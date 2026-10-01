import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AssistantBlock, LlmProvider, LlmRequest, LlmResponse, ToolResultBlock } from '../src/llm/types.ts';
import { ConfigError, runLeadAgent, type RunOptions } from '../src/run.ts';

const outRoot = mkdtempSync(join(tmpdir(), 'lead-agent-test-'));
afterAll(() => rmSync(outRoot, { recursive: true, force: true }));

const base: RunOptions = {
  niche: 'plumber', city: 'Austin, TX', limit: 15, maxDrafts: 5, maxSteps: 20, budgetUsd: 0.5,
  offline: true, noLlm: false, model: 'claude-haiku-4-5-20251001', contact: 'test@example.com', outRoot, apiKey: null,
  now: new Date('2026-10-01T00:00:00Z'),
};

const usage = (inputTokens = 100, outputTokens = 20) => ({ inputTokens, outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });

function scripted(step: (req: LlmRequest, call: number) => readonly AssistantBlock[], tokens = usage()): LlmProvider & { calls: () => LlmRequest[] } {
  let calls: LlmRequest[] = [];
  return {
    name: 'scripted',
    calls: () => calls,
    async createMessage(req): Promise<LlmResponse> {
      calls = [...calls, req];
      const content = step(req, calls.length);
      return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: tokens };
    },
  };
}

const lastToolResults = (req: LlmRequest): readonly ToolResultBlock[] => {
  const last = req.messages[req.messages.length - 1];
  return last && last.role === 'user' && typeof last.content !== 'string' ? (last.content.filter((b) => b.type === 'tool_result') as ToolResultBlock[]) : [];
};

const readOut = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8');

describe('agent loop (mock LLM, offline fixtures)', () => {
  it('runs the full tool sequence and saves every artifact', async () => {
    const r = await runLeadAgent(base);
    expect(r.loop.stopReason).toBe('saved');
    expect(r.records.slice(0, 3).map((x) => x.business.name)).toEqual(['Lone Star Plumbing', 'Barton Creek Plumbing', 'Eastside Drain Pros']);
    expect(r.records.filter((x) => x.draft?.status === 'ok')).toHaveLength(5);
    for (const f of ['leads.csv', 'leads.json', 'drafts.md', 'report.md', 'run-log.jsonl', 'cost.json']) expect(existsSync(join(r.saved.outputDir, f))).toBe(true);
    const tools = readOut(r.saved.outputDir, 'run-log.jsonl').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'tool_call').map((e) => e.tool);
    expect(new Set(tools)).toEqual(new Set(['find_businesses', 'audit_website', 'score_lead', 'draft_outreach', 'save_results']));
    expect(readOut(r.saved.outputDir, 'drafts.md')).toContain('MOCK');
    expect(JSON.parse(readOut(r.saved.outputDir, 'cost.json')).calls).toBe(r.ledger?.totals.calls);
  });

  it('stops at max steps and still writes results', async () => {
    const p = scripted((_req, n) => [{ type: 'tool_use', id: `t${n}`, name: 'score_lead', input: { business_ids: ['osm-node-1'] } }]);
    const r = await runLeadAgent({ ...base, provider: p, maxSteps: 3 });
    expect(r.loop).toMatchObject({ stopReason: 'max_steps', steps: 3 });
    expect(p.calls()).toHaveLength(3);
    expect(readOut(r.saved.outputDir, 'report.md')).toContain('max_steps');
  });

  it('stops when the budget cap would be exceeded (checked before each call)', async () => {
    const p = scripted((_req, n) => [{ type: 'tool_use', id: `t${n}`, name: 'score_lead', input: { business_ids: ['osm-node-1'] } }], usage(40_000, 2_000));
    const r = await runLeadAgent({ ...base, provider: p, budgetUsd: 0.1 });
    expect(r.loop.stopReason).toBe('budget_exceeded');
    expect(r.ledger?.totals.usd ?? 0).toBeLessThanOrEqual(0.1);
    expect(p.calls().length).toBeGreaterThanOrEqual(1);
  });

  it('makes no call at all when even one call could exceed the budget', async () => {
    const p = scripted(() => [{ type: 'text', text: 'hi' }]);
    const r = await runLeadAgent({ ...base, provider: p, budgetUsd: 0.0001 });
    expect(r.loop).toMatchObject({ stopReason: 'budget_exceeded', steps: 0 });
    expect(p.calls()).toHaveLength(0);
  });

  it('turns LLM exceptions into a clean stop with outputs written', async () => {
    const p: LlmProvider = { name: 'broken', createMessage: async () => { throw new Error('boom'); } };
    const r = await runLeadAgent({ ...base, provider: p });
    expect(r.loop.stopReason).toBe('llm_error');
    expect(existsSync(join(r.saved.outputDir, 'report.md'))).toBe(true);
  });

  it('returns validation errors to the model for bad input, unknown tools and out-of-scope searches', async () => {
    const p = scripted((req, n) => {
      if (n === 1) return [
        { type: 'tool_use', id: 'a', name: 'find_businesses', input: { niche: 'plumber', city: 'Dallas, TX', limit: 5 } },
        { type: 'tool_use', id: 'b', name: 'audit_website', input: { business_ids: ['../../etc/passwd'] } },
        { type: 'tool_use', id: 'c', name: 'rm_rf', input: {} },
      ];
      const results = lastToolResults(req);
      expect(results.map((x) => x.is_error)).toEqual([true, true, true]);
      expect(results[0]?.content).toMatch(/out of scope/);
      expect(results[1]?.content).toMatch(/invalid input/);
      expect(results[2]?.content).toMatch(/unknown tool/);
      return [{ type: 'text', text: 'giving up' }];
    });
    const r = await runLeadAgent({ ...base, provider: p });
    expect(r.loop.stopReason).toBe('end_turn');
    expect(p.calls()).toHaveLength(2);
  });

  it('enforces the per-run draft limit', async () => {
    const r = await runLeadAgent({ ...base, maxDrafts: 2 });
    expect(r.records.filter((x) => x.draft !== null)).toHaveLength(2);
  });
});

