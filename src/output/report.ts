import type { Task } from '../agent/state.ts';
import { OSM_ATTRIBUTION } from '../config/settings.ts';
import type { CostTotals } from '../llm/cost.ts';
import type { LeadRecord } from './assemble.ts';
import { hostOf, mdEscape, pct, table } from './markdown.ts';

export interface RunSummaryInput {
  readonly task: Task;
  readonly records: readonly LeadRecord[];
  readonly areaName: string | null;
  readonly stopReason: string;
  readonly stopDetail: string | null;
  readonly cost: CostTotals | null;
  readonly generatedAt: string;
}

export function modeLabel(task: Task): string {
  if (task.offline) return task.mode === 'agent' ? 'MOCK (offline fixtures, fictional businesses, mock LLM)' : 'MOCK (offline fixtures, fictional businesses, template drafts)';
  return task.mode === 'agent' ? `Claude agent (${task.model ?? 'unknown model'})` : 'Template mode (real OSM data, no LLM; drafts from deterministic templates)';
}

export interface Metrics {
  readonly found: number;
  readonly noWebsite: number;
  readonly withWebsite: number;
  readonly audited: number;
  readonly noHttps: number;
  readonly notMobile: number;
  readonly noChat: number;
  readonly noForm: number;
  readonly unreachable: number;
  readonly skipped: number;
  readonly draftsOk: number;
  readonly draftsDropped: number;
}

export function computeMetrics(records: readonly LeadRecord[]): Metrics {
  const ok = records.filter((r) => r.audit.status === 'ok');
  const count = (pred: (r: LeadRecord) => boolean): number => records.filter(pred).length;
  return {
    found: records.length,
    noWebsite: count((r) => r.audit.status === 'no_website'),
    withWebsite: count((r) => r.business.website !== null),
    audited: ok.length,
    noHttps: ok.filter((r) => r.audit.https === false && r.audit.httpsAvailable === false).length,
    notMobile: ok.filter((r) => r.audit.hasViewport === false).length,
    noChat: ok.filter((r) => r.audit.hasChatWidget === false).length,
    noForm: ok.filter((r) => r.audit.hasContactForm === false).length,
    unreachable: count((r) => r.audit.status === 'fetch_failed' || r.audit.status === 'http_error'),
    skipped: count((r) => ['robots_disallowed', 'robots_unreachable', 'blocked_url', 'invalid_url', 'access_denied', 'not_audited'].includes(r.audit.status)),
    draftsOk: count((r) => r.draft?.status === 'ok'),
    draftsDropped: count((r) => r.draft?.status === 'dropped'),
  };
}

export function buildReport(input: RunSummaryInput): string {
  const { task, records } = input;
  const m = computeMetrics(records);
  const summary = table(['Metric', 'Value'], [
    ['Businesses found', String(m.found)],
    ['No website listed', pct(m.noWebsite, m.found)],
    ['Websites audited successfully', `${m.audited} of ${m.withWebsite}`],
    ['No HTTPS (of audited sites)', pct(m.noHttps, m.audited)],
    ['Not mobile-friendly (of audited sites)', pct(m.notMobile, m.audited)],
    ['No chat widget (of audited sites)', pct(m.noChat, m.audited)],
    ['No contact form on homepage (of audited sites)', pct(m.noForm, m.audited)],
    ['Website unreachable / erroring', String(m.unreachable)],
    ['Audit skipped (robots.txt, blocked URL, bot protection)', String(m.skipped)],
    ['Outreach drafts written / dropped', `${m.draftsOk} / ${m.draftsDropped}`],
    ['Stop reason', `\`${input.stopReason}\`${input.stopDetail ? ` (${mdEscape(input.stopDetail)})` : ''}`],
    ['LLM cost (estimated)', input.cost ? `$${input.cost.usd.toFixed(4)} over ${input.cost.calls} calls` : 'none (no LLM used)'],
  ]);
  const top = table(
    ['#', 'Business', 'Score', 'Website', 'Why'],
    records.slice(0, 10).map((r) => [
      String(r.rank),
      mdEscape(r.business.name),
      String(r.lead.score),
      r.business.website ? mdEscape(hostOf(r.audit.finalUrl ?? r.business.website)) : '(none)',
      mdEscape(r.lead.reasons.join('; ')) || '-',
    ]),
  );
  return [
    `# Lead research report: ${mdEscape(task.niche)} in ${mdEscape(task.city)}`,
    '',
    `- Run: \`${task.runId}\``,
    `- Generated: ${input.generatedAt}`,
    `- Mode: ${modeLabel(task)}`,
    `- Search area: ${mdEscape(input.areaName ?? task.city)}`,
    '',
    '> Nothing has been sent. Every draft in drafts.md needs human review before any outreach.',
    '',
    '## Summary',
    '',
    summary,
    '',
    '## Top 10 leads',
    '',
    top,
    '',
    '## Notes',
    '',
    '- Scores are deterministic (see `src/scoring/weights.ts`); higher means more room for a new website or chat assistant.',
    '- Only the homepage is checked. "No contact form" and "no chat widget" mean none was detected on the homepage.',
    '- Sites whose robots.txt disallows us, that resolve to private addresses, or that block automated access are not audited and no claims are made about them.',
    '- Outreach must comply with CAN-SPAM and local law: real sender identity and postal address, honest subject, working opt-out.',
    `- ${OSM_ATTRIBUTION}`,
    '',
  ].join('\n');
}
