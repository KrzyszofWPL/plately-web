// ============================================================================
// Who each message comes from, and what it says.
//
// Three sender identities, on two subdomains, and the split is deliberate:
//
//   noreply@help.plately.eu   the confirmation. Nobody should reply to it, and
//                             the address says so.
//   contact@help.plately.eu   the conversation. Replies to this land back on
//                             the ticket, which is the whole point of it being
//                             a different address from the one above.
//   noreply@info.plately.eu   lifecycle mail — the subscription notice, the
//                             streak reminder. A separate DOMAIN, not just a
//                             separate address.
//
// The last one matters more than it looks. Reputation is tracked per sending
// domain, so the day a "keep your streak going" campaign gets marked as spam by
// enough people, it takes info.plately.eu down with it — and help.plately.eu,
// carrying the mail somebody is actually waiting for, is untouched. Mixing the
// two is how a support desk ends up in a spam folder because of a marketing
// send it had nothing to do with.
//
// Both live on subdomains rather than the apex, which keeps plately.eu's own MX
// where it is — the registrar's forwarding to a real mailbox goes on working
// exactly as before.
// ============================================================================

import { renderEmail, block } from "./email-render.js";

const SITE = "https://www.plately.eu";

/**
 * The addresses, all overridable, with the shipped defaults matching the DNS
 * described in SUPPORT-SETUP.md.
 */
