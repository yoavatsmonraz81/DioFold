import { anchorFor, footCells, propSize } from './footprint';
import type { LayerId } from './layers';
import type { GenKind, GenMapping, PackLayer } from './packs';
import { PROPS, propFits } from './props';
import { fbm, hash2, makeNoise, mulberry32 } from './rng';
import { terrain } from './terrains';
import type { Cell, World } from './world';

type Put = (x: number, y: number, cell: Cell | null) => void;

/**
 * Runs a generator into a layer. Generators speak in built-in terrain/prop ids; a pack's
 * mapping translates them (unmapped props are dropped so themed packs stay on-theme).
 */
export function generateLayer(world: World, layer: LayerId, seed: number, kind: GenKind = layer, map?: GenMapping) {
  const { w, h } = world;
  const cells: (Cell | null)[] = new Array(w * h).fill(null);
  const put: Put = (x, y, c) => {
    if (c && map) {
      const t = map.terrains[c.t] || c.t;
      const m = c.p ? map.props[c.p] : undefined;
      const p = Array.isArray(m) ? m[hash2(x, y, seed) % m.length] : m;
      c = p ? { t, h: c.h, p } : { t, h: c.h };
    }
    cells[y * w + x] = c ? { ...c } : null;
  };
  const gens: Record<GenKind, (w: number, h: number, seed: number, put: Put) => void> = { sky, surface, underground, deep, city, hive };
  gens[kind](w, h, seed, put);
  settleProps(cells, w, h, world.tile[layer], seed);
  cells.forEach((c, i) => world.set(layer, i % w, Math.floor(i / w), c));
}

/**
 * Generators place props one per cell; big ones need their whole footprint. Biggest first, each prop
 * claims and levels its cells or is dropped. Repeats of a big prop are thinned so they don't carpet the map.
 */
function settleProps(cells: (Cell | null)[], w: number, h: number, tile: number, seed: number) {
  const rnd = mulberry32(seed ^ 0x2545f491);
  const cand: { x: number; y: number; p: string; nx: number; ny: number; n: number; r: number }[] = [];
  cells.forEach((c, i) => {
    if (!c?.p) return;
    const P = PROPS[c.p];
    if (P) {
      const { nx, ny } = propSize(P, tile);
      cand.push({ x: i % w, y: Math.floor(i / w), p: c.p, nx, ny, n: nx * ny, r: rnd() });
    }
    delete c.p;
  });
  cand.sort((a, b) => b.n - a.n || a.r - b.r);
  const taken = new Uint8Array(w * h);
  const placed = new Set<string>();
  for (const k of cand) {
    if (k.n > 1 && placed.has(k.p) && rnd() > 1 / Math.sqrt(k.n)) continue;
    const P = PROPS[k.p];
    const free = (c: { x: number; y: number }) => {
      const cell = cells[c.y * w + c.x];
      return !taken[c.y * w + c.x] && !!cell && propFits(P, terrain(cell.t));
    };
    // centred on the spot if possible, otherwise any footprint position that still covers it
    const c0 = anchorFor(w, h, k.x, k.y, k.nx, k.ny);
    const tries = [c0];
    for (let j = 0; j < k.ny; j++) for (let i = 0; i < k.nx; i++) if (k.x + i < w && k.y + j < h && k.x + i >= k.nx - 1 && k.y + j >= k.ny - 1) tries.push({ x: k.x + i, y: k.y + j });
    const a = tries.find((t) => footCells(t.x, t.y, k.nx, k.ny).every(free));
    if (!a) continue;
    const fc = footCells(a.x, a.y, k.nx, k.ny);
    const level = cells[k.y * w + k.x]!.h;
    for (const c of fc) {
      taken[c.y * w + c.x] = 1;
      const cell = cells[c.y * w + c.x]!;
      if (k.n > 1 && !P.flies && terrain(cell.t).fixedH === undefined) cell.h = level;
    }
    cells[a.y * w + a.x]!.p = k.p;
    placed.add(k.p);
  }
}

/** A blank canvas for the layer, as the pack defines it. */
export function clearLayer(world: World, layer: LayerId, def: PackLayer) {
  for (let y = 0; y < world.h; y++) for (let x = 0; x < world.w; x++) world.set(layer, x, y, def.blank);
}

