import { getSiteMode } from "./lib/site-mode.js";

export const config = {
  // Only the support panel, the API and Vercel's own internals bypass this.
  // Everything else — including robots.txt and sitemap.xml — is decided below,
  // because during maintenance the *status code* matters more than the body and
  // that decision cannot be expressed in a matcher.
  //
  // `admin` is still listed even though the panel moved to /support: the old
  // path is a permanent redirect in vercel.json, and whether a redirect or the
  // middleware sees a request first depends on Vercel's routing order. Leaving
  // it out would mean the one URL the team has bookmarked answers 503 during a
  // maintenance window — which is exactly when they need it.
  matcher: ["/((?!api/|admin|support|_vercel/).*)"],
};

// Files that must answer 200 in every mode.
//
// robots.txt and sitemap.xml are the important ones: if a crawler cannot fetch
// robots.txt it treats the whole host as temporarily un-crawlable, which turns
// a maintenance window into a crawling outage. The rest is what the 503 page
// itself needs in order to render.
const ALWAYS_PUBLIC = new Set([
  "/robots.txt",
  "/sitemap.xml",
  // The help desk. Taking the support channel offline during a maintenance
  // window closes the one door a confused customer has at exactly the moment
  // they are most likely to need it — and the form talks to the API and the
  // database, neither of which is what a maintenance window switches off.
  // Both spellings, because cleanUrls serves help.html at /help and a direct
  // link to the file must not fall through to a 503 either.
  "/help",
  "/help.html",
  // The status page, for the same reason and then some: a maintenance window
  // is the single moment it is most likely to be loaded, and a status page
  // that answers 503 during one has failed at the only job it has. It reads
  // /api/status, which the matcher already excludes, so both halves stay up.
  "/status",
  "/status.html",
  // Same reasoning as robots.txt, for the crawlers that read this instead: a
  // description of the product is not the thing that goes offline during a
  // maintenance window.
  "/llms.txt",
  // Klucz IndexNow. Wyszukiwarka pobiera go, zeby potwierdzic, ze zgloszenie
  // adresow pochodzi od wlasciciela domeny; 503 w tym miejscu uniewaznia cala
  // paczke zgloszen, a przerwa techniczna to dokladnie ten moment, w ktorym
  // najbardziej zalezy nam, zeby crawler wrocil. Nazwa musi zgadzac sie z
  // plikiem w public/ — scripts/indexnow.mjs sprawdza to przy kazdym uruchomieniu.
  "/04228dfae42074cd393583edf0361812.txt",
  "/favicon.ico",
  "/logo.png",
  "/LogoAPK.png",
  "/og.png",
  "/error.css",
  "/error.js",
  "/404.html",
  "/error.html",
  "/maintenance.html",
]);

/** No framework runtime here, so "pass through unmodified" is a raw header. */
function passThrough() {
  return new Response(null, { headers: { "x-middleware-next": "1" } });
}

export default async function middleware(request) {
  const mode = await getSiteMode();
  if (mode !== "maintenance") return passThrough();

  const { pathname } = new URL(request.url);

  // /app to skrot do aplikacji, a nie strona tego serwisu: przekierowanie na
  // app.plately.eu ma zadzialac takze podczas przerwy technicznej, bo strona
  // idzie offline niezaleznie od aplikacji — dokladnie to obiecuje komunikat
  // na stronie 503. Zaleznie od kolejnosci routingu Vercela zdazy to obsluzyc
  // wpis redirects w vercel.json; ten warunek domyka przypadek, w ktorym
  // middleware dostaje zadanie pierwsze.
  if (pathname === "/app" || pathname.startsWith("/app/")) return passThrough();

  if (ALWAYS_PUBLIC.has(pathname)) return passThrough();

  // 503 — not 200, and not 404.
  //
  // This is the whole reason the page was reported as a soft 404 in Search
  // Console: serving the maintenance page with "200 OK" tells Google the URL
  // resolved fine and *this* thin "we're offline" page is the homepage's real
  // content, so Google files it as a soft 404 and drops it from the index.
  // 404 would be worse still — it means "permanently gone".
  //
  // 503 with Retry-After is the one answer that says "the page exists, it is
  // temporarily unavailable, come back later". Google keeps the URL queued and
  // re-crawls instead of downgrading it.
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "retry-after": "3600",
    // The CDN was caching the maintenance page for hours (X-Vercel-Cache: HIT
    // with an Age of ~6h). That would keep serving "offline" to visitors and to
    // Googlebot well after the mode was switched back to live.
    "cache-control": "no-store, must-revalidate",
    "x-robots-tag": "noindex",
  };

  // Read the real file rather than duplicating its markup here — the matcher
  // excludes /maintenance.html from middleware, so this cannot recurse.
  try {
    const res = await fetch(new URL("/maintenance.html", request.url));
    if (res.ok) {
      return new Response(await res.text(), { status: 503, headers });
    }
  } catch {
    // Fall through to the inline body below.
  }

  // Last resort if the static asset is somehow unreachable: the status code is
  // what actually matters to a crawler, so still answer 503 rather than letting
  // the request fall through to a 200.
  return new Response(
    '<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8">' +
      "<title>Plately — przerwa techniczna</title></head>" +
      "<body style=\"background:#0a0a0b;color:#f4f4f5;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px\">" +
      "<div><h1>Przerwa techniczna</h1><p>Strona Plately jest chwilowo niedostępna. Aplikacja działa normalnie.</p></div>" +
      "</body></html>",
    { status: 503, headers }
  );
}
