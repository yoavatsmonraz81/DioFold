import { LAYER_IDS, type LayerId } from './layers';

export interface Cell {
  t: string; // terrain id
  h: number; // height level
  p?: string; // prop id
}

export type CellListener = (layer: LayerId, x: number, y: number, before: Cell | null, after: Cell | null) => void;
export type Recorder = (layer: LayerId, i: number, before: Cell | null, after: Cell | null) => void;

type SavedCell = 0 | [string, number] | [string, number, string];
export interface SavedWorld {
  v: 1;
  w: number;
  h: number;
  layers: Record<LayerId, SavedCell[]>;
  tile?: Partial<Record<LayerId, number>>; // per-layer tile size, when not 1
  fp?: 1; // saved since props got footprints (older saves get their overlaps tidied on load)
}

const sameCell = (a: Cell | null, b: Cell | null) =>
  a === b || (!!a && !!b && a.t === b.t && a.h === b.h && a.p === b.p);

export class World {
  layers: Record<LayerId, (Cell | null)[]>;
  /** Tile size per layer: how much world one tile holds. Decides how many cells big props cover. */
  tile = Object.fromEntries(LAYER_IDS.map((id) => [id, 1])) as Record<LayerId, number>;
  /** Loaded from a save made before props had footprints. */
  legacy = false;
  recorder: Recorder | null = null;
  private listeners: CellListener[] = [];

  constructor(readonly w: number, readonly h: number) {
    this.layers = Object.fromEntries(LAYER_IDS.map((id) => [id, new Array(w * h).fill(null)])) as World['layers'];
  }

  onChange(fn: CellListener) {
    this.listeners.push(fn);
  }

  inBounds(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  get(layer: LayerId, x: number, y: number): Cell | null {
    return this.inBounds(x, y) ? this.layers[layer][y * this.w + x] : null;
  }

  /** Returns true if anything changed. */
  set(layer: LayerId, x: number, y: number, cell: Cell | null, record = true): boolean {
    if (!this.inBounds(x, y)) return false;
    const i = y * this.w + x;
    const before = this.layers[layer][i];
    if (sameCell(before, cell)) return false;
    const after = cell ? { ...cell } : null;
    this.layers[layer][i] = after;
    if (record) this.recorder?.(layer, i, before, after);
    for (const fn of this.listeners) fn(layer, x, y, before, after);
    return true;
  }

  toJSON(): SavedWorld {
    const layers = {} as SavedWorld['layers'];
    for (const id of LAYER_IDS) {
      layers[id] = this.layers[id].map((c) => (!c ? 0 : c.p ? [c.t, c.h, c.p] : [c.t, c.h]));
    }
    const tile = Object.fromEntries(LAYER_IDS.filter((id) => this.tile[id] !== 1).map((id) => [id, this.tile[id]]));
    return { v: 1, fp: 1, w: this.w, h: this.h, layers, ...(Object.keys(tile).length ? { tile } : {}) };
  }

  static fromJSON(data: SavedWorld): World {
    if (data?.v !== 1 || !data.w || !data.h) throw new Error('Not a world file');
    const world = new World(data.w, data.h);
    world.legacy = !data.fp;
    for (const id of LAYER_IDS) {
      const src = data.layers[id] ?? [];
      world.layers[id] = world.layers[id].map((_, i) => {
        const c = src[i];
        return c ? (c[2] ? { t: c[0], h: c[1], p: c[2] } : { t: c[0], h: c[1] }) : null;
      });
      const t = data.tile?.[id];
      if (typeof t === 'number' && t > 0) world.tile[id] = t;
    }
    return world;
  }
}
