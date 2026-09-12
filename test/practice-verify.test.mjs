// ---------------------------------------------------------------------------
// Practice verification — the rules that decide who sees other people's
// health data.
//
// The silent failures these guard against: an auto-pass that lets a practice
// through without proven domain ownership; a domain match that takes
// `gabinet.pl.evil.com` for `gabinet.pl`; a register outage read as "this
// company does not exist"; a week-old domain read as an established practice.
// None of them throws — a stranger simply sees a panel with real patients in
// it, or an honest practice is told it is not real. Pure functions only;
// nothing here touches the network or the database.
//
//   npm test        (node --test, nothing to install)
// ---------------------------------------------------------------------------

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { domainOf, isPublicMailDomain, normaliseDomain, domainsMatch } from "../api/_lib/domain-rules.js";
import { parseTxtRecords, txtProvesOwnership, evaluate, normaliseVat, isValidNip, interpretVies, interpretWykaz, registrationDateFrom, ageInDays, inspectSite, MIN_DOMAIN_AGE_DAYS, TXT_PREFIX } from "../api/_lib/practice-verify.js";

describe("domainOf / isPublicMailDomain", () => {
  test("extracts the domain, lower-cased", () => {
    assert.equal(domainOf("Anna@Gabinet-X.PL"), "gabinet-x.pl");
  });
  test("rejects addresses without a domain", () => {
    assert.equal(domainOf("anna"), null);
    assert.equal(domainOf("anna@localhost"), null);
    assert.equal(domainOf(""), null);
    assert.equal(domainOf(null), null);
  });
  test("knows public providers on both sides of the line", () => {
    assert.equal(isPublicMailDomain("gmail.com"), true);
    assert.equal(isPublicMailDomain("wp.pl"), true);
    assert.equal(isPublicMailDomain("gabinet-x.pl"), false);
    assert.equal(isPublicMailDomain(null), false);
  });
});

describe("normaliseDomain", () => {
  test("strips scheme, www, path, port and case", () => {
    assert.equal(normaliseDomain("https://www.Gabinet-X.pl/kontakt?x=1#top"), "gabinet-x.pl");
    assert.equal(normaliseDomain("gabinet-x.pl:8080"), "gabinet-x.pl");
    assert.equal(normaliseDomain("  gabinet-x.pl  "), "gabinet-x.pl");
  });
  test("keeps subdomains other than www — they are other domains", () => {
    assert.equal(normaliseDomain("sklep.gabinet-x.pl"), "sklep.gabinet-x.pl");
  });
  test("rejects what is not a domain", () => {
    assert.equal(normaliseDomain("gabinet"), null);
    assert.equal(normaliseDomain(""), null);
    assert.equal(normaliseDomain("http://"), null);
  });
});

describe("domainsMatch", () => {
  test("accepts equality and subdomains either way", () => {
    assert.equal(domainsMatch("gabinet.pl", "gabinet.pl"), true);
    assert.equal(domainsMatch("mail.gabinet.pl", "gabinet.pl"), true);
    assert.equal(domainsMatch("gabinet.pl", "www2.gabinet.pl"), true);
  });
  test("is not fooled by a suffix without its dot", () => {
    assert.equal(domainsMatch("gabinet.pl.evil.com", "gabinet.pl"), false);
    assert.equal(domainsMatch("notgabinet.pl", "gabinet.pl"), false);
  });
  test("matches nothing to nothing", () => {
    assert.equal(domainsMatch(null, "gabinet.pl"), false);
    assert.equal(domainsMatch("gabinet.pl", null), false);
  });
});

describe("parseTxtRecords / txtProvesOwnership", () => {
  const doh = {
    Status: 0,
    Answer: [
      { name: "gabinet.pl.", type: 16, data: '"v=spf1 include:_spf.google.com ~all"' },
      { name: "gabinet.pl.", type: 16, data: '"plately-verify=abc123"' },
      { name: "gabinet.pl.", type: 16, data: '"long" "record" "split"' },
      { name: "gabinet.pl.", type: 1, data: "1.2.3.4" },
    ],
  };
  test("unquotes, joins split records and skips non-TXT", () => {
    assert.deepEqual(parseTxtRecords(doh), ["v=spf1 include:_spf.google.com ~all", "plately-verify=abc123", "longrecordsplit"]);
  });
  test("survives an answer without Answer", () => {
    assert.deepEqual(parseTxtRecords({ Status: 3 }), []);
    assert.deepEqual(parseTxtRecords(null), []);
  });
  test("proves ownership only with the exact record", () => {
    const records = parseTxtRecords(doh);
    assert.equal(txtProvesOwnership(records, "abc123"), true);
    assert.equal(txtProvesOwnership(records, "abc124"), false);
    assert.equal(txtProvesOwnership(records, ""), false);
  });
  test("compares case-insensitively, since DNS does not guarantee case", () => {
    assert.equal(txtProvesOwnership([`${TXT_PREFIX.toUpperCase()}ABC123`], "abc123"), true);
  });
});

