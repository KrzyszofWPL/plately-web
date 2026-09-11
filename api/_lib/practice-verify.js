// ---------------------------------------------------------------------------
// Practice verification — the automatic half of a dietitian's sign-up
//
// Three steps, in order, each with its own verdict, and NOT ONE OF THEM NEEDS
// AN API KEY OR A CARD. Every source is a public register or the practice's
// own infrastructure. The order is the point: nothing past step one runs
// until step one has passed, so a practice that has not yet proven its domain
// is not also being looked up in registries and filed as a ticket — it is
// waiting on a TXT record, and the screen says exactly that.
//
//   1. DOMAIN — who controls the practice's domain. One of the two:
//        email_domain  signed in with Google using a mailbox on the practice's
//                      own domain. Google verified the mailbox; a mailbox on a
//                      domain only exists if one controls the domain. Public
//                      providers (Gmail, wp.pl…) prove nothing.
//        domain_txt    a `plately-verify=<token>` TXT record on the website's
//                      domain, read over DNS-over-HTTPS. No DNS library.
//      Until this passes: state stays `unverified`, no ticket. The dietitian
//      can ask for a person instead (the panel has a button for it).
//
//   2. COMPANY — the legal entity exists, by VAT number:
//        PL   the Ministry of Finance "wykaz podatników VAT" (wl-api.mf.gov.pl):
//             name, status (czynny / zwolniony), REGON, KRS. Free, no key,
//             100 lookups a day per IP — plenty for registrations.
//        EU   VIES, the Commission's register. Free, no key, EU-wide. For a
//             Polish number VIES is the fallback: it lists only businesses
//             registered for intra-EU trade, which small practices are not.
//      No number, or a number outside the EU → "skipped", a person decides.
//      Both registers drop out for minutes at a time, so "could not reach it"
//      is its own verdict, never a failure held against the practice.
//
//   3. PRESENCE — the practice is established, read off what it already has:
//        site      GET https://<domain>: answers, is HTML, is about nutrition
//                  or health (word list below), and names the practice.
//        age       domain registration date over RDAP (IANA's replacement
//                  for WHOIS; .pl serves it at rdap.dns.pl since 2025). At
//                  least MIN_DOMAIN_AGE_DAYS old. A practice that has run for
//                  years has a domain that has run for years; a domain bought
//                  last week is exactly what a stranger after patient data
//                  would show up with.
//
//   AUTO-PASS = all three passed. Anything short after step one goes to the
//   help desk as a ticket with the per-step summary, and the dietitian can
//   re-run the checks (added the VAT number, fixed the site) — a later pass
//   closes the ticket.
//
// What is deliberately NOT here: Google Places (a billing account with a card
// is mandatory even inside its free quota) and Google Business Profile
// (access on application, over weeks, plus an OAuth grant into the practice's
// Google account per registration). The sources above give the same answer
// — "this is a real, established practice" — with nothing to sign up for.
// ---------------------------------------------------------------------------

import { domainOf, isPublicMailDomain, normaliseDomain, domainsMatch } from "./domain-rules.js";

/** How old the domain must be before a practice counts as established. */
export const MIN_DOMAIN_AGE_DAYS = 365;
/** Re-checks allowed per hour, per practice. */
export const MAX_RECHECKS_PER_HOUR = 10;
export const TXT_PREFIX = "plately-verify=";
/** How much of a page is read when looking for the practice on it. */
const SITE_READ_LIMIT = 200_000;

/**
 * Words that make a page "about nutrition or health". Matched against the
 * page's text, case-insensitively, as prefixes — `dietety` catches dietetyk,
 * dietetyczka, dietetyczny. Deliberately wide: a physiotherapy clinic with a
 * dietitian on staff is a practice too. What this rejects is a web shop or
 * a parked domain.
 */
export const WELLNESS_WORDS = [
  "dietety", "dieta", "diet", "żywieni", "zywieni", "odchudzan", "odżywian", "odzywian",
  "nutrition", "nutritionist", "dietitian", "dietician", "ernährung", "ernahrung", "diät",
  "wellness", "fitness", "gabinet", "klinik", "clinic", "przychodni", "zdrow", "health",
  "trener", "coach", "fizjoterap", "physiother", "medyc", "medical", "lekarz",
];

