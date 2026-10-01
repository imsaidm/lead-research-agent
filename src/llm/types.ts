/**
 * Provider-neutral subset of the Anthropic Messages API shapes we use.
 * The real provider passes these straight to `client.messages.create`;
 * the mock provider produces the same shapes offline.
 */
export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

export type AssistantBlock = TextBlock | ToolUseBlock;

export type Message =
  | { readonly role: 'user'; readonly content: string | readonly (TextBlock | ToolResultBlock)[] }
  | { readonly role: 'assistant'; readonly content: readonly AssistantBlock[] };

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: { readonly type: 'object'; readonly [key: string]: unknown };
}

export type ToolChoice = { readonly type: 'auto' } | { readonly type: 'any' } | { readonly type: 'tool'; readonly name: string };

export interface LlmRequest {
  readonly purpose: 'agent' | 'draft';
  readonly model: string;
  readonly system: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: ToolChoice;
  readonly maxTokens: number;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface LlmResponse {
  readonly content: readonly AssistantBlock[];
  readonly stopReason: string;
  readonly usage: LlmUsage;
}

export interface LlmProvider {
  readonly name: 'anthropic' | 'mock' | string;
  createMessage(request: LlmRequest): Promise<LlmResponse>;
}
