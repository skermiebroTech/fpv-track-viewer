// ===========================================================================
// VelociDrone prefab classification from the exported catalogue
// (tracks/prefabs.json + tracks/prefab-dims.json). The same rules the viewer
// applies in app.js, packaged for the converter CLI and tests.
//
// kind: 'gate' | 'dive' | 'flag' | 'checkpoint' | 'tool'
//   type 'Tools'     -> tool (editor helpers, not rendered, not raced)
//   type 'Invisible' -> checkpoint
//   name ~ /flag/    -> flag,  name ~ /window/ -> dive,  else gate
// ===========================================================================

// fallback when the catalogue is unavailable (matches app.js)
const GATE_KIND_FALLBACK = {
  285: 'gate', 742: 'gate', 286: 'dive',
  170: 'flag', 88: 'checkpoint', 2231: 'checkpoint', 2232: 'checkpoint',
};

export function makeClassifier(catalog = { prefabs: {} }, dims = {}) {
  const info = id => {
    const c = catalog.prefabs[id];
    return c ? { name: c[0], type: c[1], isGate: !!c[2] } : null;
  };
  return {
    classify(g) {
      const i = info(g.prefab);
      if (!i) {
        return GATE_KIND_FALLBACK[g.prefab] ??
          (Math.max(...(g.trans.scale ?? [100, 100, 100])) >= 5000 ? 'checkpoint' : 'gate');
      }
      if (i.type === 'Tools') return 'tool';
      if (i.type === 'Invisible') return 'checkpoint';
      if (/flag/i.test(i.name)) return 'flag';
      if (/window/i.test(i.name)) return 'dive';
      return 'gate';
    },
    prefabName: id => info(id)?.name ?? '',
    // native (unscaled) gate width in metres from the prefab mesh bounds;
    // VD race gates (285/286/742) are ~3.2 m
    gateWidthFor(id) {
      const d = dims[id];
      return d ? d[3] - d[0] : 3.2;
    },
    // native prefab height (flag poles: 4-5.6 m) for the flag risers
    heightFor(id) {
      const d = dims[id];
      return d ? d[4] - d[1] : undefined;
    },
  };
}
