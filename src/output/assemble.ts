import type { RunState } from '../agent/state.ts';
import { emptyAudit } from '../audit/audit-website.ts';
import type { Audit, Business, DraftResult, ScoredLead } from '../schemas.ts';
import { rankLeads, scoreLead } from '../scoring/score.ts';

export interface LeadRecord {
  readonly rank: number;
  readonly business: Business;
  readonly audit: Audit;
  readonly lead: ScoredLead;
  readonly draft: DraftResult | null;
}

/**
 * Every business found becomes a ranked record. Scoring is deterministic, so it is
 * recomputed here for all businesses (including ones the agent never scored);
 * businesses with a website that were never audited are marked not_audited.
 */
export function assembleLeads(state: RunState, nowYear: number): readonly LeadRecord[] {
  const items = state.businesses.map((business) => {
    const audit =
      state.audits[business.id] ??
      emptyAudit(business.id, business.website === null ? 'no_website' : 'not_audited', business.website);
    return { business, lead: scoreLead(business, audit, nowYear), audit };
  });
  const auditOf = new Map(items.map((i) => [i.business.id, i.audit]));
  return rankLeads(items).map(({ business, lead }, index) =>
    Object.freeze({
      rank: index + 1,
      business,
      audit: auditOf.get(business.id) as Audit,
      lead,
      draft: state.drafts[business.id] ?? null,
    }),
  );
}

export function osmUrl(businessId: string): string {
  const [, type, id] = businessId.split('-');
  return `https://www.openstreetmap.org/${type}/${id}`;
}
