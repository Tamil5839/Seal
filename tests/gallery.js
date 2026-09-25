import { fromHex } from '../js/lib/bytes.js';
import { emblemBandSvg, emblemStampSvg, emblemPlan } from '../js/lib/emblem.js';
import { fingerprint, sealIdFromFingerprint } from '../js/lib/seal-id.js';
import { RFC8032 } from './fixtures.js';

const params = new URLSearchParams(location.search);
if (params.has('dark')) document.body.classList.add('dark');
const count = Number(params.get('n') || 24);
let seed = Number(params.get('seed') || 0);
const grid = document.getElementById('grid');

function rand32() {
  const out = new Uint8Array(32);
  if (seed) { for (let i = 0; i < 32; i++) { seed = (seed * 1103515245 + 12345) >>> 0; out[i] = seed >>> 24; } }
  else crypto.getRandomValues(out);
  return out;
}

function show(fp, i) {
  const fig = document.createElement('figure');
  fig.innerHTML = emblemBandSvg(fp, { idPrefix: `g${i}b` }) + emblemStampSvg(fp, { idPrefix: `g${i}s` });
  const cap = document.createElement('figcaption');
  const plan = emblemPlan(fp);
  cap.textContent = `${sealIdFromFingerprint(fp)} · ${plan.border.style} · ${plan.panels.map((p) => p.motif).join(', ')} · P=${plan.period}`;
  fig.append(cap);
  grid.append(fig);
}

let i = 0;
for (const v of RFC8032.slice(0, 3)) show(await fingerprint(fromHex(v.public)), i++);
for (let k = 0; k < count; k++) show(rand32(), i++);
window.__GALLERY_DONE__ = true;
