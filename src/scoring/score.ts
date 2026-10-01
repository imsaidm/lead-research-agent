import type { Audit, Business, ScoredLead } from '../schemas.ts';
import { deriveFindings } from './findings.ts';
import { WEIGHTS } from './weights.ts';

const REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  no_website: 'no website listed',
  website_unreachable: 'website could not be loaded',
  no_https: 'no HTTPS',
  no_https_redirect: 'HTTP not redirected to HTTPS',
  not_mobile_friendly: 'not mobile-friendly (no viewport)',
  slow_response: 'slow homepage',
  no_chat_widget: 'no chat widget',
  no_contact_form: 'no contact form on homepage',
  outdated_copyright: 'outdated copyright year',
  missing_meta_description: 'no meta description',
  missing_title: 'no page title',
});

const SKIP_REASONS: Readonly<Record<string, string>> = Object.freeze({
  robots_disallowed: 'audit skipped: robots.txt disallows',
  robots_unreachable: 'audit skipped: robots.txt unreachable',
  blocked_url: 'audit skipped: URL blocked by SSRF guard',
  invalid_url: 'audit skipped: invalid website URL',
  access_denied: 'audit skipped: site refused automated access (HTTP 401/403/429)',
  not_audited: 'not audited',
});

/** Deterministic lead score. Pure: no I/O, no clock (year is passed in). */
export function scoreLead(business: Business, audit: Audit, nowYear: number): ScoredLead {
  const findings = deriveFindings(audit, nowYear);
  const contactBonus = business.phone ? WEIGHTS.has_phone : 0;
  const raw = findings.reduce((sum, f) => sum + f.weight, 0) + contactBonus;
  const skip = SKIP_REASONS[audit.status];
  const reasons = [
    ...findings.map((f) => `${REASON_LABELS[f.id] ?? f.id} (+${f.weight})`),
    ...(contactBonus ? [`has phone (+${contactBonus})`] : []),
    ...(skip ? [skip] : []),
  ];
  return Object.freeze({
    businessId: business.id,
    score: Math.min(100, raw),
    findings,
    reasons: Object.freeze(reasons),
  });
}

export interface RankInput<B extends { readonly name: string }> {
  readonly business: B;
  readonly lead: ScoredLead;
}

/** Sort by score desc, then name asc. Returns a new array. */
export function rankLeads<B extends { readonly name: string }>(items: readonly RankInput<B>[]): readonly RankInput<B>[] {
  return [...items].sort((a, b) => b.lead.score - a.lead.score || a.business.name.localeCompare(b.business.name));
}
