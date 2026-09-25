import { assert, describe, test } from './harness.js';
import { testIdentity } from './fixtures.js';
import { base64urlDecode, base64urlEncode, utf8Decode, utf8Encode } from '../js/lib/bytes.js';
import { exportPrivateJwk, generateKeyPair, importPrivateJwk, keysMatch, exportPublicKeyRaw } from '../js/lib/ed25519.js';
import {
  PBKDF2_ITERATIONS, backupFileName, backupFileText, checkBackup, createBackup, openBackup, parseBackupBytes,
} from '../js/lib/backup.js';
import { deleteKeystore, openKeystore } from '../js/lib/keystore.js';
import { assessPassphrase } from '../js/lib/passphrase.js';

const PASS = 'lapis river clay moon tablet';

async function freshKey() {
  const pair = await generateKeyPair();
  return { pair, jwk: await exportPrivateJwk(pair.privateKey), publicKey: await exportPublicKeyRaw(pair.publicKey) };
}

describe('encrypted backup', () => {
  test('encrypts, and decrypts with the right passphrase', async () => {
    const { jwk, publicKey } = await freshKey();
    const backup = await createBackup({ privateJwk: jwk, publicKey, passphrase: PASS });
    const opened = await openBackup(parseBackupBytes(utf8Encode(backupFileText(backup))), PASS);
    assert.deepEqual(opened.privateJwk, jwk);
    assert.deepEqual(opened.publicKey, publicKey);
    assert.equal(opened.sealId, backup.seal_id);
    const locked = await importPrivateJwk(opened.privateJwk);
    assert.equal(locked.extractable, false);
    assert.ok(await keysMatch(locked, publicKey));
  });

  test('fails cleanly with the wrong passphrase', async () => {
    const { jwk, publicKey } = await freshKey();
    const backup = await createBackup({ privateJwk: jwk, publicKey, passphrase: PASS });
    for (const wrong of ['lapis river clay moon tablex', 'LAPIS RIVER CLAY MOON TABLET', PASS + ' ']) {
      const error = await assert.rejects(() => openBackup(backup, wrong));
      assert.equal(error.name, 'BackupError');
      assert.equal(error.code, 'passphrase');
    }
  });

  test('uses PBKDF2-SHA256 with at least 600,000 iterations and AES-256-GCM, with fresh salt and IV', async () => {
    const { jwk, publicKey } = await freshKey();
    const a = await createBackup({ privateJwk: jwk, publicKey, passphrase: PASS });
    const b = await createBackup({ privateJwk: jwk, publicKey, passphrase: PASS });
    assert.equal(a.kdf.name, 'PBKDF2');
    assert.equal(a.kdf.hash, 'SHA-256');
    assert.ok(a.kdf.iterations >= 600000 && PBKDF2_ITERATIONS >= 600000);
    assert.equal(a.cipher.name, 'AES-GCM');
    assert.equal(base64urlDecode(a.kdf.salt).length, 16);
    assert.equal(base64urlDecode(a.cipher.iv).length, 12);
    assert.notEqual(a.kdf.salt, b.kdf.salt);
    assert.notEqual(a.cipher.iv, b.cipher.iv);
    assert.notEqual(a.ct, b.ct);
  });

  test('the file never contains the private key in readable form', async () => {
    const { jwk, publicKey } = await freshKey();
    const text = backupFileText(await createBackup({ privateJwk: jwk, publicKey, passphrase: PASS }));
    assert.equal(text.includes(jwk.d), false);
    assert.ok(text.includes(base64urlEncode(publicKey)), 'the public key is readable');
  });

  test('editing any readable field makes the backup fail to open', async () => {
    const { jwk, publicKey } = await freshKey();
    const backup = await createBackup({ privateJwk: jwk, publicKey, passphrase: PASS });
    const other = await freshKey();
    const { sealIdFromPublicKey } = await import('../js/lib/seal-id.js');
    const edits = [
      { created_at: '2000-01-01T00:00:00Z' },
      { about: 'edited' },
      { kdf: { ...backup.kdf, iterations: backup.kdf.iterations + 1 } },
      { pub: base64urlEncode(other.publicKey), seal_id: await sealIdFromPublicKey(other.publicKey) },
    ];
    for (const edit of edits) {
      const error = await assert.rejects(() => openBackup({ ...backup, ...edit }, PASS));
      assert.equal(error.code, 'passphrase', JSON.stringify(Object.keys(edit)));
    }
    const ct = base64urlDecode(backup.ct);
    ct[5] ^= 1;
    assert.equal((await assert.rejects(() => openBackup({ ...backup, ct: base64urlEncode(ct) }, PASS))).code, 'passphrase');
    assert.equal((await assert.rejects(() => openBackup({ ...backup, seal_id: 'SEAL-0000-0000-0000-0000' }, PASS))).code, 'format');
  });

  test('refuses weak settings and malformed files', async () => {
    const { jwk, publicKey } = await freshKey();
    const backup = await createBackup({ privateJwk: jwk, publicKey, passphrase: PASS });
    assert.throws(() => checkBackup({ ...backup, kdf: { ...backup.kdf, iterations: 1000 } }), /settings/);
    assert.throws(() => checkBackup({ ...backup, extra: 1 }), /unknown field/);
    assert.throws(() => checkBackup({ ...backup, type: 'other' }), /not a backup/);
    assert.throws(() => parseBackupBytes(utf8Encode('hello')), /not JSON/);
    assert.throws(() => parseBackupBytes(utf8Encode('{"type":"seal-backup","v":1}')), /missing field/);
  });

  test('refuses passphrases shorter than 12 characters', async () => {
    const { jwk, publicKey } = await freshKey();
    const error = await assert.rejects(() => createBackup({ privateJwk: jwk, publicKey, passphrase: 'short pass' }));
    assert.equal(error.code, 'weak');
  });

  test('passphrases are compared in Unicode NFC', async () => {
    const { jwk, publicKey } = await freshKey();
    const nfc = 'café crème brûlée';
    const backup = await createBackup({ privateJwk: jwk, publicKey, passphrase: nfc });
    const opened = await openBackup(backup, nfc.normalize('NFD'));
    assert.deepEqual(opened.privateJwk, jwk);
  });

  test('a backup of a fixed key opens to that key', async () => {
    const { privateKey, publicKey } = await testIdentity(0, { extractable: true });
    const jwk = await exportPrivateJwk(privateKey);
    const backup = await createBackup({ privateJwk: jwk, publicKey, passphrase: PASS, createdAt: '2026-09-25T12:00:00Z' });
    assert.equal(backup.seal_id, 'SEAL-47Z3-3QX1-AJH6-2RKB');
    assert.equal(backupFileName(backup.seal_id), 'seal-backup-SEAL-47Z3-3QX1-AJH6-2RKB.json');
    assert.deepEqual(Object.keys(backup), ['type', 'v', 'about', 'seal_id', 'pub', 'created_at', 'kdf', 'cipher', 'ct']);
    const opened = await openBackup(JSON.parse(utf8Decode(utf8Encode(backupFileText(backup)))), PASS);
    assert.equal(opened.privateJwk.d, jwk.d);
  });
});

