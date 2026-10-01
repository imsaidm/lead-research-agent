import { extractTask } from '../agent/prompt.ts';
import { extractDraftPayload } from '../outreach/draft-prompt.ts';
import { writeTemplateDraft } from '../outreach/template-writer.ts';
import { WEIGHTS } from '../scoring/weights.ts';
import type { AssistantBlock, LlmProvider, LlmRequest, LlmResponse, Message, ToolUseBlock } from './types.ts';

/**
 * Offline, deterministic stand-in for Claude. It replays the intended tool-call
 * sequence (find -> audit -> score -> drafts -> save) by reading previous tool
 * results, and writes template drafts labelled MOCK. Token usage is estimated
 * from text length so budget accounting can be exercised without an API key.
 */

const estimateTokens = (value: unknown): number => Math.ceil(JSON.stringify(value).length / 4);

function toolUse(messages: readonly Message[], index: number, name: string, input: unknown): ToolUseBlock {
  return { type: 'tool_use', id: `mock_toolu_${messages.length}_${index}`, name, input };
}

function lastAssistantTool(messages: readonly Message[]): string | null {
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!last || last.role !== 'assistant') return null;
  return last.content.find((b): b is ToolUseBlock => b.type === 'tool_use')?.name ?? null;
}

/** Parsed JSON of tool results answering calls to `toolName`, newest first. */
function resultsFor(messages: readonly Message[], toolName: string): readonly unknown[] {
  const ids = new Set(
    messages.flatMap((m) => (m.role === 'assistant' ? m.content.filter((b): b is ToolUseBlock => b.type === 'tool_use' && b.name === toolName).map((b) => b.id) : [])),
  );
  return messages
    .flatMap((m) => (m.role === 'user' && typeof m.content !== 'string' ? m.content : []))
    .filter((b) => b.type === 'tool_result' && ids.has(b.tool_use_id) && !b.is_error)
    .map((b) => (b.type === 'tool_result' ? safeJson(b.content) : null))
    .filter((x) => x !== null)
    .reverse();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type Biz = { business_id: string; has_website: boolean };
type Score = { business_id: string; score: number; findings: string[] };

function nextAgentStep(messages: readonly Message[]): readonly AssistantBlock[] {
  const first = messages[0];
  const task = first && typeof first.content === 'string' ? extractTask(first.content) : null;
  if (!task) return [{ type: 'text', text: 'MOCK: no task found.' }];
  const found = resultsFor(messages, 'find_businesses')[0] as { businesses?: Biz[] } | undefined;
  const all = found?.businesses ?? [];
  const call = (name: string, input: unknown): readonly AssistantBlock[] => [
    { type: 'text', text: `MOCK: calling ${name}.` },
    toolUse(messages, 0, name, input),
  ];

  switch (lastAssistantTool(messages)) {
    case null:
      return call('find_businesses', { niche: task.niche, city: task.city, limit: task.limit });
    case 'find_businesses': {
      if (!found) return [{ type: 'text', text: 'MOCK: search failed, stopping.' }];
      const withSite = all.filter((b) => b.has_website).map((b) => b.business_id);
      if (withSite.length > 0) return call('audit_website', { business_ids: withSite });
      return all.length > 0 ? call('score_lead', { business_ids: all.map((b) => b.business_id) }) : call('save_results', {});
    }
    case 'audit_website':
      return call('score_lead', { business_ids: all.map((b) => b.business_id) });
    case 'score_lead': {
      const scores = ((resultsFor(messages, 'score_lead')[0] as { scores?: Score[] } | undefined)?.scores ?? [])
        .filter((s) => s.findings.length > 0)
        .slice(0, task.max_drafts);
      if (scores.length === 0) return call('save_results', {});
      return [
        { type: 'text', text: `MOCK: drafting ${scores.length} emails.` },
        ...scores.map((s, i) => toolUse(messages, i, 'draft_outreach', { business_id: s.business_id })),
      ];
    }
    case 'draft_outreach':
      return call('save_results', {});
    default:
      return [{ type: 'text', text: 'MOCK: done.' }];
  }
}

function draftStep(request: LlmRequest): readonly AssistantBlock[] {
  const first = request.messages[0];
  const payload = first && typeof first.content === 'string' ? extractDraftPayload(first.content) : null;
  if (!payload) return [{ type: 'text', text: 'MOCK: could not read the lead.' }];
  const findings = payload.findings.map((f) => ({ ...f, weight: WEIGHTS[f.id] }));
  const draft = writeTemplateDraft({ businessName: payload.business_name, niche: payload.niche, findings }, 'mock');
  if (!draft) return [{ type: 'text', text: 'MOCK: nothing to write.' }];
  return [{ type: 'tool_use', id: `mock_draft_${payload.business_name.length}`, name: 'submit_draft', input: draft }];
}

export function createMockProvider(): LlmProvider {
  return {
    name: 'mock',
    async createMessage(request: LlmRequest): Promise<LlmResponse> {
      const content = request.purpose === 'draft' ? draftStep(request) : nextAgentStep(request.messages);
      const hasTool = content.some((b) => b.type === 'tool_use');
      return {
        content,
        stopReason: hasTool ? 'tool_use' : 'end_turn',
        usage: {
          inputTokens: estimateTokens({ s: request.system, m: request.messages, t: request.tools }),
          outputTokens: estimateTokens(content),
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      };
    },
  };
}

/** Provider for --no-llm runs: any call is a programming error. */
export function createNoneProvider(): LlmProvider {
  return {
    name: 'none',
    async createMessage(): Promise<LlmResponse> {
      throw new Error('LLM disabled (--no-llm): no model calls are made in template mode');
    },
  };
}
