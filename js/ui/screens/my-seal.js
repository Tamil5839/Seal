// My seal: emblem and Seal ID, backup re-export, revocation notice,
// known seals, and deleting the seal from this device.

import { backupFileName, backupFileText, createBackup, openBackup } from '../../lib/backup.js';
import { base64urlEncode, utf8Encode } from '../../lib/bytes.js';
import { emblemBandSvg, emblemStampSvg } from '../../lib/emblem.js';
import { buildRevocationManifest, formatTimestamp, sealFileText, signManifest, verifySealObject } from '../../lib/manifest.js';
import { assessPassphrase } from '../../lib/passphrase.js';
import { formatFingerprint, parseSealId } from '../../lib/seal-id.js';
import { $, clear, downloadBytes, formatDate, h, setError, setStatus } from '../dom.js';
import { bandNode, stampNode } from '../emblems.js';
import { registerScreen } from '../router.js';
import { loadIdentity, loadKnown, on, state } from '../state.js';

async function renderStorage() {
  const el = $('[data-storage-status]');
  let persisted = null;
  try {
    persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
  } catch {
    persisted = null;
  }
  el.textContent = persisted
    ? 'This browser has agreed to keep SEAL’s data unless you clear it yourself. Still, keep your backup file: it’s the only way to move or recover your seal.'
    : 'Browsers may clear site data — for example when you clear your browsing history, or (in Safari) after 7 days without a visit unless SEAL is on your home screen. If that happens, restore your seal from your backup file.';
}

function render() {
  const id = state.identity;
  $('[data-my-none]').hidden = Boolean(id);
  $('[data-my-main]').hidden = !id;
  renderKnown();
  if (!id) return;
  clear($('[data-my-band]')).append(bandNode(id.fingerprint));
  clear($('[data-my-stamp-large]')).append(stampNode(id.fingerprint));
  $('[data-my-id]').textContent = id.sealId;
  $('[data-my-fingerprint]').textContent = formatFingerprint(id.fingerprint);
  $('[data-my-pub]').textContent = base64urlEncode(id.publicKey);
  $('[data-my-since]').textContent = `${formatDate(id.createdAt)} (${id.origin === 'restored' ? 'restored from a backup' : 'created here'})`;
  $('[data-my-announce]').textContent = `Files I publish are sealed with SEAL. My Seal ID: ${id.sealId}`;
  const canReexport = Boolean(state.sessionBackup && state.sessionBackup.seal_id === id.sealId);
  $('[data-reexport-unavailable]').hidden = canReexport;
  $('[data-reexport-form]').hidden = !canReexport;
  renderStorage();
}

function renderKnown() {
  const list = clear($('[data-known-list]'));
  $('[data-known-empty]').hidden = state.known.length > 0;
  for (const k of state.known) {
    list.append(h('li', {},
      h('span', {}, h('span', { className: 'known-name', text: k.name }), ' ', h('span', { className: 'seal-id', text: k.sealId })),
      h('button', {
        className: 'button button--small button--quiet',
        attrs: { type: 'button', 'aria-label': `Remove ${k.name} (${k.sealId})` },
        on: { click: async () => { await state.store.deleteKnown(k.sealId); await loadKnown(); } },
      }, 'Remove')));
  }
  const revocations = clear($('[data-saved-revocations]'));
  $('[data-saved-revocations-panel]').hidden = state.revocations.length === 0;
  for (const notice of state.revocations) {
    const entry = h('li', {}, h('span', { text: `Revocation declared ${formatDate(notice.manifest.declared_at)}` }));
    revocations.append(entry);
    verifySealObject(notice).then((result) => {
      if (!result.valid) return;
      entry.prepend(h('span', { className: 'seal-id', text: result.sealId }), ' ');
      entry.append(h('button', {
        className: 'button button--small button--quiet',
        attrs: { type: 'button', 'aria-label': `Forget the revocation of ${result.sealId}` },
        on: { click: async () => { await state.store.deleteRevocation(result.sealId); await loadKnown(); } },
      }, 'Forget'));
    });
  }
}

