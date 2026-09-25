// Seal a file: choose it, pick where the seal goes, add a note and a
// declared date, then watch the seal roll across the clay.

import { NOTE_MAX_CHARS, codePointLength, formatTimestamp, sanitizeNote } from '../../lib/manifest.js';
import { MAX_FILE_BYTES, embedOption, sealFile } from '../../lib/sealer.js';
import { $, clear, downloadBytes, formatBytes, h, icon, setError, setStatus, wireDropzone } from '../dom.js';
import { rollSeal } from '../roll.js';
import { registerScreen } from '../router.js';
import { on, state } from '../state.js';

let current = null; // { file: {name, type, size, bytes}, option }
let thumbUrl = null;

function appUrl() {
  return `${location.origin}${location.pathname}`;
}

/** Local date-time string for <input type="datetime-local"> (minutes precision). */
function localInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function render() {
  const has = Boolean(state.identity);
  $('[data-seal-needs-seal]').hidden = has;
  $('[data-seal-main]').hidden = !has;
  if (has) $('[data-seal-as]').textContent = state.identity.sealId;
  $('[data-seal-submit]').disabled = !state.supported;
}

function resetForm() {
  current = null;
  if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  thumbUrl = null;
  $('[data-seal-form]').reset();
  $('[data-seal-drop]').hidden = false;
  $('[data-seal-file-card]').hidden = true;
  $('[data-seal-options]').hidden = true;
  $('[data-seal-result]').hidden = true;
  $('[data-seal-form]').hidden = false;
  setError($('[data-seal-error]'), '');
  setStatus($('[data-seal-status]'), '');
  updateCounter();
}

async function chooseFile(files) {
  const file = files[0];
  setError($('[data-seal-error]'), '');
  if (file.size > MAX_FILE_BYTES) {
    setError($('[data-seal-error]'), `${file.name} is larger than 1 GB. SEAL has to read the whole file into memory, so it can't seal files that big.`);
    $('[data-seal-options]').hidden = false;
    return;
  }
  setStatus($('[data-seal-status]'), 'Reading the file…');
  const bytes = new Uint8Array(await file.arrayBuffer());
  setStatus($('[data-seal-status]'), '');
  current = { file: { name: file.name, type: file.type, size: file.size, bytes }, option: embedOption({ name: file.name, type: file.type, bytes }) };

  $('[data-seal-file-name]').textContent = file.name;
  $('[data-seal-file-info]').textContent = `${formatBytes(file.size)}${file.type ? ` · ${file.type}` : ''}`;
  const thumb = clear($('[data-seal-thumb]'));
  if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  thumbUrl = null;
  if (/^image\/(png|jpeg|gif|webp|avif)$/.test(file.type)) {
    thumbUrl = URL.createObjectURL(file);
    thumb.append(h('img', { attrs: { src: thumbUrl, alt: '' } }));
  } else {
    thumb.append(icon('file', ''));
  }
  $('[data-seal-drop]').hidden = true;
  $('[data-seal-file-card]').hidden = false;

  const embed = $('[data-seal-mode-embed]');
  const sidecar = $('[data-seal-mode-sidecar]');
  const reason = $('[data-seal-embed-reason]');
  embed.disabled = !current.option.embed;
  if (current.option.embed) {
    embed.checked = true;
    $('[data-seal-embed-hint]').textContent = current.option.embed === 'png'
      ? 'You get a sealed copy of the image that carries its own seal. The picture itself is not changed.'
      : 'The seal is added at the end of the text, between BEGIN SEAL and END SEAL lines.';
    reason.hidden = true;
  } else {
    sidecar.checked = true;
    $('[data-seal-embed-hint]').textContent = 'Works for PNG images and plain text or Markdown.';
    reason.textContent = current.option.reason;
    reason.hidden = false;
  }
  $('#seal-date').value = localInputValue(new Date());
  $('[data-seal-options]').hidden = false;
  $('[data-seal-result]').hidden = true;
  $('[data-seal-change]').focus();
}

