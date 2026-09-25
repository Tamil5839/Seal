// Encrypted backups of the private signing key.
//
//   key        = PBKDF2-SHA256(NFC(passphrase), random 16-byte salt, 600,000 iterations) -> AES-256 key
//   ciphertext = AES-256-GCM(key, random 12-byte IV, plaintext = canonical JSON of the
//                private JWK { crv, d, kty, x }, additional data = canonical JSON of
//                every other field of the backup file)
//
// Because all the readable fields (Seal ID, public key, KDF settings...) are
// authenticated as additional data, editing any of them makes the backup
// fail to open rather than restore something misleading.

import { base64urlDecode, base64urlDecodeLength, base64urlEncode, randomBytes, utf8Decode, utf8Encode } from './bytes.js';
import { canonicalBytes } from './canonical-json.js';
import { privateJwkProblem, publicKeyProblem } from './ed25519.js';
import { codePointLength, formatTimestamp, isPlainObject, isValidTimestamp } from './manifest.js';
import { sealIdFromPublicKey } from './seal-id.js';

export const BACKUP_TYPE = 'seal-backup';
export const BACKUP_VERSION = 1;
export const PBKDF2_ITERATIONS = 600000;
export const PBKDF2_MAX_ITERATIONS = 10000000;
export const PASSPHRASE_MIN_LENGTH = 12;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const ABOUT = 'Encrypted backup of a SEAL signing key. To restore it, open SEAL, choose "Restore from backup" and enter your passphrase. ' +
  'Keep this file somewhere safe: together with your passphrase it lets anyone seal files as you.';
const FIELDS = ['type', 'v', 'about', 'seal_id', 'pub', 'created_at', 'kdf', 'cipher', 'ct'];

export class BackupError extends Error {
  /** code: "format" | "passphrase" | "mismatch" | "weak" */
  constructor(code, message) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

/** Passphrases are compared in Unicode NFC, so the same words typed on any device match. */
export function normalizePassphrase(passphrase) {
  return String(passphrase).normalize('NFC');
}

export function backupFileName(sealId) {
  return `seal-backup-${sealId}.json`;
}

async function deriveKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', utf8Encode(normalizePassphrase(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function additionalData(backup) {
  const header = {};
  for (const key of Object.keys(backup)) if (key !== 'ct') header[key] = backup[key];
  return canonicalBytes(header);
}

/** Encrypt a private key into a backup object (JSON-serializable). */
export async function createBackup({ privateJwk, publicKey, passphrase, createdAt = formatTimestamp(new Date()) }) {
  if (codePointLength(normalizePassphrase(passphrase)) < PASSPHRASE_MIN_LENGTH) {
    throw new BackupError('weak', `The passphrase must be at least ${PASSPHRASE_MIN_LENGTH} characters long.`);
  }
  const problem = privateJwkProblem(privateJwk);
  if (problem) throw new BackupError('format', problem);
  if (privateJwk.x !== base64urlEncode(publicKey)) throw new BackupError('mismatch', 'The private key does not belong to this public key.');

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const backup = {
    type: BACKUP_TYPE,
    v: BACKUP_VERSION,
    about: ABOUT,
    seal_id: await sealIdFromPublicKey(publicKey),
    pub: base64urlEncode(publicKey),
    created_at: createdAt,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: base64urlEncode(salt) },
    cipher: { name: 'AES-GCM', iv: base64urlEncode(iv) },
  };
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plaintext = canonicalBytes({ kty: 'OKP', crv: 'Ed25519', d: privateJwk.d, x: privateJwk.x });
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(backup) }, key, plaintext);
    backup.ct = base64urlEncode(new Uint8Array(ciphertext));
  } finally {
    plaintext.fill(0);
  }
  return backup;
}

const formatError = (detail) => new BackupError('format', `This is not a valid SEAL backup file (${detail}).`);

/** Check a backup object's structure. Throws BackupError("format"). */
export function checkBackup(backup) {
  if (!isPlainObject(backup) || backup.type !== BACKUP_TYPE) throw formatError('it is not a backup');
  if (backup.v !== BACKUP_VERSION) throw formatError('unsupported version');
  for (const key of Object.keys(backup)) if (!FIELDS.includes(key)) throw formatError(`unknown field "${key}"`);
  for (const key of FIELDS) if (!(key in backup)) throw formatError(`missing field "${key}"`);
  if (typeof backup.about !== 'string') throw formatError('bad "about"');
  if (!isValidTimestamp(backup.created_at)) throw formatError('bad "created_at"');
  let pub;
  try {
    pub = base64urlDecodeLength(backup.pub, 32);
  } catch {
    throw formatError('bad public key');
  }
  if (publicKeyProblem(pub)) throw formatError('bad public key');
  const { kdf, cipher } = backup;
  if (!isPlainObject(kdf) || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || Object.keys(kdf).length !== 4) throw formatError('unsupported key derivation');
  if (!Number.isSafeInteger(kdf.iterations) || kdf.iterations < PBKDF2_ITERATIONS || kdf.iterations > PBKDF2_MAX_ITERATIONS) {
    throw formatError('unsupported key derivation settings');
  }
  if (!isPlainObject(cipher) || cipher.name !== 'AES-GCM' || Object.keys(cipher).length !== 2) throw formatError('unsupported encryption');
  try {
    if (base64urlDecode(kdf.salt).length < SALT_BYTES) throw new Error();
    base64urlDecodeLength(cipher.iv, IV_BYTES);
    if (base64urlDecode(backup.ct).length < 16 + 32) throw new Error();
  } catch {
    throw formatError('damaged encrypted data');
  }
  return { publicKey: pub };
}

/** Parse the bytes of a backup file. Throws BackupError("format"). */
export function parseBackupBytes(bytes) {
  let value;
  try {
    const text = utf8Decode(bytes);
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw formatError('it is not JSON');
  }
  checkBackup(value);
  return value;
}

export function backupFileText(backup) {
  return JSON.stringify(backup, null, 2) + '\n';
}

/**
 * Decrypt a backup. Resolves { privateJwk, publicKey, sealId }.
 * Throws BackupError: "format", "passphrase" (wrong passphrase or damaged
 * file - AES-GCM cannot tell these apart) or "mismatch".
 */
export async function openBackup(backup, passphrase) {
  const { publicKey } = checkBackup(backup);
  const sealId = await sealIdFromPublicKey(publicKey);
  if (sealId !== backup.seal_id) throw formatError('the Seal ID does not match the public key');
  const key = await deriveKey(passphrase, base64urlDecode(backup.kdf.salt), backup.kdf.iterations);
  let plaintext;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64urlDecode(backup.cipher.iv), additionalData: additionalData(backup) },
      key,
      base64urlDecode(backup.ct),
    ));
  } catch {
    throw new BackupError('passphrase', 'That passphrase does not unlock this backup, or the file was changed or damaged.');
  }
  let jwk;
  try {
    jwk = JSON.parse(utf8Decode(plaintext));
  } catch {
    throw formatError('damaged key data');
  } finally {
    plaintext.fill(0);
  }
  if (privateJwkProblem(jwk)) throw formatError('damaged key data');
  if (jwk.x !== backup.pub) throw new BackupError('mismatch', 'The key inside this backup does not match its Seal ID.');
  return { privateJwk: { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x }, publicKey, sealId };
}
