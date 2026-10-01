import { describe, expect, it } from 'vitest';
import { deriveFindings } from '../src/scoring/findings.ts';
import { scoreLead, rankLeads } from '../src/scoring/score.ts';
import { WEIGHTS } from '../src/scoring/weights.ts';
import { makeAudit, makeBusiness } from './helpers.ts';

const YEAR = 2026;
const ids = (audit: Parameters<typeof deriveFindings>[0]) => deriveFindings(audit, YEAR).map((f) => f.id);

describe('deriveFindings', () => {
  it('a healthy site has no findings', () => {
    expect(ids(makeAudit())).toEqual([]);
  });

  it('no website is a single strong finding', () => {
    expect(ids(makeAudit({ status: 'no_website' }))).toEqual(['no_website']);
  });

  it('unreachable sites are flagged but nothing else is claimed', () => {
    expect(ids(makeAudit({ status: 'fetch_failed', hasViewport: false }))).toEqual(['website_unreachable']);
    expect(ids(makeAudit({ status: 'http_error', httpStatus: 500 }))).toEqual(['website_unreachable']);
  });

  it('skipped audits (robots, blocked, invalid) produce no findings', () => {
    for (const status of ['robots_disallowed', 'robots_unreachable', 'blocked_url', 'invalid_url', 'access_denied', 'not_audited'] as const) {
      expect(ids(makeAudit({ status, hasViewport: false, https: false, httpsAvailable: false }))).toEqual([]);
    }
  });

  it('distinguishes no HTTPS at all from a missing redirect', () => {
    expect(ids(makeAudit({ https: false, httpsAvailable: false }))).toEqual(['no_https']);
    expect(ids(makeAudit({ https: false, httpsAvailable: true }))).toEqual(['no_https_redirect']);
    expect(ids(makeAudit({ https: false, httpsAvailable: null }))).toEqual([]);
  });

  it('flags each weak signal with evidence', () => {
    const f = deriveFindings(
      makeAudit({ hasViewport: false, responseTimeMs: 4_210, hasChatWidget: false, hasContactForm: false, copyrightYear: 2016, hasMetaDescription: false, title: null }),
      YEAR,
    );
    expect(f.map((x) => x.id)).toEqual([
      'not_mobile_friendly', 'slow_response', 'no_chat_widget', 'no_contact_form', 'outdated_copyright', 'missing_meta_description', 'missing_title',
    ]);
    expect(f.find((x) => x.id === 'slow_response')?.evidence).toContain('4.2 seconds');
    expect(f.find((x) => x.id === 'outdated_copyright')?.evidence).toContain('2016');
  });

  it('copyright is outdated only when 2+ years old; slow only above 3s', () => {
    expect(ids(makeAudit({ copyrightYear: 2025 }))).toEqual([]);
    expect(ids(makeAudit({ copyrightYear: 2024 }))).toEqual(['outdated_copyright']);
    expect(ids(makeAudit({ responseTimeMs: 3_000 }))).toEqual([]);
    expect(ids(makeAudit({ responseTimeMs: 3_001 }))).toEqual(['slow_response']);
  });

  it('unknown (null) signals never become findings', () => {
    expect(ids(makeAudit({ hasViewport: null, hasChatWidget: null, hasContactForm: null, copyrightYear: null, responseTimeMs: null }))).toEqual([]);
  });
});

describe('scoreLead', () => {
  it('sums documented weights, adds contactability, caps at 100', () => {
    const lead = scoreLead(makeBusiness(), makeAudit({ status: 'no_website' }), YEAR);
    expect(lead.score).toBe(WEIGHTS.no_website + WEIGHTS.has_phone);
    expect(lead.reasons[0]).toMatch(/no website/i);
  });

  it('no phone, no bonus', () => {
    expect(scoreLead(makeBusiness({ phone: null }), makeAudit(), YEAR).score).toBe(0);
  });

  it('never exceeds 100', () => {
    const worst = makeAudit({ https: false, httpsAvailable: false, hasViewport: false, responseTimeMs: 9_000, hasChatWidget: false, hasContactForm: false, copyrightYear: 2001, hasMetaDescription: false, title: null });
    expect(scoreLead(makeBusiness(), worst, YEAR).score).toBeLessThanOrEqual(100);
  });

  it('is pure: does not mutate inputs and is deterministic', () => {
    const b = Object.freeze(makeBusiness());
    const a = Object.freeze(makeAudit({ hasViewport: false }));
    expect(scoreLead(b, a, YEAR)).toEqual(scoreLead(b, a, YEAR));
  });

  it('a site with no website outranks a modern site; bad sites outrank good ones', () => {
    const leads = rankLeads([
      { business: makeBusiness({ id: 'osm-node-1', name: 'Good' }), lead: scoreLead(makeBusiness(), makeAudit(), YEAR) },
      { business: makeBusiness({ id: 'osm-node-2', name: 'None' }), lead: scoreLead(makeBusiness(), makeAudit({ status: 'no_website' }), YEAR) },
      { business: makeBusiness({ id: 'osm-node-3', name: 'Bad' }), lead: scoreLead(makeBusiness(), makeAudit({ hasViewport: false, https: false, httpsAvailable: false }), YEAR) },
    ]);
    expect(leads.map((l) => l.business.name)).toEqual(['None', 'Bad', 'Good']);
  });

  it('ties are broken by name for a stable order', () => {
    const same = scoreLead(makeBusiness(), makeAudit(), YEAR);
    const leads = rankLeads([
      { business: makeBusiness({ id: 'osm-node-2', name: 'Bravo' }), lead: same },
      { business: makeBusiness({ id: 'osm-node-1', name: 'Alpha' }), lead: same },
    ]);
    expect(leads.map((l) => l.business.name)).toEqual(['Alpha', 'Bravo']);
  });
});
