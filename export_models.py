#!/usr/bin/env python3
"""Extract VelociDrone prefab models from the game's Unity asset bundles.

Two jobs:
  --glb <id|name> ...   Export real meshes as GLB into models/ and update
                        models/models.json (the viewer uses these directly).
  --dims                Walk EVERY prefab in tracks/prefabs.json and write
                        tracks/prefab-dims.json: local-space AABB + a
                        representative colour per prefab, so the viewer can
                        draw correctly-sized boxes for anything unmodelled.

Needs a venv with UnityPy, numpy and pillow:
    python3 -m venv venv && venv/bin/pip install UnityPy numpy pillow
    venv/bin/python export_models.py --glb DefaultMaple 42 DefaultConeA

Conventions (match the committed models/ and app.js):
  - Vertices baked to prefab-root space, then Unity -> three.js handedness via
    z-mirror (x, y, -z) + triangle winding flip. Origins stay at the base.
  - Textures resized to <=512 px, JPEG for opaque, PNG when alpha matters.
  - Tree/foliage prefabs export their smallest LOD that still has real
    geometry (poster-style viewer; keeps GLBs ~100-300 KB).
"""
import argparse
import io
import json
import math
import os
import re
import struct
import sys

import numpy as np

BUNDLE_DIR = os.path.expanduser(
    "~/Downloads/production-launcher-debian/app/velocidrone_Data/StreamingAssets/assetbundles"
)
ROOT = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(ROOT, "models")
MODELS_JSON = os.path.join(MODELS_DIR, "models.json")
PREFABS_JSON = os.path.join(ROOT, "tracks", "prefabs.json")
DIMS_JSON = os.path.join(ROOT, "tracks", "prefab-dims.json")

# prefab catalog type -> asset bundle file
TYPE_BUNDLE = {
    "Gates": "gates", "Barriers": "barriers", "Trees": "trees",
    "Fast Foliage": "fast foliage", "Cones": "cones", "Misc": "misc",
    "Bando": "bando", "PolyWorld": "polyworld", "Military": "military",
    "Terrain": "terrain", "Combat": "combat", "Micro": "micro",
    "Hologram": "hologram", "SciFi": "scifi", "Dungeon": "dungeon",
    "Construction": "construction", "Future": "future", "Mobile": "mobile",
    "Decal": "decal", "DR1": "dr1", "Neon": "neon", "Rocks": "rocks",
    "Buildings": "buildings", "Effects": "effects", "Pipes": "pipes",
    "Invisible": "invisible", "Tools": "tools",
}

# helper nodes that exist for gameplay, not visuals
SKIP_NODE = re.compile(r"^(reference|triggergate|resetpoint|collisionobject|point light)", re.I)
LOD_RE = re.compile(r"lod(\d+)", re.I)

MAX_TEX = 512                # --max-tex; texture long-edge cap
VERT_BUDGET = 12000          # --vert-budget; prefer the most detailed LOD under this


# --- bundle / prefab access -------------------------------------------------
_envs = {}

def load_env(bundle):
    import UnityPy
    if bundle not in _envs:
        path = os.path.join(BUNDLE_DIR, bundle)
        if not os.path.exists(path):
            raise FileNotFoundError(f"bundle not found: {path}")
        _envs[bundle] = UnityPy.load(path)
    return _envs[bundle]


def find_prefab(env, name):
    """editor-gates container for a prefab name (case/space tolerant)."""
    want = f"assets/editor gates/{name.lower()}.prefab"
    tail = f"/{name.lower()}.prefab"
    fallback = None
    for path, o in env.container.items():
        if path == want:
            return o
        base = path.rsplit("/", 1)[-1]
        if fallback is None and path.endswith(tail) and not base.startswith("_"):
            fallback = o
    return fallback


# --- transform math ---------------------------------------------------------
def trs_matrix(t):
    p, q, s = t.m_LocalPosition, t.m_LocalRotation, t.m_LocalScale
    x, y, z, w = q.x, q.y, q.z, q.w
    R = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])
    M = np.eye(4)
    M[:3, :3] = R @ np.diag([s.x, s.y, s.z])
    M[:3, 3] = [p.x, p.y, p.z]
    return M