/**
 * Member states VIES answers for. Greece is `EL` there, not `GR`; Northern
 * Ireland kept `XI` after Brexit. Anything else is not checkable here.
 */
export const VIES_COUNTRIES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR",
  "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI",
  "SK", "XI",
]);

/** The three steps and the verdicts a step can carry. */
export const STEPS = ["domain", "company", "presence"];
export const VERDICT = {
  PASSED: "passed",
  PENDING: "pending",         // domain only: waiting on the TXT record
  FAILED: "failed",
  SKIPPED: "skipped",         // not checkable: no VAT number, number outside the EU
  UNAVAILABLE: "unavailable", // a register did not answer; retry later
  WAITING: "waiting",         // gated behind an earlier step
};

// --- pure --------------------------------------------------------------------

/**
 * TXT records out of a DNS-over-HTTPS answer (Google/Cloudflare shape).
 * Values arrive quoted, sometimes split (`"abc" "def"` for long records) —
 * join and strip.
 */
export function parseTxtRecords(doh) {
  const answers = Array.isArray(doh?.Answer) ? doh.Answer : [];
  return answers
    .filter((a) => a && (a.type === 16 || a.type === "TXT"))
    .map((a) => String(a.data || "").replace(/"\s+"/g, "").replace(/^"|"$/g, "").trim())
    .filter((s) => s.length > 0);
}

export function txtProvesOwnership(records, token) {
  if (!token) return false;
  const wanted = (TXT_PREFIX + token).toLowerCase();
  return records.some((r) => r.toLowerCase() === wanted);
}

/**
 * A VAT number as typed → `{ country, number, inVies }`, or null when it is
 * not a VAT number at all. Accepts the country prefix in the number
 * ("PL 123-456-78-90") or from the form's country field ("1234567890" + PL);
 * the prefix wins when both are present, since it is the more deliberate
 * input. Separators people type — spaces, dots, dashes, slashes — are noise.
 */
export function normaliseVat(input, country) {
  let raw = String(input || "").toUpperCase().replace(/[\s./\-]/g, "");
  if (!raw) return null;
  let cc = String(country || "").toUpperCase().slice(0, 2);
  const m = raw.match(/^([A-Z]{2})([A-Z0-9+*]+)$/);
  if (m) { cc = m[1]; raw = m[2]; }
  if (cc === "GR") cc = "EL";
  if (!/^[A-Z]{2}$/.test(cc) || !/^[A-Z0-9+*]{2,12}$/.test(raw)) return null;
  return { country: cc, number: raw, inVies: VIES_COUNTRIES.has(cc) };
}

/** A Polish NIP is ten digits with a valid weighted checksum. */
export function isValidNip(number) {
  const d = String(number || "");
  if (!/^\d{10}$/.test(d)) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(d[i]), 0);
  return sum % 11 === Number(d[9]);
}

const dash = (s) => { const v = String(s ?? "").trim(); return !v || /^-+$/.test(v) ? null : v; };

/**
 * A VIES answer → the company verdict. Pure, so the mapping of VIES's error
 * vocabulary to "failed" versus "try later" can be tested without the
 * network. `valid: false` with INVALID means the register was consulted and
 * the number is not in it; everything else that is not `valid: true` is the
 * register being unreachable, which is VIES's problem, not the practice's.
 */
export function interpretVies(data) {
  const err = String(data?.userError || "").toUpperCase();
  if (data?.valid === true) return { queried: true, valid: true, name: dash(data.name), address: dash(data.address), error: null };
  if (data?.valid === false && (err === "" || err === "INVALID" || err === "VALID" || err === "INVALID_INPUT")) {
    return { queried: true, valid: false, name: null, address: null, error: err || null };
  }
  return { queried: false, valid: null, name: null, address: null, error: err || "unknown" };
}

/**
 * A "wykaz podatników VAT" answer → the company verdict. `subject: null` is
 * the register saying "no such taxpayer". `Czynny` and `Zwolniony` are both
 * real, registered businesses — the difference is a tax status, not an
 * existence question. `Niezarejestrowany` is a number the register knows
 * about but that is not a VAT taxpayer; still a real entity, still a pass.
 */
