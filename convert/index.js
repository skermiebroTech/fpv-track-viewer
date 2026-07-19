// Public conversion API.
//   space.js        coordinate/rotation/unit conversions
//   mapping.js      object-mapping tables and decisions
//   vd-classify.js  prefab catalogue -> classifier functions
//   vd-normalize.js VD track JSON -> normalised crossing model
//   emit-mrsim.js   normalised model -> MRSIM XML (+ summary for validation)
//   validate.js     structural + geometric validation of the emitted XML
//   mrsim-to-vd.js  parsed MRSIM scene -> VD track JSON
export { vdToMrsim, emitMrsim } from './emit-mrsim.js';
export { normalizeVdTrack } from './vd-normalize.js';
export { validateMrsim } from './validate.js';
export { makeClassifier } from './vd-classify.js';
export { mrsimToVd } from './mrsim-to-vd.js';
export { MRSIM_LOCATIONS, VD_SCENES, VD_BLOCKS } from './mapping.js';
