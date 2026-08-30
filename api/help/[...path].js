// ============================================================================
// /api/help/* — the public help desk behind https://plately.eu/help
//
// Its own function rather than another branch of /api/support, because the
// trust boundary is the opposite one. Everything in /api/support assumes a
// staff session and refuses without it; everything here is reachable by
// anybody on the internet and has to assume the caller is hostile. Keeping the
// two in one file would mean one forgotten guard turns a contact form into an
// unauthenticated read of the ticket database.
//
// Routes:
//
//   GET  /api/help/session   what the page needs to draw itself: the Turnstile
//                            site key, whether Google sign-in is available, and
//                            the address of whoever is already signed in here
//   POST /api/help/google    hands back a Google URL (+ signed state cookie)
//   GET  /api/help/callback  Google returns; we verify the address and store it
//                            in a short signed cookie. No account is created
//                            and nothing is written to the database
//   POST /api/help/submit    the form itself → a ticket + a confirmation e-mail
//   POST /api/help/signout   drops the cookie above
//
// Signing in is entirely optional and buys exactly one thing: the address on
// the ticket is one Google vouched for rather than one somebody typed. An
// agent can see which it was — support_ingest_form records it — and that is
// the difference between "I am locked out of this account" being actionable
// and being a request to take a stranger's word for it.
// ============================================================================

import { hmacHex, timingSafeEqual } from "../_lib/auth.js";
import { explainSetupFailure } from "../_lib/setup-error.js";
import { rpc, selectOne } from "../_lib/db.js";
import { sendMail, isMailConfigured, ticketRef } from "../_lib/mail.js";
import { verifyTurnstile, clientIp } from "../_lib/staff-session.js";

export const config = { runtime: "edge" };

const IDENTITY_COOKIE = "plately_help_id";
const STATE_COOKIE = "plately_help_oauth";
const IDENTITY_TTL_MS = 60 * 60 * 1000; // an hour is longer than filling a form
const STATE_TTL_MS = 10 * 60 * 1000;

// Kept in step with TAGS in api/support/[...path].js, because a tag outside
// that list would show up in the panel's filters as a category nobody can
// select. The public labels live in the page; these are the stored values.
const CATEGORIES = ["Billing", "Bug", "Feature request", "How-to", "Account", "Other"];

// Enough for a detailed bug report, far short of a paste-bomb.
const MAX_BODY = 5000;
const MAX_SUBJECT = 160;
const MAX_NAME = 80;
const MAX_PER_HOUR = 5;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store", ...headers } });
}

function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  const out = {};
  for (const part of header.split(";")) {
    const piece = part.trim();
    if (!piece) continue;
    const idx = piece.indexOf("=");
    if (idx < 0) continue;
    out[piece.slice(0, idx)] = decodeURIComponent(piece.slice(idx + 1));
  }
  return out;
}

/**
 * Lax, not Strict, and this one genuinely needs to be.
 *
 * The identity cookie has to survive Google's top-level redirect back to
 * /help, which is a cross-site navigation; Strict would drop it and the
 * address would vanish at the exact moment it was earned. Lax is safe here
 * because this cookie authorises nothing — the worst a forged request can do
 * is put a Google-verified address on a support ticket.
 */
function cookieHeader(name, value, maxAgeSeconds) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function clearCookie(name) {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// signed payloads — the same shape the staff routes use
// ---------------------------------------------------------------------------

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is not set");
  return value;
}