describe("normaliseVat", () => {
  test("strips separators and takes the country from the prefix", () => {
    assert.deepEqual(normaliseVat("pl 123-456-78-90", "DE"), { country: "PL", number: "1234567890", inVies: true });
  });
  test("falls back to the form country when there is no prefix", () => {
    assert.deepEqual(normaliseVat("1234567890", "pl"), { country: "PL", number: "1234567890", inVies: true });
  });
  test("speaks VIES's dialect: Greece is EL", () => {
    assert.equal(normaliseVat("123456789", "GR").country, "EL");
    assert.equal(normaliseVat("GR123456789", "GR").country, "EL");
  });
  test("knows what it cannot check", () => {
    assert.equal(normaliseVat("GB123456789", "GB").inVies, false);
    assert.equal(normaliseVat("123456789", "US").inVies, false);
  });
  test("rejects what is not a VAT number", () => {
    assert.equal(normaliseVat("", "PL"), null);
    assert.equal(normaliseVat(null, "PL"), null);
    assert.equal(normaliseVat("1", "PL"), null);
    assert.equal(normaliseVat("1234567890", ""), null);
    assert.equal(normaliseVat("PL1234567890123456", "PL"), null);
  });
});

describe("isValidNip", () => {
  test("accepts a NIP with a correct checksum and nothing else", () => {
    assert.equal(isValidNip("5260250274"), true);
    assert.equal(isValidNip("1234567890"), false);
    assert.equal(isValidNip("526025027"), false);
    assert.equal(isValidNip("PL5260250274"), false);
  });
});

describe("interpretVies", () => {
  test("a valid number carries the registered name and address", () => {
    assert.deepEqual(interpretVies({ valid: true, name: "GABINET X SP. Z O.O.", address: "UL. PROSTA 1, 00-001 WARSZAWA" }),
      { queried: true, valid: true, name: "GABINET X SP. Z O.O.", address: "UL. PROSTA 1, 00-001 WARSZAWA", error: null });
  });
  test("a member state that withholds the name yields null, not dashes", () => {
    const r = interpretVies({ valid: true, name: "---", address: "---" });
    assert.equal(r.valid, true);
    assert.equal(r.name, null);
    assert.equal(r.address, null);
  });
  test("INVALID is a consulted register saying no", () => {
    assert.deepEqual(interpretVies({ valid: false, userError: "INVALID" }), { queried: true, valid: false, name: null, address: null, error: "INVALID" });
  });
  test("an outage is NOT a failed practice", () => {
    for (const userError of ["MS_UNAVAILABLE", "TIMEOUT", "SERVICE_UNAVAILABLE", "MS_MAX_CONCURRENT_REQ", "GLOBAL_MAX_CONCURRENT_REQ"]) {
      const r = interpretVies({ valid: false, userError });
      assert.equal(r.queried, false, userError);
      assert.equal(r.valid, null, userError);
    }
    assert.equal(interpretVies(null).queried, false);
  });
});

describe("interpretWykaz (Ministry of Finance VAT register)", () => {
  test("a subject is a real business, with what the reviewer needs", () => {
    const r = interpretWykaz({ result: { subject: { name: "KOWALSKA DIETETYKA SP. Z O.O.", statusVat: "Czynny", regon: "123456789", krs: "0000123456", workingAddress: "UL. PROSTA 1, WARSZAWA", registrationLegalDate: "2015-03-01" } } });
    assert.equal(r.queried, true);
    assert.equal(r.valid, true);
    assert.equal(r.name, "KOWALSKA DIETETYKA SP. Z O.O.");
    assert.equal(r.status, "Czynny");
    assert.equal(r.regon, "123456789");
    assert.equal(r.registeredSince, "2015-03-01");
  });
  test("an exempt taxpayer is still a real business", () => {
    assert.equal(interpretWykaz({ result: { subject: { name: "ANNA KOWALSKA", statusVat: "Zwolniony" } } }).valid, true);
  });
  test("subject: null is the register saying no", () => {
    assert.deepEqual(interpretWykaz({ result: { subject: null } }), { queried: true, valid: false, name: null, address: null, error: null });
  });
  test("an error envelope or garbage is an outage, not a refusal", () => {
    assert.equal(interpretWykaz({ code: "WL-101", message: "limit" }).queried, false);
    assert.equal(interpretWykaz(null).queried, false);
    assert.equal(interpretWykaz({ result: {} }).queried, false);
  });
});

