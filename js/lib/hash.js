// SHA-256 via Web Crypto.

import { toHex } from './bytes.js';

export async function sha256(data) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
}

export async function sha256Hex(data) {
  return toHex(await sha256(data));
}
