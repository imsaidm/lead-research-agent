import { z } from 'zod';
import type { LoopResult } from './loop.ts';
import { executeTool } from './registry.ts';
import { ScoreOutput, type ToolContext } from './tools.ts';

/**
 * Template mode (--no-llm): the same tools in a fixed order, no model involved.
 * find -> audit (all with a website) -> score -> template drafts for the top leads.
 */
export async function runTemplatePipeline(ctx: ToolContext): Promise<LoopResult> {
  let step = 0;
  const { task } = ctx;

  const find = await executeTool('find_businesses', { niche: task.niche, city: task.city, limit: task.limit }, ctx, ++step);
  if (find.isError) return { stopReason: 'tool_error', steps: step, detail: find.content };

  const businesses = ctx.store.get().businesses;
  const withSite = businesses.filter((b) => b.website !== null).map((b) => b.id);
  if (withSite.length > 0) {
    const audit = await executeTool('audit_website', { business_ids: withSite }, ctx, ++step);
    if (audit.isError) return { stopReason: 'tool_error', steps: step, detail: audit.content };
  }
  if (businesses.length === 0) return { stopReason: 'completed', steps: step, detail: 'no businesses found' };

  const score = await executeTool('score_lead', { business_ids: businesses.map((b) => b.id) }, ctx, ++step);
  if (score.isError) return { stopReason: 'tool_error', steps: step, detail: score.content };
  const ranked: z.infer<typeof ScoreOutput> = ScoreOutput.parse(JSON.parse(score.content));

  const targets = ranked.scores.filter((s) => s.findings.length > 0).slice(0, task.maxDrafts);
  for (const target of targets) {
    await executeTool('draft_outreach', { business_id: target.business_id }, ctx, ++step);
  }
  return { stopReason: 'completed', steps: step, detail: null };
}
