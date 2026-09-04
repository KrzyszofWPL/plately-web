// ============================================================================
// Generuje sekcję poradnikową: /poradnik (PL) i /guides (EN).
//
// Po co to istnieje
// -----------------
// Witryna miała jedną stronę treści powieloną w dwunastu językach. Dla zapytań
// innych niż sama nazwa marki nie było więc czym rankować: landing odpowiada na
// „czym jest Plately", a nie na „ile wynosi deficyt kaloryczny" — a to drugie
// jest tym, co ludzie wpisują, zanim w ogóle dowiedzą się, że taka aplikacja
// istnieje.
//
// Dwa języki, nie dwanaście. Pięć artykułów razy dwanaście języków to
// sześćdziesiąt stron tekstu, którego nikt nie redagował — dokładnie ten kształt,
// który wytyczne Google nazywają „scaled content abuse". Polski, bo tam jest
// odbiorca, i angielski, bo to język x-default. Reszta może dojść później, jeśli
// będzie kto ją przeczyta.
//
//   node scripts/build-guides.mjs        # samodzielnie
//   node scripts/build-pages.mjs         # woła to jako pierwszy krok
//
// Wejście   content/guides/<klucz>.json  jeden artykuł, obie wersje językowe
//                                        w jednym pliku, żeby hreflang między
//                                        nimi nie mógł się rozjechać
// Wyjście   public/poradnik/<slug>.html  artykuł PL   -> /poradnik/<slug>
//           public/guides/<slug>.html    artykuł EN   -> /guides/<slug>
//           public/poradnik/index.html   spis PL      -> /poradnik
//           public/guides/index.html     spis EN      -> /guides
//
// buildGuides() zwraca listę wpisów do sitemapy — build-pages.mjs ją wstawia,
// żeby sitemap.xml powstawał nadal w jednym miejscu.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://www.plately.eu';
const APP_URL = 'https://app.plately.eu/';
const GUIDE_LANGS = ['pl', 'en'];

// Katalog, pod którym siedzi sekcja w danym języku. Polski nie dostaje prefiksu
// /pl z tego samego powodu, dla którego nie ma go landing: polski jest korzeniem
// tej witryny, a /pl jest w vercel.json trwałym przekierowaniem na /.
const SECTION = { pl: 'poradnik', en: 'guides' };

const SECTION_META = {
  pl: {
    name: 'Poradnik',
    title: 'Poradnik Plately — kalorie, makroskładniki i nawodnienie',
    desc:
      'Praktyczne teksty o liczeniu kalorii, deficycie, makroskładnikach i nawodnieniu. ' +
      'Wzory, liczby i to, czego dziennik żywieniowy nie jest w stanie zmierzyć.',
    home: 'Strona główna',
    onThisPage: 'W tym tekście',
    faqHeading: 'Najczęstsze pytania',
    relatedHeading: 'Czytaj dalej',
    updated: 'Aktualizacja',
    readingTime: (n) => `${n} min czytania`,
    ctaTitle: 'Policz to raz, potem robi się samo',
    ctaBody:
      'Plately rozbija zdjęcie posiłku na kalorie i makroskładniki, pilnuje nawodnienia ' +
      'i prowadzi wykres wagi. Plan Start jest darmowy i nie wymaga karty.',
    ctaButton: 'Otwórz aplikację',
    disclaimer:
      'Ten tekst ma charakter informacyjny i nie jest poradą medyczną. Podane wzory są ' +
      'oszacowaniami dla zdrowych osób dorosłych. Jeśli chorujesz, przyjmujesz leki, jesteś ' +
      'w ciąży albo karmisz piersią — ustal cele z lekarzem lub dietetykiem klinicznym, ' +
      'a nie z kalkulatorem.',
    footerHelp: 'Pomoc',
    footerPrivacy: 'Prywatność',
    footerTerms: 'Regulamin',
    skip: 'Przejdź do treści',
  },
  en: {
    name: 'Guides',
    title: 'Plately guides — calories, macros and hydration',
    desc:
      'Practical writing on calorie counting, deficits, macronutrients and hydration. ' +
      'The formulas, the numbers, and what a food diary cannot measure.',
    home: 'Home',
    onThisPage: 'In this guide',
    faqHeading: 'Common questions',
    relatedHeading: 'Read next',
    updated: 'Updated',
    readingTime: (n) => `${n} min read`,
    ctaTitle: 'Work it out once, then let it run',
    ctaBody:
      'Plately breaks a photo of your meal into calories and macros, keeps an eye on ' +
      'hydration and charts your weight. The Start plan is free and needs no card.',
    ctaButton: 'Open the app',
    disclaimer:
      'This article is informational and is not medical advice. The formulas below are ' +
      'estimates for healthy adults. If you have a medical condition, take medication, are ' +
      'pregnant or are breastfeeding, set your targets with a clinician rather than a calculator.',
    footerHelp: 'Help',
    footerPrivacy: 'Privacy',
    footerTerms: 'Terms',
    skip: 'Skip to content',
  },
};

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

