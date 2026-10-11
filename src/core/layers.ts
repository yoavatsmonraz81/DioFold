export type LayerId = 'sky' | 'surface' | 'underground' | 'deep';

export interface LayerDef {
  id: LayerId;
  name: string;
  icon: string;
  blurb: string;
}

/** Ordered top to bottom. */
export const LAYERS: LayerDef[] = [
  { id: 'sky', name: 'Sky', icon: '☁️', blurb: 'Clouds & floating isles' },
  { id: 'surface', name: 'Surface', icon: '🌍', blurb: 'Lands & seas' },
  { id: 'underground', name: 'Underground', icon: '⛏️', blurb: 'Caves & mines' },
  { id: 'deep', name: 'The Deep', icon: '🔥', blurb: 'Magma & lost ruins' },
];

export const LAYER_IDS: LayerId[] = LAYERS.map((l) => l.id);
export const layerDef = (id: LayerId) => LAYERS.find((l) => l.id === id)!;