async function reexport(event) {
  event.preventDefault();
  const errorEl = $('[data-reexport-error]');
  const status = $('[data-reexport-status]');
  const current = $('#reexport-current').value;
  const next = $('#reexport-new').value;
  if (next) {
    const verdict = assessPassphrase(next);
    if (!verdict.ok) return setError(errorEl, verdict.message);
    if (next !== $('#reexport-new2').value) return setError(errorEl, 'The two new passphrases are different.');
  }
  setError(errorEl, '');
  setStatus(status, 'Working…');
  try {
    const opened = await openBackup(state.sessionBackup, current);
    const backup = await createBackup({ privateJwk: opened.privateJwk, publicKey: opened.publicKey, passphrase: next || current });
    state.sessionBackup = backup;
    downloadBytes(utf8Encode(backupFileText(backup)), backupFileName(backup.seal_id), 'application/json');
    $('[data-reexport-form]').reset();
    setStatus(status, `Downloaded ${backupFileName(backup.seal_id)}${next ? ', protected by your new passphrase' : ''}. Keep it safe.`, 'ok');
  } catch (error) {
    setStatus(status, '');
    setError(errorEl, error.message);
  }
}

async function makeRevocation(event) {
  event.preventDefault();
  const status = $('[data-revoke-status]');
  try {
    const id = state.identity;
    const manifest = buildRevocationManifest({ publicKey: id.publicKey, declaredAt: formatTimestamp(new Date()), note: $('#revoke-reason').value });
    const notice = await signManifest(id.privateKey, manifest);
    const name = `revocation-${id.sealId}.seal`;
    downloadBytes(utf8Encode(sealFileText(notice)), name, 'application/octet-stream');
    setStatus(status, `Downloaded ${name}. Keep it with your backup, and publish it only if your key is lost or stolen.`, 'ok');
  } catch (error) {
    setStatus(status, error.message, 'error');
  }
}

async function deleteSeal(event) {
  event.preventDefault();
  if (!$('[data-delete-confirm]').checked) return;
  await state.store.deleteIdentity();
  state.sessionBackup = null;
  $('[data-delete-form]').reset();
  $('[data-delete-submit]').disabled = true;
  await loadIdentity();
  setStatus($('[data-delete-status]'), '');
  const notice = $('[data-my-none] p');
  notice.textContent = 'Your seal was deleted from this device. Files you sealed before stay sealed. You can restore it from your backup at any time.';
  $('#my-title').focus();
}

async function saveKnown(event) {
  event.preventDefault();
  const errorEl = $('[data-known-error]');
  const name = $('#known-name').value.trim();
  const sealId = parseSealId($('#known-id').value);
  if (!name) return setError(errorEl, 'Enter a name.');
  if (!sealId) return setError(errorEl, 'That doesn’t look like a Seal ID. It should look like SEAL-XXXX-XXXX-XXXX-XXXX.');
  if (!state.store) return setError(errorEl, 'This browser won’t let SEAL store data.');
  setError(errorEl, '');
  await state.store.saveKnown({ sealId, name });
  $('[data-known-form]').reset();
  await loadKnown();
}

function downloadEmblem(kind) {
  const id = state.identity;
  const svg = kind === 'band' ? emblemBandSvg(id.fingerprint) : emblemStampSvg(id.fingerprint);
  downloadBytes(utf8Encode(svg), `seal-${kind === 'band' ? 'emblem' : 'stamp'}-${id.sealId}.svg`, 'image/svg+xml');
}

export function initMySeal() {
  registerScreen('my-seal', { show: render });
  on('identity', render);
  on('known', renderKnown);
  $('[data-reexport-form]').addEventListener('submit', reexport);
  $('#reexport-new').addEventListener('input', (e) => {
    const r = assessPassphrase(e.target.value);
    $('[data-reexport-strength]').textContent = e.target.value ? `${r.label}. ${r.message}` : '';
  });
  $('[data-revoke-form]').addEventListener('submit', makeRevocation);
  $('[data-delete-confirm]').addEventListener('change', (e) => {
    $('[data-delete-submit]').disabled = !e.target.checked;
  });
  $('[data-delete-form]').addEventListener('submit', deleteSeal);
  $('[data-known-form]').addEventListener('submit', saveKnown);
  $('[data-download-band]').addEventListener('click', () => downloadEmblem('band'));
  $('[data-download-stamp]').addEventListener('click', () => downloadEmblem('stamp'));
  render();
}
