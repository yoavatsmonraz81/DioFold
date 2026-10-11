import type { LayerId } from './layers';
import { PROPS, type PropDef } from './props';
import type { World } from './world';

/**
 * Big things take more than one cell. A prop's `foot` is its size in tiles at the pack's reference
 * scale: one number for a square footprint, or [along x, along y] for a long one (an arch, a train car).
 * Each layer has a tile size (how much world one tile holds), so the same palace can be a 3×3 landmark
 * on a fine city map and a single tile on a coarse continent map.
 *
 * A placed prop is stored on its anchor: the front corner (max x, max y) of an nx×ny footprint that
 * extends back from it. The other cells hold nothing; occupancy is worked out from the anchors.
 */
export const MAX_FOOT = 4;
export const TILE_SIZES = [0.5, 0.75, 1, 1.5, 2, 3];
export const FOOT_STEPS = [0.25, 0.4, 0.5, 0.6, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];

export type Foot = number | [number, number];

export interface PropSize {
  nx: number; // footprint: nx cells along x by ny along y
  ny: number;
  w: number; // drawn width in tiles (at most the footprint's; small things shrink instead of claiming space)
}

export const footXY = (foot: Foot | undefined): [number, number] => (Array.isArray(foot) ? foot : [foot ?? 1, foot ?? 1]);

export function propSize(P: PropDef, tile = 1): PropSize {
  const [a, b] = footXY(P.foot);
  const fa = a / tile, fb = b / tile;
  const nx = Math.max(1, Math.min(MAX_FOOT, Math.round(fa)));
  const ny = Math.max(1, Math.min(MAX_FOOT, Math.round(fb)));
  // an nx×ny footprint is (nx + ny) / 2 tiles wide on screen
  return { nx, ny, w: Math.max(0.3, Math.min((nx + ny) / 2, (fa + fb) / 2)) };
}

export interface Pt {
  x: number;
  y: number;
}

export interface Occupant extends Pt {
  p: string;
  nx: number;
  ny: number;
}

/** The cells under an nx×ny prop anchored at (ax, ay). */
export function footCells(ax: number, ay: number, nx: number, ny = nx): Pt[] {
  const out: Pt[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) out.push({ x: ax - i, y: ay - j });
  return out;
}

/** The anchor that centres an nx×ny footprint on (x, y), nudged inward so it stays on the map. */
export function anchorFor(w: number, h: number, x: number, y: number, nx: number, ny = nx): Pt {
  return {
    x: Math.max(nx - 1, Math.min(w - 1, x + Math.floor((nx - 1) / 2))),
    y: Math.max(ny - 1, Math.min(h - 1, y + Math.floor((ny - 1) / 2))),
  };
}

/** The prop standing on (x, y), which may be anchored on a cell in front of it. */
export function occupant(world: World, layer: LayerId, x: number, y: number): Occupant | null {
  const tile = world.tile[layer];
  for (let j = 0; j < MAX_FOOT; j++) {
    for (let i = 0; i < MAX_FOOT; i++) {
      const c = world.get(layer, x + i, y + j);
      const P = c?.p ? PROPS[c.p] : undefined;
      if (!P) continue;
      const { nx, ny } = propSize(P, tile);
      if (i < nx && j < ny) return { x: x + i, y: y + j, p: P.id, nx, ny };
    }
  }
  return null;
}

export const footLabel = (nx: number, ny: number) => `${nx}×${ny}`;

export const nextStep = (steps: number[], v: number, d: number) => {
  const i = steps.findIndex((s) => s >= v - 1e-6);
  const at = i < 0 ? steps.length - 1 : steps[i] > v + 1e-6 && d > 0 ? i - 1 : i;
  return steps[Math.max(0, Math.min(steps.length - 1, at + d))];
};
