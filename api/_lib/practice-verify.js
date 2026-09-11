// ---------------------------------------------------------------------------
// Practice verification — the automatic half of a dietitian's sign-up
//
// Three steps, in order, each with its own verdict. The order is the point:
// nothing past step one runs until step one has passed, so a practice that
// has not yet proven its domain is not also being looked up in two registries
// and filed as a ticket — it is simply waiting on a TXT record, and the
// screen says exactly that.
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
//   2. COMPANY — the legal entity exists. The VAT number is checked against
//      VIES, the European Commission's register of VAT-registered businesses.
//      Free, no key, EU-wide; answers with the registered name and address,
//      which the reviewer sees next to what the form claimed. A number
//      outside the EU, or none given, is "skipped" — a person decides.
//      VIES is flaky by reputation, so "could not reach it" is its own
//      verdict, never a failure held against the practice.
//
//   3. PRESENCE — the practice is established. Google Places (New): in Maps,
//      operational, in a wellness category, at least ten reviews, listed
//      website matches. Public data, instant. No key → skipped.
//
//   AUTO-PASS = all three passed. Anything short after step one goes to the
//   help desk as a ticket with the per-step summary, and the dietitian can
//   re-run the checks (added the VAT number, reviews came in) — a later pass
//   closes the ticket.
//
// Google Business Profile API is deliberately absent: Google grants access on
// application, over weeks, and every registration would need an OAuth grant
// into the practice's Google account. VIES + Places give the answer on the
// spot. The Polish MF "biała lista" and CEIDG would add a second registry for
// PL — noted in docs/b2b-dietetycy.md as a later step.
// ---------------------------------------------------------------------------

import { domainOf, isPublicMailDomain, normaliseDomain, domainsMatch } from "./domain-rules.js";

/** Reviews in Maps before a practice counts as established. */
export const MIN_REVIEWS_FOR_AUTOPASS = 10;
/** Re-checks allowed per hour, per practice. */
export const MAX_RECHECKS_PER_HOUR = 10;
export const TXT_PREFIX = "plately-verify=";

/**
 * Places types read as "health / wellness". One hit suffices. Deliberately
 * wide — a Polish dietitian is in Maps as "doctor" as often as "health".
 */
export const WELLNESS_TYPES = new Set([
  "health", "doctor", "nutritionist", "dietitian", "wellness_center", "gym",
  "fitness_center", "spa", "physiotherapist", "medical_clinic", "hospital",
  "sports_club", "sports_complex", "yoga_studio", "pilates_studio",
  "weight_loss_service", "medical_center", "consultant",
]);

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
  SKIPPED: "skipped",         // not checkable: no VAT number, no Places key
  UNAVAILABLE: "unavailable", // registry did not answer; retry later
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

/**
 * A VIES answer → the company verdict. Pure, so the mapping of VIES's error
 * vocabulary to "failed" versus "try later" can be tested without the
 * network. `valid: false` with INVALID means the register was consulted and
 * the number is not in it; everything else that is not `valid: true` is the
 * register being unreachable, which is VIES's problem, not the practice's.
 */
export function interpretVies(data) {
  const dash = (s) => { const v = String(s ?? "").trim(); return !v || /^-+$/.test(v) ? null : v; };
  const err = String(data?.userError || "").toUpperCase();
  if (data?.valid === true) return { queried: true, valid: true, name: dash(data.name), address: dash(data.address), error: null };
  if (data?.valid === false && (err === "" || err === "INVALID" || err === "VALID" || err === "INVALID_INPUT")) {
    return { queried: true, valid: false, name: null, address: null, error: err || null };
  }
  return { queried: false, valid: null, name: null, address: null, error: err || "unknown" };
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
    reasons.push("company_not_in_vies");
  }

  const p = e.places;
  if (!p || !p.queried) {
    steps.presence = VERDICT.SKIPPED;
    reasons.push("places_not_queried");
  } else if (!p.found) {
    steps.presence = VERDICT.FAILED;
    reasons.push("places_not_found");
  } else {
    const before = reasons.length;
    if (!p.operational) reasons.push("places_not_operational");
    if (!p.wellness) reasons.push("places_not_wellness");
    if ((p.reviews ?? 0) < MIN_REVIEWS_FOR_AUTOPASS) reasons.push("places_too_few_reviews");
    if (!p.websiteMatches) reasons.push("places_website_mismatch");
    steps.presence = reasons.length === before ? VERDICT.PASSED : VERDICT.FAILED;
  }

  return { steps, autopass: reasons.length === 0, reasons };
}