export function interpretWykaz(data) {
  const subject = data?.result?.subject;
  if (data?.result && subject === null) return { queried: true, valid: false, name: null, address: null, error: null };
  if (!subject || typeof subject !== "object") return { queried: false, valid: null, name: null, address: null, error: data?.code || data?.message || "unknown" };
  return {
    queried: true,
    valid: true,
    name: dash(subject.name),
    address: dash(subject.workingAddress || subject.residenceAddress),
    status: dash(subject.statusVat),
    regon: dash(subject.regon),
    krs: dash(subject.krs),
    registeredSince: dash(subject.registrationLegalDate),
    error: null,
  };
}

/** The `registration` event out of an RDAP domain object, as an ISO date. */
export function registrationDateFrom(rdap) {
  const events = Array.isArray(rdap?.events) ? rdap.events : [];
  const reg = events.find((e) => e && String(e.eventAction || "").toLowerCase() === "registration");
  if (!reg?.eventDate) return null;
  const t = Date.parse(reg.eventDate);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function ageInDays(isoDate, now = Date.now()) {
  if (!isoDate) return null;
  const t = Date.parse(isoDate);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** Letters and digits only, lower-cased, diacritics folded — for fuzzy "is the name on the page". */
export function foldText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0142/g, "l")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "gabinet", "dietetyczny", "dietetyczna", "dietetyk", "dietetyczka", "poradnia", "centrum", "klinika", "clinic",
  "studio", "sp", "z", "o", "oo", "spolka", "sa", "ltd", "gmbh", "the", "and", "i", "of", "dr", "mgr", "lek",
]);

/**
 * What a page says, reduced to the three facts the verdict needs. Pure: takes
 * the HTML string, so a fixture can stand in for a live site in tests.
 *
 * "Names the practice" is fuzzy on purpose. The distinctive tokens of the
 * business name (the ones that are not "gabinet dietetyczny") must appear in
 * the page text; one distinctive token suffices, because "Kowalska" on
 * gabinet-kowalska.pl is the match, and "Gabinet Dietetyczny" alone matches
 * every dietitian in the country.
 */
export function inspectSite(html, businessName) {
  const raw = String(html || "").slice(0, SITE_READ_LIMIT);
  const text = foldText(
    raw.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "),
  );
  const title = dash((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/\s+/g, " "));

  const wellness = WELLNESS_WORDS.some((w) => text.includes(foldText(w)));

  const folded = foldText(businessName);
  const tokens = folded.split(" ").filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  const padded = ` ${text} `;
  // A stem, so "Kowalska" still matches "Kowalskiej" on the page — Polish
  // declines surnames, and a site written in the genitive is the common case.
  const stem = (t) => (t.length >= 6 ? t.slice(0, t.length - 2) : t);
  const mentionsName = tokens.length === 0
    ? folded.length > 0 && padded.includes(` ${folded} `)
    : tokens.some((t) => padded.includes(` ${stem(t)}`));

  return { isHtml: /<html|<body|<head|<div|<p[\s>]/i.test(raw), title, wellness, mentionsName, textLength: text.length };
}

/**
 * The decision, step by step. Returns each step's verdict, the reasons that
 * kept the practice short of auto-pass (they go into the ticket so a person
 * does not check the same things twice), and the verdict itself.
 *
 * Step one gates the rest: with the domain unproven, company and presence
 * are `waiting`, not failed, and the only reason is `domain_unproven`.
 */
