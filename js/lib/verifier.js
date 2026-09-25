// Verifying files.
//
// verifyFiles() takes everything a person dropped in (files, .seal files,
// revocation notices), works out which is which, pairs .seal files with the
// files they belong to, and checks every seal it finds.
//
// Each seal check ends in one of three statuses:
//   "intact"  - valid signature, and the file is exactly what was sealed
//   "altered" - valid signature, but the file differs from what was sealed
//   "invalid" - the seal is damaged, malformed, or its signature does not match
// A file with no seal at all has an empty `checks` list. Valid checks may also
// carry a `revocation` when a matching, validly signed revocation notice was
// provided.

import { base64urlDecode, bytesEqual, lastIndexOfBytes, utf8Decode, utf8DecodeLenient, utf8Encode } from './bytes.js';
import { sha256Hex } from './hash.js';
import { SEAL_FILE_MAX_BYTES, isPlainObject, looksLikeSeal, parseSealBytes, parseSealText, verifySealObject } from './manifest.js';
import {
  findDamagedSealChunks, findSealChunks, isPng, nearPngSignature, readChunks, readSealChunkText, scanForSealChunks, withoutSealChunks,
} from './png.js';
import { BEGIN_MARKER, END_MARKER, parseClearSealed } from './text-seal.js';

const BEGIN_MARKER_BYTES = utf8Encode(BEGIN_MARKER);
const END_MARKER_BYTES = utf8Encode(END_MARKER);
const TEXT_TAIL_BYTES = 64 * 1024; // a seal block must end within the last 64 KiB

function startsWithBrace(bytes) {
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  return bytes[i] === 0x7b;
}

/**
 * Decide what a dropped file is: "content", "seal" (a .seal file) or
 * "revocation" (a revocation notice). Files named *.seal are always treated
 * as seals; other small JSON files are recognised by their shape.
 */
export function classifyFile({ name, bytes }) {
  const named = /\.seal$/i.test(name);
  if (named || (bytes.length <= SEAL_FILE_MAX_BYTES && startsWithBrace(bytes))) {
    try {
      const value = parseSealBytes(bytes);
      if (looksLikeSeal(value)) {
        const revocation = isPlainObject(value.manifest) && Object.prototype.hasOwnProperty.call(value.manifest, 'revoked');
        return { role: revocation ? 'revocation' : 'seal', seal: value };
      }
      if (named) return { role: 'seal', seal: null, problem: 'this .seal file does not contain a seal' };
    } catch (error) {
      if (named) return { role: 'seal', seal: null, problem: `this .seal file is damaged (${error.message})` };
    }
  }
  return { role: 'content' };
}

async function checkSeal(seal, readProblem, covered, meta, knownSha = null) {
  if (!seal) return { ...meta, status: 'invalid', malformed: true, problem: readProblem || 'the seal could not be read' };
  const sig = await verifySealObject(seal);
  if (!sig.valid) return { ...meta, status: 'invalid', malformed: sig.malformed, problem: sig.problem };
  if (sig.kind !== 'file') return { ...meta, status: 'invalid', malformed: true, problem: 'this is a revocation notice, not a file seal' };
  const sha256 = knownSha || (await sha256Hex(covered));
  const intact = sha256 === sig.manifest.sha256 && covered.length === sig.manifest.size;
  return {
    ...meta,
    status: intact ? 'intact' : 'altered',
    signer: { sealId: sig.sealId, fingerprint: sig.fingerprint, publicKey: sig.publicKey },
    manifest: sig.manifest,
    actual: { sha256, size: covered.length },
  };
}

async function pngSealCheck(bytes, sealChunks) {
  if (sealChunks.length > 1) {
    return { source: 'png', status: 'invalid', malformed: true, problem: 'the image contains more than one embedded seal' };
  }
  let seal = null;
  let problem = null;
  try {
    seal = parseSealText(readSealChunkText(bytes, sealChunks[0]));
  } catch (error) {
    problem = error.message;
  }
  return checkSeal(seal, problem, withoutSealChunks(bytes, sealChunks), { source: 'png' });
}