describe("registrationDateFrom / ageInDays (RDAP)", () => {
  const rdap = { events: [{ eventAction: "last changed", eventDate: "2026-01-01T00:00:00Z" }, { eventAction: "registration", eventDate: "2019-06-15T10:00:00Z" }] };
  test("picks the registration event, whatever its position", () => {
    assert.equal(registrationDateFrom(rdap), "2019-06-15T10:00:00.000Z");
  });
  test("no registration event, no date", () => {
    assert.equal(registrationDateFrom({ events: [{ eventAction: "expiration", eventDate: "2027-01-01" }] }), null);
    assert.equal(registrationDateFrom(null), null);
  });
  test("age is whole days, never negative", () => {
    const now = Date.parse("2026-09-11T00:00:00Z");
    assert.equal(ageInDays("2026-09-01T00:00:00Z", now), 10);
    assert.equal(ageInDays("2026-09-12T00:00:00Z", now), 0);
    assert.equal(ageInDays(null, now), null);
    assert.equal(ageInDays("not a date", now), null);
  });
});

describe("inspectSite", () => {
  const page = "<html><head><title>Dietetyk Anna Kowalska — Warszawa</title><style>.x{}</style></head><body><script>var dieta='no';</script><h1>Gabinet Anny Kowalskiej</h1><p>Odchudzanie i żywienie kliniczne.</p></body></html>";
  test("reads the title, spots the trade, finds the practice by a declined surname", () => {
    const r = inspectSite(page, "Gabinet Dietetyczny Kowalska");
    assert.equal(r.isHtml, true);
    assert.equal(r.title, "Dietetyk Anna Kowalska — Warszawa");
    assert.equal(r.wellness, true);
    assert.equal(r.mentionsName, true);
  });
  test("generic words alone do not name a practice", () => {
    assert.equal(inspectSite("<html><body>Gabinet dietetyczny w Krakowie</body></html>", "Gabinet Dietetyczny Nowak").mentionsName, false);
  });
  test("a parked domain or a shop is not a practice", () => {
    const r = inspectSite("<html><title>Buy this domain</title><body>This domain is for sale.</body></html>", "Gabinet Kowalska");
    assert.equal(r.wellness, false);
    assert.equal(r.mentionsName, false);
  });
  test("script and style bodies are not page text", () => {
    assert.equal(inspectSite("<html><body><script>dietetyk kowalska</script></body></html>", "Kowalska").mentionsName, false);
  });
  test("folds diacritics both ways", () => {
    assert.equal(inspectSite("<html><body>Poradnia Żywłość Zdrowie</body></html>", "Żywłość").mentionsName, true);
  });
});