const escText = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
const escJsonLd = (obj) => JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');

// Akapity dopuszczają dokładnie dwa znaczniki: **pogrubienie** i [tekst](/adres).
// Więcej nie jest potrzebne, a każdy dodatkowy to kolejna droga, którą treść
// mogłaby wstrzyknąć znacznik do dokumentu. Adres musi być względny albo https —
// treść nie ma powodu linkować gdzie indziej, a `javascript:` w href to jedyny
// sposób, w jaki ten plik mógłby wykonać cudzy kod.
function inline(s) {
  return escText(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) =>
      /^(https:\/\/|\/)[^"\s]*$/.test(href)
        ? `<a href="${escAttr(href)}">${text}</a>`
        : text
    );
}

// ---------------------------------------------------------------------------
// Wspólna skorupa strony
// ---------------------------------------------------------------------------

// Własny, krótki arkusz zamiast 13 kB z landingu: artykuł potrzebuje typografii
// i niczego więcej, a każdy kilobajt tutaj mnoży się przez liczbę stron.
const CSS = `
*,*::before,*::after{box-sizing:border-box}
html{background:#0a0a0b;-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:#0a0a0b;color:#f4f4f5;font-family:"Inter",ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.6}
a{color:#34d399;text-decoration:none}
a:hover{color:#6ee7b7}
img{max-width:100%;height:auto}
::selection{background:#34d399;color:#04140d}
:focus-visible{outline:2px solid #34d399;outline-offset:3px;border-radius:4px}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.wrap{max-width:760px;margin:0 auto;padding:0 24px}
header.site{border-bottom:1px solid rgba(255,255,255,.07);position:sticky;top:0;background:rgba(10,10,11,.86);backdrop-filter:blur(12px);z-index:10}
header.site .wrap{max-width:1180px;display:flex;align-items:center;justify-content:space-between;gap:16px;height:62px}
.brand{display:flex;align-items:center;gap:11px;color:#f4f4f5;font-weight:600;font-size:17px;letter-spacing:-.01em}
.brand img{width:32px;height:32px;border-radius:10px;border:1px solid rgba(255,255,255,.08);display:block}
.cta-sm{display:inline-flex;align-items:center;gap:7px;background:#34d399;color:#04140d;font-weight:650;font-size:13px;padding:9px 15px;border-radius:999px}
.cta-sm:hover{background:#6ee7b7;color:#04140d}
nav.crumbs{font-size:13px;color:#71717a;padding:26px 0 0}
nav.crumbs a{color:#8a8a92}
nav.crumbs a:hover{color:#34d399}
nav.crumbs span{padding:0 7px;opacity:.5}
article{padding:0 0 20px}
h1{font-size:clamp(31px,4.6vw,46px);line-height:1.12;font-weight:800;letter-spacing:-.03em;margin:20px 0 0;text-wrap:balance}
.meta{margin:18px 0 0;font-size:13px;color:#71717a;display:flex;flex-wrap:wrap;gap:14px}
.lead{margin:24px 0 0;font-size:19px;line-height:1.62;color:#a1a1aa;text-wrap:pretty}
.toc{margin:34px 0 0;padding:20px 22px;border:1px solid rgba(255,255,255,.08);background:#111114;border-radius:16px}
.toc p{margin:0 0 11px;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#71717a}
.toc ol{margin:0;padding-left:20px;font-size:15px;color:#c8c8ce}
.toc li{margin:5px 0}
.toc a{color:#c8c8ce}
.toc a:hover{color:#34d399}
h2{font-size:clamp(22px,2.6vw,28px);line-height:1.24;font-weight:700;letter-spacing:-.02em;margin:46px 0 0;scroll-margin-top:78px;text-wrap:balance}
h3{font-size:18px;line-height:1.34;font-weight:650;margin:30px 0 0;color:#f4f4f5}
p{margin:16px 0 0;font-size:17px;line-height:1.72;color:#c8c8ce;text-wrap:pretty}
ul,ol{margin:16px 0 0;padding-left:22px;font-size:17px;line-height:1.72;color:#c8c8ce}
li{margin:9px 0}
li::marker{color:#34d399}
strong{color:#f4f4f5;font-weight:650}
.note{margin:26px 0 0;padding:18px 20px;border-left:2px solid #34d399;background:#111114;border-radius:0 12px 12px 0}
.note p{margin:0;font-size:15.5px;color:#a1a1aa}
.note p+p{margin-top:11px}
.tablewrap{margin:22px 0 0;overflow-x:auto;border:1px solid rgba(255,255,255,.08);border-radius:14px}
table{border-collapse:collapse;width:100%;min-width:420px;font-size:15px}
th,td{padding:11px 15px;text-align:left;border-bottom:1px solid rgba(255,255,255,.06)}
th{background:#131316;font-weight:600;color:#f4f4f5;font-size:13px;letter-spacing:.02em}
td{color:#c8c8ce}
tr:last-child td{border-bottom:0}
.formula{margin:22px 0 0;padding:16px 20px;background:#111114;border:1px solid rgba(255,255,255,.08);border-radius:14px;font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14.5px;line-height:1.65;color:#e4e4e7;overflow-x:auto;white-space:pre-wrap}
.faq{margin:48px 0 0;border-top:1px solid rgba(255,255,255,.08);padding-top:8px}
details{border-bottom:1px solid rgba(255,255,255,.06);padding:4px 0}
summary{cursor:pointer;padding:16px 0;font-size:16.5px;font-weight:600;color:#f4f4f5;list-style:none;display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
summary::-webkit-details-marker{display:none}
summary::after{content:"+";color:#34d399;font-weight:400;font-size:21px;line-height:1;flex:none;transition:transform .2s}
details[open] summary::after{transform:rotate(45deg)}
details p{margin:0 0 16px;font-size:16px;color:#a1a1aa}
.cta{margin:52px 0 0;padding:30px;border:1px solid rgba(52,211,153,.22);background:radial-gradient(120% 140% at 0% 0%,rgba(52,211,153,.10),transparent 62%),#111114;border-radius:20px}
.cta h2{margin:0;font-size:23px}
.cta p{margin:12px 0 0;font-size:16px}
.cta a.big{margin-top:20px;display:inline-flex;align-items:center;gap:8px;background:#34d399;color:#04140d;font-weight:650;font-size:15px;padding:13px 22px;border-radius:999px}
.cta a.big:hover{background:#6ee7b7;color:#04140d}
.related{margin:50px 0 0}
.related h2{margin:0 0 4px;font-size:19px}
.related a{display:block;margin-top:12px;padding:17px 19px;border:1px solid rgba(255,255,255,.08);background:#111114;border-radius:14px;color:#f4f4f5;font-weight:600;font-size:16px}
.related a:hover{border-color:rgba(52,211,153,.4)}
.related a span{display:block;margin-top:5px;font-weight:400;font-size:14.5px;color:#8a8a92}
.cards{margin:30px 0 0;display:grid;gap:14px}
.cards a{display:block;padding:22px 24px;border:1px solid rgba(255,255,255,.08);background:#111114;border-radius:16px;color:#f4f4f5}
.cards a:hover{border-color:rgba(52,211,153,.4)}
.cards h2{margin:0;font-size:19px;font-weight:650;letter-spacing:-.01em}
.cards p{margin:8px 0 0;font-size:15px;color:#8a8a92}
.disclaimer{margin:44px 0 0;font-size:13.5px;line-height:1.65;color:#71717a}
footer.site{margin-top:70px;border-top:1px solid rgba(255,255,255,.07);padding:26px 0 46px}
footer.site .wrap{max-width:1180px;display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center;justify-content:space-between;font-size:13.5px;color:#71717a}
footer.site nav{display:flex;flex-wrap:wrap;gap:18px}
footer.site a{color:#8a8a92}
footer.site a:hover{color:#34d399}
@media(max-width:620px){.cta{padding:24px 20px}.toc{padding:18px}}
`.trim();

