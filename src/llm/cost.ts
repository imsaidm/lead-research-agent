import type { LlmUsage } from './types.ts';

/**
 * USD per million tokens. Values are list prices at the time of writing;
 * verify at https://www.anthropic.com/pricing before relying on them.
 * Unknown models fall back to a deliberately expensive rate so the budget
 * cap errs on the side of stopping early.
 */
export interface Pricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

const PRICING: Readonly<Record<string, Pricing>> = Object.freeze({
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-5-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25 },
});

export const FALLBACK_PRICING: Pricing = Object.freeze({ inputPerMTok: 15, outputPerMTok: 75 });

export function pricingFor(model: string): { readonly pricing: Pricing; readonly known: boolean } {
  const base = model.replace(/-\d{8}$/, '');
  const pricing = PRICING[base];
  return pricing ? { pricing, known: true } : { pricing: FALLBACK_PRICING, known: false };
}

/** Cache writes bill at 1.25x input, cache reads at 0.1x input. */
export function costUsd(usage: LlmUsage, pricing: Pricing): number {
  const input =
    usage.inputTokens + usage.cacheCreationInputTokens * 1.25 + usage.cacheReadInputTokens * 0.1;
  return (input * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1_000_000;
}

export interface CostTotals {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly usd: number;
}

export const EMPTY_TOTALS: CostTotals = Object.freeze({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  usd: 0,
});

export function addUsage(totals: CostTotals, usage: LlmUsage, pricing: Pricing): CostTotals {
  return Object.freeze({
    calls: totals.calls + 1,
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    cacheCreationInputTokens: totals.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    cacheReadInputTokens: totals.cacheReadInputTokens + usage.cacheReadInputTokens,
    usd: totals.usd + costUsd(usage, pricing),
  });
}

/** Worst-case cost of the next call: estimated prompt tokens + the full max_tokens of output. */
export function worstCaseCallUsd(promptChars: number, maxTokens: number, pricing: Pricing): number {
  // chars/3 over-counts English; the 1.2x margin covers dense or non-ASCII text.
  const estimatedInputTokens = Math.ceil((promptChars / 3) * 1.2);
  return (estimatedInputTokens * pricing.inputPerMTok + maxTokens * pricing.outputPerMTok) / 1_000_000;
}

/**
 * Shared budget ledger for one run (agent turns + draft calls).
 * State is an immutable snapshot that is replaced on every record.
 */
export class BudgetLedger {
  readonly budgetUsd: number;
  readonly model: string;
  readonly pricing: Pricing;
  readonly pricingKnown: boolean;
  #totals: CostTotals = EMPTY_TOTALS;

  constructor(model: string, budgetUsd: number) {
    const { pricing, known } = pricingFor(model);
    this.model = model;
    this.budgetUsd = budgetUsd;
    this.pricing = pricing;
    this.pricingKnown = known;
  }

  get totals(): CostTotals {
    return this.#totals;
  }

  record(usage: LlmUsage): CostTotals {
    this.#totals = addUsage(this.#totals, usage, this.pricing);
    return this.#totals;
  }

  /** True when the next call could push spending past the cap. */
  wouldExceed(promptChars: number, maxTokens: number): boolean {
    return this.#totals.usd + worstCaseCallUsd(promptChars, maxTokens, this.pricing) > this.budgetUsd;
  }

}
