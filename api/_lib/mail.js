// ============================================================================
// The e-mail channel: Resend in both directions.
//
// Outbound  POST https://api.resend.com/emails
// Inbound   Resend receives mail for the domain (its MX record), fires an
//           `email.received` webhook carrying *metadata only*, and we fetch
//           the body from GET /emails/receiving/{id}.
//
// Threading is done twice over, because mail clients are inconsistent about
// what they preserve: the RFC way (In-Reply-To / References pointing at the
// Message-ID we sent) and a visible "[SUP-1042]" in the subject, which
// survives forwarding, quoting and clients that rewrite headers.
// ============================================================================

import { timingSafeEqual } from "./auth.js";

const API = "https://api.resend.com";

function apiKey() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  return key;
}

export function isMailConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

/** "SUP-1042" — the reference customers see and reply to. */
export function ticketRef(number) {
  return `SUP-${number}`;
}

export function replySubject(subject, number) {
  const ref = ticketRef(number);
  const base = String(subject || "(no subject)").replace(/\[SUP-\d+\]/gi, "").trim();
  const withRe = /^re\s*:/i.test(base) ? base : `Re: ${base}`;
  return `${withRe} [${ref}]`;
}

/**
 * Sends one message and returns { id, messageId }.
 *
 * `messageId` matters: it is what an eventual reply will quote in its
 * In-Reply-To header, and support_ingest_email() matches on it. Resend does
 * not hand back the RFC Message-ID, so we mint our own and pass it as a
 * header — deterministic, and unique per send.
 *
 * `autoSubmitted` is the other half of the inbound loop guard, and the half
 * that protects the far side rather than us. RFC 3834: a message carrying
 * Auto-Submitted with anything but "no" must not itself provoke an automatic
 * response, which is how a vacation responder knows not to answer a robot.
 * handleInbound already honours it on the way in; without setting it on the
 * way out we were asking for a courtesy we did not extend.
 *
 *   "auto-generated"  something we sent on our own initiative — a
 *                     confirmation, a lifecycle notice
 *   "auto-replied"    an automatic answer to a message somebody sent us
 *
 * There is deliberately no default. A reply an agent typed is not automatic,
 * and labelling it so would tell the customer's mail client that the human
 * they are talking to is a machine.
 */
export async function sendMail({ to, subject, text, html, replyTo, inReplyTo, references, from, fromName, autoSubmitted }) {
  const domain = (process.env.SUPPORT_MAIL_DOMAIN || "plately.eu").trim();
  const address = (from || process.env.SUPPORT_FROM_EMAIL || `contact@${domain}`).trim();
  const name = (fromName || process.env.SUPPORT_FROM_NAME || "Plately Support").trim();
  const messageId = `<${crypto.randomUUID()}@${domain}>`;

  const headers = { "Message-ID": messageId };
  if (autoSubmitted) headers["Auto-Submitted"] = autoSubmitted;
  if (inReplyTo) {
    headers["In-Reply-To"] = inReplyTo;
    headers.References = [references, inReplyTo].filter(Boolean).join(" ").trim();
  }

  const res = await fetch(`${API}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${name} <${address}>`,
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
      ...(html ? { html } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
      headers,
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.message || payload?.error || `HTTP ${res.status}`;
    throw new Error(`Resend refused the message: ${detail}`);
  }
  return { id: payload.id || null, messageId };
}

/**
 * Pulls the full body of a received message.
 *
 * Two paths are tried because Resend's own docs have used both spellings for
 * this resource; the first that answers 200 wins, and a wrong guess costs one
 * cheap 404 rather than a lost e-mail.
 */
export async function fetchReceivedEmail(emailId) {
  const paths = [`/emails/receiving/${emailId}`, `/emails/received/${emailId}`];
  let lastError = "unknown";
  for (const path of paths) {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${apiKey()}` },
    });
    if (res.ok) return res.json();
    lastError = `${res.status} on ${path}`;
    if (res.status !== 404) break;
  }
  throw new Error(`Could not read the received e-mail (${lastError})`);
}

// ---------------------------------------------------------------------------
// webhook signatures (Svix, which is what Resend uses)
// ---------------------------------------------------------------------------

/**
 * Verifies svix-id / svix-timestamp / svix-signature against the raw body.
 *
 * The signed string is `${id}.${timestamp}.${body}` and the secret is
 * "whsec_" followed by base64 key material. The signature header may carry
 * several space-separated versions ("v1,<sig> v1,<sig>"); any match is a pass,
 * which is what makes secret rotation possible without downtime.
 */
export async function verifyWebhookSignature(request, rawBody) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  // Without a configured secret the endpoint would accept anything, so it
  // refuses instead. Fail closed: this route can create tickets and send mail.
  if (!secret) return { ok: false, reason: "RESEND_WEBHOOK_SECRET is not set" };

  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing svix headers" };

  // Five minutes either way, so a captured request cannot be replayed later.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return { ok: false, reason: "stale timestamp" };

  const keyMaterial = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = Uint8Array.from(atob(keyMaterial), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",");
    if (version === "v1" && value && timingSafeEqual(value, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}

// ---------------------------------------------------------------------------
// tidying inbound text
// ---------------------------------------------------------------------------

const QUOTE_MARKERS = [
  /^-{2,}\s*original message\s*-{2,}/i,
  /^-{2,}\s*wiadomo[śs][ćc] oryginalna\s*-{2,}/i,
  /^_{5,}$/,
  /^on .{5,80}\bwrote:\s*$/i,
  /^w dniu .{5,80}\bnapisa[łl].{0,3}:\s*$/i,
  /^from:\s.+@/i,
  /^od:\s.+@/i,
  /^>\s?/,
];

/**
 * Drops the quoted history a client appends to a reply.
 *
 * Conservative on purpose: it cuts at the first line that unmistakably starts
 * a quote, and if that would leave nothing it keeps the original. Losing a
 * customer's actual words is far worse than showing a few quoted ones.
 */
export function stripQuotedReply(text) {
  if (!text) return "";
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (QUOTE_MARKERS.some((re) => re.test(line))) {
      cut = i;
      break;
    }
  }
  const kept = (cut === -1 ? lines : lines.slice(0, cut)).join("\n").trim();
  return kept || String(text).trim();
}

/** Very small HTML → text fallback for senders that ship no text/plain part. */
export function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "Anna Kowalska <anna@x.io>" → { name, email } */
export function parseAddress(value) {
  const raw = String(value || "").trim();
  const angled = raw.match(/^(.*)<([^>]+)>\s*$/);
  if (angled) {
    return {
      name: angled[1].trim().replace(/^"(.*)"$/, "$1") || null,
      email: angled[2].trim().toLowerCase(),
    };
  }
  return { name: null, email: raw.toLowerCase() };
}

/** Signature block appended to every outbound reply. */
export function withSignature(body, signature) {
  const trimmed = String(body || "").trimEnd();
  if (!signature) return trimmed;
  if (trimmed.includes(signature.trim())) return trimmed;
  return `${trimmed}\n\n${signature.trim()}`;
}
