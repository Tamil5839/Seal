// Local storage in IndexedDB.
//   identity    - this device's seal: the private key as a NON-extractable
//                 CryptoKey (usable for signing, impossible to read or export),
//                 plus the public key and Seal ID
//   known       - Seal IDs the person saved with a name ("Priya")
//   revocations - revocation notices the person chose to remember
// Nothing here ever leaves the device.

const DEFAULT_DB = 'seal';
const DB_VERSION = 1;
const IDENTITY_ID = 'primary';

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage transaction was aborted'));
  });
}

export class KeystoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeystoreError';
  }
}

export async function openKeystore(name = DEFAULT_DB) {
  if (!globalThis.indexedDB) throw new KeystoreError('This browser does not allow SEAL to store data (IndexedDB is unavailable).');
  const req = indexedDB.open(name, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('identity')) db.createObjectStore('identity', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('known')) db.createObjectStore('known', { keyPath: 'sealId' });
    if (!db.objectStoreNames.contains('revocations')) db.createObjectStore('revocations', { keyPath: 'sealId' });
  };
  let db;
  try {
    db = await request(req);
  } catch (error) {
    throw new KeystoreError(`This browser did not allow SEAL to open its storage (${error && error.name}).`);
  }
  return new Keystore(db);
}

export function deleteKeystore(name = DEFAULT_DB) {
  return request(indexedDB.deleteDatabase(name));
}

class Keystore {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  async #get(store, key) {
    const tx = this.db.transaction(store, 'readonly');
    const result = await request(tx.objectStore(store).get(key));
    await done(tx);
    return result;
  }

  async #all(store) {
    const tx = this.db.transaction(store, 'readonly');
    const result = await request(tx.objectStore(store).getAll());
    await done(tx);
    return result;
  }

  async #put(store, value) {
    const tx = this.db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    await done(tx);
  }

  async #delete(store, key) {
    const tx = this.db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await done(tx);
  }

  /** The seal stored on this device, or null. */
  async loadIdentity() {
    const record = await this.#get('identity', IDENTITY_ID);
    if (!record) return null;
    return {
      privateKey: record.privateKey,
      publicKey: new Uint8Array(record.publicKey),
      sealId: record.sealId,
      createdAt: record.createdAt,
      origin: record.origin,
    };
  }

  /**
   * Store this device's seal. The private key must be a non-extractable
   * Ed25519 signing key; anything else is refused.
   */
  async saveIdentity({ privateKey, publicKey, sealId, createdAt, origin }) {
    const ok = privateKey instanceof CryptoKey && privateKey.type === 'private' && privateKey.extractable === false &&
      privateKey.algorithm.name === 'Ed25519' && privateKey.usages.includes('sign');
    if (!ok) throw new KeystoreError('Refusing to store a private key that is extractable or not an Ed25519 signing key.');
    const existing = await this.#get('identity', IDENTITY_ID);
    if (existing && existing.sealId !== sealId) throw new KeystoreError('Another seal is already stored on this device. Delete it first.');
    await this.#put('identity', { id: IDENTITY_ID, privateKey, publicKey: new Uint8Array(publicKey), sealId, createdAt, origin });
  }

  deleteIdentity() {
    return this.#delete('identity', IDENTITY_ID);
  }

  async listKnown() {
    const all = await this.#all('known');
    return all.sort((a, b) => a.name.localeCompare(b.name));
  }

  saveKnown({ sealId, name, publicKey = null }) {
    return this.#put('known', { sealId, name, publicKey: publicKey ? new Uint8Array(publicKey) : null, savedAt: new Date().toISOString() });
  }

  deleteKnown(sealId) {
    return this.#delete('known', sealId);
  }

  async listRevocations() {
    return (await this.#all('revocations')).map((r) => r.notice);
  }

  saveRevocation(sealId, notice) {
    return this.#put('revocations', { sealId, notice, savedAt: new Date().toISOString() });
  }

  deleteRevocation(sealId) {
    return this.#delete('revocations', sealId);
  }
}