def component_map(game_object):
    out = []
    for c in game_object.m_Components:
        try:
            r = c.read()
        except Exception:
            continue
        out.append((type(r).__name__, r))
    return out


def walk_renderers(transform, parent=np.eye(4), root=True):
    """Yield (node_name, world_matrix, mesh_pptr_read, materials, lod_level)
    for every visible renderer under the prefab root."""
    go = transform.m_GameObject.read()
    name = go.m_Name
    if not root and SKIP_NODE.match(name):
        return
    # the root's own TRS is editor placement leftovers — the game re-bases
    # prefabs at spawn, so models must be exported in root-identity space
    world = parent if root else parent @ trs_matrix(transform)
    comps = component_map(go)
    kinds = {k for k, _ in comps}
    lod = LOD_RE.search(name)
    lod_level = int(lod.group(1)) if lod else None
    if "BillboardRenderer" not in kinds:
        mesh = mats = None
        for kind, c in comps:
            if kind == "MeshFilter":
                try:
                    mesh = c.m_Mesh.read()
                except Exception:
                    mesh = None
            elif kind in ("MeshRenderer", "SkinnedMeshRenderer"):
                if kind == "SkinnedMeshRenderer":
                    try:
                        mesh = c.m_Mesh.read()
                    except Exception:
                        pass
                mats = []
                for mp in c.m_Materials:
                    try:
                        mats.append(mp.read())
                    except Exception:
                        mats.append(None)
        if mesh is not None and mats is not None \
                and "collider" not in mesh.m_Name.lower():
            yield name, world, mesh, mats, lod_level
    for ch in transform.m_Children:
        yield from walk_renderers(ch.read(), world, root=False)


def pick_lod(nodes):
    """Keep one LOD level: the most detailed whose verts fit the budget."""
    levels = sorted({n[4] for n in nodes if n[4] is not None})
    if not levels:
        return nodes
    always = [n for n in nodes if n[4] is None]

    def verts_at(level):
        return sum(n[2].m_VertexData.m_VertexCount for n in nodes if n[4] == level)

    chosen = levels[-1]
    for lv in levels:
        if verts_at(lv) <= VERT_BUDGET:
            chosen = lv
            break
    return always + [n for n in nodes if n[4] == chosen]


# --- material / texture helpers ---------------------------------------------
def mat_props(mat):
    sp = mat.m_SavedProperties
    texs = {t[0]: t[1] for t in sp.m_TexEnvs}
    cols = {c[0]: c[1] for c in sp.m_Colors}
    return texs, cols


def main_texture(mat):
    texs, _ = mat_props(mat)
    for slot in ("_MainTex", "_MainAlbedoTex", "_MainTexture", "_BaseMap", "_BaseColorMap"):
        e = texs.get(slot)
        if e is not None and getattr(e.m_Texture, "path_id", 0):
            try:
                tex = e.m_Texture.read()
                if type(tex).__name__ == "Texture2D":
                    return tex
            except Exception:
                pass
    return None


def base_color(mat):
    _, cols = mat_props(mat)
    c = cols.get("_Color") or cols.get("_BaseColor")
    if c is None:
        return (1.0, 1.0, 1.0, 1.0)
    return (c.r, c.g, c.b, c.a)


def emissive_color(mat):
    _, cols = mat_props(mat)
    c = cols.get("_EmissionColor")
    if c is None:
        return None
    rgb = (min(c.r, 1.0), min(c.g, 1.0), min(c.b, 1.0))
    return rgb if max(rgb) > 0.05 else None


def encode_texture(tex):
    """Texture2D -> (bytes, mime, has_alpha), resized to MAX_TEX."""
    from PIL import Image
    img = tex.image
    if img.width > MAX_TEX or img.height > MAX_TEX:
        f = MAX_TEX / max(img.width, img.height)
        img = img.resize((max(1, round(img.width * f)),
                          max(1, round(img.height * f))), Image.LANCZOS)
    img = img.transpose(Image.FLIP_TOP_BOTTOM)   # Unity UV origin is bottom-left
    has_alpha = img.mode in ("RGBA", "LA") and img.getextrema()[-1][0] < 250
    buf = io.BytesIO()
    if has_alpha:
        img.save(buf, "PNG", optimize=True)
        return buf.getvalue(), "image/png", True
    img.convert("RGB").save(buf, "JPEG", quality=82)
    return buf.getvalue(), "image/jpeg", False


