// Application state shared by the screens.

import { fingerprint } from '../lib/seal-id.js';

export const state = {
  supported: false, // Ed25519 available
  store: null, // Keystore, or null when storage is unavailable
  storageError: null,
  identity: null, // { privateKey, publicKey, sealId, fingerprint, createdAt, origin }
  sessionBackup: null, // encrypted backup of the identity, if made or restored in this session
  known: [], // [{ sealId, name, publicKey, savedAt }]
  revocations: [], // revocation notices remembered on this device
};

const bus = new EventTarget();

export function on(event, handler) {
  bus.addEventListener(event, (e) => handler(e.detail));
}

export function emit(event, detail) {
  bus.dispatchEvent(new CustomEvent(event, { detail }));
}

export async function loadIdentity() {
  if (!state.store) {
    state.identity = null;
  } else {
    const identity = await state.store.loadIdentity();
    state.identity = identity ? { ...identity, fingerprint: await fingerprint(identity.publicKey) } : null;
  }
  emit('identity', state.identity);
}

export async function loadKnown() {
  state.known = state.store ? await state.store.listKnown() : [];
  state.revocations = state.store ? await state.store.listRevocations() : [];
  emit('known', state.known);
}

export function knownName(sealId) {
  const entry = state.known.find((k) => k.sealId === sealId);
  return entry ? entry.name : null;
}

export function isMine(sealId) {
  return Boolean(state.identity && state.identity.sealId === sealId);
}
