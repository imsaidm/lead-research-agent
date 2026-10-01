import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runAgentLoop, type LoopResult } from './agent/loop.ts';
import { runTemplatePipeline } from './agent/pipeline.ts';
import { createStore, type Task } from './agent/state.ts';
import type { SaveSummary, ToolContext } from './agent/tools.ts';
import { auditWebsite } from './audit/audit-website.ts';
import { createRobotsChecker } from './audit/robots-check.ts';
import { FETCH_LIMITS, OSM_LIMITS, TOOL_NAME, userAgent } from './config/settings.ts';
import { createAnthropicProvider } from './llm/anthropic.ts';
import { BudgetLedger } from './llm/cost.ts';
import { createMockProvider, createNoneProvider } from './llm/mock.ts';
import type { LlmProvider } from './llm/types.ts';
import { createHttpGetterFor } from './net/getter-factory.ts';
import { createIntervalLimiter } from './net/limiter.ts';
import { createLlmDrafter, createTemplateDrafter } from './outreach/drafter.ts';
import { assembleLeads, type LeadRecord } from './output/assemble.ts';
import { createRunLog, errorMessage } from './output/run-log.ts';
import { writeRunOutputs } from './output/write-run.ts';
import { createFixtureOsmSource, createOsmSource } from './sources/osm-source.ts';

export interface FixturePaths {
  readonly nominatim: URL;
  readonly overpass: URL;
  readonly sites: URL;
}

export const DEFAULT_FIXTURES: FixturePaths = Object.freeze({
  nominatim: new URL('../fixtures/osm/nominatim.json', import.meta.url),
  overpass: new URL('../fixtures/osm/overpass.json', import.meta.url),
  sites: new URL('../fixtures/sites/', import.meta.url),
});

export interface RunOptions {
  readonly niche: string;
  readonly city: string;
  readonly limit: number;
  readonly maxDrafts: number;
  readonly maxSteps: number;
  readonly budgetUsd: number;
  /** --mock: offline fixtures + mock LLM. */
  readonly offline: boolean;
  /** --no-llm: template mode. */
  readonly noLlm: boolean;
  readonly model: string;
  readonly contact: string | null;
  readonly outRoot: string;
  readonly apiKey: string | null;
  readonly now?: Date;
  readonly fixtures?: FixturePaths;
  /** Tests only: replaces the provider chosen by mode. */
  readonly provider?: LlmProvider;
}

export interface RunResult {
  readonly task: Task;
  readonly loop: LoopResult;
  readonly saved: SaveSummary;
  readonly records: readonly LeadRecord[];
  readonly ledger: BudgetLedger | null;
}

export class ConfigError extends Error {}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'city';

function chooseProvider(opts: RunOptions): LlmProvider {
  if (opts.provider) return opts.provider;
  if (opts.noLlm) return createNoneProvider();
  if (opts.offline) return createMockProvider();
  if (!opts.apiKey) {
    throw new ConfigError(
      'ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example), or run with --mock (offline demo) or --no-llm (real data, template drafts).',
    );
  }
  return createAnthropicProvider(opts.apiKey);
}

export async function runLeadAgent(opts: RunOptions): Promise<RunResult> {
  const provider = chooseProvider(opts);
  const now = opts.now ?? new Date();
  const runId = `${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z-${slug(opts.niche)}-${slug(opts.city)}${opts.offline ? '-mock' : ''}-${randomBytes(3).toString('hex')}`;
  const dir = join(opts.outRoot, runId);
  mkdirSync(dir, { recursive: true });

  const task: Task = Object.freeze({
    runId, niche: opts.niche, city: opts.city, limit: opts.limit, maxDrafts: opts.maxDrafts, nowYear: now.getUTCFullYear(),
    mode: opts.noLlm ? 'template' : 'agent', offline: opts.offline, model: opts.noLlm ? null : opts.model,
  });
  const log = createRunLog(join(dir, 'run-log.jsonl'));
  log.event('run_start', { task, provider: provider.name, limits: { maxSteps: opts.maxSteps, budgetUsd: opts.budgetUsd, fetch: FETCH_LIMITS } });

  const ua = userAgent(opts.contact);
  const fixtures = opts.fixtures ?? DEFAULT_FIXTURES;
  const get = createHttpGetterFor(opts.offline ? { kind: 'fixture', sites: fixtures.sites } : { kind: 'real', userAgent: ua });
  const robots = createRobotsChecker(get, TOOL_NAME);
  const osm = opts.offline
    ? createFixtureOsmSource(fixtures.nominatim, fixtures.overpass)
    : createOsmSource(ua, createIntervalLimiter(OSM_LIMITS.nominatimMinIntervalMs));
  const ledger = task.mode === 'agent' ? new BudgetLedger(opts.model, opts.budgetUsd) : null;
  const drafter = ledger ? createLlmDrafter(provider, ledger, log) : createTemplateDrafter(log);
  const store = createStore();

  let stop: { reason: string; detail: string | null } = { reason: 'running', detail: null };
  const save = async (reason: string): Promise<SaveSummary> =>
    writeRunOutputs({
      dir, task, state: store.get(), stopReason: stop.reason === 'running' ? reason : stop.reason, stopDetail: stop.detail,
      ledger, providerName: provider.name, generatedAt: new Date().toISOString(),
    });

  const ctx: ToolContext = {
    task, store, osm, drafter, save, log,
    audit: (business) => auditWebsite(business, { get, robots, nowYear: task.nowYear }),
  };

  let loop: LoopResult;
  try {
    loop = ledger ? await runAgentLoop(provider, ledger, ctx, { maxSteps: opts.maxSteps }) : await runTemplatePipeline(ctx);
  } catch (err) {
    loop = { stopReason: 'tool_error', steps: 0, detail: `unexpected: ${errorMessage(err)}`.slice(0, 300) };
  }
  stop = { reason: loop.stopReason, detail: loop.detail };
  // Always (re)write outputs with the final stop reason, even if the model never called save_results.
  let saved: SaveSummary;
  try {
    saved = await save(loop.stopReason);
  } catch (err) {
    loop = { ...loop, stopReason: 'save_failed', detail: `could not write outputs: ${errorMessage(err)}`.slice(0, 300) };
    saved = { outputDir: dir, files: ['run-log.jsonl'] };
  }
  log.event('run_end', { stopReason: loop.stopReason, steps: loop.steps, detail: loop.detail, cost: ledger?.totals ?? null });
  return { task, loop, saved, records: assembleLeads(store.get(), task.nowYear), ledger };
}
