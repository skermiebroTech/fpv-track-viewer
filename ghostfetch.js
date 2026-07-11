// ===========================================================================
// Fetch a human world-record line straight from the VelociDrone leaderboard,
// live, in the browser — the same flow the game's Nemesis mode uses.
//
//   getLeaderBoard  -> the ranked times for a (track, race_mode)
//   getFlight       -> one pilot's recorded flight ("ghost")
//
// Both take a single form field  post_data = base64(AES-128-ECB("Bat Cave
// Games", params))  and reply with the same encryption; both send
// Access-Control-Allow-Origin: * so the browser can call them directly.
//
// A flight is  base64( zlib( .NET-BinaryFormatter( List<TransformRecord> ) ) ).
// TransformRecord = _position (WB_Vector3, Unity metres, Y-up), _quaternion,
// time (seconds), throttle… — decoded here into { pilot, lap_time, frames }.
//
// getFlight only returns a flight for a (track, race_mode) the calling account
// has its own leaderboard time on (same rule as in-game Nemesis), so it needs
// the account email and a track you have flown.
// ===========================================================================
import { encryptAes, decryptTrk } from './trk.js?v=11';

// Same-origin proxy provided by serve.py (browser -> your localhost ->
// VelociDrone), so getFlight's missing CORS header and the account email in
// post_data never touch a third party. Requires serving with serve.py.
const API = '/vd/leaderboard';
const KEY = 'Bat Cave Games';

