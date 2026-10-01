import { describe, expect, it } from 'vitest';
import { pickFindings, writeTemplateDraft } from '../src/outreach/template-writer.ts';
import { validateDraft } from '../src/outreach/validate.ts';
import { deriveFindings } from '../src/scoring/findings.ts';
import type { Audit } from '../src/schemas.ts';
import { makeAudit } from './helpers.ts';

const AUDITS: Readonly<Record<string, Partial<Audit>>> = {
  noWebsite: { status: 'no_website' },
  unreachable: { status: 'fetch_failed' },
  legacy: { https: false, httpsAvailable: false, hasViewport: false, responseTimeMs: 4_210, hasChatWidget: false, hasContactForm: false, copyrightYear: 2016, hasMetaDescription: false },
  slowOnly: { responseTimeMs: 5_555 },
  redirect: { https: false, httpsAvailable: true, hasChatWidget: false },
  seo: { hasMetaDescription: false, title: null },
  copyright: { copyrightYear: 2019 },
  form: { hasContactForm: false },
};

describe('writeTemplateDraft', () => {
  it.each(Object.entries(AUDITS))('%s: produces a draft that passes the validator', (_name, overrides) => {
    const audit = makeAudit(overrides);
    const findings = deriveFindings(audit, 2026);
    for (const label of ['template', 'mock'] as const) {
      const draft = writeTemplateDraft({ businessName: 'Test Plumbing', niche: 'plumber', findings }, label);
      expect(draft).not.toBeNull();
      const result = validateDraft(draft, { findings, audit, businessName: 'Test Plumbing' });
      expect(result.ok ? [] : result.errors).toEqual([]);
    }
  });

  it('returns null when there is nothing true to say', () => {
    expect(writeTemplateDraft({ businessName: 'X', niche: 'plumber', findings: [] }, 'template')).toBeNull();
  });

  it('labels mock drafts and never labels template drafts as AI', () => {
    const findings = deriveFindings(makeAudit({ status: 'no_website' }), 2026);
    const mock = writeTemplateDraft({ businessName: 'X', niche: 'plumber', findings }, 'mock');
    const tpl = writeTemplateDraft({ businessName: 'X', niche: 'plumber', findings }, 'template');
    expect(mock?.subject.startsWith('MOCK')).toBe(true);
    expect(mock?.body).toContain('[MOCK DRAFT');
    expect(tpl?.body).not.toMatch(/MOCK|Claude|AI-written/);
  });

  it('keeps subjects within 60 characters for long names', () => {
    const findings = deriveFindings(makeAudit({ status: 'no_website' }), 2026);
    const d = writeTemplateDraft({ businessName: 'A'.repeat(120), niche: 'plumber', findings }, 'template');
    expect(d?.subject.length).toBeLessThanOrEqual(60);
  });

  it('pickFindings takes the two heaviest findings from different categories', () => {
    const f = deriveFindings(makeAudit({ hasMetaDescription: false, title: null, hasViewport: false }), 2026);
    expect(pickFindings(f).map((x) => x.id)).toEqual(['not_mobile_friendly', 'missing_meta_description']);
  });
});
