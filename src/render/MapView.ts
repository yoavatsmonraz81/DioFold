import { AlphaFilter, Application, CanvasSource, Color, Container, Graphics, Rectangle, Sprite, Texture, TilingSprite } from 'pixi.js';
import { propSize } from '../core/footprint';
import { BASE, HZ, MAX_H, TH, TW, isoX, isoY } from '../core/geometry';
import { LAYER_IDS, type LayerId } from '../core/layers';
import { PROPS } from '../core/props';
import { hash2 } from '../core/rng';
import { terrain, type TerrainDef } from '../core/terrains';
import type { Cell, World } from '../core/world';
import { makeCanvas } from '../skins/painter';
import type { Rendered, Skin } from '../skins/types';

const GAP = 60; // how far below the active layer the ghosted layer sits
const GHOST_ALPHA = 0.3;
const FRAME_MS = 200;
const DROP_MS = 300;
const SPIN_MS = 520;

/** A vertical slice of a big prop's image, so each slice can sort at the depth of the cells it covers. */
interface Strip {
  tex: Texture;
  dx: number; // slice's left edge, relative to the prop's anchor point
  k: number; // slice index, left to right, in half-tile columns
}

interface Entry {
  tex: Texture;
  ax: number;
  ay: number;
  strips?: Map<number, Strip[]>;
}

class TileSprite extends Sprite {
  baseY = 0;
  drop = 1; // progress 0..1 (negative = waiting to start)
  dropH = 18;
  bobAmp = 0;
  phase = 0;
  // where it sits: world point (cell, or a footprint's centre) lifted `lift` px and nudged `dx` px on screen
  wx = 0;
  wy = 0;
  lift = 0;
  dx = 0;
  // depth: the world cell it sorts with at rest, its half-size in cells (used mid-spin), and tile/prop order
  zx = 0;
  zy = 0;
  zr = 0;
  zb = 0;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Flips a drawn prop left-to-right: the stand-in for a turned view when a skin has no art for it. */
function mirror(r: Rendered): Rendered {
  const c = makeCanvas(r.canvas.width, r.canvas.height);
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(r.canvas, 0, 0);
  return { ...r, canvas: c, ax: c.width - r.ax };
}

interface Particle {
  s: Sprite;
  vx: number;
  vy: number;
  life: number;
  max: number;
}

class LayerView {
  readonly container = new Container();
  readonly tiles: (TileSprite | null)[];
  readonly props: (TileSprite[] | null)[]; // a prop is one sprite, or strips when it covers several cells
  readonly animated = new Set<number>();
  readonly filter = new AlphaFilter({ alpha: 1 });
  y = 0;
  alpha = 1;
  targetY = 0;
  targetAlpha = 1;

