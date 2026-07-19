// ===========================================================================
// Track format converter: VelociDrone <-> MRSIM.
//
// The two sims describe tracks very differently, so conversion is driven by
// what actually defines the race: the ordered checkpoint crossings (position
// + crossing direction), plus the object type at each one.
//
//   VelociDrone            MRSIM
//   ------------------     ---------------------------------------------
//   gate prefab        <-> Centered7x6Gate (3 m) / Centered5x5Gate (2.1 m),
//                          picked by the real VD gate width
//   window/dive        <-> 7x7DiveGate/7x7ClimbGate (steep) or a tilted gate
//   4 m flag (170)     <-> Flag.xml/Flag180.xml + an either-side sensor plane
//   invisible cp       <-> bare Box sensor entity with a <Checkpoint>
//   (no equivalent)    <-  pipe cubes/poles: passes become checkpoints,
//                          the PVC structure becomes white blocks (2219)
//
// Spaces: VD is Unity left-handed Y-up in integer cm with (w,x,y,z)*1000
// quaternions; MRSIM is right-handed Z-up in metres with axis-angle
// transforms. Everything routes through the viewer's three.js space
// (right-handed Y-up, metres): VD (x,y,z) -> three (x, y, -z);
// MRSIM (x,y,z) -> three (x, z, -y).
//
// The implementation lives in convert/ as separate modules:
//   convert/space.js       coordinate/rotation/unit conversions
//   convert/mapping.js     object-mapping tables and decisions
//   convert/vd-normalize.js VD track JSON -> normalised crossing model
//   convert/emit-mrsim.js  normalised model -> MRSIM XML
//   convert/mrsim-to-vd.js parsed MRSIM scene -> VD track JSON
//   convert/validate.js    structural + geometric validation of the output
// This file only re-exports the public API (kept for the import map).
// ===========================================================================
export * from './convert/index.js';
