import { describe, expect, it } from 'vitest';
import { assembleLeads } from '../src/output/assemble.ts';
import { csvCell, leadsToCsv, LEAD_CSV_COLUMNS } from '../src/output/csv.ts';
import { INITIAL_STATE, type RunState } from '../src/agent/state.ts';
import { makeAudit, makeBusiness } from './helpers.ts';

describe('csvCell', () => {
  it('quotes commas, quotes and newlines (RFC 4180)', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('plain')).toBe('plain');
  });

  it('neutralises spreadsheet formula injection from untrusted OSM data', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    for (const lead of ['+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(lead).replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('renders null/undefined as empty and booleans/numbers plainly', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(true)).toBe('yes');
    expect(csvCell(false)).toBe('no');
    expect(csvCell(42)).toBe('42');
  });
});

describe('leadsToCsv', () => {
  const state: RunState = {
    ...INITIAL_STATE,
    searched: true,
    businesses: [
      makeBusiness({ id: 'osm-node-1', name: 'Good, Inc.', website: 'https://good.example/' }),
      makeBusiness({ id: 'osm-node-2', name: 'No Site', website: null, phone: '+1 512 555 0199' }),
      makeBusiness({ id: 'osm-way-3', name: 'Unaudited', website: 'https://later.example/' }),
    ],
    audits: { 'osm-node-1': makeAudit({ businessId: 'osm-node-1' }) },
  };

  it('writes a header plus one ranked row per business', () => {
    const csv = leadsToCsv(assembleLeads(state, 2026));
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(LEAD_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(4);
    expect(lines[1]?.startsWith('1,75,No Site,')).toBe(true);
    expect(csv).toContain('"Good, Inc."');
    expect(csv).toContain('not_audited');
    expect(csv).toContain('https://www.openstreetmap.org/way/3');
  });
});
