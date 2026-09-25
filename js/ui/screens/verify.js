// Verify files: drop a file (plus its .seal file and any revocation notice)
// and see whether it is intact and whose seal it carries.

import { base64urlEncode, utf8Encode } from '../../lib/bytes.js';
import { parseSealBytes } from '../../lib/manifest.js';
import { formatFingerprint } from '../../lib/seal-id.js';
import { classifyFile, verifyFiles } from '../../lib/verifier.js';
import { $, clear, formatBytes, formatDate, h, icon, readFiles, setError, setStatus, uniqueId, wireDropzone, withSealIds } from '../dom.js';
import { impressionNode } from '../emblems.js';
import { registerScreen } from '../router.js';
import { isMine, knownName, loadKnown, on, state } from '../state.js';

let files = []; // { id, name, bytes, role }
let run = 0;

const ROLE_LABEL = { content: 'file', seal: '.seal file', revocation: 'revocation notice' };

async function addFiles(list) {
  const read = await readFiles(list);
  for (const f of read) files.push({ id: uniqueId('f'), name: f.name, bytes: f.bytes, role: classifyFile(f).role });
  renderList();
  await check();
}

function addPastedText(text) {
  files = files.filter((f) => f.name !== 'Pasted text');
  files.push({ id: uniqueId('f'), name: 'Pasted text', bytes: utf8Encode(text), role: 'content' });
  renderList();
  return check();
}

function renderList() {
  const list = clear($('[data-verify-items]'));
  $('[data-verify-list]').hidden = files.length === 0;
  for (const f of files) {
    list.append(h('li', { className: 'file-chip' },
      h('span', { className: 'file-chip-role', text: ROLE_LABEL[f.role] }),
      h('span', { className: 'file-chip-name', text: f.name }),
      h('button', {
        className: 'chip-remove',
        attrs: { type: 'button', 'aria-label': `Remove ${f.name}` },
        on: { click: () => { files = files.filter((x) => x.id !== f.id); renderList(); check(); } },
      }, '×')));
  }
}

async function check() {
  const mine = ++run;
  const results = $('[data-verify-results]');
  const status = $('[data-verify-status]');
  if (!files.length) {
    clear(results);
    setStatus(status, '');
    return;
  }
  if (!state.supported) {
    setStatus(status, 'This browser can’t check seals. Please update it.', 'error');
    return;
  }
  setStatus(status, 'Checking…');
  const report = await verifyFiles(files.map((f) => ({ name: f.name, bytes: f.bytes })), { savedRevocations: state.revocations });
  if (mine !== run) return;
  clear(results);
  const summaries = [];
  for (const item of report.items) {
    if (item.type === 'file') {
      if (!item.checks.length) {
        results.append(noSealCard(item));
        summaries.push(`${item.fileName}: no seal found`);
      }
      for (const c of item.checks) {
        const card = checkCard(item, c);
        results.append(card);
        summaries.push(`${item.fileName}: ${card.dataset.summary}`);
      }
    } else if (item.type === 'seal') {
      results.append(sealOnlyCard(item));
      summaries.push(`${item.fileName}: ${item.status === 'valid' ? `a seal by ${item.signer.sealId}; add the file it belongs to` : 'not a valid seal'}`);
    } else {
      results.append(revocationCard(item));
      summaries.push(`${item.fileName}: ${item.status === 'valid' ? `revocation notice for ${item.signer.sealId}` : 'invalid revocation notice'}`);
    }
  }
  setStatus(status, `Result${summaries.length === 1 ? '' : 's'}: ${summaries.join('. ')}.`);
}

// ------------------------------------------------------------ pieces

function card(visual, headingText, stateLabel) {
  const headingId = uniqueId('res');
  const article = h('article', { className: `result result--${visual}`, attrs: { 'aria-labelledby': headingId } });
  const icons = { intact: 'check', altered: 'cross', invalid: 'broken', revoked: 'warning', none: 'question' };
  const heading = h('h2', { className: 'result-headline', attrs: { id: headingId } }, icon(icons[visual] || 'question'),
    h('span', {}, h('span', { className: 'result-state', text: stateLabel }), ...withSealIds(headingText)));
  return { article, heading };
}

