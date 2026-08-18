#!/usr/bin/env node
// ===========================================================================
// VelociDrone -> MRSIM track converter, command-line front end.
//
//   node convert-cli.mjs "My Track.trk" [options]
//
//   -o, --out FILE        output XML path (default: "<track name>-MRSIM.xml")
//   -l, --location NAME   MRSIM world: EmptyGrassWorld | BaylandsPark |
//                         HardestyBMXTrack (default EmptyGrassWorld)
//   -g, --ghost FILE      ghost/WR line JSON (repeatable) — sensors for flags
//                         and invisible checkpoints centre on where the field
//                         actually flies (same fitting the viewer applies)
//   -s, --summary FILE    also write the conversion summary + validation
//                         report as JSON
//   -p, --pilot NAME      credit the pilot in the XML header comment
//   -q, --quiet           errors only
//   --no-validate         skip validation (not recommended)
//
// Input may be an encrypted .trk file or a viewer-exported track .json.
// Exit code: 0 converted and valid · 1 validation errors · 2 fatal error.
// ===========================================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';

globalThis.DOMParser = globalThis.DOMParser || DOMParser;
globalThis.location = globalThis.location || { href: 'http://localhost/' };

const { parseTrk } = await import('./trk.js');
const { vdToMrsim, validateMrsim, makeClassifier, MRSIM_LOCATIONS } =
  await import('./convert/index.js');
const { simulateLine } = await import('./convert/simulate.js');

// ---- arguments -------------------------------------------------------------
const args = process.argv.slice(2);
const opts = { ghosts: [], validate: true };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => {
    const v = args[++i];
    if (v === undefined) { console.error(`option ${a} needs a value`); usage(); process.exit(2); }
    return v;
  };
  if (a === '-o' || a === '--out') opts.out = val();
  else if (a === '-l' || a === '--location') opts.location = val();
  else if (a === '-g' || a === '--ghost') opts.ghosts.push(val());
  else if (a === '-s' || a === '--summary') opts.summaryOut = val();
  else if (a === '-p' || a === '--pilot') opts.pilotName = val();
  else if (a === '-q' || a === '--quiet') opts.quiet = true;
  else if (a === '--no-validate') opts.validate = false;
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else if (a.startsWith('-')) { console.error(`unknown option ${a}`); usage(); process.exit(2); }
  else positional.push(a);
}
if (opts.location && !MRSIM_LOCATIONS.some(l => l[0] === opts.location)) {
  console.error(`unknown location "${opts.location}"`);
  usage(); process.exit(2);
}
function usage() {
  console.error('usage: node convert-cli.mjs <track.trk|track.json> ' +
    '[-o out.xml] [-l location] [-g ghost.json]… [-s summary.json] [-p pilot] [-q] [--no-validate]');
  console.error('locations: ' + MRSIM_LOCATIONS.map(l => l[0]).join(' | '));
}
if (positional.length !== 1) { usage(); process.exit(2); }
const inputPath = positional[0];

const log = (...a) => { if (!opts.quiet) console.log(...a); };

