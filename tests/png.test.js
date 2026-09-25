import { assert, describe, test } from './harness.js';
import { DECLARED, decodePixels, sampleImage, testIdentity } from './fixtures.js';
import { bytesEqual, concatBytes, utf8Encode } from '../js/lib/bytes.js';
import { canonicalize } from '../js/lib/canonical-json.js';
import { crc32, findSealChunks, makeSealChunk, readChunks, readSealChunkText, withoutSealChunks } from '../js/lib/png.js';
import { embedOption, sealFile } from '../js/lib/sealer.js';
import { verifyFiles } from '../js/lib/verifier.js';

async function sealPng(bytes, mode = 'png') {
  const { privateKey, publicKey } = await testIdentity(0);
  return sealFile({ bytes, name: 'picture.png', type: 'image/png', mode, privateKey, publicKey, declaredAt: DECLARED, note: 'my picture' });
}

async function report(bytes, extra = []) {
  return verifyFiles([{ name: 'picture-sealed.png', bytes }, ...extra]);
}

async function status(bytes, extra = []) {
  const checks = (await report(bytes, extra)).items[0].checks;
  return checks.length ? checks.map((c) => c.status).join(',') : 'none';
}

/** Move a chunk so it sits before the chunk at `toIndex` (chunk bytes are copied unchanged). */
function moveChunk(bytes, chunk, toIndex) {
  const moving = bytes.subarray(chunk.start, chunk.end);
  const rest = concatBytes(bytes.subarray(0, chunk.start), bytes.subarray(chunk.end));
  const target = readChunks(rest)[toIndex];
  return concatBytes(rest.subarray(0, target.start), moving, rest.subarray(target.start));
}

