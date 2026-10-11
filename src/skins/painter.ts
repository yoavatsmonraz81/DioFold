import { BASE, HEADROOM, HZ, PAD, TH, TW } from '../core/geometry';
import type { PropDef } from '../core/props';
import { hashStr, mulberry32 } from '../core/rng';
import type { TerrainColors, TerrainDef } from '../core/terrains';
import { shadeHex } from './color';
import type { Rendered } from './types';

/** How a procedural skin draws: one painter, many looks. */
export interface PaintStyle {
  color: (hex: string) => string; // palette transform applied to every colour
  outline: string | null;
  outlineWidth: number;
  shadeLeft: number; // lighting on the two visible block faces
  shadeRight: number;
  wobble: number; // hand-drawn vertex jitter
  hatch: boolean; // ink hatching on block sides
  strata: boolean; // lines marking each height level
}

type Pt = [number, number];
const TAU = Math.PI * 2;
const EARTH = '#7a5a3c';

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w);
  c.height = Math.ceil(h);
  return c;
}

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const add = (p: Pt, dx: number, dy: number): Pt => [p[0] + dx, p[1] + dy];
/** Point on the top diamond: u runs toward the right corner, v toward the left corner. */
const dp = (u: number, v: number): Pt => [((u - v) * TW) / 2, ((u + v - 1) * TH) / 2];
/** Isometric point for props: sx along the tile's x axis, sy along its y axis, z up. */
const P3 = (sx: number, sy: number, z: number): Pt => [sx - sy, (sx + sy) * 0.5 - z];

export class Pen {
  constructor(readonly ctx: CanvasRenderingContext2D, readonly st: PaintStyle, readonly rnd: () => number) {}

  get ol() {
    return this.st.outline;
  }
  c(hex: string, shade = 0) {
    return this.st.color(shade ? shadeHex(hex, shade) : hex);
  }
  r(a: number, b: number) {
    return a + (b - a) * this.rnd();
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rnd() * arr.length)];
  }

  path(pts: Pt[], close = true) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (close) ctx.closePath();
  }
  fillStroke(fill: string | CanvasGradient | null, stroke: string | null, lw = 1) {
    const { ctx } = this;
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = this.st.outlineWidth * lw;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }
  poly(pts: Pt[], fill: string | CanvasGradient | null, stroke: string | null = null, lw = 1) {
    if (this.st.wobble && stroke) pts = pts.map(([x, y]) => [x + (this.rnd() - 0.5) * this.st.wobble * 0.6, y + (this.rnd() - 0.5) * this.st.wobble * 0.6]);
    this.path(pts);
    this.fillStroke(fill, stroke, lw);
  }
  circle(x: number, y: number, r: number, fill: string | CanvasGradient | null, stroke: string | null = null, lw = 1) {
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, TAU);
    this.fillStroke(fill, stroke, lw);
  }
  ellipse(x: number, y: number, rx: number, ry: number, fill: string | CanvasGradient | null, stroke: string | null = null, lw = 1) {
    this.ctx.beginPath();
    this.ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
    this.fillStroke(fill, stroke, lw);
  }
  rrect(x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient | null, stroke: string | null = null, lw = 1) {
    this.ctx.beginPath();
    this.ctx.roundRect(x, y, w, h, r);
    this.fillStroke(fill, stroke, lw);
  }
  line(pts: Pt[], color: string, lw: number, alpha = 1) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha *= alpha;
    this.path(pts, false);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }
  dot(x: number, y: number, r: number, color: string, alpha = 1) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha *= alpha;
    this.circle(x, y, r, color);
    ctx.restore();
  }
  wave(x: number, y: number, w: number, color: string, lw: number, alpha: number) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.beginPath();
    ctx.moveTo(x - w, y);
    ctx.quadraticCurveTo(x - w / 2, y - 1.8, x, y);
    ctx.quadraticCurveTo(x + w / 2, y + 1.8, x + w, y);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }
  glow(x: number, y: number, r: number, hex: string, alpha: number) {
    const { ctx } = this;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, this.c(hex));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.globalAlpha *= alpha;
    this.circle(x, y, r, g);
    ctx.restore();
  }
  /** Overlapping circles with a single outline around the union, darker underside and a highlight. */
  blobs(cs: number[][], fill: string, dark?: string, light?: string) {
    const { ctx } = this;
    if (this.ol) {
      ctx.save();
      ctx.strokeStyle = this.ol;
      ctx.lineWidth = this.st.outlineWidth * 2;
      for (const [x, y, r] of cs) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    }
    for (const [x, y, r] of cs) this.circle(x, y, r, dark ?? fill);
    if (dark) for (const [x, y, r] of cs) this.circle(x - r * 0.12, y - r * 0.14, r * 0.86, fill);
    if (light) for (const [x, y, r] of cs) this.dot(x - r * 0.35, y - r * 0.4, r * 0.32, light, 0.85);
  }
  blob(x: number, y: number, rx: number, ry: number, n = 7): Pt[] {
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * TAU, k = this.r(0.75, 1.1);
      return [x + Math.cos(a) * rx * k, y + Math.sin(a) * ry * k] as Pt;
    });
  }
}

// ───────────────────────────── tiles ─────────────────────────────

