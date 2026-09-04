// ============================================================================
// Generates one static landing page per language, plus the sitemap.
//
// Why this exists
// ---------------
// The twelve translations were complete long before this script was written,
// but they only ever existed *after* JavaScript ran: one URL, one set of markup,
// text swapped client-side from a dictionary. Googlebot indexes rendered HTML,
// yet hreflang is a relationship between URLs — with a single URL there is
// nothing to relate, so eleven translations were invisible to search. Answer
// engines, which mostly read the raw document, saw even less.
//
// Baking the copy in at build time fixes both, and drops 58 kB of dictionary
// from every visit as a side effect.
//
//   node scripts/build-pages.mjs
//
// Inputs   content/index.template.html   markup + data-i18n keys, Polish inline
//          content/landing-i18n.js       original twelve-language dictionary
//          content/landing-web.js        corrections layered on top of it
//          content/seo/<lang>.json       the prose and FAQ added for search
// Outputs  public/index.html             Polish, at the site root
//          public/<lang>.html            the other eleven, served at /<lang>
//          public/sitemap.xml            every URL with its hreflang alternates,
//                                        plus /terms, /privacy, /help, /status
//
// Editing public/index.html directly is pointless: the next run overwrites it.
// Edit the template or the JSON instead.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://www.plately.eu';

// Polish is the root; every other language is a directory. landing.js and the
// hreflang block below both depend on this shape.
const DEFAULT_LANG = 'pl';
const LANGS = ['pl', 'en', 'de', 'uk', 'ru', 'fr', 'it', 'es', 'pt', 'ja', 'zh', 'ko'];

// x-default is the page served to a language we do not publish. English, not
// Polish: it is the wider fallback, even though Polish holds the root URL.
const X_DEFAULT = 'en';

// Cztery zrzuty w public/, w kolejności, w jakiej panel boczny aplikacji
// wypisuje zakładki. Wymiary to rzeczywisty rozmiar plików: schema.org wymaga,
// żeby width/height zgadzały się z obrazem, inaczej Google odrzuca ImageObject.
const SCREENSHOTS = [
  { file: 'A.png', caption: 'shot1alt' },
  { file: 'B.png', caption: 'shot2alt' },
  { file: 'C.png', caption: 'shot3alt' },
  { file: 'D.png', caption: 'shot4alt' },
];
const SHOT_W = 1919;
const SHOT_H = 1079;

// Krok 1 to logowanie — nie ma czego pokazać. Kroki 2 i 3 kończą się widokiem,
// który faktycznie jest na zrzucie, więc tylko one dostają obraz.
const HOWTO_STEP_IMAGE = { 2: 'A.png', 3: 'B.png' };

// Ceny planów. Jedno źródło prawdy zostaje na kartach cennika w szablonie;
// assertPrices() poniżej przerywa build, jeśli ta tabela się z nimi rozjedzie —
// cena w danych strukturalnych inna niż na stronie to ręczna kara od Google.
const PLANS = [
  { key: 'Free', monthly: '0', yearly: null },
  { key: 'Prem', monthly: '6.99', yearly: '59' },
  { key: 'Ultra', monthly: '12.99', yearly: '119' },
];

const APP_URL = 'https://app.plately.eu/';

// Sygnaly tozsamosci marki. Wspolne dla wszystkich jezykow, wiec nie leza w
// content/seo/<lang>.json tylko obok, w brand.json — plik opisuje sam siebie.
const BRAND = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'content', 'seo', 'brand.json'), 'utf8')
);

