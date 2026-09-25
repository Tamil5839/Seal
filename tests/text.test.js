import { assert, describe, test } from './harness.js';
import { DECLARED, testIdentity } from './fixtures.js';
import { base64urlDecode, utf8Decode, utf8Encode } from '../js/lib/bytes.js';
import { canonicalize } from '../js/lib/canonical-json.js';
import { sealFile } from '../js/lib/sealer.js';
import { BEGIN_MARKER, END_MARKER, canonicalizeText, parseClearSealed } from '../js/lib/text-seal.js';
import { verifyFiles } from '../js/lib/verifier.js';

async function sealText(text, name = 'poem.txt') {
  const { privateKey, publicKey } = await testIdentity(0);
  const result = await sealFile({ bytes: utf8Encode(text), name, mode: 'text', privateKey, publicKey, declaredAt: DECLARED });
  return { ...result, text: utf8Decode(result.output.bytes) };
}

async function status(text) {
  const report = await verifyFiles([{ name: 'poem-sealed.txt', bytes: utf8Encode(text) }]);
  const checks = report.items[0].checks;
  return checks.length ? checks[0].status : 'none';
}

const toCRLF = (t) => t.replace(/\r?\n/g, '\r\n');
const toLF = (t) => t.replace(/\r\n/g, '\n');

describe('text canonicalization', () => {
  test('converts CRLF and lone CR to LF, applies NFC, changes nothing else', () => {
    assert.equal(canonicalizeText('a\r\nb\rc\nd'), 'a\nb\nc\nd');
    assert.equal(canonicalizeText('a\r\r\nb'), 'a\n\nb');
    assert.equal(canonicalizeText('é'), 'é');
    assert.equal(canonicalizeText('  tabs\tand spaces  \n'), '  tabs\tand spaces  \n');
    assert.equal(canonicalizeText('﻿BOM kept'), '﻿BOM kept');
  });
});

