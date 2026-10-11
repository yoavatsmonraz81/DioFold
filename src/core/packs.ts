import { LAYERS, LAYER_IDS, type LayerId } from './layers';
import { PROPS, PROP_LIST, type PropDef } from './props';
import { TERRAINS, TERRAIN_LIST, type TerrainColors, type TerrainDef } from './terrains';
import type { Cell } from './world';

/**
 * A world pack: one setting's names, terrains, props and generator mapping.
 * The four layer slots (sky → deep, top to bottom) are fixed; packs label and fill them.
 * Pack terrains/props extend a built-in "base" for behaviour (liquid, height rules…) and
 * for the procedural skins' fallback look; painted art comes from the forge (tools/forge).
 */
export type GenKind = 'sky' | 'surface' | 'underground' | 'deep' | 'city' | 'hive';

export interface PackLayer {
  id: LayerId;
  name: string;
  icon: string;
  blurb: string;
  generator: GenKind | null;
  blank: Cell | null; // what "Clear" fills the layer with
  bg?: string; // background colour for the painted skin
  tile?: number; // default tile size: how much world a tile holds (1 = the scale props' `foot` is given in)
}

export interface PackTerrainJSON {
  id: string;
  name: string;
  layers: LayerId[];
  base: string;
  colors?: Partial<TerrainColors>;
  fixedH?: number;
  baseH?: number;
  keepH?: boolean;
  minH?: number;
  liquid?: boolean;
  foam?: boolean;
  animated?: boolean;
  noProps?: boolean;
  road?: boolean;
  art?: { top?: string; side?: string; sprite?: string };
}

export interface PackPropJSON {
  id: string;
  name: string;
  layers: LayerId[];
  base: string;
  onWater?: boolean;
  animated?: boolean;
  bob?: boolean;
  flies?: boolean; // airborne: placed over any tile, clouds included, and drawn hovering
  foot?: number | [number, number]; // size in tiles at tile size 1 (default 1): a palace 3, a lantern 0.5, an arch [1, 2]
  prompt?: string;
}

export interface GenMapping {
  terrains: Record<string, string>;
  props: Record<string, string | string[]>; // a list: each spot picks one at random
}

export interface PackJSON {
  id: string;
  name: string;
  subtitle: string;
  style?: string;
  layers: PackLayer[];
  sides?: Record<string, string>;
  terrains: PackTerrainJSON[];
  props: PackPropJSON[];
  generate?: Partial<Record<LayerId, GenMapping>>;
}

export interface Pack {
  id: string;
  name: string;
  subtitle: string;
  layers: Record<LayerId, PackLayer>;
  terrains: TerrainDef[];
  props: PropDef[];
  generate: Partial<Record<LayerId, GenMapping>>;
}

const CLASSIC_BLANK: Record<LayerId, Cell | null> = {
  sky: null,
  surface: { t: 'water', h: 0 },
  underground: { t: 'wall', h: 2 },
  deep: { t: 'basalt', h: 2 },
};

export const CLASSIC: Pack = {
  id: 'classic',
  name: 'Classic',
  subtitle: 'The original toy box',
  layers: Object.fromEntries(
    LAYERS.map((l) => [l.id, { ...l, generator: l.id, blank: CLASSIC_BLANK[l.id] }]),
  ) as Record<LayerId, PackLayer>,
  terrains: TERRAIN_LIST,
  props: PROP_LIST,
  generate: {},
};

export const nsId = (pack: string, id: string) => `${pack}:${id}`;

/** Turns pack JSON into registered terrain/prop definitions. */
export function registerPack(json: PackJSON): Pack {
  const ns = (id: string) => nsId(json.id, id);
  const terrains = json.terrains.map((t): TerrainDef => {
    const base = TERRAINS[t.base] ?? TERRAINS.grass;
    const def: TerrainDef = {
      ...base,
      ...Object.fromEntries(Object.entries(t).filter(([k]) => !['id', 'name', 'layers', 'base', 'colors', 'art'].includes(k))),
      id: ns(t.id),
      name: t.name,
      layers: t.layers,
      colors: { ...base.colors, ...t.colors },
      look: base.look ?? base.id,
      pack: json.id,
      art: t.id,
    };
    TERRAINS[def.id] = def;
    return def;
  });
  const props = json.props.map((p): PropDef => {
    const base = PROPS[p.base] ?? PROPS.boulder;
    const def: PropDef = {
      ...base,
      onWater: p.onWater ?? base.onWater,
      animated: p.animated ?? base.animated,
      bob: p.bob ?? base.bob,
      flies: p.flies ?? base.flies,
      id: ns(p.id),
      name: p.name,
      layers: p.layers,
      look: base.look ?? base.id,
      foot: p.foot ?? base.foot,
      pack: json.id,
      art: p.id,
    };
    PROPS[def.id] = def;
    return def;
  });
  const mapNs = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v ? ns(v) : '']));
  const mapProps = (m: Record<string, string | string[]>) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Array.isArray(v) ? v.map(ns) : v ? ns(v) : '']));
  const generate: Pack['generate'] = {};
  for (const id of LAYER_IDS) {
    const g = json.generate?.[id];
    if (g) generate[id] = { terrains: mapNs(g.terrains), props: mapProps(g.props) };
  }
  const layers = Object.fromEntries(
    json.layers.map((l) => [l.id, { ...l, blank: l.blank ? { ...l.blank, t: ns(l.blank.t) } : null }]),
  ) as Record<LayerId, PackLayer>;
  return { id: json.id, name: json.name, subtitle: json.subtitle, layers, terrains, props, generate };
}

export const packTerrains = (pack: Pack, layer: LayerId) => pack.terrains.filter((t) => t.layers.includes(layer));
export const packProps = (pack: Pack, layer: LayerId) => pack.props.filter((p) => p.layers.includes(layer));
