import { BASE, HEADROOM, HZ, PAD, TH, TW } from '../core/geometry';
import type { Pack } from '../core/packs';
import type { PropDef } from '../core/props';
import type { TerrainDef } from '../core/terrains';
import { hexToNum } from './color';
import { Pen, foam, makeCanvas, roadMarks, type PaintStyle } from './painter';
import type { PropRequest, Rendered, Skin, TileRequest } from './types';

/** A keyed sprite: anchor normalised to the footprint centre; w0 = the object's width in the raw generation. */
interface SpriteArt {
  src: string;
  ax: number;
  ay: number;
  w0?: number;
}

/** Written by tools/forge into public/packs/<pack>/assets.json. Paths are relative to that folder. */
export interface PackAssets {
  terrains: Record<string, { top?: string; side?: string; sprite?: string }>;
  props: Record<string, SpriteArt & { views?: (SpriteArt | null | false)[] }>; // views[v - 1]: the map turned v quarter-turns (false: mirror instead)
}

type Img = HTMLImageElement;
type Pt = [number, number];

const RES = 2; // painted art is rasterised at 2× for crisp zooming
const K = 4; // a texture spans K×K cells at tile size 1, so neighbouring tiles show neighbouring slices
const LIGHT = { left: 0.16, right: 0.36 };
const MARK_STYLE: PaintStyle = { color: (c) => c, outline: null, outlineWidth: 1, shadeLeft: 0, shadeRight: 0, wobble: 0, hatch: false, strata: false };

function loadImage(url: string): Promise<Img | null> {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = url;
  });
}

/** Loads a pack's forged art; null if the pack has none yet. */
export async function loadPainted(pack: Pack, fallback: Skin): Promise<PaintedSkin | null> {
  const base = `/packs/${pack.id}/`;
  let assets: PackAssets;
  try {
    const r = await fetch(`${base}assets.json`, { cache: 'no-store' });
    if (!r.ok) return null;
    assets = await r.json();
  } catch {
    return null;
  }
  const bust = `?v=${Date.now()}`;
  const images = new Map<string, Img>();
  const paths = new Set<string>();
  for (const t of Object.values(assets.terrains)) for (const p of [t.top, t.side, t.sprite]) if (p) paths.add(p);
  for (const p of Object.values(assets.props)) for (const a of [p, ...(p.views ?? [])]) if (a) paths.add(a.src);
  await Promise.all(
    [...paths].map(async (p) => {
      const img = await loadImage(base + p + bust);
      if (img) images.set(p, img);
    }),
  );
  return new PaintedSkin(pack, assets, images, fallback);
}

export class PaintedSkin implements Skin {
  readonly id: string;
  readonly name = 'Painted';
  readonly blurb: string;
  readonly theme = 'dark' as const;
  readonly nearest = false;
  readonly layerBg: Skin['layerBg'];
  private patterns = new Map<Img, CanvasPattern>();

  constructor(private pack: Pack, private assets: PackAssets, private images: Map<string, Img>, private fallback: Skin) {
    this.id = `painted:${pack.id}`;
    this.blurb = `Forged ${pack.name} art`;
    this.layerBg = { ...fallback.layerBg };
    for (const l of Object.values(pack.layers)) if (l.bg) this.layerBg[l.id] = hexToNum(l.bg);
  }

  get count() {
    return this.images.size;
  }

  private img(path?: string) {
    return path ? this.images.get(path) ?? null : null;
  }

  private art(T: TerrainDef) {
    return T.pack === this.pack.id && T.art ? this.assets.terrains[T.art] : undefined;
  }

  /** Bigger tiles hold more world, so each shows more of the texture (finer ground detail), and vice versa. */
  regionGrid(T: TerrainDef, tile: number) {
    return this.img(this.art(T)?.top) ? Math.max(2, Math.min(6, Math.round(K / tile))) : 1;
  }

  tint(hex: string) {
    return this.fallback.tint(hex);
  }

  renderTile(req: TileRequest): Rendered {
    const a = this.art(req.terrain);
    const sprite = this.img(a?.sprite);
    if (sprite) return this.spriteTile(sprite);
    const top = this.img(a?.top);
    if (!top) return this.fallback.renderTile(req);
    return this.texturedTile(req, top, this.img(a?.side));
  }

  renderProp(req: PropRequest): Rendered {
    const P: PropDef = req.prop;
    const main = P.pack === this.pack.id && P.art ? this.assets.props[P.art] : undefined;
    if (!main || !this.img(main.src)) return this.fallback.renderProp(req);
    const turned = req.view ? main.views?.[req.view - 1] : null;
    const a = turned && this.img(turned.src) ? turned : main;
    const img = this.img(a.src)!;
    // the main view fills the footprint's width; turned views keep their size relative to it
    const rel = a !== main && a.w0 && main.w0 ? a.w0 / main.w0 : 1;
    const dw = req.width * TW * 0.92 * rel;
    const dh = (dw * img.height) / img.width;
    const pad = 6;
    const canvas = makeCanvas((dw + pad * 2) * RES, (dh + pad * 2) * RES);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(RES, RES);
    // the forge finds the ground point from the lowest pixels, which for a long thing (an arch) is one end of
    // it; long footprints sit centred on the sprite's width instead, standing on the footprint like a building
    const long = Array.isArray(P.foot) && P.foot[0] !== P.foot[1];
    const ax = pad + (long ? 0.5 : a.ax) * dw, ay = pad + (long ? 1 - (0.225 * img.width) / img.height : a.ay) * dh;
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(ax, ay, dw * 0.36, dw * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, pad, pad, dw, dh);
    return { canvas, ax: ax * RES, ay: ay * RES, res: RES, view: a === main ? 0 : req.view };
  }

