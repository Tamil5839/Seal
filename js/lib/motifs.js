// The motif library for emblems: original geometric designs in the general
// spirit of cylinder-seal impressions (stars, rosettes, reeds, streams, curls,
// zig-zags, trees, standards, braids, wedge "inscriptions", volutes, lattices,
// scales, fans, celestial columns), plus small filler symbols and borders.
//
// Determinism rules (so an emblem is byte-identical on every device):
//  - only + - * / and Math.round/min/max/abs/floor on numbers; no sin, cos,
//    sqrt, pow, random, dates. Rotations are left to SVG transforms.
//  - every number is written through n(), which rounds to 2 decimals.
// Shapes carry geometry only; fill and stroke colour are inherited, so the
// same artwork can be drawn several times for the clay relief effect.

// ------------------------------------------------------------ helpers

export function n(x) {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Tagged template for path data: numbers are formatted with n(). */
export function d(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += (typeof values[i] === 'number' ? n(values[i]) : values[i]) + strings[i + 1];
  return out;
}

const attrs = (o) => Object.entries(o).map(([k, v]) => ` ${k}="${typeof v === 'number' ? n(v) : v}"`).join('');
export const shape = (tag, o) => `<${tag}${attrs(o)}/>`;
export const group = (o, children) => `<g${attrs(o)}>${children}</g>`;

export const fill = (path) => shape('path', { d: path, stroke: 'none' });
export const line = (path, width) => shape('path', { d: path, fill: 'none', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
export const disk = (cx, cy, r) => shape('circle', { cx, cy, r, stroke: 'none' });
export const ring = (cx, cy, r, width) => shape('circle', { cx, cy, r, fill: 'none', 'stroke-width': width });
export const oval = (cx, cy, rx, ry) => shape('ellipse', { cx, cy, rx, ry, stroke: 'none' });
export const ovalLine = (cx, cy, rx, ry, width) => shape('ellipse', { cx, cy, rx, ry, fill: 'none', 'stroke-width': width });
export const at = (x, y, children, extra = '') => group({ transform: `translate(${n(x)} ${n(y)})${extra}` }, children);
export const rotate = (deg, children) => (deg ? group({ transform: `rotate(${n(deg)})` }, children) : children);
export const mirrorX = (on, children) => (on ? group({ transform: 'scale(-1 1)' }, children) : children);
export const mirrorY = (on, children) => (on ? group({ transform: 'scale(1 -1)' }, children) : children);

/** `count` copies of `unit` (drawn around the origin, pointing up) turned evenly around the origin. */
export function radial(count, unit, offset = 0) {
  let out = '';
  for (let i = 0; i < count; i++) {
    const unitSvg = typeof unit === 'function' ? unit(i) : unit;
    out += rotate(offset + (i * 360) / count, unitSvg);
  }
  return out;
}

/** `count` copies of `unit` fanned out evenly over `spread` degrees, centred on straight up. */
export function fanOut(count, spread, unit) {
  let out = '';
  for (let i = 0; i < count; i++) {
    const unitSvg = typeof unit === 'function' ? unit(i) : unit;
    out += rotate(-spread / 2 + (i * spread) / (count - 1), unitSvg);
  }
  return out;
}

/** A spiral of semicircles starting at (cx - r, cy), winding clockwise and inward. */
export function spiralPath(cx, cy, r, step, halfTurns) {
  let path = d`M${cx - r} ${cy}`;
  for (let k = 0; k < halfTurns; k++) {
    const radius = r - (k * step) / 2;
    if (radius <= step / 2) break;
    const centre = k % 2 ? cx + step / 2 : cx;
    const endX = k % 2 ? centre - radius : centre + radius;
    path += d` A${radius} ${radius} 0 0 1 ${endX} ${cy}`;
  }
  return path;
}

/** A vertical wave from y0 towards y1 (quadratic segments). */
export function vwave(x, y0, y1, amp, wavelength) {
  const half = wavelength / 2;
  let path = d`M${x} ${y0} Q${x + 2 * amp} ${y0 + half / 2} ${x} ${y0 + half}`;
  for (let y = y0 + half; y + half <= y1 + 0.01; y += half) path += d` T${x} ${y + half}`;
  return path;
}

/** A horizontal wave from x0 towards x1. */
export function hwave(y, x0, x1, amp, wavelength) {
  const half = wavelength / 2;
  let path = d`M${x0} ${y} Q${x0 + half / 2} ${y - 2 * amp} ${x0 + half} ${y}`;
  for (let x = x0 + half; x + half <= x1 + 0.01; x += half) path += d` T${x + half} ${y}`;
  return path;
}

/** Crescent with its horns pointing up, horn tips at (cx ± r, cy). */
export function crescent(cx, cy, r) {
  return fill(d`M${cx - r} ${cy} A${r} ${r} 0 0 0 ${cx + r} ${cy} A${r * 1.35} ${r * 1.35} 0 0 1 ${cx - r} ${cy}Z`);
}

function smallStar(rays, R, width = 0.18) {
  const b = R * width;
  return radial(rays, fill(d`M${-b} 0 L0 ${-R} L${b} 0Z`)) + disk(0, 0, R * 0.2);
}

// ------------------------------------------------------- main motifs
// Each motif: widths [min, max] of its box, choose(rng) -> params, and
// draw(params, w, h) drawing it centred on (0, 0) inside a w x h box.

const SW = 4.6; // main stroke width
const SW2 = 3.4; // detail stroke width

export const MAIN = {
  star: {
    widths: [112, 128],
    choose: (r) => ({
      rays: r.pick([6, 8, 8, 10, 12]),
      style: r.pick(['triangle', 'lance', 'wavy']),
      alternate: r.chance(1, 2),
      center: r.pick(['disk', 'ring']),
      turn: r.chance(1, 3),
    }),
    draw(p, w, h) {
      const R = Math.min(w, h) / 2 - 3;
      const r0 = R * 0.26;
      const b = R * (p.rays >= 10 ? 0.1 : 0.13);
      const rays = radial(p.rays, (i) => {
        const len = p.alternate && i % 2 ? R * 0.7 : R;
        if (p.style === 'triangle') return fill(d`M${-b} ${-r0} L0 ${-len} L${b} ${-r0}Z`);
        if (p.style === 'lance') {
          const mid = (r0 + len) / 2;
          return fill(d`M0 ${-r0} L${b * 1.1} ${-mid} L0 ${-len} L${-b * 1.1} ${-mid}Z`);
        }
        const a = R * 0.13;
        return line(d`M0 ${-r0} C${a} ${-(r0 + (len - r0) / 3)} ${-a} ${-(r0 + (2 * (len - r0)) / 3)} 0 ${-len}`, SW2);
      }, p.turn ? 180 / p.rays : 0);
      const centre = p.center === 'disk' ? disk(0, 0, R * 0.2) : ring(0, 0, R * 0.19, SW2) + disk(0, 0, R * 0.07);
      return rays + centre;
    },
  },

  rosette: {
    widths: [110, 126],
    choose: (r) => ({
      petals: r.pick([6, 8, 8, 10, 12, 16]),
      shape: r.pick(['oval', 'drop', 'outline']),
      rim: r.pick(['none', 'dots', 'ring']),
      turn: r.chance(1, 2),
    }),
    draw(p, w, h) {
      const R = Math.min(w, h) / 2 - 3;
      const outer = p.rim === 'none' ? R : R * 0.8;
      const pw = Math.min(0.22, 1.6 / p.petals) * outer;
      const offset = p.turn ? 180 / p.petals : 0;
      const petals = radial(p.petals, () => {
        if (p.shape === 'oval') return oval(0, -outer * 0.56, pw, outer * 0.34);
        if (p.shape === 'drop') {
          return fill(d`M0 ${-outer * 0.2} C${pw * 1.5} ${-outer * 0.42} ${pw * 1.3} ${-outer} 0 ${-outer} C${-pw * 1.3} ${-outer} ${-pw * 1.5} ${-outer * 0.42} 0 ${-outer * 0.2}Z`);
        }
        return ovalLine(0, -outer * 0.56, pw * 0.9, outer * 0.32, 2.8) + disk(0, -outer * 0.56, pw * 0.35);
      }, offset);
      let rim = '';
      if (p.rim === 'dots') rim = radial(p.petals, disk(0, -R * 0.93, R * 0.065), offset + 180 / p.petals);
      if (p.rim === 'ring') rim = ring(0, 0, R * 0.95, SW2);
      return petals + disk(0, 0, outer * 0.17) + rim;
    },
  },

  reeds: {
    widths: [64, 84],
    choose: (r) => ({ stems: r.pick([3, 3, 5]), leaves: r.pick([2, 3, 4]), top: r.pick(['bud', 'curl', 'tuft']), tie: r.chance(2, 3), mirror: r.chance(1, 2) }),
    draw(p, w, h) {
      const spread = w * 0.5;
      const bottom = h / 2 - 3;
      const out = [];
      for (let i = 0; i < p.stems; i++) {
        const t = i / (p.stems - 1);
        const x = -spread / 2 + spread * t;
        const edge = Math.abs(t - 0.5) * 2; // 0 in the middle, 1 at the edges
        const top = -h / 2 + 22 + edge * 16;
        out.push(line(d`M${x} ${bottom} L${x} ${top}`, 4));
        const middle = i === (p.stems - 1) / 2;
        if (p.top === 'curl' && middle) {
          out.push(line(d`M${x} ${top} C${x} ${top - 17} ${x + 15} ${top - 17} ${x + 15} ${top - 6} C${x + 15} ${top} ${x + 7} ${top} ${x + 7} ${top - 6}`, SW2));
        } else if (p.top === 'tuft') {
          out.push(line(d`M${x} ${top} L${x - 6} ${top - 10} M${x} ${top} L${x} ${top - 13} M${x} ${top} L${x + 6} ${top - 10}`, 2.8));
        } else {
          out.push(oval(x, top - 6, 3.8, 7.5));
        }
        if (i === 0 || i === p.stems - 1) {
          const dir = i === 0 ? -1 : 1;
          for (let k = 0; k < p.leaves; k++) {
            const y = bottom - 20 - (k * (bottom - top - 34)) / p.leaves;
            out.push(line(d`M${x} ${y} Q${x + dir * 9} ${y - 2} ${x + dir * 13} ${y - 15}`, 3.2));
          }
        }
      }
      if (p.tie) {
        const y = h * 0.14;
        out.push(line(d`M${-spread / 2 - 5} ${y} L${spread / 2 + 5} ${y} M${-spread / 2 - 5} ${y + 7} L${spread / 2 + 5} ${y + 7}`, 3.2));
      }
      return mirrorX(p.mirror, out.join(''));
    },
  },

  streams: {
    widths: [58, 80],
    choose: (r) => ({ streams: r.pick([2, 3, 3, 4]), amp: r.range(3, 5), wave: r.pick([18, 22, 26]), vessel: r.chance(1, 2), mirror: r.chance(1, 2) }),
    draw(p, w, h) {
      const spread = w * 0.58;
      const t = -h / 2 + 3;
      const top = p.vessel ? t + 33 : t + 2;
      const bottom = h / 2 - 3;
      const out = [];
      for (let i = 0; i < p.streams; i++) {
        const x = -spread / 2 + (spread * i) / (p.streams - 1);
        out.push(line(vwave(x, top, bottom, p.amp, p.wave), SW2));
      }
      if (p.vessel) {
        out.push(line(d`M-9 ${t + 1} L9 ${t + 1}`, 3.2));
        out.push(fill(d`M-5 ${t + 2} L-5 ${t + 7} C-17 ${t + 10} -17 ${t + 27} -6 ${t + 29} L6 ${t + 29} C17 ${t + 27} 17 ${t + 10} 5 ${t + 7} L5 ${t + 2}Z`));
      }
      return mirrorX(p.mirror, out.join(''));
    },
  },

  mane: {
    widths: [66, 90],
    choose: (r) => ({ cols: r.pick([2, 2, 3]), rows: r.pick([3, 4, 4, 5]), style: r.pick(['curls', 'hooks']), stagger: r.chance(1, 2) }),
    draw(p, w, h) {
      const cw = (w - 6) / p.cols;
      const rh = (h - 6) / p.rows;
      const s = Math.min(cw, rh) * 0.36;
      const out = [];
      for (let row = 0; row < p.rows; row++) {
        for (let col = 0; col < p.cols; col++) {
          const shift = p.stagger ? (row % 2 ? cw * 0.12 : -cw * 0.12) : 0;
          const cx = -w / 2 + 3 + cw * (col + 0.5) + shift;
          const cy = -h / 2 + 3 + rh * (row + 0.5);
          const left = col * 2 + 1 < p.cols || (col * 2 + 1 === p.cols && row % 2 === 0);
          const curl = p.style === 'curls'
            ? line(spiralPath(0, 0, s, s * 0.55, 3), SW2)
            : line(d`M${-s} ${s} Q${-s} ${-s} ${s * 0.5} ${-s} Q${s * 1.1} ${-s} ${s * 0.9} ${-s * 0.25}`, SW2);
          out.push(at(cx, cy, mirrorX(left, curl)));
        }
      }
      return out.join('');
    },
  },

  chevrons: {
    widths: [48, 70],
    choose: (r) => ({ rows: r.range(5, 8), style: r.pick(['chevron', 'zigzag', 'mountains']), down: r.chance(1, 2) }),
    draw(p, w, h) {
      const hw = w / 2 - 4;
      const top = -h / 2 + 4;
      const step = (h - 8) / p.rows;
      const out = [];
      if (p.style === 'chevron') {
        for (let i = 0; i < p.rows; i++) {
          const y = top + step * (i + 0.5);
          out.push(line(d`M${-hw} ${y + step * 0.32} L0 ${y - step * 0.32} L${hw} ${y + step * 0.32}`, 3.8));
        }
      } else if (p.style === 'zigzag') {
        const a = hw * 0.26;
        for (const x of [-hw * 0.66, 0, hw * 0.66]) {
          let path = d`M${x - a} ${top}`;
          for (let j = 1; j <= p.rows * 2; j++) path += d` L${x + (j % 2 ? a : -a)} ${top + (j * step) / 2}`;
          out.push(line(path, 3.2));
        }
      } else {
        const tw = (2 * hw) / 3;
        for (let i = 0; i < p.rows; i++) {
          const y = top + step * i;
          const shift = i % 2 ? tw / 2 : 0;
          for (let k = 0; k < (i % 2 ? 2 : 3); k++) {
            const x0 = -hw + shift + k * tw;
            out.push(fill(d`M${x0 + 1} ${y + step - 1.5} L${x0 + tw / 2} ${y + 2} L${x0 + tw - 1} ${y + step - 1.5}Z`));
          }
        }
      }
      return mirrorY(p.down, out.join(''));
    },
  },

  tree: {
    widths: [86, 108],
    choose: (r) => ({ levels: r.pick([2, 3, 3, 4]), tip: r.pick(['bud', 'dot', 'palmette']), crown: r.pick(['fan', 'bud', 'rosette']), base: r.pick(['mound', 'steps', 'none']) }),
    draw(p, w, h) {
      const foot = h / 2 - 3;
      const bottom = p.base === 'none' ? foot : foot - 10;
      const top = -h / 2 + 20;
      const out = [line(d`M0 ${foot} L0 ${top}`, SW)];
      for (let i = 0; i < p.levels; i++) {
        const y = bottom - 14 - (i * (bottom - top - 26)) / p.levels;
        const bx = (w / 2 - 10) * (1 - i * 0.14);
        const by = 15;
        for (const s of [-1, 1]) {
          out.push(line(d`M0 ${y} Q${s * bx * 0.55} ${y} ${s * bx} ${y - by}`, SW2));
          const tx = s * bx;
          const ty = y - by;
          if (p.tip === 'bud') out.push(oval(tx, ty - 4, 3.6, 6));
          else if (p.tip === 'dot') out.push(disk(tx, ty - 2, 4));
          else out.push(line(d`M${tx} ${ty} L${tx - 5} ${ty - 8} M${tx} ${ty} L${tx} ${ty - 10} M${tx} ${ty} L${tx + 5} ${ty - 8}`, 2.6));
        }
      }
      if (p.crown === 'fan') out.push(at(0, top, fanOut(5, 76, line(d`M0 -3 L0 -15`, 3))));
      else if (p.crown === 'bud') out.push(oval(0, top - 7, 5.5, 9));
      else out.push(at(0, top - 8, radial(6, disk(0, -6.5, 2.8)) + disk(0, 0, 3)));
      if (p.base === 'mound') out.push(fill(d`M${-w * 0.3} ${foot} Q0 ${foot - 22} ${w * 0.3} ${foot}Z`));
      if (p.base === 'steps') out.push(fill(d`M-20 ${foot} L20 ${foot} L20 ${foot - 6} L-20 ${foot - 6}Z M-12 ${foot - 8} L12 ${foot - 8} L12 ${foot - 13} L-12 ${foot - 13}Z`));
      return out.join('');
    },
  },

  standard: {
    widths: [50, 64],
    choose: (r) => ({ symbol: r.pick(['crescent', 'star', 'disk', 'ring']), ribbons: r.chance(1, 2), bands: r.pick([0, 2, 3]), base: r.pick(['steps', 'mound', 'tripod']) }),
    draw(p, w, h) {
      const top = -h / 2 + 32;
      const foot = h / 2 - 3;
      const bottom = foot - 10;
      const sy = top - 13;
      const out = [line(d`M0 ${bottom} L0 ${top}`, 4.2)];
      if (p.symbol === 'crescent') out.push(crescent(0, sy + 2, 13));
      else if (p.symbol === 'star') out.push(at(0, sy, smallStar(8, 14)));
      else if (p.symbol === 'disk') out.push(disk(0, sy, 9.5));
      else out.push(ring(0, sy, 9, SW2) + disk(0, sy, 3));
      if (p.ribbons) {
        for (const s of [-1, 1]) out.push(line(d`M0 ${top + 4} C${s * 10} ${top + 14} ${s * 4} ${top + 26} ${s * 14} ${top + 40}`, 3));
      }
      for (let i = 0; i < p.bands; i++) {
        const y = top + 50 + i * 12;
        out.push(line(d`M-6 ${y} L6 ${y}`, 3.2));
      }
      if (p.base === 'steps') out.push(fill(d`M-18 ${foot} L18 ${foot} L18 ${foot - 5} L-18 ${foot - 5}Z M-11 ${foot - 7} L11 ${foot - 7} L11 ${foot - 11} L-11 ${foot - 11}Z`));
      else if (p.base === 'mound') out.push(fill(d`M-20 ${foot} Q0 ${foot - 20} 20 ${foot}Z`));
      else out.push(line(d`M0 ${bottom} L-13 ${foot} M0 ${bottom} L13 ${foot} M0 ${bottom} L0 ${foot}`, 3.2));
      return out.join('');
    },
  },

  braid: {
    widths: [40, 54],
    choose: (r) => ({ style: r.pick(['rings', 'braid']), count: r.range(3, 5) }),
    draw(p, w, h) {
      const out = [];
      if (p.style === 'rings') {
        const r = Math.min(w / 2 - 4, (h - 8) / (p.count * 1.55 + 0.45));
        const step = (h - 8 - 2 * r) / (p.count - 1);
        for (let i = 0; i < p.count; i++) {
          const cy = -h / 2 + 4 + r + i * step;
          out.push(ring(0, cy, r, 3.2), disk(0, cy, 3));
        }
      } else {
        const a = w / 2 - 7;
        const top = -h / 2 + 4;
        const wave = (h - 8) / p.count;
        out.push(line(vwave(0, top, h / 2 - 4, a / 2, wave), SW2), line(vwave(0, top, h / 2 - 4, -a / 2, wave), SW2));
        for (let i = 0; i < p.count * 2; i++) {
          const y = top + wave / 4 + (i * wave) / 2;
          if (y < h / 2 - 6) out.push(disk(0, y, 2.6));
        }
      }
      return out.join('');
    },
  },

  inscription: {
    widths: [72, 96],
    choose(r) {
      const cols = r.pick([2, 3]);
      const rows = r.pick([3, 4]);
      const signs = [];
      for (let i = 0; i < cols * rows; i++) {
        const wedges = [];
        const count = r.range(2, 4);
        for (let k = 0; k < count; k++) wedges.push({ kind: r.pick(['h', 'h', 'v', 'v', 'a']), gx: r.int(3), gy: r.int(3) });
        signs.push(wedges);
      }
      return { cols, rows, signs };
    },
    draw(p, w, h) {
      const fw = w - 6;
      const fh = h - 6;
      const cw = fw / p.cols;
      const ch = fh / p.rows;
      const u = Math.min(cw, ch) / 4.4;
      const out = [shape('rect', { x: -fw / 2, y: -fh / 2, width: fw, height: fh, rx: 2, fill: 'none', 'stroke-width': 3 })];
      for (let c = 1; c < p.cols; c++) out.push(line(d`M${-fw / 2 + c * cw} ${-fh / 2} L${-fw / 2 + c * cw} ${fh / 2}`, 2.6));
      p.signs.forEach((wedges, i) => {
        const col = Math.floor(i / p.rows);
        const row = i % p.rows;
        const x0 = -fw / 2 + col * cw + u * 0.7;
        const y0 = -fh / 2 + row * ch + u * 0.7;
        for (const wg of wedges) {
          const x = x0 + (wg.gx * (cw - u * 3.4)) / 2;
          const y = y0 + u * 0.4 + (wg.gy * (ch - u * 3)) / 2;
          if (wg.kind === 'h') out.push(fill(d`M${x} ${y - u * 0.6} L${x + u} ${y} L${x} ${y + u * 0.6}Z`), line(d`M${x + u * 0.6} ${y} L${x + u * 2.2} ${y}`, 2.2));
          else if (wg.kind === 'v') out.push(fill(d`M${x + u - u * 0.6} ${y} L${x + u} ${y + u} L${x + u + u * 0.6} ${y}Z`), line(d`M${x + u} ${y + u * 0.6} L${x + u} ${y + u * 2.1}`, 2.2));
          else out.push(fill(d`M${x + u * 1.3} ${y - u * 0.2} L${x + u * 0.2} ${y + u * 0.8} L${x + u * 1.3} ${y + u * 1.8} L${x + u * 0.8} ${y + u * 0.8}Z`));
        }
      });
      return out.join('');
    },
  },

  volute: {
    widths: [82, 100],
    choose: (r) => ({ tiers: r.pick([1, 2]), fan: r.chance(2, 3), base: r.pick(['mound', 'bands']) }),
    draw(p, w, h) {
      // Pairs of spirals (like a palmette capital) on a tall stem.
      const s = Math.min((w - 8) / 4, (h - 40) / (p.tiers * 2.2 + 0.8));
      const foot = h / 2 - 3;
      const out = [];
      let y = -h / 2 + 4 + (p.fan ? 15 : 3);
      let top = null;
      for (let t = 0; t < p.tiers; t++) {
        const size = p.tiers === 2 && t === 0 ? s * 0.78 : s;
        y += size;
        for (const flip of [false, true]) out.push(mirrorX(flip, line(spiralPath(size, y, size, size * 0.5, 4), SW2)));
        if (top === null) top = y - size * 0.35;
        y += size + 6;
      }
      out.push(line(d`M0 ${foot} L0 ${top}`, SW));
      if (p.base === 'bands') out.push(line(d`M-8 ${foot - 4} L8 ${foot - 4} M-8 ${foot - 11} L8 ${foot - 11}`, 3));
      else out.push(fill(d`M-18 ${foot} Q0 ${foot - 17} 18 ${foot}Z`));
      if (p.fan) out.push(at(0, top - 2, fanOut(5, 72, line(d`M0 -3 L0 -14`, 2.8))));
      return out.join('');
    },
  },

  lattice: {
    widths: [60, 86],
    choose: (r) => ({ cols: r.pick([2, 3]), dots: r.chance(1, 2), frame: r.chance(1, 2) }),
    draw(p, w, h) {
      const fw = w - 6;
      const fh = h - 6;
      const dw = fw / p.cols / 2;
      const rows = Math.max(3, Math.round(fh / (dw * 2.4)));
      const dh = fh / rows / 2;
      const out = [];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < p.cols; col++) {
          const cx = -fw / 2 + dw * (2 * col + 1);
          const cy = -fh / 2 + dh * (2 * row + 1);
          out.push(line(d`M${cx} ${cy - dh} L${cx + dw} ${cy} L${cx} ${cy + dh} L${cx - dw} ${cy}Z`, 2.8));
          if (p.dots) out.push(disk(cx, cy, 2.8));
        }
      }
      if (p.frame) out.push(shape('rect', { x: -fw / 2, y: -fh / 2, width: fw, height: fh, fill: 'none', 'stroke-width': 3 }));
      return out.join('');
    },
  },

  scales: {
    widths: [60, 86],
    choose: (r) => ({ size: r.pick([9, 10, 12]), down: r.chance(1, 2), dots: r.chance(1, 3) }),
    draw(p, w, h) {
      const r = p.size;
      const fw = w - 6;
      const top = -h / 2 + r + 3;
      const rows = Math.floor((h - 2 * r - 6) / r) + 1;
      const out = [];
      for (let row = 0; row < rows; row++) {
        const y = top + row * r;
        const shift = row % 2 ? r : 0;
        for (let x = -fw / 2 + r + shift; x <= fw / 2 - r + 0.01; x += 2 * r) {
          out.push(line(d`M${x - r} ${y} A${r} ${r} 0 0 1 ${x + r} ${y}`, 2.8));
          if (p.dots) out.push(disk(x, y - r * 0.35, 2.2));
        }
      }
      return mirrorY(p.down, out.join(''));
    },
  },

  fan: {
    widths: [92, 116],
    choose: (r) => ({ rays: r.pick([5, 7, 9]), tips: r.pick(['dots', 'buds', 'none']), base: r.pick(['arc', 'bud']), spread: r.pick([100, 120, 140]), stand: r.pick(['stem', 'bands']) }),
    draw(p, w, h) {
      // A palmette fan on a short stand.
      const R = Math.min(h * 0.56, w * 0.52);
      const by = -h / 2 + 4 + R;
      const foot = h / 2 - 3;
      let tip = '';
      if (p.tips === 'dots') tip = disk(0, -R * 0.92 - 4, 3.4);
      if (p.tips === 'buds') tip = oval(0, -R * 0.92 - 5, 3.2, 5.6);
      const rays = fanOut(p.rays, p.spread, line(d`M0 ${-R * 0.3} L0 ${-R * 0.88}`, SW2) + tip);
      const base = p.base === 'arc'
        ? line(d`M${-R * 0.2} 0 A${R * 0.2} ${R * 0.2} 0 0 1 ${R * 0.2} 0`, SW2) + line(d`M${-R * 0.32} 6 L${R * 0.32} 6`, SW2)
        : fill(d`M${-R * 0.22} 4 C${-R * 0.22} ${-R * 0.26} ${R * 0.22} ${-R * 0.26} ${R * 0.22} 4Z`);
      const stemTop = by + 7;
      let stand = line(d`M0 ${stemTop} L0 ${foot}`, SW);
      if (p.stand === 'bands') stand += line(d`M-9 ${foot - 5} L9 ${foot - 5} M-9 ${foot - 12} L9 ${foot - 12}`, 3);
      else stand += fill(d`M-16 ${foot} Q0 ${foot - 15} 16 ${foot}Z`);
      return at(0, by, rays + base) + stand;
    },
  },

  celestial: {
    widths: [44, 56],
    choose: (r) => ({ order: r.pick([['crescent', 'star', 'disk'], ['star', 'crescent', 'dots'], ['disk', 'star', 'crescent'], ['crescent', 'disk', 'star']]) }),
    draw(p, w, h) {
      const s = Math.min(w - 6, (h - 8) / 3);
      return p.order.map((sym, i) => {
        const y = -h / 2 + 4 + s * (i + 0.5) + ((h - 8 - 3 * s) * i) / 2;
        if (sym === 'crescent') return crescent(0, y + 3, s * 0.36);
        if (sym === 'star') return at(0, y, smallStar(8, s * 0.42));
        if (sym === 'disk') return ring(0, y, s * 0.3, 3) + disk(0, y, s * 0.12);
        return disk(0, y - s * 0.16, 3.2) + disk(-s * 0.18, y + s * 0.14, 3.2) + disk(s * 0.18, y + s * 0.14, 3.2);
      }).join('');
    },
  },
};

// ----------------------------------------------------------- fillers
// Small symbols (drawn centred in a box of size s).

export const FILLERS = {
  star: { choose: (r) => ({ rays: r.pick([4, 6, 8]) }), draw: (p, s) => smallStar(p.rays, s * 0.48, p.rays === 4 ? 0.22 : 0.17) },
  crescent: { choose: () => ({}), draw: (p, s) => crescent(0, s * 0.05, s * 0.4) },
  drill: { choose: () => ({}), draw: (p, s) => disk(0, 0, s * 0.2) },
  trio: { choose: () => ({}), draw: (p, s) => disk(0, -s * 0.2, s * 0.13) + disk(-s * 0.2, s * 0.15, s * 0.13) + disk(s * 0.2, s * 0.15, s * 0.13) },
  lozenge: { choose: () => ({}), draw: (p, s) => fill(d`M0 ${-s * 0.46} L${s * 0.28} 0 L0 ${s * 0.46} L${-s * 0.28} 0Z`) },
  flower: { choose: () => ({}), draw: (p, s) => radial(6, disk(0, -s * 0.3, s * 0.12)) + disk(0, 0, s * 0.13) },
  spiral: { choose: (r) => ({ flip: r.chance(1, 2) }), draw: (p, s) => mirrorX(p.flip, line(spiralPath(0, 0, s * 0.38, s * 0.24, 4), 2.8)) },
  fish: { choose: (r) => ({ flip: r.chance(1, 2) }), draw: (p, s) => mirrorX(p.flip, fill(d`M${-s * 0.48} 0 Q${-s * 0.05} ${-s * 0.34} ${s * 0.28} 0 Q${-s * 0.05} ${s * 0.34} ${-s * 0.48} 0Z M${s * 0.2} 0 L${s * 0.5} ${-s * 0.24} L${s * 0.5} ${s * 0.24}Z`)) },
  cross: { choose: () => ({}), draw: (p, s) => line(d`M0 ${-s * 0.4} L0 ${s * 0.4} M${-s * 0.4} 0 L${s * 0.4} 0`, 2.8) + radial(4, disk(0, -s * 0.34, s * 0.09), 45) },
  ringdot: { choose: () => ({}), draw: (p, s) => ring(0, 0, s * 0.3, 2.6) + disk(0, 0, s * 0.1) },
};

// -------------------------------------------------------------- gaps
// Narrow dividers between the main figures of a band.

export const GAPS = {
  space: { widths: [10, 14], choose: () => ({}), draw: () => '' },
  line: { widths: [14, 16], choose: () => ({}), draw: (p, w, h) => line(d`M0 ${-h / 2 + 2} L0 ${h / 2 - 2}`, 3.2) },
  double: { widths: [18, 20], choose: () => ({}), draw: (p, w, h) => line(d`M-3.5 ${-h / 2 + 2} L-3.5 ${h / 2 - 2} M3.5 ${-h / 2 + 2} L3.5 ${h / 2 - 2}`, 2.8) },
  dots: {
    widths: [16, 18],
    choose: () => ({}),
    draw(p, w, h) {
      const count = Math.floor((h - 8) / 12) + 1;
      let out = '';
      for (let i = 0; i < count; i++) out += disk(0, -h / 2 + 4 + (i * (h - 8)) / (count - 1), 3);
      return out;
    },
  },
  ladder: {
    widths: [20, 22],
    choose: () => ({}),
    draw(p, w, h) {
      let path = d`M-5 ${-h / 2 + 2} L-5 ${h / 2 - 2} M5 ${-h / 2 + 2} L5 ${h / 2 - 2}`;
      for (let y = -h / 2 + 10; y < h / 2 - 6; y += 11) path += d` M-5 ${y} L5 ${y}`;
      return line(path, 2.6);
    },
  },
  stack: {
    widths: [28, 34],
    choose(r) {
      const names = Object.keys(FILLERS);
      const count = r.pick([2, 3]);
      const items = [];
      for (let i = 0; i < count; i++) {
        const name = r.pick(names);
        items.push({ name, params: FILLERS[name].choose(r) });
      }
      return { items };
    },
    draw(p, w, h) {
      const s = Math.min(w - 6, 24);
      const gap = (h - 8) / p.items.length;
      return p.items.map((it, i) => at(0, -h / 2 + 4 + gap * (i + 0.5), FILLERS[it.name].draw(it.params, s))).join('');
    },
  },
};

// ----------------------------------------------------------- borders
// Each border draws the top strip of a band (y from 0 to bh, the side
// facing the figures at y = bh), and a ring version for round stamps.

const OUTER_LINE = (x0, x1) => line(d`M${x0} 2.5 L${x1} 2.5`, 2.6);

export const BORDERS = {
  lines: {
    band: (p, x0, x1, bh) => OUTER_LINE(x0, x1) + line(d`M${x0} ${bh - 3} L${x1} ${bh - 3}`, 2.6),
    ring: (p, r0, r1) => ring(0, 0, r1 - 2.5, 2.6) + ring(0, 0, r0 + 3, 2.6),
  },
  zigzag: {
    band(p, x0, x1, bh) {
      let path = d`M${x0} 6`;
      for (let x = x0, i = 0; x < x1; x += p.unit / 2, i++) path += d` L${x + p.unit / 2} ${i % 2 ? 6 : bh - 2}`;
      return OUTER_LINE(x0, x1) + line(path, 2.6);
    },
    ring(p, r0, r1, count) {
      const half = (r1 + r0) * 1.5708 / count;
      return ring(0, 0, r1 - 2.5, 2.6) + radial(count, line(d`M${-half} ${-(r1 - 6)} L0 ${-(r0 + 1)} L${half} ${-(r1 - 6)}`, 2.6));
    },
  },
  dots: {
    band(p, x0, x1, bh) {
      let out = OUTER_LINE(x0, x1);
      for (let x = x0; x < x1; x += p.unit) out += disk(x, bh / 2 + 1.5, 2.8);
      return out;
    },
    ring: (p, r0, r1, count) => ring(0, 0, r1 - 2.5, 2.6) + radial(count, disk(0, -(r0 + r1) / 2 + 1, 2.6)),
  },
  rope: {
    band(p, x0, x1, bh) {
      let path = '';
      for (let x = x0; x < x1; x += p.unit / 2) path += d`M${x} ${bh - 2} L${x + p.unit * 0.45} 6 `;
      return OUTER_LINE(x0, x1) + line(path, 2.6) + line(d`M${x0} ${bh} L${x1} ${bh}`, 2);
    },
    ring: (p, r0, r1, count) => ring(0, 0, r1 - 2.5, 2.6) + ring(0, 0, r0, 2) + radial(count * 2, line(d`M-2 ${-(r0 + 2)} L2 ${-(r1 - 6)}`, 2.6)),
  },
  triangles: {
    band(p, x0, x1, bh) {
      let out = OUTER_LINE(x0, x1);
      for (let x = x0; x < x1; x += p.unit) out += fill(d`M${x + 1} 4.5 L${x + p.unit - 1} 4.5 L${x + p.unit / 2} ${bh - 1}Z`);
      return out;
    },
    ring(p, r0, r1, count) {
      const half = (r1 + r0) * 1.5708 / count - 1;
      return ring(0, 0, r1 - 2.5, 2.6) + radial(count, fill(d`M${-half} ${-(r1 - 4.5)} L${half} ${-(r1 - 4.5)} L0 ${-(r0 + 1)}Z`));
    },
  },
  ladder: {
    band(p, x0, x1, bh) {
      let path = d`M${x0} 3 L${x1} 3 M${x0} ${bh - 3} L${x1} ${bh - 3}`;
      for (let x = x0; x < x1; x += p.unit * 0.6) path += d` M${x} 3 L${x} ${bh - 3}`;
      return line(path, 2.4);
    },
    ring: (p, r0, r1, count) => ring(0, 0, r1 - 3, 2.4) + ring(0, 0, r0 + 3, 2.4) + radial(Math.round(count * 1.6), line(d`M0 ${-(r0 + 3)} L0 ${-(r1 - 3)}`, 2.4)),
  },
  waves: {
    band: (p, x0, x1, bh) => OUTER_LINE(x0, x1) + line(hwave(bh / 2 + 2, x0, x1, 3.2, p.unit * 2), 2.6),
    ring(p, r0, r1, count) {
      const half = (r1 + r0) * 1.5708 / count;
      const r = -(r0 + r1) / 2 - 1;
      return ring(0, 0, r1 - 2.5, 2.6) + radial(count, line(d`M${-half} ${r} Q${-half / 2} ${r - 5} 0 ${r} Q${half / 2} ${r + 5} ${half} ${r}`, 2.6));
    },
  },
  plain: {
    band: (p, x0, x1, bh) => line(d`M${x0} ${bh - 4} L${x1} ${bh - 4}`, 3.4),
    ring: (p, r0) => ring(0, 0, r0 + 4, 3.4),
  },
};
