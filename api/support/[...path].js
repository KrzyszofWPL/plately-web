// ============================================================================
// /api/support/* — the desk itself.
//
// Same one-function-many-routes shape as /api/staff, and for the same reason:
// the Hobby plan's twelve-function budget. Everything except the inbound
// webhook requires a full staff session; the webhook instead proves itself
// with Resend's signature.
//
// The heavy reads (inbox list, ticket detail, reports, customer context) are
// Postgres functions, called by name. That keeps the definition of "urgent" or
// "waiting on us" in one place, and keeps this file about *permissions and
// side effects* — who may do a thing, and what e-mail leaves the building when
// they do.
// ============================================================================

import { requireStaff, can, logEvent } from "../_lib/staff-session.js";
import { select, selectOne, insert, update, remove, rpc, q } from "../_lib/db.js";
import { getSiteMode, setSiteMode } from "../../lib/site-mode.js";
import {
  sendMail,
  fetchReceivedEmail,
  verifyWebhookSignature,
  stripQuotedReply,
  htmlToText,
  parseAddress,
  replySubject,
  ticketRef,
  withSignature,
  isMailConfigured,
} from "../_lib/mail.js";

export const config = { runtime: "edge" };

const TAGS = ["Billing", "Bug", "Feature request", "How-to", "Account", "Other"];
const STATUSES = ["open", "pending", "solved", "closed", "spam"];
const PRIORITIES = ["urgent", "high", "normal", "low"];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Cookies are SameSite=Strict, so a cross-site form post never carries one.
 * This header is the second lock: a browser will not add a custom header to a
 * cross-origin request without a successful preflight, and this API answers
 * none — so a forged POST cannot reach a handler even if a cookie somehow did.
 */
function fromPanel(request) {
  return request.headers.get("x-plately-panel") === "1";
}

export default async function handler(request) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/support\/?/, "").replace(/\/+$/, "");

  try {
    // The webhook is the one route with no session: Resend is not a browser.
    if (route === "inbound") return await handleInbound(request);

    const auth = await requireStaff(request);
    if (auth.error) return json({ error: auth.message }, auth.error);
    const { session, staff } = auth;

    if (request.method !== "GET" && !fromPanel(request)) {
      return json({ error: "Bad request" }, 400);
    }

    switch (`${request.method} ${route}`) {
      case "GET bootstrap":
        return await bootstrap(session, staff);
      case "GET tickets":
        return await listTickets(url, session);
      case "GET ticket":
        return await ticketDetail(url);
      case "GET customers":
        return await listCustomers(url);
      case "GET reports":
        return await reports(url);
      case "GET kb":
        return await listArticles();
      case "GET events":
        return await listEvents(url, session);
      case "GET maintenance":
        return await readMaintenance(session);

      case "POST message":
        return await postMessage(request, session, staff);
      case "POST ticket":
        return await createTicket(request, session, staff);
      case "POST ticket/update":
        return await updateTicket(request, session, staff);
      case "POST ticket/delete":
        return await deleteTicket(request, session, staff);
      case "POST customer/notes":
        return await saveCustomerNotes(request, session);
      case "POST kb/save":
        return await saveArticle(request, session, staff);
      case "POST kb/delete":
        return await deleteArticle(request, session, staff);
      case "POST settings":
        return await saveSettings(request, session, staff);
      case "POST profile":
        return await saveProfile(request, staff);
      case "POST maintenance":
        return await writeMaintenance(request, session, staff);

      default:
        return json({ error: "Unknown route" }, 404);
    }
  } catch (err) {
    console.error("support route failed", route, err);
    return json({ error: "Something went wrong on our side" }, 500);
  }
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

async function bootstrap(session, staff) {
  const [counts, macros, settings, team] = await Promise.all([
    rpc("support_view_counts", { p_staff_id: staff.id }),
    select("support_macros", "select=id,label,body&order=sort_order.asc"),
    selectOne("support_settings", "select=*&id=is.true"),
    select("staff", "select=id,email,display_name,avatar_url,role,tier,active&active=is.true&order=display_name.asc"),
  ]);

  return json({
    counts,
    macros,
    settings: can(session, "settings") ? settings : { from_name: settings?.from_name, from_email: settings?.from_email },
    team,
    tags: TAGS,
    statuses: STATUSES,
    priorities: PRIORITIES,
    mailConfigured: isMailConfigured(),
  });
}

