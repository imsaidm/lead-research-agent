import { z } from 'zod';
import { NICHES } from '../config/niches.ts';
import { OSM_LIMITS } from '../config/settings.ts';
import { BusinessSchema, type Business } from '../schemas.ts';

/** Pure builders/parsers for Nominatim and Overpass. No I/O here. */

export interface GeoArea {
  readonly displayName: string;
  readonly lat: number;
  readonly lon: number;
  /** [south, west, north, east] */
  readonly bbox: readonly [number, number, number, number];
}

const NominatimSchema = z
  .array(
    z.object({
      lat: z.coerce.number().min(-90).max(90),
      lon: z.coerce.number().min(-180).max(180),
      display_name: z.string().max(500),
      boundingbox: z.tuple([z.coerce.number(), z.coerce.number(), z.coerce.number(), z.coerce.number()]),
    }),
  )
  .min(1, 'city not found');

export function buildNominatimUrl(city: string): string {
  const params = new URLSearchParams({ q: city, format: 'jsonv2', limit: '1', addressdetails: '0' });
  return `${OSM_LIMITS.nominatimUrl}?${params.toString()}`;
}

export function parseNominatim(json: unknown): GeoArea {
  const [first] = NominatimSchema.parse(json);
  if (!first) throw new Error('city not found');
  const [south, north, west, east] = first.boundingbox;
  return { displayName: first.display_name, lat: first.lat, lon: first.lon, bbox: [south, west, north, east] };
}

const quote = (s: string): string => `"${s.replace(/[\\"]/g, '\\$&')}"`;

export function buildOverpassQuery(niche: string, area: GeoArea, maxResults: number): string {
  const filters = NICHES[niche];
  if (!filters) throw new Error(`unknown niche: ${niche}`);
  const [s, w, n, e] = area.bbox;
  const tooBig = n - s > OSM_LIMITS.maxBboxSpanDeg || e - w > OSM_LIMITS.maxBboxSpanDeg;
  const scope = tooBig
    ? `(around:${OSM_LIMITS.fallbackRadiusM},${area.lat},${area.lon})`
    : `(${s},${w},${n},${e})`;
  const lines = filters.map((f) => `  nwr[${quote(f.key)}=${quote(f.value)}]${scope};`);
  return [`[out:json][timeout:${OSM_LIMITS.overpassTimeoutSec}];`, '(', ...lines, ');', `out center tags ${maxResults};`].join('\n');
}

const ElementSchema = z.object({
  type: z.enum(['node', 'way', 'relation']),
  id: z.number().int().positive(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});
const OverpassSchema = z.object({ elements: z.array(z.unknown()) });

/** Strips control characters and collapses whitespace in untrusted OSM text. */
export function cleanText(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function buildAddress(tags: Readonly<Record<string, string>>): string | null {
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const parts = [street, tags['addr:city'], [tags['addr:state'], tags['addr:postcode']].filter(Boolean).join(' ')].filter(Boolean);
  return cleanText(parts.join(', '), 300);
}

function toBusiness(raw: unknown, niche: string): Business | null {
  const el = ElementSchema.safeParse(raw);
  if (!el.success) return null;
  const tags = el.data.tags ?? {};
  const name = cleanText(tags.name, 200);
  if (!name) return null;
  const candidate = {
    id: `osm-${el.data.type}-${el.data.id}`,
    name,
    niche,
    website: cleanText(tags.website ?? tags['contact:website'] ?? tags.url, 500),
    phone: cleanText(tags.phone ?? tags['contact:phone'], 60),
    address: buildAddress(tags),
    lat: el.data.lat ?? el.data.center?.lat ?? null,
    lon: el.data.lon ?? el.data.center?.lon ?? null,
  };
  const parsed = BusinessSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Valid, named, de-duplicated businesses sorted by name (stable across runs). */
export function parseOverpass(json: unknown, niche: string, limit: number): readonly Business[] {
  const { elements } = OverpassSchema.parse(json);
  const businesses = elements.map((e) => toBusiness(e, niche)).filter((b): b is Business => b !== null);
  const seen = new Set<string>();
  const unique = businesses
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((b) => {
      const key = b.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return Object.freeze(unique.sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit));
}