function surface(w: number, h: number, seed: number, put: Put) {
  const elev = makeNoise(seed), moist = makeNoise(seed ^ 0x5bd1e995), rnd = mulberry32(seed);
  const cells: (Cell | null)[] = [];
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? cells[y * w + x] : null);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = ((x + 0.5) / w) * 2 - 1, ny = ((y + 0.5) / h) * 2 - 1;
      const d = Math.min(1, Math.hypot(nx, ny));
      const e = 0.6 * fbm(elev, x / 8, y / 8) + 0.5 * (1 - Math.pow(d, 2.2)) - 0.07;
      const m = fbm(moist, x / 6 + 40, y / 6 + 40);
      let c: Cell;
      if (e < 0.36) c = { t: 'water', h: 0 };
      else if (e < 0.42) c = { t: 'shallows', h: 0 };
      else if (e < 0.47) c = { t: 'sand', h: 1 };
      else {
        const hh = Math.min(6, 1 + Math.floor(Math.pow((e - 0.47) / 0.36, 1.3) * 6));
        if (e > 0.8) c = { t: 'snow', h: hh };
        else if (e > 0.69) c = { t: 'rock', h: Math.max(2, hh) };
        else if (m > 0.6) c = { t: 'forest', h: hh };
        else if (m < 0.27 && e < 0.62) c = { t: 'desert', h: hh };
        else if (m > 0.56 && e < 0.53) c = { t: 'swamp', h: hh };
        else c = { t: 'grass', h: hh };
      }
      cells.push(c);
    }
  }

  // sprinkle props
  let castle = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = cells[y * w + x]!;
      const r = rnd();
      const nearWater = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => at(x + dx, y + dy)?.t === 'water' || at(x + dx, y + dy)?.t === 'shallows');
      // grazer / prowler / arctic are wildlife slots: packs map them onto their animals (none built in)
      if (c.t === 'grass') {
        if (!castle && c.h >= 2 && r < 0.03) (c.p = 'castle'), (castle = true);
        else if (r < 0.07) c.p = 'tree';
        else if (r < 0.085) c.p = 'house';
        else if (r < 0.09) c.p = 'tower';
        else if (r < 0.095) c.p = 'ruins';
        else if (r < 0.115) c.p = 'grazer';
      } else if (c.t === 'forest' && r < 0.025) c.p = 'prowler';
      else if (c.t === 'sand' && nearWater && r < 0.12) c.p = 'palm';
      else if (c.t === 'sand' && nearWater && r < 0.14) c.p = 'shore'; // wildlife slot: something basking by the water
      else if (c.t === 'desert' && r < 0.08) c.p = 'cactus';
      else if (c.t === 'snow' && r < 0.05) c.p = 'arctic';
      else if (c.t === 'rock' && r < 0.015) c.p = 'flyer'; // something soaring over the mountains
      else if ((c.t === 'rock' || c.t === 'snow') && r < 0.1) c.p = c.t === 'rock' && r < 0.04 ? 'boulder' : 'pine';
      else if (c.t === 'water' && !nearWater && r < 0.008) c.p = 'boat';
      else if (c.t === 'swamp' && r < 0.06) c.p = 'mushroom';
    }
  }
  cells.forEach((c, i) => put(i % w, Math.floor(i / w), c));
}

/** Cellular-automaton caves: true = solid. */
function caves(w: number, h: number, rnd: () => number, fill: number): boolean[] {
  let solid = Array.from({ length: w * h }, () => rnd() < fill);
  for (let it = 0; it < 5; it++) {
    solid = solid.map((_, i) => {
      const x = i % w, y = Math.floor(i / w);
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || solid[yy * w + xx]) n++;
        }
      return n >= 5;
    });
  }
  return solid;
}

function underground(w: number, h: number, seed: number, put: Put) {
  const rnd = mulberry32(seed), n1 = makeNoise(seed + 1), n2 = makeNoise(seed + 2);
  const solid = caves(w, h, rnd, 0.46);
  // two mine tracks punched straight through
  const track = new Set<number>();
  for (let k = 0; k < 2; k++) {
    if (k === 0) { const y = 4 + Math.floor(rnd() * (h - 8)); for (let x = 2; x < w - 2; x++) track.add(y * w + x); }
    else { const x = 4 + Math.floor(rnd() * (w - 8)); for (let y = 2; y < h - 2; y++) track.add(y * w + x); }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, r = rnd();
      const a = fbm(n1, x / 6, y / 6), b = fbm(n2, x / 5, y / 5);
      let c: Cell;
      if (track.has(i)) c = { t: 'tunnel', h: 0, ...(r < 0.08 ? { p: 'torch' } : {}) };
      else if (solid[i]) c = { t: 'wall', h: a > 0.62 ? 3 : 2 };
      else if (a > 0.66) c = { t: 'cavelake', h: 0, ...(r < 0.03 ? { p: 'boat' } : {}) };
      else if (b > 0.64) c = { t: 'mushroom', h: 0, ...(r < 0.12 ? { p: 'mushroom' } : {}) };
      else if (b < 0.3) c = { t: 'crystal', h: 0, ...(r < 0.1 ? { p: 'crystals' } : {}) };
      else c = { t: 'cavefloor', h: 0, ...(r < 0.02 ? { p: 'chest' } : r < 0.05 ? { p: 'boulder' } : r < 0.06 ? { p: 'campfire' } : {}) };
      put(x, y, c);
    }
  }
}