export function evaluate(e) {
  const reasons = [];
  const steps = { domain: VERDICT.PENDING, company: VERDICT.WAITING, presence: VERDICT.WAITING };

  if (!e || !e.ownership) {
    reasons.push("domain_unproven");
    return { steps, autopass: false, reasons };
  }
  steps.domain = VERDICT.PASSED;

  const c = e.company;
  if (!c || !c.applicable) {
    steps.company = VERDICT.SKIPPED;
    reasons.push(c && c.reason === "outside_vies" ? "company_outside_vies" : "company_not_given");
  } else if (!c.queried) {
    steps.company = VERDICT.UNAVAILABLE;
    reasons.push("company_registry_unavailable");
  } else if (c.valid) {
    steps.company = VERDICT.PASSED;
  } else {
    steps.company = VERDICT.FAILED;
    reasons.push("company_not_in_register");
  }

  const p = e.presence;
  if (!p) {
    steps.presence = VERDICT.FAILED;
    reasons.push("site_unreachable");
  } else {
    const before = reasons.length;
    if (!p.site || !p.site.reachable) reasons.push("site_unreachable");
    else {
      if (!p.site.wellness) reasons.push("site_not_wellness");
      if (!p.site.mentionsName) reasons.push("site_no_name");
    }
    if (p.domainAgeDays === null || p.domainAgeDays === undefined) reasons.push("domain_age_unknown");
    else if (p.domainAgeDays < MIN_DOMAIN_AGE_DAYS) reasons.push("domain_too_young");
    steps.presence = reasons.length === before ? VERDICT.PASSED : VERDICT.FAILED;
  }

  return { steps, autopass: reasons.length === 0, reasons };
}

/** Evidence summarised for a human in a ticket. Readable, no JSON. */
export function summariseForTicket(row, e) {
  const yes = (b) => (b ? "tak" : "nie");
  const s = e.steps || {};
  const c = e.company || {};
  const p = e.presence || {};
  const registry = c.registry === "wykaz" ? "Wykaz podatników VAT (MF)" : "VIES";
  const company = !c.applicable
    ? (c.reason === "outside_vies" ? `Rejestr: numer spoza UE (${c.country || "?"}) — nie do sprawdzenia automatycznie` : "Rejestr: nie podano numeru VAT")
    : !c.queried
      ? `Rejestr: nie odpowiedział (${c.error || "?"}) — do ponownego sprawdzenia`
      : c.valid
        ? [
            `${registry}: ${c.country}${c.number} — ${c.status || "aktywny"}`,
            `  Nazwa w rejestrze: ${c.name || "(rejestr nie podaje)"}`,
            `  Adres w rejestrze: ${c.address || "(rejestr nie podaje)"}`,
            c.regon ? `  REGON: ${c.regon}${c.krs ? `, KRS: ${c.krs}` : ""}` : null,
            c.registeredSince ? `  W rejestrze VAT od: ${c.registeredSince}` : null,
          ].filter(Boolean).join("\n")
        : `Rejestr: ${c.country}${c.number} — NIE znaleziono (${c.registry === "wykaz" ? "wykaz MF ani VIES" : "VIES"})`;
  return [
    `Gabinet: ${row.business_name}`,
    `Strona: ${row.website || "—"}`,
    `Miasto / kraj: ${row.city || "—"} / ${row.country || "—"}`,
    `Numer VAT z formularza: ${row.vat_number || "—"}`,
    "",
    `1. Domena — ${s.domain || "?"}`,
    `   E-mail konta: ${e.email || "—"} (domena: ${e.emailDomain || "—"})`,
    `   Własność: ${e.ownership ? `potwierdzona (${e.ownership})` : "NIE potwierdzona"}`,
    `   Rekord TXT: ${e.txtChecked ? (e.txtFound ? "znaleziony" : "brak") : "nie sprawdzany"}`,
    "",
    `2. Firma — ${s.company || "?"}`,
    `   ${company.replace(/\n/g, "\n   ")}`,
    "",
    `3. Obecność — ${s.presence || "?"}`,
    p.site
      ? p.site.reachable
        ? [
            `   Strona: odpowiada (${p.site.status})${p.site.title ? ` — „${p.site.title}”` : ""}`,
            `   O żywieniu / zdrowiu: ${yes(p.site.wellness)}, wymienia gabinet: ${yes(p.site.mentionsName)}`,
          ].join("\n")
        : `   Strona: nie odpowiada (${p.site.error || p.site.status || "?"})`
      : "   Strona: nie sprawdzano",
    p.domainRegisteredAt
      ? `   Domena zarejestrowana: ${p.domainRegisteredAt.slice(0, 10)} (${p.domainAgeDays} dni; próg ${MIN_DOMAIN_AGE_DAYS})`
      : `   Wiek domeny: nieznany (${p.rdapError || "RDAP bez odpowiedzi"})`,
    "",
    `Czego zabrakło do automatycznej weryfikacji: ${(e.reasons || []).join(", ") || "—"}`,
    e.manualRequested ? "Dietetyk sam poprosił o weryfikację ręczną (nie może dodać rekordu TXT)." : null,
    `Ponownych sprawdzeń: ${e.rechecks ?? 0}`,
  ].filter((line) => line !== null).join("\n");
}

