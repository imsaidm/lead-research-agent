import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHtmlSignals } from '../src/audit/parse-html.ts';

const site = (name: string): string => readFileSync(new URL(`../fixtures/sites/${name}`, import.meta.url), 'utf8');
const NOW_YEAR = 2026;

describe('parseHtmlSignals (fixture HTML)', () => {
  it('legacy table site: no viewport, no meta description, no chat, no form, old copyright', () => {
    expect(parseHtmlSignals(site('lonestar-plumbing.html'), NOW_YEAR)).toEqual({
      title: 'Lone Star Plumbing - Austin Plumber',
      hasViewport: false,
      hasMetaDescription: false,
      hasChatWidget: false,
      chatVendor: null,
      hasContactForm: false,
      copyrightYear: 2016,
    });
  });

  it('modern site: viewport, description, quote form, copyright range uses the latest year', () => {
    const s = parseHtmlSignals(site('capitol-rooter.html'), NOW_YEAR);
    expect(s).toMatchObject({ hasViewport: true, hasMetaDescription: true, hasContactForm: true, hasChatWidget: false, copyrightYear: 2026 });
    expect(s.title).toBe('Capitol Rooter | Drain Cleaning in Austin, TX');
  });

  it('detects a known chat vendor script and ignores search-only forms', () => {
    const s = parseHtmlSignals(site('hill-country-pipes.html'), NOW_YEAR);
    expect(s).toMatchObject({ hasChatWidget: true, chatVendor: 'tawk.to', hasContactForm: true, copyrightYear: 2025 });
  });

  it('search form alone is not a contact form', () => {
    expect(parseHtmlSignals(site('austin-leak-fix.html'), NOW_YEAR)).toMatchObject({ hasContactForm: false, hasViewport: false, copyrightYear: 2019 });
  });

  it('embedded form iframe counts as a contact form; (c) notation is parsed', () => {
    expect(parseHtmlSignals(site('mueller-plumbing.html'), NOW_YEAR)).toMatchObject({ hasContactForm: true, copyrightYear: 2024 });
  });
});

describe('parseHtmlSignals (edge cases)', () => {
  it('handles empty / garbage input without throwing', () => {
    expect(parseHtmlSignals('', NOW_YEAR)).toMatchObject({ title: null, hasViewport: false, copyrightYear: null });
    expect(parseHtmlSignals('<<<>>>%%%', NOW_YEAR).title).toBeNull();
  });

  it('viewport meta without width is not counted; name matching is case-insensitive', () => {
    expect(parseHtmlSignals('<meta name="viewport" content="initial-scale=1">', NOW_YEAR).hasViewport).toBe(false);
    expect(parseHtmlSignals('<META NAME="Viewport" CONTENT="width=device-width">', NOW_YEAR).hasViewport).toBe(true);
  });

  it('empty meta description does not count', () => {
    expect(parseHtmlSignals('<meta name="description" content="  ">', NOW_YEAR).hasMetaDescription).toBe(false);
  });

  it('ignores implausible future copyright years and JS-generated years', () => {
    expect(parseHtmlSignals('<footer>© 2099 Foo</footer>', NOW_YEAR).copyrightYear).toBeNull();
    expect(parseHtmlSignals('<footer>© <script>document.write(new Date().getFullYear())</script> Foo</footer>', NOW_YEAR).copyrightYear).toBeNull();
  });

  it('detects generic chat widgets by element id/class', () => {
    expect(parseHtmlSignals('<div id="chat-widget-container"></div>', NOW_YEAR).hasChatWidget).toBe(true);
  });

  it('truncates very long titles', () => {
    expect(parseHtmlSignals(`<title>${'a'.repeat(500)}</title>`, NOW_YEAR).title).toHaveLength(200);
  });
});
