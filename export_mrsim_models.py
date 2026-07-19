#!/usr/bin/env python3
"""Extract MRSIM object meshes (.model) from MRSIM.dkb into models/mrsim/*.glb
+ models/mrsim/models.json (+ models/mrsim/tex/*.png gate atlases). The viewer
renders element BinaryModelRenderer refs (gates, mats, stands, flags, canopy,
poles, trees...) with these instead of the procedural pipe-prim stand-ins.

Each GLB keeps ONE NAMED NODE PER PART (the .model's named submeshes: "PVC",
"Fabric", "TopPanel", "LeftPanel"...) carrying POSITION + NORMAL + TEXCOORD_0,
so the viewer can assign each part its real MRSIM material (colours from
DroneTrackMaterials.xml, atlas texture + per-instance sub-rect for the fabric).
This is a superset of the old position-only export — older consumers that just
traverse+clone the scene still work.

MRSIM .model layout (reverse-engineered, verified across all 37 models):
little-endian, a sequence of named PARTS. Each part is a run of attribute
streams (positions first) each terminated by a 24-byte descriptor record, then
the index stream:

    positions (vec3 f32) ....... [24B rec: tag=4 sz=24 dataOff id=0x40000 stride=12 _ comp=3]
    <attr> (normal/uv/tangent) . [24B rec: ...                 id stride _ comp]
    ...
    <last attr> ................ [24B rec = recs[-1]]
    index data at recs[-1]+24 .. {type, totalBytes, count}      (u16 or u32)
    [u32 nameLen][name][0xff?]
    [u32 5][u32 92] footer: {partEnd, idxDataStart, streamCount N, rec0..recN-1}

Key rule: **each attribute stream's data ENDS exactly at its descriptor record**,
so start = recOffset - vertCount*comp*4. recs[0] terminates positions; recs[1:]
are the extra attributes (normal 0x40001, uv 0x40002, tangent 0x40003); the index
follows recs[-1]. Vertices are raw MRSIM Z-up local space — the viewer's
`three(m)=Z_UP_TO_Y_UP·m` matrix orients them.

    venv/bin/python export_mrsim_models.py
"""
import struct, json
import numpy as np
from pathlib import Path

DKB = Path.home()/".local/share/Steam/steamapps/common/MRSIM/MRSIM.dkb"
ROOT = Path(__file__).parent
OUTDIR = ROOT/"models"/"mrsim"
TEXDIR = OUTDIR/"tex"
INDEX = OUTDIR/"models.json"

# non-visual marker parts (the checkpoint aperture quad inside gate models)
SKIP_PARTS = {'PassageGeometry'}

# gate/flag artwork atlases + the launch-mat texture, copied out for the viewer
TEXTURES = [
    'Data/Simulations/Multirotor/GatePaint/5x5GateAtlas.png',
    'Data/Simulations/Multirotor/GatePaint/FlagAtlas.png',
    'Data/Simulations/Multirotor/GatePaint/7x7Mat.png',
]

STREAM = {0x40000: 'POSITION', 0x40001: 'NORMAL', 0x40002: 'TEXCOORD_0', 0x40003: 'TANGENT'}


def read_dkb(path):
    data = path.read_bytes()
    to,=struct.unpack_from('<Q',data,0); cnt,=struct.unpack_from('<I',data,20)
    pos=to; ent={}
    for _ in range(cnt):
        rs,_f,fsz,fo=struct.unpack_from('<QQQQ',data,pos); pl,=struct.unpack_from('<I',data,pos+32)
        nm=data[pos+40:pos+40+pl].decode('utf-8','replace'); ent[nm]=(fo,fsz); pos+=rs
    return data, ent, pos