// --- network -----------------------------------------------------------------

function timeoutSignal(ms) {
  try { return AbortSignal.timeout(ms); } catch { return undefined; }
}

const UA = "Mozilla/5.0 (compatible; PlatelyVerify/1.0; +https://plately.eu/staff)";

async function lookupTxt(domain) {
  const base = process.env.DOH_URL || "https://dns.google/resolve";
  try {
    const res = await fetch(`${base}?name=${encodeURIComponent(domain)}&type=TXT`, {
      headers: { accept: "application/dns-json" },
      signal: timeoutSignal(6000),
    });
    if (!res.ok) return [];
    return parseTxtRecords(await res.json());
  } catch (err) {
    console.error("practice: DoH lookup failed", err?.message || err);
    return [];
  }
}

/**
 * VIES REST. The same call the Commission's own form makes. No key, no
 * quota worth mentioning at this volume, but member-state back ends drop out
 * for minutes at a time — hence a short timeout and an honest "unavailable".
 */
async function lookupVies(vat) {
  try {
    const res = await fetch("https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number", {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ countryCode: vat.country, vatNumber: vat.number }),
      signal: timeoutSignal(8000),
    });
    if (!res.ok) {
      console.error("practice: VIES refused", res.status);
      return { queried: false, valid: null, name: null, address: null, error: `http_${res.status}` };
    }
    return { registry: "vies", ...interpretVies(await res.json()) };
  } catch (err) {
    console.error("practice: VIES lookup failed", err?.message || err);
    return { queried: false, valid: null, name: null, address: null, error: err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "network" };
  }
}

/**
 * Ministry of Finance "wykaz podatników VAT". 100 lookups a day per IP on
 * the `search` method; a 4xx with a `code` is the register speaking (bad
 * NIP, limit hit), which `interpretWykaz` reads as "unavailable" unless it
 * clearly says "no such subject".
 */
async function lookupWykaz(nip) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const res = await fetch(`https://wl-api.mf.gov.pl/api/search/nip/${encodeURIComponent(nip)}?date=${day}`, {
      headers: { accept: "application/json", "user-agent": UA },
      signal: timeoutSignal(8000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      console.error("practice: wykaz refused", res.status, data?.code || "");
      return { queried: false, valid: null, name: null, address: null, error: data?.code || `http_${res.status}` };
    }
    return { registry: "wykaz", ...interpretWykaz(data) };
  } catch (err) {
    console.error("practice: wykaz lookup failed", err?.message || err);
    return { queried: false, valid: null, name: null, address: null, error: err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "network" };
  }
}

/**
 * Step two. Polish numbers go to the MF register first — it knows every VAT
 * taxpayer, VIES only the ones trading across borders — and fall back to
 * VIES when the MF says no or is down. Everyone else in the EU: VIES.
 *
 * A registry answer does not change from hour to hour, so a pass from an
 * earlier run is kept rather than re-asked — the one thing worth re-asking
 * is an outage.
 */
async function checkCompany(row, previous) {
  const vat = normaliseVat(row.vat_number, row.country);
  if (!vat) return { applicable: false, reason: "not_given", queried: false, valid: null };
  if (!vat.inVies) return { applicable: false, reason: "outside_vies", queried: false, valid: null, country: vat.country, number: vat.number };

  const prev = previous?.company;
  if (prev?.applicable && prev.queried && prev.valid === true && prev.country === vat.country && prev.number === vat.number) {
    return prev;
  }

  const base = { applicable: true, country: vat.country, number: vat.number, checkedAt: new Date().toISOString() };

  if (vat.country === "PL" && isValidNip(vat.number)) {
    const wykaz = await lookupWykaz(vat.number);
    if (wykaz.queried && wykaz.valid) return { ...base, ...wykaz };
    const vies = await lookupVies(vat);
    if (vies.queried && vies.valid) return { ...base, ...vies };
    // Neither said yes. "Not found" only when at least one register was
    // actually consulted; two outages are an outage.
    if (wykaz.queried || vies.queried) return { ...base, registry: "wykaz", queried: true, valid: false, name: null, address: null, error: null };
    return { ...base, registry: "wykaz", queried: false, valid: null, name: null, address: null, error: wykaz.error || vies.error };
  }

  return { ...base, ...(await lookupVies(vat)) };
}