function deep(w: number, h: number, seed: number, put: Put) {
  const rnd = mulberry32(seed), n1 = makeNoise(seed + 3), n2 = makeNoise(seed + 4);
  const solid = caves(w, h, rnd, 0.5);
  const ruins: [number, number, number, number][] = [];
  for (let k = 0; k < 2; k++) {
    const rw = 4 + Math.floor(rnd() * 3), rh = 4 + Math.floor(rnd() * 3);
    ruins.push([2 + Math.floor(rnd() * (w - rw - 4)), 2 + Math.floor(rnd() * (h - rh - 4)), rw, rh]);
  }
  const inRuins = (x: number, y: number) => ruins.some(([rx, ry, rw, rh]) => x >= rx && y >= ry && x < rx + rw && y < ry + rh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = rnd(), a = fbm(n1, x / 6, y / 6), b = fbm(n2, x / 4, y / 4);
      let c: Cell;
      if (inRuins(x, y)) c = { t: 'ruins', h: 0, ...(r < 0.15 ? { p: 'ruins' } : r < 0.2 ? { p: 'chest' } : r < 0.26 ? { p: 'torch' } : {}) };
      else if (solid[y * w + x]) c = { t: 'basalt', h: a > 0.6 ? 3 : 2 };
      else if (a > 0.58) c = { t: 'lava', h: 0 };
      else if (b > 0.74) c = { t: 'abyss', h: 0 };
      else if (b < 0.28) c = { t: 'crystal', h: 0, ...(r < 0.12 ? { p: 'crystals' } : {}) };
      else c = { t: 'cavefloor', h: 0, ...(r < 0.03 ? { p: 'boulder' } : {}) };
      put(x, y, c);
    }
  }
}

function sky(w: number, h: number, seed: number, put: Put) {
  const rnd = mulberry32(seed), n1 = makeNoise(seed + 5), n2 = makeNoise(seed + 6);
  const isles: [number, number, number][] = [];
  const count = 2 + Math.floor(rnd() * 2);
  for (let k = 0; k < count; k++) isles.push([4 + rnd() * (w - 8), 4 + rnd() * (h - 8), 2 + rnd() * 2.5]);
  const housed = new Set<number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = rnd(), a = fbm(n1, x / 5, y / 5), b = fbm(n2, x / 7, y / 7);
      const isle = isles.findIndex(([ix, iy, ir]) => Math.hypot(x - ix, y - iy) < ir + (a - 0.5) * 2);
      let c: Cell | null = null;
      if (isle >= 0) {
        c = { t: 'isle', h: 2 + (isle % 2) };
        if (!housed.has(isle) && r < 0.25) (c.p = isle === 0 ? 'castle' : 'house'), housed.add(isle);
        else if (r < 0.3) c.p = r < 0.15 ? 'tree' : 'pine';
      } else if (a > 0.66) {
        c = { t: b > 0.62 ? 'storm' : 'cloud', h: b > 0.62 ? 2 : 1 };
        // packs can map these onto things that fly over the clouds (no built-in prop answers to them)
        if (r < 0.012) c.p = 'giant';
        else if (r < 0.05) c.p = 'flyer';
      }
      put(x, y, c);
    }
  }
}