def parts(b):
    """(name, footerPayloadOffset) for every part: a length-prefixed printable
    string followed (within a couple of pad bytes) by the [5][92] footer tag."""
    out=[]; p=0
    while p<len(b)-8:
        v=struct.unpack_from('<I',b,p)[0]
        if 1<=v<=48 and p+4+v<=len(b) and all(32<=c<127 for c in b[p+4:p+4+v]):
            name=b[p+4:p+4+v].decode()
            for skip in (0,1,2,3):
                q=p+4+v+skip
                if q+8<=len(b) and struct.unpack_from('<II',b,q)==(5,92):
                    out.append((name, q+8)); break
        p+=1
    return out


def decode(b):
    """-> ([{name, P Nx3, N Nx3|None, UV Nx2|None, I M}], [notes])."""
    subs=[]; notes=[]
    for name, foot in parts(b):
        partEnd, idxData, nStreams = struct.unpack_from('<3I', b, foot)
        if not (1 <= nStreams <= 8 and idxData < partEnd <= len(b)):
            notes.append(f'{name}: implausible footer'); continue
        recs = struct.unpack_from(f'<{nStreams}I', b, foot+12)
        if name in SKIP_PARTS: continue
        firstRec, idxRec = recs[0], recs[-1]
        if idxData != idxRec+24:
            notes.append(f'{name}: idxData {idxData} != idxRec+24'); continue
        # positions: vec3 f32 block ending at the first record, preceded by its
        # own byte length — scan for the u32 that says "the rest, up to firstRec"
        posStart=None
        lo=max(0, firstRec-0x400000)
        for p in range(firstRec-8, lo, -4):
            if struct.unpack_from('<I',b,p)[0] == firstRec-(p+4):
                posStart=p+4; break
        if posStart is None or (firstRec-posStart) % 12:
            notes.append(f'{name}: no position preamble'); continue
        P=np.frombuffer(b[posStart:firstRec], dtype='<f4').reshape(-1,3)
        V=len(P)
        # extra per-vertex attributes: each ends AT its descriptor record
        attrs={}
        for rec in recs[1:]:
            _tag,_sz,_off,sid,_stride,_pad,comp = struct.unpack_from('<7I', b, rec)
            key=STREAM.get(sid)
            if key not in ('NORMAL','TEXCOORD_0') or comp not in (2,3): continue
            start=rec - V*comp*4
            if start < 0: continue
            a=np.frombuffer(b[start:rec], dtype='<f4').reshape(-1,comp)
            if len(a)==V and np.isfinite(a).all(): attrs[key]=np.ascontiguousarray(a,dtype='<f4')
        # indices: {type, totalBytes, count} then data, u16 or u32 elements
        _t, totalB, count = struct.unpack_from('<3I', b, idxData)
        if count<3 or totalB<=12 or (totalB-12)//max(count,1) not in (2,4):
            notes.append(f'{name}: bad index header ({_t},{totalB},{count})'); continue
        esz=(totalB-12)//count
        I=np.frombuffer(b[idxData+12:idxData+12+count*esz],
                        dtype='<u2' if esz==2 else '<u4').astype('<u4')
        I=I[:(len(I)//3)*3]
        if len(I)<3 or int(I.max())>=V or not np.isfinite(P).all() or (np.abs(P)>=1e5).any():
            notes.append(f'{name}: invalid geometry V={V} I={len(I)}'); continue
        subs.append({'name':name, 'P':np.ascontiguousarray(P,dtype='<f4'),
                     'N':attrs.get('NORMAL'), 'UV':attrs.get('TEXCOORD_0'), 'I':I})
    return subs, notes


def _pad(buf,n=4,fill=b'\x00'):
    while len(buf)%n: buf+=fill
    return buf


def write_glb(path, subs):
    bin_=b''; accessors=[]; views=[]; meshes=[]; nodes=[]
    def add(data,target):
        nonlocal bin_
        off=len(bin_); bin_=_pad(bin_+data)
        views.append({"buffer":0,"byteOffset":off,"byteLength":len(data),"target":target})
        return len(views)-1
    def acc(view,ctype,count,typ,mn=None,mx=None):
        a={"bufferView":view,"componentType":ctype,"count":count,"type":typ}
        if mn is not None: a["min"]=mn; a["max"]=mx
        accessors.append(a); return len(accessors)-1
    for s in subs:
        P,N,UV,I=s['P'],s['N'],s['UV'],s['I']
        attrs={"POSITION":acc(add(P.tobytes(),34962),5126,len(P),"VEC3",
                              P.min(0).tolist(),P.max(0).tolist())}
        if N is not None:  attrs["NORMAL"]=acc(add(N.tobytes(),34962),5126,len(N),"VEC3")
        if UV is not None: attrs["TEXCOORD_0"]=acc(add(UV.tobytes(),34962),5126,len(UV),"VEC2")
        idx=acc(add(I.tobytes(),34963),5125,len(I),"SCALAR")
        meshes.append({"name":s['name'],
                       "primitives":[{"attributes":attrs,"indices":idx,"material":0}]})
        nodes.append({"name":s['name'],"mesh":len(meshes)-1})
    gltf={"asset":{"version":"2.0","generator":"export_mrsim_models.py"},
          "scene":0,"scenes":[{"nodes":list(range(len(nodes)))}],"nodes":nodes,
          "meshes":meshes,
          "materials":[{"pbrMetallicRoughness":{"baseColorFactor":[0.7,0.7,0.7,1],
                        "metallicFactor":0.0,"roughnessFactor":0.6},"doubleSided":True}],
          "accessors":accessors,"bufferViews":views,"buffers":[{"byteLength":len(bin_)}]}
    jbin=_pad(json.dumps(gltf,separators=(',',':')).encode(),4,b' ')
    bbin=_pad(bin_)
    out=struct.pack('<III',0x46546C67,2,12+8+len(jbin)+8+len(bbin))
    out+=struct.pack('<II',len(jbin),0x4E4F534A)+jbin
    out+=struct.pack('<II',len(bbin),0x004E4942)+bbin
    Path(path).write_bytes(out)
    return len(out)


def export_textures(data, ent, ds):
    TEXDIR.mkdir(parents=True, exist_ok=True)
    for full in TEXTURES:
        key=next((k for k in ent if k.lstrip('/')==full), None)
        if key is None: print(f"  ! texture missing {full}"); continue
        off,size=ent[key]
        (TEXDIR/full.split('/')[-1]).write_bytes(data[ds+off:ds+off+size])
        print(f"  ~ tex {full.split('/')[-1]} ({size} B)")


def main():
    OUTDIR.mkdir(parents=True, exist_ok=True)
    data, ent, ds = read_dkb(DKB)
    export_textures(data, ent, ds)
    models=[k for k in ent if k.endswith('.model')]
    index={}
    done=skip=0
    for full in sorted(models):
        nm=full.split('/')[-1][:-6]
        off,size=ent[full]; b=data[ds+off:ds+off+size]
        try:
            subs,notes=decode(b)
        except Exception as e:
            print(f"  ! {nm}: {e}"); skip+=1; continue
        for n in notes: print(f"    ! {nm}/{n}")
        if not subs:
            print(f"  (no geometry) {nm}"); skip+=1; continue
        fn=f"{nm}.glb"
        write_glb(OUTDIR/fn, subs)
        allP=np.concatenate([s['P'] for s in subs])
        index[nm]={"file":f"models/mrsim/{fn}",
                   "parts":[s['name'] for s in subs],
                   "min":[round(float(v),3) for v in allP.min(0)],
                   "max":[round(float(v),3) for v in allP.max(0)]}
        tris=sum(len(s['I'])//3 for s in subs)
        uv=sum(s['UV'] is not None for s in subs)
        print(f"  ✓ {nm}: {len(subs)} parts, {len(allP)} verts, {tris} tris, {uv} uv'd")
        done+=1
    json.dump(index, open(INDEX,'w'), indent=1)
    print(f"\n{done} models -> {OUTDIR} ({skip} skipped); index {INDEX}")


if __name__=='__main__':
    main()