export function paintTile(T: TerrainDef, h: number, variant: number, frame: number, mask: number, st: PaintStyle): Rendered {
  const col = T.colors;
  const look = T.look ?? T.id;
  const D = T.puffy ? 0 : T.floating ? BASE + 2 : h * HZ + BASE;
  const under = look === 'isle' ? 26 : look === 'storm' ? 24 : 0;
  const W = TW + PAD * 2, H = HEADROOM + TH + D + PAD + under;
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d')!;
  const ax = PAD + TW / 2, ay = HEADROOM + TH / 2;
  ctx.translate(ax, ay);
  const rnd = mulberry32(hashStr(T.id) + variant * 7919 + 1);
  const pen = new Pen(ctx, st, rnd);

  if (T.puffy) {
    puffs(pen, T, variant, frame);
    return { canvas, ax, ay };
  }

  const jit = (x: number, y: number): Pt => (st.wobble ? [x + (rnd() - 0.5) * st.wobble, y + (rnd() - 0.5) * st.wobble] : [x, y]);
  const t = jit(0, -TH / 2), r = jit(TW / 2, 0), b = jit(0, TH / 2), l = jit(-TW / 2, 0);
  const rd = jit(TW / 2, D), bd = jit(0, TH / 2 + D), ld = jit(-TW / 2, D);
  const top: Pt[] = [t, r, b, l];
  const capped = look === 'rock' && h >= 4;

  if (look === 'isle') underside(pen, ld, bd, rd, under);

  // sides
  const sideL: Pt[] = [l, b, bd, ld], sideR: Pt[] = [b, r, rd, bd];
  const sideCol = T.liquid ? EARTH : col.side;
  pen.poly(sideL, pen.c(sideCol, st.shadeLeft));
  pen.poly(sideR, pen.c(sideCol, st.shadeRight));
  if (T.liquid) {
    // a band of liquid over the earth, like a resin diorama cut-away
    pen.poly([l, b, add(b, 0, 6), add(l, 0, 6)], pen.c(col.side, st.shadeLeft));
    pen.poly([b, r, add(r, 0, 6), add(b, 0, 6)], pen.c(col.side, st.shadeRight));
  }
  sideTexture(pen, T, sideL, sideR, D, h);
  const lipCol = capped ? '#ffffff' : col.lip;
  if (lipCol) lip(pen, l, b, r, lipCol);

  // top face
  pen.poly(top, pen.c(capped ? '#f4f8fc' : col.top));
  ctx.save();
  pen.path(top);
  ctx.clip();
  topDetails(pen, T, variant, frame, capped);
  if (T.foam && mask) foam(pen, top, mask, frame);
  if (T.road) roadMarks(pen, mask, col);
  ctx.restore();

  if (st.outline) {
    // Only the front edges: back edges belong to the neighbour behind, and drawing both
    // turns flat ground into a heavy grid. Where a neighbour in front is level, its top
    // face covers these, so outlines only really show on cliffs and coasts.
    pen.path([l, ld, bd, rd, r], false);
    pen.fillStroke(null, st.outline);
    pen.path([b, bd], false);
    pen.fillStroke(null, st.outline, 0.6);
    if (!T.liquid) {
      pen.path([l, b, r], false);
      pen.fillStroke(null, st.outline, 0.5);
    }
  }

  tallDetails(pen, T);
  return { canvas, ax, ay };
}

function sideTexture(pen: Pen, T: TerrainDef, L: Pt[], R: Pt[], D: number, h: number) {
  const { ctx, st } = pen;
  const bricks = ['wall', 'basalt', 'ruins', 'cobble'].includes(T.look ?? T.id);
  for (const [face, shade] of [[L, st.shadeLeft], [R, st.shadeRight]] as [Pt[], number][]) {
    const [a, b] = face;
    const dark = pen.c(T.liquid ? EARTH : T.colors.side, shade - 0.16);
    ctx.save();
    pen.path(face);
    ctx.clip();
    if (bricks) {
      const rowH = 7;
      for (let row = 0, y = 0; y < D; row++, y += rowH) {
        pen.line([add(a, 0, y), add(b, 0, y)], dark, 1, 0.7);
        for (let k = 0; k < 4; k++) {
          const p = add(lerp(a, b, (k + (row % 2) * 0.5) / 4), 0, y);
          pen.line([p, add(p, 0, rowH)], dark, 1, 0.6);
        }
      }
    } else {
      if (st.strata) for (let k = 1; k <= h; k++) pen.line([add(a, 0, k * HZ), add(b, 0, k * HZ)], dark, 1, 0.45);
      for (let i = 0; i < 4 + h * 2; i++) {
        const p = add(lerp(a, b, pen.r(0.05, 0.95)), 0, pen.r(3, Math.max(4, D - 2)));
        pen.dot(p[0], p[1], pen.r(0.6, 1.3), dark, 0.6);
      }
    }
    if (st.hatch && st.outline) {
      const step = shade === st.shadeRight ? 3 : 5;
      for (let x = -TW; x < TW; x += step) pen.line([[x, -TH], [x + D + TH, D + TH]], st.outline, 0.6, 0.35);
    }
    ctx.restore();
  }
}

function lip(pen: Pen, l: Pt, b: Pt, r: Pt, color: string) {
  for (const [a, c, shade] of [[l, b, pen.st.shadeLeft], [b, r, pen.st.shadeRight]] as [Pt, Pt, number][]) {
    const pts: Pt[] = [a, c];
    for (let i = 6; i >= 0; i--) pts.push(add(lerp(a, c, i / 6), 0, 3 + (i % 2) * 2.5));
    pen.poly(pts, pen.c(color, shade * 0.5));
  }
}

function underside(pen: Pen, ld: Pt, bd: Pt, rd: Pt, depth: number) {
  const rock = '#7b6a5a';
  const tip: Pt = [pen.r(-5, 5), bd[1] + depth - 3];
  const j1: Pt = [ld[0] + 9, ld[1] + depth * 0.5], j2: Pt = [ld[0] + 19, ld[1] + depth * 0.75];
  const j3: Pt = [rd[0] - 17, rd[1] + depth * 0.8], j4: Pt = [rd[0] - 7, rd[1] + depth * 0.45];
  pen.poly([ld, j1, j2, tip, j3, j4, rd, bd], pen.c(rock, pen.st.shadeLeft), pen.ol);
  pen.poly([bd, tip, j3, j4, rd], pen.c(rock, pen.st.shadeRight));
  for (let i = 0; i < 3; i++) {
    const p = lerp(ld, rd, pen.r(0.2, 0.8));
    pen.line([add(p, 0, 4), add(p, pen.r(-2, 2), 10)], pen.c('#5a4632'), 1, 0.8);
  }
}

