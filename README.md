# VelociDrone Track Viewer

A static, browser-based 3D viewer for [VelociDrone](https://www.velocidrone.com/) race
tracks, built with [Three.js](https://threejs.org/) and hosted on **GitHub Pages**.
Styled after the official AUFPV / Mission Foods Australian Drone Nationals track
posters: green grid mat (1 m / 5 m lines), khaki racing line, white Mission gates,
feather flags and a checkered start.

Included tracks: **2024 AU NATS Quali** (6 gates, 6 flags, 1 elevated dive gate —
validated against the official 2D layout poster) and **2026 AU NATS V3 Polished**.

## Features

- 3D orbit view (drag to rotate, scroll to zoom, right-drag to pan)
- **2D layout** button — top-down view matching the official poster orientation
- Race gates as 2 m square frames (white; dive gates red with yellow tips),
  flags as printed feather flags, checkered start/finish with crossed flags
  and a yellow direction arrow
- Racing line through every gate aperture, crossing perpendicular to each frame,
  plus a flat ground projection to read altitude
- **Fly lap** — camera flight along the racing line at race-ish pace
- Layer toggles: gates, flags, sequence numbers, racing line, scenery,
  hidden checkpoints
- Track materials card (poster style): gate/flag/dive counts, lap length,
  course area, max altitude
- Multiple tracks via a dropdown (driven by `tracks/manifest.json`)

## Quick start (local)

Browsers block `fetch()` from `file://`, so serve the folder over HTTP:

```bash
cd track-viewer
python3 -m http.server 8099
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

## Adding / updating tracks

Track layouts live in the VelociDrone user database
(`~/.config/unity3d/velocidrone/velocidrone/user11.db`, table `tracks`, column
`value` = plain JSON of `gates` + `barriers`). Export with:

```bash
python3 export_tracks.py --list        # list recent tracks with ids
python3 export_tracks.py 2864 2863     # export these ids into tracks/ + manifest
```

Commit the new `tracks/*.json` + `tracks/manifest.json` and push.

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
- `models/*.glb` are the **actual in-game meshes** (MultiGP gates, 4 m flags,
  WDC gates, hurdles, start grids…) extracted from the Unity asset bundles in
  `StreamingAssets/assetbundles/{gates,barriers}` with UnityPy, converted to
  GLB with textures. Stretchable blocks/nets generate their meshes at runtime
  in-game, so they render as boxes using the exact material colours.
- Click any object in the viewer to open the **inspector** with its raw
  database values (position, quaternion, scale, prefab id/name) and derived info.

## Files

| File | Purpose |
|------|---------|
| `index.html` | UI shell, poster-style cards, import map |
| `app.js` | Three.js scene, track builder, fly-through |
| `tracks/manifest.json` | Tracks shown in the dropdown |
| `tracks/*.json` | Exported layouts (`meta` + `gates` + `barriers`) |
| `export_tracks.py` | Export tracks from the VelociDrone user DB |
| `.nojekyll` | Serve files verbatim on GitHub Pages |
