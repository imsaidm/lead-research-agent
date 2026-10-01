import { z } from 'zod';
import type { ToolDefinition } from '../llm/types.ts';
import {
  AuditInput, AuditOutput, auditWebsites, DraftInput, DraftOutput, draftOutreach, FindInput, FindOutput, findBusinesses,
  SaveInput, SaveOutput, saveResults, ScoreInput, ScoreOutput, scoreLeads, ToolError, type ToolContext,
} from './tools.ts';

/** Tool registry: JSON-schema definitions for the model + zod-validated execution. */
interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly run: (input: never, ctx: ToolContext) => Promise<unknown>;
}

export const TOOL_SPECS: readonly ToolSpec[] = Object.freeze([
  {
    name: 'find_businesses',
    description: 'Search OpenStreetMap for businesses of the run\'s niche in the run\'s city. Returns ids, names and whether a website/phone is listed. Only one search per run; repeated calls return the same list.',
    input: FindInput, output: FindOutput, run: findBusinesses,
  },
  {
    name: 'audit_website',
    description: 'Audit the homepages of the given businesses (HTTPS, mobile viewport, speed, chat widget, contact form, copyright year). Businesses without a website are flagged without fetching. Pass all ids in one call.',
    input: AuditInput, output: AuditOutput, run: auditWebsites,
  },
  {
    name: 'score_lead',
    description: 'Deterministically score audited businesses (0-100, higher = better opportunity) and return them ranked with reasons. Pass all ids in one call.',
    input: ScoreInput, output: ScoreOutput, run: scoreLeads,
  },
  {
    name: 'draft_outreach',
    description: 'Write a short outreach email draft for one scored lead, using only its audit findings. Drafts are for human review and are never sent. Limited number per run.',
    input: DraftInput, output: DraftOutput, run: draftOutreach,
  },
  {
    name: 'save_results',
    description: 'Write leads.csv, leads.json, drafts.md, report.md and cost.json for human review. Call once at the end; this finishes the run.',
    input: SaveInput, output: SaveOutput, run: saveResults,
  },
] satisfies ToolSpec[]);

export function toolDefinitions(): readonly ToolDefinition[] {
  return TOOL_SPECS.map((spec) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(spec.input) as Record<string, unknown>;
    return { name: spec.name, description: spec.description, input_schema: { ...schema, type: 'object' } };
  });
}

export interface ToolExecution {
  readonly content: string;
  readonly isError: boolean;
}

const issuesText = (error: z.ZodError): string =>
  error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ').slice(0, 500);

export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext, step: number): Promise<ToolExecution> {
  const started = performance.now();
  const finish = (ok: boolean, content: string, error?: string): ToolExecution => {
    ctx.log.event('tool_call', {
      step, tool: name, input: rawInput, ok, durationMs: Math.round(performance.now() - started),
      ...(error ? { error } : { output: content.slice(0, 1_500) }),
    });
    return { content, isError: !ok };
  };

  const spec = TOOL_SPECS.find((s) => s.name === name);
  if (!spec) return finish(false, `Error: unknown tool "${name}"`, 'unknown tool');
  const parsed = spec.input.safeParse(rawInput);
  if (!parsed.success) return finish(false, `Error: invalid input: ${issuesText(parsed.error)}`, 'invalid input');

  try {
    const output = await spec.run(parsed.data as never, ctx);
    const checked = spec.output.safeParse(output);
    if (!checked.success) return finish(false, 'Error: tool produced invalid output', `invalid output: ${issuesText(checked.error)}`);
    return finish(true, JSON.stringify(checked.data));
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 300) : 'unknown error';
    // Expected errors go back verbatim; unexpected ones are logged in full but summarized for the model.
    const forModel = err instanceof ToolError ? err.message : 'the tool failed unexpectedly; see run log';
    return finish(false, `Error: ${forModel}`, detail);
  }
}