describe('LLM drafter: validation, retry once, then drop', () => {
  const agentScript = (draftInputs: readonly unknown[]) => {
    let draftCalls = 0;
    return scripted((req, n) => {
      if (req.purpose === 'draft') {
        const input = draftInputs[Math.min(draftCalls, draftInputs.length - 1)];
        draftCalls += 1;
        return [{ type: 'tool_use', id: `d${n}`, name: 'submit_draft', input }];
      }
      const step = req.messages.filter((m) => m.role === 'assistant').length;
      const script = [
        { name: 'find_businesses', input: { niche: 'plumber', city: 'Austin, TX', limit: 15 } },
        { name: 'draft_outreach', input: { business_id: 'osm-node-1002' } },
      ][step];
      return script ? [{ type: 'tool_use', id: `s${n}`, ...script }] : [{ type: 'text', text: 'done' }];
    });
  };
  const goodDraft = {
    subject: 'Barton Creek Plumbing online',
    body: "Hi there,\n\nI couldn't find a website for your business on the map.\n\nReply 'no thanks' and I won't follow up.\n\n[Your Name]\n[Your Company]",
    findings_used: ['no_website'],
  };
  const falseClaim = { ...goodDraft, body: goodDraft.body.replace('on the map.', 'and your live chat is missing.') };

  it('accepts a valid draft on the second attempt', async () => {
    const r = await runLeadAgent({ ...base, provider: agentScript([falseClaim, goodDraft]) });
    const draft = r.records.find((x) => x.business.id === 'osm-node-1002')?.draft;
    expect(draft).toMatchObject({ status: 'ok', attempts: 2, writer: 'claude' });
  });

  it('drops and logs drafts that fail twice (false claim)', async () => {
    const r = await runLeadAgent({ ...base, provider: agentScript([falseClaim]) });
    const draft = r.records.find((x) => x.business.id === 'osm-node-1002')?.draft;
    expect(draft).toMatchObject({ status: 'dropped', attempts: 2 });
    expect(readOut(r.saved.outputDir, 'run-log.jsonl')).toContain('draft_dropped');
    expect(readOut(r.saved.outputDir, 'drafts.md')).toContain('Dropped drafts');
  });
});

describe('template mode and configuration', () => {
  it('--no-llm runs the fixed pipeline with template drafts and no LLM cost', async () => {
    const r = await runLeadAgent({ ...base, noLlm: true });
    expect(r.loop.stopReason).toBe('completed');
    expect(r.ledger).toBeNull();
    const drafts = r.records.filter((x) => x.draft?.status === 'ok');
    expect(drafts).toHaveLength(5);
    expect(drafts.every((x) => x.draft?.status === 'ok' && x.draft.writer === 'template')).toBe(true);
    const md = readOut(r.saved.outputDir, 'drafts.md');
    expect(md).toContain('not AI-written');
    expect(md).not.toContain('MOCK DRAFT');
    expect(JSON.parse(readOut(r.saved.outputDir, 'cost.json')).llmCalls).toBe(0);
  });

  it('real agent mode without an API key fails with a hint to use --mock or --no-llm', async () => {
    await expect(runLeadAgent({ ...base, offline: false })).rejects.toThrow(ConfigError);
    await expect(runLeadAgent({ ...base, offline: false })).rejects.toThrow(/--mock.*--no-llm/);
  });
});

describe('draft transport errors (code review regression)', () => {
  it('a transport error drops the draft as retryable without consuming the validation retry', async () => {
    let draftCalls = 0;
    const p = scripted((req, n) => {
      if (req.purpose === 'draft') {
        draftCalls += 1;
        throw new Error('ECONNRESET');
      }
      const step = req.messages.filter((m) => m.role === 'assistant').length;
      const script = [
        { name: 'find_businesses', input: { niche: 'plumber', city: 'Austin, TX', limit: 15 } },
        { name: 'draft_outreach', input: { business_id: 'osm-node-1002' } },
      ][step];
      return script ? [{ type: 'tool_use', id: `s${n}`, ...script }] : [{ type: 'text', text: 'done' }];
    });
    const r = await runLeadAgent({ ...base, provider: p });
    expect(draftCalls).toBe(1);
    expect(r.records.find((x) => x.business.id === 'osm-node-1002')?.draft).toMatchObject({ status: 'dropped', retryable: true, attempts: 1 });
  });

  it('a max_tokens stop never executes a possibly truncated tool call', async () => {
    const p: LlmProvider = {
      name: 'truncating',
      createMessage: async () => ({
        content: [{ type: 'tool_use', id: 't', name: 'save_results', input: {} }],
        stopReason: 'max_tokens',
        usage: usage(),
      }),
    };
    const r = await runLeadAgent({ ...base, provider: p });
    expect(r.loop.stopReason).toBe('llm_max_tokens');
    expect(readOut(r.saved.outputDir, 'run-log.jsonl')).not.toContain('"tool":"save_results"');
  });
});
