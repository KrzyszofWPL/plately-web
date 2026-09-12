// ============================================================================
// /api/gift/* — the gift page behind https://plately.eu/giftcards/<uuid>
//
// Public, like /api/help, and with the same posture: everything here has to
// assume the caller is hostile. A gift link is a bearer credential for a paid
// card, so this is a place somebody might point a script at.
//
// Routes:
//
//   GET  /api/gift/session   what the pages need to draw themselves: the
//                            Turnstile site key, whether the bot check is live,
//                            and the shop's prices
//   POST /api/gift/open      the "unwrap" click. Turnstile first, then the
//                            database — never the other way round
//   POST /api/gift/checkout  the shop: a card chosen, an e-mail typed. Turnstile,
//                            then an order row, then an invoice at the provider
//   POST /api/gift/ipn       the provider saying an invoice changed state. Signed;
//                            the first `paid` issues the card and mails the link
//   GET  /api/gift/order     the "thank you" page polling its own order
//
// The order matters more than anything else in this file. Cloudflare decides
// whether there is a person on the other end BEFORE the link is looked up, and
// a refusal answers 403 with nothing about the card in it: not "valid", not
// "invalid". A bot that fails the check learns exactly as much as a bot that
// never sent the request. Only a request that passed gets a real answer.
//
// The database then adds its own limit per address (gift_card_open, in the
// app's schema), so even a client that clears Turnstile once cannot try links
// in bulk on that token — every token is single-use, and every open costs one.
// ============================================================================

export const config = { runtime: "edge" };

import { rpc } from "../_lib/db.js";
import { hmacHex, timingSafeEqual } from "../_lib/auth.js";
import { explainSetupFailure } from "../_lib/setup-error.js";
import { verifyTurnstile, clientIp } from "../_lib/staff-session.js";
import { parseGiftLink } from "../_lib/gift-link.js";
import { PRICES, DAYS, PROMO_PERCENT, CURRENCY, isPlan, isPeriod, chargedPrice, mapStatus, ipnSignature, cleanEmail, parseOrderId } from "../_lib/gift-shop.js";
import { sendMail, isMailConfigured } from "../_lib/mail.js";
import { giftPurchaseEmail, identities } from "../_lib/email-templates.js";

// The same provider the app pays through, with the site's own keys.
const PROVIDER_API_KEY = process.env.NOWPAYMENTS_API_KEY || "";
const PROVIDER_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || "";
const PROVIDER_API_URL = process.env.NOWPAYMENTS_API_URL || "https://api.nowpayments.io/v1";
const SITE = (process.env.SITE_URL || "https://www.plately.eu").replace(/\/+$/, "");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * The same stand-in for the visitor's address the help form uses: keyed with
 * PEPPER, so the log the rate limit reads cannot be turned back into IPs from
 * a dump. Null when there is nothing to key with — the database then simply
 * does not rate-limit, which is the honest outcome of that configuration.
 */
async function ipHash(request) {
  const ip = clientIp(request);
  if (!ip) return null;
  const key = process.env.PEPPER || process.env.SESSION_SECRET;
  if (!key) return null;
  return (await hmacHex(key, `gift:${ip}`)).slice(0, 32);
}

export default async function handler(request) {
  const url = new URL(request.url);
  const route = url.pathname
    .replace(/^\/api\/gift\/?/, "")
    .replace(/\/+$/, "")
    .replace(/\//g, "-");

  try {
    switch (`${request.method} ${route}`) {
      case "GET session":
        return json({
          turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
          // Told to the page so it can say so rather than pretend. With no
          // keys the server passes every open, which is the same rule the
          // help form and the staff panel follow while keys are being set up.
          botCheck: Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY),
          // The shop draws its price list from here, so the number on the
          // button and the number on the invoice come from one table.
          shop: {
            configured: Boolean(PROVIDER_API_KEY),
            prices: PRICES,
            days: DAYS,
            promoPercent: PROMO_PERCENT,
            currency: CURRENCY,
          },
        });
      case "POST open":
        return await open(request);
      case "POST checkout":
        return await checkout(request);
      case "POST ipn":
        return await ipn(request);
      case "GET order":
        return await order(url);
      default:
        return json({ error: "Unknown route" }, 404);
    }
  } catch (err) {
    console.error("gift route failed", route, err);
    return json({ error: explainSetupFailure(err) || "Something went wrong on our side" }, 500);
  }
}

