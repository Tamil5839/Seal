// Thin wrappers around the browser's Web Crypto Ed25519 implementation.
// No custom cryptography: signing and verification are done by the browser.
// The only thing added here is input validation that the Web Crypto spec
// leaves to implementations (rejecting weak and non-canonical public keys).

import { base64urlDecodeLength, fromHex } from './bytes.js';

const ALG = { name: 'Ed25519' };
const subtle = () => globalThis.crypto && globalThis.crypto.subtle;

// RFC 8032, section 7.1, TEST 1 (empty message).
const RFC8032_TEST1 = {
  publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  signature: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
};

let supportPromise = null;

/**
 * Feature detection. Resolves true only if this browser can generate
 * Ed25519 keys, sign, and correctly verify a known RFC 8032 test vector.
 */
export function ed25519Supported() {
  if (!supportPromise) supportPromise = detect();
  return supportPromise;
}

async function detect() {
  try {
    const s = subtle();
    if (!s) return false;
    const pub = await s.importKey('raw', fromHex(RFC8032_TEST1.publicKey), ALG, false, ['verify']);
    const good = await s.verify(ALG, pub, fromHex(RFC8032_TEST1.signature), new Uint8Array(0));
    const bad = await s.verify(ALG, pub, fromHex(RFC8032_TEST1.signature), new Uint8Array([0]));
    if (!good || bad) return false;
    const pair = await s.generateKey(ALG, false, ['sign', 'verify']);
    const msg = new Uint8Array([1, 2, 3]);
    const sig = await s.sign(ALG, pair.privateKey, msg);
    return await s.verify(ALG, pair.publicKey, sig, msg);
  } catch {
    return false;
  }
}

// --------------------------------------------------- public key checks

// Encodings of the eight small-order points (and the two non-canonical
// encodings p and p+1 of y = 0 and y = 1), with the sign bit cleared.
// A public key equal to one of these would let anyone forge signatures,
// and at least one mainstream browser accepts them, so they are refused here.
// These are the same values libsodium blocks in ge25519_has_small_order.
const SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].map(fromHex);

/** True if the 32-byte encoding is a small-order point (sign bit ignored). */
export function isSmallOrderPublicKey(bytes) {
  return SMALL_ORDER.some((entry) => {
    let diff = 0;
    for (let i = 0; i < 31; i++) diff |= bytes[i] ^ entry[i];
    diff |= (bytes[31] & 0x7f) ^ entry[31];
    return diff === 0;
  });
}

/** True if the encoded y coordinate is >= p = 2^255 - 19 (non-canonical). */
export function isNonCanonicalPublicKey(bytes) {
  if ((bytes[31] & 0x7f) !== 0x7f) return false;
  for (let i = 30; i >= 1; i--) if (bytes[i] !== 0xff) return false;
  return bytes[0] >= 0xed;
}

/** Validate a raw public key's shape. Returns an error message or null. */
export function publicKeyProblem(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return 'public key must be 32 bytes';
  if (isSmallOrderPublicKey(bytes)) return 'public key is a weak (small-order) key';
  if (isNonCanonicalPublicKey(bytes)) return 'public key is not canonically encoded';
  return null;
}

// ------------------------------------------------------- key handling

/** Generate a new key pair. The private key is extractable (for backup only). */
export function generateKeyPair() {
  return subtle().generateKey(ALG, true, ['sign', 'verify']);
}

export async function exportPublicKeyRaw(publicKey) {
  return new Uint8Array(await subtle().exportKey('raw', publicKey));
}

/** Export a private key as a minimal JWK { kty, crv, d, x }. */
export async function exportPrivateJwk(privateKey) {
  const jwk = await subtle().exportKey('jwk', privateKey);
  return { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x };
}

/** Check a private JWK's shape. Returns an error message or null. */
export function privateJwkProblem(jwk) {
  if (!jwk || typeof jwk !== 'object') return 'not a key';
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') return 'not an Ed25519 key';
  try {
    base64urlDecodeLength(jwk.d, 32);
    const x = base64urlDecodeLength(jwk.x, 32);
    return publicKeyProblem(x);
  } catch {
    return 'key data is malformed';
  }
}

/** Import a private key. Non-extractable unless explicitly requested. */
export function importPrivateJwk(jwk, { extractable = false } = {}) {
  const problem = privateJwkProblem(jwk);
  if (problem) throw new Error(problem);
  return subtle().importKey('jwk', { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x }, ALG, extractable, ['sign']);
}

export function importPublicKeyRaw(bytes) {
  const problem = publicKeyProblem(bytes);
  if (problem) throw new Error(problem);
  return subtle().importKey('raw', bytes, ALG, true, ['verify']);
}

export async function sign(privateKey, data) {
  return new Uint8Array(await subtle().sign(ALG, privateKey, data));
}

/**
 * Verify a signature. Returns false (never throws) for weak keys, wrong
 * lengths, malformed input, or a signature that does not match.
 */
export async function verify(publicKeyBytes, signature, data) {
  if (publicKeyProblem(publicKeyBytes)) return false;
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return false;
  try {
    const key = await subtle().importKey('raw', publicKeyBytes, ALG, false, ['verify']);
    return await subtle().verify(ALG, key, signature, data);
  } catch {
    return false;
  }
}

/**
 * Prove that a private key and public key belong together by signing and
 * verifying a random challenge.
 */
export async function keysMatch(privateKey, publicKeyBytes) {
  const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
  try {
    return await verify(publicKeyBytes, await sign(privateKey, challenge), challenge);
  } catch {
    return false;
  }
}
