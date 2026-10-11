import type { LayerId } from './layers';

export interface TerrainColors {
  top: string;
  side: string;
  detail: string;
  light?: string;
  lip?: string; // overhanging rim on the sides, e.g. grass over dirt
  accent?: string;
}

export interface TerrainDef {
  id: string;
  name: string;
  layers: LayerId[];
  colors: TerrainColors;
  fixedH?: number; // always this height (liquids, holes)
  baseH?: number; // height when painted fresh (default 1)
  keepH?: boolean; // painting over another keepH terrain keeps the sculpted height
  minH?: number; // with keepH: raise to at least this
  liquid?: boolean;
  foam?: boolean; // water-like: foams against land, boats float on it
  animated?: boolean;
  floating?: boolean; // hovers at its height with no pillar beneath
  puffy?: boolean; // drawn as cloud puffs instead of a block
  noProps?: boolean;
  road?: boolean; // connects to neighbouring roads (lane markings follow the network)
  look?: string; // which built-in terrain the procedural skins draw this as (pack terrains)
  pack?: string; // owning pack id, for pack terrains
  art?: string; // asset id inside the pack (painted skin)
}

const S: LayerId[] = ['surface'];

const LIST: TerrainDef[] = [
  { id: 'grass', name: 'Grass', layers: S, keepH: true, colors: { top: '#7ec850', side: '#a0703f', detail: '#5fa83a', lip: '#6dbb45' } },
  { id: 'forest', name: 'Forest', layers: S, keepH: true, colors: { top: '#5a9e3a', side: '#8f6236', detail: '#3f8a2e', light: '#7cc95a', accent: '#2f6e3f', lip: '#4e8c33' } },
  { id: 'sand', name: 'Sand', layers: S, keepH: true, colors: { top: '#f0d898', side: '#d4b072', detail: '#d9bd78', light: '#fff0c4' } },
  { id: 'water', name: 'Water', layers: S, fixedH: 0, liquid: true, foam: true, animated: true, colors: { top: '#3d8fd6', side: '#2f6fb0', detail: '#9fd0f5' } },
  { id: 'shallows', name: 'Shallows', layers: S, fixedH: 0, liquid: true, foam: true, animated: true, colors: { top: '#5cc3d6', side: '#3b9cb3', detail: '#c4f1f7', accent: '#e9d8a6' } },
  { id: 'desert', name: 'Desert', layers: S, keepH: true, colors: { top: '#f2b766', side: '#c98a46', detail: '#d9954a', light: '#ffd28f' } },
  { id: 'snow', name: 'Snow', layers: S, keepH: true, colors: { top: '#f4f8fc', side: '#9aa7b5', detail: '#c9d9ec', lip: '#ffffff' } },
  { id: 'rock', name: 'Mountain', layers: S, keepH: true, minH: 2, colors: { top: '#9a9a9f', side: '#7d7d83', detail: '#6f6f75', light: '#bdbdc2' } },
  { id: 'swamp', name: 'Swamp', layers: S, keepH: true, colors: { top: '#6f8a45', side: '#5a4a33', detail: '#4a6b52', light: '#86a35a', accent: '#3e5a2a', lip: '#617a3c' } },
  { id: 'cobble', name: 'Cobblestone', layers: S, keepH: true, colors: { top: '#b8ab94', side: '#8f8370', detail: '#857a66', light: '#cfc3ad' } },
  { id: 'road', name: 'Road', layers: S, keepH: true, road: true, colors: { top: '#5d6068', side: '#7d7468', detail: '#f3e39a', light: '#c9c9cc' } },

  { id: 'cloud', name: 'Cloud', layers: ['sky'], baseH: 1, floating: true, puffy: true, noProps: true, colors: { top: '#ffffff', side: '#d5e2f2', detail: '#e8eff8', light: '#ffffff' } },
  { id: 'storm', name: 'Storm cloud', layers: ['sky'], baseH: 2, floating: true, puffy: true, animated: true, noProps: true, colors: { top: '#7a8091', side: '#545a6a', detail: '#666c7c', light: '#9aa0b0', accent: '#ffe14d' } },
  { id: 'isle', name: 'Floating isle', layers: ['sky'], baseH: 2, floating: true, colors: { top: '#84d05a', side: '#9b7a55', detail: '#62ad3f', lip: '#76c24d' } },

  { id: 'wall', name: 'Cave wall', layers: ['underground'], baseH: 2, colors: { top: '#6a6574', side: '#55505f', detail: '#4b4655', light: '#7d7887' } },
  { id: 'basalt', name: 'Basalt', layers: ['deep'], baseH: 2, colors: { top: '#3f3a42', side: '#2e2a31', detail: '#26222a', light: '#4f4953' } },
  { id: 'cavefloor', name: 'Cave floor', layers: ['underground', 'deep'], baseH: 0, colors: { top: '#8a7a69', side: '#5c5046', detail: '#6c5f52', light: '#a3937f' } },
  { id: 'crystal', name: 'Crystal cave', layers: ['underground', 'deep'], baseH: 0, colors: { top: '#6d6276', side: '#554b5e', detail: '#5a5063', light: '#b48cff', accent: '#6fe3ff' } },
  { id: 'cavelake', name: 'Cave lake', layers: ['underground'], fixedH: 0, liquid: true, foam: true, animated: true, colors: { top: '#2a5f8c', side: '#1e3f5e', detail: '#7fb8e6' } },
  { id: 'mushroom', name: 'Mushroom grove', layers: ['underground'], baseH: 0, colors: { top: '#5d5466', side: '#4d4555', detail: '#4f6b5a', light: '#ff7ac8', accent: '#59f0d6' } },
  { id: 'tunnel', name: 'Mine track', layers: ['underground'], baseH: 0, colors: { top: '#a07a4c', side: '#5c5046', detail: '#6e4f2e' } },
  { id: 'ruins', name: 'Ancient ruins', layers: ['underground', 'deep'], baseH: 0, colors: { top: '#a9a39a', side: '#77726b', detail: '#7f7a72', accent: '#6e8f4e' } },
  { id: 'lava', name: 'Lava', layers: ['surface', 'underground', 'deep'], fixedH: 0, liquid: true, animated: true, noProps: true, colors: { top: '#e8541e', side: '#b8361a', detail: '#5e2416', light: '#ffb347', accent: '#ffe04d' } },
  { id: 'abyss', name: 'Abyss', layers: ['deep'], fixedH: 0, noProps: true, colors: { top: '#120a1c', side: '#0b0612', detail: '#b69cff', accent: '#5a2fb0' } },
];

export const TERRAIN_LIST = LIST;
export const TERRAINS: Record<string, TerrainDef> = Object.fromEntries(LIST.map((t) => [t.id, t]));
export const terrain = (id: string): TerrainDef => TERRAINS[id] ?? TERRAINS.grass;
export const terrainsFor = (layer: LayerId) => LIST.filter((t) => t.layers.includes(layer));
