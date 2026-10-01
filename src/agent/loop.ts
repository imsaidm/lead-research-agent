import { AGENT_DEFAULTS } from '../config/settings.ts';
import { describeLlmError } from '../llm/anthropic.ts';
import type { BudgetLedger } from '../llm/cost.ts';
import type { LlmProvider, LlmRequest, Message, ToolResultBlock, ToolUseBlock } from '../llm/types.ts';
import { AGENT_SYSTEM_PROMPT, buildTaskMessage } from './prompt.ts';
import { executeTool, toolDefinitions } from './registry.ts';
import type { ToolContext } from './tools.ts';

export type StopReason =
  | 'saved'
  | 'end_turn'
  | 'max_steps'
  | 'budget_exceeded'
  | 'llm_error'
  | 'llm_max_tokens'
  | 'refusal'
  | 'no_tool_calls'
  | 'completed'
  | 'tool_error'
  | 'save_failed';

export interface LoopLimits {
  readonly maxSteps: number;
}

export interface LoopResult {
  readonly stopReason: StopReason;
  readonly steps: number;
  readonly detail: string | null;
}

/** Text the model wrote plus how it stopped, mapped to our stop reasons. */
function stopFromResponse(stopReason: string, toolUses: readonly ToolUseBlock[]): StopReason | null {
  if (stopReason === 'max_tokens') return 'llm_max_tokens'; // a truncated tool call is never executed
  if (toolUses.length > 0) return null;
  if (stopReason === 'refusal') return 'refusal';
  if (stopReason === 'end_turn') return 'end_turn';
  return 'no_tool_calls';
}

/**
 * The agent loop: model proposes tool calls, we validate + execute them and
 * return results, until the model saves, stops, or a hard limit is hit.
 * Hard limits: max model turns (steps) and a USD budget checked BEFORE each
 * call using the worst-case cost of that call (prompt estimate + max_tokens).
 */
export async function runAgentLoop(
  provider: LlmProvider,
  ledger: BudgetLedger,
  ctx: ToolContext,
  limits: LoopLimits,
): Promise<LoopResult> {
  const tools = toolDefinitions();
  let messages: readonly Message[] = [{ role: 'user', content: buildTaskMessage(ctx.task) }];
  let steps = 0;

  for (;;) {
    if (steps >= limits.maxSteps) return { stopReason: 'max_steps', steps, detail: `reached ${limits.maxSteps} steps` };
    const request: LlmRequest = {
      purpose: 'agent',
      model: ledger.model,
      system: AGENT_SYSTEM_PROMPT,
      messages,
      tools,
      toolChoice: { type: 'auto' },
      maxTokens: AGENT_DEFAULTS.agentMaxTokens,
    };
    if (ledger.wouldExceed(JSON.stringify(request).length, request.maxTokens)) {
      ctx.log.event('budget_stop', { where: 'agent', step: steps, spentUsd: ledger.totals.usd, budgetUsd: ledger.budgetUsd });
      return { stopReason: 'budget_exceeded', steps, detail: `spent $${ledger.totals.usd.toFixed(4)} of $${ledger.budgetUsd}` };
    }

    const started = performance.now();
    let response;
    try {
      response = await provider.createMessage(request);
    } catch (err) {
      const detail = describeLlmError(err);
      ctx.log.event('llm_error', { step: steps, error: detail });
      return { stopReason: 'llm_error', steps, detail };
    }
    steps += 1;
    ledger.record(response.usage);
    ctx.log.event('llm_call', {
      step: steps, purpose: 'agent', model: ledger.model, stopReason: response.stopReason, usage: response.usage,
      durationMs: Math.round(performance.now() - started), totalUsd: ledger.totals.usd,
    });

    const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    messages = [...messages, { role: 'assistant', content: response.content }];
    const stop = stopFromResponse(response.stopReason, toolUses);
    if (stop) return { stopReason: stop, steps, detail: null };

    let results: readonly ToolResultBlock[] = [];
    let saved = false;
    for (const use of toolUses) {
      const exec = await executeTool(use.name, use.input, ctx, steps);
      results = [...results, { type: 'tool_result', tool_use_id: use.id, content: exec.content, ...(exec.isError ? { is_error: true } : {}) }];
      saved = saved || (use.name === 'save_results' && !exec.isError);
    }
    messages = [...messages, { role: 'user', content: results }];
    if (saved) return { stopReason: 'saved', steps, detail: null };
  }
}
