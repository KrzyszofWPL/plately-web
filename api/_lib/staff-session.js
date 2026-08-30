// ============================================================================
// Who is signed in to /support, and what are they allowed to do.
//
// Four gates guard the panel, and they are deliberately of different kinds:
//
//   1. Cloudflare Turnstile — something a bot cannot cheaply do. Checked on
//      every PIN and authenticator attempt. The sign-in page itself is not
//      gated: it only hands off to Google, which brings its own abuse
//      handling.
//   2. Google — something you have: an account we put on the staff list.
//      Ownership of the address is proved to Google, not to us.
//   3. A four-digit PIN — something you know, and something a stolen or
//      still-signed-in Google session does not carry with it.
//   4. A six-digit code from an authenticator app — something you have, on a
//      second device. This is the one that survives everything else going
//      wrong: a laptop left unlocked with a live Google session and a PIN on a
//      sticky note still does not open the console.
//
// A four-digit secret is only worth anything if guessing is expensive, so the
// PIN is: hashed with PBKDF2 over a per-person salt *and* a pepper that lives
// in an environment variable rather than the database (a stolen dump alone
// cannot brute-force 10 000 candidates), rate-limited to five tries before a
// fifteen-minute lock, and fronted by Turnstile so the tries cannot be
// automated in the first place. The authenticator code is rate-limited the
// same way and each code is accepted exactly once — see totp_last_step in the
// schema.
//
// The three steps after Google share ONE cookie, the pre-session, which
// records how far the person has got. It carries no permissions whatsoever:
// no route in this project accepts it as authorisation for anything except
// the next step of signing in.
// ============================================================================

import { hmacHex, timingSafeEqual } from "./auth.js";
import { selectOne, update, insert, q } from "./db.js";

const FULL_COOKIE = "plately_staff";
const PRE_COOKIE = "plately_staff_pre";

const FULL_TTL_MS = 12 * 60 * 60 * 1000; // one shift
const PRE_TTL_MS = 10 * 60 * 1000; // Google done, PIN and/or a code still owed

export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;
// The same five, and it buys far more here: a six-digit code has a million
// candidates and each one lives ninety seconds, so five attempts per lock-out
// is not a meaningful fraction of the space. Five is chosen for the person
// mistyping, not for the attacker.
export const MAX_TOTP_ATTEMPTS = 5;

// PBKDF2 rounds. Edge Functions are billed and capped on CPU time, so this is
// a compromise rather than the usual "as high as you can bear": the pepper is
// what actually defeats an offline attack here, and 25k rounds still costs a
// would-be brute-forcer more than the lockout ever lets them spend.
const PBKDF2_ROUNDS = 25000;

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// small encodings
// ---------------------------------------------------------------------------