# --- minimal GLB writer -------------------------------------------------------
class Glb:
    def __init__(self):
        self.bin = bytearray()
        self.views = []
        self.accessors = []
        self.images = []
        self.textures = []
        self.materials = []
        self.primitives = []

    def view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        self.views.append({"buffer": 0, "byteOffset": len(self.bin),
                           "byteLength": len(data),
                           **({"target": target} if target else {})})
        self.bin.extend(data)
        return len(self.views) - 1

    def accessor(self, arr, ctype, target):
        arr = np.ascontiguousarray(arr)
        v = self.view(arr.tobytes(), target)
        acc = {"bufferView": v, "componentType": ctype,
               "count": len(arr), "type": "SCALAR" if arr.ndim == 1 else f"VEC{arr.shape[1]}"}
        if arr.ndim == 2 and arr.shape[1] == 3 and ctype == 5126:
            acc["min"] = [float(x) for x in arr.min(0)]
            acc["max"] = [float(x) for x in arr.max(0)]
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def image(self, data, mime):
        v = self.view(data)
        self.images.append({"bufferView": v, "mimeType": mime})
        self.textures.append({"source": len(self.images) - 1, "sampler": 0})
        return len(self.textures) - 1

    def to_bytes(self, name):
        mesh = {"primitives": self.primitives}
        doc = {
            "asset": {"version": "2.0", "generator": "export_models.py"},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0, "name": name}],
            "meshes": [mesh],
            "materials": self.materials,
            "accessors": self.accessors,
            "bufferViews": self.views,
            "samplers": [{"magFilter": 9729, "minFilter": 9987,
                          "wrapS": 10497, "wrapT": 10497}],
            "buffers": [{"byteLength": len(self.bin)}],
        }
        if self.images:
            doc["images"] = self.images
            doc["textures"] = self.textures
        else:
            del doc["samplers"]
        js = json.dumps(doc, separators=(",", ":")).encode()
        js += b" " * (-len(js) % 4)
        bn = bytes(self.bin) + b"\0" * (-len(self.bin) % 4)
        out = struct.pack("<III", 0x46546C67, 2, 28 + len(js) + len(bn))
        out += struct.pack("<II", len(js), 0x4E4F534A) + js
        out += struct.pack("<II", len(bn), 0x004E4942) + bn
        return out


