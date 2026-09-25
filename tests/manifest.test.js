import { assert, describe, test } from './harness.js';
import { DECLARED, RFC8032, testIdentity } from './fixtures.js';
import { base64urlEncode, fromHex } from '../js/lib/bytes.js';
import { canonicalize } from '../js/lib/canonical-json.js';
import {
  NOTE_MAX_CHARS, buildFileManifest, buildRevocationManifest, checkManifest, checkSealObject, formatTimestamp,
  isValidTimestamp, parseSealBytes, parseSealText, sanitizeName, sanitizeNote, sealFileText, signManifest, verifySealObject,
} from '../js/lib/manifest.js';

const SHA = 'ab'.repeat(32);

async function sampleSeal(overrides = {}) {
  const { privateKey, publicKey } = await testIdentity(0);
  const manifest = buildFileManifest({ publicKey, sha256: SHA, size: 1234, name: 'photo.jpg', declaredAt: DECLARED, note: 'hello', ...overrides });
  return { seal: await signManifest(privateKey, manifest), privateKey, publicKey };
}

describe('manifest', () => {
  test('has exactly the documented fields', async () => {
    const { seal } = await sampleSeal();
    assert.deepEqual(Object.keys(seal.manifest).sort(), ['alg', 'declared_at', 'name', 'note', 'pub', 'sha256', 'size', 'v']);
    assert.equal(seal.manifest.v, 1);
    assert.equal(seal.manifest.alg, 'Ed25519');
    assert.equal(seal.manifest.pub, base64urlEncode(fromHex(RFC8032[0].public)));
    assert.equal(seal.sig.length, 86);
  });

  test('omits an empty note', async () => {
    const { seal } = await sampleSeal({ note: '   ' });
    assert.equal('note' in seal.manifest, false);
  });

  test('signature is over the canonical manifest bytes', async () => {
    const { seal } = await sampleSeal();
    const expected = '{"alg":"Ed25519","declared_at":"2026-09-25T12:00:00Z","name":"photo.jpg","note":"hello",' +
      `"pub":"${seal.manifest.pub}","sha256":"${SHA}","size":1234,"v":1}`;
    assert.equal(canonicalize(seal.manifest), expected);
    // Ed25519 is deterministic, so this fixed key and manifest always give the same signature.
    const again = await signManifest((await testIdentity(0)).privateKey, JSON.parse(JSON.stringify(seal.manifest)));
    assert.equal(again.sig, seal.sig);
  });

  test('a valid seal verifies and names its Seal ID', async () => {
    const { seal } = await sampleSeal();
    const result = await verifySealObject(seal);
    assert.equal(result.valid, true);
    assert.equal(result.kind, 'file');
    assert.equal(result.sealId, 'SEAL-47Z3-3QX1-AJH6-2RKB');
  });

  test('key order and formatting of the seal file do not matter', async () => {
    const { seal } = await sampleSeal();
    const reordered = JSON.parse(`{"sig":"${seal.sig}","manifest":${JSON.stringify(Object.fromEntries(Object.entries(seal.manifest).reverse()), null, 4)}}`);
    assert.equal((await verifySealObject(reordered)).valid, true);
    const text = sealFileText(seal);
    assert.equal((await verifySealObject(parseSealText(text))).valid, true);
    assert.equal((await verifySealObject(parseSealText('﻿' + text))).valid, true, 'a BOM added by an editor is tolerated');
  });

  test('editing any field invalidates the signature', async () => {
    const { seal } = await sampleSeal();
    const edits = {
      declared_at: '2020-01-01T00:00:00Z',
      note: 'hello!',
      name: 'photo2.jpg',
      sha256: 'cd'.repeat(32),
      size: 1235,
    };
    for (const [key, value] of Object.entries(edits)) {
      const edited = { manifest: { ...seal.manifest, [key]: value }, sig: seal.sig };
      const result = await verifySealObject(edited);
      assert.equal(result.valid, false, key);
      assert.equal(result.malformed, false, key);
    }
    const noNote = { manifest: { ...seal.manifest }, sig: seal.sig };
    delete noNote.manifest.note;
    assert.equal((await verifySealObject(noNote)).valid, false, 'removing the note');
  });

  test('swapping in another public key invalidates the seal', async () => {
    const { seal } = await sampleSeal();
    const swapped = { manifest: { ...seal.manifest, pub: base64urlEncode(fromHex(RFC8032[1].public)) }, sig: seal.sig };
    const result = await verifySealObject(swapped);
    assert.equal(result.valid, false);
    // Re-signing with the other key gives a valid seal for the *other* Seal ID, never the original.
    const other = await testIdentity(1);
    const resigned = await signManifest(other.privateKey, swapped.manifest);
    assert.equal((await verifySealObject(resigned)).sealId, 'SEAL-77VH-7M56-8GJK-Y12J');
  });

  test('a changed signature byte invalidates the seal', async () => {
    const { seal } = await sampleSeal();
    const chars = seal.sig.split('');
    chars[10] = chars[10] === 'A' ? 'B' : 'A';
    assert.equal((await verifySealObject({ manifest: seal.manifest, sig: chars.join('') })).valid, false);
  });

  test('unknown, missing or malformed fields make a seal malformed', async () => {
    const { seal } = await sampleSeal();
    const bad = [
      { ...seal.manifest, extra: 1 },
      { ...seal.manifest, v: 2 },
      { ...seal.manifest, v: '1' },
      { ...seal.manifest, alg: 'RSA' },
      { ...seal.manifest, sha256: SHA.toUpperCase() },
      { ...seal.manifest, sha256: 'ab' },
      { ...seal.manifest, size: -1 },
      { ...seal.manifest, size: 1.5 },
      { ...seal.manifest, size: '1234' },
      { ...seal.manifest, name: '' },
      { ...seal.manifest, name: 'a‮gpj.exe' },
      { ...seal.manifest, name: 'two\nlines' },
      { ...seal.manifest, note: 'x'.repeat(NOTE_MAX_CHARS + 1) },
      { ...seal.manifest, note: '' },
      { ...seal.manifest, declared_at: '2026-09-25 12:00:00' },
      { ...seal.manifest, declared_at: '2026-02-30T12:00:00Z' },
      { ...seal.manifest, declared_at: '2026-09-25T12:00:00.000Z' },
      { ...seal.manifest, pub: seal.manifest.pub + 'A' },
      { ...seal.manifest, revoked: true },
      Object.fromEntries(Object.entries(seal.manifest).filter(([k]) => k !== 'size')),
    ];
    for (const manifest of bad) {
      const result = await verifySealObject({ manifest, sig: seal.sig });
      assert.equal(result.valid, false, JSON.stringify(manifest));
      assert.equal(result.malformed, true, JSON.stringify(manifest));
    }
    for (const outer of [null, [], 'x', { manifest: seal.manifest }, { sig: seal.sig }, { ...seal, extra: 1 }, { manifest: seal.manifest, sig: 'short' }]) {
      const result = await verifySealObject(outer);
      assert.equal(result.valid, false);
      assert.equal(result.malformed, true);
    }
  });

  test('a note of exactly 280 characters (emoji count once) is allowed', async () => {
    const note = '😀'.repeat(NOTE_MAX_CHARS);
    const { seal } = await sampleSeal({ note });
    assert.equal((await verifySealObject(seal)).valid, true);
    assert.throws(() => checkManifest({ ...seal.manifest, note: note + 'x' }), /longer than 280/);
  });

  test('sealing refuses manifests that could not verify', async () => {
    const { privateKey } = await testIdentity(0);
    await assert.rejects(() => signManifest(privateKey, { v: 1 }), /missing field/);
    assert.throws(() => buildFileManifest({ publicKey: fromHex(RFC8032[0].public), sha256: SHA, size: 1, name: 'a', declaredAt: 'yesterday' }), /declared_at/);
  });

  test('names and notes are cleaned before sealing', () => {
    assert.equal(sanitizeName('  re‮port\u0007.pdf '), 'report.pdf');
    assert.equal(sanitizeName('\u0000'), 'file');
    assert.equal(sanitizeName('é.txt'), 'é.txt', 'NFC');
    assert.equal(sanitizeName('x\ud800y.txt'), 'xy.txt', 'lone surrogate removed');
    assert.equal(sanitizeName('😀.png'), '😀.png');
    assert.equal(sanitizeNote(' line one\r\nline two‮ '), 'line one\nline two');
  });

  test('timestamps', () => {
    assert.ok(isValidTimestamp('2026-09-25T12:00:00Z'));
    assert.ok(isValidTimestamp('2024-02-29T23:59:59Z'));
    assert.equal(isValidTimestamp('2023-02-29T00:00:00Z'), false);
    assert.equal(isValidTimestamp('2026-09-25T24:00:00Z'), false);
    assert.equal(isValidTimestamp('2026-09-25T12:00:00+01:00'), false);
    assert.equal(formatTimestamp(new Date(Date.UTC(2026, 8, 25, 12, 0, 0, 999))), '2026-09-25T12:00:00Z');
  });

  test('seal files are parsed strictly', () => {
    assert.throws(() => parseSealBytes(new Uint8Array([0xff, 0xfe])), /UTF-8/);
    assert.throws(() => parseSealBytes(new TextEncoder().encode('{nope')), /JSON/);
    assert.throws(() => parseSealBytes(new Uint8Array(70 * 1024)), /too large/);
  });
});

describe('revocation notices', () => {
  test('a revocation notice verifies with kind "revocation"', async () => {
    const { privateKey, publicKey } = await testIdentity(0);
    const notice = await signManifest(privateKey, buildRevocationManifest({ publicKey, declaredAt: DECLARED, note: 'key stolen' }));
    assert.deepEqual(Object.keys(notice.manifest).sort(), ['alg', 'declared_at', 'note', 'pub', 'revoked', 'v']);
    const result = await verifySealObject(notice);
    assert.equal(result.valid, true);
    assert.equal(result.kind, 'revocation');
  });

  test('file seals and revocation notices cannot be mixed up', async () => {
    const { privateKey, publicKey } = await testIdentity(0);
    const notice = await signManifest(privateKey, buildRevocationManifest({ publicKey, declaredAt: DECLARED }));
    const mixed = { ...notice.manifest, sha256: SHA, size: 1, name: 'x' };
    assert.throws(() => checkSealObject({ manifest: mixed, sig: notice.sig }), /unknown field/);
    assert.throws(() => checkManifest({ ...notice.manifest, revoked: false }), /must be true/);
  });
});