function tuft(pen: Pen, x: number, y: number, color: string) {
  pen.line([[x - 2, y - 2.5], [x, y]], color, 1.1);
  pen.line([[x, y - 3.5], [x, y]], color, 1.1);
  pen.line([[x + 2, y - 2.5], [x, y]], color, 1.1);
}

function crack(pen: Pen, color: string) {
  let p = dp(pen.r(0.2, 0.8), pen.r(0.2, 0.8));
  const pts: Pt[] = [p];
  for (let i = 0; i < 3; i++) pts.push((p = add(p, pen.r(-6, 6), pen.r(-3, 3))));
  pen.line(pts, color, 0.9, 0.8);
}

function topDetails(pen: Pen, T: TerrainDef, v: number, f: number, capped: boolean) {
  const c = T.colors;
  const pts = (n: number, m = 0.12) => Array.from({ length: n }, () => dp(pen.r(m, 1 - m), pen.r(m, 1 - m)));
  const look = T.look ?? T.id;
  if (capped) {
    for (const [x, y] of pts(4)) pen.ellipse(x, y, pen.r(2, 4), pen.r(1, 2), pen.c(c.top));
    for (const [x, y] of pts(3)) pen.dot(x, y, 0.9, pen.c('#ffffff'));
    return;
  }
  switch (look) {
    case 'grass':
    case 'isle':
    case 'forest':
      for (const [x, y] of pts(6)) tuft(pen, x, y, pen.c(c.detail));
      if (v === 1) for (const [x, y] of pts(3)) pen.dot(x, y, 1.3, pen.c(pen.pick(['#fff6a0', '#ffffff', '#ffb3c7'])));
      break;
    case 'sand':
      for (const [x, y] of pts(14, 0.05)) pen.dot(x, y, pen.r(0.5, 1), pen.c(pen.rnd() < 0.5 ? c.detail : c.light!), 0.9);
      break;
    case 'desert':
      for (const [x, y] of pts(3, 0.2)) {
        const w = pen.r(7, 12);
        pen.ctx.beginPath();
        pen.ctx.moveTo(x - w, y + 1.5);
        pen.ctx.quadraticCurveTo(x, y - 3, x + w, y + 1.5);
        pen.ctx.strokeStyle = pen.c(c.detail);
        pen.ctx.lineWidth = 1.4;
        pen.ctx.stroke();
      }
      for (const [x, y] of pts(5)) pen.dot(x, y, 0.8, pen.c(c.light!));
      break;
    case 'snow':
      for (const [x, y] of pts(3, 0.2)) pen.wave(x, y, pen.r(4, 7), pen.c(c.detail), 1.2, 0.8);
      for (const [x, y] of pts(3)) pen.dot(x, y, 1, pen.c('#ffffff'));
      break;
    case 'rock':
      crack(pen, pen.c(c.detail));
      for (const [x, y] of pts(3)) pen.ellipse(x, y, pen.r(1.5, 2.8), pen.r(1, 1.6), pen.c(c.light!), pen.c(c.detail), 0.5);
      break;
    case 'swamp':
      for (const [x, y] of pts(3, 0.22)) {
        pen.poly(pen.blob(x, y, pen.r(5, 8), pen.r(2.5, 3.5)), pen.c(c.detail));
        pen.dot(x - 1.5, y - 0.8, 1, pen.c(c.light!), 0.8);
      }
      break;
    case 'cobble':
      for (let a = 0; a < 4; a++)
        for (let b = 0; b < 4; b++) {
          const [x, y] = dp((a + 0.5) / 4 + pen.r(-0.03, 0.03), (b + 0.5) / 4 + pen.r(-0.03, 0.03));
          pen.ellipse(x, y, 5.5, 2.8, pen.c(pen.rnd() < 0.3 ? c.light! : c.top, pen.r(-0.06, 0.04)), pen.c(c.detail), 0.6);
        }
      break;
    case 'water':
    case 'shallows':
    case 'cavelake':
      if (look === 'shallows') for (const [x, y] of pts(8)) pen.dot(x, y, pen.r(0.6, 1.2), pen.c(c.accent!), 0.5);
      for (let i = 0; i < 4; i++) {
        const [x, y] = dp(pen.r(0.2, 0.8), pen.r(0.2, 0.8));
        const w = pen.r(3, 5);
        const alpha = 0.25 + 0.75 * Math.abs(Math.sin(((f + i * 1.3) * Math.PI) / 4));
        pen.wave(x + ((f + i) % 4) * 0.8, y, w, pen.c(c.detail), 1.2, alpha);
      }
      break;
    case 'lava': {
      for (let i = 0; i < 4; i++) {
        const [x, y] = dp(pen.r(0.15, 0.85), pen.r(0.15, 0.85));
        pen.poly(pen.blob(x, y, pen.r(4, 7), pen.r(2, 3.5), 6), pen.c(c.detail));
      }
      for (let i = 0; i < 3; i++) {
        const a = dp(pen.r(0.1, 0.9), pen.r(0.1, 0.9)), b = dp(pen.r(0.1, 0.9), pen.r(0.1, 0.9));
        const mid: Pt = [(a[0] + b[0]) / 2 + pen.r(-3, 3), (a[1] + b[1]) / 2 + pen.r(-2, 2)];
        const glow = 0.5 + 0.5 * Math.sin(((f + i) * Math.PI) / 2);
        pen.line([a, mid, b], pen.c(c.accent!), 1.4, 0.35 + 0.65 * glow);
      }
      const [bx, by] = dp(pen.r(0.3, 0.7), pen.r(0.3, 0.7));
      pen.dot(bx, by, 0.8 + f * 0.6, pen.c(c.light!), 0.9 - f * 0.15);
      break;
    }
    case 'wall':
      crack(pen, pen.c(c.detail));
      for (const [x, y] of pts(2, 0.25)) pen.poly(pen.blob(x, y, pen.r(4, 6), pen.r(2, 3)), pen.c(c.light!));
      break;
    case 'basalt':
      for (const [x, y] of pts(4, 0.22)) {
        const hex: Pt[] = Array.from({ length: 6 }, (_, i) => [x + Math.cos((i / 6) * TAU) * 5, y + Math.sin((i / 6) * TAU) * 2.6]);
        pen.poly(hex, pen.c(c.light!), pen.c(c.detail), 0.6);
      }
      break;
    case 'cavefloor':
    case 'crystal':
    case 'mushroom':
      for (const [x, y] of pts(10, 0.05)) pen.dot(x, y, pen.r(0.5, 1), pen.c(c.detail), 0.8);
      for (const [x, y] of pts(3)) pen.ellipse(x, y, pen.r(1.5, 2.5), pen.r(1, 1.5), pen.c(look === 'cavefloor' ? c.light! : c.top, 0.1), pen.c(c.detail), 0.5);
      if (look === 'mushroom') for (const [x, y] of pts(3, 0.2)) pen.poly(pen.blob(x, y, pen.r(4, 6), pen.r(2, 3)), pen.c(c.detail));
      break;
    case 'tunnel':
      for (let k = 1; k < 5; k++) pen.line([dp(k / 5, 0), dp(k / 5, 1)], pen.c(c.detail), 1, 0.8);
      for (const vv of [0.38, 0.62]) pen.line([dp(0, vv), dp(1, vv)], pen.c('#8d96a3'), 1.6);
      break;
    case 'ruins':
      for (const k of [1 / 3, 2 / 3]) {
        pen.line([dp(k, 0), dp(k, 1)], pen.c(c.detail), 1, 0.8);
        pen.line([dp(0, k), dp(1, k)], pen.c(c.detail), 1, 0.8);
      }
      crack(pen, pen.c(c.detail));
      for (const [x, y] of pts(3)) pen.poly(pen.blob(x, y, pen.r(2, 4), pen.r(1, 2)), pen.c(c.accent!));
      break;
    case 'road':
      for (const [x, y] of pts(14, 0.05)) pen.dot(x, y, pen.r(0.4, 0.8), pen.c(c.light!), 0.25);
      break;
    case 'abyss': {
      const g = pen.ctx.createRadialGradient(0, 0, 1, 0, 0, TW / 2);
      g.addColorStop(0, pen.c(c.accent!));
      g.addColorStop(0.55, pen.c(c.top));
      g.addColorStop(1, pen.c(c.side));
      pen.poly([dp(0, 0), dp(1, 0), dp(1, 1), dp(0, 1)], g);
      for (const [x, y] of pts(10, 0.1)) pen.dot(x, y, pen.r(0.4, 0.9), pen.c(c.detail), pen.r(0.4, 1));
      break;
    }
  }
}