async function embeddedPngCheck(bytes, notes) {
  let chunks = null;
  try {
    chunks = readChunks(bytes);
  } catch {
    // damaged structure: handled below
  }
  if (chunks) {
    const sealChunks = findSealChunks(bytes, chunks);
    if (sealChunks.length) return pngSealCheck(bytes, sealChunks);
    if (findDamagedSealChunks(bytes, chunks).length) {
      return { source: 'png', status: 'invalid', malformed: true, problem: 'the embedded seal is damaged' };
    }
    return null;
  }
  // The chunk structure is damaged, so the file cannot be what was sealed
  // (sealed PNGs are always well-formed). If a seal chunk can still be found,
  // report on it: a genuine seal on a damaged image means "altered".
  const scan = scanForSealChunks(bytes);
  if (!scan.chunks.length) {
    if (scan.damaged) return { source: 'png', status: 'invalid', malformed: true, problem: 'the embedded seal is damaged' };
    if (isPng(bytes)) notes.push('This PNG image looks damaged or incomplete.');
    return null;
  }
  notes.push('This PNG image is damaged: its internal structure is broken.');
  const check = await pngSealCheck(bytes, scan.chunks);
  if (check.status === 'intact') check.status = 'altered';
  return check;
}

async function embeddedTextCheck(bytes) {
  const tail = Math.max(0, bytes.length - TEXT_TAIL_BYTES);
  if (lastIndexOfBytes(bytes, END_MARKER_BYTES, tail) < 0 && lastIndexOfBytes(bytes, BEGIN_MARKER_BYTES, tail) < 0) return null;
  let text;
  let validUtf8 = true;
  try {
    text = utf8Decode(bytes);
  } catch {
    // Sealed text is always valid UTF-8, so this file has changed. Decode it
    // anyway to find the seal and report on it.
    text = utf8DecodeLenient(bytes);
    validUtf8 = false;
  }
  const block = parseClearSealed(text);
  if (!block) return null;
  if (block.error) return { source: 'text', status: 'invalid', malformed: true, problem: block.error };
  let seal = null;
  try {
    seal = parseSealText(utf8Decode(base64urlDecode(block.payload)));
  } catch {
    // handled below
  }
  if (!looksLikeSeal(seal)) {
    // Marker lines with text after them and no readable seal in between are
    // just text that mentions the markers (for example, documentation).
    if (block.trailing) return null;
    return { source: 'text', status: 'invalid', malformed: true, problem: 'the seal block is damaged' };
  }
  const check = await checkSeal(seal, null, utf8Encode(block.content), { source: 'text' });
  if (check.status === 'intact' && block.trailing) {
    check.status = 'altered';
    check.trailingText = true;
  }
  if (check.status === 'intact' && !validUtf8) {
    check.status = 'altered';
    check.invalidUtf8 = true;
  }
  return check;
}

/**
 * Check one file: any seal embedded in it, plus the given .seal files.
 * `sidecars` is a list of { name, seal, problem }.
 */
export async function verifyContent({ name, bytes }, sidecars = [], { sha256 = null } = {}) {
  const notes = [];
  const fileSha = sha256 || (await sha256Hex(bytes));
  const checks = [];
  let embedded = null;
  if (isPng(bytes) || nearPngSignature(bytes) || /\.png$/i.test(name)) embedded = await embeddedPngCheck(bytes, notes);
  if (!embedded && !isPng(bytes)) embedded = await embeddedTextCheck(bytes);
  if (embedded) checks.push(embedded);
  for (const s of sidecars) {
    checks.push(await checkSeal(s.seal, s.problem, bytes, { source: 'sidecar', sealFileName: s.name }, fileSha));
  }
  return { type: 'file', fileName: name, size: bytes.length, sha256: fileSha, checks, notes };
}

function claimedSha(seal) {
  const m = seal && isPlainObject(seal) && seal.manifest;
  return m && typeof m.sha256 === 'string' ? m.sha256 : null;
}

function claimedNames(entry) {
  const names = [entry.name.replace(/\.seal$/i, '')];
  const m = entry.seal && isPlainObject(entry.seal) && entry.seal.manifest;
  if (m && typeof m.name === 'string') names.push(m.name);
  return names.map((n) => n.toLowerCase());
}

