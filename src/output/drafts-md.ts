import type { Task } from '../agent/state.ts';
import type { LeadRecord } from './assemble.ts';
import { osmUrl } from './assemble.ts';
import { hostOf, mdEscape } from './markdown.ts';

const WRITER_LABEL: Readonly<Record<string, string>> = Object.freeze({
  template: 'template (deterministic text built from audit facts; not AI-written)',
  mock: 'MOCK (offline template standing in for Claude)',
  claude: 'Claude (model-written, validated against audit facts)',
});

/** A code fence longer than any backtick run in the body, so the body can never close it. */
export function fence(body: string): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function draftSection(r: LeadRecord): string {
  if (r.draft?.status !== 'ok') return '';
  const { draft, writer, attempts } = r.draft;
  const used = r.lead.findings.filter((f) => draft.findings_used.includes(f.id));
  return [
    `## ${r.rank}. ${mdEscape(r.business.name)} (score ${r.lead.score})`,
    '',
    `- Writer: ${WRITER_LABEL[writer] ?? writer}${attempts > 1 ? ` - passed on attempt ${attempts}` : ''}`,
    `- Website: ${r.business.website ? mdEscape(hostOf(r.business.website)) : '(none listed)'} | Phone: ${mdEscape(r.business.phone) || '-'} | OSM: ${osmUrl(r.business.id)}`,
    '- Facts this draft relies on (verify before sending):',
    ...used.map((f) => `  - \`${f.id}\`: ${mdEscape(f.evidence)}`),
    '',
    `**Subject:** ${mdEscape(draft.subject)}`,
    '',
    `${fence(draft.body)}text`,
    draft.body,
    fence(draft.body),
    '',
  ].join('\n');
}

export function buildDraftsMd(task: Task, records: readonly LeadRecord[]): string {
  const ok = records.filter((r) => r.draft?.status === 'ok');
  const dropped = records.filter((r) => r.draft?.status === 'dropped');
  return [
    `# Outreach drafts: ${mdEscape(task.niche)} in ${mdEscape(task.city)}`,
    '',
    '> DRAFTS ONLY. Nothing has been sent and this tool cannot send email.',
    '> Before sending: re-check every claim, replace [Your Name]/[Your Company], add your real postal address',
    '> (CAN-SPAM), find the business\'s published contact address yourself, and honour every opt-out.',
    '',
    ok.length ? ok.map(draftSection).join('\n') : '_No drafts were written in this run._\n',
    ...(dropped.length
      ? ['## Dropped drafts', '', ...dropped.map((r) => `- ${mdEscape(r.business.name)}: ${mdEscape(r.draft?.status === 'dropped' ? r.draft.reason : '')}`), '']
      : []),
  ].join('\n');
}
