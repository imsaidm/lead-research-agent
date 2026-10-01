/**
 * Niche -> OpenStreetMap tag filters. A business matches a niche when ANY of
 * its filters matches. Keys are the values accepted by `--niche`.
 * Tag reference: https://wiki.openstreetmap.org/wiki/Map_features
 */
export interface OsmTagFilter {
  readonly key: string;
  readonly value: string;
}

export const NICHES: Readonly<Record<string, readonly OsmTagFilter[]>> = Object.freeze({
  plumber: [{ key: 'craft', value: 'plumber' }],
  hvac: [
    { key: 'craft', value: 'hvac' },
    { key: 'shop', value: 'hvac' },
  ],
  electrician: [{ key: 'craft', value: 'electrician' }],
  roofer: [{ key: 'craft', value: 'roofer' }],
  locksmith: [
    { key: 'shop', value: 'locksmith' },
    { key: 'craft', value: 'locksmith' },
  ],
  landscaper: [{ key: 'craft', value: 'gardener' }],
  dentist: [
    { key: 'amenity', value: 'dentist' },
    { key: 'healthcare', value: 'dentist' },
  ],
  restaurant: [{ key: 'amenity', value: 'restaurant' }],
  auto_repair: [{ key: 'shop', value: 'car_repair' }],
  hairdresser: [{ key: 'shop', value: 'hairdresser' }],
});

export const NICHE_NAMES = Object.freeze(Object.keys(NICHES)) as readonly string[];

export function isKnownNiche(niche: string): boolean {
  return Object.hasOwn(NICHES, niche);
}