function shell({ lang, m, title, desc, canonical, alternates, jsonLd, body }) {
  const hreflang = alternates
    .map((a) => `<link rel="alternate" hreflang="${a.hreflang}" href="${a.href}">`)
    .join('\n');

  return `<!DOCTYPE html>
<!-- GENERATED by scripts/build-guides.mjs — nie edytuj tego pliku.
     Źródło: content/guides/*.json -->
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<title>${escText(title)}</title>
<meta name="description" content="${escAttr(desc)}">
<link rel="canonical" href="${canonical}">
${hreflang}
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
<meta name="author" content="Plately">
<meta name="theme-color" content="#0a0a0b">
<meta name="color-scheme" content="dark">

<meta property="og:type" content="article">
<meta property="og:site_name" content="Plately">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${escAttr(title)}">
<meta property="og:description" content="${escAttr(desc)}">
<meta property="og:image" content="${ORIGIN}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="${lang === 'pl' ? 'pl_PL' : 'en_US'}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escAttr(title)}">
<meta name="twitter:description" content="${escAttr(desc)}">
<meta name="twitter:image" content="${ORIGIN}/og.png">

<link rel="icon" type="image/png" href="/logo.png">
<link rel="apple-touch-icon" href="/logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

<style>
${CSS}
</style>

<script type="application/ld+json">
${escJsonLd(jsonLd)}
</script>
</head>
<body>
<a href="#tresc" class="sr">${escText(m.skip)}</a>

<header class="site">
  <div class="wrap">
    <a class="brand" href="/">
      <img src="/logo.png" alt="Plately" width="32" height="32">
      Plately
    </a>
    <a class="cta-sm" href="${APP_URL}">${escText(m.ctaButton)}</a>
  </div>
</header>

<main id="tresc">
<div class="wrap">
${body}
</div>
</main>

<footer class="site">
  <div class="wrap">
    <div>&copy; ${new Date().getFullYear()} Plately</div>
    <nav>
      <a href="/">${escText(m.home)}</a>
      <a href="/${SECTION[lang]}">${escText(m.name)}</a>
      <a href="/help">${escText(m.footerHelp)}</a>
      <a href="/privacy">${escText(m.footerPrivacy)}</a>
      <a href="/terms">${escText(m.footerTerms)}</a>
    </nav>
  </div>
</footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Artykuł
// ---------------------------------------------------------------------------

// Sekcje są opisem, nie HTML-em: JSON trzyma treść, a kształt znaczników zostaje
// tutaj. Dzięki temu poprawka w typografii nie wymaga dotykania plików z treścią,
// a treść nie może przypadkiem rozjechać dokumentu.
function renderSection(sec, idx) {
  const parts = [`<h2 id="s${idx}">${inline(sec.h2)}</h2>`];

  for (const block of sec.blocks) {
    if (typeof block === 'string') {
      parts.push(`<p>${inline(block)}</p>`);
    } else if (block.h3) {
      parts.push(`<h3>${inline(block.h3)}</h3>`);
    } else if (block.list) {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.list.map((i) => `  <li>${inline(i)}</li>`).join('\n');
      parts.push(`<${tag}>\n${items}\n</${tag}>`);
    } else if (block.note) {
      parts.push(
        `<div class="note">${block.note.map((p) => `<p>${inline(p)}</p>`).join('')}</div>`
      );
    } else if (block.formula) {
      parts.push(`<div class="formula">${escText(block.formula.join('\n'))}</div>`);
    } else if (block.table) {
      const [head, ...rows] = block.table;
      const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
      const tr = rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('\n      ');
      parts.push(
        `<div class="tablewrap"><table>\n  <thead><tr>${th}</tr></thead>\n  <tbody>\n      ${tr}\n  </tbody>\n</table></div>`
      );
    } else {
      throw new Error(`nieznany typ bloku: ${JSON.stringify(block).slice(0, 80)}`);
    }
  }

  return parts.join('\n');
}

/** Zbiera cały tekst artykułu — do liczenia słów, nie do renderowania. */
function plainWords(a) {
  const out = [a.title, a.lead];

  for (const sec of a.sections) {
    out.push(sec.h2);
    for (const b of sec.blocks) {
      if (typeof b === 'string') out.push(b);
      else if (b.h3) out.push(b.h3);
      else if (b.list) out.push(...b.list);
      else if (b.note) out.push(...b.note);
      else if (b.formula) out.push(...b.formula);
      else if (b.table) out.push(...b.table.flat());
    }
  }

  for (const f of a.faq || []) out.push(f.q, f.a);

  return out.join(' ').trim().split(/\s+/).length;
}

// 200 słów na minutę to ostrożny środek dla polskiego i angielskiego.
const readingMinutes = (words) => Math.max(2, Math.round(words / 200));

const articleUrl = (lang, slug) => `${ORIGIN}/${SECTION[lang]}/${slug}`;

function alternatesFor(all, key) {
  const article = all.find((a) => a.key === key);
  return GUIDE_LANGS.map((l) => ({
    hreflang: l,
    href: articleUrl(l, article[l].slug),
  })).concat({ hreflang: 'x-default', href: articleUrl('en', article.en.slug) });
}

function renderArticle(article, lang, all) {
  const a = article[lang];
  const m = SECTION_META[lang];
  const url = articleUrl(lang, a.slug);
  const words = plainWords(a);

  const toc = a.sections
    .map((s, i) => `    <li><a href="#s${i + 1}">${inline(s.h2)}</a></li>`)
    .join('\n');

  const sections = a.sections.map((s, i) => renderSection(s, i + 1)).join('\n\n');

  const faq = (a.faq || []).length
    ? `<section class="faq">
  <h2 id="faq">${escText(m.faqHeading)}</h2>
${a.faq
  .map(
    (f) =>
      `  <details>\n    <summary>${inline(f.q)}</summary>\n    <p>${inline(f.a)}</p>\n  </details>`
  )
  .join('\n')}
</section>`
    : '';

  // Powiązane teksty są jedynym linkowaniem wewnętrznym, jakie ta sekcja ma.
  // Bez niego każdy artykuł jest ślepym zaułkiem: crawler wchodzi ze sitemapy
  // i nie ma dokąd pójść, a link z artykułu na artykuł jest tym, co przenosi
  // znaczenie między nimi.
  const related = (a.related || [])
    .map((key) => all.find((x) => x.key === key))
    .map(
      (x) =>
        `  <a href="/${SECTION[lang]}/${x[lang].slug}">${escText(x[lang].title)}<span>${escText(
          x[lang].metaDesc
        )}</span></a>`
    )
    .join('\n');

  const body = `<nav class="crumbs" aria-label="${escAttr(m.name)}">
  <a href="/">${escText(m.home)}</a><span>/</span><a href="/${SECTION[lang]}">${escText(m.name)}</a>
</nav>

<article>
<h1>${inline(a.title)}</h1>
<div class="meta">
  <span>${escText(m.updated)}: <time datetime="${a.dateModified}">${a.dateModified}</time></span>
  <span>${escText(m.readingTime(readingMinutes(words)))}</span>
</div>
<p class="lead">${inline(a.lead)}</p>

<div class="toc">
  <p>${escText(m.onThisPage)}</p>
  <ol>
${toc}
  </ol>
</div>

${sections}

${faq}

<div class="cta">
  <h2>${escText(m.ctaTitle)}</h2>
  <p>${escText(m.ctaBody)}</p>
  <a class="big" href="${APP_URL}">${escText(m.ctaButton)} &rarr;</a>
</div>

${related ? `<section class="related">\n  <h2>${escText(m.relatedHeading)}</h2>\n${related}\n</section>` : ''}

<p class="disclaimer">${escText(m.disclaimer)}</p>
</article>`;

  const graph = [
    {
      '@type': 'Article',
      '@id': `${url}#article`,
      headline: a.title,
      description: a.metaDesc,
      inLanguage: lang,
      datePublished: a.datePublished,
      dateModified: a.dateModified,
      wordCount: words,
      mainEntityOfPage: { '@id': `${url}#webpage` },
      // Autorem jest firma, nie wymyślony ekspert. Zmyślona osoba z tytułem
      // naukowym w danych strukturalnych to fałszowanie sygnału E-E-A-T, a nie
      // jego budowanie.
      author: { '@id': `${ORIGIN}/#organization` },
      publisher: { '@id': `${ORIGIN}/#organization` },
      image: `${ORIGIN}/og.png`,
      about: { '@id': `${ORIGIN}/#app` },
    },
    {
      '@type': 'WebPage',
      '@id': `${url}#webpage`,
      url,
      name: a.metaTitle,
      description: a.metaDesc,
      inLanguage: lang,
      isPartOf: { '@id': `${ORIGIN}/#website` },
      breadcrumb: { '@id': `${url}#breadcrumb` },
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${url}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Plately', item: `${ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: m.name, item: `${ORIGIN}/${SECTION[lang]}` },
        { '@type': 'ListItem', position: 3, name: a.title },
      ],
    },
  ];

  if ((a.faq || []).length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: a.faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }

  return {
    url,
    html: shell({
      lang,
      m,
      title: a.metaTitle,
      desc: a.metaDesc,
      canonical: url,
      alternates: alternatesFor(all, article.key),
      jsonLd: { '@context': 'https://schema.org', '@graph': graph },
      body,
    }),
  };
}