async function listTickets(url, session) {
  const tickets = await rpc("support_ticket_list", {
    p_view: url.searchParams.get("view") || "all_open",
    p_search: url.searchParams.get("search") || null,
    p_staff_id: session.sid,
    p_sort: url.searchParams.get("sort") || "age",
    p_limit: Number(url.searchParams.get("limit")) || 120,
  });
  const counts = await rpc("support_view_counts", { p_staff_id: session.sid });
  return json({ tickets, counts });
}

async function ticketDetail(url) {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing id" }, 400);
  const detail = await rpc("support_ticket_detail", { p_ticket_id: id });
  if (!detail) return json({ error: "No such ticket" }, 404);
  return json(detail);
}

async function listCustomers(url) {
  const customers = await rpc("support_customers_overview", {
    p_search: url.searchParams.get("search") || null,
    p_limit: 60,
  });
  return json({ customers });
}

async function reports(url) {
  const days = Math.min(90, Math.max(7, Number(url.searchParams.get("days")) || 14));
  return json(await rpc("support_reports", { p_days: days }));
}

async function listArticles() {
  const articles = await select(
    "support_articles",
    "select=id,title,slug,category,state,views,link_count,updated_at,body&order=updated_at.desc"
  );
  return json({ articles });
}

async function listEvents(url, session) {
  if (!can(session, "settings")) return json({ error: "Not allowed" }, 403);
  const limit = Math.min(200, Number(url.searchParams.get("limit")) || 80);
  const events = await select("support_events", `select=*&order=created_at.desc&limit=${limit}`);
  return json({ events });
}

// ---------------------------------------------------------------------------
// writing to a conversation
// ---------------------------------------------------------------------------

async function postMessage(request, session, staff) {
  const { ticketId, body, kind = "reply", solve = false } = await request.json().catch(() => ({}));
  if (!ticketId || !String(body || "").trim()) return json({ error: "Write something first" }, 400);
  if (!["reply", "note"].includes(kind)) return json({ error: "Unknown message kind" }, 400);
  if (!can(session, kind)) return json({ error: "Your role cannot do that" }, 403);

  const ticket = await selectOne(
    "support_tickets",
    `select=*,customer:support_customers(id,email,name)&id=eq.${q(ticketId)}`
  );
  if (!ticket) return json({ error: "No such ticket" }, 404);
  if (ticket.status === "closed" && !can(session, "reopen_closed")) {
    return json({ error: "This ticket is closed. Tier 3 or an admin can reopen it." }, 403);
  }

  const text = String(body).trim();
  const settings = await selectOne("support_settings", "select=*&id=is.true");
  let providerId = null;
  let messageId = null;

  if (kind === "reply") {
    if (!isMailConfigured()) {
      return json({ error: "No e-mail provider is configured, so the reply cannot be sent" }, 503);
    }
    const signature = staff.signature || settings?.signature || "";
    try {
      const sent = await sendMail({
        to: ticket.customer.email,
        subject: replySubject(ticket.subject, ticket.number),
        text: withSignature(text, signature),
        inReplyTo: ticket.email_message_id || undefined,
        fromName: settings?.from_name,
        from: settings?.from_email,
      });
      providerId = sent.id;
      messageId = sent.messageId;
    } catch (err) {
      // Nothing is written when the send fails: a reply the customer never got
      // must not sit in the thread looking answered.
      return json({ error: String(err.message || err) }, 502);
    }
  }

  await insert(
    "support_messages",
    {
      ticket_id: ticketId,
      kind,
      author_staff_id: staff.id,
      author_name: staff.display_name || staff.email,
      author_email: staff.email,
      body: text,
      provider_id: providerId,
      provider_message_id: messageId,
    },
    { returning: false }
  );

  const patch = { updated_at: new Date().toISOString() };
  if (kind === "reply") {
    patch.email_message_id = messageId;
    // A sent reply moves the ticket out of the queue by default: it is now
    // waiting on the customer, not on us.
    patch.status = solve ? "solved" : "pending";
    if (solve) patch.solved_at = new Date().toISOString();
    // "Assign to whoever replies first": only ever claims a ticket nobody owns,
    // so it can never quietly take a conversation off a colleague.
    if (settings?.auto_assign && !ticket.assignee_id) patch.assignee_id = staff.id;
  }
  await update("support_tickets", `id=eq.${q(ticketId)}`, patch, { returning: false });
  await rpc("support_recount", { p_ticket_id: ticketId });

  await logEvent({
    ticket_id: ticketId,
    staff_id: staff.id,
    actor: staff.email,
    action: kind === "reply" ? "message.replied" : "message.noted",
    detail: { solve: Boolean(solve) },
  });

  return json({ ok: true, detail: await rpc("support_ticket_detail", { p_ticket_id: ticketId }) });
}

