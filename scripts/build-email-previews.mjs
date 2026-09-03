// ============================================================================
// Renders every message the desk sends into email-templates/, as a file you
// can open in a browser.
//
//   node scripts/build-email-previews.mjs      (or: npm run emails)
//
// Why generate them instead of keeping hand-written mock-ups
// ----------------------------------------------------------
// Because hand-written mock-ups drift. The first pair in this folder had a
// different layout from each other, a logo that was a typographic dingbat, and
// links to plately.app — a domain this project does not own. None of that was
// visible from the sending code, and none of it was wrong when it was written:
// it just stopped matching. A preview that is *derived* from
// api/_lib/email-render.js cannot describe an e-mail we do not send.
//
// Nothing here ships. email-templates/ sits outside public/, so these files are
// a design surface for us, not a route for anybody else. Editing them by hand
// is pointless — the next run overwrites them. Change the renderer instead.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  confirmRequestEmail,
  agentReplyEmail,
  inboundAckEmail,
  lifecycleEmail,
} from '../api/_lib/email-templates.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'email-templates');

// One realistic ticket running through every message, rather than four
// unrelated samples: reading the folder top to bottom should feel like reading
// one conversation, because that is how a customer meets these.
const REF = 'SUP-1042';
const SUBJECT = 'Nie mogę połączyć konta z aplikacją';

const CUSTOMER_MESSAGE =
  'Po wczorajszej aktualizacji aplikacja przestała widzieć moje konto — przy logowaniu ' +
  'dostaję komunikat o nieaktualnej sesji.\n\n' +
  'Próbowałam już wylogować się i zalogować ponownie, bez skutku. Będę wdzięczna za pomoc.';

const AGENT_MESSAGE =
  'Dzień dobry! Już wiem, co się stało.\n\n' +
  'Po wczorajszej aktualizacji klucz połączenia z aplikacją wymagał ponownej synchronizacji — ' +
  'stąd komunikat o nieaktualnej sesji. Zresetowałem to po naszej stronie, więc nic więcej ' +
  'nie musisz robić.\n\n' +
  'Zaloguj się proszę jeszcze raz w aplikacji i daj znać, czy konto już się widzi. Gdyby błąd ' +
  'wrócił, odpowiedz na tego maila — zostaniemy przy tej samej rozmowie.';

// A token shaped like the real thing, so the "paste this address" line under
// the button wraps the way it will in somebody's inbox.
const CONFIRM_URL = 'https://www.plately.eu/api/help/confirm?t=8f2c1ad9b4e711f0a3c25d0e7b41cc92';

// The two filenames the folder started with are kept: they are what anybody
// looking for these previews already has bookmarked.
const PAGES = [
  {
    file: 'support-ticket-received.html',
    render: () =>
      confirmRequestEmail({
        reference: REF,
        subject: SUBJECT,
        category: 'Konto i logowanie',
        body: CUSTOMER_MESSAGE,
        confirmUrl: CONFIRM_URL,
        locale: 'pl',
      }),
  },
  {
    file: 'support-agent-reply.html',
    render: () =>
      agentReplyEmail({
        reference: REF,
        subject: `Re: ${SUBJECT} [${REF}]`,
        body: AGENT_MESSAGE,
        agentName: 'Krzysztof Pawlak',
        agentRole: 'agent',
        agentTier: 2,
        locale: 'pl',
      }),
  },
  {
    file: 'support-inbound-ack.html',
    render: () =>
      inboundAckEmail({
        reference: REF,
        subject: SUBJECT,
        body: CUSTOMER_MESSAGE,
        locale: 'pl',
      }),
  },
  {
    file: 'lifecycle-notice.html',
    render: () =>
      lifecycleEmail({
        title: 'Twoja subskrypcja odnawia się za trzy dni',
        body:
          'Plan Premium odnowi się 6 września i zostanie pobrana opłata 6,99 €. Nic nie musisz ' +
          'robić — piszemy tylko po to, żeby kwota na wyciągu nie była zaskoczeniem.\n\n' +
          'Chcesz zmienić plan albo zrezygnować? Wszystko jest w ustawieniach konta.',
        cta: 'Zarządzaj subskrypcją',
        ctaUrl: 'https://app.plately.eu/settings/billing',
        unsubscribeUrl: 'https://app.plately.eu/settings/email',
        locale: 'pl',
      }),
  },
  // One English message, because the renderer is bilingual and the half nobody
  // looks at is the half that breaks.
  {
    file: 'support-ticket-received.en.html',
    render: () =>
      confirmRequestEmail({
        reference: REF,
        subject: 'I cannot link my account to the app',
        category: 'Account',
        body:
          'Since yesterday\'s update the app stopped seeing my account — signing in gives me ' +
          'a "session out of date" message.\n\n' +
          'I have already signed out and back in, with no luck. Any help appreciated.',
        confirmUrl: CONFIRM_URL,
        locale: 'en',
      }),
  },
];

fs.mkdirSync(OUT, { recursive: true });

// The plain-text alternative goes out with every message and is the version
// spam filters read first, so it is worth being able to see it. One file, all
// four, rather than eight files in the folder.
const textParts = [];

for (const { file, render } of PAGES) {
  const { subject, html, text } = render();
  const banner =
    `<!-- Generated by scripts/build-email-previews.mjs — do not edit.\n` +
    `     Source: api/_lib/email-render.js + api/_lib/email-templates.js\n` +
    `     Subject: ${subject} -->\n`;
  fs.writeFileSync(path.join(OUT, file), banner + html + '\n', 'utf8');
  textParts.push(`=== ${file}\n=== Temat: ${subject}\n\n${text}\n`);
  console.log(`  ${file.padEnd(34)} ${String(html.length).padStart(6)} B   ${subject}`);
}

fs.writeFileSync(path.join(OUT, 'plain-text-versions.txt'), textParts.join('\n\n'), 'utf8');
console.log(`  plain-text-versions.txt            ${PAGES.length} messages`);