/** Modern city: a jittered street grid, downtown towers, residential blocks, parks and a river. */
function city(w: number, h: number, seed: number, put: Put) {
  const rnd = mulberry32(seed), n1 = makeNoise(seed + 7);
  const lines = (n: number) => {
    const out = new Set<number>();
    for (let v = 1 + Math.floor(rnd() * 3); v < n - 1; v += 4 + Math.floor(rnd() * 3)) out.add(v);
    return out;
  };
  const roadX = lines(w), roadY = lines(h);
  const riverAt = (x: number) => h * 0.68 + Math.sin(x / 5 + rnd() * 0.01) * 2.5;
  const cx = w / 2, cy = h * 0.4;
  const blockKind = new Map<string, 'park' | 'plaza' | 'downtown' | 'residential'>();
  const kindOf = (x: number, y: number) => {
    let bx = 0, by = 0;
    for (const v of roadX) if (v < x) bx++;
    for (const v of roadY) if (v < y) by++;
    const key = `${bx},${by}`;
    if (!blockKind.has(key)) {
      const d = Math.hypot(x - cx, y - cy) / Math.max(w, h);
      const r = rnd();
      blockKind.set(key, r < 0.14 ? 'park' : r < 0.22 ? 'plaza' : d < 0.22 + rnd() * 0.1 ? 'downtown' : 'residential');
    }
    return blockKind.get(key)!;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = rnd();
      const isRoad = roadX.has(x) || roadY.has(y);
      const river = Math.abs(y - riverAt(x)) < 1.3;
      let c: Cell;
      if (isRoad) c = { t: 'road', h: 1, ...(r < 0.12 && !river ? { p: 'car' } : {}) };
      else if (river) c = { t: 'water', h: 0, ...(r < 0.03 ? { p: 'boat' } : {}) };
      else if (Math.abs(y - riverAt(x)) < 2.3) c = { t: 'grass', h: 1, ...(r < 0.25 ? { p: 'tree' } : {}) };
      else {
        const kind = kindOf(x, y);
        const nearRoad = roadX.has(x - 1) || roadX.has(x + 1) || roadY.has(y - 1) || roadY.has(y + 1);
        if (kind === 'park') c = fbm(n1, x / 3, y / 3) > 0.7 ? { t: 'water', h: 0 } : { t: 'grass', h: 1, ...(r < 0.35 ? { p: 'tree' } : {}) };
        else if (kind === 'plaza') c = { t: 'cobble', h: 1, ...(r < 0.08 ? { p: 'tree' } : {}) };
        else if (kind === 'downtown') c = { t: 'cobble', h: 1, ...(r < 0.7 ? { p: r < 0.5 ? 'skyscraper' : 'apartment' } : {}) };
        else c = { t: 'cobble', h: 1, ...(r < 0.75 ? { p: nearRoad && r < 0.25 ? 'shop' : r < 0.5 ? 'apartment' : 'house' } : r < 0.85 ? { p: 'tree' } : {}) };
      }
      put(x, y, c);
    }
  }
}

/**
 * Hive city: great caverns carved out of the rock, joined by tunnels, densely built with
 * dwellings around pools, towers here and there and a few great halls.
 */
function hive(w: number, h: number, seed: number, put: Put) {
  const rnd = mulberry32(seed), n1 = makeNoise(seed + 11), n2 = makeNoise(seed + 12);
  const halls: [number, number, number][] = [];
  const count = 5 + Math.floor(rnd() * 3);
  for (let k = 0; k < count; k++) halls.push([4 + rnd() * (w - 8), 4 + rnd() * (h - 8), 4.5 + rnd() * 3]);
  const open = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (halls.some(([hx, hy, r]) => Math.hypot(x - hx, (y - hy) * 1.1) < r + (fbm(n1, x / 4, y / 4) - 0.5) * 2.5)) open[y * w + x] = 1;
  // tunnels: join each hall to the next with an L-shaped walkway
  const web = new Set<number>();
  for (let k = 0; k < halls.length; k++) {
    const [ax, ay] = halls[k], [bx, by] = halls[(k + 1) % halls.length];
    let x = Math.round(ax), y = Math.round(ay);
    while (x !== Math.round(bx)) (x += Math.sign(bx - x)), web.add(y * w + x);
    while (y !== Math.round(by)) (y += Math.sign(by - y)), web.add(y * w + x);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, r = rnd();
      const a = fbm(n1, x / 5, y / 5), b = fbm(n2, x / 4, y / 4);
      let c: Cell;
      if (!open[i] && !web.has(i)) c = { t: 'wall', h: a > 0.6 ? 3 : 2 };
      else if (web.has(i) && !open[i]) c = { t: 'tunnel', h: 1, ...(r < 0.12 ? { p: 'torch' } : {}) };
      else if (a > 0.7) c = { t: 'cavelake', h: 0 };
      else if (b > 0.68) c = { t: 'mushroom', h: 0, ...(r < 0.16 ? { p: 'boulder' } : {}) }; // brood chambers
      else if (b < 0.26) c = { t: 'crystal', h: 0, ...(r < 0.15 ? { p: 'crystals' } : {}) };
      else {
        // dwellings are big (they claim several cells once settled), so they're offered generously
        const p = r < 0.15 ? 'house' : r < 0.18 ? 'tower' : r < 0.2 ? 'castle' : r < 0.235 ? 'torch' : r < 0.25 ? 'campfire' : r < 0.265 ? 'chest' : undefined;
        c = { t: 'cavefloor', h: 0, ...(p ? { p } : {}) };
      }
      put(x, y, c);
    }
  }
}
