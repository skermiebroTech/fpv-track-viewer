#!/usr/bin/env python3
"""Extract MRSIM object meshes (.model) from MRSIM.dkb into models/mrsim/*.glb
+ models/mrsim/models.json. The viewer renders element BinaryModelRenderer refs
(gates, mats, stands, flags, canopy, poles, trees...) with these instead of the
procedural pipe-prim stand-ins.

MRSIM .model layout (reverse-engineered): little-endian. Header, then per
material submesh: a vec3 position stream, a vec3 normal stream, a vec2 uv
stream, and a u32 index buffer. Submeshes are delimited by material-name
strings (DefaultMaterial / Fabric / PVC / ...). Vertices are kept in raw MRSIM
Z-up local space — the viewer's `three(m)=Z_UP_TO_Y_UP·m` matrix orients them.

    venv/bin/python export_mrsim_models.py
"""
import struct, json, os
import numpy as np
from pathlib import Path

DKB = Path.home()/".local/share/Steam/steamapps/common/MRSIM/MRSIM.dkb"
ROOT = Path(__file__).parent
OUTDIR = ROOT/"models"/"mrsim"
INDEX = OUTDIR/"models.json"

# material-name strings that delimit a submesh (extend as new ones appear)
MATERIALS = {'DefaultMaterial','Fabric','PVC','Metal','Foam','Tape','Pole','Mat',
             'Padding','Plastic','Rubber','Glass','Chrome','Banner','Carbon',
             'Aluminium','Aluminum','Steel','Wood','Concrete','Canvas','Mesh',
             'Leaf','Bark','Trunk','Ground','Grass','Cloth','Sponsor','Led','LED'}


def read_dkb(path):
    data = path.read_bytes()
    to,=struct.unpack_from('<Q',data,0); cnt,=struct.unpack_from('<I',data,20)
    pos=to; ent={}
    for _ in range(cnt):
        rs,_f,fsz,fo=struct.unpack_from('<QQQQ',data,pos); pl,=struct.unpack_from('<I',data,pos+32)
        nm=data[pos+40:pos+40+pl].decode('utf-8','replace'); ent[nm]=(fo,fsz); pos+=rs
    return data, ent, pos


def strings(b):
    out=[]; p=0
    while p<len(b)-4:
        v=struct.unpack_from('<I',b,p)[0]
        if 2<=v<=40 and p+4+v<=len(b) and all(32<=c<127 for c in b[p+4:p+4+v]):
            out.append((p, b[p+4:p+4+v].decode())); p+=4+v; continue
        p+=1
    return out


def _coord_ok(u):
    if u == 0: return True
    f, = struct.unpack('<f', struct.pack('<I', u))
    return abs(f) >= 1e-19 and np.isfinite(f) and abs(f) < 1e4