// ---------------------------------------------------------------------------
// Spis sekcji
// ---------------------------------------------------------------------------

function indexAlternates() {
  return GUIDE_LANGS.map((l) => ({
    hreflang: l,
    href: `${ORIGIN}/${SECTION[l]}`,
  })).concat({ hreflang: 'x-default', href: `${ORIGIN}/${SECTION.en}` });
}

function renderIndex(lang, all) {
  const m = SECTION_META[lang];
  const url = `${ORIGIN}/${SECTION[lang]}`;

  const cards = all
    .map(
      (x) =>
        `  <a href="/${SECTION[lang]}/${x[lang].slug}">\n    <h2>${escText(
          x[lang].title
        )}</h2>\n    <p>${escText(x[lang].metaDesc)}</p>\n  </a>`
    )
    .join('\n');

  const body = `<nav class="crumbs" aria-label="${escAttr(m.name)}">
  <a href="/">${escText(m.home)}</a><span>/</span>${escText(m.name)}
</nav>

<h1>${escText(m.name)}</h1>
<p class="lead">${escText(m.desc)}</p>

<div class="cards">
${cards}
</div>

<p class="disclaimer">${escText(m.disclaimer)}</p>`;

  const graph = [
    {
      '@type': 'CollectionPage',
      '@id': `${url}#webpage`,
      url,
      name: m.title,
      description: m.desc,
      inLanguage: lang,
      isPartOf: { '@id': `${ORIGIN}/#website` },
      breadcrumb: { '@id': `${url}#breadcrumb` },
      mainEntity: {
        '@type': 'ItemList',
        itemListElement: all.map((x, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: x[lang].title,
          url: articleUrl(lang, x[lang].slug),
        })),
      },
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${url}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Plately', item: `${ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: m.name },
      ],
    },
  ];

  return {
    url,
    html: shell({
      lang,
      m,
      title: m.title,
      desc: m.desc,
      canonical: url,
      alternates: indexAlternates(),
      jsonLd: { '@context': 'https://schema.org', '@graph': graph },
      body,
    }),
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function loadArticles() {
  const dir = path.join(ROOT, 'content', 'guides');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) throw new Error('content/guides/ jest pusty');

  const all = files.map((f) => {
    const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    a._file = `content/guides/${f}`;

    if (a.key !== path.basename(f, '.json')) {
      throw new Error(`${a._file}: key "${a.key}" nie zgadza się z nazwą pliku`);
    }

    for (const lang of GUIDE_LANGS) {
      const v = a[lang];
      if (!v) throw new Error(`${a._file}: brak sekcji "${lang}"`);

      // Slug trafia prosto do ścieżki pliku. Ograniczenie do [a-z0-9-] jest tu
      // zabezpieczeniem, nie estetyką: "../" w slugu zapisałby plik poza public/.
      if (v.slug === 'index') throw new Error(`${a._file} (${lang}): slug "index" koliduje ze spisem sekcji`);
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v.slug || '')) {
        throw new Error(`${a._file}: nieprawidłowy slug "${v.slug}" (${lang})`);
      }
      for (const field of ['title', 'metaTitle', 'metaDesc', 'lead', 'datePublished', 'dateModified']) {
        if (typeof v[field] !== 'string' || !v[field]) {
          throw new Error(`${a._file} (${lang}): brak pola "${field}"`);
        }
      }
      if (!Array.isArray(v.sections) || !v.sections.length) {
        throw new Error(`${a._file} (${lang}): brak sekcji`);
      }
      // Opis dłuższy niż ~160 znaków Google ucina w środku zdania.
      if (v.metaDesc.length > 165) {
        throw new Error(
          `${a._file} (${lang}): metaDesc ma ${v.metaDesc.length} znaków, limit to 165`
        );
      }
    }

    return a;
  });

  // Powiązany artykuł, którego nie ma, zniknąłby po cichu z listy „czytaj dalej" —
  // literówka w kluczu kosztowałaby link, o którym nikt by się nie dowiedział.
  const keys = new Set(all.map((a) => a.key));
  for (const a of all) {
    for (const lang of GUIDE_LANGS) {
      for (const r of a[lang].related || []) {
        if (!keys.has(r)) throw new Error(`${a._file} (${lang}): nieznany related "${r}"`);
        if (r === a.key) throw new Error(`${a._file} (${lang}): related wskazuje sam na siebie`);
      }
    }
  }

  const slugs = new Set();
  for (const a of all) {
    for (const lang of GUIDE_LANGS) {
      const key = `${lang}:${a[lang].slug}`;
      if (slugs.has(key)) throw new Error(`zduplikowany slug ${key}`);
      slugs.add(key);
    }
  }

  return all;
}

