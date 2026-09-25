// Hash routing between the <section data-screen> elements.

import { $, $$ } from './dom.js';

const handlers = new Map();
let current = null;
let startedOnce = false; // focus headings only after the first render

export function registerScreen(name, { show } = {}) {
  handlers.set(name, { show });
}

export function currentScreen() {
  return current;
}

export function navigate(name) {
  if (location.hash !== `#/${name}`) location.hash = `#/${name}`;
  else render();
}

function render() {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
  const name = $(`[data-screen="${CSS.escape(raw)}"]`) ? raw : 'home';
  const changed = name !== current;
  current = name;
  for (const section of $$('[data-screen]')) section.hidden = section.dataset.screen !== name;
  for (const link of $$('[data-nav]')) {
    if (link.dataset.nav === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const section = $(`[data-screen="${name}"]`);
  document.title = name === 'home' ? 'SEAL — personal seals for your files' : `${section.dataset.title} — SEAL`;
  const handler = handlers.get(name);
  if (handler && handler.show) handler.show();
  if (changed) {
    window.scrollTo(0, 0);
    const heading = section.querySelector('h1');
    if (heading && document.readyState !== 'loading' && startedOnce) heading.focus({ preventScroll: true });
  }
  startedOnce = true;
}

export function startRouter() {
  window.addEventListener('hashchange', render);
  render();
}
