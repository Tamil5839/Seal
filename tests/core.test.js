import { assert, describe, test } from './harness.js';
import { EXPECTED_SEAL_IDS, RFC8032, testIdentity } from './fixtures.js';
import {
  base64urlDecode, base64urlDecodeLength, base64urlEncode, bytesEqual, fromHex, toHex, utf8Decode, utf8Encode,
} from '../js/lib/bytes.js';
import { crockfordEncode, crockfordNormalize } from '../js/lib/base32.js';
import { canonicalize } from '../js/lib/canonical-json.js';
import {
  ed25519Supported, exportPrivateJwk, generateKeyPair, importPrivateJwk, importPublicKeyRaw,
  isNonCanonicalPublicKey, isSmallOrderPublicKey, keysMatch, sign, verify,
} from '../js/lib/ed25519.js';
import { sha256Hex } from '../js/lib/hash.js';
import { fingerprint, formatFingerprint, parseSealId, sealIdFromFingerprint, sealIdFromPublicKey } from '../js/lib/seal-id.js';

describe('known test vectors', () => {
  test('SHA-256 (FIPS 180-2 examples)', async () => {
    assert.equal(await sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(await sha256Hex(utf8Encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(
      await sha256Hex(utf8Encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    assert.equal(await sha256Hex(new Uint8Array(1000000).fill(0x61)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  test('Ed25519 is supported by this browser', async () => {
    assert.equal(await ed25519Supported(), true);
  });

  for (let i = 0; i < RFC8032.length; i++) {
    const v = RFC8032[i];
    test(`Ed25519 RFC 8032 ${v.name}: sign and verify`, async () => {
      const { privateKey, publicKey } = await testIdentity(i, { extractable: true });
      const message = fromHex(v.message);
      const signature = await sign(privateKey, message);
      assert.equal(toHex(signature), v.signature, 'signature');
      assert.ok(await verify(publicKey, fromHex(v.signature), message), 'verifies');
      const jwk = await exportPrivateJwk(privateKey);
      assert.equal(toHex(base64urlDecode(jwk.x)), v.public, 'public key derived from the secret key');
      const tampered = new Uint8Array(message.length + 1);
      tampered.set(message);
      assert.equal(await verify(publicKey, fromHex(v.signature), tampered), false, 'rejects a changed message');
    });
  }

  test('Ed25519 rejects a signature under the wrong key', async () => {
    const message = fromHex(RFC8032[1].message);
    assert.equal(await verify(fromHex(RFC8032[0].public), fromHex(RFC8032[1].signature), message), false);
  });
});

describe('weak public keys', () => {
  test('the identity point is blocked (Chromium would accept a forged signature for it)', async () => {
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const forged = new Uint8Array(64);
    forged[0] = 1; // R = identity, S = 0: verifies for every message under the identity key
    assert.ok(isSmallOrderPublicKey(identity));
    assert.equal(await verify(identity, forged, utf8Encode('any message at all')), false);
    await assert.rejects(() => importPublicKeyRaw(identity), /weak/);
  });

  test('all small-order encodings are blocked, with either sign bit', () => {
    const list = [
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0100000000000000000000000000000000000000000000000000000000000000',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    ];
    for (const hex of list) {
      const bytes = fromHex(hex);
      assert.ok(isSmallOrderPublicKey(bytes), hex);
      bytes[31] ^= 0x80;
      assert.ok(isSmallOrderPublicKey(bytes), hex + ' with sign bit flipped');
    }
    for (const v of RFC8032) assert.equal(isSmallOrderPublicKey(fromHex(v.public)), false, v.name);
  });

  test('non-canonical encodings (y >= p) are detected', () => {
    const p = fromHex('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f');
    assert.ok(isNonCanonicalPublicKey(p));
    const pMinus1 = fromHex('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f');
    assert.equal(isNonCanonicalPublicKey(pMinus1), false);
    const big = fromHex('f0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    assert.ok(isNonCanonicalPublicKey(big));
  });
});

describe('key handling', () => {
  test('generated key pairs sign and verify', async () => {
    const pair = await generateKeyPair();
    const jwk = await exportPrivateJwk(pair.privateKey);
    const locked = await importPrivateJwk(jwk);
    assert.equal(locked.extractable, false, 'imported key is not extractable');
    const publicKey = base64urlDecodeLength(jwk.x, 32);
    assert.ok(await keysMatch(locked, publicKey));
    const other = await generateKeyPair();
    const otherJwk = await exportPrivateJwk(other.privateKey);
    assert.equal(await keysMatch(locked, base64urlDecodeLength(otherJwk.x, 32)), false);
  });

  test('a non-extractable private key cannot be exported', async () => {
    const { privateKey } = await testIdentity(0);
    assert.equal(privateKey.extractable, false);
    await assert.rejects(() => crypto.subtle.exportKey('jwk', privateKey));
    await assert.rejects(() => crypto.subtle.exportKey('pkcs8', privateKey));
  });
});

describe('encodings', () => {
  test('hex round trip and strictness', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    assert.equal(toHex(bytes), '00017f80ff');
    assert.deepEqual(fromHex('00017f80ff'), bytes);
    assert.throws(() => fromHex('0'));
    assert.throws(() => fromHex('ZZ'));
    assert.throws(() => fromHex('AB'), /Invalid/, 'uppercase is not accepted');
  });

  test('base64url matches the platform encoder for many lengths', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n * 11) & 0xff);
      const expected = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      assert.equal(base64urlEncode(bytes), expected, `length ${n}`);
      assert.deepEqual(base64urlDecode(expected), bytes, `decode length ${n}`);
    }
  });

  test('base64url decoding is strict', () => {
    assert.throws(() => base64urlDecode('AAA='), /Invalid/, 'padding');
    assert.throws(() => base64urlDecode('AA+A'), /Invalid/, 'standard alphabet');
    assert.throws(() => base64urlDecode('AA A'), /Invalid/, 'whitespace');
    assert.throws(() => base64urlDecode('A'), /Invalid/, 'impossible length');
    assert.throws(() => base64urlDecode('AB'), /Invalid/, 'non-zero trailing bits');
    assert.deepEqual(base64urlDecode('AA'), new Uint8Array([0]));
    assert.throws(() => base64urlDecodeLength('AA', 2), /Expected 2 bytes/);
  });

  test('UTF-8 decoding is strict and keeps a byte-order mark', () => {
    assert.throws(() => utf8Decode(new Uint8Array([0xc3, 0x28])));
    assert.equal(utf8Decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])), '﻿A');
    assert.ok(bytesEqual(utf8Encode('é'), new Uint8Array([0xc3, 0xa9])));
  });

  test('Crockford base32 vectors (checked against an independent implementation)', () => {
    const cases = { '': '', '00': '00', ff: 'ZW', ffff: 'ZZZG', '0102030405': '04106105', deadbeef: 'VTPVXVR', '48656c6c6f': '91JPRV3F' };
    for (const [hex, expected] of Object.entries(cases)) assert.equal(crockfordEncode(fromHex(hex)), expected, hex);
  });

  test('Crockford normalization accepts look-alike characters', () => {
    assert.equal(crockfordNormalize('abc-def oil'), 'ABCDEF011');
    assert.equal(crockfordNormalize('U'), null);
    assert.equal(crockfordNormalize('A*B'), null);
  });
});

describe('canonical JSON', () => {
  test('sorts keys at every level and removes whitespace', () => {
    assert.equal(canonicalize({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  });

  test('escapes strings like JSON.stringify and keeps Unicode', () => {
    assert.equal(canonicalize({ s: 'line\nbreak "quote" \\ é 😀' }), '{"s":"line\\nbreak \\"quote\\" \\\\ é 😀"}');
    assert.equal(canonicalize(' '), '" "');
    assert.equal(canonicalize('\ud800'), '"\\ud800"', 'lone surrogates are escaped');
  });

  test('sorts keys by UTF-16 code units', () => {
    assert.equal(canonicalize({ b: 1, B: 2, a: 3, _: 4, é: 5 }), '{"B":2,"_":4,"a":3,"b":1,"é":5}');
  });

  test('rejects values without a single canonical form', () => {
    assert.throws(() => canonicalize({ n: 1.5 }), /safe integers/);
    assert.throws(() => canonicalize({ n: 2 ** 53 }), /safe integers/);
    assert.throws(() => canonicalize({ n: NaN }), /safe integers/);
    assert.throws(() => canonicalize({ n: undefined }), /Undefined/);
    assert.throws(() => canonicalize({ d: new Date(0) }), /plain objects/);
    assert.throws(() => canonicalize({ f() {} }), /cannot encode/);
    assert.equal(canonicalize(-0), '0');
  });
});

describe('Seal ID', () => {
  test('matches independently computed values for fixed keys', async () => {
    for (const [pub, expected] of Object.entries(EXPECTED_SEAL_IDS)) {
      const fp = await fingerprint(fromHex(pub));
      assert.equal(toHex(fp), expected.fingerprint);
      assert.equal(sealIdFromFingerprint(fp), expected.sealId);
      assert.equal(await sealIdFromPublicKey(fromHex(pub)), expected.sealId);
    }
  });

  test('is stable across repeated runs', async () => {
    const pub = fromHex(RFC8032[0].public);
    const ids = await Promise.all([1, 2, 3].map(() => sealIdFromPublicKey(pub)));
    assert.ok(ids.every((id) => id === 'SEAL-47Z3-3QX1-AJH6-2RKB'));
  });

  test('parses typed Seal IDs', () => {
    assert.equal(parseSealId('SEAL-47Z3-3QX1-AJH6-2RKB'), 'SEAL-47Z3-3QX1-AJH6-2RKB');
    assert.equal(parseSealId(' seal-47z3-3qx1-ajh6-2rkb '), 'SEAL-47Z3-3QX1-AJH6-2RKB');
    assert.equal(parseSealId('47Z33QX1AJH62RKB'), 'SEAL-47Z3-3QX1-AJH6-2RKB');
    assert.equal(parseSealId('SEAL-47Z3-3QXI-AJH6-2RKB'), 'SEAL-47Z3-3QX1-AJH6-2RKB', 'I read as 1');
    assert.equal(parseSealId('SEAL-47Z3-3QX1-AJH6'), null);
    assert.equal(parseSealId('SEAL-47Z3-3QX1-AJH6-2RKU'), null);
  });

  test('full fingerprint is shown in groups of four', async () => {
    const fp = await fingerprint(fromHex(RFC8032[0].public));
    assert.equal(formatFingerprint(fp).split(' ').length, 16);
    assert.match(formatFingerprint(fp), /^21fe 31df a154 /);
  });
});
