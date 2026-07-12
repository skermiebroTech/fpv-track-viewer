# FPV Track Viewer

A static, browser-based 3D viewer compatible with
[VelociDrone](https://www.velocidrone.com/) and
[MRSIM](https://store.steampowered.com/app/2338080/MRSIM/) tracks, built with
[Three.js](https://threejs.org/) and hosted on **GitHub Pages**.
Styled after the official AUFPV / Mission Foods Australian Drone Nationals track
posters: green grid mat (1 m / 5 m lines), khaki racing line, white Mission gates,
feather flags and a checkered start.

Included tracks: **2024 AU NATS Quali** (6 gates, 6 flags, 1 elevated dive gate —
validated against the official 2D layout poster) and
**2022 Mission Foods Australian Drone Nationals**.

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
from the local `user11.db` after a Nemesis race. Bundled: **IQ0's 26.30 s
WR** for the 2024 AU NATS Quali.

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

The library objects are embedded in `mrsim-lib.js`, extracted from the
game's `MRSIM.dkb` archive (a simple file-table format). After a game
update, regenerate with:

```bash
python3 export_mrsim_lib.py   # reads ~/.local/share/Steam/steamapps/common/MRSIM/MRSIM.dkb
```

## Converting between sims

The **⇄ Convert** button translates the loaded track to the other sim,
driven by what defines the race — the ordered checkpoint crossings
(position + crossing direction) plus the object type at each one:

| VelociDrone | MRSIM |
|---|---|
| MultiGP gate (285) | 7x6 gate (closest aperture), same tilt for dive gates |
| 4 m flag (170) | `Flag.xml` on a pole riser at the exact scaled height + sensor plane |
| invisible checkpoint (88) | library-style `<Box>` sensor entity with a `<Checkpoint>` |
| building blocks (all 13 colours) | coloured `<Box>` entities, exact size + orientation |
| MGP hurdles | grey panel `<Box>` at the exact scaled size |
| decorative flags | `Flag.xml` (+ riser to the scaled height) |
| blocks | ← pipe cube PVC structure |

MRSIM→VD: every checkpoint-list entry becomes a VD sequence gate — repeat
passes through the same element (cubes, double-sided gates) become invisible
checkpoints so the lap is preserved exactly; pole/flag passes become flags;
the `.trk` is AES-encrypted in the browser and imports straight into the
game (Empty Scene Day). VD→MRSIM emits a ready-to-fly `<Simulation>` XML on
Empty Grass World with a launch pad behind the start gate — scenery
barriers convert too (VD dive-gate towers are built from blocks, so they
carry over intact). Fixed-size objects mean scaled VD gates export at
MRSIM's native size; nets and other objects with no equivalent are skipped
(the export lists exactly what was dropped).

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

## Files

| File | Purpose |
|------|---------|
| `index.html` | UI shell, poster-style cards, import map |
| `app.js` | Three.js scene, track builder, fly-through |
| `raceline.js` | Racing-line optimiser ([TOGT](https://github.com/FSC-Lab/TOGT-Planner)-inspired) |
| `trk.js` | VelociDrone `.trk` decoder/encoder (base64 + AES-128-ECB, pure JS) |
| `mrsim.js` | MRSIM `.xml` track decoder (scene-graph walker) |
| `mrsim-lib.js` | Embedded MRSIM object library (generated) |
| `convert.js` | VelociDrone ⇄ MRSIM track converter |
| `ghostfetch.js` | Live leaderboard/flight fetch + ghost decoding (zlib + MS-NRBF) |
| `serve.py` | Local dev server: static files + same-origin `/vd` proxy |
| `proxy-worker.js` | Personal Cloudflare Worker proxy for flight fetch on a hosted viewer |
| `ghosts/*.json` | Bundled human WR lines (`{pilot, lap_time, frames}`) |
| `tracks/manifest.json` | Tracks shown in the dropdown |
| `tracks/*.json` | Exported layouts (`meta` + `gates` + `barriers`) |
| `export_tracks.py` | Export tracks from the VelociDrone user DB |
| `export_models.py` | Extract prefab GLBs + `prefab-dims.json` from the asset bundles |
| `export_mrsim_lib.py` | Regenerate `mrsim-lib.js` from `MRSIM.dkb` |
| `.nojekyll` | Serve files verbatim on GitHub Pages |
