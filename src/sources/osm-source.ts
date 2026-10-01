import { readFileSync } from 'node:fs';
import { OSM_LIMITS } from '../config/settings.ts';
import type { Limiter } from '../net/limiter.ts';
import type { Business } from '../schemas.ts';
import { buildNominatimUrl, buildOverpassQuery, parseNominatim, parseOverpass, type GeoArea } from './osm-parse.ts';

export interface OsmSource {
  readonly kind: 'osm' | 'fixture';
  geocode(city: string): Promise<GeoArea>;
  findBusinesses(niche: string, area: GeoArea, limit: number): Promise<readonly Business[]>;
}

/** Overpass returns more than we need so de-duplication and unnamed elements don't starve the limit. */
const overfetch = (limit: number): number => Math.min(limit * 4 + 20, 400);

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  let chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response larger than ${maxBytes} bytes`);
    }
    chunks = [...chunks, value];
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchJson(url: string, init: RequestInit, userAgent: string): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    redirect: 'error',
    headers: { 'User-Agent': userAgent, Accept: 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(OSM_LIMITS.httpTimeoutMs),
  });
  const text = await readCapped(res, OSM_LIMITS.maxResponseBytes);
  if (!res.ok) throw new Error(`${new URL(url).host} responded HTTP ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).host} returned invalid JSON`);
  }
}

/**
 * Real OpenStreetMap source (fixed, trusted endpoints).
 * Nominatim: max 1 request/second (shared interval limiter).
 * Overpass: exactly one query per run; a second call throws.
 */
export function createOsmSource(userAgent: string, nominatimLimiter: Limiter): OsmSource {
  let overpassUsed = false;
  return {
    kind: 'osm',
    geocode: (city) => nominatimLimiter.run(async () => parseNominatim(await fetchJson(buildNominatimUrl(city), {}, userAgent))),
    async findBusinesses(niche, area, limit) {
      if (overpassUsed) throw new Error('Overpass budget exhausted: only one query per run is allowed');
      overpassUsed = true;
      const query = buildOverpassQuery(niche, area, overfetch(limit));
      const json = await fetchJson(
        OSM_LIMITS.overpassUrl,
        { method: 'POST', body: new URLSearchParams({ data: query }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        userAgent,
      );
      return parseOverpass(json, niche, limit);
    },
  };
}

/** Offline source for --mock, tests and eval. Same one-query guard as the real source. */
export function createFixtureOsmSource(nominatimFile: URL, overpassFile: URL): OsmSource {
  let overpassUsed = false;
  const read = (file: URL): unknown => JSON.parse(readFileSync(file, 'utf8'));
  return {
    kind: 'fixture',
    geocode: async (city) => ({ ...parseNominatim(read(nominatimFile)), displayName: `${city} (fixture data)` }),
    async findBusinesses(niche, _area, limit) {
      if (overpassUsed) throw new Error('Overpass budget exhausted: only one query per run is allowed');
      overpassUsed = true;
      return parseOverpass(read(overpassFile), niche, limit);
    },
  };
}
