// The gift link id is the entire credential for a paid card, and the shape
// check is what keeps junk from ever reaching the database. Exactly version 7,
// exactly the RFC variant, exactly lower-case out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGiftLink } from "../api/_lib/gift-link.js";

const GOOD = "01924c1e-5f2a-7b3c-8d4e-1f2a3b4c5d6e";

test("accepts a version-7 uuid and canonicalises it", () => {
  assert.equal(parseGiftLink(GOOD), GOOD);
  assert.equal(parseGiftLink(GOOD.toUpperCase()), GOOD);
  assert.equal(parseGiftLink(`  ${GOOD}\n`), GOOD);
});

test("accepts every RFC variant nibble", () => {
  for (const v of ["8", "9", "a", "b"]) {
    assert.equal(parseGiftLink(GOOD.replace("-8d4e-", `-${v}d4e-`)), GOOD.replace("-8d4e-", `-${v}d4e-`));
  }
});

test("refuses other uuid versions and malformed values", () => {
  assert.equal(parseGiftLink(GOOD.replace("-7b3c-", "-4b3c-")), null, "v4");
  assert.equal(parseGiftLink(GOOD.replace("-7b3c-", "-1b3c-")), null, "v1");
  assert.equal(parseGiftLink(GOOD.replace("-8d4e-", "-cd4e-")), null, "bad variant");
  assert.equal(parseGiftLink(GOOD.slice(0, -1)), null, "too short");
  assert.equal(parseGiftLink(GOOD + "0"), null, "too long");
  assert.equal(parseGiftLink(GOOD.replace(/-/g, "")), null, "no dashes");
  assert.equal(parseGiftLink(""), null);
  assert.equal(parseGiftLink(null), null);
  assert.equal(parseGiftLink(undefined), null);
  assert.equal(parseGiftLink(123), null);
  assert.equal(parseGiftLink({ toString: () => GOOD }), null, "objects are not strings");
});
