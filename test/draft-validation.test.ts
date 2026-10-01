import { describe, expect, it } from 'vitest';
import { validateDraft, OPT_OUT_LINE } from '../src/outreach/validate.ts';
import { deriveFindings } from '../src/scoring/findings.ts';
import { makeAudit } from './helpers.ts';

const audit = makeAudit({ https: false, httpsAvailable: false, hasViewport: false, responseTimeMs: 4_210, copyrightYear: 2016 });
const findings = deriveFindings(audit, 2026); // no_https, not_mobile_friendly, slow_response, outdated_copyright

const body = (middle: string): string =>
  `Hi Test Plumbing team,\n\n${middle}\n\nI help local trades fix this kind of thing quickly. Worth a short look?\n\n${OPT_OUT_LINE}\n\n[Your Name]\n[Your Company]`;

const good = {
  subject: 'Quick note about your website',
  body: body('I checked your homepage and noticed it does not load over HTTPS, so browsers may label it "Not secure". It also took about 4.2 seconds to respond.'),
  findings_used: ['no_https', 'slow_response'],
};

const errorsOf = (draft: unknown, a = audit, f = findings): readonly string[] => {
  const r = validateDraft(draft, { findings: f, audit: a, businessName: 'Test Plumbing' });
  return r.ok ? [] : r.errors;
};

describe('validateDraft', () => {
  it('accepts a draft that only uses audit facts', () => {
    expect(errorsOf(good)).toEqual([]);
  });

  it('rejects non-JSON-shaped or extra-key output', () => {
    expect(errorsOf('just text').length).toBeGreaterThan(0);
    expect(errorsOf({ ...good, extra: 1 }).length).toBeGreaterThan(0);
  });

  it('rejects subjects over 60 characters', () => {
    expect(errorsOf({ ...good, subject: 'x'.repeat(61) }).join()).toMatch(/subject/i);
  });

  it('rejects bodies over 120 words', () => {
    expect(errorsOf({ ...good, body: body('word '.repeat(120)) }).join()).toMatch(/120 words/);
  });

  it('requires the opt-out line (curly quotes are accepted)', () => {
    expect(errorsOf({ ...good, body: good.body.replace(OPT_OUT_LINE, '') }).join()).toMatch(/opt-out/i);
    expect(errorsOf({ ...good, body: good.body.replace("'no thanks'", '\u2018no thanks\u2019').replace("won't", 'won\u2019t') })).toEqual([]);
  });

  it('requires the signature placeholder', () => {
    expect(errorsOf({ ...good, body: good.body.replace('[Your Name]', 'Bob') }).join()).toMatch(/signature/i);
  });

  it('rejects findings_used that are not true for this lead', () => {
    expect(errorsOf({ ...good, findings_used: ['no_chat_widget'] }).join()).toMatch(/not an audit finding/);
  });

  it('rejects claims about things the audit did not find (e.g. chat, contact form, no website)', () => {
    const chat = { ...good, body: body('Your site has no HTTPS and no live chat for visitors.'), findings_used: ['no_https'] };
    expect(errorsOf(chat).join()).toMatch(/unsupported claim.*chat/);
    const form = { ...good, body: body('Your site has no HTTPS and no contact form.'), findings_used: ['no_https'] };
    expect(errorsOf(form).join()).toMatch(/unsupported claim.*contact form/);
  });

  it('rejects drafts that mention more than 2 findings or a finding not listed in findings_used', () => {
    const three = { ...good, body: body('No HTTPS, no mobile viewport, and it took 4.2 seconds to respond.') };
    expect(errorsOf(three).join()).toMatch(/mobile but no matching finding is listed/);
    const unlisted = { ...good, findings_used: ['no_https'] };
    expect(errorsOf(unlisted).join()).toMatch(/is listed in findings_used/);
  });

  it('rejects a draft whose findings_used are never actually mentioned', () => {
    const silent = { ...good, body: body('I took a look at your site.'), findings_used: ['no_https'] };
    expect(errorsOf(silent).join()).toMatch(/does not mention/);
  });

  it('rejects numbers that contradict the audit', () => {
    const wrongSeconds = { ...good, body: body('It does not use HTTPS and took 9 seconds to respond.') };
    expect(errorsOf(wrongSeconds).join()).toMatch(/seconds/);
    const wrongYear = { ...good, body: body('No HTTPS, and the footer still says 2012.'), findings_used: ['no_https', 'outdated_copyright'] };
    expect(errorsOf(wrongYear).join()).toMatch(/year/);
  });

  it('rejects statistics, prices, links, emails and markdown code', () => {
    for (const bad of ['Sites like yours lose 40% of visitors.', 'Plans start at $99.', 'See https://evil.example now.', 'Email me at a@b.co today.', 'Run `rm` now.']) {
      expect(errorsOf({ ...good, body: body(`No HTTPS on your homepage. ${bad} It took 4.2 seconds to respond.`) }).length).toBeGreaterThan(0);
    }
  });

  it('accepts a no-website draft for a lead without a website', () => {
    const a = makeAudit({ status: 'no_website' });
    const f = deriveFindings(a, 2026);
    const d = { subject: 'Your business online', body: body("I couldn't find a website for your business listed on the map."), findings_used: ['no_website'] };
    expect(errorsOf(d, a, f)).toEqual([]);
  });
});

