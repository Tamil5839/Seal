// Emblem nodes for the page (each with its own id prefix, so several can
// appear at once), plain clay tablets, and the verification visuals.

import { makeRng, emblemBandSvg, emblemStampSvg } from '../lib/emblem.js';
import { h, svgNode, uniqueId } from './dom.js';

export function bandNode(fp) {
  return svgNode(emblemBandSvg(fp, { idPrefix: uniqueId('eb') }));
}

export function stampNode(fp) {
  return svgNode(emblemStampSvg(fp, { idPrefix: uniqueId('es') }));
}

/** A clay tablet with no impression (for "no seal" and invalid seals). */
export function blankTabletNode(label) {
  const id = uniqueId('bt');
  return svgNode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200" width="600" height="200" role="img" aria-label="${label}">` +
    `<defs><linearGradient id="${id}-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d7a075"/><stop offset="0.55" stop-color="#c98b5e"/><stop offset="1" stop-color="#b0744a"/></linearGradient>` +
    `<filter id="${id}-n" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" stitchTiles="stitch"/>` +
    `<feColorMatrix type="matrix" values="0 0 0 0 0.22  0 0 0 0 0.12  0 0 0 0 0.05  1.6 0 0 0 -0.72"/><feComposite in2="SourceAlpha" operator="in"/></filter></defs>` +
    `<rect x="0.5" y="0.5" width="599" height="199" rx="16" fill="url(#${id}-g)" stroke="#8a5634"/>` +
    `<rect x="0" y="0" width="600" height="200" rx="16" filter="url(#${id}-n)" opacity="0.35"/></svg>`,
  );
}

function crackPaths(seed) {
  const rng = makeRng(seed);
  const walk = (x, y, stepY, spread, maxY) => {
    const points = [[x, y]];
    while (y < maxY) {
      y = Math.min(maxY, y + stepY + rng.int(stepY));
      x += rng.int(spread * 2 + 1) - spread;
      points.push([x, y]);
    }
    return points;
  };
  const main = walk(230 + rng.int(140), -4, 12, 22, 204);
  const paths = [main];
  for (let b = 0; b < 3; b++) {
    const [bx, by] = main[1 + rng.int(main.length - 2)];
    const dir = rng.chance(1, 2) ? 1 : -1;
    const branch = [[bx, by]];
    let x = bx;
    let y = by;
    for (let k = 0; k < 3 + rng.int(3); k++) {
      x += dir * (16 + rng.int(22));
      y += rng.int(25) - 6;
      branch.push([x, y]);
    }
    paths.push(branch);
  }
  return paths.map((pts) => 'M' + pts.map(([x, y]) => `${x} ${y}`).join(' L'));
}

function crackOverlay(seed) {
  const paths = crackPaths(seed);
  const strokes = paths.map((d) => `<path class="crack crack--dark" d="${d}"/><path class="crack crack--red" d="${d}"/>`).join('') +
    paths.map((d) => `<path class="crack crack--light" d="${d}" transform="translate(-1.5 -1)"/>`).join('');
  return svgNode(`<svg xmlns="http://www.w3.org/2000/svg" class="impression-overlay" viewBox="0 0 600 200" aria-hidden="true" focusable="false">${strokes}</svg>`);
}

function revokedOverlay() {
  const id = uniqueId('rv');
  return svgNode(
    `<svg xmlns="http://www.w3.org/2000/svg" class="impression-overlay" viewBox="0 0 600 200" aria-hidden="true" focusable="false">` +
    `<defs><pattern id="${id}" width="22" height="22" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)"><rect width="11" height="22" fill="#1e1b18" opacity="0.4"/></pattern>` +
    `<clipPath id="${id}-c"><rect x="0" y="0" width="600" height="200" rx="16"/></clipPath></defs>` +
    `<rect width="600" height="200" fill="url(#${id})" clip-path="url(#${id}-c)"/></svg>`,
  );
}

const LABELS = {
  intact: 'Seal impression, intact',
  altered: 'Seal impression, cracked: the file changed',
  revoked: 'Seal impression, struck through: the seal was revoked',
  invalid: 'Broken clay tablet: the seal is not valid',
  none: 'Smooth clay tablet: no seal found',
};

/**
 * The visual for a verification result.
 * state: "intact" | "altered" | "revoked" | "invalid" | "none"
 * fp: the signer's fingerprint (only for states with a trustworthy signer)
 */
export function impressionNode(state, fp, seedForCracks) {
  const showEmblem = fp && (state === 'intact' || state === 'altered' || state === 'revoked');
  const art = showEmblem ? bandNode(fp) : blankTabletNode(LABELS[state]);
  art.classList.add('impression-art');
  if (showEmblem) art.setAttribute('aria-label', LABELS[state]);
  const wrap = h('div', { className: `impression impression--${state}` }, art);
  if (state === 'altered' || state === 'invalid') wrap.append(crackOverlay(seedForCracks || fp || new Uint8Array(32)));
  if (state === 'revoked') wrap.append(revokedOverlay());
  return wrap;
}