function sealIdNode(sealId) {
  const wrap = h('span', {}, h('span', { className: 'seal-id', text: sealId }));
  const name = knownName(sealId);
  if (isMine(sealId)) wrap.append(h('span', { className: 'known-badge', text: 'your seal' }));
  else if (name) wrap.append(h('span', { className: 'known-badge' }, `“${name}” · saved by you`));
  return wrap;
}

function whoText(sealId) {
  if (isMine(sealId)) return 'This is your own seal.';
  const name = knownName(sealId);
  if (name) return `You saved this Seal ID as “${name}”. That name is only on this device — it’s your note, not part of the seal.`;
  return `SEAL can’t tell you who ${sealId} is. A Seal ID only identifies someone if they announce it publicly — for example in their social media bio. Compare the full Seal ID there, not just the emblem.`;
}

function detailsList(rows) {
  const dl = h('dl', { className: 'details-list' });
  for (const [term, value] of rows) {
    if (value === null || value === undefined || value === '') continue;
    dl.append(h('dt', { text: term }), h('dd', {}, value));
  }
  return dl;
}

function declaredDate(manifest) {
  return h('span', {}, formatDate(manifest.declared_at), h('span', { className: 'hint' }, ' — declared by the sealer, not independently confirmed'));
}

function noteNode(manifest) {
  return manifest.note ? h('span', { className: 'note-text', attrs: { dir: 'auto' }, text: manifest.note }) : null;
}

function sourceText(check) {
  if (check.source === 'png') return 'Inside the image (PNG seal chunk)';
  if (check.source === 'text') return 'At the end of the text (BEGIN SEAL … END SEAL)';
  return `Separate file: ${check.sealFileName}`;
}

function technical(rows) {
  const details = h('details', { className: 'disclosure' }, h('summary', { text: 'Technical details' }));
  details.append(detailsList(rows.map(([t, v]) => [t, typeof v === 'string' ? h('span', { className: 'mono', text: v }) : v])));
  return details;
}

function saveKnownForm(signer) {
  const inputId = uniqueId('kn');
  const error = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
  const input = h('input', { attrs: { id: inputId, type: 'text', maxlength: '80', autocomplete: 'off' } });
  const form = h('form', { className: 'form form--inline', attrs: { novalidate: true } },
    h('div', { className: 'field' }, h('label', { attrs: { for: inputId }, text: `Save ${signer.sealId} as a known seal, with the name` }), input),
    h('button', { className: 'button button--secondary', attrs: { type: 'submit' }, text: 'Save' }),
    error);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return setError(error, 'Enter a name.');
    if (!state.store) return setError(error, 'This browser won’t let SEAL store data.');
    await state.store.saveKnown({ sealId: signer.sealId, name, publicKey: signer.publicKey });
    await loadKnown(); // re-checks via the "known" event, now showing the name
  });
  return form;
}

function revocationBox(revocation, check) {
  const box = h('div', { className: 'warning-box' });
  const m = revocation.manifest;
  box.append(h('p', {}, h('strong', { text: 'The owner of this seal has revoked it. ' }),
    `They published a notice (declared ${formatDate(m.declared_at)}) saying this seal should no longer be trusted — for example because the key was lost or stolen. Anyone holding a stolen key could have made this seal, and a seal’s declared date can’t prove when it was really made.`));
  if (m.note) box.append(h('p', {}, 'Reason given: ', h('span', { className: 'note-text', attrs: { dir: 'auto' }, text: `“${m.note}”` })));
  if (check) box.append(h('p', { text: check.status === 'intact' ? 'The file itself is unchanged since sealing.' : 'The file has also changed since it was sealed.' }));
  box.append(h('p', { className: 'hint', text: revocation.saved ? 'Revocation notice: remembered on this device.' : `Revocation notice: ${revocation.fileName}` }));
  return box;
}

// ------------------------------------------------------------- cards

