#!/usr/bin/env python3
"""Export VelociDrone tracks from the user database into JSON the viewer can load.

Usage:
    python3 export_tracks.py                # export the default track (id 2863)
    python3 export_tracks.py 2863 512 475   # export specific track ids
    python3 export_tracks.py --list         # list all tracks in the db

The track layout is stored as plain JSON in the `value` column of the `tracks`
table; we wrap it with a small metadata header and drop it in ./tracks/, then
rebuild tracks/manifest.json.
"""
import json
import os
import re
import sqlite3
import sys

DB = os.path.expanduser(
    "~/.config/unity3d/velocidrone/velocidrone/user11.db"
)
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tracks")

# scene_id -> human name (extend as you discover more)
SCENES = {8: "Scene6", 12: "Scene10", 7: "Scene5"}


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "track"


def list_tracks(cur):
    for row in cur.execute(
        "SELECT id, scene_id, name, date FROM tracks ORDER BY date DESC LIMIT 60"
    ):
        print(f"{row[0]:>6}  scene {row[1]:>3}  {row[3]}  {row[2]}")


def export(cur, track_id: int) -> dict | None:
    row = cur.execute(
        "SELECT id, scene_id, name, value, date FROM tracks WHERE id=?", (track_id,)
    ).fetchone()
    if not row:
        print(f"  ! track {track_id} not found")
        return None
    tid, scene_id, name, value, date = row
    layout = json.loads(value)
    doc = {
        "meta": {
            "id": tid,
            "name": name,
            "scene_id": scene_id,
            "scene": SCENES.get(scene_id, f"Scene{scene_id}"),
            "date": date,
            "gates": len(layout.get("gates", [])),
            "barriers": len(layout.get("barriers", [])),
        },
        "gates": layout.get("gates", []),
        "barriers": layout.get("barriers", []),
    }
    fname = f"{slugify(name)}.json"
    path = os.path.join(OUT_DIR, fname)
    with open(path, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"  ✓ {name}  ->  tracks/{fname}  "
          f"({doc['meta']['gates']} gates, {doc['meta']['barriers']} barriers)")
    return {
        "file": f"tracks/{fname}",
        "name": name,
        "scene": doc["meta"]["scene"],
        "gates": doc["meta"]["gates"],
        "barriers": doc["meta"]["barriers"],
    }


def main():
    args = sys.argv[1:]
    os.makedirs(OUT_DIR, exist_ok=True)
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    cur = con.cursor()

    if args and args[0] in ("--list", "-l"):
        list_tracks(cur)
        return

    ids = [int(a) for a in args] if args else [2863]

    # keep any tracks already in the manifest that we're not re-exporting
    manifest_path = os.path.join(OUT_DIR, "manifest.json")
    existing = {}
    if os.path.exists(manifest_path):
        for t in json.load(open(manifest_path)).get("tracks", []):
            existing[t["file"]] = t

    for tid in ids:
        entry = export(cur, tid)
        if entry:
            existing[entry["file"]] = entry

    manifest = {"tracks": list(existing.values())}
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nWrote {manifest_path} with {len(manifest['tracks'])} track(s).")


if __name__ == "__main__":
    main()
