// ---------------------------------------------------------------------------
// Practice verification — the rules that decide who sees other people's
// health data.
//
// The silent failures these guard against: an auto-pass that lets a practice
// through without proven domain ownership; a domain match that takes
// `gabinet.pl.evil.com` for `gabinet.pl`; a VIES outage read as "this company
// does not exist". None of them throws — a stranger simply sees a panel with
// real patients in it, or an honest practice is told it is not real. Pure
// functions only; nothing here touches the network or the database.
//
//   npm test        (node --test, nothing to install)
// ---------------------------------------------------------------------------

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { domainOf, isPublicMailDomain, normaliseDomain, domainsMatch } from "../api/_lib/domain-rules.js";
import { parseTxtRecords, txtProvesOwnership, evaluate, normaliseVat, interpretVies, MIN_REVIEWS_FOR_AUTOPASS, TXT_PREFIX } from "../api/_lib/practice-verify.js";

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

describe("evaluate — three steps in order", () => {
  const passedPlaces = { queried: true, found: true, operational: true, wellness: true, reviews: MIN_REVIEWS_FOR_AUTOPASS, websiteMatches: true };
  const passedCompany = { applicable: true, queried: true, valid: true, country: "PL", number: "1234567890", name: "GABINET X" };
  const base = { ownership: "email_domain", company: passedCompany, places: passedPlaces };

  test("passes the full set", () => {
    assert.deepEqual(evaluate(base), { steps: { domain: "passed", company: "passed", presence: "passed" }, autopass: true, reasons: [] });
  });
  test("with the domain unproven nothing else is judged — the later steps wait", () => {
    const r = evaluate({ ...base, ownership: null });
    assert.deepEqual(r, { steps: { domain: "pending", company: "waiting", presence: "waiting" }, autopass: false, reasons: ["domain_unproven"] });
  });
  test("NEVER passes without domain ownership, however perfect the registries look", () => {
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
  test("VIES saying no is a failed step", () => {
    const r = evaluate({ ...base, company: { ...passedCompany, valid: false } });
    assert.equal(r.steps.company, "failed");
    assert.deepEqual(r.reasons, ["company_not_in_vies"]);
  });
  test("VIES being down is 'unavailable', never 'failed'", () => {
    const r = evaluate({ ...base, company: { ...passedCompany, queried: false, valid: null, error: "MS_UNAVAILABLE" } });
    assert.equal(r.steps.company, "unavailable");
    assert.deepEqual(r.reasons, ["company_registry_unavailable"]);
  });
  test("sends to a person when Places was not queried", () => {
    const r = evaluate({ ...base, places: { queried: false, found: false } });
    assert.equal(r.steps.presence, "skipped");
    assert.deepEqual(r.reasons, ["places_not_queried"]);
  });
  test("lists every Places shortfall separately so the ticket needs no second look", () => {
    const r = evaluate({ ...base, places: { queried: true, found: true, operational: false, wellness: false, reviews: 2, websiteMatches: false } });
    assert.equal(r.steps.presence, "failed");
    assert.deepEqual(r.reasons, ["places_not_operational", "places_not_wellness", "places_too_few_reviews", "places_website_mismatch"]);
  });
  test("the review threshold is closed from below", () => {
    assert.equal(evaluate({ ...base, places: { ...passedPlaces, reviews: MIN_REVIEWS_FOR_AUTOPASS - 1 } }).autopass, false);
    assert.equal(evaluate({ ...base, places: { ...passedPlaces, reviews: MIN_REVIEWS_FOR_AUTOPASS } }).autopass, true);
  });
  test("reasons from steps two and three accumulate — one ticket, everything on it", () => {
    const r = evaluate({ ...base, company: { applicable: false, reason: "not_given" }, places: { queried: true, found: false } });
    assert.deepEqual(r.reasons, ["company_not_given", "places_not_found"]);
  });
});
