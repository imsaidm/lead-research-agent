import Anthropic from '@anthropic-ai/sdk';
import type { AssistantBlock, LlmProvider, LlmRequest, LlmResponse } from './types.ts';

/** Token counts feed the budget ledger, so anything odd is treated conservatively. */
const tokens = (n: number | null | undefined): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.ceil(n) : 0);

/**
 * Real provider: a thin adapter over `client.messages.create` (Messages API with
 * client-side tools). Only text and tool_use blocks are kept; anything else the
 * API might return is dropped so downstream code sees a closed set of shapes.
 */
export function createAnthropicProvider(apiKey: string): LlmProvider {
  // baseURL is pinned so an ANTHROPIC_BASE_URL in the environment can never redirect the key elsewhere.
  const client = new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 2, timeout: 60_000 });

  return {
    name: 'anthropic',
    async createMessage(request: LlmRequest): Promise<LlmResponse> {
      const response = await client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages as Anthropic.MessageParam[],
        ...(request.tools ? { tools: request.tools as Anthropic.Tool[] } : {}),
        ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      });

      const content: AssistantBlock[] = response.content.flatMap((block): AssistantBlock[] => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }];
        if (block.type === 'tool_use') return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }];
        return [];
      });

      return {
        content,
        stopReason: response.stop_reason ?? 'unknown',
        usage: {
          inputTokens: tokens(response.usage.input_tokens),
          outputTokens: tokens(response.usage.output_tokens),
          cacheCreationInputTokens: tokens(response.usage.cache_creation_input_tokens),
          cacheReadInputTokens: tokens(response.usage.cache_read_input_tokens),
        },
      };
    },
  };
}

/** Error text safe to log: never includes request headers or the API key. */
export function describeLlmError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error ${err.status ?? ''} ${err.name}: ${err.message}`.slice(0, 300);
  }
  return `LLM call failed: ${(err as Error)?.message ?? String(err)}`.slice(0, 300);
}
