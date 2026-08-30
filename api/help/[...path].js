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
//                            site key, the categories, and whether mail is
//                            configured at all
//   POST /api/help/submit    the form. Parks the request and mails a confirm
//                            link — no ticket exists yet
//   GET  /api/help/confirm   the link. Turns the parked request into a real
//                            ticket the desk can see
//
// There is no sign-in. Anybody can type any address into this form, which is
// precisely why nothing reaches support_tickets until somebody clicks the link
// mailed to that address: the click is the proof, and it costs the visitor one
// tap rather than an account.
//
// A form that mails whatever address is typed into it, with no such step, is a
// machine for mailing strangers — and the reputation damage lands on us rather
// than on whoever typed it.
// ============================================================================

import { hmacHex } from "../_lib/auth.js";
import { explainSetupFailure } from "../_lib/setup-error.js";
import { rpc } from "../_lib/db.js";
import { sendMail, isMailConfigured, ticketRef } from "../_lib/mail.js";
import { confirmRequestEmail, identities } from "../_lib/email-templates.js";
import { verifyTurnstile, clientIp } from "../_lib/staff-session.js";

export const config = { runtime: "edge" };

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
      case "POST submit":
        return await submit(request);
      case "GET confirm":
        return await confirmRequest(request);
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

async function readSession(request) {
  return json({
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
    // The page says so plainly rather than accepting a message it cannot
    // deliver and leaving the person waiting for a reply that never comes.
    mailConfigured: isMailConfigured(),
    categories: CATEGORIES,
  });
}

// --- the form ----------------------------------------------------------------

async function submit(request) {
  const payload = await request.json().catch(() => ({}));
  const { category, subject, body, name, turnstileToken } = payload;

  const check = await verifyTurnstile(turnstileToken, clientIp(request));
  if (!check.ok) {
    return json({ error: `Verification failed: ${check.reason}. Reload the page and try again.` }, 400);
  }

  const email = String(payload.email || "").trim().toLowerCase();

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

  const locale = String(payload.locale || "").slice(0, 8) || null;
  const senderName = String(name || "").trim().slice(0, MAX_NAME) || null;
  const from = identities().supportNoreply;

  // The token goes out in the link; only its HMAC is stored. This table is the
  // one place somebody could read a pending confirmation out of, and a hash is
  // not a link.
  const token = randomToken();
  const staged = await rpc("support_stage_form", {
    p_payload: {
      token_hash: await tokenHash(token),
      email,
      name: senderName,
      subject: cleanSubject,
      text: cleanBody,
      tag: category,
      locale,
      ip_hash: await ipHash(request),
      // Nothing here has proved the address yet — the click will. Recorded so
      // an agent can tell a form ticket apart from one that arrived by e-mail,
      // which carries its own proof of the sender's mailbox.
      email_verified: false,
    },
    p_max_per_hour: MAX_PER_HOUR,
  });

  if (!staged?.ok) {
    if (staged?.error === "rate_limited") {
      return json(
        { error: "That is several messages in a short time. Check your inbox for the confirmation we already sent, or try again in an hour." },
        429
      );
    }
    return json({ error: "We could not file that message. Please try again." }, 500);
  }

  const origin = new URL(request.url).origin;
  const mail = confirmRequestEmail({
    reference: `REQ-${String(staged.request_id).slice(0, 8).toUpperCase()}`,
    subject: cleanSubject,
    category,
    body: cleanBody,
    confirmUrl: `${origin}/api/help/confirm?t=${token}`,
    locale,
  });

  // Sent from the no-reply address, not the desk's: nobody should answer a
  // confirmation, and a reply to it would arrive at an address with no ticket
  // behind it yet.
  try {
    await sendMail({
      to: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      from: from.email,
      fromName: from.name,
    });
  } catch (err) {
    console.error("help confirmation failed", err);
    // Here the failure DOES matter: without the mail there is no way to
    // confirm, so the pending row is dead weight and the person needs to know
    // rather than sit waiting for a link that was never sent.
    return json({ error: "We could not send the confirmation e-mail. Please check the address and try again." }, 502);
  }

  return json({ ok: true, pending: true, email });
}

/**
 * The click that turns a pending request into a ticket.
 *
 * A GET, because it is a link in an e-mail and that is the only verb a link
 * has. That normally makes a state change uncomfortable — but the token is
 * single-use and unguessable, the "state change" is one the recipient is being
 * asked for, and support_confirm_request is idempotent, so the mail scanners
 * and prefetchers that will inevitably hit this URL first cost nothing.
 */
async function confirmRequest(request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("t") || "";
  const done = (state, ref) =>
    redirect(`/help?confirm=${state}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`);

  if (!/^[a-f0-9]{48,80}$/.test(token)) return done("invalid");

  const result = await rpc("support_confirm_request", { p_token_hash: await tokenHash(token) });
  if (!result?.ok) return done(result?.error === "not_pending" ? "expired" : "failed");

  const reference = ticketRef(result.number);
  await logConfirmation(result, reference);
  return done("ok", reference);
}

/**
 * Tells the desk the ticket exists. Deliberately after the redirect decision
 * and wrapped: the person has confirmed either way, and a failure to write an
 * extra note must not turn a successful confirmation into an error page.
 */
async function logConfirmation(result, reference) {
  try {
    await rpc("support_recount", { p_ticket_id: result.ticket_id });
  } catch (err) {
    console.error("recount after confirmation failed", err);
  }
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** HMAC rather than a bare hash, so a stolen table cannot be rainbow-tabled. */
function tokenHash(token) {
  return hmacHex(process.env.PEPPER || process.env.SESSION_SECRET || "", `help-confirm:${token}`);
}
