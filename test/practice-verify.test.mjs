// ---------------------------------------------------------------------------
// Practice verification — the rules that decide who sees other people's
// health data.
//
// The silent failure these guard against: an auto-pass that lets a practice
// through without proven domain ownership, or a domain match that takes
// `gabinet.pl.evil.com` for `gabinet.pl`. Neither throws — a stranger simply
// sees a panel with real patients in it. Pure functions only; nothing here
// touches the network or the database.
//
//   npm test        (node --test, nothing to install)
// ---------------------------------------------------------------------------

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { domainOf, isPublicMailDomain, normaliseDomain, domainsMatch } from "../api/_lib/domain-rules.js";
import { parseTxtRecords, txtProvesOwnership, scoreVerification, MIN_REVIEWS_FOR_AUTOPASS, TXT_PREFIX } from "../api/_lib/practice-verify.js";

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

describe("scoreVerification", () => {
  const base = {
    ownership: "email_domain",
    places: { queried: true, found: true, operational: true, wellness: true, reviews: MIN_REVIEWS_FOR_AUTOPASS, websiteMatches: true },
  };
  test("passes the full set", () => {
    assert.deepEqual(scoreVerification(base), { autopass: true, reasons: [] });
  });
  test("NEVER passes without domain ownership, however perfect Maps looks", () => {
    const r = scoreVerification({ ...base, ownership: null });
    assert.equal(r.autopass, false);
    assert.ok(r.reasons.includes("ownership_unproven"));
  });
  test("sends to a person when Places was not queried", () => {
    const r = scoreVerification({ ...base, places: { queried: false, found: false } });
    assert.equal(r.autopass, false);
    assert.deepEqual(r.reasons, ["places_not_queried"]);
  });
  test("lists every shortfall separately so the ticket needs no second look", () => {
    const r = scoreVerification({ ...base, places: { queried: true, found: true, operational: false, wellness: false, reviews: 2, websiteMatches: false } });
    assert.deepEqual(r.reasons, ["places_not_operational", "places_not_wellness", "places_too_few_reviews", "places_website_mismatch"]);
  });
  test("the review threshold is closed from below", () => {
    assert.equal(scoreVerification({ ...base, places: { ...base.places, reviews: MIN_REVIEWS_FOR_AUTOPASS - 1 } }).autopass, false);
    assert.equal(scoreVerification({ ...base, places: { ...base.places, reviews: MIN_REVIEWS_FOR_AUTOPASS } }).autopass, true);
  });
});
