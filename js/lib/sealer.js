// Sealing files. Three ways to attach a seal:
//   "sidecar" - a separate <name>.seal file; the file itself is untouched
//   "png"     - embedded in a PNG image (iTXt chunk)
//   "text"    - clear-sealed plain text or Markdown
// Every seal is verified again before it is handed out.

import { utf8Decode, utf8Encode } from './bytes.js';
import { canonicalize } from './canonical-json.js';
import { sha256Hex } from './hash.js';
import { buildFileManifest, parseSealBytes, sealFileText, signManifest } from './manifest.js';
import { findSealChunks, insertChunkBeforeEnd, isPng, makeSealChunk, readChunks } from './png.js';
import { TEXT_EXTENSIONS, TEXT_TYPES, buildClearSealed, canonicalTextBytes, parseClearSealed } from './text-seal.js';
import { verifyContent } from './verifier.js';

export const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GiB: the whole file has to fit in memory

export class SealError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SealError';
  }
}

export function extensionOf(name) {
  const m = /[^.]\.([^./\\]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** "photo.png" -> "photo-sealed.png", "notes" -> "notes-sealed" */
export function sealedFileName(name) {
  const ext = extensionOf(name);
  return ext ? `${name.slice(0, -(ext.length + 1))}-sealed.${name.slice(-ext.length)}` : `${name}-sealed`;
}

export function sidecarFileName(name) {
  return `${name}.seal`;
}

export function isTextFile(name, type) {
  const base = String(type || '').split(';')[0].trim().toLowerCase();
  return TEXT_EXTENSIONS.has(extensionOf(name)) || TEXT_TYPES.has(base);
}

/**
 * How can this file carry its seal?
 * Returns { embed: "png" | "text" | null, reason } - a sidecar is always possible.
 */
export function embedOption({ name, type, bytes }) {
  if (isPng(bytes)) {
    try {
      if (findSealChunks(bytes).length) {
        return { embed: null, reason: 'This image already carries an embedded seal. To add your own without replacing it, use a separate .seal file.' };
      }
      return { embed: 'png', reason: '' };
    } catch {
      return { embed: null, reason: 'This PNG image could not be read, so the seal can only be saved as a separate .seal file.' };
    }
  }
  if (isTextFile(name, type)) {
    let text;
    try {
      text = utf8Decode(bytes);
    } catch {
      return { embed: null, reason: 'This text file is not UTF-8, so the seal can only be saved as a separate .seal file.' };
    }
    if (parseClearSealed(text)) {
      return { embed: null, reason: 'This text already contains a seal block. To add your own without replacing it, use a separate .seal file.' };
    }
    return { embed: 'text', reason: '' };
  }
  return { embed: null, reason: 'Files of this type keep their seal in a separate small .seal file. Share both files together.' };
}

/**
 * Seal a file.
 * @returns {Promise<{ seal, mode, output: { name, bytes, type } }>}
 */
export async function sealFile({ bytes, name, type = '', mode, privateKey, publicKey, declaredAt, note = '' }) {
  if (bytes.length > MAX_FILE_BYTES) throw new SealError('Files larger than 1 GB cannot be sealed in the browser.');
  let covered;
  let build;
  if (mode === 'sidecar') {
    covered = bytes;
    build = (seal) => ({ name: sidecarFileName(name), bytes: utf8Encode(sealFileText(seal)), type: 'application/octet-stream' });
  } else if (mode === 'png') {
    if (!isPng(bytes)) throw new SealError('This file is not a PNG image.');
    if (findSealChunks(bytes, readChunks(bytes)).length) throw new SealError('This image already carries an embedded seal.');
    covered = bytes;
    build = (seal) => ({ name: sealedFileName(name), bytes: insertChunkBeforeEnd(bytes, makeSealChunk(canonicalize(seal))), type: 'image/png' });
  } else if (mode === 'text') {
    let text;
    try {
      text = utf8Decode(bytes);
    } catch {
      throw new SealError('This text file is not UTF-8.');
    }
    if (parseClearSealed(text)) throw new SealError('This text already contains a seal block.');
    covered = canonicalTextBytes(text);
    build = (seal) => ({ name: sealedFileName(name), bytes: utf8Encode(buildClearSealed(text, seal)), type: type || 'text/plain' });
  } else {
    throw new SealError(`Unknown seal mode "${mode}"`);
  }

  const manifest = buildFileManifest({ publicKey, sha256: await sha256Hex(covered), size: covered.length, name, declaredAt, note });
  const seal = await signManifest(privateKey, manifest);
  const output = build(seal);

  // Self-check: the result must verify as intact before anyone gets it.
  const report = mode === 'sidecar'
    ? await verifyContent({ name, bytes }, [{ name: output.name, seal: parseSealBytes(output.bytes) }], { sha256: manifest.sha256 })
    : await verifyContent({ name: output.name, bytes: output.bytes });
  const check = report.checks.find((c) => c.source === mode);
  if (!check || check.status !== 'intact') {
    throw new SealError('Internal error: the new seal did not verify. Nothing was saved.');
  }
  return { seal, mode, output };
}
