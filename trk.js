// ===========================================================================
// VelociDrone .trk track file decoder.
//
// A .trk is base64( AES-128-ECB( PKCS7( "<sceneId>\n<name>\n<json>\n0\n0" )))
// where the key is the first 8 chars of "Velocidrone" plus their reverse
// ("VelocidrrdicoleV"). Format reverse-engineered in FPVTracksideCore:
// https://github.com/uewepuep/FPVTracksideCore (ExternalData/VDFileManager.cs)
//
// Web Crypto deliberately has no ECB mode, so a minimal pure-JS AES-128
// decryptor lives here. A 34 KB track decrypts in ~a millisecond.
// ===========================================================================

const hexTable = hex =>
  Uint8Array.from({ length: 256 }, (_, i) => parseInt(hex.substr(i * 2, 2), 16));

// FIPS-197 S-box (needed for key expansion) and its inverse (for decryption)
const SBOX = hexTable(
  '637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0' +
  'b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b275' +
  '09832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cf' +
  'd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2' +
  'cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdb' +
  'e0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08' +
  'ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9e' +
  'e1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16');
const INV_SBOX = hexTable(
  '52096ad53036a538bf40a39e81f3d7fb7ce339829b2fff87348e4344c4dee9cb' +
  '547b9432a6c2233dee4c950b42fac34e082ea16628d924b2765ba2496d8bd125' +
  '72f8f66486689816d4a45ccc5d65b6926c704850fdedb9da5e154657a78d9d84' +
  '90d8ab008cbcd30af7e45805b8b34506d02c1e8fca3f0f02c1afbd0301138a6b' +
  '3a9111414f67dcea97f2cfcef0b4e67396ac7422e7ad3585e2f937e81c75df6e' +
  '47f11a711d29c5896fb7620eaa18be1bfc563e4bc6d279209adbc0fe78cd5af4' +
  '1fdda8338807c731b11210592780ec5f60517fa919b54a0d2de57a9f93c99cef' +
  'a0e03b4dae2af5b0c8ebbb3c83539961172b047eba77d626e169146355210c7d');

// GF(2^8) multiply; used once at init to build the InvMixColumns tables
function gmul(a, b) {
  let p = 0;
  while (b) {
    if (b & 1) p ^= a;
    a = (a << 1) ^ (a & 0x80 ? 0x11b : 0);
    b >>= 1;
  }
  return p & 0xff;
}
const mulTable = n => Uint8Array.from({ length: 256 }, (_, i) => gmul(i, n));
const M9 = mulTable(9), M11 = mulTable(11), M13 = mulTable(13), M14 = mulTable(14);
const M2 = mulTable(2), M3 = mulTable(3);   // forward MixColumns (encryption)

// AES-128: 16-byte key -> 176 bytes of round keys (11 rounds)
function expandKey(key) {
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let a = w[i - 4], b = w[i - 3], c = w[i - 2], d = w[i - 1];
    if (i % 16 === 0) {
      [a, b, c, d] = [SBOX[b] ^ rcon, SBOX[c], SBOX[d], SBOX[a]];
      rcon = (rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0);
    }
    w[i] = w[i - 16] ^ a;
    w[i + 1] = w[i - 15] ^ b;
    w[i + 2] = w[i - 14] ^ c;
    w[i + 3] = w[i - 13] ^ d;
  }
  return w;
}

// state is column-major: s[row + 4*col], i.e. plain byte order of the block
function shiftRows(s) {
  let t;
  t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;        // row 1 « 1
  t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t; // row 2 « 2
  t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;      // row 3 « 3
}

function invShiftRows(s) {
  let t;
  t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;        // row 1 » 1
  t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t; // row 2 » 2
  t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;      // row 3 » 3
}

function encryptBlock(s, w) {
  for (let i = 0; i < 16; i++) s[i] ^= w[i];
  for (let round = 1; round <= 9; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    shiftRows(s);
    for (let c = 0; c < 16; c += 4) {                                  // MixColumns
      const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
      s[c] = M2[a0] ^ M3[a1] ^ a2 ^ a3;
      s[c + 1] = a0 ^ M2[a1] ^ M3[a2] ^ a3;
      s[c + 2] = a0 ^ a1 ^ M2[a2] ^ M3[a3];
      s[c + 3] = M3[a0] ^ a1 ^ a2 ^ M2[a3];
    }
    const k = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= w[k + i];
  }
  for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
  shiftRows(s);
  for (let i = 0; i < 16; i++) s[i] ^= w[160 + i];
}