def export_glb(name, bundle, out_path):
    from UnityPy.helpers.MeshHelper import MeshHandler
    env = load_env(bundle)
    obj = find_prefab(env, name)
    if obj is None:
        raise LookupError(f"prefab '{name}' not in bundle '{bundle}'")
    root = obj.read().m_Transform.read()
    nodes = pick_lod(list(walk_renderers(root)))
    if not nodes:
        raise LookupError(f"prefab '{name}' has no visible mesh (runtime geometry?)")

    glb = Glb()
    mat_index = {}      # material path_id -> gltf material index
    tex_index = {}      # texture path_id -> gltf texture index
    bounds_min = np.full(3, np.inf)
    bounds_max = np.full(3, -np.inf)

    def gltf_material(mat):
        if mat is None:
            key = None
        else:
            key = mat.object_reader.path_id
        if key in mat_index:
            return mat_index[key]
        entry = {"pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.75},
                 "doubleSided": True}
        if mat is not None:
            entry["name"] = mat.m_Name
            r, g, b, a = base_color(mat)
            entry["pbrMetallicRoughness"]["baseColorFactor"] = [r, g, b, a]
            em = emissive_color(mat)
            if em:
                entry["emissiveFactor"] = list(em)
            tex = main_texture(mat)
            if tex is not None:
                tkey = tex.object_reader.path_id
                if tkey not in tex_index:
                    try:
                        data, mime, has_alpha = encode_texture(tex)
                        tex_index[tkey] = (glb.image(data, mime), has_alpha)
                    except Exception as e:
                        print(f"    texture {tex.m_Name}: {e}")
                        tex_index[tkey] = None
                ti = tex_index[tkey]
                if ti is not None:
                    entry["pbrMetallicRoughness"]["baseColorTexture"] = {"index": ti[0]}
                    if ti[1]:
                        entry["alphaMode"] = "MASK"
                        entry["alphaCutoff"] = 0.5
        glb.materials.append(entry)
        mat_index[key] = len(glb.materials) - 1
        return mat_index[key]

    total_tris = 0
    for node_name, world, mesh, mats, _ in nodes:
        h = MeshHandler(mesh)
        try:
            h.process()
        except Exception as e:
            print(f"    mesh {mesh.m_Name}: {e}")
            continue
        verts = np.asarray(h.m_Vertices, dtype=np.float32)
        if verts.ndim != 2 or not len(verts):
            continue
        pos = verts[:, :3] @ world[:3, :3].T + world[:3, 3]
        pos[:, 2] *= -1                             # Unity -> three.js handedness
        norm = None
        if h.m_Normals is not None and len(h.m_Normals) == len(verts):
            n = np.asarray(h.m_Normals, dtype=np.float32)[:, :3]
            norm = n @ np.linalg.inv(world[:3, :3]).T.astype(np.float32)
            norm[:, 2] *= -1
            ln = np.linalg.norm(norm, axis=1, keepdims=True)
            norm = (norm / np.clip(ln, 1e-6, None)).astype(np.float32)
        uv = None
        if h.m_UV0 is not None and len(h.m_UV0) == len(verts):
            uv = np.asarray(h.m_UV0, dtype=np.float32)[:, :2]
            uv[:, 1] = 1.0 - uv[:, 1]               # glTF UV origin is top-left
        bounds_min = np.minimum(bounds_min, pos.min(0))
        bounds_max = np.maximum(bounds_max, pos.max(0))

        attrs = {"POSITION": glb.accessor(pos.astype(np.float32), 5126, 34962)}
        if norm is not None:
            attrs["NORMAL"] = glb.accessor(norm, 5126, 34962)
        if uv is not None:
            attrs["TEXCOORD_0"] = glb.accessor(uv, 5126, 34962)
        for si, tris in enumerate(h.get_triangles()):
            tri = np.asarray(tris, dtype=np.uint32)
            if not len(tri):
                continue
            tri = tri[:, [0, 2, 1]]                 # winding flip for the mirror
            total_tris += len(tri)
            mat = mats[min(si, len(mats) - 1)] if mats else None
            glb.primitives.append({
                "attributes": attrs,
                "indices": glb.accessor(tri.reshape(-1), 5125, 34963),
                "material": gltf_material(mat),
            })

    if not glb.primitives:
        raise LookupError(f"prefab '{name}' produced no triangles")
    data = glb.to_bytes(name)
    with open(out_path, "wb") as f:
        f.write(data)
    print(f"  ✓ {name}: {total_tris} tris, {len(glb.materials)} mats, "
          f"{len(data) / 1024:.0f} KB -> {os.path.relpath(out_path, ROOT)}")
    return [round(float(v), 3) for v in bounds_min], \
           [round(float(v), 3) for v in bounds_max]


# --- dims catalogue (AABB + colour for every prefab) --------------------------
def prefab_dims(name, bundle):
    env = load_env(bundle)
    obj = find_prefab(env, name)
    if obj is None:
        return None
    root = obj.read().m_Transform.read()
    nodes = pick_lod(list(walk_renderers(root)))
    if not nodes:
        return None
    bmin = np.full(3, np.inf)
    bmax = np.full(3, -np.inf)
    color = None
    for _, world, mesh, mats, _ in nodes:
        aabb = mesh.m_LocalAABB
        c = np.array([aabb.m_Center.x, aabb.m_Center.y, aabb.m_Center.z])
        e = np.array([aabb.m_Extent.x, aabb.m_Extent.y, aabb.m_Extent.z])
        corners = c + e * np.array(
            [[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)])
        wc = corners @ world[:3, :3].T + world[:3, 3]
        wc[:, 2] *= -1
        bmin = np.minimum(bmin, wc.min(0))
        bmax = np.maximum(bmax, wc.max(0))
        if color is None:
            for m in mats:
                if m is None:
                    continue
                r, g, b, a = base_color(m)
                em = emissive_color(m)
                if em and max(r, g, b) < 0.2:
                    r, g, b = em
                if (r, g, b) != (1.0, 1.0, 1.0):
                    color = (r, g, b)
                    break
    if not np.isfinite(bmin).all():
        return None
    out = [round(float(v), 2) for v in (*bmin, *bmax)]
    if color:
        out.append("%02x%02x%02x" % tuple(int(max(0, min(1, v)) * 255) for v in color))
    return out