function updateCounter() {
  const count = codePointLength(sanitizeNote($('#seal-note').value));
  const el = $('[data-seal-note-count]');
  el.textContent = `${count} / ${NOTE_MAX_CHARS}`;
  el.classList.toggle('is-over', count > NOTE_MAX_CHARS);
}

async function submit(event) {
  event.preventDefault();
  const errorEl = $('[data-seal-error]');
  if (!current) return setError(errorEl, 'Choose a file to seal first.');
  const note = sanitizeNote($('#seal-note').value);
  if (codePointLength(note) > NOTE_MAX_CHARS) return setError(errorEl, `The note is too long: at most ${NOTE_MAX_CHARS} characters.`);
  const dateValue = $('#seal-date').value;
  const date = dateValue ? new Date(dateValue) : new Date();
  if (Number.isNaN(date.getTime())) return setError(errorEl, 'Please enter a valid date.');
  const mode = $('[data-seal-mode-embed]').checked && current.option.embed ? current.option.embed : 'sidecar';
  setError(errorEl, '');

  const button = $('[data-seal-submit]');
  button.disabled = true;
  setStatus($('[data-seal-status]'), 'Sealing…');
  try {
    const { output } = await sealFile({
      bytes: current.file.bytes,
      name: current.file.name,
      type: current.file.type,
      mode,
      privateKey: state.identity.privateKey,
      publicKey: state.identity.publicKey,
      declaredAt: formatTimestamp(date),
      note,
    });
    setStatus($('[data-seal-status]'), '');
    showResult(mode, output);
  } catch (error) {
    setStatus($('[data-seal-status]'), '');
    setError(errorEl, error.message);
  } finally {
    button.disabled = false;
  }
}

async function showResult(mode, output) {
  const name = current.file.name;
  $('[data-seal-form]').hidden = true;
  $('[data-seal-result]').hidden = false;
  const title = $('[data-seal-result-title]');
  const text = $('[data-seal-result-text]');
  const downloads = clear($('[data-seal-downloads]'));
  const download = () => downloadBytes(output.bytes, output.name, output.type);
  const button = h('button', { className: 'button button--primary', attrs: { type: 'button' }, on: { click: download } }, icon('download'), `Download ${output.name}`);
  downloads.append(button);
  const sealId = state.identity.sealId;
  if (mode === 'sidecar') {
    title.textContent = `${name} is sealed`;
    text.textContent = `Your file is unchanged. Its seal is in ${output.name} — share both files together.`;
    $('[data-seal-howto]').textContent = `This file is sealed by ${sealId}. To check it, open ${appUrl()} and drop in ${name} together with ${output.name}.`;
  } else {
    title.textContent = `${output.name} is sealed`;
    text.textContent = mode === 'png'
      ? 'This copy of your image carries its seal inside. Share it as a file (not through apps that re-compress images).'
      : 'This copy of your text carries its seal at the end. You can share the file, or paste the whole text.';
    $('[data-seal-howto]').textContent = `This file is sealed by ${sealId}. To check it, open ${appUrl()} and drop in ${output.name}${mode === 'text' ? ' (or paste the text)' : ''}.`;
  }
  title.focus();
  download();
  await rollSeal($('[data-seal-roll]'), state.identity.fingerprint);
}

export function initSeal() {
  registerScreen('seal', { show: render });
  on('identity', () => {
    render();
    resetForm();
  });
  wireDropzone($('[data-seal-drop]'), (files) => chooseFile(files).catch((e) => setError($('[data-seal-error]'), e.message)));
  $('[data-seal-change]').addEventListener('click', () => {
    resetForm();
    $('#seal-file').focus();
  });
  $('#seal-note').addEventListener('input', updateCounter);
  $('[data-seal-form]').addEventListener('submit', submit);
  $('[data-seal-another]').addEventListener('click', () => {
    resetForm();
    $('#seal-file').focus();
  });
  resetForm();
  render();
}