describe('clear-sealed text', () => {
  test('the seal block follows the text and carries the base64url seal JSON', async () => {
    const { text, seal } = await sealText('Line one\nLine two\n');
    assert.ok(text.startsWith('Line one\nLine two\n\n' + BEGIN_MARKER + '\n'));
    assert.ok(text.endsWith(END_MARKER + '\n'));
    const block = parseClearSealed(text);
    assert.equal(block.content, 'Line one\nLine two\n');
    assert.equal(utf8Decode(base64urlDecode(block.payload)), canonicalize(seal));
    const lines = text.split('\n');
    const payloadLines = lines.slice(lines.indexOf(BEGIN_MARKER) + 1, lines.indexOf(END_MARKER));
    assert.ok(payloadLines.every((l) => l.length <= 64 && /^[A-Za-z0-9_-]+$/.test(l)));
    assert.equal(seal.manifest.size, utf8Encode('Line one\nLine two\n').length);
  });

  test('round trips texts with and without a final newline, and empty text', async () => {
    for (const original of ['no final newline', 'final newline\n', 'two\n\n', '', '\n', 'x\n-----BEGIN SEAL-----\nnot a block']) {
      const { text } = await sealText(original);
      assert.equal(await status(text), 'intact', JSON.stringify(original));
      assert.equal(parseClearSealed(text).content, canonicalizeText(original), JSON.stringify(original));
    }
  });

  test('CRLF and LF versions verify identically', async () => {
    const lf = await sealText('first\nsecond\nthird\n');
    assert.equal(await status(lf.text), 'intact');
    assert.equal(await status(toCRLF(lf.text)), 'intact', 'sealed with LF, checked with CRLF');
    const crlf = await sealText('first\r\nsecond\r\nthird\r\n');
    assert.ok(crlf.text.includes('\r\n' + BEGIN_MARKER + '\r\n'), 'block uses the file\'s CRLF line breaks');
    assert.equal(await status(crlf.text), 'intact');
    assert.equal(await status(toLF(crlf.text)), 'intact', 'sealed with CRLF, checked with LF');
    assert.equal(crlf.seal.manifest.sha256, lf.seal.manifest.sha256, 'same canonical text, same fingerprint');
  });

  test('old Mac line endings and a final lone CR work', async () => {
    for (const original of ['a\rb\r', 'a\rb', 'a\nb\r', 'a\r\nb\r']) {
      const { text } = await sealText(original);
      assert.equal(await status(text), 'intact', JSON.stringify(original));
      assert.equal(await status(toLF(text.replace(/\r\n?/g, '\n'))), 'intact', JSON.stringify(original) + ' as LF');
    }
  });

  test('NFC and NFD forms verify identically', async () => {
    const { text } = await sealText('Café crème\n');
    assert.equal(await status(text.normalize('NFD')), 'intact');
  });

  test('other edits break the seal', async () => {
    const { text } = await sealText('The quick brown fox.\nJumps.\n');
    const edits = [
      text.replace('quick', 'quack'),
      text.replace('fox.', 'fox. '),
      text.replace('fox.\n', 'fox.\n\n'),
      text.replace('Jumps.\n\n', 'Jumps.\n'),
      text.replace('The', ' The'),
      text.replace('The', ' The'),
      text.replace('fox', 'fox​'),
      'X' + text,
    ];
    for (const edited of edits) assert.equal(await status(edited), 'altered', JSON.stringify(edited.slice(0, 40)));
  });

  test('text added after the seal block makes it ALTERED; blank lines do not', async () => {
    const { text } = await sealText('Signed words.\n');
    const report = await verifyFiles([{ name: 't.txt', bytes: utf8Encode(text + 'P.S. unsealed extra\n') }]);
    assert.equal(report.items[0].checks[0].status, 'altered');
    assert.equal(report.items[0].checks[0].trailingText, true);
    assert.equal(await status(text + '\n\n  \t\n'), 'intact');
    assert.equal(await status(text.replace(/\n$/, '')), 'intact', 'final newline after END removed');
  });

  test('a re-wrapped payload still verifies; a damaged one is INVALID', async () => {
    const { text } = await sealText('Wrap me.\n');
    const lines = text.split('\n');
    const b = lines.indexOf(BEGIN_MARKER);
    const e = lines.indexOf(END_MARKER);
    const joined = lines.slice(b + 1, e).join('');
    const rewrapped = [...lines.slice(0, b + 1), ...joined.match(/.{1,40}/g), ...lines.slice(e)].join('\n');
    assert.equal(await status(rewrapped), 'intact');
    const replaced = joined[joined.length - 3] === 'A' ? 'B' : 'A';
    const damaged = [...lines.slice(0, b + 1), joined.slice(0, -3) + replaced + joined.slice(-2), ...lines.slice(e)].join('\n');
    assert.equal(await status(damaged), 'invalid');
    const noBegin = text.replace(BEGIN_MARKER, '-----BEGIN SEEL-----');
    assert.equal(await status(noBegin), 'invalid');
  });

  test('damaged BEGIN or END lines make it INVALID, not "no seal"', async () => {
    const { text } = await sealText('Words.\n');
    assert.equal(await status(text.replace(END_MARKER, '-----END SEAM-----')), 'invalid');
    assert.equal(await status(text.replace(END_MARKER, '')), 'invalid');
    assert.equal(await status(text.replace(BEGIN_MARKER, '-----BEGIN SEEL-----')), 'invalid');
    assert.equal(await status(text.replace('\n' + BEGIN_MARKER, 'X' + BEGIN_MARKER)), 'invalid');
  });

  test('text that only mentions the markers (like documentation) has no seal', async () => {
    const doc = `# Format\n\n\`\`\`\noriginal text\n${BEGIN_MARKER}\n<base64url seal JSON>\n${END_MARKER}\n\`\`\`\n\nMore docs.\n`;
    assert.equal(await status(doc), 'none');
    assert.equal(await status(`intro\n${BEGIN_MARKER}\nsee the spec for details\n`), 'none');
  });

  test('a byte-order mark is part of the text', async () => {
    const { text } = await sealText('﻿With BOM\n');
    assert.equal(await status(text), 'intact');
    assert.equal(await status(text.slice(1)), 'altered');
  });

  test('text in a non-UTF-8 re-encoding is reported as ALTERED, not missed', async () => {
    const { text } = await sealText('café\n');
    const bytes = utf8Encode(text);
    const latin1 = new Uint8Array(bytes.length - 1);
    const i = bytes.indexOf(0xc3);
    latin1.set(bytes.subarray(0, i));
    latin1[i] = 0xe9;
    latin1.set(bytes.subarray(i + 2), i + 1);
    const report = await verifyFiles([{ name: 't.txt', bytes: latin1 }]);
    assert.equal(report.items[0].checks[0].status, 'altered');
  });

  test('invalid UTF-8 is ALTERED even where it decodes to the same text', async () => {
    const { text } = await sealText('A replacement character: \ufffd\n');
    assert.equal(await status(text), 'intact');
    const bytes = utf8Encode(text);
    const at = bytes.indexOf(0xef); // U+FFFD is EF BF BD
    const broken = new Uint8Array(bytes.length - 2);
    broken.set(bytes.subarray(0, at));
    broken[at] = 0xff; // an invalid byte: decodes leniently to U+FFFD too
    broken.set(bytes.subarray(at + 3), at + 1);
    const report = await verifyFiles([{ name: 't.txt', bytes: broken }]);
    assert.equal(report.items[0].checks[0].status, 'altered');
    assert.equal(report.items[0].checks[0].invalidUtf8, true);
  });

  test('already clear-sealed text cannot be embedded again', async () => {
    const { text } = await sealText('Once.\n');
    const { privateKey, publicKey } = await testIdentity(1);
    await assert.rejects(() => sealFile({ bytes: utf8Encode(text), name: 'x.txt', mode: 'text', privateKey, publicKey, declaredAt: DECLARED }), /already/);
  });

  test('Markdown is clear-sealed the same way', async () => {
    const { text, output } = await sealText('# Title\n\n*Emphasis*\n', 'README.md');
    assert.equal(output.name, 'README-sealed.md');
    assert.equal(await status(text), 'intact');
  });
});
