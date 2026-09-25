import { assert, describe, test } from './harness.js';
import { DECLARED, RFC8032, flipByte, pseudoRandomBytes, sampleImage, samplePdf, testIdentity } from './fixtures.js';
import { base64urlEncode, fromHex, utf8Decode, utf8Encode } from '../js/lib/bytes.js';
import { buildRevocationManifest, parseSealBytes, sealFileText, signManifest } from '../js/lib/manifest.js';
import { embedOption, sealFile, sealedFileName, sidecarFileName } from '../js/lib/sealer.js';
import { classifyFile, verifyFiles } from '../js/lib/verifier.js';

async function seal(bytes, name, mode, { identity = 0, note = 'test note', type = '' } = {}) {
  const { privateKey, publicKey } = await testIdentity(identity);
  return sealFile({ bytes, name, type, mode, privateKey, publicKey, declaredAt: DECLARED, note });
}

/** Verify and return the checks of the (single) content file. */
async function checksFor(files) {
  const report = await verifyFiles(files);
  const item = report.items.find((i) => i.type === 'file');
  assert.ok(item, 'a file result');
  return item.checks;
}

async function statusOf(files) {
  const checks = await checksFor(files);
  return checks.length ? checks.map((c) => c.status).join(',') : 'none';
}

async function samples() {
  return {
    'photo.png': await sampleImage('image/png'),
    'photo.jpg': await sampleImage('image/jpeg'),
    'paper.pdf': samplePdf(),
    'notes.txt': utf8Encode('Hello, clay.\nSecond line.\n'),
    'data.bin': pseudoRandomBytes(5000, 42),
    'empty.dat': new Uint8Array(0),
  };
}

