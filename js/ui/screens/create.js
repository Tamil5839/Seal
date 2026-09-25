// Create a seal:
//  1. generate an Ed25519 key pair (extractable only for the backup step)
//  2. require an encrypted backup (passphrase -> PBKDF2 + AES-GCM) and download it
//  3. re-import the private key as NON-extractable and drop the extractable copy
//  4. after the person confirms they saved the backup, store the locked key in
//     IndexedDB and roll out the new emblem

import { utf8Encode } from '../../lib/bytes.js';
import {
  backupFileName, backupFileText, createBackup, openBackup, parseBackupBytes,
} from '../../lib/backup.js';
import { exportPrivateJwk, exportPublicKeyRaw, generateKeyPair, importPrivateJwk, keysMatch } from '../../lib/ed25519.js';
import { formatTimestamp } from '../../lib/manifest.js';
import { assessPassphrase } from '../../lib/passphrase.js';
import { fingerprint, sealIdFromFingerprint } from '../../lib/seal-id.js';
import { $, $$, downloadBytes, setError, setStatus } from '../dom.js';
import { rollSeal } from '../roll.js';
import { registerScreen } from '../router.js';
import { loadIdentity, state } from '../state.js';

const screen = () => $('[data-screen="create"]');
let pending = null; // { pair, publicKey, fp, sealId, lockedKey, backup }

function showStep(name) {
  for (const step of $$('[data-step]', screen())) step.hidden = step.dataset.step !== name;
}

function render() {
  if (pending) return; // keep the person where they were
  const exists = Boolean(state.identity);
  $('[data-create-exists]').hidden = !exists;
  $('[data-create-start]').hidden = exists;
  if (exists) $('[data-create-existing-id]').textContent = state.identity.sealId;
  $('[data-create-begin]').disabled = !state.supported || !state.store;
  showStep('intro');
}

async function begin() {
  const pair = await generateKeyPair();
  const publicKey = await exportPublicKeyRaw(pair.publicKey);
  const fp = await fingerprint(publicKey);
  pending = { pair, publicKey, fp, sealId: sealIdFromFingerprint(fp), lockedKey: null, backup: null };
  $('[data-create-new-id]').textContent = pending.sealId;
  $('[data-backup-form]').reset();
  updateStrength();
  setError($('[data-backup-error]'), '');
  showStep('backup');
  $('[data-backup-title]').focus();
}

function restart() {
  pending = null;
  render();
}

function updateStrength() {
  const value = $('#create-pass').value;
  const result = assessPassphrase(value);
  $('[data-strength-bar]').dataset.level = value ? String(result.level) : '0';
  $('[data-strength-text]').textContent = value ? `${result.label}. ${result.message}` : '';
}

async function makeBackup(event) {
  event.preventDefault();
  const pass = $('#create-pass').value;
  const again = $('#create-pass2').value;
  const errorEl = $('[data-backup-error]');
  const verdict = assessPassphrase(pass);
  if (!verdict.ok) return setError(errorEl, verdict.message);
  if (pass !== again) return setError(errorEl, 'The two passphrases are different.');
  setError(errorEl, '');

  const submit = $('[data-backup-submit]');
  submit.disabled = true;
  setStatus($('[data-backup-status]'), 'Encrypting your backup… (this takes a moment on purpose, to slow down guessing)');
  try {
    let jwk = await exportPrivateJwk(pending.pair.privateKey);
    const backup = await createBackup({ privateJwk: jwk, publicKey: pending.publicKey, passphrase: pass });
    // Lock the key: from here on only a non-extractable copy is kept.
    const locked = await importPrivateJwk(jwk);
    jwk = null;
    pending.pair = null;
    if (!(await keysMatch(locked, pending.publicKey))) throw new Error('The locked key does not match.');
    pending.lockedKey = locked;
    pending.backup = backup;
    downloadBackup();
    $('[data-backup-filename]').textContent = backupFileName(pending.sealId);
    $('[data-confirm-form]').reset();
    $('[data-confirm-submit]').disabled = true;
    setStatus($('[data-backup-status]'), '');
    showStep('confirm');
    $('[data-confirm-title]').focus();
  } catch (error) {
    setStatus($('[data-backup-status]'), '');
    setError(errorEl, `Could not create the backup: ${error.message}`);
  } finally {
    submit.disabled = false;
  }
}

function downloadBackup() {
  downloadBytes(utf8Encode(backupFileText(pending.backup)), backupFileName(pending.sealId), 'application/json');
}

async function testBackup(event) {
  event.preventDefault();
  const status = $('[data-backup-test-status]');
  const file = $('#test-backup-file').files[0];
  if (!file) return setStatus(status, 'Choose your downloaded backup file first.', 'error');
  setStatus(status, 'Checking…');
  try {
    const backup = parseBackupBytes(new Uint8Array(await file.arrayBuffer()));
    if (backup.seal_id !== pending.sealId) {
      return setStatus(status, `That backup belongs to ${backup.seal_id}, not your new seal ${pending.sealId}.`, 'error');
    }
    await openBackup(backup, $('#test-backup-pass').value);
    setStatus(status, 'Your backup works: it opens with this passphrase.', 'ok');
  } catch (error) {
    setStatus(status, error.message, 'error');
  }
}

async function finish(event) {
  event.preventDefault();
  const errorEl = $('[data-confirm-error]');
  if (!$('[data-confirm-saved]').checked) return setError(errorEl, 'Please confirm that you saved your backup.');
  try {
    await state.store.saveIdentity({
      privateKey: pending.lockedKey,
      publicKey: pending.publicKey,
      sealId: pending.sealId,
      createdAt: formatTimestamp(new Date()),
      origin: 'created',
    });
  } catch (error) {
    return setError(errorEl, `Could not save your seal on this device: ${error.message}`);
  }
  setError(errorEl, '');
  state.sessionBackup = pending.backup;
  const { fp, sealId } = pending;
  pending = null;
  navigator.storage?.persist?.().catch(() => {});
  await loadIdentity();
  $('[data-create-final-id]').textContent = sealId;
  showStep('done');
  $('[data-done-title]').focus();
  await rollSeal($('[data-create-roll]'), fp);
}

export function initCreate() {
  registerScreen('create', { show: render });
  $('[data-create-begin]').addEventListener('click', () => {
    setError($('[data-create-error]'), '');
    begin().catch((e) => setError($('[data-create-error]'), `Could not create a key: ${e.message}`));
  });
  $('[data-create-restart]').addEventListener('click', restart);
  $('#create-pass').addEventListener('input', updateStrength);
  $('[data-backup-form]').addEventListener('submit', makeBackup);
  $('[data-backup-again]').addEventListener('click', downloadBackup);
  $('[data-backup-test]').addEventListener('submit', testBackup);
  $('[data-confirm-saved]').addEventListener('change', (e) => {
    $('[data-confirm-submit]').disabled = !e.target.checked;
  });
  $('[data-confirm-form]').addEventListener('submit', finish);
  for (const toggle of $$('[data-toggle-password]')) {
    toggle.addEventListener('click', () => {
      const show = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', String(show));
      toggle.textContent = show ? 'Hide' : 'Show';
      for (const id of toggle.dataset.togglePassword.split(' ')) $(`#${id}`).type = show ? 'text' : 'password';
    });
  }
}
