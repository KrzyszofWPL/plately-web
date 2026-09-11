// ---------------------------------------------------------------------------
// Plately Pro — the practice panel behind /staff, for dietitians
//
// A dietitian is a site-side identity: Google OAuth through api/staff, a row
// in `dietitians`, a `plately_practice` cookie. Never a Supabase Auth user,
// never an app account — so nothing here can lean on RLS or auth.uid(). The
// gate is this file: every route reads the cookie, every query goes through a
// `pro_*` function in the app's schema that takes the dietitian id first and
// filters on `program_memberships`. Those functions are granted to
// service_role only, which is the key this file holds and browsers never do.
//
// Same conventions as api/support: one catch-all (Vercel Hobby caps functions
// at twelve), routes flattened to `METHOD word`, `x-plately-panel: 1` as the
// CSRF second lock behind SameSite=Strict cookies.
// ---------------------------------------------------------------------------

export const config = { runtime: "edge" };

import { rpc, selectOne, q } from "../_lib/db.js";
import {
  COOKIES, clearCookie, clientIp, readPracticeSession, readPracticePending,
  issuePracticeSession, verifyTurnstile, publicDietitian,
} from "../_lib/staff-session.js";
import { explainSetupFailure } from "../_lib/setup-error.js";
import { hmacHex } from "../_lib/auth.js";
import { normaliseDomain } from "../_lib/domain-rules.js";
import { runChecks, summariseForTicket, MAX_RECHECKS_PER_HOUR } from "../_lib/practice-verify.js";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function fromPanel(request) {
  return request.headers.get("x-plately-panel") === "1";
}

/** Same hashing the help form uses for its own IP records — one pepper, one shape. */
async function ipHash(request) {
  const ip = clientIp(request) || "";
  if (!ip) return null;
  return (await hmacHex(process.env.PEPPER || "", "practice:" + ip)).slice(0, 32);
}

const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export default async function handler(request) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/practice\/?/, "").replace(/\/+$/, "").replace(/\//g, "-");

  if (request.method !== "GET" && !fromPanel(request)) return json({ error: "Missing panel header" }, 400);

  try {
    // Registration is the one route that runs on the pending cookie: the
    // person has a verified Google address and no practice row yet.
    if (route === "register" && request.method === "POST") return await register(request);

    const session = await readPracticeSession(request);
    if (!session) return json({ error: "Not signed in as a practice" }, 401);
    const dietitian = await selectOne("dietitians", `select=*&id=eq.${q(session.did)}`);
    if (!dietitian) return json({ error: "Practice not found" }, 401);

    switch (`${request.method} ${route}`) {
      case "POST recheck":       return await recheck(dietitian);
      case "POST manual":        return await requestManual(dietitian);
      case "GET overview":       return await overview(dietitian);
      case "GET patients":       return json({ patients: await rpc("pro_patients", { p_dietitian_id: dietitian.id, p_tz: tz(url) }) });
      case "GET invites":        return json({ invites: await rpc("pro_invites", { p_dietitian_id: dietitian.id }) });
      case "POST invite":        return await createInvite(request, dietitian);
      case "POST invite-revoke": return await revokeInvite(request, dietitian);
      case "POST seat":          return await setSeat(request, dietitian);
      case "POST coach":         return await setCoach(request, dietitian);
      case "POST goals":         return await setGoals(request, dietitian);
      case "POST end":           return await endMembership(request, dietitian);
      case "POST logout":
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: [
            ["Content-Type", "application/json"],
            ["Cache-Control", "no-store"],
            ["Set-Cookie", clearCookie(COOKIES.PRACTICE)],
            ["Set-Cookie", clearCookie(COOKIES.PRACTICE_PENDING)],
          ],
        });
      default:
        return json({ error: "Unknown route" }, 404);
    }
  } catch (err) {
    console.error("practice route failed", route, err);
    // Unverified practice hitting a panel route: pro_guard() raises 42501.
    if (err?.code === "42501") return json({ error: "Practice not verified" }, 403);
    return json({ error: explainSetupFailure(err) || "Something went wrong on our side" }, 500);
  }
}

function tz(url) {
  const value = url.searchParams.get("tz") || "UTC";
  return value.length < 64 ? value : "UTC";
}

// --- registration ------------------------------------------------------------

