// ============================================================================
// /api/gift/* — the gift page behind https://plately.eu/giftcards/<uuid>
//
// Public, like /api/help, and with the same posture: everything here has to
// assume the caller is hostile. A gift link is a bearer credential for a paid
// card, so this is a place somebody might point a script at.
//
// Routes:
//
//   GET  /api/gift/session   what the page needs to draw itself: the Turnstile
//                            site key, and whether the bot check is live at all
//   POST /api/gift/open      the "unwrap" click. Turnstile first, then the
//                            database — never the other way round
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
import { hmacHex } from "../_lib/auth.js";
import { explainSetupFailure } from "../_lib/setup-error.js";
import { verifyTurnstile, clientIp } from "../_lib/staff-session.js";
import { parseGiftLink } from "../_lib/gift-link.js";

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
        });
      case "POST open":
        return await open(request);
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
