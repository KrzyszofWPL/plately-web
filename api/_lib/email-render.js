// ============================================================================
// What our e-mail actually looks like when it arrives.
//
// Every message this project sends goes through here, so the confirmation, the
// agent's reply and the lifecycle notice are recognisably the same company.
//
// Written for mail clients, not browsers, which is a different and much older
// craft:
//
//   * Tables, not flexbox or grid. Outlook on Windows renders through Word,
//     which has no support for either and will collapse a div layout.
//   * Inline styles on every element. Gmail strips <style> blocks in some
//     views, and a stylesheet that vanishes takes the whole design with it.
//   * `bgcolor` attributes beside the CSS background, because Word honours the
//     attribute and ignores the property.
//   * The call to action is a "bulletproof button": a table cell with a
//     background and a padded link inside, rather than a styled <a>, so it
//     stays a rectangle in clients that drop padding on inline elements.
//   * Pixel widths, capped at 600 — the width every client has agreed on for
//     twenty years and the width a phone can show without zooming.
//
// A dark palette on purpose: it is what the site and the app look like, and
// Gmail, Apple Mail and Outlook.com all render it faithfully. The one client
// that does not (Outlook desktop) still gets legible dark text because the
// fallback is the body background, and that is set too.
//
// Every message is sent as HTML *and* plain text. Some people read in plain
// text by choice; more importantly, a message with no text part scores worse
// with spam filters, and this desk cannot afford to land in spam.
// ============================================================================

const SITE = "https://www.plately.eu";

// Absolute, because an e-mail has no origin to resolve against.
const LOGO = `${SITE}/logo.png`;