describe('PNG embedded seals', () => {
  test('CRC-32 matches the PNG specification', () => {
    assert.equal(crc32(utf8Encode('123456789')), 0xcbf43926);
    assert.equal(crc32(utf8Encode('IEND')), 0xae426082);
  });

  test('seal then verify is INTACT; the seal chunk sits before IEND', async () => {
    const original = await sampleImage('image/png');
    const { output, seal } = await sealPng(original);
    assert.equal(output.name, 'picture-sealed.png');
    const chunks = readChunks(output.bytes);
    assert.equal(chunks[chunks.length - 1].type, 'IEND');
    assert.equal(chunks[chunks.length - 2].type, 'iTXt');
    assert.equal(readSealChunkText(output.bytes, chunks[chunks.length - 2]), canonicalize(seal));
    const r = await report(output.bytes);
    assert.equal(r.items[0].checks[0].status, 'intact');
    assert.equal(r.items[0].checks[0].source, 'png');
    assert.equal(r.items[0].checks[0].manifest.note, 'my picture');
  });

  test('removing the seal chunk gives back the original file byte for byte', async () => {
    const original = await sampleImage('image/png');
    const { output, seal } = await sealPng(original);
    assert.ok(bytesEqual(withoutSealChunks(output.bytes), original));
    assert.equal(seal.manifest.size, original.length);
  });

  test('the sealed image still decodes to the same pixels', async () => {
    const original = await sampleImage('image/png');
    const { output } = await sealPng(original);
    assert.ok(bytesEqual(await decodePixels(output.bytes), await decodePixels(original)));
  });

  test('moving the seal chunk elsewhere keeps it INTACT', async () => {
    const { output } = await sealPng(await sampleImage('image/png'));
    const [sealChunk] = findSealChunks(output.bytes);
    const afterHeader = moveChunk(output.bytes, sealChunk, 1); // right after IHDR
    assert.equal(readChunks(afterHeader)[1].type, 'iTXt');
    assert.equal(await status(afterHeader), 'intact');
  });

  test('changing any pixel makes it ALTERED (same seal chunk, re-encoded image)', async () => {
    const original = await sampleImage('image/png');
    const { output } = await sealPng(original);
    const [sealChunk] = findSealChunks(output.bytes);
    const chunkBytes = output.bytes.slice(sealChunk.start, sealChunk.end);
    for (const [x, y] of [[0, 0], [20, 10], [47, 31]]) {
      const changed = await sampleImage('image/png', {
        tweak(data, width) {
          data[(y * width + x) * 4] ^= 1;
        },
      });
      assert.equal(bytesEqual(changed, original), false);
      const chunks = readChunks(changed);
      const iend = chunks[chunks.length - 1];
      const forged = concatBytes(changed.subarray(0, iend.start), chunkBytes, changed.subarray(iend.start));
      assert.equal(await status(forged), 'altered', `pixel ${x},${y}`);
    }
  });

  test('changing any byte outside the seal chunk makes it ALTERED', async () => {
    const { output } = await sealPng(await sampleImage('image/png'));
    const [sealChunk] = findSealChunks(output.bytes);
    // signature, IHDR length/type/data/CRC, image data, the seal chunk's neighbours, IEND
    const positions = [0, 3, 7, 8, 11, 12, 16, 20, 29, 33, 40, 60, sealChunk.start - 1, sealChunk.end, output.bytes.length - 5, output.bytes.length - 1];
    for (const pos of positions) {
      const changed = new Uint8Array(output.bytes);
      changed[pos] ^= 0x10;
      assert.equal(await status(changed), 'altered', `byte ${pos}`);
    }
  });

  test('changing any byte of the seal chunk itself makes it INVALID', async () => {
    const { output } = await sealPng(await sampleImage('image/png'));
    const [sealChunk] = findSealChunks(output.bytes);
    for (let pos = sealChunk.start; pos < sealChunk.end; pos += 7) {
      const changed = new Uint8Array(output.bytes);
      changed[pos] ^= 0x04;
      const s = await status(changed);
      assert.ok(s === 'invalid', `byte ${pos - sealChunk.start} of the seal chunk gave ${s}`);
    }
  });

  test('adding another chunk makes it ALTERED', async () => {
    const { output } = await sealPng(await sampleImage('image/png'));
    const text = new Uint8Array([0, 0, 0, 5, 0x74, 0x45, 0x58, 0x74, 0x61, 0x00, 0x62, 0x63, 0x64]);
    const chunk = concatBytes(text, new Uint8Array(4));
    const chunks = readChunks(output.bytes);
    const at = chunks[1].start;
    const withExtra = concatBytes(output.bytes.subarray(0, at), chunk, output.bytes.subarray(at));
    assert.equal(await status(withExtra), 'altered');
  });

  test('re-encoding the image drops the seal: NO SEAL FOUND', async () => {
    const { output } = await sealPng(await sampleImage('image/png'));
    const bitmap = await createImageBitmap(new Blob([output.bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const reencoded = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    assert.equal(await status(reencoded), 'none');
  });

  test('a damaged seal chunk is INVALID', async () => {
    const { output } = await sealPng(await sampleImage('image/png'));
    const [sealChunk] = findSealChunks(output.bytes);
    const damaged = new Uint8Array(output.bytes);
    damaged[sealChunk.dataStart + 30] ^= 0x01;
    assert.equal(await status(damaged), 'invalid');
  });

  test('a seal chunk whose signature does not match is INVALID', async () => {
    const original = await sampleImage('image/png');
    const { seal } = await sealPng(original);
    const edited = { manifest: { ...seal.manifest, note: 'edited note' }, sig: seal.sig };
    const chunks = readChunks(original);
    const iend = chunks[chunks.length - 1];
    const forged = concatBytes(original.subarray(0, iend.start), makeSealChunk(canonicalize(edited)), original.subarray(iend.start));
    assert.equal(await status(forged), 'invalid');
  });

  test('two seal chunks are INVALID', async () => {
    const { output } = await sealPng(await sampleImage('image/png'));
    const [sealChunk] = findSealChunks(output.bytes);
    const twice = concatBytes(output.bytes.subarray(0, sealChunk.end), output.bytes.subarray(sealChunk.start));
    assert.equal(findSealChunks(twice).length, 2);
    assert.equal(await status(twice), 'invalid');
  });

  test('an incomplete sealed PNG is ALTERED, or INVALID when the seal itself was cut', async () => {
    const original = await sampleImage('image/png');
    const { output } = await sealPng(original);
    const lostEnd = await report(output.bytes.subarray(0, output.bytes.length - 5));
    assert.equal(lostEnd.items[0].checks[0].status, 'altered');
    assert.equal(lostEnd.items[0].notes.length, 1, 'mentions the damage');
    assert.equal(await status(output.bytes.subarray(0, output.bytes.length - 30)), 'invalid');
    const unsealed = await report(original.subarray(0, original.length - 30));
    assert.equal(unsealed.items[0].checks.length, 0);
    assert.equal(unsealed.items[0].notes.length, 1, 'an incomplete unsealed PNG says it looks damaged');
  });

  test('every single-bit change in the seal chunk\'s type or keyword is caught', async () => {
    const { output } = await sealPng(await sampleImage('image/png'));
    const [sealChunk] = findSealChunks(output.bytes);
    for (let pos = sealChunk.start + 4; pos < sealChunk.dataStart + 9; pos++) {
      for (let bit = 0; bit < 8; bit++) {
        const changed = new Uint8Array(output.bytes);
        changed[pos] ^= 1 << bit;
        const s = await status(changed);
        assert.equal(s, 'invalid', `byte ${pos - sealChunk.start} bit ${bit}`);
      }
    }
  });

  test('an already sealed PNG can only get a separate .seal file', async () => {
    const { output } = await sealPng(await sampleImage('image/png'));
    assert.equal(embedOption({ name: 'x.png', type: 'image/png', bytes: output.bytes }).embed, null);
    await assert.rejects(() => sealPng(output.bytes), /already/);
    const second = await sealPng(output.bytes, 'sidecar');
    const statuses = await status(output.bytes, [{ name: 'picture.png.seal', bytes: second.output.bytes }]);
    assert.equal(statuses, 'intact,intact', 'the embedded seal and the separate seal both hold');
  });

  test('a .seal file made for the original PNG does not match the embedded copy', async () => {
    const original = await sampleImage('image/png');
    const sidecar = await sealPng(original, 'sidecar');
    assert.equal(await status(original, [{ name: 'picture.png.seal', bytes: sidecar.output.bytes }]), 'intact');
    const embedded = await sealPng(original);
    assert.equal(await status(embedded.output.bytes, [{ name: 'picture.png.seal', bytes: sidecar.output.bytes }]), 'intact,altered');
  });

  test('JPEG images are sealed with a separate .seal file', async () => {
    const jpeg = await sampleImage('image/jpeg');
    const { privateKey, publicKey } = await testIdentity(0);
    const { output } = await sealFile({ bytes: jpeg, name: 'p.jpg', mode: 'sidecar', privateKey, publicKey, declaredAt: DECLARED });
    const r = await verifyFiles([{ name: 'p.jpg', bytes: jpeg }, { name: output.name, bytes: output.bytes }]);
    assert.equal(r.items[0].checks[0].status, 'intact');
  });
});
