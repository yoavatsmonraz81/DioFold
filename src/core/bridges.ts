import type { Pt } from './footprint';
import type { LayerId } from './layers';
import { terrain } from './terrains';
import type { World } from './world';

/**
 * Bridges are laid in straight lines over whatever is below (water, lava, a chasm). They sit on top of
 * the cells rather than replacing them: each bridge cell keeps its terrain and gains a deck at a fixed
 * height, level with the higher of the two banks. Things can be placed on the deck.
 */
export interface BridgeDef {
  id: string;
  name: string;
  colors: { deck: string; side: string; rail: string; pier: string; cap: string };
  rail: 'posts' | 'wall'; // wooden railings, or a solid parapet
  piers: 'posts' | 'arches'; // stilts into the water, or masonry arches
  deck: 'planks' | 'slabs' | 'bricks';
}

const LIST: BridgeDef[] = [
  { id: 'wood', name: 'Wooden bridge', colors: { deck: '#a3713f', side: '#6f4a29', rail: '#5f3f22', pier: '#4d331d', cap: '#b8854f' }, rail: 'posts', piers: 'posts', deck: 'planks' },
  { id: 'stone', name: 'Stone bridge', colors: { deck: '#bdb4a3', side: '#958d7f', rail: '#aba393', pier: '#878074', cap: '#d8d1c3' }, rail: 'wall', piers: 'arches', deck: 'slabs' },
  { id: 'brick', name: 'Brick bridge', colors: { deck: '#a95a3b', side: '#8e4730', rail: '#b4613f', pier: '#7a3c28', cap: '#dccab0' }, rail: 'wall', piers: 'arches', deck: 'bricks' },
];

export const BRIDGE_LIST = LIST;
export const BRIDGES: Record<string, BridgeDef> = Object.fromEntries(LIST.map((b) => [b.id, b]));

/** What a cell stores: bridge kind, deck height (levels) and axis (0 = runs along x, 1 = along y). */
export interface Bridge {
  k: string;
  h: number;
  a: 0 | 1;
}

/** The straight run of cells from `from` towards `to`, snapped to whichever grid axis is closer. */
export function bridgeLine(from: Pt, to: Pt): { cells: Pt[]; a: 0 | 1 } {
  const dx = to.x - from.x, dy = to.y - from.y;
  const a: 0 | 1 = Math.abs(dx) >= Math.abs(dy) ? 0 : 1;
  const n = a === 0 ? dx : dy, step = Math.sign(n) || 1;
  const cells: Pt[] = [];
  for (let i = 0; i <= Math.abs(n); i++) cells.push(a === 0 ? { x: from.x + i * step, y: from.y } : { x: from.x, y: from.y + i * step });
  return { cells, a };
}

/** A bridge needs at least two cells, all of them with ground (or water) under them. */
export const bridgeFits = (world: World, layer: LayerId, cells: Pt[]) => cells.length >= 2 && cells.every((c) => !!world.get(layer, c.x, c.y));

/** The deck runs level with the higher bank (liquids count as height 0), and never lower than 1. */
export function deckHeight(world: World, layer: LayerId, cells: Pt[]): number {
  const ends = [cells[0], cells[cells.length - 1]].map((c) => world.get(layer, c.x, c.y)!);
  return Math.max(1, ...ends.map((c) => (terrain(c.t).liquid ? 0 : c.h)));
}

const same = (a: Bridge | undefined, b: Bridge) => !!a && a.k === b.k && a.a === b.a && a.h === b.h;

/** Every cell of the bridge running through (x, y). */
export function bridgeCells(world: World, layer: LayerId, x: number, y: number): Pt[] {
  const b = world.get(layer, x, y)?.b;
  if (!b) return [];
  const out: Pt[] = [{ x, y }];
  for (const d of [-1, 1]) {
    for (let i = 1; ; i++) {
      const p = b.a === 0 ? { x: x + d * i, y } : { x, y: y + d * i };
      if (!same(world.get(layer, p.x, p.y)?.b, b)) break;
      out.push(p);
    }
  }
  return out;
}
