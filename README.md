# FPV Track Viewer

A static, browser-based 3D viewer compatible with
[VelociDrone](https://www.velocidrone.com/) and
[MRSIM](https://store.steampowered.com/app/2338080/MRSIM/) tracks, built with
[Three.js](https://threejs.org/) and hosted on **GitHub Pages**.
Styled after the official AUFPV / Mission Foods Australian Drone Nationals track
posters: green grid mat (1 m / 5 m lines), khaki racing line, white Mission gates,
feather flags and a checkered start.

Bundled tracks (dropdown, driven by `tracks/manifest.json`): **2024 AU NATS
Quali** (6 gates, 6 flags, 1 elevated dive gate — validated against the
official 2D layout poster), **2022 Mission Foods Australian Drone Nationals**,
**Dutch Drone Madness 2021 Race 1**, **FAI World Cup Italy 2024**,
**2025 MultiGP European Champs** and **DDR Race Series – Track 5**.

## Features

- 3D orbit view (drag to rotate, scroll to zoom, right-drag to pan)
- **2D layout** button — top-down view matching the official poster orientation
- Race gates as 2 m square frames (white; dive gates red with yellow tips),
  flags as printed feather flags, checkered start/finish with crossed flags
  and a yellow direction arrow
- Optimised racing line through every gate aperture with an estimated
  race-pace lap time, plus a flat ground projection to read altitude
- **Fly lap** — camera flight along the racing line that brakes into corners
  and sprints the straights, following the optimiser's speed profile
- Layer toggles: gates, flags, sequence numbers, racing line, scenery,
  hidden checkpoints
- Track materials card (poster style): gate/flag/dive counts, lap length,
  course area, max altitude
- Multiple tracks via a dropdown (driven by `tracks/manifest.json`)
- Collapsible menus — click a card title (Layers / Track Materials / Legend)
  to minimise it to its title bar; the choice is remembered. On phones and
  other small screens the menus start minimised, the header switches to
  compact icon buttons, and touch targets are enlarged.
- **Open track** — view any VelociDrone `.trk` track file or MRSIM `.xml`
  track (header button or drag-and-drop it onto the page). Files are decoded
  entirely in the browser; nothing is uploaded anywhere.
- **🌐 Browse** — search VelociDrone's ~2000 official public tracks and view
  any of them with one click (catalogue format documented by
  [bolagnaise/vdrone-tracks](https://github.com/bolagnaise/vdrone-tracks);
  the AES-encrypted list is decoded client-side, downloads come straight
  from VelociDrone's public API).
- **⇄ Convert** — convert the displayed track to the other sim's format and
  download it: MRSIM `.xml` → VelociDrone `.trk` (encrypted, ready to import
  in-game) or VelociDrone → MRSIM `.xml`. The environment selector next to
  the button picks the target scene (Empty Scene Day/Night… for VD; Empty
  Grass World / Baylands Park / Hardesty BMX for MRSIM).
- **🛠 Editor** — the **FPV Track Editor**, a full 3D MRSIM track editor (opens
  `mrsim-test.html`): place any MRSIM object from a palette, edit the lap /
  checkpoint order, move-rotate-scale with a gizmo, and import a VelociDrone
  `.trk`/`.json` or MRSIM `.xml` to edit and re-export. See
  [FPV Track Editor](#fpv-track-editor).

## Human world-record line

Alongside the computed line, the viewer can overlay a **real human racing
line** — the actual world-record flight from the VelociDrone leaderboard,
drawn in cyan with the pilot's name and lap time, a **WR lap** button that
replays it in first person at its true recorded pace, and a **Fetch WR line**
button that pulls the current record live.

VelociDrone stores a leaderboard flight ("ghost") as
`base64( zlib( .NET-BinaryFormatter( List<TransformRecord> ) ) )`, where each
`TransformRecord` carries a position (Unity metres, same world space as the
track), quaternion, throttle and timing.

### Live fetch (Fetch WR line)

`getLeaderBoard` / `getFlight` take a single AES-encrypted `post_data` field
(key seed `Bat Cave Games`) and `ghostfetch.js` decodes the reply — zlib +
a small MS-NRBF reader — entirely in the browser.

One catch shapes the setup: the API drops its CORS header on responses over
**~4 KB**, so a browser can't read a flight (always ≥100 KB) cross-origin.
Small responses keep the header, so the **leaderboard works from anywhere** —
including GitHub Pages, no setup — fetched in 15-row pages that stay under
the limit. Fetching a *flight* therefore goes through a CORS proxy (the
request carries no account data — no email or login is needed). Two ways to
have one:

- **Locally**: `serve.py` serves the viewer and proxies `/vd/*` to
  VelociDrone on the same origin:

  ```bash
  python3 serve.py            # http://localhost:8099  (viewer + /vd proxy)
  ```

- **Hosted (GitHub Pages)**: [`proxy-worker.js`](proxy-worker.js) deployed as
  a Cloudflare Worker (free tier). The viewer defaults to this repo's
  instance (`vd-proxy.skermiebro.workers.dev`), so the hosted site works with
  no setup. To run your own instead — recommended if you fork this —
  deploy it with `npx wrangler deploy proxy-worker.js --name vd-proxy`
  (or paste the file into a new Worker at
  [dash.cloudflare.com](https://dash.cloudflare.com)) and put the
  `https://<name>.<account>.workers.dev` URL into the **proxy URL** field
  under *Human lines* (shown whenever the viewer isn't on localhost,
  remembered in the browser). The worker only forwards the same endpoints
  serve.py allows, and nothing is logged.

The button appears for tracks whose online leaderboard id is known (any track
opened via **🌐 Browse**, plus the bundled AU NATS Quali).
`protected_track_value` is 1 for official tracks, 2 for user tracks.

### Offline (bundled / captured)

Without `serve.py`, a line can also be prepared offline and bundled:

```bash
# in vd-ghost-capture/ : decode a captured getFlight payload
python3 ghost_decode.py out/021_getFlight.txt --which faster --out line.json
```

`ghost_decode.py` (uses the `nrbf` package) emits a compact
`{pilot, lap_time, frames:[{t, p:[x,y,z]}]}`. Drop it at
`ghosts/<track-slug>-wr.json` (e.g. `ghosts/2024-au-nats-quali-wr.json`) and
the viewer loads it automatically. `ghost_extract.py` instead pulls ghosts
from the local `user11.db` after a Nemesis race. Bundled WR lines: **IQ0's
26.30 s** lap for the 2024 AU NATS Quali and **BMSThomas's 53.36 s** run for
the 2022 Mission Foods Nationals (auto-loaded from `ghosts/<track-slug>-wr.json`).

## Quick start (local)

Browsers block `fetch()` from `file://`, so serve the folder over HTTP:

```bash
cd track-viewer
python3 serve.py            # viewer + /vd proxy (needed for live Fetch WR line)
# or: python3 -m http.server 8099   (everything except live fetch)
# open http://localhost:8099
```

## Deploy to GitHub Pages

1. Push these files to a repo:
   ```bash
   git init && git add . && git commit -m "VelociDrone track viewer"
   git branch -M main
   git remote add origin git@github.com:<you>/<repo>.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Deploy from a branch**, pick `main` / root.
3. Live at `https://<you>.github.io/<repo>/`. (`.nojekyll` included.)

Everything works on Pages out of the box: the live leaderboard is fetched
straight from VelociDrone, and flight lines go through the bundled proxy
worker (see [Live fetch](#live-fetch-fetch-wr-line) — deploy your own
instance if you fork this).

## Adding / updating tracks

The quickest way to view a track is **Open .trk** in the header (or drop the
file onto the page): VelociDrone's shared `.trk` files are AES-encrypted
(`trk.js` decodes them client-side, format documented in
[FPVTracksideCore](https://github.com/uewepuep/FPVTracksideCore)). Imported
tracks are session-only; to publish one on the site, export it as JSON:

Track layouts live in the VelociDrone user database
(`~/.config/unity3d/velocidrone/velocidrone/user11.db`, table `tracks`, column
`value` = plain JSON of `gates` + `barriers`). Export with:

```bash
python3 export_tracks.py --list        # list recent tracks with ids
python3 export_tracks.py 2864 2863     # export these ids into tracks/ + manifest
```

Commit the new `tracks/*.json` + `tracks/manifest.json` and push.

## MRSIM tracks

[MRSIM](https://store.steampowered.com/app/2338080/MRSIM/) (Multi Rotor SIM)
tracks are plain-XML `<Simulation>` scene graphs: nested `<Transform>`s place
entities that `<Include>` library objects (`5x5Gate.xml`, `Flag.xml`,
`7x7Mat.xml`…) or `<Instance>` macros (`PaddedPole`, `PipeDoubleCube`…).
Coordinates are metres, right-handed **Z-up**; rotations are axis-angle
attributes (`rz="-1" angleDegrees="110"`).

`mrsim.js` walks the scene graph and renders each object's **collision
primitives** — the thin `<Box>`es are exactly the gate fabric panels and the
`<Cylinder>`s the PVC pipes / padded poles, so every object type (gates,
pole cubes, ladders, hurdles, dive gates…) draws faithfully with no
per-type code. The `<CheckpointList>` names (`trkCube1.lower.backEntry`)
resolve to `<Checkpoint>` reference points and crossing directions, so the
racing line is exact — including multi-pass elements and cube entries/exits.

The library objects are embedded in `mrsim-lib.js` — the object geometry
(collision-primitive coordinates + sizes) needed to place and draw any MRSIM
track, read from your own licensed `MRSIM.dkb`. After a game update,
regenerate with:

```bash
python3 export_mrsim_lib.py   # reads ~/.local/share/Steam/steamapps/common/MRSIM/MRSIM.dkb
```

MRSIM's rendered **meshes and textures** (gates, flags, mat, terrain, drone
frames, logo…) are **not redistributed with this project** — they are the
developer's copyrighted art. The hosted viewer draws every MRSIM object from
those collision primitives instead, which is faithful (the thin boxes *are*
the fabric panels, the cylinders *are* the PVC/poles). If you own MRSIM you
can decode the real meshes locally into `models/mrsim/` with
`export_mrsim_models.py`; a gitignored `models/mrsim/models.local.json`
overlay then makes the viewer prefer them on your own machine only. See
[Assets & attribution](#assets--attribution).

## FPV Track Editor

The **🛠 Editor** button (top-right of the viewer) opens `mrsim-test.html`, the
**FPV Track Editor** — a standalone 3D MRSIM track editor. It renders gates,
flags, mat and terrain from the real decoded MRSIM meshes (falling back to
collision primitives), and while it is MRSIM-native it can import either sim's
tracks:

- **Palette** — place any MRSIM library object: 5×5 / 7×6 / Champs gates,
  start/finish, dive / climb / corner gates, hurdles, half-plane passages,
  flags, towers, launch stands, mat and custom sensor boxes. Objects marked ◉
  carry a checkpoint and auto-join the lap when placed; ▫ objects are scenery.
  Click a palette entry, then click the ground to drop it (hold shift to place
  several). A translucent **3D ghost of the actual object** follows the cursor
  while placing, so you see exactly what you're dropping. Hover a palette entry
  for a live 3D thumbnail of the object.
- **Track objects (VelociDrone)** — a second palette section with the objects
  the converter emits, which MRSIM's own library has no equivalent for: the
  true-size 3.2 m VD race gate and start/finish gate, the 4 m feather flag
  with its one-sided pole-side pass, the MGP hurdle panel, upright and dive
  checkpoint panes, net panels and stretch blocks. They carry the converter's
  own material names, so one dropped next to a converted object matches it —
  which is what you want when hand-fixing a conversion.
- **＋ Build / manage objects** — the object builder (bottom of the palette)
  lets you compose your **own** track object from box / cylinder parts — each
  with a size, offset, rotation and colour — plus an optional fly-through
  checkpoint whose **ring position and crossing direction** (yaw / pitch / roll)
  you can aim, shown live in the preview. A 3D preview updates as you edit. Saved
  objects appear in a **custom** section of the palette and place exactly like
  the built-ins (the placed object is self-contained XML, so exported tracks
  load in MRSIM as-is). See [Custom objects & components](#custom-objects--components).
- **Move / rotate / scale** — select any object for a TransformControls gizmo
  and a numeric panel (MRSIM coordinates, yaw / pitch / roll and uniform scale,
  kept MRSIM-legal). **★ Set as start / finish** marks the red-banner gate the
  lap begins and ends at; the **colour** picker recolours by material — just
  this object, everything of its type, or all items.
- **View** — toggle **perspective / orthographic / isometric** projection and
  pick a **camera control scheme** (Orbit, Blender, Fusion / CAD or Maya) so
  navigation matches whichever 3D tool you're used to; the choice is remembered.
- **Lap panel** — the ordered checkpoint list from the track's
  `<CheckpointList>`, with reorder (▲▼), remove (✕), add-selected (+ lap) and a
  circuit toggle, written straight back into the scene.
- **Delete / duplicate / undo** — Del removes an object (and cleans up its lap
  entry), `d` duplicates it (renaming the subtree uniquely), Ctrl-Z undoes any
  step.
- **Import / New** — the file picker (or drag-and-drop) accepts a MRSIM `.xml`
  directly, or a VelociDrone `.trk` / `.json` that is converted in-browser
  first; **New track** starts from an Empty Grass World template.
- **⤓ Export .xml** — writes the edited `<Simulation>` back out; objects you
  didn't touch round-trip byte-for-byte. Copy it into `Documents/MRSIM/Tracks/`
  and it appears in MRSIM's track list.

### Custom objects & components

The object builder saves each custom object as a small JSON **component** — a
list of primitive `parts` (box / cylinder with `pos`, `rot`, `dims`, `color`)
and an optional `pass` checkpoint (`pos`/`dims` trigger box plus a `ref` with
`pos` + `rot` for the ring position and crossing direction). Components live in
two places, and both feed the palette's **custom** section:

- **Your browser** — objects you build are stored in `localStorage`, so they
  persist across sessions on that machine (and stay private to it).
- **`components.json`** (repo root) — a shared bundle loaded at startup and
  shown as *repo-shared* objects for everyone who opens the editor.

To **contribute an object to the repo**: build it, then use the builder's
**⤓ Export all** button to download a `components.json` (your local objects in
the shared format), drop it in the repo root, and commit — it now ships to every
user. **⤓ Export this** downloads a single component for sharing one object;
**⤒ Import** loads either back in. A repo-shared object can be tweaked locally
(your copy shadows the shared one by id) without editing the file.

Headless hooks mirror `__edit`/`__preview`: `window.__build.save(component)`,
`.list()`, `.exportAll()`, `.open(id)`, `.remove(id)`.

## Converting between sims

The **⇄ Convert** button translates the loaded track to the other sim,
driven by what defines the race — the ordered checkpoint crossings
(position + crossing direction) plus the object type at each one:

| VelociDrone | MRSIM |
|---|---|
| MultiGP gate (285) | 7x6 gate (closest aperture), same tilt for dive gates |
| 4 m flag (170) | pole + soft cloth at the exact scaled height + a one-sided pole-side sensor plane |
| invisible checkpoint (88) | library-style `<Box>` sensor entity with a `<Checkpoint>` |
| building blocks (all 13 colours) | coloured `<Box>` entities, exact size + orientation |
| MGP hurdles | grey panel `<Box>` at the exact scaled size and full orientation (rolled slats stay rolled) |
| decorative flags | `Flag.xml` (+ riser to the scaled height) |
| blocks | ← pipe cube PVC structure |

MRSIM→VD: every checkpoint-list entry becomes a VD sequence gate — repeat
passes through the same element (cubes, double-sided gates) become invisible
checkpoints so the lap is preserved exactly; pole/flag passes become flags;
the `.trk` is AES-encrypted in the browser and imports straight into the
game (Empty Scene Day). VD→MRSIM emits a ready-to-fly `<Simulation>` XML on
Empty Grass World with a launch pad behind the start gate — scenery
barriers convert too (VD dive-gate towers are built from blocks, so they
carry over intact; nets become solid dark panels). Fixed-size objects mean
scaled VD gates export at MRSIM's native size; objects with no equivalent
are skipped and the report lists exactly what was dropped.

The conversion logic lives in `convert/` as separate modules (coordinate
maths → normalisation → object mapping → XML emission → validation), so the
same code runs in the browser, from Node, and under the test suite. After
every VD→MRSIM export the viewer shows a **conversion report**: object and
checkpoint counts, every warning, and a validation pass that re-parses the
emitted XML with the game-library-driven MRSIM parser and confirms each
checkpoint resolves exactly where the converter aimed.

Command line (same engine, no browser needed):

```bash
npm install                                  # three + @xmldom/xmldom
node convert-cli.mjs "My Track.trk"          # → "My Track-MRSIM.xml" + report
node convert-cli.mjs track.json -l BaylandsPark -g ghosts/wr.json -s report.json
npm test                                     # converter test suite
```

Copy the exported XML into `Documents/MRSIM/Tracks/` and it appears in
MRSIM's track list.

VD invisible checkpoints store a near-vertical crossing axis (turn poles,
flat "stay low" squares) that is no use as a heading. Every one of them
exports as a **window pane** — 0.3 m thick, the same as MRSIM's own gate
triggers — wide and tall enough that no line round the mark can miss it:
markers you fly PAST (turn poles, offset flags) become an upright pane
squared to the lap direction and anchored on the marker, so it fires exactly
where VelociDrone fires; a rolled square, which is a real aperture you cross
vertically, becomes a flat horizontal pane whose ring points down (dive) or
up (climb). Flags follow VD's own one-sided trigger: a long thin box running
out of the POLE side, away from the fabric. Consecutive checkpoints stacked
on the same spot (VD fires both in one pass) are merged into one sensor so
the MRSIM lap counts exactly like the VD lap.

## Data interpretation (verified against the official 2024 poster)

- **Positions**: integer centimetres, Unity left-handed Y-up. Imported as
  `(x/100, y/100, -z/100)` so the three.js top view matches the poster.
- **Rotations**: quaternions stored as `int × 1000` in **(w, x, y, z)** order,
  imported as `(-x, -y, z, w)` (handedness mirror). Under this reading every
  gate/flag is an upright yaw and the 2024 dive gate comes out 22.5° from
  horizontal — matching the "≤ 40°" rule on the poster.
- **Scale**: percent, relative to each prefab's native size. Race gates render
  at a fixed 2 m × scale; checkpoint prefabs (scale 10000) are invisible in-game
  and hidden behind a toggle here.
- **Prefab origins are at the object's base**, not its centre.
- `tracks/prefabs.json` is the game's own prefab catalog (settings.db
  `trackprefabs`: 3394 prefabs with name/type/gate-flag, plus scene titles).
  Objects classify from it: type `Invisible` → hidden checkpoint, `Tools` →
  editor helpers (not rendered), names containing `Flag` → flags.
- `models/*.glb` are the **actual in-game meshes** (gates, flags, hurdles,
  trees, cones, rocks, gazebos, banners… ~250 prefabs) extracted from the
  Unity asset bundles in `StreamingAssets/assetbundles/*` by
  `export_models.py` (UnityPy → GLB with textures; the set covers every
  scenery prefab used by ≥2 of the top-130 official tracks plus all cones,
  trees, rocks and fast foliage). Stretchable blocks/nets/neon generate their
  meshes at runtime in-game, so they render procedurally using the exact
  material colours (all 13 block colours, name-derived neon tints, sphere
  primitives).
- `tracks/prefab-dims.json` (also from `export_models.py --dims`) holds the
  real local-space bounding box + a representative colour for **every**
  prefab in the catalog, so scenery without an extracted model still draws as
  a correctly sized, category-tinted box instead of a raw-scale cube.
  Particle-only prefabs (fog, smoke) are skipped entirely.
- Click any object in the viewer to open the **inspector** with its raw
  database values (position, quaternion, scale, prefab id/name) and derived info.

## Assets & attribution

This is a **non-commercial, fan-made interoperability tool** — a track viewer
and format converter. It is **not affiliated with, endorsed by, or associated
with** VelociDrone or its developers, or MRSIM / Multi Rotor SIM or its
developers. "VelociDrone", "MRSIM", their names and logos, and all in-game 3D
models, textures and other art are the property of their respective owners.

The viewer works by reading each game's file formats from **your own licensed
copy** of the game (and public, already-shareable data such as the community
track catalogue and public leaderboard times). What that means for game art:

- **MRSIM meshes and textures are not redistributed here.** MRSIM objects
  render procedurally from their collision-primitive geometry. The real meshes
  can be decoded locally by owners of the game and stay on that machine (a
  gitignored `models/mrsim/models.local.json` overlay); they are never
  committed or served.
- **VelociDrone:** the bundled example tracks include a small subset of
  VelociDrone scenery meshes needed to display *those* tracks; the full ~3300
  prefab extraction stays local (gitignored), and objects with no shipped mesh
  are drawn procedurally. Run your own copy of VelociDrone to extract the rest.

If you are a rights holder and would like something changed, please open an
issue. Contributions that add value back to the sims (the VD⇄MRSIM converter,
for example) are the point — not re-hosting anyone's assets.

## Files

| File | Purpose |
|------|---------|
| `index.html` | UI shell, poster-style cards, import map |
| `app.js` | Three.js scene, track builder, fly-through |
| `raceline.js` | Racing-line optimiser ([TOGT](https://github.com/FSC-Lab/TOGT-Planner)-inspired) |
| `trk.js` | VelociDrone `.trk` decoder/encoder (base64 + AES-128-ECB, pure JS) |
| `mrsim.js` | MRSIM `.xml` track decoder (scene-graph walker) |
| `mrsim-lib.js` | Embedded MRSIM object library (generated) |
| `mrsim-test.html` | FPV Track Editor — 3D MRSIM track editor (palette, lap editor, gizmo, object builder, import/export) |
| `components.json` | Repo-shared custom objects for the editor's object builder |
| `convert.js` | VelociDrone ⇄ MRSIM track converter (façade over `convert/`) |
| `convert/*.js` | Converter modules: coordinate spaces, VD classify/normalise, mapping, XML emit, MRSIM→VD, validate |
| `convert-cli.mjs` | Node CLI: `.trk`/`.json` → validated MRSIM XML |
| `test/` | Converter test suite (`npm test`, node:test) |
| `ghostfetch.js` | Live leaderboard/flight fetch + ghost decoding (zlib + MS-NRBF) |
| `serve.py` | Local dev server: static files + same-origin `/vd` proxy |
| `proxy-worker.js` | Personal Cloudflare Worker proxy for flight fetch on a hosted viewer |
| `ghosts/*.json` | Bundled human WR lines (`{pilot, lap_time, frames}`) |
| `tracks/manifest.json` | Tracks shown in the dropdown |
| `tracks/*.json` | Exported layouts (`meta` + `gates` + `barriers`) |
| `export_tracks.py` | Export tracks from the VelociDrone user DB |
| `export_models.py` | Extract prefab GLBs + `prefab-dims.json` from the asset bundles |
| `export_mrsim_lib.py` | Regenerate `mrsim-lib.js` from `MRSIM.dkb` |
| `export_mrsim_models.py` | Decode MRSIM `.model` meshes + atlases → `models/mrsim/` (local only) |
| `ghost_extract.py` | Pull ghost lines from the local VelociDrone `user11.db` |
| `.nojekyll` | Serve files verbatim on GitHub Pages |
