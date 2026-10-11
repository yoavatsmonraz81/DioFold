import { anchorFor, footCells, occupant, propSize, type Occupant } from './footprint';
import { MAX_H } from './geometry';
import { LAYER_IDS, type LayerId } from './layers';
import { PROPS, propFits } from './props';
import { terrain } from './terrains';
import type { Cell, World } from './world';

/** The height a terrain gets when painted over `cur`. */
export function paintedHeight(tId: string, cur: Cell | null): number {
  const T = terrain(tId);
  if (T.fixedH !== undefined) return T.fixedH;
  if (T.keepH && cur && terrain(cur.t).keepH) return Math.max(cur.h, T.minH ?? 0);
  return Math.max(T.baseH ?? 1, T.minH ?? 0);
}

function removeProp(world: World, layer: LayerId, o: Occupant): boolean {
  const c = world.get(layer, o.x, o.y);
  return !!c && world.set(layer, o.x, o.y, { t: c.t, h: c.h });
}

export function paintCell(world: World, layer: LayerId, x: number, y: number, tId: string): boolean {
  const cur = world.get(layer, x, y);
  const T = terrain(tId);
  const occ = occupant(world, layer, x, y);
  // ground under a big prop stays level with the rest of its footprint
  const h = occ && occ.nx * occ.ny > 1 && cur && T.fixedH === undefined ? cur.h : paintedHeight(tId, cur);
  const next: Cell = { t: T.id, h };
  let changed = false;
  if (occ && !propFits(PROPS[occ.p], T)) {
    if (occ.x !== x || occ.y !== y) changed = removeProp(world, layer, occ);
  } else if (cur?.p) next.p = cur.p;
  return world.set(layer, x, y, next) || changed;
}

/** Raises or lowers a cell; a big prop's whole footprint moves together. `seen` collects every cell touched. */
export function nudgeHeight(world: World, layer: LayerId, x: number, y: number, dh: number, seen?: Set<number>): boolean {
  const occ = occupant(world, layer, x, y);
  const cells = occ && occ.nx * occ.ny > 1 ? footCells(occ.x, occ.y, occ.nx, occ.ny) : [{ x, y }];
  let changed = false;
  for (const c of cells) {
    seen?.add(c.y * world.w + c.x);
    const cur = world.get(layer, c.x, c.y);
    if (!cur || terrain(cur.t).fixedH !== undefined) continue;
    const h = Math.max(0, Math.min(MAX_H, cur.h + dh));
    changed = world.set(layer, c.x, c.y, { ...cur, h }) || changed;
  }
  return changed;
}

/** Erases a cell, taking down any prop that was standing on it. */
export function eraseCell(world: World, layer: LayerId, x: number, y: number): boolean {
  const occ = occupant(world, layer, x, y);
  const changed = !!occ && (occ.x !== x || occ.y !== y) && removeProp(world, layer, occ);
  return world.set(layer, x, y, null) || changed;
}

/** Where a prop would go if dropped on (x, y), and whether it fits there. */
export function propPlacement(world: World, layer: LayerId, x: number, y: number, pId: string) {
  const P = PROPS[pId];
  const { nx, ny } = propSize(P, world.tile[layer]);
  const a = anchorFor(world.w, world.h, x, y, nx, ny);
  const cells = footCells(a.x, a.y, nx, ny);
  const fits = cells.every((c) => {
    const cell = world.get(layer, c.x, c.y);
    return !!cell && propFits(P, terrain(cell.t));
  });
  return { anchor: a, cells, big: nx * ny > 1, fits };
}

/**
 * Places a prop centred on (x, y): big props level the ground under them and clear whatever stood
 * there (unless `replace` is false, when an occupied spot is skipped). A null id removes the prop on (x, y).
 */
export function placeProp(world: World, layer: LayerId, x: number, y: number, pId: string | null, replace = true): boolean {
  if (!pId) {
    const occ = occupant(world, layer, x, y);
    return !!occ && removeProp(world, layer, occ);
  }
  const { anchor, cells, big, fits } = propPlacement(world, layer, x, y, pId);
  if (!fits) return false;
  const occs = new Map<string, Occupant>();
  for (const c of cells) {
    const o = occupant(world, layer, c.x, c.y);
    if (o) occs.set(`${o.x},${o.y}`, o);
  }
  const same = occs.size === 1 && [...occs.values()].every((o) => o.x === anchor.x && o.y === anchor.y && o.p === pId);
  if (same || (!replace && occs.size)) return false;
  for (const o of occs.values()) removeProp(world, layer, o);
  if (big) {
    const level = world.get(layer, x, y)!.h;
    for (const c of cells) {
      const cur = world.get(layer, c.x, c.y)!;
      if (terrain(cur.t).fixedH === undefined) world.set(layer, c.x, c.y, { ...cur, h: level });
    }
  }
  return world.set(layer, anchor.x, anchor.y, { ...world.get(layer, anchor.x, anchor.y)!, p: pId });
}

/**
 * Makes room for big props in a world saved before footprints existed: bigger props claim their cells
 * first, and any prop whose footprint would overlap one already placed is removed. Returns how many went.
 */
export function tidyProps(world: World): number {
  let removed = 0;
  for (const layer of LAYER_IDS) {
    const tile = world.tile[layer];
    const anchors: { x: number; y: number; nx: number; ny: number }[] = [];
    world.layers[layer].forEach((c, i) => {
      if (c?.p && PROPS[c.p]) anchors.push({ x: i % world.w, y: Math.floor(i / world.w), ...propSize(PROPS[c.p], tile) });
    });
    anchors.sort((a, b) => b.nx * b.ny - a.nx * a.ny || b.x + b.y - (a.x + a.y));
    const taken = new Uint8Array(world.w * world.h);
    for (const a of anchors) {
      const cells = footCells(a.x, a.y, a.nx, a.ny);
      const c = world.get(layer, a.x, a.y)!;
      if (cells.some((p) => !world.inBounds(p.x, p.y) || taken[p.y * world.w + p.x])) {
        world.set(layer, a.x, a.y, { t: c.t, h: c.h }, false);
        removed++;
        continue;
      }
      for (const p of cells) taken[p.y * world.w + p.x] = 1;
    }
  }
  return removed;
}

/** Flood-fills the contiguous region matching the start cell's terrain. */
export function floodFill(world: World, layer: LayerId, x: number, y: number, tId: string): number {
  const start = world.get(layer, x, y);
  const match = start?.t ?? null;
  if (match === tId) return 0;
  const seen = new Uint8Array(world.w * world.h);
  const stack = [[x, y]];
  let n = 0;
  while (stack.length) {
    const [cx, cy] = stack.pop()!;
    if (!world.inBounds(cx, cy) || seen[cy * world.w + cx]) continue;
    seen[cy * world.w + cx] = 1;
    if ((world.get(layer, cx, cy)?.t ?? null) !== match) continue;
    if (paintCell(world, layer, cx, cy, tId)) n++;
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
  return n;
}