try {
  // ---- load the prefab catalogue (needed to classify sequence objects) -----
  const root = dirname(fileURLToPath(import.meta.url));
  const catalog = JSON.parse(readFileSync(join(root, 'tracks/prefabs.json'), 'utf8'));
  const dims = JSON.parse(readFileSync(join(root, 'tracks/prefab-dims.json'), 'utf8'));
  const { classify, prefabName, gateWidthFor, heightFor, boundsFor } = makeClassifier(catalog, dims);

  // ---- parse the input track ------------------------------------------------
  const raw = readFileSync(inputPath, 'utf8').replace(/^﻿/, '');
  const data = /^\s*\{/.test(raw)
    ? JSON.parse(raw)                       // viewer-exported JSON
    : parseTrk(raw, basename(inputPath));   // encrypted .trk
  if (!Array.isArray(data.gates)) throw new Error('no gates in the input track');
  const name = data.meta?.name || basename(inputPath).replace(/\.(trk|json)$/i, '');
  log(`Track: ${name}  (${data.gates.length} sequence objects, ` +
    `${(data.barriers || []).length} scenery objects` +
    (data.meta?.scene_id != null ? `, scene ${data.meta.scene_id}` : '') + ')');

  // ---- optional ghost lines for sensor fitting ------------------------------
  const humanLines = [];
  const ghostLabels = [];
  for (const g of opts.ghosts) {
    try {
      const gd = JSON.parse(readFileSync(g, 'utf8'));
      const frames = gd.frames || gd;
      if (!Array.isArray(frames) || frames.length < 4) {
        console.warn(`ghost ${g}: no usable frames, skipped`);
        continue;
      }
      const THREE = await import('three');
      humanLines.push(frames.map(f => {
        const p = f.p || f;
        return new THREE.Vector3(p[0], p[1], -p[2]);
      }));
      ghostLabels.push(gd.pilot ?? basename(g));
      log(`Ghost: ${gd.pilot ?? basename(g)} (${frames.length} frames)`);
    } catch (e) {
      console.warn(`ghost ${g}: unreadable (${e.message}), skipped`);
    }
  }

  // ---- convert --------------------------------------------------------------
  const { xml, warnings, summary, normal } = vdToMrsim(data, classify, prefabName, {
    location: opts.location, humanLines, gateWidthFor, heightFor, boundsFor,
    pilotName: opts.pilotName,
  });

  // embedded track names can contain path separators — never let the default
  // output path escape the working directory
  const outPath = opts.out || `${name.replace(/[/\\]/g, '-')}-MRSIM.xml`;
  writeFileSync(outPath, xml);
  const k = summary.counts;
  log(`\nConverted -> ${outPath}`);
  log(`  ${k.crossings} checkpoints (${k.gates} gates, ${k.dives} dive/climb, ` +
    `${k.flags} flags, ${k.checkpoints} sensors)` +
    (k.merged ? `, ${k.merged} duplicate(s) merged` : '') +
    (k.tools ? `, ${k.tools} editor tool(s) dropped` : ''));
  log(`  scenery: ${k.blocks} blocks, ${k.nets} nets, ${k.hurdles} hurdles, ` +
    `${k.decoFlags} flags, ${k.neon} neon; skipped: ` +
    (k.skipped.length ? k.skipped.map(s => `${s.count}× ${s.name}`).join(', ') : 'none'));
  log(`  world: ${summary.location}, ${summary.isCircuit ? 'circuit' : 'sprint'}` +
    (summary.groundRaise ? `, raised ${summary.groundRaise.toFixed(2)} m onto the floor` : ''));
  for (const w of warnings) log(`  ! ${w}`);

  // ---- validate -------------------------------------------------------------
  let v = null;
  if (opts.validate) {
    v = validateMrsim(xml, { summary, normal, humanLines });
    const worst = v.comparison.reduce((a, c) => Math.max(a, c.posDelta), 0);
    log(`\nValidation: ${v.ok ? 'PASS' : 'FAIL'} — ${v.stats.checkpoints ?? 0}/${v.stats.listed ?? 0} ` +
      `checkpoints resolved, worst placement error ${worst.toFixed(3)} m`);
    for (const e of v.errors) console.error(`  ERROR: ${e}`);
    for (const w of v.warnings) log(`  warn: ${w}`);
  }
  // ---- fly each supplied line through the converted track -------------------
  // one simulateLine call per ghost: every line must fire every checkpoint in
  // order on its own lap (concatenating lines would let one lap's misses hide
  // behind another's hits)
  let simOk = true;
  if (opts.validate && humanLines.length) {
    log(`\nDrone simulation, one lap per line (${humanLines.length} line(s)):`);
    let grazeTotal = 0;
    const dirStats = new Map();   // checkpoint name -> {n, min, sum, count}
    humanLines.forEach((line, li) => {
      const sim = simulateLine(xml, [line], { summary, normal });
      const ok = sim.fired === sim.checkpoints && sim.collisions.length === 0;
      simOk &&= ok;
      grazeTotal += sim.grazes.length;
      for (const f of sim.firedAt) {
        const s = dirStats.get(f.name) ?? { n: f.n, min: 1, sum: 0, count: 0 };
        s.min = Math.min(s.min, f.dot); s.sum += f.dot; s.count++;
        dirStats.set(f.name, s);
      }
      log(`  ${ok ? 'PASS' : 'FAIL'} ${ghostLabels[li]}: ${sim.fired}/${sim.checkpoints} in order` +
        (sim.missed.length ? ` — MISSED: ${sim.missed.map(m => `#${m.n} ${m.name}`).join(', ')}` : '') +
        (sim.collisions.length ? ` — ${sim.collisions.length} collision(s)` : ''));
      for (const c of sim.collisions) {
        console.error(`    COLLISION: ${c.element} (${c.depth} m deep at ${c.at})`);
      }
    });
    if (grazeTotal) {
      log(`  ${grazeTotal} thin-object graze(s) ≤0.25 m across all lines (10 Hz line ` +
        'resolution — same clearances as the VD originals)');
    }
    if (simOk) log('  clean: every line flies the whole lap and fires every checkpoint');
    // facing summary: every fire required forward motion through the sensor —
    // this table shows the margin (travel·facing at the trigger, min across lines)
    if (dirStats.size) {
      const rows = [...dirStats.values()].sort((a, b) => a.min - b.min);
      const tight = rows.filter(r => r.min < 0.3);
      log(`  facing check: every fire crossed along the checkpoint direction; ` +
        `tightest margins: ` + rows.slice(0, 3).map(r =>
          `#${r.n} min=${r.min.toFixed(2)} mean=${(r.sum / r.count).toFixed(2)}`).join(', '));
      if (tight.length) {
        log(`  ${tight.length} checkpoint(s) fired at a shallow angle on some line ` +
          `(oblique but forward — VD lines cut these marks obliquely too)`);
      }
    }
  }
  if (opts.summaryOut) {
    writeFileSync(opts.summaryOut, JSON.stringify({
      track: name, output: outPath, warnings,
      layout: { groundY: normal.layout.groundY, shift3: normal.layout.shift3.toArray() },
      summary: {
        ...summary, emitted: undefined, spawn: undefined,   // drop three.js objects
      }, validation: v,
    }, null, 2));
    log(`Summary -> ${opts.summaryOut}`);
  }
  process.exit((v && !v.ok) || !simOk ? 1 : 0);
} catch (e) {
  console.error(`convert failed: ${e.message}`);
  process.exit(2);
}
