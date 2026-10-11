import { BRIDGES, BRIDGE_LIST, bridgeCells, bridgeFits, bridgeLine } from './core/bridges';
import { buildBridge, eraseCell, floodFill, nudgeHeight, paintCell, placeProp, propPlacement, removeBridge, tidyProps } from './core/edit';
import { FOOT_STEPS, TILE_SIZES, footCells, footLabel, footXY, nextStep, occupant, propSize, type Foot } from './core/footprint';
import { clearLayer, generateLayer } from './core/generate';
import { History } from './core/history';
import { LAYER_IDS, type LayerId } from './core/layers';
import { nsId, packProps, packTerrains, type Pack } from './core/packs';
import { PROPS } from './core/props';
import { hashStr } from './core/rng';
import { terrain } from './core/terrains';
import { World } from './core/world';
import { PACKS, packById } from './packs';
import { MapView, type HoverMode } from './render/MapView';
import { SKINS, skinById } from './skins';
import { loadPainted, type PaintedSkin } from './skins/painted';
import type { Skin } from './skins/types';
import { Sound } from './ui/sound';

type Tool = 'paint' | 'fill' | 'raise' | 'lower' | 'prop' | 'bridge' | 'erase' | 'pan';
interface Pt {
  x: number;
  y: number;
}

const TOOLS: { id: Tool; icon: string; name: string; key: string }[] = [
  { id: 'paint', icon: '🖌️', name: 'Paint terrain', key: 'B' },
  { id: 'fill', icon: '🪣', name: 'Fill region', key: 'F' },
  { id: 'raise', icon: '⛰️', name: 'Raise ground', key: 'R' },
  { id: 'lower', icon: '🕳️', name: 'Lower ground', key: 'L' },
  { id: 'prop', icon: '🏰', name: 'Place things', key: 'P' },
  { id: 'bridge', icon: '🌉', name: 'Build a bridge: click where it starts, then where it ends', key: 'J' },
  { id: 'erase', icon: '🧽', name: 'Erase', key: 'E' },
  { id: 'pan', icon: '✋', name: 'Pan (or right-drag / hold Space)', key: 'H' },
];
const HOVER: Record<Tool, HoverMode> = { paint: 'paint', fill: 'paint', raise: 'raise', lower: 'lower', prop: 'prop', bridge: 'prop', erase: 'erase', pan: 'none' };

const SIZE = 32;
const PREFS_KEY = 'wmb.prefs.v1';
const saveKey = (pack: string) => (pack === 'classic' ? 'wmb.world.v1' : `wmb.world.v1.${pack}`);
const FOOT_KEY = (pack: string) => `wmb.foot.v1.${pack}`; // prop sizes tweaked in a build without the dev server

const fmtFoot = (f: Foot) => (Array.isArray(f) ? `${fmt(f[0])}×${fmt(f[1])}` : fmt(f));

/** ½×, 1½× … for tile sizes and prop sizes. */
function fmt(v: number) {
  const whole = Math.floor(v), frac = v - whole;
  const f = Math.abs(frac - 0.5) < 1e-6 ? '½' : Math.abs(frac - 0.25) < 1e-6 ? '¼' : Math.abs(frac - 0.75) < 1e-6 ? '¾' : '';
  return f ? `${whole || ''}${f}` : String(+v.toFixed(2));
}

const $ = (id: string) => document.getElementById(id)!;
const seed = () => (Math.random() * 2 ** 31) | 0;

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode etc.) — the app still works, it just won't remember */
  }
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Grid cells on the line from a to b (Bresenham), so fast drags don't leave gaps. */
function gridLine(a: Pt, b: Pt): Pt[] {
  const out: Pt[] = [];
  let { x, y } = a;
  const dx = Math.abs(b.x - x), dy = -Math.abs(b.y - y);
  const sx = x < b.x ? 1 : -1, sy = y < b.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push({ x, y });
    if (x === b.x && y === b.y) return out;
    const e2 = 2 * err;
    if (e2 >= dy) (err += dy), (x += sx);
    if (e2 <= dx) (err += dx), (y += sy);
  }
}

export class App {
  readonly world: World;
  readonly history: History;
  readonly view: MapView;
  readonly sound = new Sound();
  pack: Pack = PACKS[0];
  skin: Skin = SKINS[0];
  painted: PaintedSkin | null = null;
  tool: Tool = 'paint';
  brush = 1;
  layer: LayerId = 'surface';
  private terrainSel = new Map<string, string>(); // `${pack}|${layer}` → terrain id
  private propSel = new Map<string, string | null>();
  private prefSkin = '';
  private bridgeSel: string | null = 'wood';
  private bridgeFrom: Pt | null = null; // first click of a bridge, waiting for the second
  private tidied = 0; // props removed from older saves to make room for big footprints