/** The practice's own front page, as an ordinary visitor would fetch it. */
async function fetchSite(domain, businessName) {
  for (const scheme of ["https", "http"]) {
    try {
      const res = await fetch(`${scheme}://${domain}/`, {
        headers: { accept: "text/html,*/*;q=0.5", "user-agent": UA, "accept-language": "pl,en;q=0.8" },
        redirect: "follow",
        signal: timeoutSignal(8000),
      });
      const type = res.headers.get("content-type") || "";
      const html = await res.text().catch(() => "");
      const looked = inspectSite(html, businessName);
      const reachable = res.ok && (type.includes("html") || looked.isHtml);
      if (reachable || scheme === "http") {
        return { reachable, status: res.status, scheme, finalHost: normaliseDomain(res.url) || domain, title: looked.title, wellness: looked.wellness, mentionsName: looked.mentionsName, error: reachable ? null : `not_html_or_${res.status}` };
      }
    } catch (err) {
      if (scheme === "http") {
        return { reachable: false, status: 0, scheme, error: err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "network" };
      }
    }
  }
  return { reachable: false, status: 0, error: "unreachable" };
}

/**
 * Domain registration date over RDAP. rdap.org is the community redirector
 * that knows which registry answers for which TLD (it follows IANA's
 * bootstrap file); a registry with no RDAP yields no date, which the verdict
 * reads as "unknown", not "young".
 */
async function lookupRdap(domain) {
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { accept: "application/rdap+json, application/json", "user-agent": UA },
      redirect: "follow",
      signal: timeoutSignal(8000),
    });
    if (!res.ok) return { registeredAt: null, error: `http_${res.status}` };
    const data = await res.json();
    return { registeredAt: registrationDateFrom(data), error: null };
  } catch (err) {
    console.error("practice: RDAP lookup failed", err?.message || err);
    return { registeredAt: null, error: err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "network" };
  }
}

/** Step three: the site and the domain's age, in parallel. */
async function checkPresence(row, claimedDomain) {
  const [site, rdap] = await Promise.all([fetchSite(claimedDomain, row.business_name), lookupRdap(claimedDomain)]);
  return {
    checkedAt: new Date().toISOString(),
    site,
    domainRegisteredAt: rdap.registeredAt,
    domainAgeDays: ageInDays(rdap.registeredAt),
    rdapError: rdap.error,
  };
}

/**
 * Runs the steps in order against a `dietitians` row and returns the
 * evidence. Stops after step one when the domain is unproven — no registry
 * calls, no site fetch, for a practice that is still on the TXT record.
 * `previous` is the last evidence blob: re-check counter, and a company pass
 * worth keeping.
 */
export async function runChecks(row, previous) {
  const claimedDomain = normaliseDomain(row.website);
  const emailDomain = domainOf(row.email);

  let ownership = null;
  if (emailDomain && !isPublicMailDomain(emailDomain) && domainsMatch(emailDomain, claimedDomain)) {
    ownership = "email_domain";
  }

  let txtChecked = false;
  let txtFound = false;
  if (!ownership && claimedDomain && row.domain_token) {
    txtChecked = true;
    txtFound = txtProvesOwnership(await lookupTxt(claimedDomain), row.domain_token);
    if (txtFound) ownership = "domain_txt";
  }

  const evidence = {
    version: 3,
    checkedAt: new Date().toISOString(),
    email: row.email,
    emailDomain,
    claimedDomain,
    ownership,
    txtChecked,
    txtFound,
    company: null,
    presence: null,
    rechecks: (previous?.rechecks ?? 0) + (previous ? 1 : 0),
  };

  if (ownership) {
    const [company, presence] = await Promise.all([checkCompany(row, previous), checkPresence(row, claimedDomain)]);
    evidence.company = company;
    evidence.presence = presence;
  }

  return { ...evidence, ...evaluate(evidence) };
}
