import { CLASSIC, registerPack, type Pack, type PackJSON } from '../core/packs';

/**
 * Every pack folder here (src/packs/<id>/pack.json) is picked up automatically. Pack folders are
 * git-ignored, so your own worlds stay on your machine; the repository itself ships only Classic.
 */
const found = import.meta.glob<PackJSON>('./*/pack.json', { eager: true, import: 'default' });

export const PACKS: Pack[] = [...Object.values(found).map((json) => registerPack(json)), CLASSIC];
export const packById = (id: string) => PACKS.find((p) => p.id === id) ?? PACKS[0];
