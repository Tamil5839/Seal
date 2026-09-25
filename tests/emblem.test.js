import { assert, describe, test } from './harness.js';
import { RFC8032, pseudoRandomBytes } from './fixtures.js';
import { fromHex } from '../js/lib/bytes.js';
import { emblemBandSvg, emblemPlan, emblemStampSvg, makeRng } from '../js/lib/emblem.js';
import { sha256Hex } from '../js/lib/hash.js';
import { fingerprint } from '../js/lib/seal-id.js';

// SHA-256 of the SVG text for the fixed test keys, computed in Node.js (a
// different JavaScript runtime and process). If the emblem design changes on
// purpose, update these values - existing seals will then show new emblems,
// so such a change should be rare and announced.
const GOLDEN = [
  { band: 'cf21f3e1e50644130dd5bfdf1f6809bda83b11a813ce329af0dd1ee096d6c410', stamp: '637cbfb773f7e111ce6159cf5e792b770db188c67c2aaa421f50584cbf975a44' },
  { band: '2abca334b0cabbcfa029372e2f1878ed12d4e98a7eea8084874add68d43b8451', stamp: 'a62f58948c6f41d1d15f9fe0915feaffe5cb30be5c979b1da905202c427444e1' },
  { band: '5cd7824c607d4a094811bd6b0cca78bafce45ceba42f77e89fbc70f5157413fb', stamp: 'ef092e2fe7dee9aae5436ae30f71ff19b0a4e9532cda320c405f92f0855917c5' },
];

const utf8 = (s) => new TextEncoder().encode(s);

function parseSvg(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  assert.equal(doc.querySelector('parsererror'), null, 'well-formed SVG');
  return doc;
}

describe('emblem', () => {
  test('matches golden values computed in another runtime (fixed test keys)', async () => {
    for (let i = 0; i < GOLDEN.length; i++) {
      const fp = await fingerprint(fromHex(RFC8032[i].public));
      assert.equal(await sha256Hex(utf8(emblemBandSvg(fp))), GOLDEN[i].band, `band ${i}`);
      assert.equal(await sha256Hex(utf8(emblemStampSvg(fp))), GOLDEN[i].stamp, `stamp ${i}`);
    }
  });

  test('is identical across repeated runs', async () => {
    const fp = await fingerprint(fromHex(RFC8032[0].public));
    const first = emblemBandSvg(fp);
    for (let i = 0; i < 5; i++) {
      assert.equal(emblemBandSvg(new Uint8Array(fp)), first);
      assert.deepEqual(emblemPlan(fp), emblemPlan(new Uint8Array(fp)));
    }
    assert.equal(emblemStampSvg(fp), emblemStampSvg(new Uint8Array(fp)));
  });

  test('different keys give different emblems', () => {
    const seen = new Set();
    const plans = new Set();
    for (let i = 0; i < 400; i++) {
      const fp = pseudoRandomBytes(32, i + 1);
      seen.add(emblemBandSvg(fp));
      const plan = emblemPlan(fp);
      plans.add(JSON.stringify([plan.border.style, plan.panels.map((p) => p.motif), plan.gaps.map((g) => g.type)]));
    }
    assert.equal(seen.size, 400, 'every SVG differs');
    assert.ok(plans.size >= 396, `visible layouts are nearly always distinct (${plans.size}/400)`);
  });

  test('a single changed fingerprint bit changes the emblem', () => {
    const fp = pseudoRandomBytes(32, 99);
    const base = emblemBandSvg(fp);
    for (const byte of [0, 7, 15, 16, 31]) {
      const changed = new Uint8Array(fp);
      changed[byte] ^= 1;
      assert.notEqual(emblemBandSvg(changed), base, `byte ${byte}`);
    }
  });

  test('is well-formed SVG with a title, and unique ids', async () => {
    const fp = await fingerprint(fromHex(RFC8032[0].public));
    for (const svg of [emblemBandSvg(fp), emblemStampSvg(fp)]) {
      const doc = parseSvg(svg);
      assert.match(doc.querySelector('title').textContent, /SEAL-47Z3-3QX1-AJH6-2RKB/);
      const ids = [...doc.querySelectorAll('[id]')].map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length, 'ids are unique');
      assert.equal(doc.documentElement.getAttribute('role'), 'img');
      assert.equal(/style=|<style|<script|javascript:/i.test(svg), false, 'no inline styles or scripts (CSP-safe)');
    }
    const a = emblemBandSvg(fp, { idPrefix: 'one' });
    const b = emblemBandSvg(fp, { idPrefix: 'two' });
    assert.ok(a.includes('id="one-art"') && b.includes('id="two-art"'));
  });

  test('every motif is used, and plans stay within the designed sizes', () => {
    const used = new Set();
    for (let i = 0; i < 300; i++) {
      const plan = emblemPlan(pseudoRandomBytes(32, 1000 + i));
      plan.panels.forEach((p) => used.add(p.motif));
      assert.ok(plan.panels.length >= 3 && plan.panels.length <= 5);
      assert.ok(plan.period >= 200 && plan.period <= 700, `period ${plan.period}`);
      assert.ok(plan.phase >= 0 && plan.phase < plan.period);
    }
    assert.equal(used.size, 15);
  });

  test('the generator uses no floating-point functions that can differ between browsers', async () => {
    for (const file of ['../js/lib/emblem.js', '../js/lib/motifs.js']) {
      const text = await (await fetch(new URL(file, import.meta.url))).text();
      const source = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      const forbidden = source.match(/Math\.(sin|cos|tan|asin|acos|atan2?|sqrt|cbrt|pow|exp|expm1|log\w*|hypot|random|fround)\b|\*\*|Date\b|performance\./g);
      assert.equal(forbidden, null, `${file}: ${forbidden}`);
    }
  });

  test('the PRNG is a plain 32-bit integer sequence', () => {
    const rng = makeRng(new Uint8Array(32));
    const values = Array.from({ length: 5 }, () => rng.next());
    assert.ok(values.every((v) => Number.isInteger(v) && v >= 0 && v < 2 ** 32));
    const again = makeRng(new Uint8Array(32));
    assert.deepEqual(Array.from({ length: 5 }, () => again.next()), values);
  });
});
