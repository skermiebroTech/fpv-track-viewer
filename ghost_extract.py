#!/usr/bin/env python3
"""
Extract VelociDrone ghost flights (including downloaded Nemesis / world-record
ghosts) from the local user database.

Why this exists
---------------
VelociDrone's leaderboard API exposes only *lap times* anonymously
(`/api/leaderboard/track_times`). The actual flown *trajectory* — the human
racing line — lives in "ghost" data, which the flight endpoints
(`getFlight`, `getGhostFlights`) serve only to an authenticated game session
(they 500 for anonymous callers). So we can't pull a ghost straight from the
web.

But we don't need to. When you race a track in **Nemesis mode** against a
leaderboard time, the game downloads that pilot's ghost and stores it locally:

    ghost_flights          one row of metadata per ghost
                           (scene_id, track_name, lap_time, player_name, filename)
    sim_states             the trajectory blob, in a row named
                           'GhostData-<filename>'

So to capture the world-record line for a track:
  1. In VelociDrone, open the track's Three-Lap leaderboard.
  2. Click the #1 time -> Race / Nemesis (let the ghost download).
  3. Run this script. It dumps every ghost blob to ghosts/ for decoding.

DB location (Linux):
  ~/.config/unity3d/velocidrone/velocidrone/user11.db
"""
import argparse, os, sqlite3, sys

DEFAULT_DB = os.path.expanduser(
    "~/.config/unity3d/velocidrone/velocidrone/user11.db")


def hexpreview(b, n=64):
    chunk = b[:n]
    hexs = " ".join(f"{c:02x}" for c in chunk)
    ascii_ = "".join(chr(c) if 32 <= c < 127 else "." for c in chunk)
    return f"{hexs}\n    ascii: {ascii_}"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=DEFAULT_DB, help="path to user11.db")
    ap.add_argument("--out", default="ghosts", help="output directory for blobs")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        sys.exit(f"database not found: {args.db}")
    con = sqlite3.connect(args.db)
    con.row_factory = sqlite3.Row

    flights = con.execute(
        "select id, scene_id, track_name, lap_time, player_name, filename "
        "from ghost_flights order by scene_id, track_name, lap_time").fetchall()

    if not flights:
        print("No ghost flights stored yet.\n")
        print("To capture a world-record line: in VelociDrone open a track's\n"
              "Three-Lap leaderboard, race the #1 time in Nemesis mode (let the\n"
              "ghost download), then re-run this script.")
        # still list any GhostData blobs that exist without a metadata row
        orphan = con.execute(
            "select name, length(value) from sim_states "
            "where name like 'GhostData-%'").fetchall()
        if orphan:
            print("\nGhostData blobs present without metadata rows:")
            for o in orphan:
                print(f"  {o['name']}  ({o['length(value)']} bytes)")
        return

    os.makedirs(args.out, exist_ok=True)
    print(f"{len(flights)} ghost flight(s):\n")
    for f in flights:
        blob_name = f"GhostData-{f['filename']}"
        row = con.execute("select value from sim_states where name = ?",
                          (blob_name,)).fetchone()
        print(f"#{f['id']}  {f['player_name']!r}  {f['lap_time']}s"
              f"  track={f['track_name']!r}  scene={f['scene_id']}")
        if row is None or row["value"] is None:
            print(f"    (no blob row '{blob_name}')")
            continue
        val = row["value"]
        data = val if isinstance(val, (bytes, bytearray)) else str(val).encode()
        safe = "".join(c if c.isalnum() or c in "-_." else "_"
                       for c in f"{f['player_name']}_{f['track_name']}_{f['lap_time']}")
        path = os.path.join(args.out, safe + ".ghostblob")
        with open(path, "wb") as fh:
            fh.write(data)
        print(f"    -> {path}  ({len(data)} bytes)")
        print(f"    head: {hexpreview(data)}")
        print()


if __name__ == "__main__":
    main()