  constructor(readonly id: LayerId, n: number) {
    this.container.sortableChildren = true;
    this.tiles = new Array(n).fill(null);
    this.props = new Array(n).fill(null);
  }
}

export type HoverMode = 'paint' | 'erase' | 'raise' | 'lower' | 'prop' | 'blocked' | 'none';
const HOVER_COLORS: Record<HoverMode, number> = { paint: 0xffffff, erase: 0xff6b6b, raise: 0x7dffa0, lower: 0xffb86b, prop: 0xffe14d, blocked: 0xff5a5a, none: 0xffffff };

const easeOutBack = (t: number) => 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class MapView {
  readonly app = new Application();
  readonly root = new Container();
  private bg!: TilingSprite;
  private hover = new Graphics();
  private fx = new Container();
  private layers = {} as Record<LayerId, LayerView>;
  private textures = new Map<string, Entry>();
  private skin!: Skin;
  private frame = 0;
  private frameClock = 0;
  private time = 0;
  private dropping = new Set<TileSprite>();
  private particles: Particle[] = [];
  private dotTex!: Texture;
  private bgColor = new Color(0x86c3e3);
  private batching = false;
  private spin: { from: number; to: number; t: number } | null = null;
  private angle = 0; // current turn in quarter-turns (fractional mid-spin)
  active: LayerId = 'surface';
  /** View rotation: the map turned this many quarter-turns clockwise. */
  rot = 0;
  /** Called when a turn has finished and the map is redrawn from its new side. */
  onTurned: (() => void) | null = null;

  constructor(private world: World) {}

  async init(host: HTMLElement, skin: Skin) {
    await this.app.init({
      resizeTo: host,
      antialias: true,
      background: skin.layerBg[this.active],
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    host.appendChild(this.app.canvas);

    this.bg = new TilingSprite({ texture: Texture.EMPTY, width: 1, height: 1 });
    this.app.stage.addChild(this.bg, this.root);
    for (const id of [...LAYER_IDS].reverse()) {
      const lv = new LayerView(id, this.world.w * this.world.h);
      this.layers[id] = lv;
      this.root.addChild(lv.container);
    }
    this.root.addChild(this.hover, this.fx);

    const dot = makeCanvas(8, 8);
    const dctx = dot.getContext('2d')!;
    dctx.fillStyle = '#fff';
    dctx.beginPath();
    dctx.arc(4, 4, 3.5, 0, Math.PI * 2);
    dctx.fill();
    this.dotTex = new Texture({ source: new CanvasSource({ resource: dot }) });

    this.setSkin(skin);
    this.setActiveLayer(this.active, true);
    this.world.onChange((layer, x, y, before, after) => this.onCellChanged(layer, x, y, before, after));
    this.app.ticker.add((t) => this.tick(t.deltaMS));
    this.fit();
  }

  // ── skin & textures ──

  setSkin(skin: Skin) {
    this.skin = skin;
    const old = [...this.textures.values()];
    const oldBg = this.bg.texture;
    this.textures.clear();
    if (skin.pattern) {
      const size = 128;
      const c = makeCanvas(size, size);
      skin.pattern(c.getContext('2d')!, size);
      this.bg.texture = new Texture({ source: new CanvasSource({ resource: c }) });
    } else this.bg.texture = Texture.EMPTY;
    for (const id of LAYER_IDS) this.rebuildLayer(id);
    // free the old textures once a couple of frames have drawn without them
    setTimeout(() => {
      for (const e of old) {
        for (const list of e.strips?.values() ?? []) for (const s of list) s.tex.destroy(false);
        e.tex.destroy(true);
      }
      if (oldBg !== Texture.EMPTY && oldBg !== this.bg.texture) oldBg.destroy(true);
    }, 250);
  }

  private entry(key: string, draw: () => Rendered): Entry {
    let e = this.textures.get(key);
    if (!e) {
      const r = draw();
      const source = new CanvasSource({ resource: r.canvas, resolution: r.res ?? 1, scaleMode: this.skin.nearest ? 'nearest' : 'linear' });
      e = { tex: new Texture({ source }), ax: r.ax / r.canvas.width, ay: r.ay / r.canvas.height };
      this.textures.set(key, e);
    }
    return e;
  }

  private tileEntry(T: TerrainDef, h: number, variant: number, frame: number, mask: number, region: number, grid: number) {
    const hh = T.floating ? 0 : h;
    return this.entry(`t|${T.id}|${hh}|${variant}|${frame}|${mask}|${region}|${grid}`, () => this.skin.renderTile({ terrain: T, h: hh, variant, frame, mask, region, grid }));
  }

  private propEntry(id: string, variant: number, frame: number, width: number, view: number) {
    return this.entry(`p|${id}|${variant}|${frame}|${width.toFixed(3)}|${view}`, () => {
      const r = this.skin.renderProp({ prop: PROPS[id], variant, frame, width, view });
      return (r.view ?? 0) === view || view % 2 === 0 ? r : mirror(r);
    });
  }

  /**
   * Cuts a prop image into half-tile-wide columns lined up with a footprint that is su cells along its
   * screen-left front edge and sv along its screen-right one (outer slices keep any overhang).
   */
  private strips(e: Entry, su: number, sv: number): Strip[] {
    const key = su * 16 + sv;
    let list = e.strips?.get(key);
    if (list) return list;
    const tw = e.tex.width, th = e.tex.height, ax = e.ax * tw;
    const front = ax - ((sv - su) * TW) / 4; // the front corner sits off-centre when the footprint is long
    const count = su + sv;
    list = [];
    for (let k = 0; k < count; k++) {
      const x0 = k === 0 ? 0 : Math.max(0, Math.min(tw, front + (k - su) * (TW / 2)));
      const x1 = k === count - 1 ? tw : Math.max(0, Math.min(tw, front + (k - su + 1) * (TW / 2)));
      if (x1 - x0 < 0.5) continue;
      list.push({ tex: new Texture({ source: e.tex.source, frame: new Rectangle(x0, 0, x1 - x0, th) }), dx: x0 - ax, k });
    }
    (e.strips ??= new Map()).set(key, list);
    return list;
  }

  /** Canvas thumbnails for the palette, drawn with the current skin. */
  thumb(kind: 'terrain' | 'prop', id: string): HTMLCanvasElement {
    const T = terrain(id);
    const r =
      kind === 'terrain'
        ? this.skin.renderTile({ terrain: T, h: T.fixedH ?? Math.min(T.baseH ?? 1, 2), variant: 1, frame: 0, mask: T.road ? 5 : 0, region: 0, grid: this.skin.regionGrid?.(T, 1) ?? 1 })
        : this.skin.renderProp({ prop: PROPS[id], variant: 0, frame: 0, width: 1, view: 0 });
    const out = makeCanvas(56, 56);
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingEnabled = !this.skin.nearest;
    // crop around the anchor so the interesting part fills the swatch
    const res = r.res ?? 1;
    const sw = (kind === 'terrain' ? 74 : 60) * res;
    const sx = r.ax - sw / 2, sy = kind === 'terrain' ? r.ay - 30 * res : r.ay - sw + 6 * res;
    ctx.drawImage(r.canvas, sx, sy, sw, sw, 0, 0, 56, 56);
    return out;
  }

  // ── rotation ──

  /** Screen-grid position of world point (x, y) at the resting rotation. Works for fractional points too. */
  rest(x: number, y: number): [number, number] {
    const { w, h } = this.world;
    switch (this.rot) {
      case 1:
        return [h - 1 - y, x];
      case 2:
        return [w - 1 - x, h - 1 - y];
      case 3:
        return [y, w - 1 - x];
      default:
        return [x, y];
    }
  }

  /** World cell at screen-grid position (u, v), the inverse of rest(). */
  unrest(u: number, v: number): [number, number] {
    const { w, h } = this.world;
    switch (this.rot) {
      case 1:
        return [v, h - 1 - u];
      case 2:
        return [w - 1 - u, h - 1 - v];
      case 3:
        return [w - 1 - v, u];
      default:
        return [u, v];
    }
  }

  /** Like rest(), but follows the turntable mid-spin. */
  private uvAt(x: number, y: number): [number, number] {
    if (!this.spin) return this.rest(x, y);
    const cx = (this.world.w - 1) / 2, cy = (this.world.h - 1) / 2;
    const a = x - cx, b = y - cy, t = (this.angle * Math.PI) / 2;
    const c = Math.cos(t), s = Math.sin(t);
    return [cx + a * c - b * s, cy + a * s + b * c];
  }

  /** Turn the map a quarter-turn (1 = clockwise). Everything swings round, then redraws from the new side. */
  rotate(dir: 1 | -1) {
    if (this.spin) {
      // queue another quarter-turn, carrying on smoothly from wherever the spin has got to
      this.spin = { from: this.angle, to: this.spin.to + dir, t: 0 };
      return;
    }
    this.spin = { from: this.rot, to: this.rot + dir, t: 0 };
    this.setHover([]);
  }

  get spinning() {
    return !!this.spin;
  }

  private position(s: TileSprite) {
    const [u, v] = this.uvAt(s.wx, s.wy);
    s.x = isoX(u, v) + s.dx;
    s.baseY = isoY(u, v) - s.lift;
    const [zu, zv] = this.spin ? [u + s.zr, v + s.zr] : this.rest(s.zx, s.zy);
    s.zIndex = ((zu + zv) * 256 + zu) * 2 + s.zb;
    this.place(s);
  }

  // ── cells ──

  private variant(layer: LayerId, x: number, y: number) {
    return hash2(x, y, LAYER_IDS.indexOf(layer) + 1) % 3;
  }

  /** Which neighbours matter for this terrain's edges: land around water (foam), roads around roads. Bits follow the screen. */
  private edgeMask(T: TerrainDef, layer: LayerId, x: number, y: number) {
    if (!T.foam && !T.road) return 0;
    let m = 0;
    const [u, v] = this.rest(x, y);
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    dirs.forEach(([du, dv], k) => {
      const [nx, ny] = this.unrest(u + du, v + dv);
      const n = this.world.get(layer, nx, ny);
      if (!n) return;
      const N = terrain(n.t);
      if (T.road ? N.road : !N.liquid && !N.floating && N.fixedH === undefined) m |= 1 << k;
    });
    return m;
  }

  private refreshCell(layer: LayerId, x: number, y: number) {
    const lv = this.layers[layer];
    const i = y * this.world.w + x;
    const cell = this.world.get(layer, x, y);
    let s = lv.tiles[i];
    if (!cell) {
      if (s) this.removeSprite(lv, s), (lv.tiles[i] = null);
      this.setProp(lv, i, null);
      lv.animated.delete(i);
      return;
    }
    const T = terrain(cell.t);
    const v = this.variant(layer, x, y);
    const f = T.animated ? (this.frame + v) % 4 : 0;
    const k = this.skin.regionGrid?.(T, this.world.tile[layer]) ?? 1;
    const [ru, rv] = this.rest(x, y);
    const region = k > 1 ? mod(ru, k) + k * mod(rv, k) : 0;
    const e = this.tileEntry(T, cell.h, T.liquid ? 0 : v, f, this.edgeMask(T, layer, x, y), region, k);
    if (!s) {
      s = new TileSprite(e.tex);
      s.phase = x * 0.7 + y * 1.3;
      lv.tiles[i] = s;
      lv.container.addChild(s);
    } else s.texture = e.tex;
    s.anchor.set(e.ax, e.ay);
    s.wx = s.zx = x;
    s.wy = s.zy = y;
    s.lift = cell.h * HZ;
    s.bobAmp = T.floating ? 2 : 0;
    this.position(s);

    const P = cell.p ? PROPS[cell.p] : null;
    if (P) {
      const { nx, ny, w: width } = propSize(P, this.world.tile[layer]);
      const big = nx * ny > 1;
      const pe = this.propEntry(P.id, v, P.animated ? (this.frame + v) % 4 : 0, width, this.rot);
      // the footprint on screen: its front corner, and how many cells run along each front edge
      const corners = [this.rest(x, y), this.rest(x - nx + 1, y), this.rest(x, y - ny + 1), this.rest(x - nx + 1, y - ny + 1)];
      const us = corners.map((c) => c[0]), vs = corners.map((c) => c[1]);
      const fu = Math.max(...us), fv = Math.max(...vs);
      const su = fu - Math.min(...us) + 1, sv = fv - Math.min(...vs) + 1;
      // big props sort slice by slice along the two front edges
      const parts: Strip[] = big ? this.strips(pe, su, sv) : [{ tex: pe.tex, dx: 0, k: 0 }];
      const sprites = this.setProp(lv, i, parts.length, s.phase);
      parts.forEach((part, j) => {
        const ps = sprites[j];
        ps.texture = part.tex;
        ps.anchor.set(big ? 0 : pe.ax, pe.ay);
        ps.wx = x - (nx - 1) / 2;
        ps.wy = y - (ny - 1) / 2;
        ps.dx = part.dx;
        ps.lift = cell.h * HZ - (T.liquid ? 2 : 0);
        ps.zr = (Math.max(nx, ny) - 1) / 2;
        ps.zb = 1;
        ps.bobAmp = P.bob ? 1.5 : s.bobAmp;
        if (!big) (ps.zx = x), (ps.zy = y);
        else {
          const m = part.k < su ? su - 1 - part.k : part.k - su;
          [ps.zx, ps.zy] = part.k < su ? this.unrest(fu - m, fv) : this.unrest(fu, fv - m);
        }
        this.position(ps);
      });
    } else this.setProp(lv, i, null);
    if (T.animated || P?.animated) lv.animated.add(i);
    else lv.animated.delete(i);
  }

  /** Makes sure cell i has exactly `count` prop sprites (null = none) and returns them. */
  private setProp(lv: LayerView, i: number, count: number | null, phase = 0): TileSprite[] {
    const cur = lv.props[i];
    if (cur && cur.length === count) return cur;
    if (cur) for (const s of cur) this.removeSprite(lv, s);
    if (!count) {
      lv.props[i] = null;
      return [];
    }
    const list = Array.from({ length: count }, () => {
      const s = new TileSprite();
      s.phase = phase;
      lv.container.addChild(s);
      return s;
    });
    lv.props[i] = list;
    return list;
  }

  private removeSprite(lv: LayerView, s: TileSprite) {
    this.dropping.delete(s);
    lv.container.removeChild(s);
    s.destroy();
  }

  private place(s: TileSprite) {
    const p = Math.max(0, s.drop);
    const off = s.drop >= 1 ? 0 : -s.dropH * (1 - easeOutBack(p));
    s.alpha = s.drop >= 1 ? 1 : Math.min(1, p * 4);
    s.y = s.baseY + off + (s.bobAmp ? Math.sin(this.time / 650 + s.phase) * s.bobAmp : 0);
  }

  private startDrop(s: TileSprite | TileSprite[] | null, delay = 0, height = 18) {
    if (!s) return;
    for (const one of Array.isArray(s) ? s : [s]) {
      one.drop = -delay / DROP_MS;
      one.dropH = height;
      this.dropping.add(one);
      this.place(one);
    }
  }

  private onCellChanged(layer: LayerId, x: number, y: number, before: Cell | null, after: Cell | null) {
    if (this.batching) return;
    this.refreshCell(layer, x, y);
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const n = this.world.get(layer, x + dx, y + dy);
      if (n && (terrain(n.t).foam || terrain(n.t).road)) this.refreshCell(layer, x + dx, y + dy);
    }
    if (!after) return;
    const lv = this.layers[layer];
    const i = y * this.world.w + x;
    if (!before || before.t !== after.t) {
      this.startDrop(lv.tiles[i]);
      this.startDrop(lv.props[i]);
      if (layer === this.active) this.burst(x, y, after, terrain(after.t).colors.top);
    } else if (before.h !== after.h) {
      this.startDrop(lv.tiles[i], 0, after.h > before.h ? -8 : 8);
      this.startDrop(lv.props[i], 0, after.h > before.h ? -8 : 8);
    } else if (before.p !== after.p && after.p) {
      this.startDrop(lv.props[i], 0, 24);
      if (layer === this.active) this.burst(x, y, after, '#ffffff');
    }
  }

  /** Run many edits without per-cell animation, then rebuild once. */
  batch(layer: LayerId, fn: () => void, cascade = true) {
    this.batching = true;
    try {
      fn();
    } finally {
      this.batching = false;
    }
    this.rebuildLayer(layer, cascade);
  }

  rebuildLayer(layer: LayerId, cascade = false) {
    const { w, h } = this.world;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.refreshCell(layer, x, y);
    if (!cascade) return;
    const lv = this.layers[layer];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const [u, v] = this.rest(x, y);
        this.startDrop(lv.tiles[i], (u + v) * 9, 26);
        this.startDrop(lv.props[i], (u + v) * 9 + 120, 26);
      }
  }

  rebuildAll() {
    for (const id of LAYER_IDS) this.rebuildLayer(id, id === this.active);
  }

  // ── layers ──

  setActiveLayer(id: LayerId, instant = false) {
    this.active = id;
    const a = LAYER_IDS.indexOf(id);
    for (const lid of LAYER_IDS) {
      const lv = this.layers[lid];
      const d = LAYER_IDS.indexOf(lid) - a;
      lv.targetY = d === 0 ? 0 : d === 1 ? GAP : d > 1 ? GAP * 2 : -GAP * 1.5;
      lv.targetAlpha = d === 0 ? 1 : d === 1 ? GHOST_ALPHA : 0;
      if (instant) (lv.y = lv.targetY), (lv.alpha = lv.targetAlpha);
    }
    if (instant) this.bgColor.setValue(this.skin.layerBg[id]);
    this.setHover([]);
  }

  // ── frame loop ──

  private tick(dt: number) {
    this.time += dt;
    if (this.spin) this.tickSpin(dt);
    this.frameClock += dt;
    if (this.frameClock >= FRAME_MS) {
      this.frameClock = 0;
      this.frame = (this.frame + 1) % 4;
      for (const id of LAYER_IDS) {
        const lv = this.layers[id];
        if (!lv.container.visible) continue;
        for (const i of lv.animated) this.refreshCell(id, i % this.world.w, Math.floor(i / this.world.w));
      }
    }

    const k = 1 - Math.exp(-dt / 110);
    for (const id of LAYER_IDS) {
      const lv = this.layers[id];
      lv.y += (lv.targetY - lv.y) * k;
      lv.alpha += (lv.targetAlpha - lv.alpha) * k;
      lv.container.y = lv.y;
      lv.container.visible = lv.alpha > 0.01;
      const needsFilter = lv.alpha < 0.995;
      if (needsFilter) lv.filter.alpha = lv.alpha;
      if (needsFilter !== !!lv.container.filters) lv.container.filters = needsFilter ? [lv.filter] : null;
    }

    // ease the background toward the active layer's colour
    const target = new Color(this.skin.layerBg[this.active]).toRgb();
    const cur = this.bgColor.toRgb();
    this.bgColor.setValue([cur.r + (target.r - cur.r) * k, cur.g + (target.g - cur.g) * k, cur.b + (target.b - cur.b) * k]);
    this.app.renderer.background.color = this.bgColor;
    this.bg.width = this.app.screen.width;
    this.bg.height = this.app.screen.height;
    this.bg.tilePosition.set(this.root.x * 0.35, this.root.y * 0.35);

    for (const s of this.dropping) {
      s.drop += dt / DROP_MS;
      if (s.drop >= 1) {
        s.drop = 1;
        this.dropping.delete(s);
      }
      this.place(s);
    }
    for (const id of LAYER_IDS) {
      const lv = this.layers[id];
      if (!lv.container.visible) continue;
      for (const s of lv.tiles) if (s && s.bobAmp && s.drop >= 1) this.place(s);
      for (const list of lv.props) if (list) for (const s of list) if (s.bobAmp && s.drop >= 1) this.place(s);
    }

    for (let n = this.particles.length - 1; n >= 0; n--) {
      const p = this.particles[n];
      p.life += dt;
      p.vy += 0.0009 * dt;
      p.s.x += p.vx * dt;
      p.s.y += p.vy * dt;
      p.s.alpha = 1 - p.life / p.max;
      if (p.life >= p.max) {
        p.s.destroy();
        this.particles.splice(n, 1);
      }
    }
    this.hover.y = this.layers[this.active].y;
  }

  private tickSpin(dt: number) {
    const sp = this.spin!;
    sp.t = Math.min(1, sp.t + dt / (SPIN_MS * Math.max(1, Math.abs(sp.to - sp.from) * 0.7)));
    this.angle = sp.from + (sp.to - sp.from) * easeInOut(sp.t);
    for (const id of LAYER_IDS) {
      const lv = this.layers[id];
      if (!lv.container.visible) continue;
      for (const s of lv.tiles) if (s) this.position(s);
      for (const list of lv.props) if (list) for (const s of list) this.position(s);
    }
    if (sp.t < 1) return;
    this.spin = null;
    this.rot = mod(sp.to, 4);
    this.angle = this.rot;
    for (const id of LAYER_IDS) this.rebuildLayer(id);
    this.onTurned?.();
  }

  private burst(x: number, y: number, cell: Cell, hex: string) {
    if (this.particles.length > 220) return;
    const tint = this.skin.tint(hex);
    for (let k = 0; k < 6; k++) {
      const s = new Sprite(this.dotTex);
      s.anchor.set(0.5);
      s.tint = tint;
      s.scale.set(0.5 + Math.random() * 0.6);
      const [u, v] = this.uvAt(x, y);
      s.x = isoX(u, v) + (Math.random() - 0.5) * TW * 0.5;
      s.y = isoY(u, v) - cell.h * HZ + this.layers[this.active].y;
      this.fx.addChild(s);
      this.particles.push({ s, vx: (Math.random() - 0.5) * 0.12, vy: -0.12 - Math.random() * 0.12, life: 0, max: 380 + Math.random() * 200 });
    }
  }

  // ── picking & hover ──

  /** Front-most cell whose block silhouette contains the screen point. */
  pick(sx: number, sy: number): { x: number; y: number } | null {
    if (this.spin) return null;
    const p = this.root.toLocal({ x: sx, y: sy });
    const px = p.x, py = p.y - this.layers[this.active].y;
    let best: { x: number; y: number } | null = null;
    let bestZ = -1;
    const { w, h } = this.world;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [u, v] = this.rest(x, y);
        const cx = isoX(u, v);
        const dx = Math.abs(px - cx);
        if (dx > TW / 2 || u + v < bestZ) continue;
        const cell = this.world.get(this.active, x, y);
        const T = cell ? terrain(cell.t) : null;
        const lift = cell ? cell.h * HZ : 0;
        const cy = isoY(u, v);
        const half = (TH / 2) * (1 - dx / (TW / 2));
        const topEdge = cy - lift - half;
        const bottomEdge = T?.floating ? cy - lift + half + (T.puffy ? 0 : BASE) : cy + half;
        if (py >= topEdge && py <= bottomEdge) {
          bestZ = u + v;
          best = { x, y };
        }
      }
    }
    return best;
  }

  setHover(cells: { x: number; y: number }[], mode: HoverMode = 'paint') {
    const g = this.hover;
    g.clear();
    if (!cells.length) return;
    const color = HOVER_COLORS[mode];
    const lw = 2 / this.root.scale.x;
    for (const { x, y } of cells) {
      const cell = this.world.get(this.active, x, y);
      const [u, v] = this.rest(x, y);
      const cx = isoX(u, v), cy = isoY(u, v) - (cell ? cell.h * HZ : 0);
      g.poly([cx, cy - TH / 2, cx + TW / 2, cy, cx, cy + TH / 2, cx - TW / 2, cy]).fill({ color, alpha: 0.16 }).stroke({ width: lw, color, alpha: 0.95 });
    }
  }

  // ── camera ──

  fit() {
    const { w, h } = this.world;
    const minX = isoX(0, h - 1) - TW / 2, maxX = isoX(w - 1, 0) + TW / 2;
    const minY = -TH / 2 - MAX_H * HZ * 0.5, maxY = isoY(w - 1, h - 1) + TH / 2 + BASE + GAP;
    const sw = this.app.screen.width, sh = this.app.screen.height;
    const s = Math.min((sw * 0.86) / (maxX - minX), (sh * 0.78) / (maxY - minY));
    this.root.scale.set(s);
    this.root.x = sw / 2 - ((minX + maxX) / 2) * s;
    this.root.y = sh / 2 - ((minY + maxY) / 2) * s - sh * 0.02;
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const s0 = this.root.scale.x;
    const s1 = Math.max(0.2, Math.min(4, s0 * factor));
    const wx = (sx - this.root.x) / s0, wy = (sy - this.root.y) / s0;
    this.root.scale.set(s1);
    this.root.x = sx - wx * s1;
    this.root.y = sy - wy * s1;
  }

  panBy(dx: number, dy: number) {
    this.root.x += dx;
    this.root.y += dy;
  }

  // ── export ──

  async exportPNG(): Promise<Blob | null> {
    const lv = this.layers[this.active];
    const hadFilter = !!lv.container.filters;
    lv.container.filters = null;
    const art = this.app.renderer.extract.canvas({ target: lv.container, resolution: 2 }) as HTMLCanvasElement;
    lv.container.filters = hadFilter ? [lv.filter] : null;
    const out = makeCanvas(art.width + 80, art.height + 80);
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = new Color(this.skin.layerBg[this.active]).toHex();
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(art, 40, 40);
    return new Promise((res) => out.toBlob(res, 'image/png'));
  }
}