/**
 * Verify everything that was dropped in together.
 * @param files  Array<{ name, bytes }>
 * @param options.savedRevocations  revocation notices remembered on this device
 * @returns {Promise<{ items: Array }>} items in the order the files were given:
 *   { type: "file", fileName, size, sha256, checks, notes }
 *   { type: "seal", fileName, status: "valid" | "invalid", signer?, manifest?, problem?, revocation? }
 *   { type: "revocation", fileName, status: "valid" | "invalid", signer?, manifest?, problem?, matched }
 */
export async function verifyFiles(files, { savedRevocations = [] } = {}) {
  const entries = files.map((file, index) => ({ ...file, index, ...classifyFile(file) }));
  const contents = entries.filter((e) => e.role === 'content');
  const seals = entries.filter((e) => e.role === 'seal');
  const notices = entries.filter((e) => e.role === 'revocation');

  for (const c of contents) {
    c.sha256 = await sha256Hex(c.bytes);
    c.sidecars = [];
  }

  // Pair .seal files with content files: by fingerprint, then by name, then
  // (if exactly one of each is left) with each other.
  const unpaired = new Set(seals);
  for (const s of seals) {
    const sha = claimedSha(s.seal);
    const match = sha && contents.find((c) => c.sha256 === sha);
    if (match) {
      match.sidecars.push(s);
      unpaired.delete(s);
    }
  }
  for (const s of [...unpaired]) {
    const names = claimedNames(s);
    const match = contents.find((c) => names.includes(c.name.toLowerCase()));
    if (match) {
      match.sidecars.push(s);
      unpaired.delete(s);
    }
  }
  if (contents.length === 1 && unpaired.size === 1 && contents[0].sidecars.length === 0) {
    contents[0].sidecars.push(...unpaired);
    unpaired.clear();
  }

  const results = new Map();
  for (const c of contents) results.set(c.index, await verifyContent(c, c.sidecars, { sha256: c.sha256 }));
  for (const s of unpaired) {
    if (!s.seal) {
      results.set(s.index, { type: 'seal', fileName: s.name, status: 'invalid', problem: s.problem });
      continue;
    }
    const sig = await verifySealObject(s.seal);
    results.set(s.index, sig.valid
      ? { type: 'seal', fileName: s.name, status: 'valid', signer: { sealId: sig.sealId, fingerprint: sig.fingerprint, publicKey: sig.publicKey }, manifest: sig.manifest }
      : { type: 'seal', fileName: s.name, status: 'invalid', problem: sig.problem });
  }

  // Revocation notices: dropped ones are reported; saved ones only apply.
  const valid = [];
  for (const n of notices) {
    const sig = await verifySealObject(n.seal);
    const item = sig.valid && sig.kind === 'revocation'
      ? { type: 'revocation', fileName: n.name, status: 'valid', signer: { sealId: sig.sealId, fingerprint: sig.fingerprint, publicKey: sig.publicKey }, manifest: sig.manifest, matched: false }
      : { type: 'revocation', fileName: n.name, status: 'invalid', problem: sig.problem || 'not a revocation notice', matched: false };
    results.set(n.index, item);
    if (item.status === 'valid') valid.push({ item, publicKey: sig.publicKey, manifest: sig.manifest, fileName: n.name, saved: false });
  }
  for (const saved of savedRevocations) {
    const sig = await verifySealObject(saved);
    if (sig.valid && sig.kind === 'revocation') valid.push({ item: null, publicKey: sig.publicKey, manifest: sig.manifest, fileName: null, saved: true });
  }

  const items = [...results.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  const withSigner = [];
  for (const item of items) {
    if (item.type === 'file') withSigner.push(...item.checks.filter((c) => c.signer));
    if (item.type === 'seal' && item.signer) withSigner.push(item);
  }
  for (const target of withSigner) {
    const notice = valid.find((v) => bytesEqual(v.publicKey, target.signer.publicKey));
    if (notice) {
      target.revocation = { manifest: notice.manifest, fileName: notice.fileName, saved: notice.saved };
      if (notice.item) notice.item.matched = true;
    }
  }
  return { items };
}
