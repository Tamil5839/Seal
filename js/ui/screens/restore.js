// Restore a seal from an encrypted backup file on a new device.

import { openBackup, parseBackupBytes } from '../../lib/backup.js';
import { importPrivateJwk, keysMatch } from '../../lib/ed25519.js';
import { formatTimestamp } from '../../lib/manifest.js';
import { fingerprint } from '../../lib/seal-id.js';
import { $, $$, formatDate, setError, setStatus, wireDropzone } from '../dom.js';
import { rollSeal } from '../roll.js';
import { registerScreen } from '../router.js';
import { loadIdentity, state } from '../state.js';

let selected = null; // parsed backup object

function showStep(name) {
  for (const step of $$('[data-restore-step]')) step.hidden = step.dataset.restoreStep !== name;
}

function render() {
  const exists = Boolean(state.identity);
  $('[data-restore-exists]').hidden = !exists;
  if (exists) $('[data-restore-existing-id]').textContent = state.identity.sealId;
  $('[data-restore-submit]').disabled = !state.supported || !state.store;
  showStep('form');
}

async function chooseFile(files) {
  const status = $('[data-restore-file-status]');
  setError($('[data-restore-error]'), '');
  selected = null;
  const file = files[0];
  try {
    selected = parseBackupBytes(new Uint8Array(await file.arrayBuffer()));
    setStatus(status, `Backup for ${selected.seal_id}, made ${formatDate(selected.created_at)}. Enter its passphrase.`, 'ok');
    $('#restore-pass').focus();
  } catch (error) {
    setStatus(status, `${file.name}: ${error.message}`, 'error');
  }
}

async function restore(event) {
  event.preventDefault();
  const errorEl = $('[data-restore-error]');
  const status = $('[data-restore-status]');
  if (!selected) return setError(errorEl, 'Choose your backup file first.');
  if (state.identity && state.identity.sealId !== selected.seal_id) {
    return setError(errorEl, `Another seal (${state.identity.sealId}) is already on this device. Delete it in My seal first.`);
  }
  setError(errorEl, '');
  const submit = $('[data-restore-submit]');
  submit.disabled = true;
  setStatus(status, 'Unlocking your backup…');
  try {
    let opened = await openBackup(selected, $('#restore-pass').value);
    const locked = await importPrivateJwk(opened.privateJwk);
    const { publicKey, sealId } = opened;
    opened = null;
    if (!(await keysMatch(locked, publicKey))) throw new Error('The key in this backup does not work.');
    if (!state.identity) {
      await state.store.saveIdentity({ privateKey: locked, publicKey, sealId, createdAt: formatTimestamp(new Date()), origin: 'restored' });
    }
    state.sessionBackup = selected;
    navigator.storage?.persist?.().catch(() => {});
    const wasThere = Boolean(state.identity);
    await loadIdentity();
    setStatus(status, '');
    $('#restore-pass').value = '';
    $('[data-restore-final-id]').textContent = sealId;
    $('[data-restore-done-title]').textContent = wasThere ? 'This seal was already on this device' : 'Your seal is restored on this device';
    showStep('done');
    $('[data-restore-done-title]').focus();
    await rollSeal($('[data-restore-roll]'), await fingerprint(publicKey));
  } catch (error) {
    setStatus(status, '');
    setError(errorEl, error.message);
  } finally {
    submit.disabled = false;
  }
}

export function initRestore() {
  registerScreen('restore', { show: render });
  wireDropzone($('[data-screen="restore"] [data-dropzone]'), chooseFile);
  $('[data-restore-form]').addEventListener('submit', restore);
}
