#!/usr/bin/env python3
"""Extract MRSIM object meshes (.model) from MRSIM.dkb into models/mrsim/*.glb
+ models/mrsim/models.json. The viewer renders element BinaryModelRenderer refs
(gates, mats, stands, flags, canopy, poles, trees...) with these instead of the
procedural pipe-prim stand-ins.

MRSIM .model layout (reverse-engineered, verified across all 37 models):
little-endian, a sequence of named PARTS. Each part is

    [u32 6][u32 12]{a, components, totalLen}   stream preamble
    [u32 posBytes]  position data (vec3 f32)   -> ends at the first record
    per extra stream: [u32 4][u32 24]{backPtr, id, stride, 0, comp, total}
                      {t, totalBytes, dataBytes/count} + data
    [u32 nameLen][name][0xff?]                 part name
    [u32 5][u32 92] footer: {partEnd, idxDataStart, streamCount N, rec1..recN}

The LAST record offset is always the index record; POSITIONS end at the
first record (at the index record when N==1 — collision meshes have no
normals/uvs). At idxDataStart sits {type, totalBytes, count}: index element
size = (totalBytes-12)/count, 2 or 4 bytes. Vertices are raw MRSIM Z-up
local space — the viewer's `three(m)=Z_UP_TO_Y_UP·m` matrix orients them.

    venv/bin/python export_mrsim_models.py
"""
import struct, json, os
import numpy as np
from pathlib import Path

DKB = Path.home()/".local/share/Steam/steamapps/common/MRSIM/MRSIM.dkb"
ROOT = Path(__file__).parent
OUTDIR = ROOT/"models"/"mrsim"
INDEX = OUTDIR/"models.json"

# non-visual marker parts (the checkpoint aperture quad inside gate models)
SKIP_PARTS = {'PassageGeometry'}


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
    """-> ([(name, positions Nx3 f32, indices M u32)], [notes])."""
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
        subs.append((name, np.ascontiguousarray(P, dtype='<f4'), I))
    return subs, notes


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
    for _name,P,I in subs:
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
            subs,notes=decode(b)
        except Exception as e:
            print(f"  ! {nm}: {e}"); skip+=1; continue
        for n in notes: print(f"    ! {nm}/{n}")
        if not subs:
            print(f"  (no geometry) {nm}"); skip+=1; continue
        fn=f"{nm}.glb"
        write_glb(OUTDIR/fn, subs)
        allP=np.concatenate([P for _,P,_ in subs])
        index[nm]={"file":f"models/mrsim/{fn}",
                   "min":[round(float(v),3) for v in allP.min(0)],
                   "max":[round(float(v),3) for v in allP.max(0)]}
        tris=sum(len(I)//3 for _,_,I in subs)
        print(f"  ✓ {nm}: {len(subs)} parts, {len(allP)} verts, {tris} tris")
        done+=1
    json.dump(index, open(INDEX,'w'), indent=1)
    print(f"\n{done} models -> {OUTDIR} ({skip} skipped); index {INDEX}")


if __name__=='__main__':
    main()
