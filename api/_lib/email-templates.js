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
  const title = pl ? "Potwierdź zgłoszenie" : "Confirm your request";

  return {
    subject: pl
      ? `Potwierdź zgłoszenie [${reference}]`
      : `Confirm your request [${reference}]`,
    ...renderEmail({
      locale,
      title,
      accentLabel: "Support",
      preheader: pl
        ? "Kliknij, żeby Twoje zgłoszenie do nas dotarło."
        : "One click and your request reaches the team.",
      blocks: [
        block.text(
          pl
            ? "Cześć! Widzimy, że wysłałeś/aś wiadomość przez formularz na plately.eu. Potwierdź proszę swój adres e-mail — wystarczy kliknąć przycisk poniżej."
            : "Hi! We see you sent a message through the form on plately.eu. Please confirm your email address — just click the button below."
        ),
        block.button(pl ? "Potwierdzam" : "Confirm my request", confirmUrl, locale),
        block.facts([
          [pl ? "Numer" : "Reference", reference],
          [pl ? "Kategoria" : "Category", category],
          [pl ? "Temat" : "Subject", subject],
        ], locale),
        block.quote(pl ? "Twoja wiadomość" : "Your message", body),
        block.text(
          pl
            ? "Jak tylko potwierdzisz, zajmiemy się Twoją sprawą. Staramy się odpowiadać w ciągu jednego dnia roboczego."
            : "Once you confirm, we'll get right on it. We usually reply within one business day."
        ),
      ],
      footer: [
        pl
          ? "Nie wypełniałeś/aś tego formularza? Zignoruj tę wiadomość — nic się nie stanie."
          : "Didn't fill in this form? Just ignore this message — nothing will happen.",
        pl
          ? "Wiadomość wysłana automatycznie — nie odpowiadaj na nią."
          : "This is an automated message — please don't reply to it.",
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
      locale,
      title: pl ? "Odpowiedź od zespołu Plately" : "A reply from the Plately team",
      accentLabel: "Support",
      preheader: String(body || "").slice(0, 110),
      blocks: [
        block.text(body),
        signOff,
        block.facts([
          [pl ? "Zgłoszenie" : "Ticket", reference],
          [pl ? "Temat" : "Subject", subject.replace(/\s*\[[A-Z]+-\d+\]\s*$/, "")],
        ], locale),
      ],
      footer: [
        pl
          ? "Chcesz coś dodać? Odpowiedz na tego maila — trafimy na tę samą rozmowę."
          : "Want to follow up? Just reply to this email — it stays on the same thread.",
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
      locale,
      title: pl ? "Dostaliśmy Twoją wiadomość" : "We got your message",
      accentLabel: "Support",
      preheader: pl
        ? `Zgłoszenie ${reference} — odezwiemy się najszybciej, jak się da.`
        : `Ticket ${reference} — we'll get back to you as soon as we can.`,
      blocks: [
        block.text(
          pl
            ? `Cześć! Twoja wiadomość do nas dotarła — ma numer ${reference}. Ktoś z zespołu ją przeczyta i odpowie Ci na ten adres, zwykle w ciągu jednego dnia roboczego.`
            : `Hi! Your message made it through — it's ticket ${reference}. Someone from the team will read it and reply to this address, usually within one business day.`
        ),
        ...(body ? [block.quote(pl ? "Co do nas napisałeś/aś" : "What you sent us", body)] : []),
        block.text(
          pl
            ? "Nie musisz nic więcej robić. Chcesz coś dodać? Po prostu odpowiedz na tego maila."
            : "Nothing else needed from your side. Want to add something? Just reply to this email."
        ),
      ],
      footer: [
        pl ? "To automatyczne potwierdzenie." : "This is an automatic confirmation.",
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
      locale,
      title,
      preheader: preheader || String(body || "").slice(0, 110),
      blocks: [
        block.text(body),
        ...(cta && ctaUrl ? [block.button(cta, ctaUrl, locale)] : []),
      ],
      footer: [
        pl
          ? `Wysyłamy Ci to, bo masz konto w Plately. <a href="${unsubscribeUrl || SITE}" style="color:#71717a;text-decoration:underline;">Wypisz się</a>.`
          : `You're getting this because you have a Plately account. <a href="${unsubscribeUrl || SITE}" style="color:#71717a;text-decoration:underline;">Unsubscribe</a>.`,
        pl
          ? "Potrzebujesz pomocy? Napisz na plately.eu/help — ten adres nie przyjmuje odpowiedzi."
          : "Need help? Head to plately.eu/help — this address doesn't accept replies.",
      ],
    }),
  };
}

// ---------------------------------------------------------------------------
// 5. the gift card somebody just bought in the shop  —  noreply@help
// ---------------------------------------------------------------------------

// The shop speaks the app's twelve languages; the mail's own chrome (nav,
// footer) is Polish or English, so a buyer in any other language reads the
// body in theirs and the frame in English. Body copy only, deliberately short.
const GIFT_MAIL = {
  pl: { subject: "Twoja karta podarunkowa Plately", title: "Karta gotowa", pre: "Link do prezentu jest w tej wiadomości.",
    body: "Dziękujemy za zakup. Poniżej jest link do prezentu — wyślij go obdarowanej osobie (albo otwórz sam). Rozpakuje kartę i zdrapie kod, jak prawdziwą.",
    button: "Otwórz prezent", backup: "Na wszelki wypadek — kod z karty, do wpisania ręcznie na plately.eu/redeem:", plan: "Karta", days: "dni",
    foot: "Kod działa raz, na dowolnym koncie Plately. Pomoc: plately.eu/help — ten adres nie przyjmuje odpowiedzi." },
  en: { subject: "Your Plately gift card", title: "Your card is ready", pre: "The gift link is in this message.",
    body: "Thank you for your purchase. Below is the gift link — send it to the person you are giving the card to (or open it yourself). They unwrap the card and scratch the code, like a real one.",
    button: "Open the gift", backup: "Just in case — the code from the card, to type by hand at plately.eu/redeem:", plan: "Card", days: "days",
    foot: "The code works once, on any Plately account. Help: plately.eu/help — this address does not accept replies." },
  de: { subject: "Deine Plately-Geschenkkarte", title: "Deine Karte ist bereit", pre: "Der Geschenk-Link ist in dieser Nachricht.",
    body: "Danke für deinen Kauf. Unten ist der Geschenk-Link — schick ihn der beschenkten Person (oder öffne ihn selbst). Sie packt die Karte aus und rubbelt den Code frei, wie bei einer echten.",
    button: "Geschenk öffnen", backup: "Für alle Fälle — der Code der Karte, von Hand einzugeben auf plately.eu/redeem:", plan: "Karte", days: "Tage",
    foot: "Der Code gilt einmal, auf jedem Plately-Konto. Hilfe: plately.eu/help — diese Adresse nimmt keine Antworten an." },
  uk: { subject: "Ваша подарункова картка Plately", title: "Картка готова", pre: "Посилання на подарунок у цьому листі.",
    body: "Дякуємо за покупку. Нижче — посилання на подарунок: надішліть його тому, кому даруєте (або відкрийте самі). Отримувач розгорне картку та зітре код, як справжню.",
    button: "Відкрити подарунок", backup: "Про всяк випадок — код з картки, щоб ввести вручну на plately.eu/redeem:", plan: "Картка", days: "днів",
    foot: "Код діє один раз, на будь-якому обліковому записі Plately. Допомога: plately.eu/help — ця адреса не приймає відповідей." },
  ru: { subject: "Ваша подарочная карта Plately", title: "Карта готова", pre: "Ссылка на подарок в этом письме.",
    body: "Спасибо за покупку. Ниже — ссылка на подарок: отправьте её тому, кому дарите (или откройте сами). Получатель развернёт карту и сотрёт код, как настоящую.",
    button: "Открыть подарок", backup: "На всякий случай — код с карты, чтобы ввести вручную на plately.eu/redeem:", plan: "Карта", days: "дней",
    foot: "Код действует один раз, на любом аккаунте Plately. Помощь: plately.eu/help — этот адрес не принимает ответов." },
  fr: { subject: "Votre carte cadeau Plately", title: "Votre carte est prête", pre: "Le lien cadeau est dans ce message.",
    body: "Merci pour votre achat. Ci-dessous, le lien cadeau — envoyez-le à la personne à qui vous offrez la carte (ou ouvrez-le vous-même). Elle déballe la carte et gratte le code, comme une vraie.",
    button: "Ouvrir le cadeau", backup: "Au cas où — le code de la carte, à saisir à la main sur plately.eu/redeem :", plan: "Carte", days: "jours",
    foot: "Le code fonctionne une fois, sur n'importe quel compte Plately. Aide : plately.eu/help — cette adresse n'accepte pas de réponses." },
  it: { subject: "La tua carta regalo Plately", title: "La tua carta è pronta", pre: "Il link del regalo è in questo messaggio.",
    body: "Grazie per l'acquisto. Qui sotto c'è il link del regalo — invialo alla persona a cui regali la carta (o aprilo tu). Scarta la carta e gratta il codice, come una vera.",
    button: "Apri il regalo", backup: "Per sicurezza — il codice della carta, da digitare a mano su plately.eu/redeem:", plan: "Carta", days: "giorni",
    foot: "Il codice vale una volta, su qualsiasi account Plately. Aiuto: plately.eu/help — questo indirizzo non accetta risposte." },
  es: { subject: "Tu tarjeta regalo Plately", title: "Tu tarjeta está lista", pre: "El enlace del regalo está en este mensaje.",
    body: "Gracias por tu compra. Abajo está el enlace del regalo — envíaselo a quien le regalas la tarjeta (o ábrelo tú). Desenvuelve la tarjeta y rasca el código, como una de verdad.",
    button: "Abrir el regalo", backup: "Por si acaso — el código de la tarjeta, para escribirlo a mano en plately.eu/redeem:", plan: "Tarjeta", days: "días",
    foot: "El código funciona una vez, en cualquier cuenta Plately. Ayuda: plately.eu/help — esta dirección no acepta respuestas." },
  pt: { subject: "O seu cartão-presente Plately", title: "O seu cartão está pronto", pre: "A ligação do presente está nesta mensagem.",
    body: "Obrigado pela compra. Abaixo está a ligação do presente — envie-a a quem oferece o cartão (ou abra-a você). Desembrulha o cartão e raspa o código, como um verdadeiro.",
    button: "Abrir o presente", backup: "Por precaução — o código do cartão, para introduzir à mão em plately.eu/redeem:", plan: "Cartão", days: "dias",
    foot: "O código funciona uma vez, em qualquer conta Plately. Ajuda: plately.eu/help — este endereço não aceita respostas." },
  ja: { subject: "Plately ギフトカードのご案内", title: "カードの準備ができました", pre: "ギフトリンクはこのメールにあります。",
    body: "ご購入ありがとうございます。下のギフトリンクを、贈る相手に送ってください（ご自身で開くこともできます）。受け取った人はカードを開けてスクラッチを削ります。",
    button: "プレゼントを開く", backup: "念のため — plately.eu/redeem で手入力できるカードのコード：", plan: "カード", days: "日",
    foot: "コードは Plately のどのアカウントでも 1 回だけ使えます。ヘルプ：plately.eu/help — このアドレスは返信を受け付けません。" },
  zh: { subject: "你的 Plately 礼品卡", title: "卡片已就绪", pre: "礼物链接就在这封邮件里。",
    body: "感谢购买。下方是礼物链接 — 把它发给收礼人（也可以自己打开）。对方拆开卡片、刮开兑换码，就像真正的礼品卡一样。",
    button: "打开礼物", backup: "以防万一 — 卡片上的兑换码，可在 plately.eu/redeem 手动输入：", plan: "卡片", days: "天",
    foot: "兑换码仅可在任一 Plately 账户上使用一次。帮助：plately.eu/help — 此地址不接受回复。" },
  ko: { subject: "Plately 기프트 카드", title: "카드가 준비됐어요", pre: "선물 링크가 이 메일에 있어요.",
    body: "구매해 주셔서 감사합니다. 아래 선물 링크를 받는 분께 보내세요(직접 열어도 돼요). 받는 분이 카드를 풀고 코드를 긁어요 — 진짜 카드처럼.",
    button: "선물 열기", backup: "혹시 몰라서 — plately.eu/redeem에 직접 입력할 수 있는 카드 코드:", plan: "카드", days: "일",
    foot: "코드는 어떤 Plately 계정에서든 한 번만 쓸 수 있어요. 도움말: plately.eu/help — 이 주소는 답장을 받지 않아요." },
};

export function giftPurchaseEmail({ link, code, plan, days, lang }) {
  const t = GIFT_MAIL[lang] || GIFT_MAIL.en;
  const locale = lang === "pl" ? "pl" : "en";
  const planName = plan === "ultra" ? "Ultra" : "Premium";
  return {
    subject: t.subject,
    ...renderEmail({
      locale,
      title: t.title,
      accentLabel: "Gift card",
      preheader: t.pre,
      blocks: [
        block.text(t.body),
        block.button(t.button, link, locale),
        block.facts([[t.plan, `${planName} · ${days} ${t.days}`], ["Link", link]], locale),
        block.quote(t.backup, code),
      ],
      footer: [t.foot],
    }),
  };
}