async function register(request) {
  const pending = await readPracticePending(request);
  if (!pending) return json({ error: "Sign in with Google first" }, 401);

  const body = await request.json().catch(() => ({}));
  const businessName = clean(body.businessName, 120);
  const website = normaliseDomain(clean(body.website, 200));
  const country = clean(body.country, 2).toUpperCase();
  const city = clean(body.city, 80);
  const vatNumber = clean(body.vatNumber, 32) || null;
  const dpaVersion = clean(body.dpaVersion, 20) || null;

  if (businessName.length < 2 || !website) return json({ error: "bad_request" }, 400);
  if (body.dpaAccepted !== true) return json({ error: "dpa_required" }, 400);

  // Turnstile, when configured: the form is reachable by any Google account,
  // and a practice row costs a ticket in the desk.
  const tv = await verifyTurnstile(body.turnstileToken, clientIp(request));
  if (!tv.ok) return json({ error: tv.reason || "captcha" }, 400);

  const rows = await rpc("register_dietitian", {
    p_email: pending.em,
    p_google_sub: pending.sub || null,
    p_display_name: pending.nm,
    p_avatar_url: pending.pic,
    p_business_name: businessName,
    p_website: website,
    p_country: country || null,
    p_city: city || null,
    p_vat_number: vatNumber,
    p_dpa_version: dpaVersion,
    p_ip_hash: await ipHash(request),
  });
  const reg = Array.isArray(rows) ? rows[0] : rows;
  if (!reg?.id) return json({ error: "register_failed" }, 500);

  const dietitian = await selectOne("dietitians", `select=*&id=eq.${q(reg.id)}`);
  if (!dietitian) return json({ error: "register_failed" }, 500);

  // Already registered and past the form: just hand over the session.
  if (reg.state === "verified" || reg.state === "pending") {
    return sessionResponse(dietitian);
  }

  const evidence = await runChecks(dietitian, null);
  const settled = await settle(dietitian, evidence);
  return sessionResponse(settled);
}

async function sessionResponse(dietitian) {
  const cookie = await issuePracticeSession(dietitian);
  return new Response(JSON.stringify({ ok: true, dietitian: publicDietitian(dietitian) }), {
    status: 200,
    headers: [
      ["Content-Type", "application/json"],
      ["Cache-Control", "no-store"],
      ["Set-Cookie", cookie],
      ["Set-Cookie", clearCookie(COOKIES.PRACTICE_PENDING)],
    ],
  });
}

/**
 * Applies a verification result. Three outcomes, in the order the steps run:
 *
 *   auto-pass          → verified. The same function the help desk calls on
 *                        Approve, so "what does verified grant" lives in one
 *                        place. An open ticket from an earlier attempt is
 *                        closed — the person no longer has anything to decide.
 *   domain unproven    → stays `unverified`, evidence saved, NO ticket. The
 *                        dietitian is on the TXT record; a queue entry for
 *                        that would be noise. `manual` overrides this: the
 *                        dietitian asked for a person because they cannot
 *                        touch DNS.
 *   anything else      → pending + a ticket carrying the per-step summary.
 *
 * The ticket is best-effort: the row is the truth, the ticket is its
 * notification.
 */
async function settle(dietitian, evidence, { manual = false } = {}) {
  const ev = manual ? { ...evidence, manualRequested: true } : evidence;

  if (ev.autopass) {
    await rpc("admin_set_dietitian_verification", {
      p_dietitian_id: dietitian.id,
      p_state: "verified",
      p_method: ev.ownership === "email_domain" ? "email_domain" : "domain_txt",
      p_note: null,
      p_evidence: ev,
    });
    try {
      await rpc("support_resolve_verification_ticket", {
        p_email: dietitian.email,
        p_body: "Zweryfikowano automatycznie: domena, VIES i Google Maps przeszły przy ponownym sprawdzeniu.",
      });
    } catch (err) {
      console.error("practice: ticket not resolved", err?.message || err);
    }
  } else if (ev.steps?.domain !== "passed" && !manual) {
    await rpc("admin_set_dietitian_verification", {
      p_dietitian_id: dietitian.id,
      p_state: "unverified",
      p_method: null,
      p_note: null,
      p_evidence: ev,
    });
  } else {
    await rpc("admin_set_dietitian_verification", {
      p_dietitian_id: dietitian.id,
      p_state: "pending",
      p_method: ev.ownership,
      p_note: null,
      p_evidence: ev,
    });
    try {
      await rpc("support_file_verification_ticket", {
        p_email: dietitian.email,
        p_name: dietitian.display_name,
        p_summary: {
          businessName: dietitian.business_name,
          website: dietitian.website,
          city: dietitian.city,
          country: dietitian.country,
          vatNumber: dietitian.vat_number,
          ownership: ev.ownership,
          steps: ev.steps,
          reasons: ev.reasons,
          manualRequested: manual,
          body: summariseForTicket(dietitian, ev),
        },
      });
    } catch (err) {
      console.error("practice: ticket not filed", err?.message || err);
    }
  }
  return await selectOne("dietitians", `select=*&id=eq.${q(dietitian.id)}`);
}

