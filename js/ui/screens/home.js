import { fromHex } from '../../lib/bytes.js';
import { $, clear, withSealIds } from '../dom.js';
import { bandNode, stampNode } from '../emblems.js';
import { on, state } from '../state.js';
import { registerScreen } from '../router.js';

// A fixed example fingerprint for visitors who don't have a seal yet.
const EXAMPLE = fromHex('5ea1c0de7a6b1e70f3c2a9d48e6b0f1253a7c9e4d2b8f6a0c3e5d7b9a1f2e4c6');

function render() {
  const frame = $('[data-hero-emblem]');
  const caption = $('[data-hero-caption]');
  const create = $('[data-home-create]');
  clear(frame).append(bandNode(state.identity ? state.identity.fingerprint : EXAMPLE));
  if (state.identity) {
    clear(caption).append(...withSealIds(`Your seal’s emblem · ${state.identity.sealId}`));
    create.href = '#/my-seal';
    $('[data-home-create-title]').textContent = 'My seal';
    clear($('[data-home-create-text]')).append(...withSealIds(`${state.identity.sealId} — see your emblem, back it up, or make a revocation notice.`));
  } else {
    caption.textContent = 'Every seal gets its own emblem, rolled out like an ancient cylinder seal. This one is an example.';
    create.href = '#/create';
    $('[data-home-create-title]').textContent = 'Create my seal';
    $('[data-home-create-text]').textContent = 'Make your private key, emblem and Seal ID. Takes a minute.';
  }
  const navStamp = $('[data-my-stamp]');
  clear(navStamp);
  if (state.identity) navStamp.append(stampNode(state.identity.fingerprint));
}

export function initHome() {
  registerScreen('home', { show: render });
  on('identity', render);
  render();
}
