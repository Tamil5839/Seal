// SEAL - entry point. Detects support, opens local storage, wires screens.

import { ed25519Supported } from './lib/ed25519.js';
import { openKeystore } from './lib/keystore.js';
import { $, $$, copyText, uniqueId } from './ui/dom.js';
import { startRouter } from './ui/router.js';
import { loadIdentity, loadKnown, state } from './ui/state.js';
import { initHome } from './ui/screens/home.js';
import { initCreate } from './ui/screens/create.js';
import { initRestore } from './ui/screens/restore.js';
import { initSeal } from './ui/screens/seal.js';
import { initVerify } from './ui/screens/verify.js';
import { initMySeal } from './ui/screens/my-seal.js';

function mountHonestyPanels() {
  const template = $('#tpl-honesty');
  for (const slot of $$('[data-honesty]')) {
    const panel = template.content.firstElementChild.cloneNode(true);
    const heading = panel.querySelector('.honesty-title');
    heading.id = uniqueId('honesty');
    panel.setAttribute('aria-labelledby', heading.id);
    if ('compact' in slot.dataset) panel.classList.add('honesty--compact');
    slot.replaceWith(panel);
  }
}

function wireCopyButtons() {
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-copy-from]');
    if (!button) return;
    const source = $(button.dataset.copyFrom);
    if (source) copyText(source.textContent.trim(), button);
  });
}

async function start() {
  mountHonestyPanels();
  wireCopyButtons();

  state.supported = await ed25519Supported();
  if (!state.supported) {
    $('#support-banner').hidden = false;
    document.body.classList.add('no-crypto');
  }
  try {
    state.store = await openKeystore();
  } catch (error) {
    state.store = null;
    state.storageError = error.message;
    $('#storage-banner').hidden = false;
  }
  try {
    await loadIdentity();
    await loadKnown();
  } catch (error) {
    state.storageError = error.message;
    $('#storage-banner').hidden = false;
  }

  initHome();
  initCreate();
  initRestore();
  initSeal();
  initVerify();
  initMySeal();
  startRouter();
  document.documentElement.dataset.ready = 'true';
}

start();