async function open(request) {
  const body = await request.json().catch(() => ({}));

  // 1. Is there a person? Decided before the link is even parsed, so a
  //    refused request costs nothing and reveals nothing.
  const check = await verifyTurnstile(body.turnstileToken, clientIp(request));
  if (!check.ok) {
    // `reason` describes our configuration (a missing key, a mismatched
    // widget) or the token's own state — never the card. The page shows it
    // in small print so a misconfigured deployment is diagnosable from the
    // browser, the same call api/_lib/setup-error.js makes.
    return json({ error: "verification", reason: check.reason || null }, 403);
  }

  // 2. Only now: is this even the shape of a link?
  const link = parseGiftLink(body.id);
  if (!link) return json({ found: false, reason: "not_found" });

  // 3. The card. `gift_card_open` does its own per-address limit and answers
  //    `found: false` for both "no such row" and "the ciphertext does not
  //    open with this link" — the page needs no more than that.
  const card = await rpc("gift_card_open", { p_link: link, p_ip_hash: await ipHash(request) });
  const result = card && typeof card === "object" ? card : { found: false, reason: "not_found" };

  if (result.found !== true) {
    if (result.reason === "rate_limited") return json({ error: "rate_limited" }, 429);
    return json({ found: false });
  }

  return json({
    found: true,
    state: result.state,
    plan: result.plan,
    days: result.days,
    // Present only while the card is still open; the database withholds it
    // for a redeemed, voided or expired card because there is nothing left
    // for it to do.
    code: result.code || null,
    deadline: result.deadline || null,
    redeemedAt: result.redeemedAt || null,
  });
}

// --- the shop ------------------------------------------------------------------
//
// No account, on purpose: a gift is bought for somebody else, and asking the
// buyer to sign up for an app they will never use is where a gift purchase
// dies. The buyer is an e-mail address. Everything else is the same machinery
// the app's checkout runs on — the same provider, the same webhook shape —
// with the order living in `gift_orders` instead of `payments`.

async function checkout(request) {
  if (!PROVIDER_API_KEY) return json({ error: "shop_off" }, 503);
  const body = await request.json().catch(() => ({}));

  // 1. A person, before anything costs us an invoice.
  const check = await verifyTurnstile(body.turnstileToken, clientIp(request));
  if (!check.ok) return json({ error: "verification", reason: check.reason || null }, 403);

  // 2. The choice. The price is never read from the request.
  const plan = body.plan, period = body.period;
  const email = cleanEmail(body.email);
  const lang = /^[a-z]{2}$/.test(String(body.lang || "")) ? body.lang : "en";
  if (!isPlan(plan) || !isPeriod(period)) return json({ error: "bad_request" }, 400);
  if (!email) return json({ error: "bad_email" }, 400);
  const amount = chargedPrice(plan, period);

  // 3. The order row, which also enforces a per-address limit on orders.
  const created = await rpc("gift_shop_create", {
    p_email: email, p_lang: lang, p_plan: plan, p_period: period, p_days: DAYS[period],
    p_amount: amount, p_currency: CURRENCY, p_ip_hash: await ipHash(request),
  });
  if (!created || created.error) return json({ error: (created && created.error) || "order_failed" }, created && created.error === "rate_limited" ? 429 : 400);
  const orderId = created.id;

  // 4. The invoice. `order_id` is ours and is the only field read on the way
  //    back; the IPN and the return trip both carry it.
  let invoice;
  try {
    const res = await fetch(`${PROVIDER_API_URL}/invoice`, {
      method: "POST",
      headers: { "x-api-key": PROVIDER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        price_amount: amount,
        price_currency: CURRENCY,
        order_id: `shop:${orderId}`,
        order_description: `Plately gift card — ${plan} (${DAYS[period]} days)`,
        ipn_callback_url: `${SITE}/api/gift/ipn`,
        success_url: `${SITE}/giftcards?order=${orderId}`,
        cancel_url: `${SITE}/giftcards?order=${orderId}&cancel=1`,
      }),
    });
    invoice = await res.json().catch(() => ({}));
    if (!res.ok || !invoice?.id) {
      console.error("gift shop: provider rejected invoice", res.status, invoice);
      return json({ error: "provider_error", detail: invoice?.message || invoice?.error || null }, 502);
    }
  } catch (err) {
    console.error("gift shop: provider unreachable", err?.message || err);
    return json({ error: "provider_unreachable" }, 502);
  }

  await rpc("gift_shop_attach", { p_id: orderId, p_provider_payment_id: String(invoice.id) });
  return json({ orderId, checkoutUrl: invoice.invoice_url, amount, currency: CURRENCY });
}

