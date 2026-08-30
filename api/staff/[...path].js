// ============================================================================
// /api/staff/* — sign-in, the PIN, and who may be an agent at all.
//
// One catch-all function rather than a file per route on purpose: Vercel's
// Hobby plan caps a deployment at twelve Serverless/Edge Functions, and this
// desk needs far more than twelve endpoints. Routing inside one function costs
// nothing and leaves room in the budget for the rest of the site.
//
// The sign-in dance, end to end:
//
//   POST /api/staff/start      Turnstile token in, Google URL out (+ state cookie)
//   GET  /api/staff/callback   Google comes back with a code; we swap it for an
//                              id_token, match the address against `staff`, and
//                              issue a *pre-session* — proof of Google, nothing more
//   POST /api/staff/pin        PIN + Turnstile; on success the real session cookie
//   GET  /api/staff/session    what the panel calls on load to decide what to draw
//
// Nothing below trusts the browser for permissions: every privileged route
// re-reads the staff row and re-checks the role there.
// ============================================================================

import {
  COOKIES,
  clearCookie,
  issuePreSession,
  issueSession,
  readPreSession,
  requireStaff,
  can,
  permissionMap,
  verifyTurnstile,
  clientIp,
  isValidPinFormat,
  isWeakPin,
  hashPin,
  verifyPin,
  randomHex,
  recordLogin,
  logEvent,
  parseCookies,
  MAX_PIN_ATTEMPTS,
  PIN_LOCK_MINUTES,
} from "../_lib/staff-session.js";
import { hmacHex, timingSafeEqual } from "../_lib/auth.js";
import { selectOne, select, insert, update, q } from "../_lib/db.js";

export const config = { runtime: "edge" };

const OAUTH_COOKIE = "plately_oauth";
const OAUTH_TTL_MS = 10 * 60 * 1000;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store", ...headers } });
}

/**
 * A response carrying more than one Set-Cookie.
 *
 * Built with Headers.append rather than an object or an array of pairs: those
 * two collapse repeated names into one comma-joined value, which is fine for
 * every header except this one — a browser reading "a=1; Path=/, b=2; Path=/"
 * keeps the first cookie and throws the second away.
 */
