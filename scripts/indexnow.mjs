// ============================================================================
// IndexNow — zglasza adresy z sitemap.xml wprost do wyszukiwarek.
//
// Po co to istnieje
// -----------------
// Google Search Console ma "Prosba o zaindeksowanie", ale jeden adres na raz i
// z dziennym limitem. IndexNow jest protokolem push: jedno zadanie HTTP zglasza
// cala liste, a Bing, Yandex, Seznam i Naver odbieraja ja natychmiast, zamiast
// czekac, az crawler sam wroci. Google IndexNow nie obsluguje — dla Google
// zostaje sitemap i GSC, i to jest w porzadku, bo to nie Google jest tu waskim
// gardlem.
//
// Waskim gardlem jest Bing. Odpowiedzi ChatGPT, Copilota i czesci wynikow
// Perplexity opieraja sie na indeksie Bing, a nowa domena trafia tam wolniej niz
// do Google. Strona, ktorej Bing nie zna, nie moze pojawic sie w tych
// odpowiedziach niezaleznie od tego, jak dobrze jest napisana.
//
//   node scripts/indexnow.mjs           # zglasza wszystkie adresy z sitemapy
//   node scripts/indexnow.mjs --dry-run # pokazuje, co zostaloby zgloszone
//
// Klucz lezy w public/<klucz>.txt i musi byc osiagalny pod tym adresem, bo tak
// wyszukiwarka potwierdza, ze zgloszenie pochodzi od wlasciciela domeny.
// middleware.js trzyma ten plik na liscie ALWAYS_PUBLIC, zeby przerwa
// techniczna nie uniewazniala zgloszen.
//
// Nie wolno tego wolac przy kazdym deployu bez zmiany tresci: zglaszanie
// adresow, ktore sie nie zmienily, jest przez protokol traktowane jak spam i
// konczy sie ignorowaniem klucza.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'www.plately.eu';
const ORIGIN = `https://${HOST}`;
const ENDPOINT = 'https://api.indexnow.org/indexnow';

const dryRun = process.argv.includes('--dry-run');

/** Klucz to nazwa jedynego pliku .txt w public/, ktory wyglada jak klucz. */
function readKey() {
  const files = fs
    .readdirSync(path.join(ROOT, 'public'))
    .filter((f) => /^[0-9a-f]{8,128}\.txt$/i.test(f));

  if (files.length !== 1) {
    throw new Error(
      `public/ zawiera ${files.length} plikow wygladajacych na klucz IndexNow, ` +
        'a ma zawierac dokladnie jeden.'
    );
  }

  const file = files[0];
  const key = file.replace(/\.txt$/i, '');
  const body = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8').trim();

  // Wyszukiwarka pobiera ten plik i porownuje jego tresc z kluczem w zadaniu.
  // Rozjazd oznacza odrzucenie calego zgloszenia, wiec lepiej stanac tutaj.
  if (body !== key) {
    throw new Error(`public/${file} zawiera "${body}", a powinien zawierac "${key}".`);
  }

  return { key, keyLocation: `${ORIGIN}/${file}` };
}

function readSitemapUrls() {
  const xml = fs.readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8');
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());

  if (urls.length === 0) throw new Error('sitemap.xml nie zawiera zadnego <loc>.');

  // Protokol odrzuca cala paczke, jesli choc jeden adres jest z innego hosta.
  const foreign = urls.filter((u) => !u.startsWith(`${ORIGIN}/`) && u !== ORIGIN);
  if (foreign.length) throw new Error(`Adresy spoza ${HOST}: ${foreign.join(', ')}`);

  return urls;
}

const { key, keyLocation } = readKey();
const urlList = readSitemapUrls();

console.log(`IndexNow: ${urlList.length} adresow, klucz ${keyLocation}`);
for (const u of urlList) console.log(`  ${u}`);

if (dryRun) {
  console.log('\n--dry-run: nic nie wyslano.');
  process.exit(0);
}

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key, keyLocation, urlList }),
});

// 200 i 202 to sukces (202 znaczy "przyjete, klucz weryfikujemy asynchronicznie").
// 403 prawie zawsze znaczy, ze plik z kluczem nie jest jeszcze wdrozony — wtedy
// trzeba wdrozyc i powtorzyc, a nie generowac nowy klucz.
const body = await res.text();
console.log(`\n${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);

if (res.status !== 200 && res.status !== 202) {
  if (res.status === 403) {
    console.error(
      `\n403 zwykle znaczy, ze ${keyLocation} nie odpowiada jeszcze 200. ` +
        'Wdroz strone i uruchom to ponownie.'
    );
  }
  process.exit(1);
}
