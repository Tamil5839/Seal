// Seal manifests, seal objects and revocation notices.
//
// A file seal manifest (every field required unless marked optional):
//   { v: 1, alg: "Ed25519", pub, sha256, size, name, declared_at, note? }
// A revocation manifest:
//   { v: 1, alg: "Ed25519", pub, revoked: true, declared_at, note? }
// A seal object (the contents of a .seal file, or of an embedded seal):
//   { manifest: {...}, sig: base64url(Ed25519 signature over the canonical manifest bytes) }
//
// Validation is strict: unknown fields, missing fields, or values outside the
// rules below make a seal invalid. docs/FORMAT.md describes the same rules.

import { base64urlDecodeLength, base64urlEncode, utf8Decode } from './bytes.js';
import { canonicalBytes } from './canonical-json.js';
import { publicKeyProblem, sign, verify } from './ed25519.js';
import { fingerprint, sealIdFromFingerprint } from './seal-id.js';

export const FORMAT_VERSION = 1;
export const SIGNATURE_ALG = 'Ed25519';
export const NOTE_MAX_CHARS = 280;
export const NAME_MAX_CHARS = 255;
export const SEAL_FILE_MAX_BYTES = 64 * 1024;

const FILE_FIELDS = { required: ['v', 'alg', 'pub', 'sha256', 'size', 'name', 'declared_at'], optional: ['note'] };
const REVOCATION_FIELDS = { required: ['v', 'alg', 'pub', 'revoked', 'declared_at'], optional: ['note'] };

// Control characters and bidirectional embedding/override/isolate characters
// can make text display differently from what it is, so they are not allowed.
// Notes may contain line breaks (\n); names may not.
const FORBIDDEN_IN_NAME = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const FORBIDDEN_IN_NOTE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export class SealFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SealFormatError';
  }
}

const fail = (message) => {
  throw new SealFormatError(message);
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function codePointLength(text) {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export function hasLoneSurrogate(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function removeLoneSurrogates(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      }
    } else if (c < 0xdc00 || c > 0xdfff) {
      out += text[i];
    }
  }
  return out;
}

// ---------------------------------------------------------- timestamps

/** True for "YYYY-MM-DDTHH:MM:SSZ" naming a real UTC date and time. */
export function isValidTimestamp(text) {
  const m = typeof text === 'string' && TIMESTAMP.exec(text);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (y < 1) return false;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, s, 0);
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d &&
    t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === s;
}

/** Format a Date as "YYYY-MM-DDTHH:MM:SSZ" (UTC, whole seconds). */
export function formatTimestamp(date) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

export function parseTimestamp(text) {
  return isValidTimestamp(text) ? new Date(text) : null;
}

// ------------------------------------------------------ text sanitizing

/** Make a file name safe to put in a manifest (used when sealing). */
export function sanitizeName(name) {
  let clean = removeLoneSurrogates(String(name)).normalize('NFC');
  clean = clean.replace(new RegExp(FORBIDDEN_IN_NAME.source, 'g'), '').trim();
  if (!clean) clean = 'file';
  const chars = [...clean];
  if (chars.length > NAME_MAX_CHARS) clean = chars.slice(0, NAME_MAX_CHARS).join('');
  return clean;
}

/** Normalize a note typed by the sealer. Returns "" for no note. */
export function sanitizeNote(note) {
  let clean = removeLoneSurrogates(String(note ?? '')).replace(/\r\n?/g, '\n').normalize('NFC');
  return clean.replace(new RegExp(FORBIDDEN_IN_NOTE.source, 'g'), '').trim();
}

// ----------------------------------------------------------- validation

function checkText(value, field, forbidden, maxChars) {
  if (typeof value !== 'string') fail(`"${field}" must be text`);
  if (hasLoneSurrogate(value)) fail(`"${field}" contains invalid characters`);
  if (forbidden.test(value)) fail(`"${field}" contains control or direction-changing characters`);
  const n = codePointLength(value);
  if (n < 1) fail(`"${field}" must not be empty`);
  if (n > maxChars) fail(`"${field}" is longer than ${maxChars} characters`);
}

function decodePublicKey(value) {
  if (typeof value !== 'string') fail('"pub" must be text');
  let bytes;
  try {
    bytes = base64urlDecodeLength(value, 32);
  } catch {
    fail('"pub" is not a valid public key encoding');
  }
  const problem = publicKeyProblem(bytes);
  if (problem) fail(problem);
  return bytes;
}

/**
 * Check a manifest against the format rules.
 * Returns { kind: "file" | "revocation", publicKey } or throws SealFormatError.
 */
