// Crockford base32 (https://www.crockford.com/base32.html).
// Alphabet excludes I, L, O and U so IDs are easy to read aloud and retype.

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Encode bytes, most significant bit first. When the bit count is not a
 * multiple of 5 the last group is padded with zero bits on the right.
 */
export function crockfordEncode(bytes) {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    buffer = ((buffer << 8) | bytes[i]) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * Normalize user-typed Crockford base32: uppercase, drop hyphens and
 * spaces, read O as 0 and I/L as 1. Returns null if anything else is left.
 */
export function crockfordNormalize(text) {
  const cleaned = String(text)
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  for (const ch of cleaned) {
    if (!CROCKFORD_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}
