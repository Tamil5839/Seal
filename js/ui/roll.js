// The rolling-seal animation: a lapis cylinder seal with gold caps rolls
// across wet clay and leaves its impression behind (about 1.5 s). With
// reduced motion the finished impression is shown straight away.

import { emblemBandSvg } from '../lib/emblem.js';
import { clear, prefersReducedMotion, svgNode, uniqueId } from './dom.js';

const X0 = 40; // where the impression starts on the stage
const WIDTH = 600;

function stageMarkup(id, fp) {
  const band = emblemBandSvg(fp, { idPrefix: `${id}e` }).replace('<svg ', `<svg x="${X0}" y="30" `);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="roll-svg" viewBox="0 0 680 260" aria-hidden="true" focusable="false">` +
    `<defs>` +
    `<linearGradient id="${id}-slab" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cf9567"/><stop offset="1" stop-color="#ad7147"/></linearGradient>` +
    `<linearGradient id="${id}-lapis" x1="0" x2="1"><stop offset="0" stop-color="#132a55"/><stop offset="0.4" stop-color="#3f6fc0"/><stop offset="0.55" stop-color="#2f5da8"/><stop offset="1" stop-color="#10234a"/></linearGradient>` +
    `<linearGradient id="${id}-shade" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity="0.55"/><stop offset="0.3" stop-color="#000" stop-opacity="0"/><stop offset="0.42" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.58" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/></linearGradient>` +
    `<linearGradient id="${id}-gold" x1="0" x2="1"><stop offset="0" stop-color="#8f6519"/><stop offset="0.42" stop-color="#f3cd72"/><stop offset="1" stop-color="#8a6117"/></linearGradient>` +
    `<radialGradient id="${id}-shadow"><stop offset="0" stop-color="#2a150a" stop-opacity="0.45"/><stop offset="1" stop-color="#2a150a" stop-opacity="0"/></radialGradient>` +
    `<clipPath id="${id}-reveal"><rect data-reveal="1" x="${X0}" y="0" width="0" height="260"/></clipPath>` +
    `<clipPath id="${id}-body"><rect x="-38" y="24" width="76" height="212" rx="8"/></clipPath>` +
    `</defs>` +
    `<rect x="8" y="10" width="664" height="240" rx="26" fill="url(#${id}-slab)"/>` +
    `<rect x="8" y="10" width="664" height="240" rx="26" fill="none" stroke="#7a4a2a" stroke-opacity="0.35" stroke-width="2"/>` +
    `<g clip-path="url(#${id}-reveal)">${band}</g>` +
    `<g data-cylinder="1" class="roll-cylinder" transform="translate(${X0} 0)">` +
    `<ellipse cx="18" cy="246" rx="52" ry="10" fill="url(#${id}-shadow)"/>` +
    `<rect x="-38" y="24" width="76" height="212" rx="8" fill="url(#${id}-lapis)"/>` +
    `<g clip-path="url(#${id}-body)"><g data-pattern="1" transform="translate(0 30) scale(-1 1)">` +
    `<use href="#${id}e-art" x="0.8" y="0.8" fill="#9dbdf2" stroke="#9dbdf2" opacity="0.35"/>` +
    `<use href="#${id}e-art" fill="#0c1d3b" stroke="#0c1d3b" opacity="0.75"/>` +
    `</g></g>` +
    `<rect x="-38" y="24" width="76" height="212" rx="8" fill="url(#${id}-shade)"/>` +
    `<rect x="-41" y="12" width="82" height="16" rx="4" fill="url(#${id}-gold)"/>` +
    `<rect x="-41" y="232" width="82" height="16" rx="4" fill="url(#${id}-gold)"/>` +
    `<path d="M0 12 C0 -4 -16 -12 -34 -30" fill="none" stroke="#5b3b22" stroke-width="3" stroke-linecap="round"/>` +
    `</g></svg>`
  );
}

const ease = (t) => 0.5 - Math.cos(Math.PI * t) / 2;

/**
 * Roll the seal with fingerprint `fp` into `container`.
 * Resolves when the impression is complete.
 */
export function rollSeal(container, fp, { duration = 1500 } = {}) {
  const id = uniqueId('roll');
  const svg = svgNode(stageMarkup(id, fp));
  clear(container).append(svg);
  const reveal = svg.querySelector('[data-reveal]');
  const cylinder = svg.querySelector('[data-cylinder]');
  const pattern = svg.querySelector('[data-pattern]');

  const place = (t) => {
    const x = WIDTH * t;
    reveal.setAttribute('width', x.toFixed(2));
    cylinder.setAttribute('transform', `translate(${(X0 + x).toFixed(2)} 0)`);
    pattern.setAttribute('transform', `translate(${x.toFixed(2)} 30) scale(-1 1)`);
  };
  const finish = () => {
    place(1);
    cylinder.remove();
  };

  if (prefersReducedMotion()) {
    finish();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let start = null;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      const lift = cylinder.animate
        ? cylinder.animate([{ opacity: 1, transform: `translate(${X0 + WIDTH}px, 0px)` }, { opacity: 0, transform: `translate(${X0 + WIDTH + 30}px, -24px)` }], { duration: 380, easing: 'ease-out' })
        : null;
      const cleanup = () => {
        finish();
        resolve();
      };
      if (lift) lift.onfinish = cleanup;
      else cleanup();
      setTimeout(cleanup, 600);
    };
    const step = (now) => {
      if (done) return;
      if (start === null) start = now;
      const t = Math.min(1, (now - start) / duration);
      place(ease(t));
      if (t < 1) requestAnimationFrame(step);
      else end();
    };
    place(0);
    requestAnimationFrame(step);
    // If the tab is in the background, animation frames pause: finish anyway.
    setTimeout(end, duration + 800);
  });
}