def run_dims(prefabs):
    dims = {}
    misses = []
    by_bundle = {}
    for pid, (name, ptype, _gate) in prefabs.items():
        b = TYPE_BUNDLE.get(ptype)
        if b:
            by_bundle.setdefault(b, []).append((pid, name))
    for bundle in sorted(by_bundle):
        entries = by_bundle[bundle]
        print(f"[{bundle}] {len(entries)} prefabs")
        for pid, name in entries:
            try:
                d = prefab_dims(name, bundle)
            except Exception as e:
                d = None
                print(f"  ! {name}: {e}")
            if d:
                dims[pid] = d
            else:
                misses.append(f"{pid} {name}")
        _envs.clear()                    # keep memory bounded, bundles are GBs
    with open(DIMS_JSON, "w") as f:
        json.dump(dims, f, separators=(",", ":"))
    print(f"\nWrote {DIMS_JSON}: {len(dims)} prefabs sized, {len(misses)} without meshes")
    if misses:
        print("  (no mesh — runtime/particle prefabs):", ", ".join(misses[:20]),
              "..." if len(misses) > 20 else "")


# --- cli ----------------------------------------------------------------------
def main():
    global MAX_TEX, VERT_BUDGET
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--glb", nargs="+", metavar="ID|NAME",
                    help="export these prefabs (catalog id or prefab name) to models/")
    ap.add_argument("--dims", action="store_true",
                    help="write tracks/prefab-dims.json for every prefab")
    ap.add_argument("--max-tex", type=int, default=MAX_TEX,
                    help="texture long-edge cap in px (default 512)")
    ap.add_argument("--vert-budget", type=int, default=VERT_BUDGET,
                    help="pick the most detailed LOD under this many verts")
    args = ap.parse_args()
    MAX_TEX, VERT_BUDGET = args.max_tex, args.vert_budget
    if not args.glb and not args.dims:
        ap.error("nothing to do: pass --glb and/or --dims")

    prefabs = json.load(open(PREFABS_JSON))["prefabs"]
    by_name = {v[0].lower(): (k, v) for k, v in prefabs.items()}

    if args.glb:
        os.makedirs(MODELS_DIR, exist_ok=True)
        index = json.load(open(MODELS_JSON)) if os.path.exists(MODELS_JSON) else {}
        todo = []
        done = failed = 0
        for ref in args.glb:
            if ref in prefabs:
                pid, (name, ptype, _) = ref, prefabs[ref]
            elif ref.lower() in by_name:
                pid, (name, ptype, _) = by_name[ref.lower()][0], by_name[ref.lower()][1]
            else:
                print(f"  ! unknown prefab: {ref}")
                failed += 1
                continue
            bundle = TYPE_BUNDLE.get(ptype)
            if not bundle:
                print(f"  ! {name}: no bundle for type {ptype}")
                failed += 1
                continue
            todo.append((bundle, pid, name))
        # group by bundle and drop each env when done — bundles are GBs
        todo.sort()
        prev_bundle = None
        for bundle, pid, name in todo:
            if bundle != prev_bundle:
                _envs.clear()
                prev_bundle = bundle
            out = os.path.join(MODELS_DIR, f"{name.lower().replace(' ', '_')}.glb")
            try:
                bmin, bmax = export_glb(name, bundle, out)
                index[pid] = {"file": f"models/{os.path.basename(out)}",
                              "min": bmin, "max": bmax}
                done += 1
            except Exception as e:
                print(f"  ! {name}: {e}")
                failed += 1
        with open(MODELS_JSON, "w") as f:
            json.dump(index, f, indent=1)
        print(f"\n{done} exported, {failed} failed; index -> {MODELS_JSON}")

    if args.dims:
        run_dims(prefabs)


if __name__ == "__main__":
    main()
