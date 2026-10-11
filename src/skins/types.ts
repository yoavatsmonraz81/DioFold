import type { BridgeDef } from '../core/bridges';
import type { LayerId } from '../core/layers';
import type { PropDef } from '../core/props';
import type { TerrainDef } from '../core/terrains';

/** A drawn image plus the pixel that sits on the anchor point (tile: top-face centre; prop: ground point). */
export interface Rendered {
  canvas: HTMLCanvasElement;
  ax: number;
  ay: number;
  res?: number; // pixels per logical pixel (painted art is drawn at 2×)
  view?: number; // for props: which view was actually drawn (when a skin has no art for the asked view, the map mirrors)
}

export interface TileRequest {
  terrain: TerrainDef;
  h: number;
  variant: number; // 0..2, picked per cell so neighbours don't look identical
  frame: number; // 0..3 for animated terrains
  mask: number; // neighbour edges (foam: land, road: road): bit0 NE, bit1 SE, bit2 SW, bit3 NW
  region: number; // which slice of a painted texture this cell shows (0 when unused)
  grid: number; // the texture spans grid×grid cells (region = column + grid × row)
}

export interface PropRequest {
  prop: PropDef;
  variant: number;
  frame: number;
  width: number; // how wide to draw it, in tiles (see core/footprint.ts)
  view: number; // 0..3: the map turned this many quarter-turns clockwise
}

export interface BridgeRequest {
  bridge: BridgeDef;
  deck: number; // deck height, in levels
  ground: number; // height of what's underneath (liquids count as 0)
  axis: 0 | 1; // on screen: 0 runs down-right, 1 runs down-left
  cont: number; // bit0: the bridge carries on behind this cell, bit1: in front
  variant: number;
}

/**
 * Anything that can draw tiles and props. The procedural skins implement this in code;
 * a future sprite-sheet skin (e.g. generated with ComfyUI) implements it with image lookups.
 */
export interface Skin {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly theme: 'dark' | 'light';
  readonly layerBg: Record<LayerId, number>;
  readonly nearest: boolean; // crisp pixel scaling
  renderTile(req: TileRequest): Rendered;
  /** Painted textures span a k×k block of cells so neighbours join seamlessly; 1 = no regions. */
  regionGrid?(terrain: TerrainDef, tile: number): number;
  renderProp(req: PropRequest): Rendered;
  renderBridge(req: BridgeRequest): Rendered;
  /** Maps a base colour through the skin (for particles and UI accents). */
  tint(hex: string): number;
  /** Optional tiling background overlay, drawn in white/black with low alpha. */
  pattern?(ctx: CanvasRenderingContext2D, size: number): void;
}