  private stroke: { visited: Set<number>; last: Pt } | null = null;
  private panning: Pt | null = null;
  private spaceDown = false;
  private saveTimer = 0;
  private thumbs = new Map<string, HTMLCanvasElement>();

  constructor() {
    try {
      const prefs = JSON.parse(storageGet(PREFS_KEY) ?? '{}');
      if (prefs.pack) this.pack = packById(prefs.pack);
      if (prefs.skin) (this.prefSkin = prefs.skin), (this.skin = skinById(prefs.skin));
      if (prefs.sound === false) this.sound.enabled = false;
    } catch {
      /* ignore bad prefs */
    }
    for (const p of PACKS) this.applyLocalFeet(p);
    this.world = new World(SIZE, SIZE);
    this.loadPackWorld(this.world, this.pack);
    this.history = new History(this.world);
    this.view = new MapView(this.world);
  }

  /** Fills `into` with the pack's saved world, or a freshly generated one. */
  private loadPackWorld(into: World, pack: Pack) {
    const saved = storageGet(saveKey(pack.id));
    if (saved) {
      try {
        const w = World.fromJSON(JSON.parse(saved));
        if (w.w === into.w && w.h === into.h) {
          for (const id of LAYER_IDS) (into.layers[id] = w.layers[id]), (into.tile[id] = w.tile[id]);
          if (w.legacy) this.tidied += tidyProps(into);
          return;
        }
      } catch {
        /* fall through to a fresh world */
      }
    }
    for (const id of LAYER_IDS) {
      into.tile[id] = pack.layers[id].tile ?? 1;
      this.fillLayer(into, pack, id, true);
    }
  }

  private fillLayer(world: World, pack: Pack, id: LayerId, generate: boolean) {
    const L = pack.layers[id];
    if (generate && L.generator) generateLayer(world, id, seed(), L.generator, pack.generate[id]);
    else clearLayer(world, id, L);
  }

  async start() {
    this.painted = await loadPainted(this.pack, SKINS[0]);
    if (this.painted && (!this.prefSkin || this.prefSkin.startsWith('painted'))) this.skin = this.painted;
    document.body.dataset.theme = this.skin.theme;
    document.body.dataset.skin = this.skin.id;
    await this.view.init($('stage'), this.skin);
    this.view.rebuildLayer(this.layer, true);
    this.buildTools();
    this.buildPacks();
    this.buildLayers();
    this.buildSkins();
    this.buildPalette();
    this.bindTopbar();
    this.bindInput();
    this.refreshUndo();
    this.updateMute();
    this.world.onChange(() => this.scheduleSave());
    this.view.onTurned = () => this.buildSizer();
    // the size bar, status text and (on phones) side panels sit above the palette, however tall it gets
    const dock = () => document.body.style.setProperty('--dock', `${$('palette').offsetHeight}px`);
    new ResizeObserver(dock).observe($('palette'));
    dock();
    this.watchArt();
    this.toast('Drag to paint · right-drag to pan · scroll to zoom · 🎲 for a new layer', 5200);
    this.reportTidy();
  }

  // ── actions ──

