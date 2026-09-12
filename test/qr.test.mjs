// The QR on the back of a gift card is generated in the browser by
// public/giftcard/qr.js. The reference check — rendering the matrix and
// reading it back with OpenCV's decoder — was done by hand when the encoder
// was written (every test string below decoded to itself). What runs here
// on every push is the structure: the parts of a QR symbol a decoder locks
// on to, which are exactly the parts a botched port gets wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "public", "giftcard", "qr.js"), "utf8");
// The file is a browser script with a CommonJS escape hatch; evaluate it as one.
const mod = { exports: {} };
new Function("module", "self", src)(mod, undefined);
const { qrModules, qrSvg } = mod.exports;

const URL = "https://plately.eu/redeem?code=PLATELY-ABCD-EFGH-JKMN";

function finderAt(m, x0, y0) {
  // 7x7: dark ring, light ring, dark 3x3 core
  for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
    const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
    const want = d !== 2;
    if (m[y0 + dy][x0 + dx] !== want) return false;
  }
  return true;
}

test("a redeem link fits a version-4 symbol (33 modules) at level M", () => {
  const m = qrModules(URL);
  assert.equal(m.length, 33);
  m.forEach((row) => assert.equal(row.length, 33));
});

test("the three finder patterns sit in their corners", () => {
  const m = qrModules(URL);
  const n = m.length;
  assert.ok(finderAt(m, 0, 0), "top-left");
  assert.ok(finderAt(m, n - 7, 0), "top-right");
  assert.ok(finderAt(m, 0, n - 7), "bottom-left");
});

test("the timing patterns alternate along row and column 6", () => {
  const m = qrModules(URL);
  for (let i = 8; i < m.length - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0, `row 6, col ${i}`);
    assert.equal(m[i][6], i % 2 === 0, `col 6, row ${i}`);
  }
});

test("the dark module beside the bottom-left finder is always dark", () => {
  const m = qrModules(URL);
  assert.equal(m[m.length - 8][8], true);
});

test("the same text always gives the same symbol", () => {
  assert.deepEqual(qrModules(URL), qrModules(URL));
});

test("longer text picks a larger version; too long throws", () => {
  assert.equal(qrModules("hello").length, 21);
  assert.equal(qrModules("x".repeat(200)).length, 57);
  assert.throws(() => qrModules("x".repeat(3000)), /too long/);
});

test("the SVG carries one dark path and a quiet zone", () => {
  const svg = qrSvg("hello", { quiet: 2 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 25 25"/, "21 modules + 2 quiet each side");
  assert.match(svg, /<path d="M/);
});
