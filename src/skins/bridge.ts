import { HZ, TH, TW } from '../core/geometry';
import { mulberry32 } from '../core/rng';
import { shadeHex } from './color';
import { makeCanvas } from './painter';
import type { BridgeRequest, Rendered } from './types';

/** How a skin wants its bridges drawn: its palette, ink, lighting and resolution. */
export interface BridgeLook {
  color: (hex: string) => string;
  outline: string | null;
  outlineWidth: number;
  shadeLeft: number; // darkening of faces that look down-left / down-right
  shadeRight: number;
  res: number;
  grain: number; // painterly speckle on surfaces (0 = flat)
}

type P = [number, number];

const HALF = 0.3; // deck half-width, in cells
const THICK = 4; // deck slab thickness, px

/**
 * One bridge segment: piers or arches down to whatever is below, the deck slab, its surface, and railings
 * or parapets. Drawn around the cell centre at height 0, so it sorts and places like a tile.
 */
export function drawBridge(req: BridgeRequest, look: BridgeLook): Rendered {
  const { bridge: B, deck, ground, axis, cont, variant } = req;
  const D = deck * HZ, G = Math.min(ground * HZ, D - THICK);
  const padX = 8, top = TH / 2 + D + 20;
  const W = TW + padX * 2, H = top + TH / 2 + 10;
  const res = look.res;
  const canvas = makeCanvas(W * res, H * res);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(res, res);
  ctx.translate(W / 2, top);
  ctx.lineJoin = 'round';
  const rnd = mulberry32(variant * 7919 + 3);
  const col = (hex: string, amt = 0) => look.color(amt ? shadeHex(hex, amt) : hex);

  // s runs along the bridge (+ towards the viewer), c across it (+ towards the viewer), z up
  const pt = (s: number, c: number, z: number): P => {
    const [u, v] = axis === 0 ? [s, c] : [c, s];
    return [((u - v) * TW) / 2, ((u + v) * TH) / 2 - z];
  };
  const shape = (pts: P[]) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
  };
  const fill = (pts: P[], fillStyle: string | CanvasGradient, ink = false) => {
    shape(pts);
    ctx.fillStyle = fillStyle;
    ctx.fill();
    if (ink && look.outline) {
      ctx.strokeStyle = look.outline;
      ctx.lineWidth = look.outlineWidth;
      ctx.stroke();
    }
  };
  const line = (a: P, b: P, stroke: string, width: number) => {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  const grain = (pts: P[], base: string, n: number) => {
    if (!look.grain) return;
    ctx.save();
    shape(pts);
    ctx.clip();
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    for (let i = 0; i < n * look.grain; i++) {
      ctx.fillStyle = shadeHex(base, (rnd() - 0.5) * 0.35);
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x0 + rnd() * (x1 - x0), y0 + rnd() * (y1 - y0), 1 + rnd() * 1.6, 0.8 + rnd());
    }
    ctx.restore();
  };
  // faces looking down-left get shadeLeft, down-right shadeRight (the long side's direction depends on the axis)
  const sideShade = axis === 0 ? look.shadeLeft : look.shadeRight;
  const endShade = axis === 0 ? look.shadeRight : look.shadeLeft;
  const openBack = !(cont & 1), openFront = !(cont & 2);
  const s0 = -0.5, s1 = 0.5;

  // ── under the deck ──
  const drop = D - THICK - G;
  if (B.piers === 'posts' && drop > 2) {
    for (const c of [-HALF * 0.8, HALF * 0.8]) {
      const a = pt(0, c, D - THICK), b = pt(0, c, G - 3);
      fill([[a[0] - 1.3, a[1]], [a[0] + 1.3, a[1]], [b[0] + 1.3, b[1]], [b[0] - 1.3, b[1]]], col(B.colors.pier, c < 0 ? -0.25 : 0), true);
    }
    if (drop > 8) line(pt(0, -HALF * 0.8, D - THICK - 1), pt(0, HALF * 0.8, G + 1), col(B.colors.pier, -0.1), 1);
  }
  if (B.piers === 'arches' && drop > 3) {
    // the far wall (seen through the arches), then the near wall; each has its arch cut right out
    for (const c of [-HALF, HALF]) {
      const face: P[] = [pt(s0, c, D - THICK), pt(s1, c, D - THICK), pt(s1, c, G), pt(s0, c, G)];
      const tmp = makeCanvas(canvas.width, canvas.height);
      const t = tmp.getContext('2d')!;
      t.setTransform(ctx.getTransform());
      t.beginPath();
      t.moveTo(face[0][0], face[0][1]);
      for (const p of face.slice(1)) t.lineTo(p[0], p[1]);
      t.closePath();
      t.fillStyle = col(B.colors.pier, -(sideShade + (c < 0 ? 0.22 : 0)));
      t.fill();
      if (drop > 7) {
        const spring = G + drop * 0.3, crown = D - THICK - Math.max(2.5, drop * 0.18);
        t.globalCompositeOperation = 'destination-out';
        t.beginPath();
        const a0 = pt(-0.36, c, G - 1);
        t.moveTo(a0[0], a0[1]);
        for (let k = 0; k <= 14; k++) {
          const th = Math.PI - (k / 14) * Math.PI;
          const p = pt(0.36 * Math.cos(th), c, spring + (crown - spring) * Math.sin(th));
          t.lineTo(p[0], p[1]);
        }
        const a1 = pt(0.36, c, G - 1);
        t.lineTo(a1[0], a1[1]);
        t.closePath();
        t.fill();
        t.globalCompositeOperation = 'source-over';
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
    }
  }

  // ── the deck slab ──
  const sideFace: P[] = [pt(s0, HALF, D), pt(s1, HALF, D), pt(s1, HALF, D - THICK), pt(s0, HALF, D - THICK)];
  fill(sideFace, col(B.colors.side, -sideShade), true);
  if (openFront) fill([pt(s1, -HALF, D), pt(s1, HALF, D), pt(s1, HALF, D - THICK), pt(s1, -HALF, D - THICK)], col(B.colors.side, -endShade), true);
  const deckTop: P[] = [pt(s0, -HALF, D), pt(s1, -HALF, D), pt(s1, HALF, D), pt(s0, HALF, D)];
  fill(deckTop, col(B.colors.deck), true);
  grain(deckTop, col(B.colors.deck), 60);

  // ── the walking surface ──
  ctx.save();
  shape(deckTop);
  ctx.clip();
  const joint = col(B.colors.deck, -0.3);
  if (B.deck === 'planks') {
    const n = 7;
    for (let k = 0; k < n; k++) {
      const a = s0 + k / n, b = a + 1 / n;
      fill([pt(a, -HALF, D), pt(b, -HALF, D), pt(b, HALF, D), pt(a, HALF, D)], col(B.colors.deck, (rnd() - 0.5) * 0.16));
      line(pt(a, -HALF, D), pt(a, HALF, D), joint, 0.6);
    }
  } else if (B.deck === 'slabs') {
    for (const s of [-0.25, 0.25]) line(pt(s, -HALF, D), pt(s, HALF, D), joint, 0.6);
    line(pt(s0, 0, D), pt(-0.25, 0, D), joint, 0.6);
    line(pt(0, 0, D), pt(0.25, 0, D), joint, 0.6);
  } else {
    const rows = 5;
    for (let r = 1; r < rows; r++) {
      const c = -HALF + (2 * HALF * r) / rows;
      line(pt(s0, c, D), pt(s1, c, D), joint, 0.5);
    }
    for (let r = 0; r < rows; r++) {
      const c0 = -HALF + (2 * HALF * r) / rows, c1 = c0 + (2 * HALF) / rows;
      for (let s = s0 + (r % 2 ? 0.0625 : 0.125); s < s1; s += 0.125) line(pt(s, c0, D), pt(s, c1, D), joint, 0.45);
    }
  }
  ctx.restore();

  // ── railings or parapets: the far one first, standing on the deck ──
  const rail = (c: number) => {
    if (B.rail === 'posts') {
      const sa = openBack ? s0 + 0.04 : s0, sb = openFront ? s1 - 0.04 : s1;
      const posts = [-0.25, 0.25, ...(openBack ? [sa] : []), ...(openFront ? [sb] : [])];
      for (const s of posts) {
        const a = pt(s, c, D), b = pt(s, c, D + 8);
        fill([[a[0] - 0.9, a[1]], [a[0] + 0.9, a[1]], [b[0] + 0.9, b[1]], [b[0] - 0.9, b[1]]], col(B.colors.rail, c < 0 ? -0.15 : 0));
      }
      line(pt(sa, c, D + 7.2), pt(sb, c, D + 7.2), col(B.colors.rail, c < 0 ? -0.1 : 0.05), 1.5);
      line(pt(sa, c, D + 4), pt(sb, c, D + 4), col(B.colors.rail, c < 0 ? -0.2 : -0.05), 1);
      return;
    }
    // a parapet: a low wall with a cap; pillars where the bridge meets the bank
    const inner = c < 0 ? c + 0.07 : c - 0.07, ht = 5;
    const near = c > 0 ? c : inner; // the face we see is the one towards the viewer
    const face: P[] = [pt(s0, near, D), pt(s1, near, D), pt(s1, near, D + ht), pt(s0, near, D + ht)];
    fill(face, col(B.colors.rail, -(sideShade * (c > 0 ? 1 : 0.6))), true);
    if (B.deck === 'bricks') {
      line(pt(s0, near, D + ht / 2), pt(s1, near, D + ht / 2), col(B.colors.rail, -0.35), 0.4);
      for (let s = s0 + 0.0625; s < s1; s += 0.125) line(pt(s, near, D), pt(s, near, D + ht / 2), col(B.colors.rail, -0.35), 0.4);
    }
    if (openFront) fill([pt(s1, inner, D), pt(s1, c, D), pt(s1, c, D + ht), pt(s1, inner, D + ht)], col(B.colors.rail, -endShade));
    fill([pt(s0, inner, D + ht), pt(s1, inner, D + ht), pt(s1, c, D + ht), pt(s0, c, D + ht)], col(B.colors.cap, 0.05), true);
    for (const s of [...(openBack ? [s0 + 0.06] : []), ...(openFront ? [s1 - 0.06] : [])]) {
      const w = 0.07, z1 = D + ht + 3;
      fill([pt(s - w, near, D), pt(s + w, near, D), pt(s + w, near, z1), pt(s - w, near, z1)], col(B.colors.rail, -sideShade * 0.8), true);
      fill([pt(s + w, inner, D), pt(s + w, c, D), pt(s + w, c, z1), pt(s + w, inner, z1)], col(B.colors.rail, -endShade));
      fill([pt(s - w, inner, z1), pt(s + w, inner, z1), pt(s + w, c, z1), pt(s - w, c, z1)], col(B.colors.cap, 0.1), true);
    }
  };
  rail(-HALF);
  rail(HALF);
  return { canvas, ax: (W / 2) * res, ay: top * res, res };
}

