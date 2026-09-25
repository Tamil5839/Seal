// Every main motif in several variants, drawn in its box, for design review.
import { makeRng } from '../js/lib/emblem.js';
import { FILLERS, MAIN, at } from '../js/lib/motifs.js';

const sheet = document.getElementById('sheet');
const H = 132;
const VARIANTS = 8;
for (const [name, spec] of Object.entries(MAIN)) {
  const row = document.createElement('div');
  row.className = 'sheet-row';
  let x = 6;
  let body = '';
  for (let v = 0; v < VARIANTS; v++) {
    const rng = makeRng(new Uint8Array(32).map((_, i) => (i * 31 + v * 97 + name.length * 13) & 255));
    const w = spec.widths[v % 2];
    body += `<rect x="${x}" y="4" width="${w}" height="${H}" fill="none" stroke="#0002"/>` + at(x + w / 2, 4 + H / 2, spec.draw(spec.choose(rng), w, H));
    x += w + 10;
  }
  row.innerHTML = `<h3>${name}</h3><svg viewBox="0 0 ${x} ${H + 8}" width="${x}" height="${H + 8}" fill="#6b3d20" stroke="#6b3d20">${body}</svg>`;
  sheet.append(row);
}
const frow = document.createElement('div');
let fx = 6; let fbody = '';
for (const [name, spec] of Object.entries(FILLERS)) {
  for (let v = 0; v < 2; v++) {
    const rng = makeRng(new Uint8Array(32).map((_, i) => (i * 7 + v * 3) & 255));
    fbody += at(fx + 16, 20, spec.draw(spec.choose(rng), 24));
    fx += 34;
  }
}
frow.innerHTML = `<h3>fillers</h3><svg viewBox="0 0 ${fx} 40" width="${fx * 2}" height="80" fill="#6b3d20" stroke="#6b3d20">${fbody}</svg>`;
sheet.append(frow);
