// Byte and text encoding helpers. No DOM access, no crypto.
// Every decoder here is strict: it rejects anything that does not have
// exactly one valid encoding, so a value can never be written two ways.

const encoder = new TextEncoder();

/** UTF-8 encode a string. */
export function utf8Encode(text) {
  return encoder.encode(text);
}

/**
 * Strict UTF-8 decode. Throws on invalid UTF-8. A leading byte-order mark
 * is kept as U+FEFF (never silently removed), so decoding is lossless.
 */
export function utf8Decode(bytes) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** Return a Uint8Array view of ArrayBuffer / typed array input. */
export function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Expected bytes');
}

export function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function randomBytes(length) {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

// ---------------------------------------------------------------- hex

const HEX = '0123456789abcdef';

/** Lowercase hex. */
export function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return out;
}

/** Strict lowercase hex decode. */
export function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error('Invalid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------- base64url

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64URL.length; i++) B64URL_LOOKUP[B64URL.charCodeAt(i)] = i;

/** base64url without padding (RFC 4648 section 5). */
export function base64urlEncode(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

/**
 * Strict base64url decode: no padding, no whitespace, no characters outside
 * the URL-safe alphabet, and unused trailing bits must be zero (so every byte
 * string has exactly one accepted encoding).
 */
export function base64urlDecode(text) {
  if (typeof text !== 'string' || text.length % 4 === 1) throw new Error('Invalid base64url');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? B64URL_LOOKUP[c] : -1;
    if (v < 0) throw new Error('Invalid base64url');
    buffer = ((buffer << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) throw new Error('Invalid base64url');
  return out;
}

/** Decode base64url and require an exact byte length. */
export function base64urlDecodeLength(text, length) {
  const bytes = base64urlDecode(text);
  if (bytes.length !== length) throw new Error(`Expected ${length} bytes`);
  return bytes;
}