/**
 * The provider's webhook. Signed with HMAC-SHA512 over the body with its keys
 * sorted; an unsigned or mis-signed call is refused before anything is read,
 * because a webhook that issues cards on an unsigned request is a public
 * "give me a card" endpoint.
 */
async function ipn(request) {
  const signature = (request.headers.get("x-nowpayments-sig") || "").trim();
  const rawBody = await request.text();
  let event;
  try { event = JSON.parse(rawBody); } catch { return json({ error: "bad_json" }, 400); }
  if (!PROVIDER_IPN_SECRET || !signature) return json({ error: "bad_signature" }, 401);
  const expected = await ipnSignature(PROVIDER_IPN_SECRET, event);
  if (!timingSafeEqual(expected, signature)) {
    console.error("gift shop: rejected IPN with bad signature");
    return json({ error: "bad_signature" }, 401);
  }

  const providerId = String(event.invoice_id ?? event.payment_id ?? "");
  const status = mapStatus(String(event.payment_status || ""));
  const result = await rpc("gift_shop_update", { p_provider_payment_id: providerId, p_status: status, p_raw: event });
  // 200 for an unknown order on purpose: a retry will not make it known, and
  // providers hammer non-2xx responses for days.
  if (!result || result.found !== true) return json({ ok: false, error: "unknown_order" });

  // The first `paid` is the moment the card exists. Mail the link; the page
  // the buyer is looking at finds it on its next poll either way.
  if (result.first_paid && result.link && result.code) {
    const link = `${SITE}/giftcards/${result.link}`;
    if (isMailConfigured()) {
      try {
        const mail = giftPurchaseEmail({ link, code: result.code, plan: result.plan, days: result.days, lang: result.lang });
        const from = identities().supportNoreply;
        await sendMail({ to: result.email, subject: mail.subject, text: mail.text, html: mail.html, from: from.email, fromName: from.name, autoSubmitted: "auto-generated" });
        await rpc("gift_shop_mailed", { p_id: result.id });
      } catch (err) {
        // Logged, never fatal: the order is paid and the card issued; the
        // page shows the link, and support can re-send from the order row.
        console.error("gift shop: mail failed for order", result.id, err?.message || err);
      }
    }
  }
  return json({ ok: true });
}

/** The "thank you" page, polling. The order id is the credential. */
async function order(url) {
  const id = parseOrderId(url.searchParams.get("id"));
  if (!id) return json({ found: false });
  const row = await rpc("gift_shop_read", { p_id: id });
  if (!row || row.found !== true) return json({ found: false });
  return json({
    found: true,
    status: row.status,
    plan: row.plan,
    days: row.days,
    amount: row.amount,
    currency: row.currency,
    email: row.email,
    link: row.link ? `${SITE}/giftcards/${row.link}` : null,
    code: row.code || null,
    mailed: Boolean(row.mailed),
  });
}
