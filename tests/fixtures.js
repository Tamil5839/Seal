// Fixed test keys (RFC 8032 section 7.1) and small helpers shared by tests.

import { base64urlEncode, fromHex } from '../js/lib/bytes.js';
import { importPrivateJwk } from '../js/lib/ed25519.js';

export const RFC8032 = [
  {
    name: 'TEST 1',
    secret: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    public: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    message: '',
    signature: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  },
  {
    name: 'TEST 2',
    secret: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    public: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    message: '72',
    signature: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  },
  {
    name: 'TEST 3',
    secret: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
    public: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    message: 'af82',
    signature: '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
  },
  {
    name: 'TEST SHA(abc)',
    secret: '833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42',
    public: 'ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf',
    message: 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    signature: 'dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704',
  },
];

// Expected Seal IDs, computed independently (Python hashlib + a separate
// Crockford base32 implementation).
export const EXPECTED_SEAL_IDS = {
  d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a: {
    fingerprint: '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9',
    sealId: 'SEAL-47Z3-3QX1-AJH6-2RKB',
  },
  '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c': {
    fingerprint: '39f713d0a644253f04529421b9f51b9b08979d08295959c4f3990ee617f5139f',
    sealId: 'SEAL-77VH-7M56-8GJK-Y12J',
  },
  fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025: {
    fingerprint: 'dac073e0123bdea59dd9b3bda9cf6037f63aca82627d7abcd5c4ac29dd74003e',
    sealId: 'SEAL-VB07-7R0J-7FFA-B7ES',
  },
};

/** A fixed identity (key pair) for deterministic tests. */
export async function testIdentity(index = 0, { extractable = false } = {}) {
  const v = RFC8032[index];
  const publicKey = fromHex(v.public);
  const privateKey = await importPrivateJwk(
    { kty: 'OKP', crv: 'Ed25519', d: base64urlEncode(fromHex(v.secret)), x: base64urlEncode(publicKey) },
    { extractable },
  );
  return { privateKey, publicKey };
}

export const DECLARED = '2026-09-25T12:00:00Z';

export function flipByte(bytes, index, mask = 0x01) {
  const copy = new Uint8Array(bytes);
  copy[index] ^= mask;
  return copy;
}

/** Deterministic pseudo-random bytes (for fixtures; not for keys). */
export function pseudoRandomBytes(length, seed = 1) {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

/** A small but structurally valid PDF document. */
export function samplePdf() {
  const text = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >> endobj',
    '4 0 obj << /Length 44 >> stream',
    'BT /F1 18 Tf 20 40 Td (Sealed PDF) Tj ET',
    'endstream endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF',
    '',
  ].join('\n');
  return new TextEncoder().encode(text);
}

/** Render a small image to PNG or JPEG bytes using a canvas. */
export async function sampleImage(type = 'image/png', { width = 48, height = 32, seed = 7, tweak = null } = {}) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const noise = pseudoRandomBytes(width * height * 4, seed);
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < noise.length; i += 4) {
    image.data[i] = noise[i];
    image.data[i + 1] = noise[i + 1];
    image.data[i + 2] = noise[i + 2];
    image.data[i + 3] = 255;
  }
  if (tweak) tweak(image.data, width, height);
  ctx.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type, quality: 0.92 });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Decode PNG/JPEG bytes to RGBA pixel data. */
export async function decodePixels(bytes, type = 'image/png') {
  const bitmap = await createImageBitmap(new Blob([bytes], { type }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}
