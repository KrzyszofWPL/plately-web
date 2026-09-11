// ---------------------------------------------------------------------------
// Domains — the rules practice verification is built on
//
// Pure functions, no imports, no env. Read by api/_lib/practice-verify.js
// (the decision) and by the sign-in page's copy (the promise), so the hint
// "sign in with your practice's account" can never promise something the
// verifier will not honour.
// ---------------------------------------------------------------------------

/**
 * Public mail providers. A mailbox on one of these proves nothing about any
 * business domain. The list is a negative signal — anything NOT on it is taken
 * to be a domain of one's own — so one entry too many is cheaper than one too
 * few.
 */
export const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "yahoo.pl", "yahoo.co.uk", "yahoo.de", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "pm.me", "aol.com", "gmx.com", "gmx.de", "gmx.net",
  "wp.pl", "o2.pl", "onet.pl", "onet.eu", "op.pl", "interia.pl", "interia.eu", "tlen.pl",
  "poczta.fm", "vp.pl", "gazeta.pl", "spoko.pl", "autograf.pl", "go2.pl", "buziaczek.pl",
  "web.de", "t-online.de", "mail.ru", "yandex.ru", "yandex.com", "ukr.net", "i.ua",
  "orange.fr", "free.fr", "laposte.net", "libero.it", "virgilio.it", "seznam.cz", "centrum.cz",
  "qq.com", "163.com", "126.com", "naver.com", "daum.net", "hanmail.net",
]);

/** Domain of an e-mail address, lower-cased, or null. */
export function domainOf(email) {
  const at = String(email || "").lastIndexOf("@");
  if (at < 0) return null;
  const domain = String(email).slice(at + 1).trim().toLowerCase();
  return domain.includes(".") ? domain : null;
}

export function isPublicMailDomain(domain) {
  return domain !== null && PUBLIC_MAIL_DOMAINS.has(domain);
}

/**
 * `https://www.Gabinet-X.pl/kontakt` → `gabinet-x.pl`.
 *
 * No scheme, no `www.`, no path, lower case. `www` is the only prefix dropped
 * automatically: `sklep.gabinet.pl` is a different domain from `gabinet.pl`
 * and stays one — the comparison below allows parents.
 */
export function normaliseDomain(input) {
  let s = String(input || "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  s = s.replace(/:\d+$/, "");
  s = s.replace(/^www\./, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return null;
  return s;
}

/**
 * Same domain, or a subdomain of it, in either direction.
 *
 * `anna@gabinet.pl` matches the site `gabinet.pl`; so does
 * `anna@mail.gabinet.pl`, since a mailbox on a subdomain still needs control
 * of the parent. `gabinet.pl.evil.com` does not — the suffix is compared with
 * its dot.
 */
export function domainsMatch(candidate, claimed) {
  if (!candidate || !claimed) return false;
  if (candidate === claimed) return true;
  return candidate.endsWith("." + claimed) || claimed.endsWith("." + candidate);
}