function withCookies(body, cookies, status = 200, extra = {}) {
  const headers = new Headers({ "Cache-Control": "no-store", ...extra });
  if (body !== null) headers.set("Content-Type", "application/json");
  for (const cookie of cookies.filter(Boolean)) headers.append("Set-Cookie", cookie);
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

// ---------------------------------------------------------------------------
// OAuth state, carried in a signed cookie rather than server memory
// ---------------------------------------------------------------------------

async function packState(payload) {
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${body}.${await hmacHex(process.env.SESSION_SECRET || "", body)}`;
}

async function unpackState(token) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  if (!timingSafeEqual(mac, await hmacHex(process.env.SESSION_SECRET || "", body))) return null;
  try {
    const padded = body.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(body.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded));
    return Date.now() > payload.exp ? null : payload;
  } catch {
    return null;
  }
}

function redirectUri(request) {
  return `${new URL(request.url).origin}/api/staff/callback`;
}

/** Decodes a JWT payload. Safe here: see the note in the callback handler. */
function decodeJwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const binary = atob(padded);
    // Names come back UTF-8 encoded; atob gives one byte per character, so the
    // bytes have to go back through a decoder or "Łukasz" arrives mangled.
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Turnstile, with the reason attached.
 *
 * The reason is safe to show: it names *our* misconfiguration, never anything
 * about the visitor. Hiding it turned a five-second fix ("the secret key is
 * the site key pasted twice") into an unsolvable sign-in button.
 */
async function turnstileGuard(request, token) {
  const check = await verifyTurnstile(token, clientIp(request));
  if (check.ok) return null;
  return json({ error: `Verification failed: ${check.reason}. Reload the page and try again.` }, 400);
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export default async function handler(request) {
  const url = new URL(request.url);
  // Slashes are folded into hyphens because a [...path] catch-all in a project
  // with no framework preset only ever matches ONE segment on Vercel:
  // /api/staff/pin answers, /api/staff/pin/setup is a platform 404 that never
  // reaches this file. The routes are named with hyphens for that reason, and
  // the fold means a nested spelling keeps working if that ever changes.
  const route = url.pathname
    .replace(/^\/api\/staff\/?/, "")
    .replace(/\/+$/, "")
    .replace(/\//g, "-");

  try {
    switch (`${request.method} ${route}`) {
      case "POST start":
        return await startSignIn(request);
      case "GET callback":
        return await handleCallback(request);
      case "GET session":
        return await readSession(request);
      case "POST pin":
        return await submitPin(request);
      case "POST pin-setup":
        return await setupPin(request);
      case "POST pin-change":
        return await changePin(request);
      case "POST logout":
        return await logout(request);
      case "GET list":
        return await listStaff(request);
      case "POST invite":
        return await inviteStaff(request);
      case "POST update":
        return await updateStaff(request);
      case "POST reset-pin":
        return await resetPin(request);
      default:
        return json({ error: "Unknown route" }, 404);
    }
  } catch (err) {
    // Never leak a stack or a Postgres message to the browser; the panel shows
    // `error`, the deployment log keeps the rest.
    console.error("staff route failed", route, err);
    return json({ error: "Something went wrong on our side" }, 500);
  }
}

// --- 1. start ---------------------------------------------------------------

async function startSignIn(request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return json({ error: "Google sign-in is not configured" }, 500);

  const { turnstileToken } = await request.json().catch(() => ({}));
  const blocked = await turnstileGuard(request, turnstileToken);
  if (blocked) return blocked;

  const state = randomHex(16);
  const nonce = randomHex(16);
  const cookie = await packState({ state, nonce, exp: Date.now() + OAUTH_TTL_MS });

  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri(request));
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  // Always ask which account: agents routinely have a personal Google session
  // in the same browser, and silently reusing it is how the wrong person ends
  // up looking at customer mail.
  authorize.searchParams.set("prompt", "select_account");

  return json(
    { url: authorize.toString() },
    200,
    { "Set-Cookie": `${OAUTH_COOKIE}=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` }
  );
}

// --- 2. callback ------------------------------------------------------------

async function handleCallback(request) {
  const url = new URL(request.url);
  const drop = clearCookie(OAUTH_COOKIE);
  const fail = (reason) => redirect(`/admin?error=${reason}`, { "Set-Cookie": drop });

  if (url.searchParams.get("error")) return fail("google_denied");

  const stored = await unpackState(parseCookies(request)[OAUTH_COOKIE]);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  // SameSite=Lax lets the cookie ride along on Google's top-level redirect back
  // here; a missing or mismatched state means this callback was not started by
  // the person holding the browser.
  if (!stored || !state || !code || !timingSafeEqual(state, stored.state)) return fail("bad_state");

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail("not_configured");

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
  if (!tokenRes.ok) return fail("google_exchange");

  const tokens = await tokenRes.json().catch(() => ({}));
  // The id_token arrived over TLS straight from Google's token endpoint, in
  // exchange for our client secret — so its signature adds nothing here and we
  // read the claims directly. (Verifying the JWKS signature would matter for a
  // token handed to us by the *browser*, which is not this flow.) The claims
  // themselves are still checked, because they are what we act on.
  const claims = decodeJwtPayload(tokens.id_token);
  if (!claims) return fail("google_token");
  if (claims.aud !== clientId) return fail("google_audience");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) return fail("google_issuer");
  if (typeof claims.exp === "number" && Date.now() / 1000 > claims.exp) return fail("google_expired");
  if (stored.nonce && claims.nonce && !timingSafeEqual(claims.nonce, stored.nonce)) return fail("bad_nonce");
  if (claims.email_verified === false) return fail("email_unverified");

  const email = String(claims.email || "").toLowerCase();
  if (!email) return fail("no_email");

  const staff = await selectOne("staff", `select=*&email=eq.${q(email)}`);
  if (!staff) {
    await logEvent({ actor: email, action: "signin.rejected", detail: { reason: "not_staff" } });
    return fail("not_staff");
  }
  if (!staff.active) return fail("inactive");
  // The address is the login, but the Google account behind it is pinned on
  // first use: an address that changes hands (or a Workspace account recreated
  // under the same name) is a different person and must be re-approved.
  if (staff.google_sub && !timingSafeEqual(staff.google_sub, String(claims.sub))) return fail("account_mismatch");

  await update(
    "staff",
    `id=eq.${q(staff.id)}`,
    {
      google_sub: staff.google_sub || String(claims.sub),
      display_name: staff.display_name || claims.name || null,
      avatar_url: claims.picture || staff.avatar_url || null,
    },
    { returning: false }
  );

  const preCookie = await issuePreSession(staff);
  await logEvent({ staff_id: staff.id, actor: email, action: "signin.google" });

  return withCookies(null, [drop, preCookie], 302, { Location: "/admin" });
}

// --- 3. session -------------------------------------------------------------

async function readSession(request) {
  const full = await requireStaff(request);
  if (full.session) {
    return json({
      state: "signed_in",
      staff: publicStaff(full.staff),
      permissions: permissionMap(full.session),
      turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
      mailConfigured: Boolean(process.env.RESEND_API_KEY),
    });
  }

  const pre = await readPreSession(request);
  if (pre) {
    const staff = await selectOne("staff", `select=id,email,display_name,avatar_url,pin_hash,locked_until,active&id=eq.${q(pre.sid)}`);
    if (staff && staff.active) {
      const locked = staff.locked_until && new Date(staff.locked_until) > new Date();
      return json({
        state: staff.pin_hash ? "pin_required" : "pin_setup",
        email: staff.email,
        displayName: staff.display_name,
        avatarUrl: staff.avatar_url,
        lockedUntil: locked ? staff.locked_until : null,
        turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
      });
    }
  }

  return json({
    state: "signed_out",
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
    googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID),
  });
}

function publicStaff(staff) {
  return {
    id: staff.id,
    email: staff.email,
    displayName: staff.display_name || staff.email,
    avatarUrl: staff.avatar_url || null,
    role: staff.role,
    tier: staff.tier,
    signature: staff.signature || null,
    prefs: staff.prefs || {},
    lastLoginAt: staff.last_login_at || null,
  };
}

// --- 4. the PIN -------------------------------------------------------------

async function submitPin(request) {
  const pre = await readPreSession(request);
  if (!pre) return json({ error: "Sign in with Google first" }, 401);

  const { pin, turnstileToken } = await request.json().catch(() => ({}));
  const blocked = await turnstileGuard(request, turnstileToken);
  if (blocked) return blocked;

  const staff = await selectOne("staff", `select=*&id=eq.${q(pre.sid)}`);
  if (!staff || !staff.active) return json({ error: "Account is not active" }, 403);
  if (!staff.pin_hash) return json({ error: "No PIN set yet", state: "pin_setup" }, 409);

  if (staff.locked_until && new Date(staff.locked_until) > new Date()) {
    return json({ error: "Too many attempts. Try again later.", lockedUntil: staff.locked_until }, 429);
  }

  if (!isValidPinFormat(pin) || !(await verifyPin(pin, staff))) {
    const attempts = (staff.failed_pin_attempts || 0) + 1;
    const lock = attempts >= MAX_PIN_ATTEMPTS;
    await update(
      "staff",
      `id=eq.${q(staff.id)}`,
      {
        failed_pin_attempts: lock ? 0 : attempts,
        locked_until: lock ? new Date(Date.now() + PIN_LOCK_MINUTES * 60 * 1000).toISOString() : staff.locked_until,
      },
      { returning: false }
    );
    await logEvent({
      staff_id: staff.id,
      actor: staff.email,
      action: "signin.pin_failed",
      detail: { attempts, locked: lock },
    });
    return json(
      {
        error: lock
          ? `Too many attempts. Locked for ${PIN_LOCK_MINUTES} minutes.`
          : `Wrong PIN. ${MAX_PIN_ATTEMPTS - attempts} attempt(s) left.`,
      },
      lock ? 429 : 401
    );
  }

  await recordLogin(staff.id, null);
  await logEvent({ staff_id: staff.id, actor: staff.email, action: "signin.complete" });

  return withCookies(
    { ok: true, staff: publicStaff(staff), permissions: permissionMap({ rl: staff.role, tr: staff.tier }) },
    [clearCookie(COOKIES.PRE), await issueSession(staff)]
  );
}

async function setupPin(request) {
  const pre = await readPreSession(request);
  if (!pre) return json({ error: "Sign in with Google first" }, 401);

  const { pin, confirm, turnstileToken } = await request.json().catch(() => ({}));
  const blocked = await turnstileGuard(request, turnstileToken);
  if (blocked) return blocked;
  if (!isValidPinFormat(pin)) return json({ error: "The PIN must be exactly four digits" }, 400);
  if (pin !== confirm) return json({ error: "The two PINs do not match" }, 400);
  if (isWeakPin(pin)) return json({ error: "That PIN is too easy to guess. Pick another." }, 400);

  const staff = await selectOne("staff", `select=*&id=eq.${q(pre.sid)}`);
  if (!staff || !staff.active) return json({ error: "Account is not active" }, 403);
  // Enrolment is first-run only. Changing an existing PIN needs the old one,
  // which is pin/change below — otherwise a stolen Google session would be
  // enough to lock the real owner out.
  if (staff.pin_hash) return json({ error: "A PIN is already set" }, 409);

  const salt = randomHex(16);
  await update(
    "staff",
    `id=eq.${q(staff.id)}`,
    { pin_salt: salt, pin_hash: await hashPin(pin, salt), pin_set_at: new Date().toISOString(), failed_pin_attempts: 0, locked_until: null },
    { returning: false }
  );
  await recordLogin(staff.id, null);
  await logEvent({ staff_id: staff.id, actor: staff.email, action: "pin.enrolled" });

  return withCookies(
    { ok: true, staff: publicStaff(staff), permissions: permissionMap({ rl: staff.role, tr: staff.tier }) },
    [clearCookie(COOKIES.PRE), await issueSession(staff)]
  );
}

async function changePin(request) {
  const auth = await requireStaff(request);
  if (auth.error) return json({ error: auth.message }, auth.error);

  const { currentPin, pin, confirm } = await request.json().catch(() => ({}));
  if (!isValidPinFormat(pin)) return json({ error: "The PIN must be exactly four digits" }, 400);
  if (pin !== confirm) return json({ error: "The two PINs do not match" }, 400);
  if (isWeakPin(pin)) return json({ error: "That PIN is too easy to guess. Pick another." }, 400);

  const staff = await selectOne("staff", `select=*&id=eq.${q(auth.staff.id)}`);
  if (staff.pin_hash && !(await verifyPin(String(currentPin || ""), staff))) {
    return json({ error: "The current PIN is wrong" }, 401);
  }

  const salt = randomHex(16);
  await update(
    "staff",
    `id=eq.${q(staff.id)}`,
    { pin_salt: salt, pin_hash: await hashPin(pin, salt), pin_set_at: new Date().toISOString() },
    { returning: false }
  );
  await logEvent({ staff_id: staff.id, actor: staff.email, action: "pin.changed" });
  return json({ ok: true });
}

async function logout(request) {
  const auth = await requireStaff(request);
  if (auth.staff) await logEvent({ staff_id: auth.staff.id, actor: auth.staff.email, action: "signout" });
  return withCookies({ ok: true }, [clearCookie(COOKIES.FULL), clearCookie(COOKIES.PRE)]);
}

// --- 5. managing the team (owner only) --------------------------------------

async function listStaff(request) {
  const auth = await requireStaff(request);
  if (auth.error) return json({ error: auth.message }, auth.error);
  // Everyone may see who is on the team — the sidebar and the assignee picker
  // need it. Only an owner may change any of it.
  const rows = await select(
    "staff",
    "select=id,email,display_name,avatar_url,role,tier,active,last_login_at,pin_set_at,created_at&order=role.asc,created_at.asc"
  );
  return json({
    staff: rows.map((row) => ({
      ...row,
      hasPin: Boolean(row.pin_set_at),
      pin_set_at: undefined,
    })),
    canManage: can(auth.session, "staff_write"),
  });
}

async function inviteStaff(request) {
  const auth = await requireStaff(request);
  if (auth.error) return json({ error: auth.message }, auth.error);
  if (!can(auth.session, "staff_write")) return json({ error: "Only an owner can add agents" }, 403);

  const { email, displayName, role = "agent", tier = 1 } = await request.json().catch(() => ({}));
  const address = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return json({ error: "That is not a valid e-mail address" }, 400);
  if (!["owner", "admin", "agent", "viewer"].includes(role)) return json({ error: "Unknown role" }, 400);

  const existing = await selectOne("staff", `select=id&email=eq.${q(address)}`);
  if (existing) return json({ error: "That address is already on the team" }, 409);

  const created = await insert("staff", {
    email: address,
    display_name: displayName || null,
    role,
    tier: Math.min(3, Math.max(1, Number(tier) || 1)),
  });
  await logEvent({ staff_id: auth.staff.id, actor: auth.staff.email, action: "staff.invited", detail: { email: address, role } });
  // Nothing is e-mailed: the person simply signs in with that Google account
  // and sets their own PIN on first run. Only the fields the panel draws go
  // back — the row itself carries PIN columns that have no business leaving.
  return json({
    ok: true,
    staff: { id: created.id, email: created.email, display_name: created.display_name, role: created.role, tier: created.tier, active: created.active },
  });
}

async function updateStaff(request) {
  const auth = await requireStaff(request);
  if (auth.error) return json({ error: auth.message }, auth.error);
  if (!can(auth.session, "staff_write")) return json({ error: "Only an owner can change roles" }, 403);

  const { id, role, tier, active, displayName } = await request.json().catch(() => ({}));
  if (!id) return json({ error: "Missing id" }, 400);

  const target = await selectOne("staff", `select=*&id=eq.${q(id)}`);
  if (!target) return json({ error: "No such agent" }, 404);

  // Guard against the one mistake that cannot be undone from inside the panel:
  // removing the last way in. Only an actual demotion or deactivation counts —
  // renaming the sole owner is not a threat to anything.
  const demoting = role !== undefined && role !== "owner";
  const deactivating = active === false;
  if (target.role === "owner" && (demoting || deactivating)) {
    const owners = await select("staff", "select=id&role=eq.owner&active=is.true");
    if (owners.length <= 1) return json({ error: "This is the last owner — promote someone else first" }, 400);
  }

  const patch = {};
  if (role !== undefined) {
    if (!["owner", "admin", "agent", "viewer"].includes(role)) return json({ error: "Unknown role" }, 400);
    patch.role = role;
  }
  if (tier !== undefined) patch.tier = Math.min(3, Math.max(1, Number(tier) || 1));
  if (active !== undefined) patch.active = Boolean(active);
  if (displayName !== undefined) patch.display_name = displayName || null;
  if (!Object.keys(patch).length) return json({ error: "Nothing to change" }, 400);

  const saved = await update("staff", `id=eq.${q(id)}`, patch);
  await logEvent({ staff_id: auth.staff.id, actor: auth.staff.email, action: "staff.updated", detail: { target: target.email, patch } });
  return json({ ok: true, staff: saved });
}

async function resetPin(request) {
  const auth = await requireStaff(request);
  if (auth.error) return json({ error: auth.message }, auth.error);
  if (!can(auth.session, "staff_write")) return json({ error: "Only an owner can reset a PIN" }, 403);

  const { id } = await request.json().catch(() => ({}));
  if (!id) return json({ error: "Missing id" }, 400);

  await update(
    "staff",
    `id=eq.${q(id)}`,
    { pin_hash: null, pin_salt: null, pin_set_at: null, failed_pin_attempts: 0, locked_until: null },
    { returning: false }
  );
  await logEvent({ staff_id: auth.staff.id, actor: auth.staff.email, action: "staff.pin_reset", detail: { target: id } });
  return json({ ok: true });
}
