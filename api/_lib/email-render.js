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

// The three links under every message. Kept here rather than in each template,
// because the point of them is that they are the same in all of them.
const NAV = {
  pl: [
    ["Pomoc", `${SITE}/help`],
    ["Status", `${SITE}/status`],
    ["Prywatność", `${SITE}/privacy`],
  ],
  en: [
    ["Help", `${SITE}/help`],
    ["Status", `${SITE}/status`],
    ["Privacy", `${SITE}/privacy`],
  ],
};

const C = {
  page: "#f8f9fa",
  card: "#ffffff",
  line: "#e2e8f0",
  text: "#0f172a",
  muted: "#334155",
  faint: "#64748b",
  // Sampled from logo.png rather than picked by eye. The mark is the one piece
  // of the message a client cannot restyle, so everything else matches it —
  // a button in a different green next to it reads as a broken template.
  brand: "#0b845a",
  onBrand: "#ffffff",
  quote: "#f8fafc",
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
  `<p style="margin:0 0 18px;font-family:${FONT};font-size:15px;line-height:25px;color:${color};">${html}</p>`;

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
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">` +
      `<tr><td bgcolor="${C.quote}" style="background:${C.quote};border-left:4px solid ${C.brand};border-radius:6px;padding:16px 20px;">` +
      (label
        ? `<div style="margin:0 0 8px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.faint};">${escapeHtml(label)}</div>`
        : "") +
      paragraphsFrom(value).map((h) => p(h, C.text)).join("").replace(/margin:0 0 16px/g, "margin:0 0 12px") +
      `</td></tr></table>`,
    text: (label ? `--- ${label} ---\n` : "") + String(value || "").trim() + "\n---",
  }),

  /** Reference, category, that sort of thing. */
  facts: (pairs, locale) => {
    const title = locale === "en" ? "Request details" : "Szczegóły zgłoszenia";
    const rows = pairs
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(
        ([k, v], idx) => {
          const isLast = idx === pairs.length - 1;
          const borderStyle = isLast ? "" : "border-bottom:1px solid #f1f5f9;";
          return `<tr>` +
            `<td style="padding:14px 0;font-family:${FONT};font-size:14px;line-height:20px;color:${C.faint};vertical-align:top;${borderStyle}">${escapeHtml(k)}:</td>` +
            `<td style="padding:14px 0;font-family:${FONT};font-size:14px;line-height:20px;color:${C.text};font-weight:600;text-align:right;vertical-align:top;${borderStyle}">${escapeHtml(v)}</td>` +
            `</tr>`;
        }
      );

    return {
      html:
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">` +
        `<tr><td bgcolor="${C.quote}" style="background:${C.quote};border:1px solid ${C.line};border-radius:12px;padding:16px 20px;">` +
        `<div style="font-family:${FONT};font-size:12px;font-weight:700;color:${C.text};text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">${title}</div>` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">` +
        rows.join("") +
        `</table>` +
        `</td></tr></table>`,
      text: pairs
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n"),
    };
  },

  /**
   * The bulletproof button. Two nested tables and a padded link, because a
   * styled <a> loses its padding in several clients and becomes plain text.
   */
  button: (label, href, locale) => ({
    html:
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:12px auto 28px;">` +
      `<tr><td bgcolor="${C.brand}" style="background:${C.brand};border-radius:6px;box-shadow:0 2px 4px rgba(0,0,0,0.05);">` +
      `<a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 32px;font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;color:${C.onBrand};text-decoration:none;border-radius:6px;letter-spacing:-.01em;">${escapeHtml(label)}</a>` +
      `</td></tr></table>` +
      // A button is useless to anyone whose client blocks the link, and to
      // anyone forwarding the message. The address goes below it, always.
      `<p style="margin:0 0 24px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint};word-break:break-all;text-align:center;">` +
      (locale === "en"
        ? `If the button does not work, paste this address into your browser:<br>`
        : `Jeśli przycisk nie działa, wklej ten adres w przeglądarkę:<br>`) +
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
export function renderEmail({ title, preheader, blocks = [], footer = [], accentLabel = null, locale }) {
  const pl = locale !== "en";
  const body = blocks.map((b) => b.html).join("");
  const footHtml = footer
    .map(
      (line) =>
        `<p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint};text-align:center;">${line}</p>`
    )
    .join("");

  const nav = NAV[pl ? "pl" : "en"];

  const html =
    `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">` +
    `<html xmlns="http://www.w3.org/1999/xhtml" lang="${pl ? "pl" : "en"}"><head>` +
    `<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    // Tells a client that respects it not to "helpfully" invert our dark design.
    `<meta name="color-scheme" content="dark light">` +
    `<meta name="supported-color-schemes" content="dark light">` +
    `<title>${escapeHtml(title)}</title>` +
    // The only stylesheet in the message, and nothing depends on it: every
    // rule here is a phone-sized override of an inline style that already
    // works. A client that drops <style> (Gmail does, in some views) loses
    // the tighter padding and nothing else.
    `<style type="text/css">` +
    `body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}` +
    `table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}` +
    `img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none;}` +
    `@media screen and (max-width:620px){` +
    `.ec{width:100%!important;max-width:100%!important;}` +
    `.card-pad{padding:28px 22px 12px!important;}` +
    `.h1{font-size:22px!important;line-height:30px!important;}}` +
    `</style>` +
    `</head>` +
    `<body style="margin:0;padding:0;background:${C.page};">` +
    // Hidden preheader, then enough zero-width space to stop the client
    // pulling real body copy in after it.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">` +
    `${escapeHtml(preheader || title)}${"&#847;&zwnj;&nbsp;".repeat(60)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page};">` +
    `<tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="ec" style="width:600px;max-width:100%;">` +

    // --- brand ---
    `<tr><td align="center" style="padding:0 4px 24px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>` +
    // alt text, not alt="": images are blocked by default in enough clients
    // that the name has to survive without the mark.
    `<td style="padding-right:10px;vertical-align:middle;"><img src="${LOGO}" width="36" height="36" alt="Plately" style="display:block;width:36px;height:36px;border-radius:10px;border:0;"></td>` +
    `<td style="font-family:${FONT};font-size:22px;font-weight:700;color:${C.text};letter-spacing:-.02em;vertical-align:middle;">Plately` +
    (accentLabel
      ? `<span style="font-weight:500;color:${C.faint};font-size:16px;"> · ${escapeHtml(accentLabel)}</span>`
      : "") +
    `</td></tr></table></td></tr>` +

    // --- card ---
    `<tr><td bgcolor="${C.card}" class="card-pad" style="background:${C.card};border:1px solid ${C.line};border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,0.05), 0 10px 20px -5px rgba(0,0,0,0.03);padding:40px 36px 20px;">` +
    `<h1 class="h1" style="margin:0 0 20px;font-family:${FONT};font-size:26px;line-height:34px;font-weight:700;color:${C.text};letter-spacing:-.03em;text-align:center;">${escapeHtml(title)}</h1>` +
    body +
    `</td></tr>` +

    // --- footer ---
    //
    // Three tiers, and the alignment is the whole design: the small print and
    // the links sit centred under the card, mirroring the logo above it, and
    // the only thing left against the left edge is the address itself. One
    // anchor at the bottom reads as finished; three ragged-left blocks stacked
    // on each other read as leftovers.
    (footHtml
      ? `<tr><td style="padding:22px 6px 0;">${footHtml}</td></tr>`
      : "") +
    `<tr><td align="center" style="padding:14px 6px 0;">` +
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint};text-align:center;">` +
    nav
      .map(([label, href]) => `<a href="${href}" style="color:${C.faint};text-decoration:underline;">${label}</a>`)
      .join(`<span style="color:#cbd5e1;padding:0 8px;">&middot;</span>`) +
    `</p></td></tr>` +
    `<tr><td style="padding:14px 6px 0;">` +
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint};">` +
    `<a href="${SITE}" style="color:${C.faint};text-decoration:underline;">www.plately.eu</a></p>` +
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
    nav.map(([label, href]) => `${label}: ${href}`).join("\n"),
    "www.plately.eu",
  ].join("\n");

  return { html, text };
}