const C = {
  page: "#0a0a0b",
  card: "#131316",
  line: "#26262b",
  text: "#f4f4f5",
  muted: "#a1a1aa",
  faint: "#71717a",
  brand: "#34d399",
  onBrand: "#04140d",
  quote: "#1b1c1f",
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/** Customer-written text into HTML: escaped first, then newlines honoured. */
function paragraphsFrom(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => escapeHtml(block).replace(/\n/g, "<br>"));
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

const p = (html, color = C.muted) =>
  `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:24px;color:${color};">${html}</p>`;

/**
 * Each block returns { html, text } so the plain-text alternative is built
 * from the same content rather than written twice and allowed to drift.
 */
export const block = {
  text: (value) => ({
    html: paragraphsFrom(value).map((h) => p(h)).join(""),
    text: String(value || "").trim(),
  }),

  /** What the customer wrote, quoted back so they can see we have it. */
  quote: (label, value) => ({
    html:
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">` +
      `<tr><td bgcolor="${C.quote}" style="background:${C.quote};border-left:3px solid ${C.brand};border-radius:0 10px 10px 0;padding:16px 18px;">` +
      (label
        ? `<p style="margin:0 0 8px;font-family:${FONT};font-size:11px;line-height:16px;letter-spacing:.08em;text-transform:uppercase;color:${C.faint};">${escapeHtml(label)}</p>`
        : "") +
      paragraphsFrom(value).map((h) => p(h, C.text)).join("").replace(/margin:0 0 16px/g, "margin:0 0 10px") +
      `</td></tr></table>`,
    text: (label ? `--- ${label} ---\n` : "") + String(value || "").trim() + "\n---",
  }),

  /** Reference, category, that sort of thing. */
  facts: (pairs) => ({
    html:
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">` +
      pairs
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(
          ([k, v]) =>
            `<tr>` +
            `<td style="padding:5px 12px 5px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${C.faint};white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td>` +
            `<td style="padding:5px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${C.text};">${escapeHtml(v)}</td>` +
            `</tr>`
        )
        .join("") +
      `</table>`,
    text: pairs
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
  }),

  /**
   * The bulletproof button. Two nested tables and a padded link, because a
   * styled <a> loses its padding in several clients and becomes plain text.
   */
  button: (label, href) => ({
    html:
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px;">` +
      `<tr><td bgcolor="${C.brand}" style="background:${C.brand};border-radius:999px;">` +
      `<a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 32px;font-family:${FONT};font-size:15px;font-weight:700;line-height:20px;color:${C.onBrand};text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>` +
      `</td></tr></table>` +
      // A button is useless to anyone whose client blocks the link, and to
      // anyone forwarding the message. The address goes below it, always.
      `<p style="margin:0 0 20px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint};word-break:break-all;">` +
      `Jeśli przycisk nie działa, wklej ten adres w przeglądarkę:<br>` +
      `<a href="${escapeHtml(href)}" style="color:${C.brand};text-decoration:underline;">${escapeHtml(href)}</a></p>`,
    text: `${label}:\n${href}`,
  }),

  /**
   * The sign-off. A person's name and what they do, in a block that reads as
   * written by a human rather than appended by a system.
   *
   * The initials disc is a table cell, not a flex item: same reason as
   * everything else here — Outlook renders through Word.
   */
  signoff: ({ greeting, name, role, initials }) => ({
    html:
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 20px;">` +
      `<tr><td height="1" bgcolor="${C.line}" style="background:${C.line};font-size:0;line-height:0;">&nbsp;</td></tr>` +
      `<tr><td style="padding-top:18px;">` +
      `<p style="margin:0 0 12px;font-family:${FONT};font-size:15px;line-height:23px;color:${C.muted};">${escapeHtml(greeting)}</p>` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
      `<td width="40" style="padding-right:12px;vertical-align:top;">` +
      `<table role="presentation" width="40" height="40" cellpadding="0" cellspacing="0" border="0" style="width:40px;height:40px;">` +
      `<tr><td align="center" valign="middle" bgcolor="${C.brand}" style="background:${C.brand};border-radius:50%;` +
      `font-family:${FONT};font-size:14px;font-weight:700;color:${C.onBrand};height:40px;">${escapeHtml(initials)}</td></tr>` +
      `</table></td>` +
      `<td style="vertical-align:middle;">` +
      `<div style="font-family:${FONT};font-size:15px;font-weight:600;line-height:21px;color:${C.text};">${escapeHtml(name)}</div>` +
      `<div style="font-family:${FONT};font-size:13px;line-height:19px;color:${C.faint};">${escapeHtml(role)}</div>` +
      `</td></tr></table>` +
      `</td></tr></table>`,
    text: `${greeting}
${name}
${role}`,
  }),

  divider: () => ({
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr><td height="1" bgcolor="${C.line}" style="background:${C.line};font-size:0;line-height:0;">&nbsp;</td></tr></table>`,
    text: "\n---\n",
  }),
};

// ---------------------------------------------------------------------------
// the shell
// ---------------------------------------------------------------------------

/**
 * Wraps blocks in the Plately frame and returns { html, text }.
 *
 * `preheader` is the grey line a client shows next to the subject in the list.
 * Left unset, clients grab the first words of the body — usually the logo alt
 * text or "Jeśli przycisk nie działa", which is a poor first impression.
 */
export function renderEmail({ title, preheader, blocks = [], footer = [], accentLabel = null }) {
  const body = blocks.map((b) => b.html).join("");
  const footHtml = footer
    .map(
      (line) =>
        `<p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint};">${line}</p>`
    )
    .join("");

  const html =
    `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">` +
    `<html xmlns="http://www.w3.org/1999/xhtml"><head>` +
    `<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    // Tells a client that respects it not to "helpfully" invert our dark design.
    `<meta name="color-scheme" content="dark light">` +
    `<meta name="supported-color-schemes" content="dark light">` +
    `<title>${escapeHtml(title)}</title>` +
    `</head>` +
    `<body style="margin:0;padding:0;background:${C.page};">` +
    // Hidden preheader, then enough zero-width space to stop the client
    // pulling real body copy in after it.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">` +
    `${escapeHtml(preheader || title)}${"&#847;&zwnj;&nbsp;".repeat(60)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page};">` +
    `<tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">` +

    // --- brand ---
    `<tr><td style="padding:0 4px 20px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="padding-right:11px;"><img src="${LOGO}" width="34" height="34" alt="" style="display:block;width:34px;height:34px;border-radius:9px;border:0;"></td>` +
    `<td style="font-family:${FONT};font-size:17px;font-weight:700;color:${C.text};letter-spacing:-.01em;">Plately` +
    (accentLabel
      ? `<span style="font-weight:600;color:${C.faint};"> · ${escapeHtml(accentLabel)}</span>`
      : "") +
    `</td></tr></table></td></tr>` +

    // --- card ---
    `<tr><td bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-radius:18px;padding:32px 30px 14px;">` +
    `<h1 style="margin:0 0 18px;font-family:${FONT};font-size:24px;line-height:31px;font-weight:700;color:${C.text};letter-spacing:-.02em;">${escapeHtml(title)}</h1>` +
    body +
    `</td></tr>` +

    // --- footer ---
    (footHtml
      ? `<tr><td style="padding:22px 6px 0;">${footHtml}</td></tr>`
      : "") +
    `<tr><td style="padding:14px 6px 0;">` +
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint};">` +
    `<a href="${SITE}" style="color:${C.faint};text-decoration:underline;">plately.eu</a></p>` +
    `</td></tr>` +

    `</table></td></tr></table></body></html>`;

  const text = [
    title,
    "=".repeat(Math.min(title.length, 60)),
    "",
    ...blocks.map((b) => b.text).filter(Boolean),
    "",
    "—",
    ...footer.map((line) => line.replace(/<[^>]+>/g, "")),
    "plately.eu",
  ].join("\n");

  return { html, text };
}
