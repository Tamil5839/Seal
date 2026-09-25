// Clear-sealed text: the seal travels at the end of the text itself.
//
//   original text
//   -----BEGIN SEAL-----
//   <base64url of the seal JSON, wrapped at 64 characters>
//   -----END SEAL-----
//
// Canonical text (what the seal's sha256 and size cover): the text before the
// block, converted to Unicode NFC with every line ending (CRLF or lone CR)
// turned into LF. Nothing else is changed. Exactly one line break always
// separates the text from the BEGIN line and is not part of the text, so a
// text with or without a final newline is recovered exactly.
// docs/FORMAT.md gives the precise parsing rules.

import { base64urlEncode, utf8Encode } from './bytes.js';
import { canonicalize } from './canonical-json.js';

export const BEGIN_MARKER = '-----BEGIN SEAL-----';
export const END_MARKER = '-----END SEAL-----';
const LINE_WIDTH = 64;

export const TEXT_EXTENSIONS = new Set(['txt', 'text', 'md', 'markdown', 'mdown', 'mkd', 'mkdn']);
export const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);

export function canonicalizeText(text) {
  return text.replace(/\r\n?/g, '\n').normalize('NFC');
}

/** The exact bytes a clear-sealed text's hash covers. */
export function canonicalTextBytes(text) {
  return utf8Encode(canonicalizeText(text));
}

const PAYLOAD_LINE = /^[A-Za-z0-9_-]+$/;
const isPayloadLine = (line) => PAYLOAD_LINE.test(line.trim());

function lastLineIndex(lines, marker, before = lines.length) {
  for (let i = before - 1; i >= 0; i--) if (lines[i].trimEnd() === marker) return i;
  return -1;
}

/**
 * Look for a seal block in a text: the last END line and the last BEGIN
 * line before it.
 * Returns null when there is no seal block. Otherwise { content, payload, trailing },
 * or { error } for a block whose BEGIN or END line is damaged.
 *   content  - canonical text covered by the seal
 *   payload  - base64url seal text with all whitespace removed
 *   trailing - true if non-blank text follows the END line
 */
export function parseClearSealed(text) {
  const lines = canonicalizeText(text).split('\n');
  const end = lastLineIndex(lines, END_MARKER);
  if (end < 0) {
    // No END line. A BEGIN line followed only by payload lines (and perhaps a
    // mangled END line) is a damaged seal block rather than ordinary text.
    const begin = lastLineIndex(lines, BEGIN_MARKER);
    if (begin < 0) return null;
    const after = lines.slice(begin + 1).filter((line) => line.trim() !== '');
    const damaged = after.length > 0 && isPayloadLine(after[0]) && after.every((line) => isPayloadLine(line) || line.startsWith('-----'));
    return damaged ? { error: 'the seal block is damaged (its END line is missing)' } : null;
  }
  const begin = lastLineIndex(lines, BEGIN_MARKER, end);
  if (begin < 0) {
    const before = lines[end - 1];
    return before !== undefined && isPayloadLine(before) ? { error: 'the seal block is damaged (its BEGIN line is missing)' } : null;
  }
  return {
    content: lines.slice(0, begin).join('\n'),
    payload: lines.slice(begin + 1, end).join('').replace(/\s+/g, ''),
    trailing: lines.slice(end + 1).some((line) => line.trim() !== ''),
  };
}

/** Pick a line break that matches the text, and cannot merge with a final CR. */
export function lineBreakFor(text) {
  if (text.endsWith('\r') || text.includes('\r\n')) return '\r\n';
  if (text.includes('\r')) return '\r';
  return '\n';
}

export function sealBlock(seal, lineBreak = '\n') {
  const payload = base64urlEncode(utf8Encode(canonicalize(seal)));
  const lines = payload.match(new RegExp(`.{1,${LINE_WIDTH}}`, 'g'));
  return [BEGIN_MARKER, ...lines, END_MARKER].join(lineBreak) + lineBreak;
}

/** The original text, untouched, followed by the seal block. */
export function buildClearSealed(originalText, seal) {
  const lineBreak = lineBreakFor(originalText);
  return originalText + lineBreak + sealBlock(seal, lineBreak);
}