/** Details that rise above the top face and so can't be clipped to it. */
function tallDetails(pen: Pen, T: TerrainDef) {
  const c = T.colors;
  switch (T.look ?? T.id) {
    case 'forest': {
      const spots = [dp(0.27, 0.27), dp(0.73, 0.28), dp(0.28, 0.72), dp(0.72, 0.72), dp(0.5, 0.5)]
        .map(([x, y]) => [x + pen.r(-2, 2), y + pen.r(-1, 1)] as Pt)
        .sort((a, b) => a[1] - b[1]);
      for (const [x, y] of spots) {
        pen.ellipse(x, y + 0.5, 5, 2, 'rgba(0,0,0,0.15)');
        if (pen.rnd() < 0.35) {
          pen.poly([[x - 1, y], [x + 1, y], [x + 1, y - 3], [x - 1, y - 3]], pen.c('#6b4423'));
          pen.poly([[x - 5, y - 2], [x + 5, y - 2], [x, y - 15]], pen.c(c.accent!), pen.ol, 0.7);
          pen.poly([[x, y - 2], [x + 5, y - 2], [x, y - 15]], pen.c(c.accent!, -0.2));
        } else {
          pen.poly([[x - 1, y], [x + 1, y], [x + 1, y - 4], [x - 1, y - 4]], pen.c('#6b4423'));
          pen.blobs([[x, y - 8, 5.5]], pen.c(c.detail), pen.c(c.detail, -0.2), pen.c(c.light!));
        }
      }
      break;
    }
    case 'swamp':
      for (let i = 0; i < 4; i++) {
        const [x, y] = dp(pen.r(0.15, 0.85), pen.r(0.15, 0.85));
        pen.line([[x, y], [x + pen.r(-1, 1), y - 6]], pen.c(c.accent!), 1);
        pen.ellipse(x, y - 6, 0.9, 1.8, pen.c('#7a5230'));
      }
      break;
    case 'crystal':
      for (const [x, y] of [dp(0.3, 0.4), dp(0.65, 0.35), dp(0.55, 0.7)].sort((a, b) => a[1] - b[1])) {
        crystal(pen, x, y, pen.r(8, 13), 2.5, pen.rnd() < 0.5 ? c.light! : c.accent!);
      }
      break;
    case 'mushroom':
      for (const [x, y] of [dp(0.3, 0.3), dp(0.7, 0.4), dp(0.35, 0.7), dp(0.65, 0.72)].sort((a, b) => a[1] - b[1])) {
        const cap = pen.rnd() < 0.5 ? c.light! : c.accent!;
        pen.glow(x, y - 4, 6, cap, 0.35);
        pen.rrect(x - 0.8, y - 4, 1.6, 4, 0.8, pen.c('#e8dccb'));
        pen.ctx.beginPath();
        pen.ctx.ellipse(x, y - 4, 3.5, 2.6, 0, Math.PI, 0);
        pen.ctx.closePath();
        pen.fillStroke(pen.c(cap), pen.ol, 0.6);
      }
      break;
  }
}