describe('sidecar seals', () => {
  test('seal then verify is INTACT for images, PDF, text, binary and empty files', async () => {
    for (const [name, bytes] of Object.entries(await samples())) {
      const { output, seal: s } = await seal(bytes, name, 'sidecar');
      assert.equal(output.name, `${name}.seal`);
      const checks = await checksFor([{ name, bytes }, { name: output.name, bytes: output.bytes }]);
      assert.equal(checks.length, 1, name);
      assert.equal(checks[0].status, 'intact', name);
      assert.equal(checks[0].source, 'sidecar');
      assert.equal(checks[0].signer.sealId, 'SEAL-47Z3-3QX1-AJH6-2RKB');
      assert.equal(checks[0].manifest.note, 'test note');
      assert.equal(checks[0].manifest.size, bytes.length);
      assert.equal(s.manifest.name, name);
    }
  });

  test('changing one byte anywhere makes it ALTERED', async () => {
    for (const [name, bytes] of Object.entries(await samples())) {
      if (!bytes.length) continue;
      const { output } = await seal(bytes, name, 'sidecar');
      const positions = [0, bytes.length >> 1, bytes.length - 1];
      for (const pos of positions) {
        for (const mask of [0x01, 0x80]) {
          const changed = flipByte(bytes, pos, mask);
          const status = await statusOf([{ name, bytes: changed }, { name: output.name, bytes: output.bytes }]);
          assert.equal(status, 'altered', `${name} byte ${pos} mask ${mask}`);
        }
      }
      const appended = new Uint8Array(bytes.length + 1);
      appended.set(bytes);
      assert.equal(await statusOf([{ name, bytes: appended }, { name: output.name, bytes: output.bytes }]), 'altered', `${name} appended`);
      assert.equal(await statusOf([{ name, bytes: bytes.subarray(1) }, { name: output.name, bytes: output.bytes }]), 'altered', `${name} truncated`);
    }
  });

  test('every byte position of a small file is covered', async () => {
    const bytes = pseudoRandomBytes(64, 3);
    const { output } = await seal(bytes, 'small.bin', 'sidecar');
    for (let i = 0; i < bytes.length; i++) {
      assert.equal(await statusOf([{ name: 'small.bin', bytes: flipByte(bytes, i) }, { name: output.name, bytes: output.bytes }]), 'altered', `byte ${i}`);
    }
  });

  test('swapping the public key in the manifest makes it INVALID', async () => {
    const bytes = samplePdf();
    const { seal: s } = await seal(bytes, 'paper.pdf', 'sidecar');
    const swapped = { manifest: { ...s.manifest, pub: base64urlEncode(fromHex(RFC8032[2].public)) }, sig: s.sig };
    const checks = await checksFor([{ name: 'paper.pdf', bytes }, { name: 'paper.pdf.seal', bytes: utf8Encode(sealFileText(swapped)) }]);
    assert.equal(checks[0].status, 'invalid');
    assert.equal(checks[0].signer, undefined, 'an invalid seal names no signer');
  });

  test('editing the date, note or name makes it INVALID', async () => {
    const bytes = utf8Encode('some words');
    const { seal: s } = await seal(bytes, 'words.txt', 'sidecar');
    for (const [key, value] of [['declared_at', '2001-01-01T00:00:00Z'], ['note', 'a different note'], ['name', 'other.txt']]) {
      const edited = { manifest: { ...s.manifest, [key]: value }, sig: s.sig };
      const checks = await checksFor([{ name: 'words.txt', bytes }, { name: 'words.txt.seal', bytes: utf8Encode(sealFileText(edited)) }]);
      assert.equal(checks[0].status, 'invalid', key);
    }
  });

  test('a damaged .seal file is INVALID, and a file alone has NO SEAL', async () => {
    const bytes = utf8Encode('plain');
    assert.equal(await statusOf([{ name: 'plain.txt', bytes }, { name: 'plain.txt.seal', bytes: utf8Encode('{"manifest": 1') }]), 'invalid');
    assert.equal(await statusOf([{ name: 'plain.txt', bytes }, { name: 'plain.txt.seal', bytes: new Uint8Array([0xff, 0x00]) }]), 'invalid');
    assert.equal(await statusOf([{ name: 'plain.txt', bytes }]), 'none');
  });

  test('a .seal file on its own reports who sealed which file', async () => {
    const { output } = await seal(utf8Encode('abc'), 'abc.txt', 'sidecar');
    const report = await verifyFiles([{ name: output.name, bytes: output.bytes }]);
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0].type, 'seal');
    assert.equal(report.items[0].status, 'valid');
    assert.equal(report.items[0].manifest.name, 'abc.txt');
    assert.equal(report.items[0].signer.sealId, 'SEAL-47Z3-3QX1-AJH6-2RKB');
  });

  test('seal files are paired with their files by fingerprint, even when renamed', async () => {
    const a = utf8Encode('file A');
    const b = utf8Encode('file B');
    const sa = await seal(a, 'a.txt', 'sidecar');
    const sb = await seal(b, 'b.txt', 'sidecar', { identity: 1 });
    const report = await verifyFiles([
      { name: 'renamed-b.txt', bytes: b },
      { name: 'x.seal', bytes: sa.output.bytes },
      { name: 'renamed-a.txt', bytes: a },
      { name: 'y.seal', bytes: sb.output.bytes },
    ]);
    assert.equal(report.items.length, 2);
    assert.equal(report.items[0].fileName, 'renamed-b.txt');
    assert.equal(report.items[0].checks[0].status, 'intact');
    assert.equal(report.items[0].checks[0].signer.sealId, 'SEAL-77VH-7M56-8GJK-Y12J');
    assert.equal(report.items[1].fileName, 'renamed-a.txt');
    assert.equal(report.items[1].checks[0].signer.sealId, 'SEAL-47Z3-3QX1-AJH6-2RKB');
  });

  test('a changed file is still paired with its seal by name, and shows ALTERED', async () => {
    const original = utf8Encode('version 1');
    const { output } = await seal(original, 'doc.txt', 'sidecar');
    const report = await verifyFiles([
      { name: 'doc.txt', bytes: utf8Encode('version 2') },
      { name: 'other.txt', bytes: utf8Encode('unrelated') },
      { name: output.name, bytes: output.bytes },
    ]);
    assert.equal(report.items[0].checks[0].status, 'altered');
    assert.equal(report.items[1].checks.length, 0);
  });

  test('recognises seal files by content even without the .seal extension', async () => {
    const { output } = await seal(utf8Encode('x'), 'x.txt', 'sidecar');
    assert.equal(classifyFile({ name: 'x.txt.seal.json', bytes: output.bytes }).role, 'seal');
    assert.equal(classifyFile({ name: 'x.txt', bytes: utf8Encode('{"a": 1}') }).role, 'content');
    assert.equal(classifyFile({ name: 'broken.seal', bytes: utf8Encode('nope') }).role, 'seal');
  });
});