function checkCard(item, c) {
  const revoked = Boolean(c.revocation) && c.status !== 'invalid';
  const visual = revoked ? 'revoked' : c.status;
  let parts;
  if (c.status === 'invalid') {
    parts = card('invalid', 'This seal is not valid', 'Invalid seal');
  } else if (revoked) {
    parts = card('revoked', `Warning: the seal ${c.signer.sealId} has been revoked`, 'Revoked');
  } else if (c.status === 'intact') {
    parts = card('intact', `Sealed by ${c.signer.sealId}, unchanged since sealing`, 'Intact');
  } else {
    parts = card('altered', 'This file has changed since it was sealed', 'Altered');
  }
  const { article, heading } = parts;
  article.dataset.summary = heading.textContent.replace(/^(Intact|Altered|Invalid seal|Revoked)/, '').trim();
  article.dataset.state = visual;
  article.append(h('p', { className: 'result-file', text: `${item.fileName} · ${formatBytes(item.size)}` }));
  article.append(impressionNode(visual, c.signer && c.signer.fingerprint, item.sha256 ? utf8Encode(item.sha256).subarray(0, 32) : null));
  article.append(heading);

  if (c.status === 'invalid') {
    article.append(h('p', { text: 'The seal’s signature doesn’t match its contents, or the seal is damaged. It may have been edited or forged. It tells you nothing about who made this file, or whether the file changed.' }));
    article.append(technical([['Problem', c.problem], ['Where the seal was', sourceText(c)]]));
    return article;
  }

  const m = c.manifest;
  const sealId = c.signer.sealId;
  if (revoked) {
    article.append(revocationBox(c.revocation, c));
  } else if (c.status === 'intact') {
    article.append(h('p', { text: 'This exact file was sealed by the holder of this Seal ID, and not one byte has changed since.' }));
  } else {
    article.append(h('p', {}, ...withSealIds(`The seal itself is valid: ${sealId} did seal a file called `), h('strong', { text: `“${m.name}”` }),
      '. But this file is not identical to it. Even a tiny change — editing, re-saving or re-compressing — breaks a seal. It’s also possible that this seal belongs to a different file.'));
    if (c.trailingText) article.append(h('p', { text: 'Text was added after the seal block — that part was never sealed.' }));
    else if (c.invalidUtf8) article.append(h('p', { text: 'The text’s character encoding was changed (it is no longer valid UTF-8).' }));
    else if (c.actual.size !== m.size) article.append(h('p', { text: `The sealed file was ${formatBytes(m.size)}; this one is ${formatBytes(c.actual.size)}.` }));
  }
  article.append(h('p', { className: 'hint' }, ...withSealIds(whoText(sealId))));

  const renamed = c.source !== 'text' && m.name !== item.fileName && !(c.source === 'png' && item.fileName.includes('-sealed'))
    ? ` (this copy is named “${item.fileName}” — renaming doesn’t affect a seal)` : '';
  article.append(detailsList([
    ['Sealed by', sealIdNode(sealId)],
    ['Declared date', declaredDate(m)],
    ['Note', noteNode(m)],
    ['Sealed as', h('span', {}, h('span', { className: 'filename', text: m.name }), renamed)],
    ['Size', formatBytes(m.size)],
    ['Seal found', sourceText(c)],
  ]));
  article.append(technical([
    ['Seal fingerprint', formatFingerprint(c.signer.fingerprint)],
    ['Public key', base64urlEncode(c.signer.publicKey)],
    ['Sealed SHA-256', m.sha256],
    ['This file’s SHA-256', c.source === 'sidecar' ? c.actual.sha256 : `${c.actual.sha256} (of the ${c.source === 'png' ? 'image without its seal chunk' : 'text before the seal block, normalized'})`],
  ]));

  if (!isMine(sealId) && !knownName(sealId)) article.append(saveKnownForm(c.signer));
  return article;
}

function noSealCard(item) {
  const { article, heading } = card('none', 'No seal found', 'No seal');
  article.dataset.state = 'none';
  article.append(h('p', { className: 'result-file', text: `${item.fileName} · ${formatBytes(item.size)}` }));
  article.append(impressionNode('none'));
  article.append(heading);
  article.append(h('p', { text: 'This file doesn’t carry a seal, and no matching .seal file was added. If you received a .seal file with it, drop both files together.' }));
  article.append(h('p', { className: 'hint', text: 'Images shared through social apps usually lose their seal, because those apps re-compress them. Ask for the original file, sent as a document.' }));
  for (const note of item.notes) article.append(h('p', { className: 'hint', text: note }));
  return article;
}

