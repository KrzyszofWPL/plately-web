// ---------------------------------------------------------------------------
// Practice verification — the automatic half of a dietitian's sign-up
//
// Three signals, two decisions:
//
//   DOMAIN OWNERSHIP — one of the two, required:
//     email_domain  the dietitian signed in with Google using a mailbox on the
//                   practice's own domain. Google verified that mailbox, and a
//                   mailbox on one's own domain only exists if one controls the
//                   domain. Gmail and other public providers prove nothing.
//     domain_txt    a `plately-verify=<token>` TXT record on the website's
//                   domain, looked up over DNS-over-HTTPS. No DNS library.
//
//   SIZE AND TRADE — Google Places (New). Public data, instant. The business
//     is in Maps, operational, in a wellness category, with at least ten
//     reviews, and its listed website matches the one claimed. Proves nothing
//     about ownership — proves the practice exists and did not appear
//     yesterday.
//
//   AUTO-PASS = ownership + Places, all of it. Anything short goes to the help
//   desk as a ticket. No Places key degrades to "everything by hand", not to
//   an error.
//
// Google Business Profile API is deliberately absent: Google grants access to
// it on application, over weeks, and every registration would need an OAuth
// grant into the practice's Google account. The signals above give the same
// answer on the spot.
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
 * The decision. `verified` only when ownership is proven AND Places confirms
 * an established practice in the trade. `reasons` says what fell short — that
 * goes into the ticket so a person does not check it twice.
 */
export function scoreVerification(e) {
  const reasons = [];
  if (!e.ownership) reasons.push("ownership_unproven");
  if (!e.places || !e.places.queried) reasons.push("places_not_queried");
  else if (!e.places.found) reasons.push("places_not_found");
  else {
    if (!e.places.operational) reasons.push("places_not_operational");
    if (!e.places.wellness) reasons.push("places_not_wellness");
    if ((e.places.reviews ?? 0) < MIN_REVIEWS_FOR_AUTOPASS) reasons.push("places_too_few_reviews");
    if (!e.places.websiteMatches) reasons.push("places_website_mismatch");
  }
  return { autopass: reasons.length === 0, reasons };
}

/** Evidence summarised for a human in a ticket. Readable, no JSON. */
export function summariseForTicket(row, e) {
  const yes = (b) => (b ? "tak" : "nie");
  const p = e.places || {};
  return [
    `Gabinet: ${row.business_name}`,
    `Strona: ${row.website || "—"}`,
    `Miasto / kraj: ${row.city || "—"} / ${row.country || "—"}`,
    "",
    `E-mail konta: ${e.email || "—"} (domena: ${e.emailDomain || "—"})`,
    `Własność domeny: ${e.ownership ? `potwierdzona (${e.ownership})` : "NIE potwierdzona"}`,
    `Rekord TXT: ${e.txtChecked ? (e.txtFound ? "znaleziony" : "brak") : "nie sprawdzany"}`,
    "",
    p.queried
      ? p.found
        ? [
            `Google Maps: znaleziono — ${p.name || "?"}`,
            `  Adres: ${p.address || "—"}`,
            `  Działa: ${yes(p.operational)}, branża wellness: ${yes(p.wellness)}`,
            `  Opinie: ${p.reviews ?? 0}, strona w Maps: ${p.websiteHost || "—"} (zgodna: ${yes(p.websiteMatches)})`,
            `  Typy: ${(p.types || []).join(", ") || "—"}`,
          ].join("\n")
        : "Google Maps: nie znaleziono firmy o tej nazwie w tym mieście"
      : "Google Maps: nie sprawdzano (brak klucza Places)",
    "",
    `Czego zabrakło do automatycznej weryfikacji: ${(e.reasons || []).join(", ") || "—"}`,
    `Ponownych sprawdzeń: ${e.rechecks ?? 0}`,
  ].join("\n");
}

// --- network -----------------------------------------------------------------

async function lookupTxt(domain) {
  const base = process.env.DOH_URL || "https://dns.google/resolve";
  try {
    const res = await fetch(`${base}?name=${encodeURIComponent(domain)}&type=TXT`, {
      headers: { accept: "application/dns-json" },
    });
    if (!res.ok) return [];
    return parseTxtRecords(await res.json());
  } catch (err) {
    console.error("practice: DoH lookup failed", err?.message || err);
    return [];
  }
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
 * Runs every check against a `dietitians` row and returns the evidence.
 * `previous` is the last evidence blob, for the re-check counter.
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

  const places = await lookupPlaces(row.business_name, row.city || "", row.country || "", claimedDomain);

  const partial = {
    checkedAt: new Date().toISOString(),
    email: row.email,
    emailDomain,
    claimedDomain,
    ownership,
    txtChecked,
    txtFound,
    places,
    rechecks: (previous?.rechecks ?? 0) + (previous ? 1 : 0),
  };
  const { autopass, reasons } = scoreVerification(partial);
  return { ...partial, autopass, reasons };
}