describe('revocation', () => {
  async function notice(identity = 0) {
    const { privateKey, publicKey } = await testIdentity(identity);
    const n = await signManifest(privateKey, buildRevocationManifest({ publicKey, declaredAt: DECLARED, note: 'lost my laptop' }));
    return utf8Encode(sealFileText(n));
  }

  test('a matching revocation notice marks the seal as revoked', async () => {
    const bytes = utf8Encode('revoked content');
    const { output } = await seal(bytes, 'r.txt', 'sidecar');
    const report = await verifyFiles([
      { name: 'r.txt', bytes },
      { name: output.name, bytes: output.bytes },
      { name: 'revocation-SEAL-47Z3-3QX1-AJH6-2RKB.seal', bytes: await notice(0) },
    ]);
    const check = report.items[0].checks[0];
    assert.equal(check.status, 'intact');
    assert.ok(check.revocation, 'revocation attached');
    assert.equal(check.revocation.manifest.note, 'lost my laptop');
    const rev = report.items.find((i) => i.type === 'revocation');
    assert.equal(rev.status, 'valid');
    assert.equal(rev.matched, true);
  });

  test('a revocation notice for another key does not apply', async () => {
    const bytes = utf8Encode('content');
    const { output } = await seal(bytes, 'c.txt', 'sidecar');
    const report = await verifyFiles([{ name: 'c.txt', bytes }, { name: output.name, bytes: output.bytes }, { name: 'n.seal', bytes: await notice(1) }]);
    assert.equal(report.items[0].checks[0].revocation, undefined);
    assert.equal(report.items.find((i) => i.type === 'revocation').matched, false);
  });

  test('a forged revocation notice is invalid and does not apply', async () => {
    const bytes = utf8Encode('content');
    const { output } = await seal(bytes, 'c.txt', 'sidecar');
    const forged = parseSealBytes(await notice(1));
    forged.manifest.pub = base64urlEncode(fromHex(RFC8032[0].public)); // claims to revoke key 0, signed by key 1
    const report = await verifyFiles([{ name: 'c.txt', bytes }, { name: output.name, bytes: output.bytes }, { name: 'n.seal', bytes: utf8Encode(JSON.stringify(forged)) }]);
    assert.equal(report.items[0].checks[0].revocation, undefined);
    assert.equal(report.items.find((i) => i.type === 'revocation').status, 'invalid');
  });

  test('revocation notices saved on the device also apply', async () => {
    const bytes = utf8Encode('content');
    const { output } = await seal(bytes, 'c.txt', 'sidecar');
    const saved = parseSealBytes(await notice(0));
    const report = await verifyFiles([{ name: 'c.txt', bytes }, { name: output.name, bytes: output.bytes }], { savedRevocations: [saved] });
    assert.ok(report.items[0].checks[0].revocation.saved);
  });
});

describe('embed options', () => {
  test('PNG and text can embed; other types use a .seal file', async () => {
    const s = await samples();
    assert.equal(embedOption({ name: 'photo.png', type: 'image/png', bytes: s['photo.png'] }).embed, 'png');
    assert.equal(embedOption({ name: 'notes.txt', type: 'text/plain', bytes: s['notes.txt'] }).embed, 'text');
    assert.equal(embedOption({ name: 'README.md', type: '', bytes: s['notes.txt'] }).embed, 'text');
    assert.equal(embedOption({ name: 'photo.jpg', type: 'image/jpeg', bytes: s['photo.jpg'] }).embed, null);
    assert.equal(embedOption({ name: 'paper.pdf', type: 'application/pdf', bytes: s['paper.pdf'] }).embed, null);
    assert.equal(embedOption({ name: 'latin1.txt', type: 'text/plain', bytes: new Uint8Array([0x63, 0x61, 0x66, 0xe9]) }).embed, null);
    assert.equal(embedOption({ name: 'data.json', type: 'application/json', bytes: utf8Encode('{}') }).embed, null);
  });

  test('output file names', () => {
    assert.equal(sealedFileName('photo.png'), 'photo-sealed.png');
    assert.equal(sealedFileName('Notes.MD'), 'Notes-sealed.MD');
    assert.equal(sealedFileName('README'), 'README-sealed');
    assert.equal(sealedFileName('.env'), '.env-sealed');
    assert.equal(sidecarFileName('a.tar.gz'), 'a.tar.gz.seal');
  });

  test('the seal file is readable JSON with sorted manifest keys', async () => {
    const { output } = await seal(utf8Encode('x'), 'x.txt', 'sidecar');
    const text = utf8Decode(output.bytes);
    assert.match(text, /^\{\n {2}"manifest": \{\n {4}"alg": "Ed25519",\n {4}"declared_at"/);
    assert.deepEqual(Object.keys(JSON.parse(text)), ['manifest', 'sig']);
  });
});
