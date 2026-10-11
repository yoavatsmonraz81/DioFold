/** Isometric tile geometry, shared by the painters (which draw tiles) and the renderer (which places them). */
export const TW = 64; // diamond width
export const TH = 32; // diamond height
export const HZ = 12; // pixels per height level
export const BASE = 10; // thickness of the earth slab under height 0
export const MAX_H = 6;
export const PAD = 4; // texture padding so outlines aren't clipped
export const HEADROOM = 56; // room above the top face for trees, crystals, puffs

export const isoX = (x: number, y: number) => (x - y) * (TW / 2);
export const isoY = (x: number, y: number) => (x + y) * (TH / 2);
