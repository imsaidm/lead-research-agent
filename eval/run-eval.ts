import { existsSync } from 'node:fs';
import { createAnthropicProvider } from '../src/llm/anthropic.ts';
import { resolveModel } from '../src/args.ts';
import { validateDraft, wordCount, MAX_BODY_WORDS, OPT_OUT_LINE } from '../src/outreach/validate.ts';
import { DEFAULT_FIXTURES, runLeadAgent } from '../src/run.ts';
import type { LeadRecord } from '../src/output/assemble.ts';
import { EXPECTATIONS, EXPECTED_TOP3 } from './expectations.ts';

/**
 * Small offline eval: 8 fictional businesses with known properties.
 * Default: mock LLM (free, deterministic). `npm run eval -- --real` runs the same
 * fixtures through Claude (needs ANTHROPIC_API_KEY) to grade model-written drafts.
 */

interface Row {
  readonly check: string;
  readonly subject: string;
  readonly pass: boolean;
  readonly detail: string;
}

function draftRows(r: LeadRecord): readonly Row[] {
  if (r.draft === null) return [];
  if (r.draft.status !== 'ok') return [{ check: 'draft produced', subject: r.business.name, pass: false, detail: r.draft.reason.slice(0, 80) }];
  const d = r.draft.draft;
  const facts = validateDraft(d, { findings: r.lead.findings, audit: r.audit, businessName: r.business.name });
  const optOut = d.body.toLowerCase().includes(OPT_OUT_LINE.toLowerCase().replace(/\.$/, ''));
  return [
    { check: 'draft: only audit facts', subject: r.business.name, pass: facts.ok, detail: facts.ok ? `uses ${d.findings_used.join(', ')}` : facts.errors.join('; ').slice(0, 80) },
    { check: 'draft: within limits', subject: r.business.name, pass: d.subject.length <= 60 && wordCount(d.body) <= MAX_BODY_WORDS, detail: `subject ${d.subject.length} chars, body ${wordCount(d.body)} words` },
    { check: 'draft: opt-out line', subject: r.business.name, pass: optOut, detail: optOut ? 'present' : 'missing' },
  ];
}

function auditRows(records: readonly LeadRecord[]): readonly Row[] {
  return EXPECTATIONS.map((e) => {
    const r = records.find((x) => x.business.id === e.id);
    if (!r) return { check: 'audit: expected findings', subject: e.name, pass: false, detail: 'business not found' };
    const ids = r.lead.findings.map((f) => f.id);
    const missing = e.mustHave.filter((f) => !ids.includes(f));
    const unexpected = e.mustNotHave.filter((f) => ids.includes(f));
    const pass = r.audit.status === e.status && missing.length === 0 && unexpected.length === 0;
    const detail = pass
      ? `${r.audit.status}; score ${r.lead.score}`
      : `status ${r.audit.status} (want ${e.status}) missing [${missing.join(',')}] unexpected [${unexpected.join(',')}]`;
    return { check: 'audit: expected findings', subject: e.name, pass, detail };
  });
}

function printTable(rows: readonly Row[]): void {
  const widths = [26, 24, 6];
  const pad = (s: string, w: number): string => (s.length > w ? `${s.slice(0, w - 1)}~` : s.padEnd(w));
  const line = (c: readonly string[]): string => `${pad(c[0] ?? '', widths[0] ?? 0)} | ${pad(c[1] ?? '', widths[1] ?? 0)} | ${pad(c[2] ?? '', widths[2] ?? 0)} | ${c[3] ?? ''}`;
  process.stdout.write(`${line(['Check', 'Business', 'Result', 'Detail'])}\n${'-'.repeat(100)}\n`);
  for (const r of rows) process.stdout.write(`${line([r.check, r.subject, r.pass ? 'PASS' : 'FAIL', r.detail])}\n`);
}

async function main(): Promise<number> {
  const real = process.argv.includes('--real');
  if (existsSync('.env')) process.loadEnvFile('.env');
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
  if (real && !apiKey) {
    process.stderr.write('--real needs ANTHROPIC_API_KEY in .env. Run `npm run eval` (mock) instead.\n');
    return 2;
  }
  const result = await runLeadAgent({
    niche: 'plumber', city: 'Austin, TX', limit: 8, maxDrafts: 5, maxSteps: 12, budgetUsd: 0.25,
    offline: true, noLlm: false, model: resolveModel(process.env), contact: 'eval@example.com', outRoot: 'out/eval', apiKey,
    now: new Date('2026-10-01T00:00:00Z'),
    fixtures: { ...DEFAULT_FIXTURES, overpass: new URL('../fixtures/eval/overpass.json', import.meta.url) },
    ...(real && apiKey ? { provider: createAnthropicProvider(apiKey) } : {}),
  });

  const top3 = result.records.slice(0, 3).map((r) => r.business.id);
  const rows: readonly Row[] = [
    { check: 'run: finished cleanly', subject: '-', pass: ['saved', 'end_turn'].includes(result.loop.stopReason), detail: `${result.loop.stopReason} after ${result.loop.steps} steps` },
    { check: 'run: found all businesses', subject: '-', pass: result.records.length === EXPECTATIONS.length, detail: `${result.records.length} of ${EXPECTATIONS.length}` },
    ...auditRows(result.records),
    { check: 'ranking: top-3 matches', subject: '-', pass: top3.join() === EXPECTED_TOP3.join(), detail: top3.join(', ') },
    { check: 'drafts: top leads drafted', subject: '-', pass: result.records.filter((r) => r.draft?.status === 'ok').length >= 3, detail: `${result.records.filter((r) => r.draft?.status === 'ok').length} drafts` },
    ...result.records.flatMap(draftRows),
  ];
  process.stdout.write(`Eval (${real ? 'Claude' : 'mock LLM'}) on ${EXPECTATIONS.length} fixture businesses\n\n`);
  printTable(rows);
  const failed = rows.filter((r) => !r.pass).length;
  process.stdout.write(`\n${rows.length - failed}/${rows.length} checks passed. Cost: $${(result.ledger?.totals.usd ?? 0).toFixed(4)}${real ? '' : ' (mock estimate)'}. Output: ${result.saved.outputDir}\n`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`Eval error: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