function decryptBlock(s, w) {
  for (let i = 0; i < 16; i++) s[i] ^= w[160 + i];
  for (let round = 9; round >= 1; round--) {
    invShiftRows(s);
    const k = round * 16;
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]] ^ w[k + i];
    for (let c = 0; c < 16; c += 4) {                                  // InvMixColumns
      const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
      s[c] = M14[a0] ^ M11[a1] ^ M13[a2] ^ M9[a3];
      s[c + 1] = M9[a0] ^ M14[a1] ^ M11[a2] ^ M13[a3];
      s[c + 2] = M13[a0] ^ M9[a1] ^ M14[a2] ^ M11[a3];
      s[c + 3] = M11[a0] ^ M13[a1] ^ M9[a2] ^ M14[a3];
    }
  }
  invShiftRows(s);
  for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]] ^ w[i];
}

const TRK_KEY = 'Velocidrone';

// base64 .trk file content -> decrypted plaintext. VelociDrone reuses the
// same scheme with other seeds (the official-track catalogue uses
// 'Bat Cave Games'), so the key is a parameter.
export function decryptTrk(fileText, key = TRK_KEY) {
  let bytes;
  try {
    bytes = Uint8Array.from(atob(fileText.replace(/\s+/g, '')), ch => ch.charCodeAt(0));
  } catch {
    throw new Error('not base64 data — is this really a VelociDrone .trk file?');
  }
  if (!bytes.length || bytes.length % 16) {
    throw new Error('cipher length is not a multiple of the AES block size');
  }
  const k8 = key.replaceAll(' ', '').slice(0, 8);
  const w = expandKey(new TextEncoder().encode(k8 + [...k8].reverse().join('')));
  for (let off = 0; off < bytes.length; off += 16) {
    decryptBlock(bytes.subarray(off, off + 16), w);
  }
  const pad = bytes[bytes.length - 1];
  if (pad < 1 || pad > 16 ||
      !bytes.subarray(bytes.length - pad).every(b => b === pad)) {
    throw new Error('decryption produced garbage — wrong key or corrupt file');
  }
  return new TextDecoder().decode(bytes.subarray(0, bytes.length - pad));
}

// plaintext -> base64 AES-128-ECB (PKCS7) under any key seed (same derivation
// as decryptTrk). The leaderboard API encrypts its request `post_data` this
// way with the 'Bat Cave Games' seed.
export function encryptAes(plainText, key = TRK_KEY) {
  const data = new TextEncoder().encode(plainText);
  const pad = 16 - (data.length % 16);
  const bytes = new Uint8Array(data.length + pad);
  bytes.set(data);
  bytes.fill(pad, data.length);
  const k8 = key.replaceAll(' ', '').slice(0, 8);
  const w = expandKey(new TextEncoder().encode(k8 + [...k8].reverse().join('')));
  for (let off = 0; off < bytes.length; off += 16) {
    encryptBlock(bytes.subarray(off, off + 16), w);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}
export const encryptTrk = plainText => encryptAes(plainText, TRK_KEY);

// track data -> shareable .trk file content (inverse of parseTrk)
export function buildTrk(sceneId, name, json) {
  const safeName = String(name).replace(/[\r\n]+/g, ' ');   // keep line framing intact
  return encryptTrk(`${sceneId}\n${safeName}\n${JSON.stringify(json)}\n0\n0`);
}

// .trk file content -> track data in the viewer's JSON shape
// ({ meta, gates, barriers }, positions in cm, (w,x,y,z)*1000 quaternions)
export function parseTrk(fileText, fileName = 'track.trk') {
  const text = decryptTrk(fileText);
  // the JSON starts on the third line — track names may themselves contain '{'
  const nameEnd = text.indexOf('\n', text.indexOf('\n') + 1);
  const jsonStart = text.indexOf('{', nameEnd + 1);
  const jsonEnd = text.lastIndexOf('}') + 1;
  if (jsonStart === -1 || jsonEnd === 0) {
    throw new Error('no track JSON inside the decrypted file');
  }
  const header = text.slice(0, jsonStart).split('\n');
  const sceneId = parseInt(header[0], 10);
  const data = JSON.parse(text.slice(jsonStart, jsonEnd));
  if (!Array.isArray(data.gates) || !data.gates.length) {
    throw new Error('track has no gates');
  }
  data.meta = {
    name: (header[1] || '').trim() || fileName.replace(/\.trk$/i, ''),
    scene_id: Number.isFinite(sceneId) ? sceneId : undefined,
    gates: data.gates.length,
    barriers: (data.barriers || []).length,
    source: 'Imported .trk',
  };
  return data;
}