async function recheck(dietitian) {
  if (dietitian.verification_state === "verified") return json({ ok: true, dietitian: publicDietitian(dietitian) });
  if (dietitian.verification_state === "rejected") return json({ error: "rejected" }, 409);

  const previous = dietitian.verification_evidence || null;
  const lastAt = previous?.checkedAt ? Date.parse(previous.checkedAt) : 0;
  const withinHour = Date.now() - lastAt < 3_600_000;
  if (withinHour && (previous?.rechecks ?? 0) >= MAX_RECHECKS_PER_HOUR) return json({ error: "rate_limited" }, 429);

  const evidence = await runChecks(dietitian, withinHour ? previous : { ...(previous || {}), rechecks: 0 });
  // A practice already in the queue stays in it (and the ticket gets the
  // fresh summary) even if the domain step somehow regressed — a person is
  // already looking, and flipping them back out would lose that.
  const manual = dietitian.verification_state === "pending";
  const settled = await settle(dietitian, evidence, { manual });
  return json({ ok: true, dietitian: publicDietitian(settled), evidence });
}

/**
 * "I cannot add a TXT record — let a person verify me." Only meaningful while
 * the domain step is what blocks: the practice goes to `pending` with a
 * ticket that says the dietitian asked, so the reviewer knows to look at the
 * company and the listing themselves.
 */
async function requestManual(dietitian) {
  if (dietitian.verification_state === "verified") return json({ ok: true, dietitian: publicDietitian(dietitian) });
  if (dietitian.verification_state === "rejected") return json({ error: "rejected" }, 409);
  if (dietitian.verification_state === "pending") return json({ ok: true, dietitian: publicDietitian(dietitian) });

  const previous = dietitian.verification_evidence || null;
  const evidence = previous && previous.version === 2 ? previous : await runChecks(dietitian, null);
  const settled = await settle(dietitian, evidence, { manual: true });
  return json({ ok: true, dietitian: publicDietitian(settled), evidence });
}

// --- panel -------------------------------------------------------------------

async function overview(dietitian) {
  // Deferred Care→Track downgrades settle on entry, not on a cron: the free
  // Supabase plan has no scheduled functions, and the same rule governs how
  // entitlements expire across the app's schema.
  await rpc("pro_settle_seat_changes", { p_dietitian_id: dietitian.id });
  const data = await rpc("pro_overview", { p_dietitian_id: dietitian.id, p_tz: "UTC" });
  return json({ overview: data, dietitian: publicDietitian(dietitian) });
}

async function createInvite(request, dietitian) {
  const { seatType, label } = await request.json().catch(() => ({}));
  if (seatType !== "track" && seatType !== "care") return json({ error: "Invalid seat type" }, 400);
  try {
    const rows = await rpc("create_program_invite", {
      p_dietitian_id: dietitian.id,
      p_seat_type: seatType,
      p_label: clean(label, 80) || null,
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    // The plain code comes back exactly once. After this response the database
    // holds only a hash.
    return json({ ok: true, code: row.code, prefix: row.code_prefix, expiresAt: row.expires_at });
  } catch (err) {
    if (String(err?.message || "").includes("seat limit")) return json({ error: "seat_limit" }, 409);
    throw err;
  }
}

async function revokeInvite(request, dietitian) {
  const { prefix } = await request.json().catch(() => ({}));
  const ok = await rpc("revoke_program_invite", { p_dietitian_id: dietitian.id, p_code_prefix: clean(prefix, 8) });
  return json({ ok: Boolean(ok) });
}

async function setSeat(request, dietitian) {
  const { membershipId, seatType } = await request.json().catch(() => ({}));
  if (seatType !== "track" && seatType !== "care") return json({ error: "Invalid seat type" }, 400);
  const ok = await rpc("set_membership_seat", { p_dietitian_id: dietitian.id, p_membership_id: membershipId, p_seat_type: seatType });
  return json({ ok: Boolean(ok) });
}

async function setCoach(request, dietitian) {
  const { membershipId, enabled } = await request.json().catch(() => ({}));
  const ok = await rpc("set_membership_coach", { p_dietitian_id: dietitian.id, p_membership_id: membershipId, p_enabled: enabled === true });
  return json({ ok: Boolean(ok) });
}

async function setGoals(request, dietitian) {
  const { patientId, calorie, protein, carb, fat } = await request.json().catch(() => ({}));
  const num = (v) => (v === null || v === undefined || v === "" ? null : Math.max(0, Math.min(20000, Math.round(Number(v)) || 0)));
  const ok = await rpc("set_patient_goals", {
    p_dietitian_id: dietitian.id,
    p_patient_user_id: patientId,
    p_calorie: num(calorie),
    p_protein: num(protein),
    p_carb: num(carb),
    p_fat: num(fat),
  });
  return json({ ok: Boolean(ok) });
}

async function endMembership(request, dietitian) {
  const { membershipId } = await request.json().catch(() => ({}));
  const ok = await rpc("pro_end_membership", { p_dietitian_id: dietitian.id, p_membership_id: membershipId });
  return json({ ok: Boolean(ok) });
}