// Pola, ktore maja zniknac z grafu, dopoki nikt ich nie wypelnil. Pusta tablica
// sameAs jest gorsza niz jej brak: mowi konsumentowi grafu "sprawdzilem, ta
// marka nie ma zadnych profili", zamiast zostawic pytanie otwarte.
const nonEmpty = (obj) =>
  Object.fromEntries(
    Object.entries(obj).filter(
      ([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0)
    )
  );

const OG_LOCALE = {
  pl: 'pl_PL', en: 'en_US', de: 'de_DE', uk: 'uk_UA', ru: 'ru_RU', fr: 'fr_FR',
  it: 'it_IT', es: 'es_ES', pt: 'pt_PT', ja: 'ja_JP', zh: 'zh_CN', ko: 'ko_KR',
};

// No trailing slash: vercel.json sets trailingSlash:false, so /en/ would 308 to
// /en and every hreflang URL would resolve through a redirect — the exact state
// Search Console reports as "Page with redirect". Each language is emitted as
// public/<lang>.html, which cleanUrls serves at /<lang>, the same mechanism that
// already serves terms.html at /terms.
const pathFor = (lang) => (lang === DEFAULT_LANG ? '/' : `/${lang}`);
const urlFor = (lang) => ORIGIN + pathFor(lang);

// ---------------------------------------------------------------------------
// Dictionary
// ---------------------------------------------------------------------------

// The two dictionary files are browser IIFEs that assign onto `window`. Running
// them in a sandbox is cheaper and less brittle than reparsing them, and it
// applies landing-web.js's corrections in exactly the order the browser did.
function loadDictionary() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);

  for (const file of ['landing-i18n.js', 'landing-web.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'content', file), 'utf8');
    new vm.Script(src, { filename: file }).runInContext(sandbox);
  }

  const dict = sandbox.window.PLATELY_I18N;
  if (!dict) throw new Error('content/landing-*.js did not define window.PLATELY_I18N');

  // The prose and FAQ written for search live in their own files, one per
  // language, so they can be edited without touching the generated blocks.
  for (const lang of LANGS) {
    const file = path.join(ROOT, 'content', 'seo', `${lang}.json`);
    Object.assign(dict[lang], JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  return dict;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

const escText = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escAttr = (s) => escText(s).replace(/"/g, '&quot;');

// `</script` inside a JSON-LD block would close it early. Escaping every `<`
// keeps the JSON valid and the block intact whatever the copy contains.
const escJsonLd = (obj) => JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');

// ---------------------------------------------------------------------------
// Head blocks
// ---------------------------------------------------------------------------

// Karta cennika renderuje t.pr<Key>Price ("$6.99") i t.pr<Key>Sub ("Lub $59
// rocznie."). Jeśli któraś liczba przestanie się w nich pojawiać, PLANS jest
// nieaktualne i build ma stanąć, zamiast opublikować rozbieżny Offer.
function assertPrices(lang, t) {
  for (const { key, monthly, yearly } of PLANS) {
    const shown = t[`pr${key}Price`] || '';
    if (!shown.includes(monthly)) {
      throw new Error(`[${lang}] PLANS.${key}.monthly = ${monthly}, a cennik pokazuje "${shown}"`);
    }
    if (yearly) {
      const sub = t[`pr${key}Sub`] || '';
      if (!sub.includes(yearly)) {
        throw new Error(`[${lang}] PLANS.${key}.yearly = ${yearly}, a cennik pokazuje "${sub}"`);
      }
    }
  }
}

// Odcisk landing.js dopisywany do adresu skryptu.
//
// vercel.json cache'uje .js na godzine, z stale-while-revalidate na dobe, a
// strony HTML na must-revalidate. Po wdrozeniu przegladarka bierze wiec nowy
// dokument i STARY skrypt — dokladnie ta para wygasila przelacznik jezyka, bo
// swiezy HTML nie ladowal juz slownika, ktorego stary landing.js szukal w
// window. Zmiana adresu przy kazdej zmianie tresci pliku sprawia, ze nowy
// dokument prosi o zasob, ktorego nie ma jeszcze w cache, i para nie moze sie
// rozjechac. Dlugie cache'owanie zostaje — to jest jego warunek bezpieczenstwa.
function assetVersion(file) {
  const bytes = fs.readFileSync(path.join(ROOT, 'public', file));
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

function hreflangBlock(eol) {
  const lines = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${l}" href="${urlFor(l)}">`
  );
  lines.push(`<link rel="alternate" hreflang="x-default" href="${urlFor(X_DEFAULT)}">`);
  return lines.join(eol);
}

function jsonLd(lang, t) {
  const url = urlFor(lang);
  assertPrices(lang, t);

  // og.png dostaje @id, bo odwołuje się do niego i WebPage, i aplikacja —
  // jeden węzeł zamiast trzech kopii tego samego obrazu w grafie.
  const ogImage = {
    '@type': 'ImageObject',
    '@id': `${ORIGIN}/#ogimage`,
    url: `${ORIGIN}/og.png`,
    contentUrl: `${ORIGIN}/og.png`,
    width: 1200,
    height: 630,
    caption: t.metaTitle,
  };

  // Zrzuty nie mają @id: podpis jest inny w każdym języku, a @id musi wskazywać
  // jeden byt. Powtórzone w każdym dokumencie osobno są poprawne.
  const shots = SCREENSHOTS.map((s) => ({
    '@type': 'ImageObject',
    url: `${ORIGIN}/${s.file}`,
    contentUrl: `${ORIGIN}/${s.file}`,
    width: SHOT_W,
    height: SHOT_H,
    caption: t[s.caption],
  }));

  // Trzy plany jako osobne Offer wewnątrz AggregateOffer. Sam AggregateOffer
  // podawał tylko widełki 0–12.99, więc Google nie miał skąd wziąć ceny
  // konkretnego planu; referenceQuantity rozróżnia cenę miesięczną od rocznej.
  const offers = PLANS.map(({ key, monthly, yearly }) => {
    const priceSpecification = [
      {
        '@type': 'UnitPriceSpecification',
        price: monthly,
        priceCurrency: 'USD',
        referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON' },
      },
    ];
    if (yearly) {
      priceSpecification.push({
        '@type': 'UnitPriceSpecification',
        price: yearly,
        priceCurrency: 'USD',
        referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'ANN' },
      });
    }
    return {
      '@type': 'Offer',
      name: t[`pr${key}Name`],
      description: t[`pr${key}Desc`],
      price: monthly,
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url: APP_URL,
      priceSpecification,
    };
  });

  const howToSteps = [1, 2, 3].map((n) => {
    const step = {
      '@type': 'HowToStep',
      position: n,
      name: t[`how${n}t`],
      text: t[`how${n}d`],
      url: `${url}#jak-zaczac`,
    };
    if (HOWTO_STEP_IMAGE[n]) step.image = `${ORIGIN}/${HOWTO_STEP_IMAGE[n]}`;
    return step;
  });

  const faq = Array.from({ length: 11 }, (_, i) => i + 1).map((n) => ({
    '@type': 'Question',
    name: t[`q${n}`],
    acceptedAnswer: { '@type': 'Answer', text: t[`a${n}`] },
  }));

  return {
    '@context': 'https://schema.org',
    '@graph': [
      ogImage,
      {
        '@type': 'Organization',
        '@id': `${ORIGIN}/#organization`,
        name: 'Plately',
        // "Plately" nie jest nazwa wolna — w indeksie sa juz plately.io,
        // getplately.com i dwie aplikacje o tej nazwie w sklepach. Sama nazwa
        // nie wskazuje wiec, o ktora firme chodzi; robia to dopiero
        // alternateName i sameAs ponizej.
        ...nonEmpty({ alternateName: BRAND.alternateName }),
        url: ORIGIN + '/',
        logo: {
          '@type': 'ImageObject',
          '@id': `${ORIGIN}/#logo`,
          url: `${ORIGIN}/logo.png`,
          contentUrl: `${ORIGIN}/logo.png`,
          width: 1025,
          height: 1025,
          caption: 'Plately',
        },
        // Organization.logo obsługuje panel wiedzy, ale to image jest tym, po co
        // sięga większość konsumentów grafu — wskazanie tego samego węzła kosztuje
        // jedną linijkę i domyka oba przypadki.
        image: { '@id': `${ORIGIN}/#logo` },
        description: t.metaDesc,
        // sameAs to jedyna deklaracja, ktora Google traktuje jako dowod
        // tozsamosci: profil potwierdza witryne, witryna potwierdza profil.
        // Lista mieszka w content/seo/brand.json i jest pusta do czasu, az
        // ktorys profil naprawde powstanie — patrz komentarz w tamtym pliku.
        ...nonEmpty({ sameAs: BRAND.sameAs, email: BRAND.email }),
        ...(BRAND.email
          ? {
              contactPoint: {
                '@type': 'ContactPoint',
                contactType: 'customer support',
                email: BRAND.email,
                url: `${ORIGIN}/help`,
                availableLanguage: LANGS,
              },
            }
          : {}),
      },
      {
        '@type': 'WebSite',
        '@id': `${ORIGIN}/#website`,
        url: ORIGIN + '/',
        name: 'Plately',
        ...nonEmpty({ alternateName: BRAND.alternateName }),
        publisher: { '@id': `${ORIGIN}/#organization` },
        inLanguage: LANGS,
      },
      {
        '@type': 'WebPage',
        '@id': `${url}#webpage`,
        url,
        name: t.metaTitle,
        description: t.metaDesc,
        isPartOf: { '@id': `${ORIGIN}/#website` },
        about: { '@id': `${ORIGIN}/#app` },
        primaryImageOfPage: { '@id': `${ORIGIN}/#ogimage` },
        // Karta w wynikach bierze obraz stąd. og.png jest pierwszy, bo to on jest
        // przygotowany pod proporcje podglądu; zrzuty idą dalej jako materiał dla
        // Google Images i Discover.
        image: [{ '@id': `${ORIGIN}/#ogimage` }, ...shots],
        inLanguage: lang,
      },
      {
        // One @id for the application across all twelve pages: it is a single
        // product described in twelve languages, not twelve products.
        '@type': 'SoftwareApplication',
        '@id': `${ORIGIN}/#app`,
        name: 'Plately',
        url: 'https://app.plately.eu/',
        applicationCategory: 'HealthApplication',
        applicationSubCategory: 'Nutrition',
        operatingSystem: 'Android, iOS, Windows, macOS, Linux, Web',
        browserRequirements: t.browserReq,
        description: t.metaDesc,
        inLanguage: LANGS,
        publisher: { '@id': `${ORIGIN}/#organization` },
        image: { '@id': `${ORIGIN}/#ogimage` },
        screenshot: shots,
        installUrl: APP_URL,
        // Wpisy w Google Play i App Store, gdy powstana. Dla aplikacji to
        // mocniejszy sygnal tozsamosci niz profil spolecznosciowy: sklep
        // publikuje wydawce, a wydawca wskazuje te domene.
        ...nonEmpty({ sameAs: BRAND.appSameAs }),
        // No aggregateRating. Google's review-snippet guidelines forbid marking
        // up ratings gathered from third-party sites, and inventing them is a
        // manual action waiting to happen. It goes in when there are first-party
        // reviews to report, and not before.
        offers: {
          '@type': 'AggregateOffer',
          priceCurrency: 'USD',
          lowPrice: PLANS[0].monthly,
          highPrice: PLANS[PLANS.length - 1].monthly,
          offerCount: String(PLANS.length),
          availability: 'https://schema.org/InStock',
          offers,
        },
        featureList: [
          t.c1t, t.c2t, t.c3t, t.c4t, t.wLabel, t.coachLabel,
        ].filter(Boolean),
      },
      {
        // HowTo to jeden z niewielu typów, które wciąż dają wynik rozszerzony, i
        // dokładnie ta forma, którą wyszukiwarki AI cytują, gdy ktoś pyta „jak
        // zacząć". Kroki są tym samym tekstem, co sekcja #jak-zaczac na stronie —
        // dane strukturalne opisujące treść, której nie widać, to naruszenie
        // wytycznych, a nie sprytny trik.
        '@type': 'HowTo',
        '@id': `${url}#howto`,
        name: t.howH2,
        description: t.howLead,
        inLanguage: lang,
        isPartOf: { '@id': `${url}#webpage` },
        about: { '@id': `${ORIGIN}/#app` },
        totalTime: 'PT2M',
        image: { '@id': `${ORIGIN}/#ogimage` },
        step: howToSteps,
      },
      {
        // FAQPage rarely earns a rich result any more — Google restricted those
        // to government and health authorities in 2023. It stays because it is
        // still how a machine reads question/answer pairs, which is what answer
        // engines quote.
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        isPartOf: { '@id': `${url}#webpage` },
        inLanguage: lang,
        mainEntity: faq,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function buildPage(template, lang, t) {
  let html = template;

  // --- text nodes -----------------------------------------------------------
  // Every data-i18n element is text-only; a build that meets one which is not
  // must stop rather than quietly leave it in Polish.
  const seen = new Set();
  html = html.replace(
    /(<([a-z0-9]+)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/g,
    (whole, open, _tag, key, _old, close) => {
      seen.add(key);
      const value = t[key];
      if (typeof value !== 'string') return whole; // no translation: keep source
      return open + escText(value) + close;
    }
  );

  // --- alt ------------------------------------------------------------------
  // Lookbehind na bialy znak, nie : granica slowa wypada takze wewnatrz
  // "data-i18n-alt=", wiec /alt="/ podmieniloby klucz zamiast atrybutu.
  // Alt to atrybut, nie węzeł tekstowy, więc pętla wyżej go nie dosięga.
  // data-i18n-alt niesie klucz. Obowiązuje ta sama zasada co przy tekście: brak
  // tłumaczenia przerywa build, bo polski alt na stronie koreańskiej jest gorszy
  // niż jego brak.
  html = html.replace(/<img\b[^>]*\bdata-i18n-alt="([^"]+)"[^>]*>/g, (tag, key) => {
    const value = t[key];
    if (typeof value !== 'string') throw new Error(`[${lang}] brak tłumaczenia alt: ${key}`);
    if (!/(?<=\s)alt="[^"]*"/.test(tag)) throw new Error(`[${lang}] data-i18n-alt="${key}" na <img> bez atrybutu alt`);
    return tag.replace(/(?<=\s)alt="[^"]*"/, `alt="${escAttr(value)}"`);
  });

  const keysInMarkup = new Set(template.match(/data-i18n="([^"]+)"/g)?.map((m) => m.slice(11, -1)));
  const missed = [...keysInMarkup].filter((k) => !seen.has(k));
  if (missed.length) throw new Error(`[${lang}] data-i18n elements not text-only: ${missed.join(', ')}`);

  const untranslated = [...keysInMarkup].filter((k) => typeof t[k] !== 'string');
  if (untranslated.length) throw new Error(`[${lang}] no translation for: ${untranslated.join(', ')}`);

  // --- head -----------------------------------------------------------------
  html = html.replace('<html lang="pl">', `<html lang="${lang}">`);
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escText(t.metaTitle)}</title>`);

  const setMeta = (selectorAttr, name, value) => {
    const re = new RegExp(`(<meta ${selectorAttr}="${name}" content=")[^"]*(">)`);
    if (!re.test(html)) throw new Error(`[${lang}] meta ${name} not found`);
    html = html.replace(re, `$1${escAttr(value)}$2`);
  };

  setMeta('name', 'description', t.metaDesc);
  setMeta('property', 'og:title', t.metaTitle);
  setMeta('property', 'og:description', t.metaDesc);
  setMeta('property', 'og:image:alt', t.metaTitle);
  setMeta('name', 'twitter:title', t.metaTitle);
  setMeta('name', 'twitter:description', t.metaDesc);
  setMeta('name', 'twitter:image:alt', t.metaTitle);

  html = html.replace(
    /<meta property="og:url" content="[^"]*">/,
    `<meta property="og:url" content="${urlFor(lang)}">`
  );
  html = html.replace(
    /<link rel="canonical" href="[^"]*">/,
    `<link rel="canonical" href="${urlFor(lang)}">`
  );

  // og:locale is this page's locale; the alternates are the other eleven.
  //
  // The template ships CRLF, so any pattern spanning a line break has to allow
  // it. A \n-only pattern here matched nothing and silently left og:locale as
  // pl_PL on all twelve pages — hence the explicit failure below rather than a
  // quiet no-op.
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const localeBlock = [`<meta property="og:locale" content="${OG_LOCALE[lang]}">`]
    .concat(
      LANGS.filter((l) => l !== lang).map(
        (l) => `<meta property="og:locale:alternate" content="${OG_LOCALE[l]}">`
      )
    )
    .join(eol);
  const localeRe =
    /<meta property="og:locale" content="[^"]*">\r?\n(?:<meta property="og:locale:alternate" content="[^"]*">\r?\n)*/;
  if (!localeRe.test(html)) throw new Error(`[${lang}] og:locale block not found`);
  html = html.replace(localeRe, localeBlock + eol);

  const scriptRe = /(<script src="\/landing\.js)(\?v=[0-9a-f]+)?(" defer><\/script>)/;
  if (!scriptRe.test(html)) throw new Error(`[${lang}] nie znaleziono <script src="/landing.js">`);
  html = html.replace(scriptRe, `$1?v=${assetVersion('landing.js')}$3`);

  html = html.replace('<!--PLATELY:HREFLANG-->', hreflangBlock(eol));
  html = html.replace(
    '<!--PLATELY:JSONLD-->',
    `<script type="application/ld+json">\n${escJsonLd(jsonLd(lang, t))}\n</script>`
  );

  // --- body -----------------------------------------------------------------
  html = html.replace(
    /(<span id="pl-langcode"[^>]*>)[^<]*(<\/span>)/,
    `$1${lang}$2`
  );
  html = html.replace(
    /(<a href="#tresc" class="pl-sr">)[^<]*(<\/a>)/,
    `$1${escText(t.skipToContent)}$2`
  );

  // After the doctype, not before it: a comment ahead of the doctype is legal
  // but puts older engines into quirks mode, and there is nothing to gain by
  // risking it.
  const banner =
    `<!-- GENERATED by scripts/build-pages.mjs — do not edit.${eol}` +
    `     Source: content/index.template.html + content/seo/${lang}.json -->`;

  return html.replace(/(<!DOCTYPE html>)/i, `$1${eol}${banner}`);
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

// lastmod z daty builda oznaczał, że po każdym deployu wszystkie czternaście
// URL-i twierdziło, że się zmieniło. Google z czasem przestaje ufać takim datom
// i zaczyna je ignorować. Data pochodzi teraz z plików, które faktycznie
// składają się na dany URL.
function lastmodOf(...files) {
  const newest = Math.max(...files.map((f) => fs.statSync(path.join(ROOT, f)).mtimeMs));
  return new Date(newest).toISOString().slice(0, 10);
}

// Wspólne dla każdego języka: szablon i słownik. Zmiana któregokolwiek zmienia
// wszystkie dwanaście stron, więc wszystkie dostają wtedy nową datę.
const SHARED_SOURCES = [
  'content/index.template.html',
  'content/landing-i18n.js',
  'content/landing-web.js',
];

function buildSitemap() {
  const alternates = LANGS.map(
    (l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${urlFor(l)}"/>`
  )
    .concat(
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${urlFor(X_DEFAULT)}"/>`
    )
    .join('\n');

  // Every language page carries the full alternate set, including a self
  // reference — that is what the protocol asks for, and Google drops the whole
  // cluster if the references are not reciprocal.
  const langEntries = LANGS.map(
    (l) => `  <url>
    <loc>${urlFor(l)}</loc>
${alternates}
    <lastmod>${lastmodOf(...SHARED_SOURCES, `content/seo/${l}.json`)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${l === DEFAULT_LANG ? '1.0' : '0.8'}</priority>
  </url>`
  ).join('\n');

  // Terms, privacy, help and status are hand-written pages carrying their own
  // Polish and English inside one URL, so they get no hreflang alternates.
  //
  // Help is listed apart from the small print because it is worth more to a
  // crawler: "how do I contact Plately" is a real query, and the page that
  // answers it should rank rather than sit at the bottom with the small print.
  // "is Plately down" is the same kind of query, which is why /status sits
  // beside it — and it changes daily, so it says so.
  const standalone = [
    { slug: 'terms', changefreq: 'yearly', priority: '0.3' },
    { slug: 'privacy', changefreq: 'yearly', priority: '0.3' },
    { slug: 'help', changefreq: 'monthly', priority: '0.6' },
    { slug: 'status', changefreq: 'daily', priority: '0.5' },
  ]
    .map(
      ({ slug, changefreq, priority }) => `  <url>
    <loc>${ORIGIN}/${slug}</loc>
    <lastmod>${lastmodOf(`public/${slug}.html`)}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${langEntries}
${standalone}
</urlset>
`;
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Redirect sanity
// ---------------------------------------------------------------------------

// A redirect whose destination lands back on a source is an infinite loop, and
// the browser's only symptom is ERR_TOO_MANY_REDIRECTS on a URL that looks
// perfectly reasonable in the config. It shipped exactly once — a careless
// find-and-replace rewrote `/admin -> /support` into `/support -> /support` —
// and cost a deploy. The build refuses to produce another one.
//
// Vercel matches `source` with path-to-regexp and re-enters routing after a
// redirect, so the test is: does any rule's destination match any rule's
// source? Absolute URLs leave the site and are none of our business.
function sourceMatcher(source) {
  const pattern = source
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\/:[A-Za-z0-9_]+\*/g, '(?:/.*)?')  // /:path* — zero or more segments
    .replace(/:[A-Za-z0-9_]+\+/g, '.+')
    .replace(/:[A-Za-z0-9_]+/g, '[^/]+');
  return new RegExp(`^${pattern}$`);
}

function assertNoRedirectLoops() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const rules = (config.redirects || []).filter((r) => !/^https?:\/\//i.test(r.destination));

  const problems = [];
  for (const rule of rules) {
    // Params carry through verbatim, so a concrete stand-in is enough to see
    // where the destination actually lands.
    const landing = rule.destination.replace(/:[A-Za-z0-9_]+[*+]?/g, 'x');
    for (const other of rules) {
      if (sourceMatcher(other.source).test(landing)) {
        problems.push(
          `  ${rule.source} -> ${rule.destination}` +
          (rule.source === other.source
            ? '  (redirects to itself)'
            : `  (lands on the source of ${other.source})`)
        );
        break;
      }
    }
  }

  if (problems.length) {
    throw new Error(
      `vercel.json has ${problems.length} redirect loop(s):\n${problems.join('\n')}\n` +
      'A browser sees these as ERR_TOO_MANY_REDIRECTS.'
    );
  }
  console.log(`  redirects    ${rules.length} local rules, no loops`);
}

function main() {
  assertNoRedirectLoops();

  const template = fs.readFileSync(path.join(ROOT, 'content', 'index.template.html'), 'utf8');
  const dict = loadDictionary();

  for (const lang of LANGS) {
    const t = dict[lang];
    if (!t) throw new Error(`no dictionary entry for ${lang}`);

    const html = buildPage(template, lang, t);
    const outFile = lang === DEFAULT_LANG
      ? path.join(ROOT, 'public', 'index.html')
      : path.join(ROOT, 'public', `${lang}.html`);
    fs.writeFileSync(outFile, html, 'utf8');
    console.log(`  ${pathFor(lang).padEnd(6)} -> ${path.relative(ROOT, outFile).padEnd(20)} ${(html.length / 1024).toFixed(1)} kB`);
  }

  fs.writeFileSync(path.join(ROOT, 'public', 'sitemap.xml'), buildSitemap(), 'utf8');
  // Counted from the file rather than from a total kept in step by hand, which
  // is how it came to be reporting one fewer URL than it had just written.
  const sitemap = fs.readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8');
  console.log(`\n  sitemap.xml  ${(sitemap.match(/<url>/g) || []).length} URLs`);
}

main();