async function apiPost(endpoint, params) {
  const post_data = encryptAes(new URLSearchParams(params).toString(), KEY);
  let res;
  try {
    res = await fetch(`${API}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ post_data }).toString(),
    });
  } catch {
    throw new Error('cannot reach the local proxy — serve the viewer with `python3 serve.py`');
  }
  if (res.status === 404 || res.status === 405) {
    throw new Error('live fetch needs the local proxy — serve the viewer with `python3 serve.py`');
  }
  if (!res.ok) throw new Error(`${endpoint} failed (HTTP ${res.status})`);
  return JSON.parse(decryptTrk(await res.text(), KEY));
}

// ---- zlib inflate via the native Compression Streams API --------------------
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');   // 'deflate' == zlib (RFC 1950)
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

// ---- minimal .NET Remoting Binary Format (MS-NRBF) reader -------------------
// Enough of the grammar to walk a List<TransformRecord>: it tracks class
// metadata by id (so ClassWithId can reuse a layout) and resolves object
// references in a final pass.
class NRBF {
  constructor(bytes) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = 0;
    this.objects = new Map();   // objectId -> value
    this.classes = new Map();   // objectId -> { names, binTypes, addl }
  }
  u8() { return this.b[this.p++]; }
  i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  str() {                                   // 7-bit length-prefixed UTF-8
    let n = 0, shift = 0, byte;
    do { byte = this.u8(); n |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    const s = new TextDecoder().decode(this.b.subarray(this.p, this.p + n));
    this.p += n; return s;
  }
  primitive(t) {                            // PrimitiveTypeEnumeration
    switch (t) {
      case 1: return this.u8() !== 0;       // Boolean
      case 2: return this.u8();             // Byte
      case 6: return this.f64();            // Double
      case 7: return this.dv.getInt16((this.p += 2) - 2, true); // Int16
      case 8: return this.i32();            // Int32
      case 9: { const v = this.dv.getBigInt64(this.p, true); this.p += 8; return Number(v); } // Int64
      case 10: return (this.u8() << 24) >> 24; // SByte
      case 11: return this.f32();           // Single
      case 13: { this.p += 8; return null; } // DateTime
      case 18: return this.str();           // String
      default: throw new Error(`unhandled primitive type ${t}`);
    }
  }
  addlInfo(t) {                              // extra type info for one BinaryType
    if (t === 0) return this.u8();                          // Primitive -> prim type
    if (t === 3) return this.str();                         // SystemClass -> name
    if (t === 4) return { name: this.str(), lib: this.i32() }; // Class -> name+libId
    if (t === 7) return this.u8();                          // PrimitiveArray -> prim type
    return null;                                            // String/Object/Array: none
  }
  memberTypeInfo(count) {
    const binTypes = [];
    for (let i = 0; i < count; i++) binTypes.push(this.u8());
    return { binTypes, addl: binTypes.map(t => this.addlInfo(t)) };
  }
  value(binType, addl) {
    // Primitive is inline; everything else is (or references) a record.
    return binType === 0 ? this.primitive(addl) : this.record();
  }
  classMembers(id, meta) {
    const obj = {};
    this.objects.set(id, obj);
    for (let i = 0; i < meta.names.length; i++) {
      obj[meta.names[i]] = this.value(meta.binTypes[i], meta.addl[i]);
    }
    return obj;
  }
  record() {
    const rt = this.u8();
    switch (rt) {
      case 5:   // ClassWithMembersAndTypes  (has libraryId)
      case 4: { // SystemClassWithMembersAndTypes  (no libraryId)
        const id = this.i32(), name = this.str(), count = this.i32();
        const names = []; for (let i = 0; i < count; i++) names.push(this.str());
        const { binTypes, addl } = this.memberTypeInfo(count);
        if (rt === 5) this.i32();            // libraryId
        this.classes.set(id, { names, binTypes, addl });
        return this.classMembers(id, { names, binTypes, addl });
      }
      case 1: { // ClassWithId -> reuse a prior class layout
        const id = this.i32(), meta = this.classes.get(this.i32());
        return this.classMembers(id, meta);
      }
      case 6: { const id = this.i32(), s = this.str(); this.objects.set(id, s); return s; } // BinaryObjectString
      case 8: return this.primitive(this.u8());        // MemberPrimitiveTyped
      case 9: return { __ref: this.i32() };            // MemberReference
      case 10: return null;                            // ObjectNull
      case 13: return { __nulls: this.u8() };          // ObjectNullMultiple256
      case 14: return { __nulls: this.i32() };         // ObjectNullMultiple
      case 12: { this.i32(); this.str(); return this.record(); } // BinaryLibrary -> skip
      case 16: {                                       // ArraySingleObject
        const id = this.i32(), len = this.i32(), arr = [];
        this.objects.set(id, arr);
        while (arr.length < len) {
          const rec = this.record();
          if (rec && rec.__nulls !== undefined) { for (let i = 0; i < rec.__nulls; i++) arr.push(null); }
          else arr.push(rec);
        }
        return arr;
      }
      case 7: {                                        // BinaryArray
        const id = this.i32();
        const arrType = this.u8();                     // BinaryArrayTypeEnumeration
        const rank = this.i32();
        const lengths = []; for (let i = 0; i < rank; i++) lengths.push(this.i32());
        if (arrType >= 3) for (let i = 0; i < rank; i++) this.i32(); // lower bounds
        const elemType = this.u8();
        const addl = this.addlInfo(elemType);
        const total = lengths.reduce((a, b) => a * b, 1);
        const arr = []; this.objects.set(id, arr);
        while (arr.length < total) {
          const v = this.value(elemType, addl);
          if (v && v.__nulls !== undefined) { for (let i = 0; i < v.__nulls; i++) arr.push(null); }
          else arr.push(v);
        }
        return arr;
      }
      case 11: return { __end: true };                 // MessageEnd
      default: throw new Error(`unhandled NRBF record type ${rt} at ${this.p}`);
    }
  }
  parse() {
    if (this.u8() !== 0) throw new Error('not an NRBF stream');
    const rootId = this.i32(); this.i32(); this.i32(); this.i32();  // header
    for (;;) {
      const rec = this.record();
      if (rec && rec.__end) break;
      if (this.p >= this.b.length) break;
    }
    const seen = new Set();
    const resolve = v => {
      if (!v || typeof v !== 'object') return v;
      if (v.__ref !== undefined) return resolve(this.objects.get(v.__ref));
      if (seen.has(v)) return v;
      seen.add(v);
      if (Array.isArray(v)) for (let i = 0; i < v.length; i++) v[i] = resolve(v[i]);
      else for (const k in v) v[k] = resolve(v[k]);
      return v;
    };
    return resolve(this.objects.get(rootId));
  }
}

// TransformRecord list -> [{ t: seconds-from-start, p: [x, y, z] }]
function recordsToFrames(list) {
  const items = (list._items || list).filter(Boolean).slice(0, list._size ?? undefined);
  if (!items.length) throw new Error('flight had no frames');
  const t0 = items[0].time;
  return items.map(r => ({
    t: +(r.time - t0).toFixed(4),
    p: [r._position.x, r._position.y, r._position.z],
  }));
}

// flight base64 (zlib+NRBF) -> frames
export async function decodeFlight(b64) {
  const comp = Uint8Array.from(atob(b64.replace(/\\\//g, '/')), c => c.charCodeAt(0));
  return recordsToFrames(new NRBF(await inflate(comp)).parse());
}

// Parse an exported .ghost file (bytes). VelociDrone's ghost serialisation is
// the same List<TransformRecord>; files in the wild may be raw NRBF, zlib'd,
// or base64 text of either — sniff and handle all three.
export async function parseGhostBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // base64 text? (printable ASCII start) -> decode then recurse
  const looksB64 = u8.length > 8 && [...u8.slice(0, 8)].every(c =>
    (c >= 43 && c <= 122) && c !== 60);   // A-z,0-9,+,/,= ; not '<'
  if (looksB64) {
    try {
      const txt = new TextDecoder().decode(u8).trim().replace(/\s+/g, '');
      const dec = Uint8Array.from(atob(txt), c => c.charCodeAt(0));
      if (dec[0] === 0x78 || (dec[0] === 0x00 && dec[1] === 0x01)) return parseGhostBytes(dec);
    } catch { /* not base64 */ }
  }
  if (u8[0] === 0x78) return recordsToFrames(new NRBF(await inflate(u8)).parse());  // zlib
  if (u8[0] === 0x00 && u8[1] === 0x01) return recordsToFrames(new NRBF(u8).parse()); // raw NRBF
  throw new Error('unrecognised .ghost format');
}

// Leaderboard entries for a (track, mode): [{ playername, lap_time, country, model_id, user_id }]
export async function fetchLeaderboard({ trackId, protectedValue = 1, raceMode = 6, count = 25 }) {
  const board = await apiPost('getLeaderBoard', {
    track_id: trackId, sim_version: '1.16', offset: 0, count,
    protected_track_value: protectedValue, model_id: 0, race_mode: raceMode, quad_class: 0,
  });
  const rows = board.tracktimes || [];
  return rows.map((r, i) => ({
    rank: i + 1, playername: (r.playername || '').trim(), lap_time: Number(r.lap_time),
    country: r.country, model_id: r.model_id, user_id: r.user_id,
  }));
}

// Fetch + decode one pilot's flight. Returns { pilot, lap_time, frames }.
export async function fetchFlightFor({ email, trackId, protectedValue = 1, raceMode = 6, playername, lapTime }) {
  const resp = await apiPost('getFlight', {
    email_address: email, track_id: trackId, lap_time: lapTime,
    race_mode: raceMode, protected_track_value: protectedValue,
    playername, version: '1.16',
  });
  const all = [...(resp.flights?.faster || []), ...(resp.flights?.user || []), ...(resp.flights?.slower || [])];
  const rec = all.find(r => (r.playername || '').trim() === playername && r.flight) || all.find(r => r.flight);
  if (!resp.success || !rec) {
    throw new Error(`no ghost for ${playername} — you must have your own ${raceMode === 3 ? 'single' : '3'}-lap time on this track first`);
  }
  return { pilot: (rec.playername || '').trim(), lap_time: Number(rec.lap_time), frames: await decodeFlight(rec.flight) };
}

// Fetch + decode the #1 world-record line (thin wrapper over the above).
export async function fetchWrLine({ email, trackId, protectedValue = 1, raceMode = 6 }) {
  const board = await fetchLeaderboard({ trackId, protectedValue, raceMode, count: 1 });
  if (!board.length) throw new Error('no leaderboard times for this track / mode');
  return fetchFlightFor({ email, trackId, protectedValue, raceMode, playername: board[0].playername, lapTime: board[0].lap_time });
}

// ---- lap averaging ---------------------------------------------------------
// A leaderboard run is recorded start-line to finish-line over exactly nLaps
// (no lead-in), so resampling the whole flight to nLaps*N points evenly by arc
// length makes points k, k+N, k+2N… land at the SAME circuit position each lap
// (equal-length laps => equal-arc-length phase alignment). Averaging those
// gives one clean representative lap without any lap-boundary detection.
const dist2 = (a, b) => { const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return x * x + y * y + z * z; };

// split a multi-lap flight at start-line returns (closest approaches to the
// first frame). Robust to unequal lap lengths; falls back to an even split.
function splitLaps(frames, nLaps) {
  if (nLaps <= 1) return [frames];
  const S = frames[0].p;
  const d = frames.map(f => Math.sqrt(dist2(f.p, S)));
  const maxD = Math.max(...d), thr = 0.18 * maxD;
  const clusters = [];         // contiguous runs where the drone is near the start
  let cur = null;
  for (let i = 0; i < frames.length; i++) {
    if (d[i] < thr) { if (!cur) cur = { min: i }; else if (d[i] < d[cur.min]) cur.min = i; }
    else if (cur) { clusters.push(cur.min); cur = null; }
  }
  if (cur) clusters.push(cur.min);
  let bounds = clusters.slice();
  if (bounds[0] > frames.length * 0.1) bounds.unshift(0);
  if (bounds[bounds.length - 1] < frames.length * 0.9) bounds.push(frames.length - 1);
  if (bounds.length !== nLaps + 1) {   // detection failed — even split
    bounds = [];
    for (let k = 0; k <= nLaps; k++) bounds.push(Math.round(k * (frames.length - 1) / nLaps));
  }
  const laps = [];
  for (let k = 0; k < nLaps; k++) laps.push(frames.slice(bounds[k], bounds[k + 1] + 1));
  return laps.filter(l => l.length > 4);
}

// resample one lap to N points by arc-length fraction (0..1), time re-based to 0
function resampleLap(lap, N) {
  const s = [0];
  for (let i = 1; i < lap.length; i++) s.push(s[i - 1] + Math.sqrt(dist2(lap[i].p, lap[i - 1].p)));
  const total = s[s.length - 1] || 1, t0 = lap[0].t, out = [];
  let j = 1;
  for (let k = 0; k < N; k++) {
    const target = (k / (N - 1)) * total;
    while (j < lap.length - 1 && s[j] < target) j++;
    const seg = s[j] - s[j - 1] || 1, w = (target - s[j - 1]) / seg;
    const a = lap[j - 1], b = lap[j];
    out.push({ t: (a.t + (b.t - a.t) * w) - t0,
      p: [a.p[0] + (b.p[0] - a.p[0]) * w, a.p[1] + (b.p[1] - a.p[1]) * w, a.p[2] + (b.p[2] - a.p[2]) * w] });
  }
  return out;
}

const pathLen = a => { let L = 0; for (let i = 1; i < a.length; i++) L += Math.sqrt(dist2(a[i].p, a[i - 1].p)); return L; };

// Average an nLaps flight into one clean lap of N points. Arc-length-fraction
// averaging drifts off the racing line (laps go out of phase and the mean cuts
// corners / misses gates), so instead we take the longest lap as a reference
// and, at each reference point, average the NEAREST point from every lap. That
// keeps the result on the line the laps actually fly (through the gates) while
// still smoothing out each lap's individual jitter.
export function averageLaps(frames, nLaps, N = 400) {
  if (!frames || frames.length < 4 || nLaps <= 1) return frames;
  const laps = splitLaps(frames, nLaps);
  if (laps.length < 2) return frames;
  const ref = laps.slice().sort((a, b) => pathLen(b) - pathLen(a))[0];
  const refR = resampleLap(ref, N);
  const out = [];
  for (let k = 0; k < N; k++) {
    const rp = refR[k].p;
    let x = 0, y = 0, z = 0;
    for (const lap of laps) {
      let best = Infinity, bi = 0;
      for (let i = 0; i < lap.length; i++) { const d = dist2(lap[i].p, rp); if (d < best) { best = d; bi = i; } }
      x += lap[bi].p[0]; y += lap[bi].p[1]; z += lap[bi].p[2];
    }
    out.push({ t: refR[k].t, p: [x / laps.length, y / laps.length, z / laps.length] });
  }
  return out;
}
