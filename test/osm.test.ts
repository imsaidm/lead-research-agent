import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildNominatimUrl, buildOverpassQuery, cleanText, parseNominatim, parseOverpass, type GeoArea } from '../src/sources/osm-parse.ts';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/osm/${name}`, import.meta.url), 'utf8'));
const austin: GeoArea = { displayName: 'Austin', lat: 30.27, lon: -97.74, bbox: [30.1, -97.94, 30.52, -97.56] };

describe('nominatim', () => {
  it('builds an encoded search URL', () => {
    expect(buildNominatimUrl('Austin, TX')).toBe('https://nominatim.openstreetmap.org/search?q=Austin%2C+TX&format=jsonv2&limit=1&addressdetails=0');
  });

  it('parses the bounding box into [s, w, n, e]', () => {
    const area = parseNominatim(fixture('nominatim.json'));
    expect(area.bbox).toEqual([30.0985133, -97.9367663, 30.5166255, -97.5605288]);
    expect(area.lat).toBeCloseTo(30.27, 2);
  });

  it('rejects empty results', () => {
    expect(() => parseNominatim([])).toThrow(/city not found/);
  });
});

describe('overpass', () => {
  it('builds one union query per niche with all mapped tags', () => {
    const q = buildOverpassQuery('hvac', austin, 60);
    expect(q).toContain('nwr["craft"="hvac"](30.1,-97.94,30.52,-97.56);');
    expect(q).toContain('nwr["shop"="hvac"](30.1,-97.94,30.52,-97.56);');
    expect(q).toContain('out center tags 60;');
  });

  it('falls back to a radius search for huge bounding boxes', () => {
    const q = buildOverpassQuery('plumber', { ...austin, bbox: [25, -106, 36, -93] }, 10);
    expect(q).toContain('(around:20000,30.27,-97.74)');
  });

  it('rejects unknown niches', () => {
    expect(() => buildOverpassQuery('astronaut', austin, 10)).toThrow(/unknown niche/);
  });

  it('parses businesses: drops unnamed, dedupes, maps contact:* tags, sorts by name', () => {
    const list = parseOverpass(fixture('overpass.json'), 'plumber', 50);
    expect(list).toHaveLength(10);
    expect(list.filter((b) => b.name === 'Lone Star Plumbing')).toHaveLength(1);
    const capitol = list.find((b) => b.name === 'Capitol Rooter');
    expect(capitol).toMatchObject({ id: 'osm-way-2004', phone: '+1 512-555-0104', lat: 30.28 });
    expect(list.find((b) => b.name === 'Mueller Plumbing Co.')?.website).toBe('http://mueller-plumbing.example/');
    expect(list.find((b) => b.name === 'Lone Star Plumbing')?.address).toBe('100 Congress Avenue, Austin, TX 78701');
    expect(list.map((b) => b.name)).toEqual([...list.map((b) => b.name)].sort((a, b) => a.localeCompare(b)));
  });

  it('applies the limit', () => {
    expect(parseOverpass(fixture('overpass.json'), 'plumber', 3)).toHaveLength(3);
  });

  it('strips control and bidi characters from untrusted names', () => {
    expect(cleanText('Evil\u202E Co\n\tLLC', 50)).toBe('Evil Co LLC');
    expect(cleanText('   ', 50)).toBeNull();
  });
});