describe("evaluate — three steps in order", () => {
  const passedPresence = { site: { reachable: true, wellness: true, mentionsName: true }, domainRegisteredAt: "2015-01-01T00:00:00Z", domainAgeDays: MIN_DOMAIN_AGE_DAYS };
  const passedCompany = { applicable: true, queried: true, valid: true, country: "PL", number: "1234567890", name: "GABINET X", registry: "wykaz" };
  const base = { ownership: "email_domain", company: passedCompany, presence: passedPresence };

  test("passes the full set", () => {
    assert.deepEqual(evaluate(base), { steps: { domain: "passed", company: "passed", presence: "passed" }, autopass: true, reasons: [] });
  });
  test("with the domain unproven nothing else is judged — the later steps wait", () => {
    const r = evaluate({ ...base, ownership: null });
    assert.deepEqual(r, { steps: { domain: "pending", company: "waiting", presence: "waiting" }, autopass: false, reasons: ["domain_unproven"] });
  });
  test("NEVER passes without domain ownership, however perfect the registers look", () => {
    assert.equal(evaluate({ ...base, ownership: null }).autopass, false);
    assert.equal(evaluate(null).autopass, false);
  });
  test("no VAT number: company is skipped and a person decides", () => {
    const r = evaluate({ ...base, company: { applicable: false, reason: "not_given" } });
    assert.equal(r.steps.company, "skipped");
    assert.deepEqual(r.reasons, ["company_not_given"]);
    assert.equal(r.autopass, false);
  });
  test("a number outside the EU is skipped with its own reason", () => {
    const r = evaluate({ ...base, company: { applicable: false, reason: "outside_vies" } });
    assert.equal(r.steps.company, "skipped");
    assert.deepEqual(r.reasons, ["company_outside_vies"]);
  });
  test("the register saying no is a failed step", () => {
    const r = evaluate({ ...base, company: { ...passedCompany, valid: false } });
    assert.equal(r.steps.company, "failed");
    assert.deepEqual(r.reasons, ["company_not_in_register"]);
  });
  test("the register being down is 'unavailable', never 'failed'", () => {
    const r = evaluate({ ...base, company: { ...passedCompany, queried: false, valid: null, error: "MS_UNAVAILABLE" } });
    assert.equal(r.steps.company, "unavailable");
    assert.deepEqual(r.reasons, ["company_registry_unavailable"]);
  });
  test("a site that does not answer fails presence on that alone", () => {
    const r = evaluate({ ...base, presence: { ...passedPresence, site: { reachable: false } } });
    assert.equal(r.steps.presence, "failed");
    assert.deepEqual(r.reasons, ["site_unreachable"]);
  });
  test("lists every presence shortfall separately so the ticket needs no second look", () => {
    const r = evaluate({ ...base, presence: { site: { reachable: true, wellness: false, mentionsName: false }, domainRegisteredAt: "2026-09-01T00:00:00Z", domainAgeDays: 10 } });
    assert.deepEqual(r.reasons, ["site_not_wellness", "site_no_name", "domain_too_young"]);
  });
  test("a domain whose age cannot be read is not established", () => {
    const r = evaluate({ ...base, presence: { ...passedPresence, domainRegisteredAt: null, domainAgeDays: null } });
    assert.equal(r.autopass, false);
    assert.deepEqual(r.reasons, ["domain_age_unknown"]);
  });
  test("a registry that publishes no dates (.eu, .de …) does not make a practice look young when the VAT register vouched", () => {
    for (const rdapError of ["no_rdap", "no_registration_event"]) {
      const r = evaluate({ ...base, presence: { ...passedPresence, domainRegisteredAt: null, domainAgeDays: null, rdapError } });
      assert.equal(r.autopass, true, rdapError);
      assert.deepEqual(r.reasons, []);
    }
  });
  test("…but without the register it goes to a person, under its own reason", () => {
    const r = evaluate({ ...base, company: { applicable: false, reason: "not_given" }, presence: { ...passedPresence, domainRegisteredAt: null, domainAgeDays: null, rdapError: "no_rdap" } });
    assert.equal(r.autopass, false);
    assert.deepEqual(r.reasons, ["company_not_given", "domain_age_unavailable"]);
  });
  test("an RDAP lookup that merely failed is still 'unknown' — worth retrying, never waived", () => {
    const r = evaluate({ ...base, presence: { ...passedPresence, domainRegisteredAt: null, domainAgeDays: null, rdapError: "timeout" } });
    assert.deepEqual(r.reasons, ["domain_age_unknown"]);
  });
  test("a site that turns the check away is 'blocked', not 'unreachable'", () => {
    const r = evaluate({ ...base, presence: { ...passedPresence, site: { reachable: false, status: 403, error: "blocked_403" } } });
    assert.equal(r.steps.presence, "failed");
    assert.deepEqual(r.reasons, ["site_blocked"]);
  });
  test("the age threshold is closed from below", () => {
    assert.equal(evaluate({ ...base, presence: { ...passedPresence, domainAgeDays: MIN_DOMAIN_AGE_DAYS - 1 } }).autopass, false);
    assert.equal(evaluate({ ...base, presence: { ...passedPresence, domainAgeDays: MIN_DOMAIN_AGE_DAYS } }).autopass, true);
  });
  test("reasons from steps two and three accumulate — one ticket, everything on it", () => {
    const r = evaluate({ ...base, company: { applicable: false, reason: "not_given" }, presence: { ...passedPresence, domainAgeDays: 3 } });
    assert.deepEqual(r.reasons, ["company_not_given", "domain_too_young"]);
  });
});
