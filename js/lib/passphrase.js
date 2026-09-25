// A rough passphrase strength hint. It is only a hint: the only hard rules
// are the minimum length and refusing a few trivially guessable patterns.

import { PASSPHRASE_MIN_LENGTH, normalizePassphrase } from './backup.js';

const COMMON = [
  'password', 'passphrase', 'passwort', 'motdepasse', 'contraseña', 'qwerty', 'azerty', 'asdf', 'zxcv',
  'letmein', 'iloveyou', 'welcome', 'admin', 'monkey', 'dragon', 'football', 'baseball', 'sunshine',
  'princess', 'master', 'shadow', 'superman', 'trustno1', 'secret', 'abc', '123', '1234', '12345',
  '123456', '1234567', '12345678', '123456789', '0000', '1111', 'seal', 'correcthorsebatterystaple',
];

const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** Count characters that repeat the previous one or continue a keyboard/alphabet run. */
function predictableCount(text) {
  let count = 0;
  for (let i = 1; i < text.length; i++) {
    const pair = text[i - 1] + text[i];
    if (text[i] === text[i - 1] || SEQUENCES.some((s) => s.includes(pair) || s.includes(pair[1] + pair[0]))) count++;
  }
  return count;
}

/**
 * Assess a passphrase.
 * @returns {{ ok: boolean, level: 0|1|2|3|4, label: string, message: string }}
 *   level 0 = not allowed, 1 = weak, 2 = fair, 3 = good, 4 = strong
 */
export function assessPassphrase(input) {
  const passphrase = normalizePassphrase(input);
  const chars = [...passphrase];
  if (chars.length < PASSPHRASE_MIN_LENGTH) {
    const more = PASSPHRASE_MIN_LENGTH - chars.length;
    return { ok: false, level: 0, label: 'Too short', message: `Use at least ${PASSPHRASE_MIN_LENGTH} characters (${more} more).` };
  }
  const lower = passphrase.toLowerCase();
  const letters = lower.replace(/[^\p{L}\p{N}]/gu, '');
  if (new Set(chars).size <= 3) {
    return { ok: false, level: 0, label: 'Too easy to guess', message: 'Use more than a few different characters.' };
  }
  if (predictableCount(lower) >= (chars.length - 1) * 0.6) {
    return { ok: false, level: 0, label: 'Too easy to guess', message: 'Avoid keyboard patterns and runs like "qwerty" or "1234".' };
  }
  let stripped = letters;
  for (const word of [...COMMON].sort((a, b) => b.length - a.length)) stripped = stripped.split(word).join('');
  if (stripped.replace(/\d/g, '').length < 4) {
    return { ok: false, level: 0, label: 'Too easy to guess', message: 'This is a very common password. Try a few unrelated words.' };
  }

  let pool = 0;
  if (/[a-z]/.test(passphrase)) pool += 26;
  if (/[A-Z]/.test(passphrase)) pool += 26;
  if (/[0-9]/.test(passphrase)) pool += 10;
  if (/[ ]/.test(passphrase)) pool += 1;
  if (/[!-/:-@[-`{-~]/.test(passphrase)) pool += 32;
  if (/[^\x00-\x7f]/.test(passphrase)) pool += 64;
  const effective = Math.max(1, chars.length - predictableCount(lower) - (letters.length - stripped.length) * 0.75);
  let bits = effective * Math.log2(Math.max(pool, 2));
  // A plain list of words is only as strong as the number of words in it.
  if (/^[\p{L}\s\-_.,]+$/u.test(passphrase)) {
    const words = passphrase.trim().split(/[\s\-_.,]+/).filter((w) => w.length >= 2);
    if (words.length >= 2) bits = Math.min(bits, words.length * 13 + 4);
  }

  if (bits < 45) return { ok: true, level: 1, label: 'Weak', message: 'Easy to guess. Add more words or characters.' };
  if (bits < 60) return { ok: true, level: 2, label: 'Fair', message: 'Okay. One or two more words would make it much stronger.' };
  if (bits < 80) return { ok: true, level: 3, label: 'Good', message: 'Good passphrase.' };
  return { ok: true, level: 4, label: 'Strong', message: 'Strong passphrase.' };
}
