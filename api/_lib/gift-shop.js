// ============================================================================
// The gift-card shop's pure parts: what a card costs, and how the payment
// provider's messages are read. Kept apart from the route so they can be
// tested without a request in hand.
//
// The provider is NOWPayments, the same one the app uses (Application APK/
// serverless/paymentsHandler.ts) — same API key family, same IPN signature,
// same status vocabulary. Anything that has to agree with the app is marked.
// ============================================================================

/**
 * Gross USD. Mirrors PLANS[plan].pricing in Application APK/src/lib/plans.ts
 * and PLAN_PRICES in serverless/paymentsHandler.ts — change them there first.
 * USD in every language, because the invoice is in USD in every language.
 */
export const PRICES = {
  premium: { monthly: 6.99, quarterly: 18.99, yearly: 59 },
  ultra: { monthly: 12.99, quarterly: 34.99, yearly: 119 },
};

/** Days a period buys — mirrors PERIOD_DAYS in the app. */
export const DAYS = { monthly: 31, quarterly: 92, yearly: 366 };

/**
 * Promocja: procent zniżki od PRICES. Mirrors PROMO_PERCENT in the app's
 * plans.ts and paymentsHandler.ts. CHWILOWO 99 na czas testów; potem 0.
 */
export const PROMO_PERCENT = 99;

export const CURRENCY = "usd";

export function isPlan(v) { return v === "premium" || v === "ultra"; }
export function isPeriod(v) { return v === "monthly" || v === "quarterly" || v === "yearly"; }

/** What the invoice is raised for: the sticker price after the promotion, to the cent. */
export function chargedPrice(plan, period) {
  return Math.round(PRICES[plan][period] * (100 - PROMO_PERCENT)) / 100;
}

/** Provider vocabulary → ours. Mirrors mapStatus() in the app's handler. */
export function mapStatus(providerStatus) {
  switch (providerStatus) {
    case "finished":
    case "confirmed":
      return "paid";
    case "confirming":
    case "sending":
      return "confirming";
    case "partially_paid":
    case "failed":
      return "failed";
    case "expired":
      return "expired";
    case "refunded":
      return "refunded";
    default:
      return "pending";
  }
}

/**
 * The provider signs the JSON body with its keys sorted, recursively — so the
 * body has to be re-serialised the same way before the HMAC is recomputed.
 * Mirrors sortedStringify() in the app's handler.
 */
export function sortedStringify(value) {
  if (Array.isArray(value)) return `[${value.map(sortedStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${sortedStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** HMAC-SHA512 over the sorted body, hex — the IPN signature. WebCrypto, for the edge. */
export async function ipnSignature(secret, parsedBody) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(sortedStringify(parsedBody)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export function cleanEmail(v) {
  const s = String(v || "").trim().toLowerCase();
  return s.length <= 254 && EMAIL.test(s) ? s : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseOrderId(v) {
  const s = String(v || "").trim().toLowerCase();
  return UUID.test(s) ? s : null;
}