def decode(b):
    """-> list of (positions Nx3 float32, indices Mx uint32) submeshes."""
    W = np.frombuffer(b[:len(b)//4*4], dtype='<u4')
    F = np.frombuffer(b[:len(b)//4*4], dtype='<f4')
    ok = np.fromiter((_coord_ok(int(u)) for u in W), dtype=bool, count=len(W))
    runs=[]; i=0; n=len(W)
    while i<n:
        k=ok[i]; j=i
        while j<n and ok[j]==k: j+=1
        runs.append((k,i,j)); i=j
    matmarks = sorted(p for p,s in strings(b) if s in MATERIALS)
    regions=[]
    for idx,mp in enumerate(matmarks):
        end = matmarks[idx+1] if idx+1<len(matmarks) else len(b)
        regions.append((mp, end))
    if regions:
        regions[0] = (0, regions[0][1] if len(matmarks)<2 else matmarks[1])
    subs=[]
    for (rs,re) in regions:
        rw0, rw1 = rs//4, re//4
        # position stream = first coord run in region
        pos=None
        for (k,i,j) in runs:
            if j<=rw0 or i>=rw1: continue
            if k and (j-i)>=30: pos=(i,j); break
        if not pos: continue
        pi,pj=pos; plen=((pj-pi)//3)*3
        P=F[pi:pi+plen].reshape(-1,3); V=len(P)
        # index buffer = longest contiguous run of (u32 < V) after the position
        # stream. Float streams (normals/uvs) are huge-u32 nonzero, so they don't
        # match; only the real u32 index block (incl. 0-indices) forms a long run.
        idxlike = W[pj:rw1] < max(V, 1)
        best=(0,0); i=0; m=len(idxlike)
        while i<m:
            if idxlike[i]:
                j=i
                while j<m and idxlike[j]: j+=1
                if j-i>best[1]-best[0]: best=(i,j)
                i=j
            else: i+=1
        if best[1]-best[0]>=3:
            I=W[pj+best[0]:pj+best[1]]; I=I[:(len(I)//3)*3]
        else:
            I=np.arange((V//3)*3, dtype=np.uint32)
        if len(I)>=3: subs.append((P.astype('<f4'), I.astype('<u4')))
    return subs


def _pad(buf,n=4,fill=b'\x00'):
    while len(buf)%n: buf+=fill
    return buf


def write_glb(path, subs):
    bin_=b''; accessors=[]; views=[]; prims=[]
    def add(data,target):
        nonlocal bin_
        off=len(bin_); bin_=_pad(bin_+data)
        views.append({"buffer":0,"byteOffset":off,"byteLength":len(data),"target":target})
        return len(views)-1
    for P,I in subs:
        vv=add(P.tobytes(),34962)
        accessors.append({"bufferView":vv,"componentType":5126,"count":len(P),
                          "type":"VEC3","min":P.min(0).tolist(),"max":P.max(0).tolist()})
        pa=len(accessors)-1
        iv=add(I.tobytes(),34963)
        accessors.append({"bufferView":iv,"componentType":5125,"count":len(I),"type":"SCALAR"})
        prims.append({"attributes":{"POSITION":pa},"indices":len(accessors)-1,"material":0})
    gltf={"asset":{"version":"2.0","generator":"export_mrsim_models.py"},
          "scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0}],
          "meshes":[{"primitives":prims}],
          "materials":[{"pbrMetallicRoughness":{"baseColorFactor":[0.9,0.9,0.88,1],
                        "metallicFactor":0.05,"roughnessFactor":0.7},"doubleSided":True}],
          "accessors":accessors,"bufferViews":views,"buffers":[{"byteLength":len(bin_)}]}
    jbin=_pad(json.dumps(gltf,separators=(',',':')).encode(),4,b' ')
    bbin=_pad(bin_)
    out=struct.pack('<III',0x46546C67,2,12+8+len(jbin)+8+len(bbin))
    out+=struct.pack('<II',len(jbin),0x4E4F534A)+jbin
    out+=struct.pack('<II',len(bbin),0x004E4942)+bbin
    Path(path).write_bytes(out)
    return len(out)


def main():
    OUTDIR.mkdir(parents=True, exist_ok=True)
    data, ent, ds = read_dkb(DKB)
    models=[k for k in ent if k.endswith('.model')]
    index={}
    done=skip=0
    for full in sorted(models):
        nm=full.split('/')[-1][:-6]
        off,size=ent[full]; b=data[ds+off:ds+off+size]
        try:
            subs=decode(b)
        except Exception as e:
            print(f"  ! {nm}: {e}"); skip+=1; continue
        if not subs:
            print(f"  (no geometry) {nm}"); skip+=1; continue
        fn=f"{nm}.glb"
        write_glb(OUTDIR/fn, subs)
        allP=np.concatenate([P for P,_ in subs])
        index[nm]={"file":f"models/mrsim/{fn}",
                   "min":[round(float(v),3) for v in allP.min(0)],
                   "max":[round(float(v),3) for v in allP.max(0)]}
        tris=sum(len(I)//3 for _,I in subs)
        print(f"  ✓ {nm}: {len(allP)} verts, {tris} tris")
        done+=1
    json.dump(index, open(INDEX,'w'), indent=1)
    print(f"\n{done} models -> {OUTDIR} ({skip} skipped); index {INDEX}")


if __name__=='__main__':
    main()