async function createTicket(request, session, staff) {
  if (!can(session, "reply")) return json({ error: "Your role cannot do that" }, 403);
  const { email, name, subject, body, priority = "normal", tag = null } = await request.json().catch(() => ({}));

  const address = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return json({ error: "That is not a valid e-mail address" }, 400);
  if (!String(subject || "").trim()) return json({ error: "A subject is required" }, 400);
  if (!String(body || "").trim()) return json({ error: "Write the first message" }, 400);
  if (!isMailConfigured()) return json({ error: "No e-mail provider is configured" }, 503);

  let customer = await selectOne("support_customers", `select=*&email=eq.${q(address)}`);
  if (!customer) {
    customer = await insert("support_customers", { email: address, name: name || null });
  }

  const ticket = await insert("support_tickets", {
    customer_id: customer.id,
    subject: String(subject).trim(),
    priority: PRIORITIES.includes(priority) ? priority : "normal",
    tag: TAGS.includes(tag) ? tag : null,
    channel: "manual",
    status: "pending",
    assignee_id: staff.id,
  });

  const settings = await selectOne("support_settings", "select=*&id=is.true");
  const signature = staff.signature || settings?.signature || "";
  let sent;
  try {
    sent = await sendMail({
      to: address,
      subject: `${String(subject).trim()} [${ticketRef(ticket.number)}]`,
      text: withSignature(String(body).trim(), signature),
      fromName: settings?.from_name,
      from: settings?.from_email,
    });
  } catch (err) {
    // Roll the empty ticket back rather than leaving a conversation that was
    // never actually started.
    await remove("support_tickets", `id=eq.${q(ticket.id)}`);
    return json({ error: String(err.message || err) }, 502);
  }

  await insert(
    "support_messages",
    {
      ticket_id: ticket.id,
      kind: "reply",
      author_staff_id: staff.id,
      author_name: staff.display_name || staff.email,
      author_email: staff.email,
      body: String(body).trim(),
      provider_id: sent.id,
      provider_message_id: sent.messageId,
    },
    { returning: false }
  );
  await update("support_tickets", `id=eq.${q(ticket.id)}`, { email_message_id: sent.messageId }, { returning: false });
  await rpc("support_recount", { p_ticket_id: ticket.id });
  await logEvent({ ticket_id: ticket.id, staff_id: staff.id, actor: staff.email, action: "ticket.created_outbound", detail: { to: address } });

  return json({ ok: true, ticketId: ticket.id, number: ticket.number });
}

