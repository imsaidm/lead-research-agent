import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunState, Task } from '../agent/state.ts';
import type { SaveSummary } from '../agent/tools.ts';
import { OSM_ATTRIBUTION } from '../config/settings.ts';
import type { BudgetLedger } from '../llm/cost.ts';
import { assembleLeads, osmUrl } from './assemble.ts';
import { leadsToCsv } from './csv.ts';
import { buildDraftsMd } from './drafts-md.ts';
import { buildReport, computeMetrics, modeLabel } from './report.ts';

export interface WriteRunInput {
  readonly dir: string;
  readonly task: Task;
  readonly state: RunState;
  readonly stopReason: string;
  readonly stopDetail: string | null;
  readonly ledger: BudgetLedger | null;
  readonly providerName: string;
  readonly generatedAt: string;
}

function costJson(input: WriteRunInput): unknown {
  const { ledger } = input;
  if (!ledger) return { mode: modeLabel(input.task), provider: input.providerName, llmCalls: 0, estimatedUsd: 0, note: 'No LLM was used in this run.' };
  return {
    mode: modeLabel(input.task),
    provider: input.providerName,
    model: ledger.model,
    pricingUsdPerMTok: ledger.pricing,
    pricingKnown: ledger.pricingKnown,
    budgetUsd: ledger.budgetUsd,
    ...ledger.totals,
    estimatedUsd: Number(ledger.totals.usd.toFixed(6)),
    note: input.providerName === 'mock'
      ? 'MOCK run: token counts are estimates from text length; no API was called and nothing was billed.'
      : 'Estimate from API-reported token usage and list prices; check your Anthropic console for billed amounts.',
  };
}

/** Writes all review artifacts. run-log.jsonl is written incrementally by the RunLog. */
export function writeRunOutputs(input: WriteRunInput): SaveSummary {
  mkdirSync(input.dir, { recursive: true });
  const records = assembleLeads(input.state, input.task.nowYear);
  const leadsJson = {
    runId: input.task.runId,
    generatedAt: input.generatedAt,
    mode: modeLabel(input.task),
    niche: input.task.niche,
    city: input.task.city,
    area: input.state.area,
    stopReason: input.stopReason,
    metrics: computeMetrics(records),
    attribution: OSM_ATTRIBUTION,
    leads: records.map((r) => ({
      rank: r.rank,
      score: r.lead.score,
      reasons: r.lead.reasons,
      findings: r.lead.findings,
      business: { ...r.business, osmUrl: osmUrl(r.business.id) },
      audit: r.audit,
      draft: r.draft,
    })),
  };
  const files: readonly (readonly [string, string])[] = [
    ['leads.csv', leadsToCsv(records)],
    ['leads.json', `${JSON.stringify(leadsJson, null, 2)}\n`],
    ['drafts.md', buildDraftsMd(input.task, records)],
    ['report.md', buildReport({
      task: input.task, records, areaName: input.state.area?.displayName ?? null, stopReason: input.stopReason,
      stopDetail: input.stopDetail, cost: input.ledger?.totals ?? null, generatedAt: input.generatedAt,
    })],
    ['cost.json', `${JSON.stringify(costJson(input), null, 2)}\n`],
  ];
  // Write everything to temp files first so a failure never leaves a half-updated set.
  for (const [name, content] of files) writeFileSync(join(input.dir, `${name}.tmp`), content, 'utf8');
  for (const [name] of files) renameSync(join(input.dir, `${name}.tmp`), join(input.dir, name));
  return { outputDir: input.dir, files: [...files.map(([name]) => name), 'run-log.jsonl'] };
}
