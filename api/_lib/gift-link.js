// ============================================================================
// The gift link — https://plately.eu/giftcards/<uuid v7>
//
// The UUID is the whole credential: the database holds only its hash, and the
// code on the card is encrypted with a key derived from it (see the gift-link
// block in Application APK/supabase/schema.sql). So the shape check here is
// not cosmetic — anything that is not a well-formed version-7 UUID cannot
// possibly match a row, and refusing it before the database is asked keeps a
// junk request from costing a lookup or a log line.
// ============================================================================

// Version nibble pinned to 7, variant to RFC 4122. `gift_new_link()` in the
// schema produces exactly this; a v4 pasted in by hand is refused on purpose.
const GIFT_LINK = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The canonical (lower-case) link id, or null when the value is not one.
 * Tolerates surrounding whitespace and upper case — both happen when a link
 * is copied out of an e-mail by hand.
 */
export function parseGiftLink(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return GIFT_LINK.test(value) ? value : null;
}