/** Curbs where the road ends, dashed centre lines toward every connected neighbour. */
export function roadMarks(pen: Pen, mask: number, c: TerrainColors) {
  const corners = [dp(0, 0), dp(1, 0), dp(1, 1), dp(0, 1)];
  const mids: Pt[] = [[TW / 4, -TH / 4], [TW / 4, TH / 4], [-TW / 4, TH / 4], [-TW / 4, -TH / 4]];
  for (let k = 0; k < 4; k++) {
    if (mask & (1 << k)) continue;
    const a = corners[k], b = corners[(k + 1) % 4];
    pen.line([[a[0] * 0.9, a[1] * 0.9], [b[0] * 0.9, b[1] * 0.9]], pen.c(c.light!), 3, 0.9);
  }
  const { ctx } = pen;
  ctx.save();
  ctx.setLineDash([3.5, 3]);
  for (let k = 0; k < 4; k++) if (mask & (1 << k)) pen.line([[0, 0], mids[k]], pen.c(c.detail), 1.3, 0.95);
  ctx.restore();
}

function crystal(pen: Pen, x: number, y: number, h: number, w: number, hex: string) {
  pen.glow(x, y - h / 2, h * 0.9, hex, 0.35);
  pen.poly([[x - w, y], [x - w, y - h + w * 1.4], [x, y - h], [x, y]], pen.c(hex, 0.25));
  pen.poly([[x, y], [x, y - h], [x + w, y - h + w * 1.4], [x + w, y]], pen.c(hex, -0.15));
  pen.poly([[x - w, y], [x - w, y - h + w * 1.4], [x, y - h], [x + w, y - h + w * 1.4], [x + w, y]], null, pen.ol, 0.7);
}

export function foam(pen: Pen, top: Pt[], mask: number, f: number) {
  const edges: [Pt, Pt][] = [[top[0], top[1]], [top[1], top[2]], [top[2], top[3]], [top[3], top[0]]];
  for (let k = 0; k < 4; k++) {
    if (!(mask & (1 << k))) continue;
    const [p1, p2] = edges[k];
    for (const [inset, alpha, lw] of [[0.88, 0.9, 2], [0.76 + 0.04 * Math.sin((f * Math.PI) / 2), 0.4, 1.2]]) {
      const pts: Pt[] = [];
      for (let i = 0; i <= 10; i++) {
        const q = lerp(p1, p2, i / 10), s = inset + Math.sin(i * 1.9 + f * 1.4) * 0.025;
        pts.push([q[0] * s, q[1] * s]);
      }
      pen.line(pts, pen.c('#ffffff'), lw, alpha);
    }
  }
}

function puffs(pen: Pen, T: TerrainDef, v: number, f: number) {
  const c = T.colors;
  const storm = (T.look ?? T.id) === 'storm';
  const cs = Array.from({ length: 5 }, (_, i) => {
    const [x, y] = i === 0 ? dp(0.5, 0.5) : dp(pen.r(0.2, 0.8), pen.r(0.2, 0.8));
    return [x, y - 4, pen.r(7, 11)];
  }).sort((a, b) => a[1] - b[1]);
  if (storm) {
    for (let i = 0; i < 7; i++) {
      const x = pen.r(-18, 18), y = 6 + ((f * 5 + i * 4) % 16);
      pen.line([[x, y], [x - 2, y + 5]], pen.c('#9fc3ff'), 1.2, 0.7);
    }
  }
  pen.blobs(cs, pen.c(c.top), pen.c(c.side), pen.c(c.light!));
  if (storm && f === 3 && v !== 1) {
    const bolt: Pt[] = [[2, 4], [-3, 12], [2, 12], [-2, 22]];
    pen.line(bolt, pen.c(c.accent!), 3.5, 0.35);
    pen.line(bolt, pen.c(c.accent!), 1.6);
  }
}

// ───────────────────────────── props ─────────────────────────────