// Names arrive from Google as UTF-8 and atob hands back one byte per
// character, so both directions go through an encoder rather than the old
// escape/unescape pair — otherwise "Łukasz" comes back mangled.
async function pack(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const body = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${body}.${await hmacHex(secret(), body)}`;
}

async function unpack(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  if (!timingSafeEqual(mac, await hmacHex(secret(), body))) return null;
  try {
    const padded = body.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(body.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return Date.now() > payload.exp ? null : payload;
  } catch {
    return null;
  }
}

function redirectUri(request) {
  return `${new URL(request.url).origin}/api/help/callback`;
}

/** Same reasoning as the staff callback: see the note there. */
function decodeJwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * A stable, non-reversible stand-in for the sender's IP.
 *
 * The rate limit needs to recognise a repeat visitor; it does not need to know
 * where they live, and an audit table full of raw addresses is a liability
 * nobody asked for. Keyed with PEPPER so the hashes cannot be recomputed from
 * a stolen dump alone.
 */
async function ipHash(request) {
  const ip = clientIp(request);
  if (!ip) return null;
  const key = process.env.PEPPER || process.env.SESSION_SECRET;
  if (!key) return null;
  return (await hmacHex(key, `help:${ip}`)).slice(0, 32);
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export default async function handler(request) {
  const url = new URL(request.url);
  // Single segment, hyphenated — same platform constraint as /api/staff.
  const route = url.pathname
    .replace(/^\/api\/help\/?/, "")
    .replace(/\/+$/, "")
    .replace(/\//g, "-");

  try {
    switch (`${request.method} ${route}`) {
      case "GET session":
        return await readSession(request);
      case "POST google":
        return await startGoogle(request);
      case "GET callback":
        return await finishGoogle(request);
      case "POST submit":
        return await submit(request);
      case "POST signout":
        return json({ ok: true }, 200, { "Set-Cookie": clearCookie(IDENTITY_COOKIE) });
      default:
        return json({ error: "Unknown route" }, 404);
    }
  } catch (err) {
    console.error("help route failed", route, err);
    // A setup step nobody has run yet is not a fault, and saying so turns a
    // dead end into a fix. Anything else keeps the shrug.
    return json({ error: explainSetupFailure(err) || "Something went wrong on our side" }, 500);
  }
}

async function readIdentity(request) {
  const payload = await unpack(parseCookies(request)[IDENTITY_COOKIE]);
  return payload && payload.kind === "help" ? payload : null;
}

async function readSession(request) {
  const identity = await readIdentity(request);
  return json({
    email: identity ? identity.em : null,
    name: identity ? identity.nm || null : null,
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
    googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID),
    // The page says so plainly rather than accepting a message it cannot
    // deliver and leaving the person waiting for a reply that never comes.
    mailConfigured: isMailConfigured(),
    categories: CATEGORIES,
  });
}

// --- Google, for the address only -------------------------------------------

async function startGoogle(request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return json({ error: "Google sign-in is not configured" }, 500);

  const state = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const cookie = await pack({ kind: "help_state", state, exp: Date.now() + STATE_TTL_MS });

  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri(request));
  authorize.searchParams.set("response_type", "code");
  // Nothing beyond the address and a name to greet them by. No offline access,
  // no refresh token: there is nothing here to come back for later.
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("prompt", "select_account");

  return json(
    { url: authorize.toString() },
    200,
    { "Set-Cookie": cookieHeader(STATE_COOKIE, cookie, Math.floor(STATE_TTL_MS / 1000)) }
  );
}

async function finishGoogle(request) {
  const url = new URL(request.url);
  const drop = clearCookie(STATE_COOKIE);
  // Errors come back on the page rather than as JSON: this is a top-level
  // browser navigation, so whatever it answers is what the person reads.
  const fail = (reason) => redirect(`/help?signin=${reason}`, { "Set-Cookie": drop });

  if (url.searchParams.get("error")) return fail("cancelled");

  const stored = await unpack(parseCookies(request)[STATE_COOKIE]);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!stored || stored.kind !== "help_state" || !state || !code) return fail("expired");
  if (!timingSafeEqual(state, stored.state)) return fail("expired");

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail("unconfigured");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(request),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return fail("failed");

  const tokens = await tokenRes.json().catch(() => ({}));
  const claims = decodeJwtPayload(tokens.id_token);
  if (!claims || claims.aud !== clientId) return fail("failed");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) return fail("failed");
  if (typeof claims.exp === "number" && Date.now() / 1000 > claims.exp) return fail("expired");
  // An unverified address is worth less than a typed one, because it carries
  // an implication of proof it does not have.
  if (claims.email_verified === false) return fail("unverified");

  const email = String(claims.email || "").toLowerCase();
  if (!email) return fail("failed");

  const identity = await pack({
    kind: "help",
    em: email,
    nm: claims.name || null,
    exp: Date.now() + IDENTITY_TTL_MS,
  });

  const headers = new Headers({ Location: "/help?signin=ok", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", drop);
  headers.append("Set-Cookie", cookieHeader(IDENTITY_COOKIE, identity, Math.floor(IDENTITY_TTL_MS / 1000)));
  return new Response(null, { status: 302, headers });
}

// --- the form ----------------------------------------------------------------

async function submit(request) {
  const payload = await request.json().catch(() => ({}));
  const { category, subject, body, name, turnstileToken } = payload;

  const check = await verifyTurnstile(turnstileToken, clientIp(request));
  if (!check.ok) {
    return json({ error: `Verification failed: ${check.reason}. Reload the page and try again.` }, 400);
  }

  // A signed-in address always wins over a typed one. Otherwise the sign-in
  // button would be decorative: anyone could sign in as themselves and then
  // put somebody else's address in the field.
  const identity = await readIdentity(request);
  const typed = String(payload.email || "").trim().toLowerCase();
  const email = identity ? identity.em : typed;

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: "That e-mail address does not look right." }, 400);
  }
  if (!CATEGORIES.includes(category)) {
    return json({ error: "Choose what your message is about." }, 400);
  }
  const cleanSubject = String(subject || "").trim().slice(0, MAX_SUBJECT);
  const cleanBody = String(body || "").trim().slice(0, MAX_BODY);
  if (cleanSubject.length < 3) return json({ error: "Give your message a short subject." }, 400);
  if (cleanBody.length < 20) {
    return json({ error: "Tell us a little more — at least a sentence or two." }, 400);
  }
  if (!isMailConfigured()) {
    return json({ error: "The help desk is temporarily unable to accept messages. Please try again later." }, 503);
  }

  const result = await rpc("support_ingest_form", {
    p_payload: {
      email,
      name: identity ? identity.nm : String(name || "").trim().slice(0, MAX_NAME) || null,
      subject: cleanSubject,
      text: cleanBody,
      tag: category,
      locale: String(payload.locale || "").slice(0, 8) || null,
      ip_hash: await ipHash(request),
      email_verified: Boolean(identity),
    },
    p_max_per_hour: MAX_PER_HOUR,
  });

  if (!result?.ok) {
    if (result?.error === "rate_limited") {
      return json(
        { error: "That is several messages in a short time. Reply to the e-mail you already have, or try again in an hour." },
        429
      );
    }
    return json({ error: "We could not file that message. Please try again." }, 500);
  }

  const reference = ticketRef(result.number);

  // The sender comes from the desk's own settings, not from the environment
  // alone, so that changing it in Settings -> E-mail channel changes it here
  // too. Out of the box that is Plately Support <contact@plately.eu>, and a
  // reply to it lands straight back in the same ticket.
  const settings = await selectOne("support_settings", "select=from_name,from_email&id=is.true");

  // The confirmation is the whole promise of the page: the message landed, it
  // has a number, and a person will answer it. A failure to send does NOT undo
  // the ticket — the desk has the message either way, and telling someone
  // their report vanished when it did not is the worse of the two errors.
  let confirmed = true;
  try {
    await sendMail({
      to: email,
      subject: `We have your message [${reference}]`,
      text: confirmationText({ reference, subject: cleanSubject, category, body: cleanBody }),
      fromName: settings?.from_name,
      from: settings?.from_email,
    });
  } catch (err) {
    console.error("help confirmation failed", err);
    confirmed = false;
  }

  return json({ ok: true, reference, number: result.number, confirmed, email });
}

/**
 * Written to be replied to. The reference in the subject is what threads the
 * answer back onto this ticket if they write again from their own mailbox —
 * support_ingest_email matches on exactly that.
 */
function confirmationText({ reference, subject, category, body }) {
  return [
    "Thanks for writing to Plately support.",
    "",
    `We have your message and it is now ticket ${reference}. A person reads every one of them,`,
    "and you will get a real answer at this address — usually within one business day.",
    "",
    "You do not need to do anything else. If you want to add something, just reply to this",
    "e-mail and it joins the same conversation.",
    "",
    "— — —",
    `Reference: ${reference}`,
    `Category:  ${category}`,
    `Subject:   ${subject}`,
    "",
    "What you sent us:",
    "",
    body,
    "",
    "— — —",
    "Plately · plately.eu",
    "This is an automatic confirmation. Replying to it reaches the support team.",
  ].join("\n");
}