export function buildGuides({ quiet = false } = {}) {
  const all = loadArticles();
  const entries = [];

  for (const lang of GUIDE_LANGS) {
    const dir = path.join(ROOT, 'public', SECTION[lang]);
    fs.mkdirSync(dir, { recursive: true });

    for (const article of all) {
      const { url, html } = renderArticle(article, lang, all);
      fs.writeFileSync(path.join(dir, `${article[lang].slug}.html`), html, 'utf8');
      entries.push({
        loc: url,
        lastmod: article[lang].dateModified,
        changefreq: 'monthly',
        priority: '0.7',
        alternates: alternatesFor(all, article.key),
      });
      if (!quiet) {
        console.log(
          `  /${SECTION[lang]}/${article[lang].slug}`.padEnd(44) +
            `${(html.length / 1024).toFixed(1)} kB`
        );
      }
    }

    // public/poradnik/index.html, nie public/poradnik.html: przy cleanUrls oba
    // odpowiadałyby na /poradnik, a który wygra, zależy od kolejności routingu
    // Vercela. Katalog z index.html jest tu jednoznaczny.
    const idx = renderIndex(lang, all);
    fs.writeFileSync(path.join(dir, 'index.html'), idx.html, 'utf8');
    entries.push({
      loc: idx.url,
      lastmod: all.map((a) => a[lang].dateModified).sort().pop(),
      changefreq: 'monthly',
      priority: '0.7',
      alternates: indexAlternates(),
    });
    if (!quiet) {
      console.log(`  /${SECTION[lang]}`.padEnd(44) + `${(idx.html.length / 1024).toFixed(1)} kB`);
    }
  }

  return entries;
}

// Uruchomiony wprost, a nie zaimportowany przez build-pages.mjs.
if (process.argv[1] && path.basename(process.argv[1]) === 'build-guides.mjs') {
  console.log(`\n  ${buildGuides().length} adresów\n`);
}