export function paintProp(P: PropDef, variant: number, frame: number, st: PaintStyle, scale = 1): Rendered {
  const W = 88, H = 112, ax = 44, ay = 98;
  const canvas = makeCanvas(Math.ceil(W * scale), Math.ceil(H * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.translate(ax, ay);
  const pen = new Pen(ctx, st, mulberry32(hashStr(P.id) + variant * 104729 + 7));
  const look = P.look ?? P.id;
  if (look !== 'boat' && !P.flies) pen.ellipse(0, 0, 11, 5, 'rgba(0,0,0,0.18)');
  PROP_PAINTERS[look]?.(pen, variant, frame);
  return { canvas, ax: ax * scale, ay: ay * scale };
}

function box(pen: Pen, cx: number, cy: number, z0: number, a: number, b: number, hgt: number, base: string) {
  const p = (sx: number, sy: number, z: number) => P3(cx + sx, cy + sy, z0 + z);
  const { shadeLeft: L, shadeRight: R } = pen.st;
  pen.poly([p(-a, b, 0), p(a, b, 0), p(a, b, hgt), p(-a, b, hgt)], pen.c(base, L), pen.ol);
  pen.poly([p(a, b, 0), p(a, -b, 0), p(a, -b, hgt), p(a, b, hgt)], pen.c(base, R), pen.ol);
  pen.poly([p(-a, -b, hgt), p(a, -b, hgt), p(a, b, hgt), p(-a, b, hgt)], pen.c(base, 0.08), pen.ol);
}

function windows(pen: Pen, a: number, b: number, hgt: number, lit: string, rowStep: number) {
  for (let z = 3; z < hgt - 2; z += rowStep) {
    for (let s = -a + 1.5; s < a - 1.5; s += 3) pen.poly([P3(s, b, z), P3(s + 1.6, b, z), P3(s + 1.6, b, z + 2), P3(s, b, z + 2)], pen.c(lit, pen.rnd() < 0.3 ? -0.45 : 0));
    for (let s = -b + 1.5; s < b - 1.5; s += 3) pen.poly([P3(a, s, z), P3(a, s + 1.6, z), P3(a, s + 1.6, z + 2), P3(a, s, z + 2)], pen.c(lit, pen.rnd() < 0.3 ? -0.55 : -0.2));
  }
}

function cylinder(pen: Pen, x: number, y: number, r: number, hgt: number, body: string, roof?: string, roofH = 0) {
  const { ctx } = pen;
  const g = ctx.createLinearGradient(x - r, 0, x + r, 0);
  g.addColorStop(0, pen.c(body, 0.12));
  g.addColorStop(1, pen.c(body, -0.3));
  ctx.beginPath();
  ctx.moveTo(x - r, y - hgt);
  ctx.lineTo(x - r, y);
  ctx.ellipse(x, y, r, r / 2, 0, Math.PI, 0, true);
  ctx.lineTo(x + r, y - hgt);
  ctx.ellipse(x, y - hgt, r, r / 2, 0, 0, Math.PI, true);
  pen.fillStroke(g, pen.ol);
  if (roof) {
    const rg = ctx.createLinearGradient(x - r, 0, x + r, 0);
    rg.addColorStop(0, pen.c(roof, 0.15));
    rg.addColorStop(1, pen.c(roof, -0.3));
    ctx.beginPath();
    ctx.moveTo(x - r - 1.5, y - hgt);
    ctx.ellipse(x, y - hgt, r + 1.5, (r + 1.5) / 2, 0, Math.PI, 0, true);
    ctx.lineTo(x, y - hgt - roofH);
    ctx.closePath();
    pen.fillStroke(rg, pen.ol);
  } else {
    pen.ellipse(x, y - hgt, r, r / 2, pen.c(body, 0.2), pen.ol);
  }
}

function flame(pen: Pen, x: number, y: number, s: number, f: number) {
  const h = [9, 11, 8, 12][f] * s, w = 4 * s;
  pen.glow(x, y - h / 2, 16 * s, '#ffb347', 0.35);
  for (const [k, col] of [[1, '#ff7a2a'], [0.55, '#ffd23f']] as [number, string][]) {
    pen.ctx.beginPath();
    pen.ctx.moveTo(x - w * k, y);
    pen.ctx.quadraticCurveTo(x - w * k * 1.2, y - h * k * 0.5, x + (f % 2 ? 1 : -1) * s, y - h * k);
    pen.ctx.quadraticCurveTo(x + w * k * 1.2, y - h * k * 0.5, x + w * k, y);
    pen.ctx.closePath();
    pen.fillStroke(pen.c(col), null);
  }
}

const PROP_PAINTERS: Record<string, (pen: Pen, v: number, f: number) => void> = {
  tree(pen, v) {
    const s = 0.92 + v * 0.08;
    pen.poly([[-2, 0], [2, 0], [1.5, -11 * s], [-1.5, -11 * s]], pen.c('#7a4b2a'), pen.ol);
    const g = ['#4f9e35', '#5fae3e', '#3f8f3a'][v % 3];
    pen.blobs([[-5 * s, -15 * s, 7.5 * s], [5 * s, -15 * s, 7.5 * s], [0, -23 * s, 8.5 * s]], pen.c(g), pen.c(g, -0.22), pen.c(g, 0.3));
  },
  pine(pen, v) {
    const s = 0.9 + v * 0.1, g = '#2f6e3f';
    pen.poly([[-1.5, 0], [1.5, 0], [1.5, -6], [-1.5, -6]], pen.c('#6b4423'), pen.ol);
    for (const [w, base, apex] of [[10, -5, -16], [8, -11, -23], [6, -17, -30]]) {
      pen.poly([[-w * s, base * s], [w * s, base * s], [0, apex * s]], pen.c(g), pen.ol);
      pen.poly([[0, base * s], [w * s, base * s], [0, apex * s]], pen.c(g, -0.2));
    }
    if (v === 2) pen.poly([[-2.5, -26 * s], [2.5, -26 * s], [0, -30 * s]], pen.c('#ffffff'));
  },
  palm(pen, v) {
    const { ctx } = pen;
    const tx = 6 + v, ty = -27;
    for (const [lw, col] of [[6, pen.ol], [4, pen.c('#9b6b3d')]] as [number, string | null][]) {
      if (!col) continue;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(-2, -14, tx, ty);
      ctx.strokeStyle = col;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    for (let i = 1; i < 6; i++) pen.dot(-1 + (tx + 1) * (i / 6) ** 1.6, ty * (i / 6), 0.9, pen.c('#6e4a2a'));
    for (const a of [-170, -130, -50, -10, 150, 30]) {
      const rad = (a * Math.PI) / 180, ex = tx + Math.cos(rad) * 14, ey = ty + Math.sin(rad) * 6 + 6;
      for (const [lw, col] of [[5, pen.ol], [3, pen.c('#4fa83c')]] as [number, string | null][]) {
        if (!col) continue;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.quadraticCurveTo(tx + Math.cos(rad) * 8, ty + Math.sin(rad) * 6 - 6, ex, ey);
        ctx.strokeStyle = col;
        ctx.lineWidth = lw;
        ctx.stroke();
      }
    }
    pen.circle(tx - 1.5, ty + 2, 1.8, pen.c('#6b4423'), pen.ol, 0.5);
    pen.circle(tx + 1.5, ty + 2.5, 1.8, pen.c('#6b4423'), pen.ol, 0.5);
  },
  cactus(pen, v) {
    const g = '#4c9a4a';
    pen.rrect(-9, -16, 4, 9, 2, pen.c(g, -0.1), pen.ol);
    pen.rrect(-9, -9, 8, 3, 1.5, pen.c(g, -0.1), pen.ol);
    pen.rrect(5, -20, 4, 10, 2, pen.c(g, -0.1), pen.ol);
    pen.rrect(1, -12, 8, 3, 1.5, pen.c(g, -0.1), pen.ol);
    pen.rrect(-3.5, -25, 7, 25, 3.5, pen.c(g), pen.ol);
    pen.line([[0, -22], [0, -2]], pen.c(g, 0.25), 1, 0.8);
    if (v === 1) pen.circle(0, -25.5, 2, pen.c('#ff7aa8'), pen.ol, 0.5);
  },
  boulder(pen, v) {
    const g = '#8d8d93';
    if (v === 2) pen.poly(pen.blob(8, -2, 4, 3), pen.c(g, -0.1), pen.ol);
    pen.poly(pen.blob(0, -5, 8, 6, 8), pen.c(g), pen.ol);
    pen.poly(pen.blob(-2, -7, 4, 2.5, 6), pen.c(g, 0.2));
    pen.line([[1, -9], [3, -5], [2, -2]], pen.c(g, -0.35), 0.8);
  },
  house(pen, v) {
    const wall = '#f1e2c4', roof = ['#c8553d', '#3d7ec8', '#6b8f3a'][v % 3];
    const a = 9, b = 7, hgt = 10, A = a + 1.5, B = b + 2, zR = hgt + 9;
    box(pen, 0, 0, 0, a, b, hgt, wall);
    pen.poly([P3(-1.5, b, 0), P3(1.5, b, 0), P3(1.5, b, 6), P3(-1.5, b, 6)], pen.c('#6b4423'), pen.ol, 0.6);
    pen.poly([P3(a, -4.5, 3.5), P3(a, -1, 3.5), P3(a, -1, 7), P3(a, -4.5, 7)], pen.c('#ffe08a'), pen.ol, 0.6);
    box(pen, -4, -3, hgt + 2, 1.6, 1.6, 9, '#a5674a'); // chimney
    pen.poly([P3(-A, -B, hgt - 1), P3(A, -B, hgt - 1), P3(A, 0, zR), P3(-A, 0, zR)], pen.c(roof, 0.12), pen.ol);
    pen.poly([P3(a, -b, hgt), P3(a, b, hgt), P3(a, 0, zR - 1)], pen.c(wall, pen.st.shadeRight), pen.ol);
    pen.poly([P3(-A, B, hgt - 1), P3(A, B, hgt - 1), P3(A, 0, zR), P3(-A, 0, zR)], pen.c(roof, pen.st.shadeLeft), pen.ol);
  },
  tower(pen, v) {
    cylinder(pen, 0, 0, 6.5, 30, '#b9b2a6', ['#4a6fd1', '#c8553d', '#7a5bbf'][v % 3], 16);
    pen.rrect(-1, -22, 2, 5, 1, pen.c('#2b2530'));
    pen.rrect(-3.5, -12, 2, 4, 1, pen.c('#2b2530'));
  },
  castle(pen, _v, f) {
    const stone = '#c9c1b2', roof = '#c8553d';
    const a = 11, b = 8, hgt = 13;
    const tower = (sx: number, sy: number, h = 21) => {
      const [x, y] = P3(sx, sy, 0);
      cylinder(pen, x, y, 4.5, h, stone, roof, 10);
    };
    tower(-a, -b);
    box(pen, 0, 0, 0, a, b, hgt, stone);
    for (let k = -a + 1; k < a; k += 4) box(pen, k, b - 1, hgt, 1, 1, 3, stone);
    for (let k = -b + 1; k < b; k += 4) box(pen, a - 1, k, hgt, 1, 1, 3, stone);
    pen.poly([P3(-3, b, 0), P3(3, b, 0), P3(3, b, 7), P3(0, b, 9), P3(-3, b, 7)], pen.c('#3a2a1e'), pen.ol, 0.6);
    tower(-a, b);
    tower(a, -b);
    tower(a, b, 25);
    const [fx, fy] = P3(a, b, 35);
    pen.line([[fx, fy + 1], [fx, fy - 9]], pen.c('#4a3a2a'), 1.2);
    const wave = [0, 1.5, 0, -1.5][f];
    pen.poly([[fx, fy - 9], [fx + 9, fy - 7 + wave], [fx, fy - 4]], pen.c('#3d7ec8'), pen.ol, 0.6);
  },
  ruins(pen, v) {
    const stone = '#b5ada0';
    const cols: [number, number, number][] = [[-8, -3, 16], [4, -6, 22], [9, 3, 9]];
    for (const [x, y, h] of cols) {
      cylinder(pen, x, y, 3.2, h - (v === 1 && h > 15 ? 6 : 0), stone);
      pen.poly(pen.blob(x, y + 0.5, 4.5, 1.8, 6), pen.c('#6e8f4e'));
    }
    box(pen, -2, 7, 0, 3.5, 2, 3, stone);
  },
  campfire(pen, _v, f) {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      pen.ellipse(Math.cos(a) * 7, Math.sin(a) * 3.5, 2.2, 1.5, pen.c('#8d8d93'), pen.ol, 0.5);
    }
    pen.line([[-5, 1], [5, -2]], pen.c('#6b4423'), 2.6);
    pen.line([[-5, -2], [5, 1]], pen.c('#7a4b2a'), 2.6);
    flame(pen, 0, -1, 1, f);
    for (let i = 0; i < 3; i++) pen.dot(-3 + i * 3, -14 - ((f * 4 + i * 5) % 10), 0.8, pen.c('#ffd23f'), 0.8);
  },
  boat(pen, v, f) {
    const wood = '#9b6331';
    const ripple = 1 + (f % 4) * 0.08;
    pen.ellipse(1, 1, 15 * ripple, 6 * ripple, null, pen.c('#ffffff'), 0.7);
    const deck: [number, number][] = [[-10, 0], [-7, -4], [8, -4], [12, 0], [8, 4], [-7, 4]];
    const front: [number, number][] = [[-10, 0], [-7, 4], [8, 4], [12, 0]];
    const keel = [...front].reverse().map(([sx, sy]) => P3(sx * 0.7, sy * 0.6, -1));
    pen.poly([...front.map(([sx, sy]) => P3(sx, sy, 3)), ...keel], pen.c(wood, -0.2), pen.ol);
    pen.poly(deck.map(([sx, sy]) => P3(sx, sy, 3)), pen.c(wood, 0.1), pen.ol);
    const [mx, my] = P3(0, 0, 3);
    pen.line([[mx, my], [mx, my - 24]], pen.c('#5a3d26'), 1.5);
    pen.poly([[mx, my - 22], [mx, my - 5], [mx + 11, my - 1]], pen.c(['#f7f3ea', '#f2c14e', '#e8eef7'][v % 3]), pen.ol);
    pen.poly([[mx, my - 24], [mx + 5, my - 22.5], [mx, my - 21]], pen.c('#d9415a'));
  },
  crystals(pen, v) {
    const cs: [number, number, number, string][] = [[-6, 0, 18, '#b48cff'], [0, -3, 26, '#6fe3ff'], [6, 1, 16, '#b48cff'], [2, 3, 11, v === 1 ? '#ff7ac8' : '#6fe3ff']];
    for (const [x, y, h, c] of cs.sort((a, b) => a[1] - b[1])) crystal(pen, x, y, h, 3.5, c);
  },
  mushroom(pen, v) {
    const cap = ['#d9415a', '#8f5bd6', '#e0a03a'][v % 3];
    if (v === 1) pen.glow(0, -14, 20, cap, 0.4);
    pen.rrect(-3, -14, 6, 14, 2.5, pen.c('#efe3cf'), pen.ol);
    pen.ellipse(0, -14, 11, 2.5, pen.c(cap, -0.35));
    pen.ctx.beginPath();
    pen.ctx.ellipse(0, -14, 12, 9, 0, Math.PI, 0);
    pen.ctx.closePath();
    pen.fillStroke(pen.c(cap), pen.ol);
    for (const [x, y, r] of [[-5, -18, 2], [2, -21, 2.2], [6, -16, 1.6], [-1, -16, 1.3]]) pen.circle(x, y, r, pen.c('#ffffff'));
  },
  chest(pen) {
    const wood = '#9b6331', gold = '#f2c14e';
    box(pen, 0, 0, 0, 6, 4, 6, wood);
    box(pen, 0, 0, 6, 6, 4, 2.5, '#a86d38');
    for (const sx of [-3, 3]) pen.line([P3(sx, 4, 0), P3(sx, 4, 8.5)], pen.c(gold), 1.4);
    pen.poly([P3(-1, 4, 4), P3(1, 4, 4), P3(1, 4, 7), P3(-1, 4, 7)], pen.c(gold), pen.ol, 0.5);
  },
  skyscraper(pen, v) {
    const hgt = 46 + v * 6;
    box(pen, 0, 0, 0, 9, 9, hgt, ['#7aa7c7', '#8fb3a8', '#a6a9c9'][v % 3]);
    windows(pen, 9, 9, hgt, '#e8f4ff', 4);
    box(pen, -2, -2, hgt, 4, 4, 5, '#b9bec7');
  },
  apartment(pen, v) {
    box(pen, 0, 0, 0, 10, 8, 22, ['#c9805e', '#d8c3a5', '#9fb0bf'][v % 3]);
    windows(pen, 10, 8, 22, '#ffe7a8', 5);
    box(pen, 0, 0, 22, 10.5, 8.5, 1.5, '#8a8f99');
  },
  shop(pen, v) {
    box(pen, 0, 0, 0, 9, 7, 10, '#ece2cc');
    pen.poly([P3(-6, 7, 1), P3(6, 7, 1), P3(6, 7, 5), P3(-6, 7, 5)], pen.c('#9fd0f5'), pen.ol, 0.5);
    const aw = ['#d9415a', '#3d7ec8', '#2f9e6a'][v % 3];
    for (let i = 0; i < 6; i++) {
      const s0 = -9 + i * 3;
      pen.poly([P3(s0, 7, 8), P3(s0 + 3, 7, 8), P3(s0 + 3, 10, 5.5), P3(s0, 10, 5.5)], pen.c(i % 2 ? '#ffffff' : aw));
    }
  },
  car(pen, v) {
    box(pen, 0, 0, 0, 6, 3, 3, ['#d9415a', '#3d7ec8', '#f2c14e'][v % 3]);
    box(pen, -0.5, 0, 3, 3.5, 2.6, 2.4, '#a9cde6');
  },
  torch(pen, _v, f) {
    pen.rrect(-1.3, -14, 2.6, 14, 1, pen.c('#5a3d26'), pen.ol);
    pen.rrect(-2.5, -16, 5, 3, 1, pen.c('#6e6e74'), pen.ol, 0.6);
    flame(pen, 0, -16, 0.7, f);
  },
};