/** Evidence summarised for a human in a ticket. Readable, no JSON. */
export function summariseForTicket(row, e) {
  const yes = (b) => (b ? "tak" : "nie");
  const s = e.steps || {};
  const c = e.company || {};
  const p = e.places || {};
  const company = !c.applicable
    ? (c.reason === "outside_vies" ? `VIES: numer spoza UE (${c.country || "?"}) — nie do sprawdzenia automatycznie` : "VIES: nie podano numeru VAT")
    : !c.queried
      ? `VIES: rejestr nie odpowiedział (${c.error || "?"}) — do ponownego sprawdzenia`
      : c.valid
        ? [
            `VIES: ${c.country}${c.number} — aktywny`,
            `  Nazwa w rejestrze: ${c.name || "(rejestr nie podaje)"}`,
            `  Adres w rejestrze: ${c.address || "(rejestr nie podaje)"}`,
          ].join("\n")
        : `VIES: ${c.country}${c.number} — NIE znaleziono w rejestrze VAT UE`;
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
    p.queried
      ? p.found
        ? [
            `   Google Maps: znaleziono — ${p.name || "?"}`,
            `   Adres: ${p.address || "—"}`,
            `   Działa: ${yes(p.operational)}, branża wellness: ${yes(p.wellness)}`,
            `   Opinie: ${p.reviews ?? 0}, strona w Maps: ${p.websiteHost || "—"} (zgodna: ${yes(p.websiteMatches)})`,
            `   Typy: ${(p.types || []).join(", ") || "—"}`,
          ].join("\n")
        : "   Google Maps: nie znaleziono firmy o tej nazwie w tym mieście"
      : "   Google Maps: nie sprawdzano (brak klucza Places)",
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
    return interpretVies(await res.json());
  } catch (err) {
    console.error("practice: VIES lookup failed", err?.message || err);
    return { queried: false, valid: null, name: null, address: null, error: err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "network" };
  }
}

/**
 * Step two. A registry answer does not change from hour to hour, so a pass
 * from an earlier run is kept rather than re-asked — the one thing worth
 * re-asking is an outage.
 */
async function checkCompany(row, previous) {
  const vat = normaliseVat(row.vat_number, row.country);
  if (!vat) return { applicable: false, reason: "not_given", queried: false, valid: null };
  if (!vat.inVies) return { applicable: false, reason: "outside_vies", queried: false, valid: null, country: vat.country, number: vat.number };

  const prev = previous?.company;
  if (prev?.applicable && prev.queried && prev.valid === true && prev.country === vat.country && prev.number === vat.number) {
    return prev;
  }

  const answer = await lookupVies(vat);
  return { applicable: true, country: vat.country, number: vat.number, checkedAt: new Date().toISOString(), ...answer };
}

async function lookupPlaces(businessName, city, country, claimedDomain) {
  const key = process.env.GOOGLE_PLACES_API_KEY || "";
  if (!key) return { queried: false, found: false };
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.types,places.businessStatus,places.userRatingCount,places.websiteUri,places.formattedAddress",
      },
      body: JSON.stringify({
        textQuery: [businessName, city, country].filter(Boolean).join(" "),
        maxResultCount: 3,
        languageCode: "pl",
      }),
      signal: timeoutSignal(8000),
    });
    if (!res.ok) {
      console.error("practice: Places refused", res.status, await res.text().catch(() => ""));
      return { queried: true, found: false };
    }
    const data = await res.json();
    const place = (data?.places || [])[0];
    if (!place) return { queried: true, found: false };

    const types = Array.isArray(place.types) ? place.types : [];
    const websiteHost = normaliseDomain(place.websiteUri);
    return {
      queried: true,
      found: true,
      placeId: place.id,
      name: place.displayName?.text,
      address: place.formattedAddress,
      operational: place.businessStatus === "OPERATIONAL",
      types,
      wellness: types.some((t) => WELLNESS_TYPES.has(t)),
      reviews: Number(place.userRatingCount || 0),
      websiteHost,
      websiteMatches: domainsMatch(websiteHost, claimedDomain),
    };
  } catch (err) {
    console.error("practice: Places lookup failed", err?.message || err);
    return { queried: true, found: false };
  }
}

/**
 * Runs the steps in order against a `dietitians` row and returns the
 * evidence. Stops after step one when the domain is unproven — no registry
 * calls, no Places spend, for a practice that is still on the TXT record.
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
    version: 2,
    checkedAt: new Date().toISOString(),
    email: row.email,
    emailDomain,
    claimedDomain,
    ownership,
    txtChecked,
    txtFound,
    company: null,
    places: null,
    rechecks: (previous?.rechecks ?? 0) + (previous ? 1 : 0),
  };

  if (ownership) {
    const [company, places] = await Promise.all([
      checkCompany(row, previous),
      lookupPlaces(row.business_name, row.city || "", row.country || "", claimedDomain),
    ]);
    evidence.company = company;
    evidence.places = places;
  }

  return { ...evidence, ...evaluate(evidence) };
}
