// ============================================================================
// The authenticator step: RFC 6238 TOTP, and the QR code that enrols it.
//
// No service and no dependency. A TOTP secret is twenty random bytes shared
// once with the agent's phone; from then on both sides derive the same
// six-digit number from the clock (HMAC-SHA1 over a 30-second counter, then
// the dynamic truncation from RFC 4226). Google Authenticator, Aegis,
// 1Password, Bitwarden and every other app speak exactly this, which is why
// "free" costs nothing here: there is no third party in the loop at all.
//
// The QR code is generated here too, for the same reason. Handing the secret
// to an image API would mean posting a live second factor to somebody else's
// server, and the panel's Content-Security-Policy would not load the picture
// anyway — img-src is 'self' and data:. So the encoder is below: byte mode,
// error correction level M, versions 1 to 14, which covers an otpauth:// URI
// with any realistic address in it.
// ============================================================================

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// base32 — how every authenticator app expects to be handed a secret
// ---------------------------------------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text || "").toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = B32.indexOf(char);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** Twenty bytes: the length RFC 4226 recommends and every app accepts. */
export function generateTotpSecret() {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

// ---------------------------------------------------------------------------
// the code itself
// ---------------------------------------------------------------------------

export const TOTP_PERIOD = 30;
const DIGITS = 6;

/** Which 30-second slot a moment falls into. */
export function totpStep(atMs = Date.now()) {
  return Math.floor(atMs / 1000 / TOTP_PERIOD);
}

/** HMAC-SHA1 over the counter, then RFC 4226 dynamic truncation. */
export async function totpCode(secretBase32, step) {
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secretBase32),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  // Counters stay far below 2^53, so splitting into two 32-bit halves gets the
  // eight big-endian bytes without reaching for BigInt.
  const counter = new Uint8Array(8);
  let high = Math.floor(step / 0x100000000);
  let low = step >>> 0;
  for (let i = 7; i >= 4; i--) {
    counter[i] = low & 255;
    low = low >>> 8;
  }
  for (let i = 3; i >= 0; i--) {
    counter[i] = high & 255;
    high = Math.floor(high / 256);
  }

  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function isValidTotpFormat(code) {
  return typeof code === "string" && /^[0-9]{6}$/.test(code.replace(/\s/g, ""));
}

/**
 * Checks a code against the current slot and one on either side.
 *
 * The one-slot window is what lets a phone whose clock drifts by a few seconds
 * still work; it costs ninety seconds of validity rather than thirty.
 *
 * Returns { ok, step }. `step` is the slot that matched and the caller must
 * store it: without that, a code read over someone's shoulder stays usable for
 * the rest of its window. Replay is refused by comparing against the last
 * accepted step, not by trusting the clock.
 */
export async function verifyTotp(secretBase32, code, { lastStep = null, atMs = Date.now() } = {}) {
  const clean = String(code || "").replace(/\s/g, "");
  if (!isValidTotpFormat(clean)) return { ok: false, reason: "format" };
  if (!secretBase32) return { ok: false, reason: "no secret" };

  const now = totpStep(atMs);
  for (const step of [now, now - 1, now + 1]) {
    if (lastStep !== null && lastStep !== undefined && step <= Number(lastStep)) continue;
    const expected = await totpCode(secretBase32, step);
    // Fixed-length digit strings, compared without an early exit.
    let diff = 0;
    for (let i = 0; i < DIGITS; i++) diff |= expected.charCodeAt(i) ^ clean.charCodeAt(i);
    if (diff === 0) return { ok: true, step };
  }
  return { ok: false, reason: "mismatch" };
}

/** The string behind the QR. Defaults (SHA1, 6 digits, 30s) are left out. */
export function otpauthUri({ secret, account, issuer = "Plately Support" }) {
  const label = `${issuer}:${account}`;
  return (
    "otpauth://totp/" +
    encodeURIComponent(label) +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}`
  );
}

/** "ABCD EFGH …" — the form a person has to retype when the camera fails. */
export function groupSecret(secret) {
  return String(secret).replace(/(.{4})/g, "$1 ").trim();
}

// ============================================================================
// QR code — byte mode, error correction M, versions 1 to 14
// ============================================================================

// Per version: [ecCodewordsPerBlock, blocksInGroup1, dataCodewordsInGroup1,
//               blocksInGroup2, dataCodewordsInGroup2]. Level M only.
const RS_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
  11: [30, 1, 50, 4, 51],
  12: [22, 6, 36, 2, 37],
  13: [22, 8, 37, 1, 38],
  14: [24, 4, 40, 5, 41],
};

const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
};

function dataCodewords(version) {
  const [, b1, d1, b2, d2] = RS_M[version];
  return b1 * d1 + b2 * d2;
}

// ---- GF(256), primitive polynomial 0x11D ----------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function ecBlock(data, ecCount) {
  const gen = generatorPoly(ecCount);
  const out = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.shift();
    out.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i++) out[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return out;
}

// ---- bit stream ------------------------------------------------------------

function encodeData(bytes, version) {
  const total = dataCodewords(version);
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  // Terminator, then pad to a whole codeword, then the two alternating pad
  // bytes the specification names.
  for (let i = 0; i < 4 && bits.length < total * 8; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
    codewords.push(value);
  }
  const pad = [0xec, 0x11];
  for (let i = 0; codewords.length < total; i++) codewords.push(pad[i % 2]);
  return codewords;
}

/** Data blocks and EC blocks, interleaved the way the reader expects them. */
function buildCodewords(bytes, version) {
  const [ecCount, b1, d1, b2, d2] = RS_M[version];
  const flat = encodeData(bytes, version);

  const blocks = [];
  let at = 0;
  for (let i = 0; i < b1; i++) blocks.push(flat.slice(at, (at += d1)));
  for (let i = 0; i < b2; i++) blocks.push(flat.slice(at, (at += d2)));
  const ec = blocks.map((block) => ecBlock(block, ecCount));

  const out = [];
  const longest = Math.max(d1, d2);
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecCount; i++) {
    for (const block of ec) out.push(block[i]);
  }
  return out;
}

// ---- the matrix ------------------------------------------------------------

function placeFunctionPatterns(size, version) {
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));

  // The 7x7 eye plus the one-module light separator that rings it. The
  // separator has to be written explicitly: -1 and 7 are outside the eye, so
  // folding them into the "outer ring" test would paint a dark line down the
  // side of every finder and no reader would recognise the pattern.
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = row + r;
        const x = col + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const separator = r === -1 || r === 7 || c === -1 || c === 7;
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        modules[y][x] = !separator && (ring || core);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    modules[6][i] = i % 2 === 0;
    modules[i][6] = i % 2 === 0;
  }

  // Alignment patterns, skipping the three that would sit on a finder.
  const centres = ALIGNMENT[version];
  for (const row of centres) {
    for (const col of centres) {
      const onFinder =
        (row === 6 && col === 6) ||
        (row === 6 && col === size - 7) ||
        (row === size - 7 && col === 6);
      if (onFinder) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          modules[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        }
      }
    }
  }

  // The one module that is always dark, then the reserved format areas so the
  // data walk below steps over them.
  modules[size - 8][8] = true;
  for (let i = 0; i < 9; i++) {
    if (modules[8][i] === null) modules[8][i] = false;
    if (modules[i][8] === null) modules[i][8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (modules[8][size - 1 - i] === null) modules[8][size - 1 - i] = false;
    if (modules[size - 1 - i][8] === null) modules[size - 1 - i][8] = false;
  }

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >> i) & 1) === 1;
      const row = Math.floor(i / 3);
      const col = size - 11 + (i % 3);
      modules[row][col] = bit;
      modules[col][row] = bit;
    }
  }

  return modules;
}

/** BCH(18,6) — the version block printed on versions 7 and up. */
function versionBits(version) {
  let rest = version << 12;
  for (let i = 0; i < 12; i++) {
    if ((rest >> (17 - i)) & 1) rest ^= 0x1f25 << (5 - i);
  }
  return (version << 12) | rest;
}

/** BCH(15,5), plus the fixed mask the specification applies to it. */
function formatBits(mask) {
  const data = (0b00 << 3) | mask; // 00 = error correction level M
  let rest = data << 10;
  for (let i = 0; i < 5; i++) {
    if ((rest >> (14 - i)) & 1) rest ^= 0x537 << (4 - i);
  }
  return ((data << 10) | rest) ^ 0x5412;
}

function placeFormat(modules, size, mask) {
  const bits = formatBits(mask);
  // Written most significant bit first: `i` is the position in the reading
  // order below, not the bit's own index. Getting this backwards produces a
  // symbol that looks perfect and decodes to nothing, because a reader takes
  // the format block as its very first instruction.
  const bit = (i) => ((bits >> (14 - i)) & 1) === 1;

  for (let i = 0; i <= 5; i++) modules[8][i] = bit(i);
  modules[8][7] = bit(6);
  modules[8][8] = bit(7);
  modules[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) modules[14 - i][8] = bit(i);

  // The second copy is split 7 + 8, not 8 + 7: the eighth module of the
  // bottom-left run is the module that is always dark, and it belongs to no
  // format bit at all.
  for (let i = 0; i <= 6; i++) modules[size - 1 - i][8] = bit(i);
  for (let i = 7; i <= 14; i++) modules[8][size - 15 + i] = bit(i);
}

function maskAt(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

/** Walks the zig-zag up from the bottom right, stepping over the timing column. */
function placeData(modules, size, codewords, mask) {
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let c = 0; c < 2; c++) {
        const col = right - c;
        if (modules[row][col] !== null) continue;
        const byte = codewords[bitIndex >> 3];
        const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
        modules[row][col] = (bit === 1) !== maskAt(mask, row, col);
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

/** The four penalty rules. Lower is easier for a camera to read. */
function penalty(modules, size) {
  let score = 0;

  const runScore = (line) => {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  };
  for (let i = 0; i < size; i++) {
    runScore(modules[i]);
    runScore(modules.map((row) => row[i]));
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const first = modules[r][c];
      if (first === modules[r][c + 1] && first === modules[r + 1][c] && first === modules[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  const FINDER = [true, false, true, true, true, false, true];
  const hasPattern = (line, at) => {
    for (let i = 0; i < 7; i++) if (line[at + i] !== FINDER[i]) return false;
    const quiet = (part, need) => part.length >= need && part.every((value) => value === false);
    return quiet(line.slice(Math.max(0, at - 4), at), 4) || quiet(line.slice(at + 7, at + 11), 4);
  };
  for (let i = 0; i < size; i++) {
    const row = modules[i];
    const col = modules.map((r) => r[i]);
    for (let at = 0; at + 7 <= size; at++) {
      if (hasPattern(row, at)) score += 40;
      if (hasPattern(col, at)) score += 40;
    }
  }

  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * Encodes `text` and returns a boolean matrix, quiet zone excluded.
 * Throws if the text is longer than a version-14 symbol can hold.
 */
export function qrMatrix(text) {
  const bytes = encoder.encode(String(text));

  let version = 0;
  for (let candidate = 1; candidate <= 14; candidate++) {
    // The header is four mode bits plus the length field, so a byte-mode
    // payload loses one and a half (or two and a half) codewords to it.
    const capacity = dataCodewords(candidate) - (candidate < 10 ? 2 : 3);
    if (bytes.length <= capacity) {
      version = candidate;
      break;
    }
  }
  if (!version) throw new Error("too long for a version 14 QR code");

  const size = version * 4 + 17;
  const codewords = buildCodewords(bytes, version);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = placeFunctionPatterns(size, version);
    placeData(modules, size, codewords, mask);
    placeFormat(modules, size, mask);
    const score = penalty(modules, size);
    if (!best || score < best.score) best = { score, modules };
  }
  return best.modules;
}

/**
 * The same code as an SVG string, ready to drop into the page.
 *
 * Always black on white, whatever theme the panel is wearing: a camera reads
 * contrast, and a dark-on-dark QR code is a decoration, not a credential.
 */
export function qrSvg(text, { size = 200, quiet = 4 } = {}) {
  const modules = qrMatrix(text);
  const count = modules.length;
  const span = count + quiet * 2;

  let path = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (modules[row][col]) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="QR code for the authenticator app">` +
    `<rect width="${span}" height="${span}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/></svg>`
  );
}
