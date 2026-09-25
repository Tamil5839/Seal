// Small DOM helpers. Text from files and seals is untrusted: it is only
// ever inserted with textContent, never as HTML.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * Create an element. `props`: className, text, attrs {}, on {event: fn}, hidden, dataset {}.
 * Children may be nodes or strings (strings become text nodes).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  if (props.className) el.className = props.className;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.hidden) el.hidden = true;
  for (const [k, v] of Object.entries(props.attrs || {})) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  for (const [k, v] of Object.entries(props.dataset || {})) el.dataset[k] = v;
  for (const [k, v] of Object.entries(props.on || {})) el.addEventListener(k, v);
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

const SEAL_ID_IN_TEXT = /SEAL-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/g;

/**
 * Split text SEAL composed itself into text and monospace Seal ID spans, so
 * IDs are always shown in the same easy-to-compare style.
 */
export function withSealIds(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(SEAL_ID_IN_TEXT)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('span', { className: 'seal-id', text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Parse SVG markup that SEAL generated itself (emblems, icons) into a node. */
export function svgNode(markup) {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Internal error: malformed SVG');
  return document.importNode(doc.documentElement, true);
}

const ICONS = {
  check: '<path d="M5 12l5 5 9-10"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  warning: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.4M12 17v.4"/>',
  broken: '<path d="M4 7h16v10H4z"/><path d="M11 7l-1.5 4 3 2L11 17"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
};

export function icon(name, className = 'inline-icon') {
  return svgNode(`<svg xmlns="http://www.w3.org/2000/svg" class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`);
}

export function setError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

export function setStatus(el, message, kind = '') {
  el.textContent = message || '';
  el.classList.toggle('is-ok', kind === 'ok');
  el.classList.toggle('is-error', kind === 'error');
}

/** Offer bytes to the person as a normal browser download. */
export function downloadBytes(bytes, filename, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = h('a', { attrs: { href: url, download: filename, rel: 'noopener' }, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function copyText(text, button) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const area = h('textarea', { attrs: { readonly: true, 'aria-hidden': 'true' }, className: 'visually-hidden' });
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
  }
  if (button) {
    const label = button.dataset.label || button.textContent;
    button.dataset.label = label;
    button.textContent = ok ? 'Copied' : 'Copy failed — select the text instead';
    setTimeout(() => {
      button.textContent = label;
    }, 1800);
  }
  return ok;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} byte${n === 1 ? '' : 's'}`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' });

/** "25 September 2026 at 14:00" in the viewer's time zone. */
export function formatDate(isoOrDate) {
  const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return Number.isNaN(date.getTime()) ? String(isoOrDate) : dateFormat.format(date);
}

export const prefersReducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Read dropped/selected File objects into { name, type, bytes }. */
export async function readFiles(fileList) {
  const out = [];
  for (const file of fileList) out.push({ name: file.name, type: file.type, size: file.size, bytes: new Uint8Array(await file.arrayBuffer()) });
  return out;
}

/**
 * Make a .dropzone accept dropped files (in addition to its file input).
 * onFiles receives a FileList-like array.
 */
export function wireDropzone(zone, onFiles) {
  const input = zone.querySelector('input[type="file"]');
  input.addEventListener('change', () => {
    if (input.files && input.files.length) onFiles([...input.files]);
    input.value = '';
  });
  let depth = 0;
  zone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    zone.classList.add('is-dragging');
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove('is-dragging');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove('is-dragging');
    const files = e.dataTransfer ? [...e.dataTransfer.files] : [];
    if (files.length) onFiles(files);
  });
}

let idCounter = 0;
export const uniqueId = (prefix = 'u') => `${prefix}${++idCounter}`;
