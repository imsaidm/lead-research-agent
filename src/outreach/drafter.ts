import { AGENT_DEFAULTS } from '../config/settings.ts';
import { describeLlmError } from '../llm/anthropic.ts';
import type { BudgetLedger } from '../llm/cost.ts';
import type { LlmProvider, LlmRequest } from '../llm/types.ts';
import type { RunLog } from '../output/run-log.ts';
import type { Audit, Business, DraftResult, Finding } from '../schemas.ts';
import { buildDraftPayload, buildDraftUserMessage, DRAFT_SYSTEM_PROMPT, SUBMIT_DRAFT_TOOL } from './draft-prompt.ts';
import { writeTemplateDraft } from './template-writer.ts';
import { validateDraft } from './validate.ts';

export interface DraftRequest {
  readonly business: Business;
  readonly audit: Audit;
  readonly findings: readonly Finding[];
  readonly city: string;
}

export type Drafter = (request: DraftRequest) => Promise<DraftResult>;

const MAX_ATTEMPTS = 2; // first try + one retry with the validation errors

/** Deterministic drafts for --no-llm mode. Validated like any other draft. */
export function createTemplateDrafter(log: RunLog): Drafter {
  return async ({ business, audit, findings }) => {
    const draft = writeTemplateDraft({ businessName: business.name, niche: business.niche, findings }, 'template');
    if (!draft) return { status: 'dropped', reason: 'no audit findings to mention', attempts: 0, retryable: false };
    const result = validateDraft(draft, { findings, audit, businessName: business.name });
    log.event('draft_attempt', { businessId: business.id, writer: 'template', attempt: 1, ok: result.ok, errors: result.ok ? [] : result.errors });
    return result.ok
      ? { status: 'ok', draft: result.draft, attempts: 1, writer: 'template' }
      : { status: 'dropped', reason: result.errors.join('; '), attempts: 1, retryable: false };
  };
}

/** Model-written drafts: forced submit_draft tool call, zod + fact validation, one retry, then drop. */
export function createLlmDrafter(provider: LlmProvider, ledger: BudgetLedger, log: RunLog): Drafter {
  return async ({ business, audit, findings, city }) => {
    if (findings.length === 0) return { status: 'dropped', reason: 'no audit findings to mention', attempts: 0, retryable: false };
    const payload = buildDraftPayload(business.name, business.niche, city, findings);
    let errors: readonly string[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const request: LlmRequest = {
        purpose: 'draft',
        model: ledger.model,
        system: DRAFT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildDraftUserMessage(payload, errors) }],
        tools: [SUBMIT_DRAFT_TOOL],
        toolChoice: { type: 'tool', name: SUBMIT_DRAFT_TOOL.name },
        maxTokens: AGENT_DEFAULTS.draftMaxTokens,
      };
      if (ledger.wouldExceed(JSON.stringify(request).length, request.maxTokens)) {
        log.event('budget_stop', { where: 'draft', businessId: business.id, spentUsd: ledger.totals.usd });
        return { status: 'dropped', reason: 'budget cap reached before drafting', attempts: attempt - 1, retryable: true };
      }
      const started = performance.now();
      let response;
      try {
        response = await provider.createMessage(request);
      } catch (err) {
        // Transport/API errors are not validation failures: don't burn the retry or feed them to the model.
        const reason = describeLlmError(err);
        log.event('draft_attempt', { businessId: business.id, writer: provider.name, attempt, ok: false, errors: [reason] });
        return { status: 'dropped', reason, attempts: attempt, retryable: true };
      }
      ledger.record(response.usage);
      const call = response.content.find((b) => b.type === 'tool_use' && b.name === SUBMIT_DRAFT_TOOL.name);
      const result = call && call.type === 'tool_use'
        ? validateDraft(call.input, { findings, audit, businessName: business.name })
        : ({ ok: false, errors: ['model did not call submit_draft'] } as const);
      log.event('draft_attempt', {
        businessId: business.id, writer: provider.name, attempt, ok: result.ok,
        errors: result.ok ? [] : result.errors, usage: response.usage, durationMs: Math.round(performance.now() - started),
      });
      if (result.ok) return { status: 'ok', draft: result.draft, attempts: attempt, writer: provider.name === 'mock' ? 'mock' : 'claude' };
      errors = result.errors;
    }
    log.event('draft_dropped', { businessId: business.id, reason: errors });
    return { status: 'dropped', reason: errors.join('; ').slice(0, 500), attempts: MAX_ATTEMPTS, retryable: false };
  };
}
