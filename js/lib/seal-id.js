// Seal IDs.
//   fingerprint = SHA-256(raw 32-byte Ed25519 public key)
//   Seal ID     = "SEAL-" + Crockford base32 of the first 80 bits of the
//                 fingerprint, in four groups of four characters.

import { crockfordEncode, crockfordNormalize } from './base32.js';
import { toHex } from './bytes.js';
import { sha256 } from './hash.js';

export const SEAL_ID_PATTERN = /^SEAL-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

export function fingerprint(publicKeyBytes) {
  return sha256(publicKeyBytes);
}

export function sealIdFromFingerprint(fp) {
  const chars = crockfordEncode(fp.subarray(0, 10)); // 80 bits -> 16 characters
  return 'SEAL-' + chars.match(/.{4}/g).join('-');
}

export async function sealIdFromPublicKey(publicKeyBytes) {
  return sealIdFromFingerprint(await fingerprint(publicKeyBytes));
}

/**
 * Parse a Seal ID typed or pasted by a person. Accepts lowercase, missing
 * hyphens, a missing "SEAL-" prefix and the usual Crockford look-alikes
 * (O for 0, I or L for 1). Returns the canonical form, or null.
 */
export function parseSealId(input) {
  let text = String(input).trim().toUpperCase();
  // A leading "SEAL" is always the prefix: "L" is not a base32 digit, so a
  // bare code can never start with it.
  if (text.startsWith('SEAL')) text = text.slice(4);
  const chars = crockfordNormalize(text);
  if (!chars || chars.length !== 16) return null;
  return 'SEAL-' + chars.match(/.{4}/g).join('-');
}

/** Full fingerprint as lowercase hex in groups of four, for careful comparison. */
export function formatFingerprint(fp) {
  return toHex(fp).match(/.{4}/g).join(' ');
}