  setTool(t: Tool) {
    this.tool = t;
    this.bridgeFrom = null;
    document.querySelectorAll<HTMLElement>('#tools [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    document.body.classList.toggle('can-grab', t === 'pan');
    this.buildPalette();
    this.view.setHover([]);
  }

  setBrush(n: number) {
    this.brush = Math.max(1, Math.min(3, n));
    document.querySelectorAll<HTMLElement>('#tools [data-brush]').forEach((b) => b.classList.toggle('active', Number(b.dataset.brush) === this.brush));
  }

  setLayer(id: LayerId) {
    if (id === this.layer) return;
    const up = LAYER_IDS.indexOf(id) < LAYER_IDS.indexOf(this.layer);
    this.layer = id;
    this.view.setActiveLayer(id);
    this.updateHud(null);
    this.sound.whoosh(up);
    document.querySelectorAll<HTMLElement>('#layers [data-layer]').forEach((b) => b.classList.toggle('active', b.dataset.layer === id));
    this.updateTileSize();
    const def = this.pack.layers[id];
    const banner = $('banner');
    banner.innerHTML = `<div class="big">${def.icon} ${def.name}</div><div class="small">${def.blurb}</div>`;
    banner.classList.remove('show');
    void banner.offsetWidth; // restart the animation
    banner.classList.add('show');
    this.buildPalette();
  }

  stepLayer(d: number) {
    const i = LAYER_IDS.indexOf(this.layer) + d;
    if (i >= 0 && i < LAYER_IDS.length) this.setLayer(LAYER_IDS[i]);
  }

  async setPack(pack: Pack) {
    if (pack.id === this.pack.id) return;
    storageSet(saveKey(this.pack.id), JSON.stringify(this.world.toJSON()));
    this.pack = pack;
    ($('pack') as HTMLSelectElement).value = pack.id;
    const next = new World(this.world.w, this.world.h);
    this.loadPackWorld(next, pack);
    for (const id of LAYER_IDS) {
      this.world.tile[id] = next.tile[id];
      this.view.batch(id, () => {
        for (let y = 0; y < next.h; y++) for (let x = 0; x < next.w; x++) this.world.set(id, x, y, next.get(id, x, y), false);
      }, id === this.layer);
    }
    this.history.clear();
    this.refreshUndo();
    this.painted = await loadPainted(pack, SKINS[0]);
    const wantPainted = this.painted && (this.skin.id.startsWith('painted') || !this.prefSkin);
    this.setSkin(wantPainted ? this.painted! : this.skin.id.startsWith('painted') ? SKINS[0] : this.skin, true);
    this.buildLayers();
    this.buildPalette();
    this.savePrefs();
    this.scheduleSave();
    this.toast(`${pack.name} — ${pack.subtitle}`);
    this.reportTidy();
  }

  /** Older saves had big things crammed onto single tiles; say so when some were cleared to make room. */
  private reportTidy() {
    if (!this.tidied) return;
    const n = this.tidied;
    this.tidied = 0;
    this.scheduleSave();
    setTimeout(() => this.toast(`Big things now take several tiles — cleared ${n} overlapping ${n === 1 ? 'prop' : 'props'} from your saved map (🎲 for a fresh one)`, 6000), 2600);
  }

  setSkin(skin: Skin, quiet = false) {
    this.skin = skin;
    this.thumbs.clear();
    this.view.setSkin(skin);
    if (!quiet) this.view.rebuildLayer(this.layer, true);
    document.body.dataset.theme = skin.theme;
    document.body.dataset.skin = skin.id;
    document.querySelectorAll<HTMLElement>('#skins [data-skin]').forEach((b) => b.classList.toggle('active', b.dataset.skin === skin.id));
    this.buildSkins();
    this.buildPalette();
    this.prefSkin = skin.id;
    this.savePrefs();
    if (quiet) return;
    this.sound.chime();
    this.toast(`${skin.name} — ${skin.blurb}`);
  }

  generate() {
    this.history.begin();
    this.view.batch(this.layer, () => this.fillLayer(this.world, this.pack, this.layer, true));
    this.history.commit();
    this.refreshUndo();
    this.sound.chime();
  }

  clear() {
    this.history.begin();
    this.view.batch(this.layer, () => this.fillLayer(this.world, this.pack, this.layer, false));
    this.history.commit();
    this.refreshUndo();
    this.sound.whoosh(false);
  }

  undo() {
    if (this.history.undo()) this.sound.click();
    this.refreshUndo();
  }

  redo() {
    if (this.history.redo()) this.sound.click();
    this.refreshUndo();
  }

  private selectIndex(i: number) {
    if (this.tool === 'bridge') {
      const items = [null, ...BRIDGE_LIST.map((b) => b.id)];
      if (i < items.length) this.bridgeSel = items[i];
    } else if (this.tool === 'prop') {
      const items = [null, ...packProps(this.pack, this.layer).map((p) => p.id)];
      if (i < items.length) this.propSel.set(this.selKey, items[i]);
    } else {
      const items = packTerrains(this.pack, this.layer);
      if (i < items.length) this.terrainSel.set(this.selKey, items[i].id);
      if (!['paint', 'fill'].includes(this.tool)) this.setTool('paint');
    }
    this.sound.click();
    this.buildPalette();
  }

  // ── editing ──

  private get selKey() {
    return `${this.pack.id}|${this.layer}`;
  }

  private get selTerrain(): string {
    return this.terrainSel.get(this.selKey) ?? packTerrains(this.pack, this.layer)[0]?.id ?? 'grass';
  }

  private get selProp(): string | null {
    const p = this.propSel.get(this.selKey);
    return p === undefined ? packProps(this.pack, this.layer)[0]?.id ?? null : p;
  }

  private brushCells(c: Pt): Pt[] {
    const r = this.tool === 'fill' ? 0 : this.brush - 1;
    const out: Pt[] = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (this.world.inBounds(c.x + dx, c.y + dy)) out.push({ x: c.x + dx, y: c.y + dy });
    return out;
  }

  private applyBrush(c: Pt) {
    const stroke = this.stroke!;
    const cells = this.brushCells(c);
    const { world, layer } = this;
    for (const p of cells) {
      const key = p.y * world.w + p.x;
      if (stroke.visited.has(key)) continue;
      stroke.visited.add(key);
      switch (this.tool) {
        case 'paint': {
          const id = this.selTerrain;
          if (paintCell(world, layer, p.x, p.y, id)) this.sound.place((hashStr(id) % 7) + p.x + p.y);
          break;
        }
        case 'raise':
          if (nudgeHeight(world, layer, p.x, p.y, 1, stroke.visited)) this.sound.raise();
          break;
        case 'lower':
          if (nudgeHeight(world, layer, p.x, p.y, -1, stroke.visited)) this.sound.lower();
          break;
        case 'erase':
          if (eraseCell(world, layer, p.x, p.y)) this.sound.erase();
          break;
        case 'prop': {
          // a big brush scatters instead of carpeting, and never knocks down what's already there
          const scatter = cells.length > 1;
          if (scatter && Math.random() > 0.3) continue;
          if (placeProp(world, layer, p.x, p.y, this.selProp, !scatter)) this.sound.prop();
          break;
        }
      }
    }
  }

  private cancelBridge() {
    if (!this.bridgeFrom) return;
    this.bridgeFrom = null;
    this.view.setHover([]);
    this.sound.click();
  }

  /** First click marks where a bridge starts; the second lays it (or removes one, with Remove selected). */
  private bridgeClick(c: Pt) {
    const { world, layer } = this;
    if (!this.bridgeSel) {
      this.history.begin();
      if (removeBridge(world, layer, c.x, c.y)) this.sound.erase();
      this.history.commit();
      this.refreshUndo();
      return;
    }
    if (!this.bridgeFrom) {
      this.bridgeFrom = c;
      this.sound.click();
      this.hoverAt(c);
      this.toast(`${BRIDGES[this.bridgeSel].name}: now click where it ends (Esc to cancel)`);
      return;
    }
    const from = this.bridgeFrom;
    if (from.x === c.x && from.y === c.y) return;
    this.bridgeFrom = null;
    this.history.begin();
    const built = buildBridge(world, layer, from, c, this.bridgeSel);
    this.history.commit();
    this.refreshUndo();
    if (built) this.sound.chime();
    else this.toast('A bridge needs ground (or water) under every cell of it');
    this.hoverAt(c);
  }

  /** Shows what the current tool would touch: big props show their whole footprint (red if it won't fit). */
  private hoverAt(c: Pt | null) {
    if (!c || this.tool === 'pan') return this.view.setHover([]);
    if (this.tool === 'bridge') {
      if (!this.bridgeSel) {
        const span = bridgeCells(this.world, this.layer, c.x, c.y);
        return this.view.setHover(span.length ? span : [c], 'erase');
      }
      if (!this.bridgeFrom) return this.view.setHover([c], 'prop');
      const { cells } = bridgeLine(this.bridgeFrom, c);
      return this.view.setHover(cells, bridgeFits(this.world, this.layer, cells) ? 'prop' : 'blocked');
    }
    const pId = this.selProp;
    if (this.tool === 'prop' && this.brush === 1) {
      if (!pId) {
        const o = occupant(this.world, this.layer, c.x, c.y);
        return this.view.setHover(o ? footCells(o.x, o.y, o.nx, o.ny) : [c], 'erase');
      }
      const pl = propPlacement(this.world, this.layer, c.x, c.y, pId);
      return this.view.setHover(pl.cells, pl.fits ? 'prop' : 'blocked');
    }
    this.view.setHover(this.brushCells(c), HOVER[this.tool]);
  }

  // ── view & sizes ──

  rotate(dir: 1 | -1) {
    this.view.rotate(dir);
    this.sound.whoosh(dir < 0);
    const el = document.querySelector<HTMLElement>('#viewctl .compass');
    if (el) {
      this.turns += dir;
      el.style.transform = `rotate(${this.turns * 90}deg)`;
    }
  }
  private turns = 0;

  setTileSize(v: number) {
    if (v === this.world.tile[this.layer]) return;
    this.world.tile[this.layer] = v;
    this.view.setHover([]);
    this.view.rebuildLayer(this.layer, true);
    this.updateTileSize();
    this.buildPalette();
    this.scheduleSave();
    this.sound.chime();
    this.toast(v > 1 ? `Tile size ${fmt(v)}× — more world per tile, so big things take fewer cells` : v < 1 ? `Tile size ${fmt(v)}× — zoomed-in world, big things spread over more cells` : 'Tile size 1× — the pack’s own scale');
  }

  private updateTileSize() {
    const v = this.world.tile[this.layer];
    const el = document.querySelector('#layers .tilesize b');
    if (el) el.textContent = `${fmt(v)}×`;
    document.querySelectorAll<HTMLButtonElement>('#layers .tilesize button').forEach((b) => {
      b.disabled = Number(b.dataset.d) < 0 ? v <= TILE_SIZES[0] : v >= TILE_SIZES[TILE_SIZES.length - 1];
    });
  }

  /** Re-sizes a prop for its pack (saved into the pack file when running the dev server) and redraws. */
  async setFoot(pId: string, foot: Foot) {
    const P = PROPS[pId];
    if (!P || JSON.stringify(P.foot ?? 1) === JSON.stringify(foot)) return;
    P.foot = foot;
    for (const id of LAYER_IDS) this.view.rebuildLayer(id, false);
    this.thumbs.clear();
    this.buildPalette();
    this.sound.click();
    const { nx, ny } = propSize(P, this.world.tile[this.layer]);
    let saved = false;
    if (P.pack && P.art) {
      try {
        const r = await fetch('/__wmb/foot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pack: P.pack, id: P.art, foot }) });
        saved = r.ok;
      } catch {
        /* no dev server: remember it locally instead */
      }
    }
    if (!saved) {
      const key = FOOT_KEY(P.pack ?? 'classic');
      const all = JSON.parse(storageGet(key) ?? '{}');
      all[P.art ?? P.id] = foot;
      storageSet(key, JSON.stringify(all));
    }
    this.toast(`${P.name}: size ${fmtFoot(foot)} → ${footLabel(nx, ny)} ${nx * ny > 1 ? 'tiles' : 'tile'} here${saved ? ' · saved to pack' : ''}`);
  }

  private applyLocalFeet(pack: Pack) {
    try {
      const all = JSON.parse(storageGet(FOOT_KEY(pack.id)) ?? '{}');
      for (const [id, foot] of Object.entries(all)) {
        const P = PROPS[pack.id === 'classic' ? id : nsId(pack.id, id)];
        if (P && (typeof foot === 'number' || (Array.isArray(foot) && foot.length === 2))) P.foot = foot as Foot;
      }
    } catch {
      /* ignore */
    }
  }

  // ── input ──

  private bindInput() {
    const cv = this.view.app.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      this.sound.unlock();
      cv.setPointerCapture(e.pointerId);
      if (e.button === 2 && this.bridgeFrom) return this.cancelBridge();
      if (e.button === 1 || e.button === 2 || this.tool === 'pan' || this.spaceDown) {
        this.panning = { x: e.clientX, y: e.clientY };
        document.body.classList.add('grabbing');
        return;
      }
      if (e.button !== 0) return;
      const c = this.view.pick(e.offsetX, e.offsetY);
      if (!c) return;
      if (this.tool === 'bridge') return this.bridgeClick(c);
      this.history.begin();
      if (this.tool === 'fill') {
        if (floodFill(this.world, this.layer, c.x, c.y, this.selTerrain)) this.sound.chime();
        this.history.commit();
        this.refreshUndo();
        return;
      }
      this.stroke = { visited: new Set(), last: c };
      this.applyBrush(c);
    });
    cv.addEventListener('pointermove', (e) => {
      if (this.panning) {
        this.view.panBy(e.clientX - this.panning.x, e.clientY - this.panning.y);
        this.panning = { x: e.clientX, y: e.clientY };
        return;
      }
      const c = this.view.pick(e.offsetX, e.offsetY);
      this.hoverAt(c);
      this.updateHud(c);
      if (this.stroke && c && (c.x !== this.stroke.last.x || c.y !== this.stroke.last.y)) {
        for (const p of gridLine(this.stroke.last, c).slice(1)) this.applyBrush(p);
        this.stroke.last = c;
      }
    });
    const end = (e: PointerEvent) => {
      // dragging from one bank to the other builds the bridge on release
      if (this.tool === 'bridge' && this.bridgeFrom && e.type === 'pointerup' && !this.panning) {
        const c = this.view.pick(e.offsetX, e.offsetY);
        if (c && (c.x !== this.bridgeFrom.x || c.y !== this.bridgeFrom.y)) this.bridgeClick(c);
      }
      if (this.stroke) {
        this.history.commit();
        this.stroke = null;
        this.refreshUndo();
      }
      this.panning = null;
      document.body.classList.remove('grabbing');
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => {
      if (!this.stroke) this.view.setHover([]);
      this.updateHud(null);
    });
    cv.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.view.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        document.body.classList.toggle('can-grab', this.tool === 'pan');
      }
    });
  }

  private onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && k === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod || e.altKey) return;
    if (e.code === 'Space') {
      e.preventDefault();
      this.spaceDown = true;
      document.body.classList.add('can-grab');
      return;
    }
    const tool = TOOLS.find((t) => t.key.toLowerCase() === k);
    if (tool) return this.setTool(tool.id);
    if (/^[0-9]$/.test(k)) return this.selectIndex(k === '0' ? 9 : Number(k) - 1);
    switch (e.key) {
      case '[':
        return this.setBrush(this.brush - 1);
      case ']':
        return this.setBrush(this.brush + 1);
      case 'PageUp':
      case 'w':
      case 'W':
        return this.stepLayer(-1);
      case 'PageDown':
      case 's':
      case 'S':
        return this.stepLayer(1);
      case 'g':
      case 'G':
        return this.generate();
      case 'm':
      case 'M':
        return this.toggleMute();
      case 'Home':
      case '.':
        return this.view.fit();
      case 'Escape':
        return this.cancelBridge();
      case 'q':
        return this.rotate(1);
      case 'Q':
        return this.rotate(-1);
    }
  }

  // ── UI ──

  private buildTools() {
    const el = $('tools');
    el.innerHTML = '';
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.dataset.tool = t.id;
      b.title = `${t.name} (${t.key})`;
      b.innerHTML = `<span class="ico">${t.icon}</span><kbd>${t.key}</kbd>`;
      b.classList.toggle('active', t.id === this.tool);
      b.onclick = () => (this.sound.click(), this.setTool(t.id));
      el.appendChild(b);
    }
    const sep = document.createElement('div');
    sep.className = 'sep';
    el.appendChild(sep);
    for (const n of [1, 2, 3]) {
      const b = document.createElement('button');
      b.dataset.brush = String(n);
      b.title = `Brush ${n * 2 - 1}×${n * 2 - 1}  ([ / ])`;
      b.innerHTML = `<span class="brush" style="--s:${4 + n * 4}px"></span>`;
      b.classList.toggle('active', n === this.brush);
      b.onclick = () => (this.sound.click(), this.setBrush(n));
      el.appendChild(b);
    }
  }

  private buildPacks() {
    const sel = $('pack') as HTMLSelectElement;
    sel.innerHTML = PACKS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    sel.value = this.pack.id;
    sel.onchange = () => void this.setPack(packById(sel.value));
  }

  private buildLayers() {
    const el = $('layers');
    el.innerHTML = '<div class="title">Layers <kbd>W</kbd><kbd>S</kbd></div>';
    for (const id of LAYER_IDS) {
      const l = this.pack.layers[id];
      const b = document.createElement('button');
      b.dataset.layer = l.id;
      b.innerHTML = `<span class="ico">${l.icon}</span><span class="txt"><b>${l.name}</b><small>${l.blurb}</small></span>`;
      b.classList.toggle('active', l.id === this.layer);
      b.onclick = () => this.setLayer(l.id);
      el.appendChild(b);
    }
    const ts = document.createElement('div');
    ts.className = 'tilesize';
    ts.title = 'Tile size: how much world one tile holds on this layer. Bigger tiles make big things take fewer cells.';
    ts.innerHTML = '<span>Tile size</span><button data-d="-1">−</button><b></b><button data-d="1">+</button>';
    ts.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => this.setTileSize(nextStep(TILE_SIZES, this.world.tile[this.layer], Number(b.dataset.d)));
    });
    el.appendChild(ts);
    this.updateTileSize();
  }

  private buildSkins() {
    const el = $('skins');
    el.innerHTML = '';
    for (const s of this.painted ? [this.painted, ...SKINS] : SKINS) {
      const b = document.createElement('button');
      b.dataset.skin = s.id;
      b.className = 'skin';
      b.title = s.blurb;
      b.textContent = s.name;
      b.classList.toggle('active', s.id === this.skin.id);
      b.onclick = () => s.id !== this.skin.id && this.setSkin(s);
      el.appendChild(b);
    }
  }

  private thumb(kind: 'terrain' | 'prop' | 'bridge', id: string) {
    const key = `${kind}|${id}`;
    let c = this.thumbs.get(key);
    if (!c) this.thumbs.set(key, (c = this.view.thumb(kind, id)));
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    copy.getContext('2d')!.drawImage(c, 0, 0);
    return copy;
  }

  private buildPalette() {
    const el = $('palette');
    const scrolled = el.scrollTop;
    el.innerHTML = '';
    const props = this.tool === 'prop', bridges = this.tool === 'bridge';
    const items: { id: string | null; name: string }[] = bridges
      ? [{ id: null, name: 'Remove a bridge' }, ...BRIDGE_LIST]
      : props
        ? [{ id: null, name: 'Remove' }, ...packProps(this.pack, this.layer)]
        : packTerrains(this.pack, this.layer);
    const sel = bridges ? this.bridgeSel : props ? this.selProp : this.selTerrain;
    const tile = this.world.tile[this.layer];
    items.forEach((it, i) => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.title = it.name;
      b.classList.toggle('active', it.id === sel);
      if (it.id) b.appendChild(this.thumb(bridges ? 'bridge' : props ? 'prop' : 'terrain', it.id));
      else b.insertAdjacentHTML('beforeend', '<div class="none">🚫</div>');
      b.insertAdjacentHTML('beforeend', `<span class="name">${it.name}</span>${i < 10 ? `<kbd>${(i + 1) % 10}</kbd>` : ''}`);
      if (props && it.id) {
        const { nx, ny } = propSize(PROPS[it.id], tile);
        if (nx * ny > 1) b.insertAdjacentHTML('beforeend', `<span class="foot">${footLabel(nx, ny)}</span>`);
      }
      b.onclick = () => this.selectIndex(i);
      el.appendChild(b);
    });
    // keep the scroll position across rebuilds, but always show the selected item
    const first = el.querySelector<HTMLElement>('.swatch');
    if (first) el.style.setProperty('--row', `${first.offsetHeight}px`);
    el.scrollTop = scrolled;
    el.querySelector<HTMLElement>('.swatch.active')?.scrollIntoView({ block: 'nearest' });
    this.buildSizer();
  }

  /**
   * The selected prop's size: − / + step its size in tiles (the footprint follows from the layer's tile
   * size), and the shape button cycles square → long one way → long the other way (as seen right now).
   */
  private buildSizer() {
    const el = $('sizer');
    const pId = this.tool === 'prop' ? this.selProp : null;
    const P = pId ? PROPS[pId] : null;
    el.classList.toggle('show', !!P);
    if (!P) return;
    const [a, b] = footXY(P.foot);
    const long = Math.max(a, b);
    const { nx, ny, w } = propSize(P, this.world.tile[this.layer]);
    // on screen, x runs down-right in the even views and down-left in the odd ones
    const odd = this.view.rot % 2 === 1;
    const [cols, rows] = odd ? [ny, nx] : [nx, ny];
    const grid = Array.from({ length: nx * ny }, () => '<i></i>').join('');
    const shape = a === b ? 'square' : (a > b) !== odd ? 'long ↘' : 'long ↙';
    el.innerHTML =
      `<span class="what">${P.name}</span>` +
      `<span class="grid" style="--c:${cols};--r:${rows}">${grid}</span>` +
      `<span class="fp">${footLabel(nx, ny)} ${nx * ny > 1 ? 'tiles' : w < 0.95 ? 'tile · drawn small' : 'tile'}</span>` +
      `<button class="shape" title="Footprint shape: square, long ↘ or long ↙ (as the map faces now)">${shape}</button>` +
      `<span class="ctl"><button data-d="-1" title="Smaller">−</button><b title="Size in tiles at tile size 1×">${fmtFoot(P.foot ?? 1)}</b><button data-d="1" title="Bigger">+</button></span>`;
    el.querySelectorAll<HTMLButtonElement>('.ctl button').forEach((btn) => {
      btn.onclick = () => {
        const s = nextStep(FOOT_STEPS, long, Number(btn.dataset.d));
        void this.setFoot(P.id, a === b ? s : [(a / long) * s, (b / long) * s]);
      };
    });
    el.querySelector<HTMLButtonElement>('.shape')!.onclick = () => {
      // square → long ↘ → long ↙ → square, with the short side half the long one
      const half = Math.max(0.25, long / 2);
      const alongX: Foot = [long, half], alongY: Foot = [half, long];
      const next = shape === 'square' ? (odd ? alongY : alongX) : shape === 'long ↘' ? (odd ? alongX : alongY) : long;
      void this.setFoot(P.id, next);
    };
  }

  private bindTopbar() {
    $('undo').onclick = () => this.undo();
    $('redo').onclick = () => this.redo();
    $('gen').onclick = () => (this.sound.unlock(), this.generate());
    $('clear').onclick = () => this.clear();
    $('mute').onclick = () => (this.sound.unlock(), this.toggleMute());
    $('rotl').onclick = () => (this.sound.unlock(), this.rotate(-1));
    $('rotr').onclick = () => (this.sound.unlock(), this.rotate(1));
    $('save').onclick = () => {
      download(new Blob([JSON.stringify(this.world.toJSON())], { type: 'application/json' }), 'my-world.json');
      this.toast('World downloaded 💾');
    };
    $('png').onclick = async () => {
      const blob = await this.view.exportPNG();
      if (blob) download(blob, `world-${this.layer}.png`);
      this.toast('Layer exported 🖼️');
    };
    const file = $('file') as HTMLInputElement;
    $('load').onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      try {
        const text = await f.text();
        const loaded = World.fromJSON(JSON.parse(text));
        if (loaded.legacy) this.tidied += tidyProps(loaded);
        if (loaded.w !== this.world.w || loaded.h !== this.world.h) {
          storageSet(saveKey(this.pack.id), text);
          location.reload();
          return;
        }
        for (const id of LAYER_IDS) {
          this.world.tile[id] = loaded.tile[id];
          this.view.batch(id, () => {
            for (let y = 0; y < loaded.h; y++) for (let x = 0; x < loaded.w; x++) this.world.set(id, x, y, loaded.get(id, x, y), false);
          }, id === this.layer);
        }
        this.buildLayers();
        this.buildPalette();
        this.history.clear();
        this.refreshUndo();
        this.toast(`Opened ${f.name}`);
        this.reportTidy();
      } catch {
        this.toast("That file doesn't look like a world 🤔");
      }
    };
  }

  private updateHud(c: Pt | null) {
    const el = $('hud');
    const cell = c && this.world.get(this.layer, c.x, c.y);
    if (!c) return void (el.textContent = '');
    if (!cell) return void (el.textContent = `Empty · ${c.x}, ${c.y}`);
    const parts = [terrain(cell.t).name, `height ${cell.h}`];
    if (cell.b) parts.push(`${BRIDGES[cell.b.k]?.name ?? 'Bridge'} (deck ${cell.b.h})`);
    const occ = occupant(this.world, this.layer, c.x, c.y);
    if (occ) parts.push(`${PROPS[occ.p]?.name ?? occ.p}${occ.nx * occ.ny > 1 ? ` (${footLabel(occ.nx, occ.ny)})` : ''}`);
    el.textContent = `${parts.join(' · ')} · ${c.x}, ${c.y}`;
  }

  private refreshUndo() {
    ($('undo') as HTMLButtonElement).disabled = !this.history.canUndo;
    ($('redo') as HTMLButtonElement).disabled = !this.history.canRedo;
  }

  private toggleMute() {
    this.sound.enabled = !this.sound.enabled;
    this.updateMute();
    this.savePrefs();
    this.sound.click();
  }

  private updateMute() {
    $('mute').textContent = this.sound.enabled ? '🔊' : '🔇';
  }

  private savePrefs() {
    storageSet(PREFS_KEY, JSON.stringify({ pack: this.pack.id, skin: this.skin.id, sound: this.sound.enabled }));
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    const key = saveKey(this.pack.id);
    this.saveTimer = window.setTimeout(() => storageSet(key, JSON.stringify(this.world.toJSON())), 700);
  }

  /** Hot-swap new forge output: poll the pack's manifest and reload the painted skin when it changes. */
  private artStamp = '';
  private watchArt() {
    setInterval(async () => {
      try {
        const pack = this.pack;
        const r = await fetch(`/packs/${pack.id}/assets.json`, { cache: 'no-store' });
        if (!r.ok) return;
        const stamp = `${pack.id}|${await r.text()}`;
        if (stamp === this.artStamp) return;
        const first = !this.artStamp || !this.artStamp.startsWith(pack.id + '|');
        this.artStamp = stamp;
        if (first && this.painted) return; // nothing new; but if the art wasn't there at load, pick it up now
        const painted = await loadPainted(pack, SKINS[0]);
        if (!painted || pack !== this.pack) return;
        const usePainted = !this.painted || this.skin.id.startsWith('painted');
        this.painted = painted;
        if (usePainted) this.setSkin(painted, true);
        else this.buildSkins();
      } catch {
        /* dev convenience only */
      }
    }, 6000);
  }

  private toastTimer = 0;
  toast(msg: string, ms = 2200) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
  }
}