function b64urlFromBytes(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(value) {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomHex(byteLength = 16) {
  return hex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function parseCookies(request) {
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

// ---------------------------------------------------------------------------
// signed cookies
// ---------------------------------------------------------------------------

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is not set");
  return value;
}

async function sign(payload) {
  const body = b64urlFromBytes(encoder.encode(JSON.stringify(payload)));
  const mac = await hmacHex(secret(), body);
  return `${body}.${mac}`;
}

async function unsign(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = await hmacHex(secret(), body);
  if (!timingSafeEqual(mac, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytesFromB64url(body)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
  return payload;
}

function cookieHeader(name, value, maxAgeSeconds) {
  // Strict rather than Lax: nothing on this site ever links into /support
  // from the outside, so there is no flow for Strict to break — and it is the
  // cheapest CSRF defence there is.
  const attrs = [
    `${name}=${value}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ];
  return attrs.join("; ");
}

export function clearCookie(name) {
  return `${name}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export const COOKIES = { FULL: FULL_COOKIE, PRE: PRE_COOKIE };

/**
 * Google is done; the PIN and the authenticator may not be. Carries no
 * permissions at all.
 *
 * `pin` records that the PIN step has been cleared, so the cookie is reissued
 * rather than replaced when the person moves on to the code. Reissuing also
 * restarts the ten minutes, which is what stops a slow enrolment — find the
 * app, scan the code, read the digits — from timing out halfway through.
 */
export async function issuePreSession(staff, { pin = false } = {}) {
  const token = await sign({
    kind: "pre",
    sid: staff.id,
    em: staff.email,
    ...(pin ? { pin: 1 } : {}),
    exp: Date.now() + PRE_TTL_MS,
  });
  return cookieHeader(PRE_COOKIE, token, Math.floor(PRE_TTL_MS / 1000));
}

export async function readPreSession(request) {
  const payload = await unsign(parseCookies(request)[PRE_COOKIE]);
  return payload && payload.kind === "pre" ? payload : null;
}

/** The pre-session, but only if the PIN step is already behind it. */
export async function readPinnedPreSession(request) {
  const payload = await readPreSession(request);
  return payload && payload.pin === 1 ? payload : null;
}

/** Every factor cleared. This is the cookie the whole panel runs on. */
export async function issueSession(staff) {
  const token = await sign({
    kind: "full",
    sid: staff.id,
    em: staff.email,
    rl: staff.role,
    tr: staff.tier,
    iat: Date.now(),
    exp: Date.now() + FULL_TTL_MS,
  });
  return cookieHeader(FULL_COOKIE, token, Math.floor(FULL_TTL_MS / 1000));
}

// ---------------------------------------------------------------------------
// PIN
// ---------------------------------------------------------------------------

function pepper() {
  // PEPPER already exists in this project for the legacy admin password; the
  // support PIN reuses it rather than inventing a second secret to lose.
  const value = process.env.PEPPER;
  if (!value) throw new Error("PEPPER is not set");
  return value;
}

export function isValidPinFormat(pin) {
  return typeof pin === "string" && /^[0-9]{4}$/.test(pin);
}

/** Rejects the handful of PINs that a person guessing by hand tries first. */
export function isWeakPin(pin) {
  if (/^(\d)\1{3}$/.test(pin)) return true; // 0000, 1111 …
  const digits = pin.split("").map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (ascending || descending) return true; // 1234, 4321
  return ["1212", "2020", "6969", "1122", "1313", "2580"].includes(pin);
}

export async function hashPin(pin, saltHex) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${pepper()}:${pin}`),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: bytesFromHex(saltHex), iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
    material,
    256
  );
  return hex(bits);
}

export async function verifyPin(pin, staff) {
  if (!staff.pin_hash || !staff.pin_salt) return false;
  const candidate = await hashPin(pin, staff.pin_salt);
  return timingSafeEqual(candidate, staff.pin_hash);
}

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------

// What Cloudflare's error codes actually mean, in words a person can act on.
// A bot gate that only ever says "verification failed" is a dead end: every
// one of these has a different fix, and none of them is "try again".
const TURNSTILE_REASONS = {
  "missing-input-secret": "TURNSTILE_SECRET_KEY is not set on this deployment",
  "invalid-input-secret":
    "TURNSTILE_SECRET_KEY is wrong — it is probably the site key pasted twice, or a key from a different widget",
  "missing-input-response": "the browser sent no Turnstile token",
  "invalid-input-response":
    "the token does not match this widget — usually the site key and the secret key come from two different widgets",
  "timeout-or-duplicate": "that token was already used or has expired — reload the page",
  "bad-request": "Cloudflare rejected the shape of the request",
  "internal-error": "Cloudflare had an internal error",
};

/**
 * Checks a widget token. Returns { ok, reason }. Only the PIN and
 * authenticator routes call it.
 *
 * With no TURNSTILE_SECRET_KEY configured this passes: the panel must stay
 * usable while the key is being set up, and Google, the PIN and the
 * authenticator are the factors carrying the weight. Same when Cloudflare
 * itself is unreachable — an outage there must not lock the desk out.
 *
 * A *misconfiguration*, though, fails closed and says what is wrong, because
 * the alternative is a sign-in button that refuses forever without a clue.
 */
export async function verifyTurnstile(token, ip) {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey) return { ok: true };
  if (!token || typeof token !== "string") {
    return {
      ok: false,
      reason: process.env.TURNSTILE_SITE_KEY
        ? "the bot check did not finish in the browser"
        : "TURNSTILE_SITE_KEY is missing, so the widget never rendered and no token could be produced",
    };
  }

  const form = new FormData();
  form.append("secret", secretKey);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);

  let data;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    data = await res.json();
  } catch {
    return { ok: true };
  }

  if (data.success === true) return { ok: true };

  const codes = Array.isArray(data["error-codes"]) ? data["error-codes"] : [];
  const explained = codes.map((code) => TURNSTILE_REASONS[code] || code);
  return { ok: false, reason: explained.join("; ") || "Cloudflare rejected the token" };
}

export function clientIp(request) {
  return (
    request.headers.get("x-real-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    null
  );
}

// ---------------------------------------------------------------------------
// permissions — the same ladder as support_tier_allows() in the schema
// ---------------------------------------------------------------------------

const AGENT_TIER_MIN = {
  read: 1,
  reply: 1,
  note: 1,
  assign_self: 1,
  set_priority: 1,
  set_tag: 1,
  solve: 1,
  refund: 2,
  escalate: 2,
  assign_other: 2,
  reopen_closed: 3,
  edit_others: 3,
  delete: 3,
  spam: 3,
};

// Things only the top of the ladder touches, whatever an agent's tier is.
const ADMIN_ONLY = new Set(["maintenance", "settings", "kb_write", "macros_write"]);
const OWNER_ONLY = new Set(["staff_write"]);

export function can(session, action) {
  const role = session?.rl;
  const tier = Number(session?.tr || 1);
  if (!role) return false;
  if (OWNER_ONLY.has(action)) return role === "owner";
  if (ADMIN_ONLY.has(action)) return role === "owner" || role === "admin";
  if (role === "owner" || role === "admin") return true;
  if (role === "viewer") return action === "read";
  if (role === "agent") {
    const min = AGENT_TIER_MIN[action];
    return min !== undefined && tier >= min;
  }
  return false;
}

/** Everything the browser needs to grey out the buttons it must not offer. */
export function permissionMap(session) {
  const actions = [
    ...Object.keys(AGENT_TIER_MIN),
    ...ADMIN_ONLY,
    ...OWNER_ONLY,
  ];
  const out = {};
  for (const action of actions) out[action] = can(session, action);
  return out;
}

// ---------------------------------------------------------------------------
// the guard every protected route calls first
// ---------------------------------------------------------------------------

/**
 * Verifies the cookie *and* re-reads the row behind it. The signature alone
 * would be enough to prove the cookie is ours, but not that the person still
 * works here: without this read, revoking someone would take up to twelve
 * hours to bite. One indexed lookup is a fair price for same-second removal.
 */
export async function requireStaff(request) {
  const payload = await unsign(parseCookies(request)[FULL_COOKIE]);
  if (!payload || payload.kind !== "full") return { error: 401, message: "Not signed in" };

  const staff = await selectOne(
    "staff",
    `select=id,email,display_name,avatar_url,role,tier,active,signature,prefs,last_login_at,totp_enrolled_at&id=eq.${q(payload.sid)}`
  );
  if (!staff || !staff.active) return { error: 403, message: "Account is not active" };

  // The row wins over the cookie: a demotion applies immediately.
  const session = { sid: staff.id, em: staff.email, rl: staff.role, tr: staff.tier };
  return { session, staff };
}

export async function recordLogin(staffId, googleSub, patch = {}) {
  return update(
    "staff",
    `id=eq.${q(staffId)}`,
    {
      last_login_at: new Date().toISOString(),
      failed_pin_attempts: 0,
      failed_totp_attempts: 0,
      locked_until: null,
      ...(googleSub ? { google_sub: googleSub } : {}),
      ...patch,
    },
    { returning: false }
  );
}

export async function logEvent(entry) {
  try {
    await insert("support_events", entry, { returning: false });
  } catch {
    // An audit write must never be the reason a reply fails to send.
  }
}