function sealOnlyCard(item) {
  if (item.status !== 'valid') {
    const { article, heading } = card('invalid', 'This .seal file is not valid', 'Invalid seal');
    article.dataset.state = 'invalid';
    article.append(h('p', { className: 'result-file', text: item.fileName }), heading,
      h('p', { text: 'It is damaged, or its signature doesn’t match its contents. It tells you nothing about any file.' }),
      technical([['Problem', item.problem]]));
    return article;
  }
  const m = item.manifest;
  const revoked = Boolean(item.revocation);
  const { article, heading } = card(revoked ? 'revoked' : 'none', `A seal by ${item.signer.sealId} for “${m.name}”`, revoked ? 'Revoked' : 'Seal file only');
  article.dataset.state = 'seal-only';
  article.append(h('p', { className: 'result-file', text: item.fileName }), heading);
  article.append(h('p', {}, 'This .seal file is valid. To check the file it belongs to, add ', h('strong', { text: m.name }), ` (${formatBytes(m.size)}) as well.`));
  if (revoked) article.append(revocationBox(item.revocation, null));
  article.append(detailsList([['Sealed by', sealIdNode(item.signer.sealId)], ['Declared date', declaredDate(m)], ['Note', noteNode(m)]]));
  return article;
}

function rememberRevocationButton(sealId, fileName) {
  const button = h('button', { className: 'button button--secondary', attrs: { type: 'button' }, text: 'Remember this revocation on this device' });
  button.addEventListener('click', async () => {
    const notice = files.find((f) => f.name === fileName && f.role === 'revocation');
    if (!state.store || !notice) return;
    await state.store.saveRevocation(sealId, parseSealBytes(notice.bytes));
    await loadKnown(); // re-checks via the "known" event
  });
  return h('div', { className: 'button-row' }, button);
}

function revocationCard(item) {
  if (item.status !== 'valid') {
    const { article, heading } = card('invalid', 'This revocation notice is not valid', 'Invalid notice');
    article.dataset.state = 'invalid';
    article.append(h('p', { className: 'result-file', text: item.fileName }), heading,
      h('p', { text: 'Its signature doesn’t match. Only the holder of a seal can revoke it, so ignore this notice.' }),
      technical([['Problem', item.problem]]));
    return article;
  }
  const m = item.manifest;
  const { article, heading } = card('revoked', `Revocation notice for ${item.signer.sealId}`, 'Revocation notice');
  article.dataset.state = 'revocation';
  article.append(h('p', { className: 'result-file', text: item.fileName }), heading);
  article.append(h('p', { text: `The owner of this seal says it should no longer be trusted (declared ${formatDate(m.declared_at)}). The notice is valid: it was signed by the seal’s own key.` }));
  if (m.note) article.append(h('p', {}, 'Reason given: ', h('span', { className: 'note-text', attrs: { dir: 'auto' }, text: `“${m.note}”` })));
  article.append(h('p', { className: 'hint', text: item.matched ? 'It applies to a seal you added above.' : 'It doesn’t match any seal you added here.' }));
  const saved = state.revocations.some((r) => r && r.manifest && r.manifest.pub === m.pub);
  if (!saved && state.store) {
    article.append(rememberRevocationButton(item.signer.sealId, item.fileName));
  } else if (saved) {
    article.append(h('p', { className: 'hint', text: 'Remembered on this device: future checks of this seal will show the warning.' }));
  }
  return article;
}

export function initVerify() {
  registerScreen('verify', {});
  wireDropzone($('[data-verify-drop]'), (list) => addFiles(list).catch((e) => setStatus($('[data-verify-status]'), e.message, 'error')));
  $('[data-verify-clear]').addEventListener('click', () => {
    files = [];
    renderList();
    check();
  });
  $('[data-verify-paste-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('#verify-text').value;
    if (text.trim()) addPastedText(text);
  });
  on('known', () => {
    if (files.length) check();
  });
}