export function checkManifest(manifest) {
  if (!isPlainObject(manifest)) fail('manifest is not an object');
  const kind = hasOwn(manifest, 'revoked') ? 'revocation' : 'file';
  const fields = kind === 'file' ? FILE_FIELDS : REVOCATION_FIELDS;
  for (const key of Object.keys(manifest)) {
    if (!fields.required.includes(key) && !fields.optional.includes(key)) fail(`unknown field "${key}"`);
  }
  for (const key of fields.required) if (!hasOwn(manifest, key)) fail(`missing field "${key}"`);

  if (manifest.v !== FORMAT_VERSION) fail('unsupported format version');
  if (manifest.alg !== SIGNATURE_ALG) fail('unsupported signature algorithm');
  const publicKey = decodePublicKey(manifest.pub);
  if (!isValidTimestamp(manifest.declared_at)) fail('"declared_at" is not a UTC timestamp like 2026-01-31T12:00:00Z');
  if (hasOwn(manifest, 'note')) checkText(manifest.note, 'note', FORBIDDEN_IN_NOTE, NOTE_MAX_CHARS);

  if (kind === 'file') {
    if (typeof manifest.sha256 !== 'string' || !SHA256_HEX.test(manifest.sha256)) fail('"sha256" must be 64 lowercase hex digits');
    if (!Number.isSafeInteger(manifest.size) || manifest.size < 0) fail('"size" must be a whole number of bytes');
    checkText(manifest.name, 'name', FORBIDDEN_IN_NAME, NAME_MAX_CHARS);
  } else if (manifest.revoked !== true) {
    fail('"revoked" must be true');
  }
  return { kind, publicKey };
}

/**
 * Check a seal object { manifest, sig }.
 * Returns { kind, manifest, publicKey, signature } or throws SealFormatError.
 */
export function checkSealObject(seal) {
  if (!isPlainObject(seal)) fail('not a seal');
  for (const key of Object.keys(seal)) if (key !== 'manifest' && key !== 'sig') fail(`unknown field "${key}"`);
  if (!hasOwn(seal, 'manifest')) fail('missing "manifest"');
  if (!hasOwn(seal, 'sig')) fail('missing "sig"');
  if (typeof seal.sig !== 'string') fail('"sig" must be text');
  let signature;
  try {
    signature = base64urlDecodeLength(seal.sig, 64);
  } catch {
    fail('"sig" is not a valid signature encoding');
  }
  const { kind, publicKey } = checkManifest(seal.manifest);
  return { kind, manifest: seal.manifest, publicKey, signature };
}

// ------------------------------------------------------------- building

export function buildFileManifest({ publicKey, sha256, size, name, declaredAt, note }) {
  const manifest = {
    v: FORMAT_VERSION,
    alg: SIGNATURE_ALG,
    pub: base64urlEncode(publicKey),
    sha256,
    size,
    name: sanitizeName(name),
    declared_at: declaredAt,
  };
  const cleanNote = sanitizeNote(note);
  if (cleanNote) manifest.note = cleanNote;
  checkManifest(manifest);
  return manifest;
}

export function buildRevocationManifest({ publicKey, declaredAt, note }) {
  const manifest = {
    v: FORMAT_VERSION,
    alg: SIGNATURE_ALG,
    pub: base64urlEncode(publicKey),
    revoked: true,
    declared_at: declaredAt,
  };
  const cleanNote = sanitizeNote(note);
  if (cleanNote) manifest.note = cleanNote;
  checkManifest(manifest);
  return manifest;
}

/** Sign a manifest. Refuses to sign anything that would not verify. */
export async function signManifest(privateKey, manifest) {
  checkManifest(manifest);
  const signature = await sign(privateKey, canonicalBytes(manifest));
  return { manifest, sig: base64urlEncode(signature) };
}

// --------------------------------------------------------- verification

/**
 * Verify a seal object's signature (not the file it covers).
 * Never throws. Returns:
 *   { valid: true, kind, manifest, publicKey, fingerprint, sealId }
 *   { valid: false, malformed: boolean, problem }
 */
export async function verifySealObject(seal) {
  let checked;
  try {
    checked = checkSealObject(seal);
  } catch (error) {
    return { valid: false, malformed: true, problem: error.message };
  }
  const ok = await verify(checked.publicKey, checked.signature, canonicalBytes(checked.manifest));
  if (!ok) return { valid: false, malformed: false, problem: 'the signature does not match the seal contents' };
  const fp = await fingerprint(checked.publicKey);
  return {
    valid: true,
    kind: checked.kind,
    manifest: checked.manifest,
    publicKey: checked.publicKey,
    fingerprint: fp,
    sealId: sealIdFromFingerprint(fp),
  };
}

// ----------------------------------------------------------- seal files

/** Parse the JSON text of a seal. Throws SealFormatError. */
export function parseSealText(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(body);
  } catch {
    fail('not valid JSON');
  }
}

/** Parse the bytes of a .seal file. Throws SealFormatError. */
export function parseSealBytes(bytes) {
  if (bytes.length > SEAL_FILE_MAX_BYTES) fail('too large to be a seal file');
  let text;
  try {
    text = utf8Decode(bytes);
  } catch {
    fail('not UTF-8 text');
  }
  return parseSealText(text);
}

/** Quick structural test used to recognise seal files among dropped files. */
export function looksLikeSeal(value) {
  return isPlainObject(value) && hasOwn(value, 'manifest') && hasOwn(value, 'sig');
}

function sortedObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

/** Human-readable .seal file contents (manifest keys sorted). */
export function sealFileText(seal) {
  return JSON.stringify({ manifest: sortedObject(seal.manifest), sig: seal.sig }, null, 2) + '\n';
}