describe('key storage', () => {
  const dbName = () => `seal-test-${Math.random().toString(36).slice(2)}`;

  test('stores the private key as non-extractable; export attempts fail', async () => {
    const name = dbName();
    const store = await openKeystore(name);
    try {
      const { jwk, publicKey } = await freshKey();
      const locked = await importPrivateJwk(jwk);
      await store.saveIdentity({ privateKey: locked, publicKey, sealId: 'SEAL-TEST-TEST-TEST-TEST', createdAt: '2026-09-25T12:00:00Z', origin: 'created' });
      store.close();
      const reopened = await openKeystore(name);
      const identity = await reopened.loadIdentity();
      reopened.close();
      assert.ok(identity.privateKey instanceof CryptoKey);
      assert.equal(identity.privateKey.extractable, false);
      await assert.rejects(() => crypto.subtle.exportKey('jwk', identity.privateKey));
      await assert.rejects(() => crypto.subtle.exportKey('pkcs8', identity.privateKey));
      await assert.rejects(() => crypto.subtle.exportKey('raw', identity.privateKey));
      assert.ok(await keysMatch(identity.privateKey, identity.publicKey), 'the stored key still signs');
      assert.deepEqual(identity.publicKey, publicKey);
    } finally {
      store.close();
      await deleteKeystore(name);
    }
  });

  test('refuses to store an extractable private key', async () => {
    const name = dbName();
    const store = await openKeystore(name);
    try {
      const { pair, publicKey } = await freshKey();
      assert.equal(pair.privateKey.extractable, true);
      await assert.rejects(() => store.saveIdentity({ privateKey: pair.privateKey, publicKey, sealId: 'x', createdAt: 'x', origin: 'created' }), /extractable/);
      assert.equal(await store.loadIdentity(), null);
    } finally {
      store.close();
      await deleteKeystore(name);
    }
  });

  test('deleting the seal removes it; a second seal needs the first deleted', async () => {
    const name = dbName();
    const store = await openKeystore(name);
    try {
      const a = await freshKey();
      const b = await freshKey();
      await store.saveIdentity({ privateKey: await importPrivateJwk(a.jwk), publicKey: a.publicKey, sealId: 'SEAL-A', createdAt: 'x', origin: 'created' });
      const lockedB = await importPrivateJwk(b.jwk);
      await assert.rejects(() => store.saveIdentity({ privateKey: lockedB, publicKey: b.publicKey, sealId: 'SEAL-B', createdAt: 'x', origin: 'created' }), /Delete it first/);
      await store.deleteIdentity();
      assert.equal(await store.loadIdentity(), null);
      await store.saveIdentity({ privateKey: await importPrivateJwk(b.jwk), publicKey: b.publicKey, sealId: 'SEAL-B', createdAt: 'x', origin: 'restored' });
      assert.equal((await store.loadIdentity()).sealId, 'SEAL-B');
    } finally {
      store.close();
      await deleteKeystore(name);
    }
  });

  test('known seals and revocations are saved, listed and removed', async () => {
    const name = dbName();
    const store = await openKeystore(name);
    try {
      await store.saveKnown({ sealId: 'SEAL-2222-2222-2222-2222', name: 'Priya' });
      await store.saveKnown({ sealId: 'SEAL-1111-1111-1111-1111', name: 'Ada', publicKey: new Uint8Array(32) });
      assert.deepEqual((await store.listKnown()).map((k) => k.name), ['Ada', 'Priya']);
      await store.saveKnown({ sealId: 'SEAL-2222-2222-2222-2222', name: 'Priya S.' });
      assert.equal((await store.listKnown()).length, 2, 'saving again renames');
      await store.deleteKnown('SEAL-1111-1111-1111-1111');
      assert.deepEqual((await store.listKnown()).map((k) => k.name), ['Priya S.']);
      await store.saveRevocation('SEAL-2222-2222-2222-2222', { manifest: { revoked: true }, sig: 'x' });
      assert.equal((await store.listRevocations()).length, 1);
      await store.deleteRevocation('SEAL-2222-2222-2222-2222');
      assert.equal((await store.listRevocations()).length, 0);
    } finally {
      store.close();
      await deleteKeystore(name);
    }
  });
});

describe('passphrase hint', () => {
  test('enforces the minimum length', () => {
    assert.equal(assessPassphrase('').ok, false);
    assert.equal(assessPassphrase('elevenchars').ok, false);
    assert.match(assessPassphrase('elevenchars').message, /1 more/);
    assert.equal(assessPassphrase('twelve chars').ok, true);
  });

  test('refuses trivially guessable passphrases', () => {
    for (const p of ['aaaaaaaaaaaaaaaa', 'abababababab', 'password1234', 'Password123!', '123456789012', 'qwertyuiop12', 'correct horse battery staple']) {
      assert.equal(assessPassphrase(p).ok, false, p);
    }
  });

  test('ranks longer, more varied passphrases higher', () => {
    assert.ok(assessPassphrase('lapis river clay moon').level <= 2);
    assert.ok(assessPassphrase('lapis river clay moon tablet reed').level >= 3);
    assert.equal(assessPassphrase('Tr4v3l-Clay-Lapis-9, Ur!').level, 4);
    assert.ok(assessPassphrase('mesopotamia').level === 0);
  });
});