export function identities() {
  const helpDomain = (process.env.SUPPORT_MAIL_DOMAIN || "help.plately.eu").trim();
  const infoDomain = (process.env.INFO_MAIL_DOMAIN || "info.plately.eu").trim();
  return {
    // Replies to this one are ingested by the webhook and joined to a ticket.
    support: {
      email: (process.env.SUPPORT_FROM_EMAIL || `contact@${helpDomain}`).trim(),
      name: (process.env.SUPPORT_FROM_NAME || "Plately Support").trim(),
      domain: helpDomain,
    },
    // Transactional, one-way.
    supportNoreply: {
      email: (process.env.SUPPORT_NOREPLY_EMAIL || `noreply@${helpDomain}`).trim(),
      name: (process.env.SUPPORT_FROM_NAME || "Plately Support").trim(),
      domain: helpDomain,
    },
    // Lifecycle. Different domain, different reputation.
    info: {
      email: (process.env.INFO_FROM_EMAIL || `noreply@${infoDomain}`).trim(),
      name: (process.env.INFO_FROM_NAME || "Plately").trim(),
      domain: infoDomain,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. confirm the request  —  noreply@help
// ---------------------------------------------------------------------------

/**
 * Why a confirmation step exists at all.
 *
 * The form takes an address and writes to it. Without a confirmation, anyone
 * can type a stranger's address into it and make us send them mail — that is
 * the whole mechanism behind form-to-mail abuse, and the reputation damage
 * lands on us, not on whoever typed it. Requiring one click before the ticket
 * reaches the desk means we only ever hold conversations with people who can
 * read the mailbox they gave us.
 *
 * It also keeps the queue honest: an agent's inbox contains real requests from
 * reachable people, not typos and drive-by nonsense.
 */
export function confirmRequestEmail({ reference, subject, category, body, confirmUrl, locale }) {
  const pl = locale !== "en";
  const title = pl ? "Potwierdź swoje zgłoszenie" : "Confirm your request";

  return {
    subject: pl
      ? `Potwierdź zgłoszenie [${reference}]`
      : `Confirm your request [${reference}]`,
    ...renderEmail({
      title,
      accentLabel: "Support",
      preheader: pl
        ? "Jedno kliknięcie i Twoje zgłoszenie trafi do zespołu."
        : "One click and your request reaches the team.",
      blocks: [
        block.text(
          pl
            ? "Dostaliśmy zgłoszenie z formularza pomocy na plately.eu. Zanim trafi do zespołu, potwierdź proszę, że ten adres należy do Ciebie — to jedno kliknięcie."
            : "We received a request from the help form on plately.eu. Before it reaches the team, please confirm this address is yours — it is one click."
        ),
        block.button(pl ? "Potwierdzam zgłoszenie" : "Confirm my request", confirmUrl),
        block.facts([
          [pl ? "Numer" : "Reference", reference],
          [pl ? "Kategoria" : "Category", category],
          [pl ? "Temat" : "Subject", subject],
        ]),
        block.quote(pl ? "Twoja wiadomość" : "Your message", body),
        block.text(
          pl
            ? "Po potwierdzeniu odpiszemy na ten adres — zwykle w ciągu jednego dnia roboczego."
            : "Once confirmed we will reply to this address, usually within one business day."
        ),
      ],
      footer: [
        pl
          ? "Jeśli to nie Ty wypełniałeś/aś ten formularz, po prostu zignoruj tę wiadomość — bez kliknięcia nic się nie wydarzy i nikt Ci nie odpisze."
          : "If you did not fill in this form, simply ignore this message — without the click nothing happens and nobody will write to you.",
        pl
          ? "Ta wiadomość jest wysyłana automatycznie i nie przyjmuje odpowiedzi."
          : "This message is automatic and does not accept replies.",
      ],
    }),
  };
}

// ---------------------------------------------------------------------------
// 2. an agent's reply  —  contact@help
// ---------------------------------------------------------------------------

/**
 * What the agent is called in front of a customer.
 *
 * Not the internal ladder. "Agent T2" means something to the desk and nothing
 * to the person reading it, and tiers are our business, not theirs.
 */
export function publicRole(role, tier, pl) {
  if (role === "owner" || role === "admin") return pl ? "Zespół Plately" : "The Plately team";
  if (role === "agent" && Number(tier) >= 3) {
    return pl ? "Starszy konsultant wsparcia" : "Senior support specialist";
  }
  return pl ? "Wsparcie Plately" : "Plately Support";
}

function initialsOf(name) {
  const parts = String(name || "?").trim().split(/[\s@._-]+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function agentReplyEmail({ reference, subject, body, agentName, agentRole, agentTier, signature, locale }) {
  const pl = locale !== "en";
  // A signature the agent wrote themselves wins: it is the one place they get
  // to sound like themselves rather than like the template.
  const signOff = signature
    ? block.text(signature)
    : block.signoff({
        greeting: pl ? "Pozdrawiam," : "Best regards,",
        name: agentName,
        role: publicRole(agentRole, agentTier, pl),
        initials: initialsOf(agentName),
      });

  return {
    subject,
    ...renderEmail({
      title: pl ? "Odpowiedź od zespołu Plately" : "A reply from the Plately team",
      accentLabel: "Support",
      preheader: String(body || "").slice(0, 110),
      blocks: [
        block.text(body),
        signOff,
        block.facts([
          [pl ? "Zgłoszenie" : "Ticket", reference],
          [pl ? "Temat" : "Subject", subject.replace(/\s*\[[A-Z]+-\d+\]\s*$/, "")],
        ]),
      ],
      footer: [
        pl
          ? "Możesz po prostu odpowiedzieć na tę wiadomość — dopisze się do tej samej rozmowy."
          : "You can simply reply to this message — it joins the same conversation.",
      ],
    }),
  };
}
// ---------------------------------------------------------------------------
// 3. inbound acknowledgement  —  noreply@help
// ---------------------------------------------------------------------------

/** For mail that arrives straight at the address, bypassing the form. */
export function inboundAckEmail({ reference, subject, body, locale }) {
  const pl = locale !== "en";
  return {
    subject,
    ...renderEmail({
      title: pl ? "Mamy Twoją wiadomość" : "We have your message",
      accentLabel: "Support",
      preheader: pl
        ? `Zgłoszenie ${reference} — odpowie człowiek, zwykle w jeden dzień roboczy.`
        : `Ticket ${reference} — a person will answer, usually within one business day.`,
      blocks: [
        block.text(
          pl
            ? `Twoja wiadomość dotarła do zespołu Plately i ma numer ${reference}. Czyta ją człowiek — odpowiedź przyjdzie na ten adres, zwykle w ciągu jednego dnia roboczego.`
            : `Your message reached the Plately team and is ticket ${reference}. A person reads it — the answer comes back to this address, usually within one business day.`
        ),
        ...(body ? [block.quote(pl ? "Co do nas napisałeś/aś" : "What you sent us", body)] : []),
        block.text(
          pl
            ? "Nie musisz nic więcej robić. Jeśli chcesz coś dodać, odpowiedz na tę wiadomość."
            : "You do not need to do anything else. If you want to add something, reply to this message."
        ),
      ],
      footer: [
        pl ? "To jest automatyczne potwierdzenie." : "This is an automatic acknowledgement.",
      ],
    }),
  };
}

// ---------------------------------------------------------------------------
// 4. lifecycle  —  noreply@info
// ---------------------------------------------------------------------------

/**
 * The subscription notice, the streak reminder, and every other message a
 * person did not ask for on the day it arrives.
 *
 * These carry an unsubscribe link and mean it. It is a legal requirement in
 * the EU for anything that is not strictly transactional, and it is also the
 * difference between somebody clicking "unsubscribe" and clicking "spam" —
 * only one of those two costs us the ability to deliver mail to anybody else.
 */
export function lifecycleEmail({ title, body, cta, ctaUrl, unsubscribeUrl, preheader, locale }) {
  const pl = locale !== "en";
  return {
    subject: title,
    ...renderEmail({
      title,
      preheader: preheader || String(body || "").slice(0, 110),
      blocks: [
        block.text(body),
        ...(cta && ctaUrl ? [block.button(cta, ctaUrl)] : []),
      ],
      footer: [
        pl
          ? `Dostajesz tę wiadomość, bo masz konto w Plately. <a href="${unsubscribeUrl || SITE}" style="color:#71717a;text-decoration:underline;">Wypisz się z powiadomień</a>.`
          : `You are getting this because you have a Plately account. <a href="${unsubscribeUrl || SITE}" style="color:#71717a;text-decoration:underline;">Unsubscribe from notifications</a>.`,
        pl
          ? "W sprawach pomocy pisz na plately.eu/help — ten adres nie przyjmuje odpowiedzi."
          : "For help, write via plately.eu/help — this address does not accept replies.",
      ],
    }),
  };
}
