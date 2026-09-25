// Embedded seals in PNG images.
//
// The seal is stored in an iTXt chunk with the keyword "seal": no compression,
// empty language tag, empty translated keyword, and the seal JSON as UTF-8
// text. The seal's sha256 covers the PNG byte stream with every seal chunk
// (length, type, data and CRC) cut out, so the seal chunk may sit anywhere
// between IHDR and IEND. Because nothing else is touched when sealing,
// "sealed PNG minus its seal chunk" is byte-for-byte the original file.

import { concatBytes, utf8Decode, utf8Encode } from './bytes.js';

export const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const SEAL_PREFIX = new Uint8Array([0x73, 0x65, 0x61, 0x6c, 0x00]); // "seal" + NUL
const ITXT = new Uint8Array([0x69, 0x54, 0x58, 0x74]);

export class PngError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PngError';
  }
}

export function isPng(bytes) {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

/** True if the first bytes are within two bytes of the PNG signature (a damaged PNG). */
export function nearPngSignature(bytes) {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  let differences = 0;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) differences++;
  return differences <= 2;
}

// CRC-32 as used by PNG (ISO 3309, polynomial 0xEDB88320). Not a security
// feature: it only detects accidental damage to a chunk.
let crcTable = null;
export function crc32(bytes, start = 0, end = bytes.length) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const readU32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
function writeU32(b, o, v) {
  b[o] = v >>> 24;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

/**
 * List the chunks of a PNG up to and including IEND.
 * Each entry: { type, start, end, dataStart, dataEnd } where start..end spans
 * the whole chunk (length + type + data + CRC). Throws PngError.
 */
export function readChunks(bytes) {
  if (!isPng(bytes)) throw new PngError('not a PNG file');
  const chunks = [];
  let o = PNG_SIGNATURE.length;
  for (;;) {
    if (o + 12 > bytes.length) throw new PngError('the PNG file is incomplete');
    const length = readU32(bytes, o);
    if (length > 0x7fffffff) throw new PngError('the PNG file has an invalid chunk');
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new PngError('the PNG file has an invalid chunk');
    const end = o + 12 + length;
    if (end > bytes.length) throw new PngError('the PNG file is incomplete');
    chunks.push({ type, start: o, end, dataStart: o + 8, dataEnd: o + 8 + length });
    o = end;
    if (type === 'IEND') break;
  }
  if (chunks[0].type !== 'IHDR') throw new PngError('the PNG file does not start with an image header');
  return chunks;
}

export function isSealChunk(bytes, chunk) {
  if (chunk.type !== 'iTXt' || chunk.dataEnd - chunk.dataStart < SEAL_PREFIX.length) return false;
  for (let i = 0; i < SEAL_PREFIX.length; i++) if (bytes[chunk.dataStart + i] !== SEAL_PREFIX[i]) return false;
  return true;
}

export function findSealChunks(bytes, chunks = readChunks(bytes)) {
  return chunks.filter((c) => isSealChunk(bytes, c));
}

/**
 * For PNG files whose chunk structure is damaged: look for seal chunks by
 * the start of their data ("seal", NUL, four zero bytes, then the JSON "{").
 * Returns { chunks, damaged } - chunks whose type, length and CRC check out,
 * and how many look like seal chunks but have a broken type, length or CRC.
 */
export function scanForSealChunks(bytes) {
  const pattern = concatBytes(SEAL_PREFIX, new Uint8Array([0, 0, 0, 0, 0x7b]));
  const chunks = [];
  let damaged = 0;
  for (let i = bytes.indexOf(pattern[0], 8); i >= 0; i = bytes.indexOf(pattern[0], i + 1)) {
    let j = 1;
    while (j < pattern.length && bytes[i + j] === pattern[j]) j++;
    if (j < pattern.length) continue;
    const start = i - 8;
    const length = readU32(bytes, start);
    const chunk = { type: 'iTXt', start, end: start + 12 + length, dataStart: i, dataEnd: i + length };
    const typeOk = ITXT.every((b, k) => bytes[start + 4 + k] === b);
    if (typeOk && chunk.end <= bytes.length && chunkCrcOk(bytes, chunk)) {
      chunks.push(chunk);
      i = chunk.end - 1;
    } else {
      damaged++;
    }
  }
  return { chunks, damaged };
}

export function chunkCrcOk(bytes, chunk) {
  return crc32(bytes, chunk.start + 4, chunk.dataEnd) === readU32(bytes, chunk.dataEnd);
}

const MANIFEST_MARK = utf8Encode('{"manifest":');

function containsBytes(haystack, needle, start, end) {
  for (let i = haystack.indexOf(needle[0], start); i >= 0 && i + needle.length <= end; i = haystack.indexOf(needle[0], i + 1)) {
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return false;
}

/**
 * Chunks that look like a seal chunk whose type or keyword was damaged:
 * a CRC mismatch plus seal JSON inside.
 */
export function findDamagedSealChunks(bytes, chunks = readChunks(bytes)) {
  return chunks.filter((c) => !isSealChunk(bytes, c) && !chunkCrcOk(bytes, c) && containsBytes(bytes, MANIFEST_MARK, c.dataStart, c.dataEnd));
}

/** Read the seal JSON text out of a seal chunk. Throws PngError. */
export function readSealChunkText(bytes, chunk) {
  if (!chunkCrcOk(bytes, chunk)) {
    throw new PngError('the embedded seal is damaged');
  }
  const data = bytes.subarray(chunk.dataStart, chunk.dataEnd);
  let p = SEAL_PREFIX.length;
  if (data[p] !== 0 || data[p + 1] !== 0) throw new PngError('compressed seal chunks are not supported');
  p += 2;
  const languageEnd = data.indexOf(0, p);
  if (languageEnd < 0) throw new PngError('the embedded seal is damaged');
  const keywordEnd = data.indexOf(0, languageEnd + 1);
  if (keywordEnd < 0) throw new PngError('the embedded seal is damaged');
  try {
    return utf8Decode(data.subarray(keywordEnd + 1));
  } catch {
    throw new PngError('the embedded seal is damaged');
  }
}

/** The bytes a PNG seal's hash covers: the file with all seal chunks removed. */
export function withoutSealChunks(bytes, sealChunks = findSealChunks(bytes)) {
  if (!sealChunks.length) return bytes;
  const parts = [];
  let o = 0;
  for (const c of sealChunks) {
    parts.push(bytes.subarray(o, c.start));
    o = c.end;
  }
  parts.push(bytes.subarray(o));
  return concatBytes(...parts);
}

/** Build a complete iTXt "seal" chunk holding the given text. */
export function makeSealChunk(text) {
  const textBytes = utf8Encode(text);
  // keyword "seal", NUL, compression flag 0, method 0, empty language tag + NUL,
  // empty translated keyword + NUL, then the text
  const data = concatBytes(SEAL_PREFIX, new Uint8Array([0, 0, 0, 0]), textBytes);
  const chunk = new Uint8Array(12 + data.length);
  writeU32(chunk, 0, data.length);
  chunk.set(ITXT, 4);
  chunk.set(data, 8);
  writeU32(chunk, 8 + data.length, crc32(chunk, 4, 8 + data.length));
  return chunk;
}

/** Insert a chunk immediately before IEND. */
export function insertChunkBeforeEnd(bytes, chunk) {
  const chunks = readChunks(bytes);
  const iend = chunks[chunks.length - 1];
  return concatBytes(bytes.subarray(0, iend.start), chunk, bytes.subarray(iend.start));
}