async function updateTicket(request, session, staff) {
  const payload = await request.json().catch(() => ({}));
  const { ticketId } = payload;
  if (!ticketId) return json({ error: "Missing ticketId" }, 400);

  const ticket = await selectOne("support_tickets", `select=*&id=eq.${q(ticketId)}`);
  if (!ticket) return json({ error: "No such ticket" }, 404);

  const patch = { updated_at: new Date().toISOString() };
  const changes = {};

  if (payload.status !== undefined) {
    if (!STATUSES.includes(payload.status)) return json({ error: "Unknown status" }, 400);
    if (payload.status === "spam" && !can(session, "spam")) return json({ error: "Tier 3 or an admin marks spam" }, 403);
    if (!can(session, "solve")) return json({ error: "Your role cannot change status" }, 403);
    if (ticket.status === "closed" && !can(session, "reopen_closed")) {
      return json({ error: "Reopening a closed ticket needs Tier 3 or an admin" }, 403);
    }
    patch.status = payload.status;
    patch.solved_at = payload.status === "solved" || payload.status === "closed" ? new Date().toISOString() : null;
    changes.status = payload.status;
  }

  if (payload.priority !== undefined) {
    if (!PRIORITIES.includes(payload.priority)) return json({ error: "Unknown priority" }, 400);
    if (!can(session, "set_priority")) return json({ error: "Your role cannot change priority" }, 403);
    patch.priority = payload.priority;
    changes.priority = payload.priority;
  }

  if (payload.tag !== undefined) {
    if (payload.tag && !TAGS.includes(payload.tag)) return json({ error: "Unknown tag" }, 400);
    if (!can(session, "set_tag")) return json({ error: "Your role cannot change tags" }, 403);
    patch.tag = payload.tag || null;
    changes.tag = payload.tag;
  }

  if (payload.assigneeId !== undefined) {
    const toSelf = payload.assigneeId === staff.id;
    const permitted = toSelf ? can(session, "assign_self") : can(session, "assign_other");
    if (!permitted) return json({ error: "Assigning someone else needs Tier 2 or an admin" }, 403);
    if (payload.assigneeId) {
      const target = await selectOne("staff", `select=id,active&id=eq.${q(payload.assigneeId)}`);
      if (!target || !target.active) return json({ error: "That agent is not active" }, 400);
    }
    patch.assignee_id = payload.assigneeId || null;
    changes.assignee_id = payload.assigneeId;
  }

  if (payload.escalate) {
    if (!can(session, "escalate")) return json({ error: "Escalation needs Tier 2 or an admin" }, 403);
    patch.priority = "urgent";
    patch.assignee_id = null;
    patch.status = "open";
    changes.escalated = true;
  }

  if (Object.keys(changes).length === 0) return json({ error: "Nothing to change" }, 400);

  await update("support_tickets", `id=eq.${q(ticketId)}`, patch, { returning: false });

  // A status change the customer would notice is worth a line in the thread,
  // so the next agent reads the history rather than guessing at it.
  await insert(
    "support_messages",
    {
      ticket_id: ticketId,
      kind: "system",
      author_staff_id: staff.id,
      author_name: staff.display_name || staff.email,
      body: describeChange(changes, staff),
    },
    { returning: false }
  );
  await rpc("support_recount", { p_ticket_id: ticketId });
  await logEvent({ ticket_id: ticketId, staff_id: staff.id, actor: staff.email, action: "ticket.updated", detail: changes });

  return json({ ok: true, detail: await rpc("support_ticket_detail", { p_ticket_id: ticketId }) });
}

function describeChange(changes, staff) {
  const who = staff.display_name || staff.email;
  const parts = [];
  if (changes.escalated) parts.push("escalated to urgent and returned to the queue");
  if (changes.status) parts.push(`status → ${changes.status}`);
  if (changes.priority && !changes.escalated) parts.push(`priority → ${changes.priority}`);
  if (changes.tag !== undefined && !changes.escalated) parts.push(`tag → ${changes.tag || "none"}`);
  if (changes.assignee_id !== undefined && !changes.escalated) {
    parts.push(changes.assignee_id ? "reassigned" : "unassigned");
  }
  return `${who}: ${parts.join(", ")}`;
}

async function deleteTicket(request, session, staff) {
  if (!can(session, "delete")) return json({ error: "Deleting needs Tier 3 or an admin" }, 403);
  const { ticketId } = await request.json().catch(() => ({}));
  if (!ticketId) return json({ error: "Missing ticketId" }, 400);
  const ticket = await selectOne("support_tickets", `select=number,subject&id=eq.${q(ticketId)}`);
  await remove("support_tickets", `id=eq.${q(ticketId)}`);
  await logEvent({ staff_id: staff.id, actor: staff.email, action: "ticket.deleted", detail: ticket || { ticketId } });
  return json({ ok: true });
}