describe('validateDraft: unverifiable numbers', () => {
  it('rejects invented numbers (years in business, review counts)', () => {
    const d = { ...good, body: body('After 25 years serving Austin, your homepage has no HTTPS. It took 4.2 seconds to respond.') };
    expect(errorsOf(d).join()).toMatch(/unverifiable number/);
  });

  it('allows digits that are part of the business name', () => {
    const r = validateDraft(
      { ...good, subject: 'A note for A1 Plumbing 24/7' },
      { findings, audit, businessName: 'A1 Plumbing 24/7' },
    );
    expect(r.ok).toBe(true);
  });
});

describe('validateDraft: review regressions', () => {
  const okBody = (middle: string): string => body(middle);

  it('a lead whose HTTPS only lacks a redirect cannot be told it has no HTTPS', () => {
    const a = makeAudit({ https: false, httpsAvailable: true });
    const f = deriveFindings(a, 2026);
    const lie = { subject: 'Your website', body: okBody('Your site does not use HTTPS at all.'), findings_used: ['no_https_redirect'] };
    expect(validateDraft(lie, { findings: f, audit: a, businessName: 'Test Plumbing' }).ok).toBe(false);
    const truth = { subject: 'Your website', body: okBody('Your homepage opens over plain HTTP by default, even though an HTTPS version exists.'), findings_used: ['no_https_redirect'] };
    expect(validateDraft(truth, { findings: f, audit: a, businessName: 'Test Plumbing' }).ok).toBe(true);
  });

  it('a missing meta description does not license a missing page title claim', () => {
    const a = makeAudit({ hasMetaDescription: false });
    const f = deriveFindings(a, 2026);
    const lie = { subject: 'Your website', body: okBody('Your homepage has no page title.'), findings_used: ['missing_meta_description'] };
    expect(validateDraft(lie, { findings: f, audit: a, businessName: 'Test Plumbing' }).ok).toBe(false);
  });

  it.each(["doesn't have a website", 'does not have a website', 'has no site online', 'lacks a website'])(
    'detects the no-website claim phrased as "%s"',
    (phrase) => {
      const d = { ...good, body: body(`I noticed your company ${phrase}. Also, no HTTPS and it took 4.2 seconds to respond.`) };
      expect(errorsOf(d).join()).toMatch(/unsupported claim: no website/);
    },
  );

  it('rejects number words that could hide invented facts', () => {
    const d = { ...good, body: body('After twenty years in Austin, your homepage has no HTTPS and took 4.2 seconds to respond.') };
    expect(errorsOf(d).join()).toMatch(/number word/);
  });

  it('a hostile business name cannot smuggle links or prices past the validator', () => {
    const name = 'Visit www.evil.com or call $5 now';
    const d = { ...good, body: good.body.replace('Test Plumbing', name) };
    const r = validateDraft(d, { findings, audit, businessName: name });
    expect(r.ok).toBe(false);
  });

  it('curly apostrophes in the business name are normalized before name stripping', () => {
    const name = 'Joe’s Mobile Plumbing';
    const d = { ...good, body: good.body.replace('Test Plumbing', name) };
    const r = validateDraft(d, { findings, audit, businessName: name });
    expect(r.ok ? [] : r.errors).toEqual([]);
  });
});
