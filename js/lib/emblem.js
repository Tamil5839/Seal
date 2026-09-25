// Emblems: deterministic artwork derived from a public-key fingerprint.
//
// The band is a cylinder-seal impression "rolled out" on clay: a sequence of
// figures (one turn of the cylinder, the "period") repeats across the band,
// starting at a key-dependent point, between two borders. The stamp is a
// round version for avatars built from the same choices.
//
// Emblems are for recognising a seal at a glance. They are not a security
// check: careful verification compares the Seal ID.
//
// Everything is decided by an integer-only PRNG seeded from the fingerprint,
// and drawn with plain arithmetic (see motifs.js), so the same key gives the
// same SVG text in every browser.

import { toHex } from './bytes.js';
import { BORDERS, FILLERS, GAPS, MAIN, at, d, group, n, radial, shape } from './motifs.js';
import { sealIdFromFingerprint } from './seal-id.js';

// ------------------------------------------------------------- PRNG

/** sfc32, seeded from the 32 fingerprint bytes. Integer arithmetic only. */
export function makeRng(fp) {
  const word = (i) => (fp[i] | (fp[i + 1] << 8) | (fp[i + 2] << 16) | (fp[i + 3] << 24)) >>> 0;
  let a = (word(0) ^ word(16)) >>> 0;
  let b = (word(4) ^ word(20)) >>> 0;
  let c = (word(8) ^ word(24)) >>> 0;
  let e = (word(12) ^ word(28)) >>> 0;
  const next = () => {
    const t = (((a + b) | 0) + e) | 0;
    e = (e + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 15; i++) next();
  const rng = {
    next,
    int: (count) => next() % count,
    range: (lo, hi) => lo + (next() % (hi - lo + 1)),
    pick: (list) => list[next() % list.length],
    chance: (num, den) => next() % den < num,
    shuffle(list) {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = next() % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
  return rng;
}

// ------------------------------------------------------------- plan

const BORDER_STYLES = ['lines', 'zigzag', 'dots', 'rope', 'triangles', 'ladder', 'waves', 'plain'];
const GAP_TYPES = ['space', 'line', 'double', 'dots', 'ladder', 'stack', 'stack'];

/** All the choices that make up an emblem. Pure function of the fingerprint. */
export function emblemPlan(fp) {
  const rng = makeRng(fp);
  const border = { style: rng.pick(BORDER_STYLES), unit: rng.pick([10, 12, 14, 16]), shift: rng.int(16) };
  const panels = [];
  const gaps = [];
  let period = 0;
  for (const motif of rng.shuffle(Object.keys(MAIN))) {
    const spec = MAIN[motif];
    const width = rng.range(spec.widths[0], spec.widths[1]);
    panels.push({ motif, width, params: spec.choose(rng) });
    const type = rng.pick(GAP_TYPES);
    const gap = { type, width: rng.range(GAPS[type].widths[0], GAPS[type].widths[1]), params: GAPS[type].choose(rng) };
    gaps.push(gap);
    period += width + gap.width;
    if (panels.length >= 3 && (period >= 340 || panels.length === 5)) break;
  }
  const phase = rng.int(period);
  const fillerNames = rng.shuffle(Object.keys(FILLERS)).slice(0, 2);
  const stamp = {
    count: rng.pick([8, 10, 12]),
    fillers: fillerNames.map((name) => ({ name, params: FILLERS[name].choose(rng) })),
    turn: rng.chance(1, 2),
  };
  return { border, panels, gaps, period, phase, stamp };
}

// ----------------------------------------------------------- colours

const CLAY = {
  light: '#d7a075',
  base: '#c98b5e',
  dark: '#b0744a',
  field: '#b0734a',
  face: '#d49d71',
  highlight: '#fbdcb6',
  shadow: '#4f2a13',
  edge: '#8a5634',
};

function defsCommon(id, gradient) {
  return (
    `<linearGradient id="${id}-light" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${CLAY.light}"/><stop offset="0.55" stop-color="${CLAY.base}"/><stop offset="1" stop-color="${CLAY.dark}"/>` +
    `</linearGradient>` +
    gradient +
    `<filter id="${id}-grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" stitchTiles="stitch"/>` +
    `<feColorMatrix type="matrix" values="0 0 0 0 0.22  0 0 0 0 0.12  0 0 0 0 0.05  1.6 0 0 0 -0.72"/>` +
    `<feComposite in2="SourceAlpha" operator="in"/>` +
    `</filter>`
  );
}

/** The three copies that make artwork look pressed into clay. */
function relief(id) {
  return (
    `<use href="#${id}-art" x="1.7" y="2" fill="${CLAY.shadow}" stroke="${CLAY.shadow}" opacity="0.7"/>` +
    `<use href="#${id}-art" x="-1.1" y="-1.2" fill="${CLAY.highlight}" stroke="${CLAY.highlight}" opacity="0.9"/>` +
    `<use href="#${id}-art" fill="${CLAY.face}" stroke="${CLAY.face}"/>`
  );
}

function svgOpen(width, height, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}">`;
}

function describe(fp, kind) {
  const sealId = sealIdFromFingerprint(fp);
  return {
    label: `Seal emblem (${kind}) for ${sealId}`,
    meta: `<title>Seal emblem for ${sealId}</title>` +
      `<desc>Generated from the SEAL public key fingerprint ${toHex(fp)}. The emblem helps you recognise a seal at a glance; for careful verification compare the Seal ID.</desc>`,
  };
}

// ------------------------------------------------------------- band

export const BAND = { width: 600, height: 200 };
const FIELD = { top: 30, height: 140 }; // between the borders
const FIGURE_H = 132;
const BORDER_H = 18;

export function emblemBandSvg(fp, { idPrefix } = {}) {
  const plan = emblemPlan(fp);
  const id = idPrefix || `e${toHex(fp.subarray(0, 4))}b`;
  const { width: W, height: H } = BAND;
  const midY = FIELD.top + FIELD.height / 2;

  let x = 0;
  let period = '';
  plan.panels.forEach((panel, i) => {
    period += at(x + panel.width / 2, midY, MAIN[panel.motif].draw(panel.params, panel.width, FIGURE_H));
    x += panel.width;
    const gap = plan.gaps[i];
    period += at(x + gap.width / 2, midY, GAPS[gap.type].draw(gap.params, gap.width, FIGURE_H));
    x += gap.width;
  });

  let copies = '';
  for (let k = 0; k * plan.period < W + plan.phase; k++) copies += `<use href="#${id}-period" x="${n(k * plan.period)}"/>`;

  const border = BORDERS[plan.border.style];
  const x0 = -plan.border.shift - plan.border.unit;
  const strip = border.band(plan.border, x0, W + plan.border.unit, BORDER_H);
  const borders = at(0, 12, strip) + group({ transform: `translate(0 ${H - 12}) scale(1 -1)` }, strip);

  const { label, meta } = describe(fp, 'band');
  return (
    svgOpen(W, H, label) + meta +
    `<defs>` +
    defsCommon(id, '') +
    `<clipPath id="${id}-clip"><rect x="4" y="8" width="${W - 8}" height="${H - 16}" rx="9"/></clipPath>` +
    `<g id="${id}-period">${period}</g>` +
    `<g id="${id}-art"><g transform="translate(${n(-plan.phase)} 0)">${copies}</g>${borders}</g>` +
    `</defs>` +
    shape('rect', { x: 0.5, y: 0.5, width: W - 1, height: H - 1, rx: 16, fill: `url(#${id}-light)`, stroke: CLAY.edge, 'stroke-width': 1 }) +
    shape('rect', { x: 4, y: 8, width: W - 8, height: H - 16, rx: 9, fill: CLAY.field }) +
    group({ 'clip-path': `url(#${id}-clip)` },
      relief(id) +
      shape('path', { d: d`M4 9.5 L${W - 4} 9.5`, stroke: CLAY.shadow, 'stroke-width': 3, opacity: 0.45, fill: 'none' }) +
      shape('path', { d: d`M4 ${H - 9} L${W - 4} ${H - 9}`, stroke: CLAY.highlight, 'stroke-width': 2, opacity: 0.6, fill: 'none' })) +
    shape('rect', { x: 0, y: 0, width: W, height: H, rx: 16, filter: `url(#${id}-grain)`, opacity: 0.35 }) +
    `</svg>`
  );
}

// ------------------------------------------------------------ stamp

export const STAMP = { size: 200 };

export function emblemStampSvg(fp, { idPrefix } = {}) {
  const plan = emblemPlan(fp);
  const id = idPrefix || `e${toHex(fp.subarray(0, 4))}s`;
  const S = STAMP.size;
  const C = S / 2;

  // The first figure sits in the middle. Boxy figures fill their corners, so
  // they are drawn a little smaller to stay inside the ring of symbols.
  const main = plan.panels[0];
  const boxy = main.motif === 'inscription' || (main.motif === 'lattice' && main.params.frame);
  const scale = boxy ? Math.min(84 / FIGURE_H, 70 / main.width) : Math.min(96 / FIGURE_H, 86 / main.width);
  const centre = group({ transform: `scale(${n(scale)})` }, MAIN[main.motif].draw(main.params, main.width, FIGURE_H));

  const [f1, f2] = plan.stamp.fillers;
  const offset = plan.stamp.turn ? 180 / plan.stamp.count : 0;
  const ringFillers = radial(plan.stamp.count, (i) => {
    const f = i % 2 && plan.stamp.count % 2 === 0 ? f2 : f1;
    return at(0, -66, FILLERS[f.name].draw(f.params, 17));
  }, offset);

  const border = BORDERS[plan.border.style];
  const count = Math.max(12, Math.round((3.1416 * (76 + 90)) / (plan.border.unit * 1.1)));
  const rim = border.ring(plan.border, 76, 91, count);

  const { label, meta } = describe(fp, 'round stamp');
  return (
    svgOpen(S, S, label) + meta +
    `<defs>` +
    defsCommon(id, '') +
    `<clipPath id="${id}-clip"><circle cx="${C}" cy="${C}" r="92"/></clipPath>` +
    `<g id="${id}-art">${at(C, C, centre + ringFillers + rim)}</g>` +
    `</defs>` +
    shape('circle', { cx: C, cy: C, r: 99.5, fill: `url(#${id}-light)`, stroke: CLAY.edge, 'stroke-width': 1 }) +
    shape('circle', { cx: C, cy: C, r: 92, fill: CLAY.field }) +
    group({ 'clip-path': `url(#${id}-clip)` },
      relief(id) +
      shape('circle', { cx: C, cy: C + 1, r: 92, fill: 'none', stroke: CLAY.shadow, 'stroke-width': 3, opacity: 0.4 })) +
    shape('circle', { cx: C, cy: C, r: 100, filter: `url(#${id}-grain)`, opacity: 0.35 }) +
    `</svg>`
  );
}
