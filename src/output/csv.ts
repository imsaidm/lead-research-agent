import { osmUrl, type LeadRecord } from './assemble.ts';

export const LEAD_CSV_COLUMNS = Object.freeze([
  'rank', 'score', 'name', 'niche', 'website', 'phone', 'address', 'osm_id', 'osm_url', 'audit_status', 'https',
  'mobile_viewport', 'response_ms', 'chat_widget', 'contact_form', 'copyright_year', 'findings', 'reasons', 'draft_status',
] as const);

/** One CSV cell: RFC 4180 quoting + formula-injection guard for spreadsheet apps. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function leadsToCsv(records: readonly LeadRecord[]): string {
  const rows = records.map(({ rank, business: b, audit: a, lead, draft }) => [
    rank, lead.score, b.name, b.niche, b.website, b.phone, b.address, b.id, osmUrl(b.id), a.status, a.https,
    a.hasViewport, a.responseTimeMs, a.hasChatWidget, a.hasContactForm, a.copyrightYear,
    lead.findings.map((f) => f.id).join(' '), lead.reasons.join('; '), draft?.status ?? '',
  ]);
  return toCsv(LEAD_CSV_COLUMNS, rows);
}