  private texPattern(ctx: CanvasRenderingContext2D, img: Img) {
    let p = this.patterns.get(img);
    if (!p) this.patterns.set(img, (p = ctx.createPattern(img, 'repeat')!));
    return p;
  }

  private spriteTile(img: Img): Rendered {
    const dw = TW * 1.3, dh = (dw * img.height) / img.width;
    const canvas = makeCanvas((dw + 8) * RES, (dh + 8) * RES);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(RES, RES);
    ctx.drawImage(img, 4, 4, dw, dh);
    // anchor slightly below the sprite's middle so it floats over the cell
    return { canvas, ax: (4 + dw / 2) * RES, ay: (4 + dh * 0.62) * RES, res: RES };
  }

  private texturedTile(req: TileRequest, top: Img, side: Img | null): Rendered {
    const { terrain: T, h, region, frame, mask, grid: K } = req;
    const D = T.floating ? BASE + 2 : h * HZ + BASE;
    const under = T.floating ? 24 : 0;
    const W = TW + PAD * 2, H = HEADROOM + TH + D + PAD + under;
    const canvas = makeCanvas(W * RES, H * RES);
    const ctx = canvas.getContext('2d')!;
    const ax = PAD + TW / 2, ay = HEADROOM + TH / 2;
    ctx.scale(RES, RES);
    ctx.translate(ax, ay);
    const rx = region % K, ry = Math.floor(region / K);

    const t: Pt = [0, -TH / 2], r: Pt = [TW / 2, 0], b: Pt = [0, TH / 2], l: Pt = [-TW / 2, 0];
    const rd: Pt = [TW / 2, D], bd: Pt = [0, TH / 2 + D], ld: Pt = [-TW / 2, D];
    const path = (pts: Pt[], close = true) => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
      if (close) ctx.closePath();
    };

    if (T.floating) {
      const tip: Pt = [0, bd[1] + under - 3];
      path([ld, [ld[0] + 10, ld[1] + under * 0.55], tip, [rd[0] - 10, rd[1] + under * 0.6], rd, bd]);
      ctx.fillStyle = side ? this.texPattern(ctx, side) : T.colors.side;
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fill();
    }

    // sides: the side texture runs along each face; liquids show a band of liquid over earth
    const faces: [Pt[], Pt, Pt, number, number][] = [
      [[l, b, bd, ld], l, [TW / 2, TH / 2], rx, LIGHT.left],
      [[b, r, rd, bd], b, [TW / 2, -TH / 2], ry, LIGHT.right],
    ];
    for (const [face, origin, dir, slice, shade] of faces) {
      path(face);
      if (side) {
        const sz = side.width / K;
        const m = new DOMMatrix([dir[0] / sz, dir[1] / sz, 0, TW / 2 / sz, origin[0], origin[1]]).translate(-slice * sz, 0);
        const p = this.texPattern(ctx, side);
        p.setTransform(m);
        ctx.fillStyle = p;
      } else ctx.fillStyle = T.colors.side;
      ctx.fill();
      if (T.liquid) {
        path([face[0], face[1], [face[1][0], face[1][1] + 6], [face[0][0], face[0][1] + 6]]);
        ctx.fillStyle = T.colors.side;
        ctx.fill();
        path(face);
      }
      const g = ctx.createLinearGradient(0, origin[1], 0, origin[1] + D + TH / 2);
      g.addColorStop(0, `rgba(0,0,0,${shade})`);
      g.addColorStop(1, `rgba(0,0,0,${Math.min(0.85, shade + 0.3)})`);
      ctx.fillStyle = g;
      ctx.fill();
    }

    // top: a slice of the seamless texture, chosen by the cell's position (liquids drift with the frame)
    ctx.save();
    const grow = 1.012; // overlap neighbours by a hair so no seams show
    path([t, r, b, l].map(([x, y]) => [x * grow, y * grow] as Pt));
    ctx.clip();
    const s = top.width / K;
    const drift = T.liquid ? (frame * s) / 10 : 0;
    const m = new DOMMatrix([TW / 2 / s, TH / 2 / s, -TW / 2 / s, TH / 2 / s, 0, -TH / 2]).translate(-rx * s - drift, -ry * s - drift * 0.5);
    const pat = this.texPattern(ctx, top);
    pat.setTransform(m);
    ctx.fillStyle = pat;
    ctx.fillRect(-TW, -TH, TW * 2, TH * 2);
    const pen = new Pen(ctx, MARK_STYLE, () => 0.5);
    if (T.foam && mask) foam(pen, [t, r, b, l], mask, frame);
    if (T.road) roadMarks(pen, mask, T.colors);
    ctx.restore();

    // a soft bevel: light catches the front lip, dark lines settle the silhouette
    ctx.lineJoin = 'round';
    path([l, b, r], false);
    ctx.strokeStyle = 'rgba(255,240,210,0.16)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    path([l, ld, bd, rd, r], false);
    ctx.strokeStyle = 'rgba(12,8,6,0.5)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    return { canvas, ax: ax * RES, ay: ay * RES, res: RES };
  }
}
