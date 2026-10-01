import { z } from 'zod';
import { NICHE_NAMES } from '../config/niches.ts';
import { OSM_ATTRIBUTION } from '../config/settings.ts';
import type { Drafter } from '../outreach/drafter.ts';
import type { RunLog } from '../output/run-log.ts';
import { AUDIT_STATUSES, BusinessIdSchema, FINDING_IDS, type Audit, type Business, type DraftResult } from '../schemas.ts';
import { emptyAudit } from '../audit/audit-website.ts';
import { rankLeads, scoreLead } from '../scoring/score.ts';
import type { OsmSource } from '../sources/osm-source.ts';
import type { StateStore, Task } from './state.ts';

export interface SaveSummary {
  readonly outputDir: string;
  readonly files: readonly string[];
}

export interface ToolContext {
  readonly task: Task;
  readonly store: StateStore;
  readonly osm: OsmSource;
  readonly audit: (business: Business) => Promise<Audit>;
  readonly drafter: Drafter;
  readonly save: (reason: string) => Promise<SaveSummary>;
  readonly log: RunLog;
}

/** Thrown for expected, model-facing errors (returned as is_error tool results). */
export class ToolError extends Error {}

const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const findBusiness = (ctx: ToolContext, id: string): Business | undefined => ctx.store.get().businesses.find((b) => b.id === id);
const IdList = z.array(BusinessIdSchema).min(1).max(50);

// ---------- find_businesses ----------
export const FindInput = z.object({ niche: z.enum(NICHE_NAMES as [string, ...string[]]), city: z.string().min(2).max(100), limit: z.number().int().min(1).max(50) }).strict();
export const FindOutput = z.object({
  area: z.string(),
  count: z.number().int(),
  businesses: z.array(z.object({ business_id: BusinessIdSchema, name: z.string(), has_website: z.boolean(), has_phone: z.boolean() })),
  attribution: z.string(),
});

export async function findBusinesses(input: z.infer<typeof FindInput>, ctx: ToolContext): Promise<z.infer<typeof FindOutput>> {
  if (!sameText(input.niche, ctx.task.niche) || !sameText(input.city, ctx.task.city)) {
    throw new ToolError(`out of scope: this run is limited to niche "${ctx.task.niche}" in "${ctx.task.city}"`);
  }
  if (!ctx.store.get().searched) {
    const area = await ctx.osm.geocode(ctx.task.city);
    const businesses = await ctx.osm.findBusinesses(ctx.task.niche, area, Math.min(input.limit, ctx.task.limit));
    ctx.store.update((s) => ({ ...s, area, businesses, searched: true }));
  }
  const { area, businesses } = ctx.store.get();
  return {
    area: area?.displayName ?? ctx.task.city,
    count: businesses.length,
    businesses: businesses.map((b) => ({ business_id: b.id, name: b.name, has_website: b.website !== null, has_phone: b.phone !== null })),
    attribution: OSM_ATTRIBUTION,
  };
}

// ---------- audit_website ----------
export const AuditInput = z.object({ business_ids: IdList }).strict();
const AuditItem = z.object({
  business_id: z.string(),
  status: z.enum(AUDIT_STATUSES),
  findings: z.array(z.enum(FINDING_IDS)),
  https: z.boolean().nullable(),
  mobile_viewport: z.boolean().nullable(),
  response_time_ms: z.number().nullable(),
  chat_widget: z.boolean().nullable(),
  contact_form: z.boolean().nullable(),
});
export const AuditOutput = z.object({ audits: z.array(AuditItem), errors: z.array(z.string()) });

export async function auditWebsites(input: z.infer<typeof AuditInput>, ctx: ToolContext): Promise<z.infer<typeof AuditOutput>> {
  const unique = [...new Set(input.business_ids)];
  const known = unique.map((id) => findBusiness(ctx, id)).filter((b): b is Business => b !== undefined);
  const errors = unique.filter((id) => !findBusiness(ctx, id)).map((id) => `${id}: unknown business_id (call find_businesses first)`);
  const audits = await Promise.all(
    known.map(async (b) => ctx.store.get().audits[b.id] ?? (await ctx.audit(b))),
  );
  ctx.store.update((s) => ({ ...s, audits: { ...s.audits, ...Object.fromEntries(audits.map((a) => [a.businessId, a])) } }));
  return {
    audits: audits.map((a) => ({
      business_id: a.businessId,
      status: a.status,
      findings: scoreLead(findBusiness(ctx, a.businessId) as Business, a, ctx.task.nowYear).findings.map((f) => f.id),
      https: a.https,
      mobile_viewport: a.hasViewport,
      response_time_ms: a.responseTimeMs,
      chat_widget: a.hasChatWidget,
      contact_form: a.hasContactForm,
    })),
    errors,
  };
}

