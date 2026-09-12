// The shop's pure parts. The one that matters most is the IPN signature:
// a webhook that issues cards has to refuse anything it cannot verify, and
// the verification has to compute exactly what the provider computed — the
// body re-serialised with its keys sorted, HMAC-SHA512, hex. Node's crypto
// stands in for the provider here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  PRICES, PROMO_PERCENT, chargedPrice, mapStatus, sortedStringify, ipnSignature, cleanEmail, parseOrderId, isPlan, isPeriod,
} from "../api/_lib/gift-shop.js";

test("the charged price is the sticker price after the promotion, to the cent", () => {
  for (const plan of Object.keys(PRICES)) {
    for (const period of Object.keys(PRICES[plan])) {
      const expected = Math.round(PRICES[plan][period] * (100 - PROMO_PERCENT)) / 100;
      assert.equal(chargedPrice(plan, period), expected);
      assert.ok(chargedPrice(plan, period) > 0, `${plan}/${period} must cost something`);
    }
  }
});

test("provider statuses map the way the app maps them", () => {
  assert.equal(mapStatus("finished"), "paid");
  assert.equal(mapStatus("confirmed"), "paid");
  assert.equal(mapStatus("confirming"), "confirming");
  assert.equal(mapStatus("sending"), "confirming");
  assert.equal(mapStatus("partially_paid"), "failed");
  assert.equal(mapStatus("failed"), "failed");
  assert.equal(mapStatus("expired"), "expired");
  assert.equal(mapStatus("refunded"), "refunded");
  assert.equal(mapStatus("waiting"), "pending");
  assert.equal(mapStatus(""), "pending");
});

test("sortedStringify orders keys recursively and keeps arrays in order", () => {
  const s = sortedStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } });
  assert.equal(s, '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
});

test("the IPN signature matches what the provider (node crypto) would produce", async () => {
  const secret = "ipn-secret-for-the-test";
  const body = { payment_status: "finished", invoice_id: 12345, order_id: "shop:abc", nested: { b: 2, a: 1 } };
  const expected = createHmac("sha512", secret).update(sortedStringify(body)).digest("hex");
  assert.equal(await ipnSignature(secret, body), expected);
  // Key order in the incoming JSON must not matter.
  const reordered = JSON.parse('{"nested":{"a":1,"b":2},"order_id":"shop:abc","invoice_id":12345,"payment_status":"finished"}');
  assert.equal(await ipnSignature(secret, reordered), expected);
  assert.notEqual(await ipnSignature("another-secret", body), expected);
});

test("e-mails are trimmed, lower-cased and shape-checked", () => {
  assert.equal(cleanEmail("  Someone@Example.COM "), "someone@example.com");
  assert.equal(cleanEmail("nope"), null);
  assert.equal(cleanEmail("a@b"), null);
  assert.equal(cleanEmail(""), null);
  assert.equal(cleanEmail(null), null);
});

test("order ids are UUIDs, plan and period come from the fixed sets", () => {
  assert.equal(parseOrderId("6F9619FF-8B86-4D11-B42D-00C04FC964FF"), "6f9619ff-8b86-4d11-b42d-00c04fc964ff");
  assert.equal(parseOrderId("not-an-id"), null);
  assert.equal(isPlan("ultra"), true);
  assert.equal(isPlan("free"), false);
  assert.equal(isPeriod("quarterly"), true);
  assert.equal(isPeriod("weekly"), false);
});