async function saveCustomerNotes(request, session) {
  if (!can(session, "note")) return json({ error: "Your role cannot do that" }, 403);
  const { customerId, notes } = await request.json().catch(() => ({}));
  if (!customerId) return json({ error: "Missing customerId" }, 400);
  await update("support_customers", `id=eq.${q(customerId)}`, { notes: notes || null }, { returning: false });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// knowledge base, settings, profile
// ---------------------------------------------------------------------------

async function saveArticle(request, session, staff) {
  if (!can(session, "kb_write")) return json({ error: "Only an admin edits the knowledge base" }, 403);
  const { id, title, category, body, state = "draft" } = await request.json().catch(() => ({}));
  if (!String(title || "").trim()) return json({ error: "A title is required" }, 400);
  if (!["draft", "published", "archived"].includes(state)) return json({ error: "Unknown state" }, 400);

  const slug = String(title)
    .toLowerCase()
    // NFD + stripping the combining marks turns "Płatności" into "platnosci"
    // rather than dropping the accented letters outright.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || `article-${Date.now()}`;

  const row = {
    title: String(title).trim(),
    category: String(category || "General").trim(),
    body: String(body || ""),
    state,
    updated_at: new Date().toISOString(),
    author_staff_id: staff.id,
  };

  const saved = id
    ? await update("support_articles", `id=eq.${q(id)}`, row)
    : await insert("support_articles", { ...row, slug: `${slug}-${Math.random().toString(36).slice(2, 6)}` });

  await logEvent({ staff_id: staff.id, actor: staff.email, action: id ? "kb.updated" : "kb.created", detail: { title: row.title } });
  return json({ ok: true, article: saved });
}

async function deleteArticle(request, session, staff) {
  if (!can(session, "kb_write")) return json({ error: "Only an admin edits the knowledge base" }, 403);
  const { id } = await request.json().catch(() => ({}));
  if (!id) return json({ error: "Missing id" }, 400);
  await remove("support_articles", `id=eq.${q(id)}`);
  await logEvent({ staff_id: staff.id, actor: staff.email, action: "kb.deleted", detail: { id } });
  return json({ ok: true });
}

async function saveSettings(request, session, staff) {
  if (!can(session, "settings")) return json({ error: "Only an admin changes desk settings" }, 403);
  const payload = await request.json().catch(() => ({}));
  const patch = { updated_at: new Date().toISOString() };
  for (const key of ["from_name", "from_email", "signature", "auto_ack_body"]) {
    if (payload[key] !== undefined) patch[key] = String(payload[key]);
  }
  for (const key of ["auto_ack", "auto_assign"]) {
    if (payload[key] !== undefined) patch[key] = Boolean(payload[key]);
  }
  const saved = await update("support_settings", "id=is.true", patch);
  await logEvent({ staff_id: staff.id, actor: staff.email, action: "settings.updated", detail: Object.keys(patch) });
  return json({ ok: true, settings: saved });
}

async function saveProfile(request, staff) {
  const { signature, prefs } = await request.json().catch(() => ({}));
  const patch = {};
  if (signature !== undefined) patch.signature = signature || null;
  if (prefs !== undefined && prefs && typeof prefs === "object") {
    patch.prefs = { ...(staff.prefs || {}), ...prefs };
  }
  if (!Object.keys(patch).length) return json({ error: "Nothing to change" }, 400);
  const saved = await update("staff", `id=eq.${q(staff.id)}`, patch);
  return json({ ok: true, signature: saved.signature, prefs: saved.prefs });
}

// ---------------------------------------------------------------------------
// the old maintenance panel, now a card inside Settings
// ---------------------------------------------------------------------------

async function readMaintenance(session) {
  if (!can(session, "maintenance")) return json({ error: "Not allowed" }, 403);
  return json({ mode: await getSiteMode() });
}

async function writeMaintenance(request, session, staff) {
  if (!can(session, "maintenance")) return json({ error: "Only an owner or admin can take the site offline" }, 403);
  const { mode } = await request.json().catch(() => ({}));
  if (mode !== "live" && mode !== "maintenance") return json({ error: "Invalid mode" }, 400);
  try {
    await setSiteMode(mode);
  } catch (err) {
    return json({ error: "Vercel refused the change", details: String(err) }, 502);
  }
  await logEvent({ staff_id: staff.id, actor: staff.email, action: "site.mode", detail: { mode } });
  return json({ ok: true, mode });
}

// ---------------------------------------------------------------------------
// inbound mail
// ---------------------------------------------------------------------------

/**
 * Resend calls this when mail arrives for the domain.
 *
 * It answers 200 for anything it has decided not to act on (a delivery event,
 * an already-filed message, a bounce loop) because a non-2xx makes Resend
 * retry, and retrying will not change any of those answers. Only a genuine
 * server fault gets a 5xx, which is exactly when a retry helps.
 */
async function handleInbound(request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const raw = await request.text();
  const check = await verifyWebhookSignature(request, raw);
  if (!check.ok) {
    console.warn("rejected inbound webhook:", check.reason);
    return json({ error: "Invalid signature" }, 401);
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ ok: true, ignored: "unparseable" });
  }
  if (event?.type !== "email.received") return json({ ok: true, ignored: event?.type || "unknown" });

  const emailId = event?.data?.email_id;
  if (!emailId) return json({ ok: true, ignored: "no email_id" });

  const full = await fetchReceivedEmail(emailId);
  const sender = parseAddress(full.from || event.data.from);

  // Never answer our own mail: an auto-reply loop between two robots is the
  // classic way a support address takes itself offline.
  const ourDomain = (process.env.SUPPORT_MAIL_DOMAIN || "plately.eu").toLowerCase();
  if (!sender.email || sender.email.endsWith(`@${ourDomain}`)) {
    return json({ ok: true, ignored: "own domain" });
  }
  const headers = full.headers || {};
  const autoSubmitted = String(headers["auto-submitted"] || "").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return json({ ok: true, ignored: "auto-submitted" });
  if (headers["list-unsubscribe"] || headers["precedence"] === "bulk") {
    return json({ ok: true, ignored: "bulk" });
  }

  const text = stripQuotedReply(full.text || htmlToText(full.html));

  const result = await rpc("support_ingest_email", {
    p_payload: {
      from_email: sender.email,
      from_name: sender.name,
      subject: full.subject || event.data.subject,
      text,
      html: full.html || null,
      provider_id: emailId,
      message_id: full.message_id || event.data.message_id || null,
      in_reply_to: headers["in-reply-to"] || null,
      references: headers.references || "",
      attachments: (full.attachments || []).map((a) => ({
        id: a.id,
        filename: a.filename,
        content_type: a.content_type,
        size: a.size,
      })),
    },
  });

  if (!result?.ok) return json({ ok: true, ignored: result?.error || "not ingested" });

  // Acknowledge only a brand new conversation, and only once: a reply on an
  // existing thread already has a human on it.
  if (result.created && !result.duplicate && isMailConfigured()) {
    const settings = await selectOne("support_settings", "select=*&id=is.true");
    if (settings?.auto_ack) {
      try {
        const sent = await sendMail({
          to: sender.email,
          subject: replySubject(full.subject || "(no subject)", result.number),
          text: (settings.auto_ack_body || "").replace(/\{\{\s*ref\s*\}\}/g, ticketRef(result.number)),
          fromName: settings.from_name,
          from: settings.from_email,
        });
        await update(
          "support_tickets",
          `id=eq.${q(result.ticket_id)}`,
          { email_message_id: sent.messageId },
          { returning: false }
        );
      } catch (err) {
        // The ticket exists; a failed courtesy note is not worth a retry storm.
        console.error("auto-acknowledgement failed", err);
      }
    }
  }

  // Optional safety net for the switch-over: Resend's MX replaces whatever
  // forwarding the registrar was doing, so a copy can still land in the old
  // mailbox while the desk is being trusted. Each copy spends one send from
  // the daily quota, which is why it is off unless the variable is set.
  var forwardTo = process.env.SUPPORT_FORWARD_COPY_TO;
  if (forwardTo && isMailConfigured()) {
    try {
      await sendMail({
        to: forwardTo,
        subject: `[${ticketRef(result.number)}] ${full.subject || "(no subject)"}`,
        text: `From: ${sender.name ? sender.name + " " : ""}<${sender.email}>
` +
          `Ticket: https://plately.eu/admin

${text}`,
        replyTo: sender.email,
      });
    } catch (err) {
      console.error("forwarding a copy failed", err);
    }
  }

  return json({ ok: true, ticket: result.number, created: result.created === true });
}