// ---------- score_lead ----------
export const ScoreInput = z.object({ business_ids: IdList }).strict();
export const ScoreOutput = z.object({
  scores: z.array(z.object({ business_id: z.string(), name: z.string(), score: z.number(), findings: z.array(z.enum(FINDING_IDS)), reasons: z.array(z.string()) })),
  errors: z.array(z.string()),
});

/** Businesses without a website need no fetch, so they get their audit implicitly. */
export function auditFor(ctx: ToolContext, b: Business): Audit | undefined {
  return ctx.store.get().audits[b.id] ?? (b.website === null ? emptyAudit(b.id, 'no_website', null) : undefined);
}

export async function scoreLeads(input: z.infer<typeof ScoreInput>, ctx: ToolContext): Promise<z.infer<typeof ScoreOutput>> {
  const unique = [...new Set(input.business_ids)];
  const errors = unique.flatMap((id) => {
    const b = findBusiness(ctx, id);
    if (!b) return [`${id}: unknown business_id`];
    return auditFor(ctx, b) ? [] : [`${id}: not audited yet (call audit_website first)`];
  });
  const scored = unique
    .map((id) => findBusiness(ctx, id))
    .filter((b): b is Business => b !== undefined && auditFor(ctx, b) !== undefined)
    .map((business) => ({ business, lead: scoreLead(business, auditFor(ctx, business) as Audit, ctx.task.nowYear) }));
  return {
    scores: rankLeads(scored).map(({ business, lead }) => ({
      business_id: business.id,
      name: business.name,
      score: lead.score,
      findings: lead.findings.map((f) => f.id),
      reasons: [...lead.reasons],
    })),
    errors,
  };
}

// ---------- draft_outreach ----------
export const DraftInput = z.object({ business_id: BusinessIdSchema }).strict();
export const DraftOutput = z.object({
  business_id: z.string(),
  status: z.enum(['ok', 'dropped']),
  subject: z.string().optional(),
  findings_used: z.array(z.enum(FINDING_IDS)).optional(),
  reason: z.string().optional(),
  drafts_remaining: z.number().int(),
});

export async function draftOutreach(input: z.infer<typeof DraftInput>, ctx: ToolContext): Promise<z.infer<typeof DraftOutput>> {
  const business = findBusiness(ctx, input.business_id);
  if (!business) throw new ToolError(`${input.business_id}: unknown business_id`);
  const audit = auditFor(ctx, business);
  if (!audit) throw new ToolError(`${input.business_id}: not audited yet (call audit_website first)`);
  const final = (r: DraftResult | undefined): boolean => r !== undefined && (r.status === 'ok' || !r.retryable);
  const existing = ctx.store.get().drafts[business.id];
  const used = Object.values(ctx.store.get().drafts).filter(final).length;
  if (!final(existing) && used >= ctx.task.maxDrafts) throw new ToolError(`draft limit reached (${ctx.task.maxDrafts} per run)`);

  const result = existing && final(existing) ? existing : (await ctx.drafter({ business, audit, findings: scoreLead(business, audit, ctx.task.nowYear).findings, city: ctx.task.city }));
  ctx.store.update((s) => ({ ...s, drafts: { ...s.drafts, [business.id]: result } }));
  const remaining = ctx.task.maxDrafts - Object.values(ctx.store.get().drafts).filter(final).length;
  return result.status === 'ok'
    ? { business_id: business.id, status: 'ok', subject: result.draft.subject, findings_used: [...result.draft.findings_used], drafts_remaining: remaining }
    : { business_id: business.id, status: 'dropped', reason: result.reason, drafts_remaining: remaining };
}

// ---------- save_results ----------
export const SaveInput = z.object({}).strict();
export const SaveOutput = z.object({ output_dir: z.string(), files: z.array(z.string()) });

export async function saveResults(_input: z.infer<typeof SaveInput>, ctx: ToolContext): Promise<z.infer<typeof SaveOutput>> {
  const saved = await ctx.save('saved_by_agent');
  return { output_dir: saved.outputDir, files: [...saved.files] };
}
