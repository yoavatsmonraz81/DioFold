import type { LayerId } from './layers';
import type { TerrainDef } from './terrains';

export interface PropDef {
  id: string;
  name: string;
  layers: LayerId[];
  onWater?: boolean; // sits on foam-y liquids instead of land
  animated?: boolean;
  bob?: boolean;
  look?: string; // built-in prop the procedural skins draw this as
  foot?: number | [number, number]; // size in tiles at the pack's reference tile size: square, or [along x, along y]; see footprint.ts
  pack?: string;
  art?: string;
}

const LIST: PropDef[] = [
  { id: 'tree', name: 'Oak', layers: ['surface', 'sky'] },
  { id: 'pine', name: 'Pine', layers: ['surface', 'sky'] },
  { id: 'palm', name: 'Palm', layers: ['surface'] },
  { id: 'cactus', name: 'Cactus', layers: ['surface'] },
  { id: 'boulder', name: 'Boulder', layers: ['surface', 'underground', 'deep'] },
  { id: 'house', name: 'Cottage', layers: ['surface', 'sky'] },
  { id: 'tower', name: 'Tower', layers: ['surface', 'sky', 'underground'] },
  { id: 'castle', name: 'Castle', layers: ['surface', 'sky'], animated: true },
  { id: 'ruins', name: 'Ruins', layers: ['surface', 'underground', 'deep'] },
  { id: 'campfire', name: 'Campfire', layers: ['surface', 'underground'], animated: true },
  { id: 'boat', name: 'Boat', layers: ['surface', 'underground'], onWater: true, animated: true, bob: true },
  { id: 'crystals', name: 'Crystals', layers: ['underground', 'deep', 'surface'] },
  { id: 'mushroom', name: 'Giant mushroom', layers: ['underground', 'surface'] },
  { id: 'chest', name: 'Treasure', layers: ['underground', 'deep', 'surface'] },
  { id: 'torch', name: 'Torch', layers: ['underground', 'deep'], animated: true },
  { id: 'skyscraper', name: 'Skyscraper', layers: ['surface'] },
  { id: 'apartment', name: 'Apartments', layers: ['surface'] },
  { id: 'shop', name: 'Shop', layers: ['surface'] },
  { id: 'car', name: 'Car', layers: ['surface'] },
];

export const PROP_LIST = LIST;
export const PROPS: Record<string, PropDef> = Object.fromEntries(LIST.map((p) => [p.id, p]));
export const propsFor = (layer: LayerId) => LIST.filter((p) => p.layers.includes(layer));

export function propFits(p: PropDef, t: TerrainDef): boolean {
  if (t.noProps) return false;
  return p.onWater ? !!t.foam : !t.liquid;
}
