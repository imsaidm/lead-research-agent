import { describe, expect, it } from 'vitest';
import { fence } from '../src/output/drafts-md.ts';
import { mdEscape } from '../src/output/markdown.ts';

describe('markdown output for untrusted text', () => {
  it('neutralises links, images, autolinks, emails, html and table pipes', () => {
    const out = mdEscape('![x](http://evil.example) <b>|</b> www.evil.example me@evil.example & more');
    // every markdown-active character is backslash-escaped; no raw link/image/html/autolink survives
    expect(out).not.toMatch(/(?<!\\)[![\]<>|]|<b>|https?:\/\/|www\.|@e/);
    expect(out).toContain('\\|');
  });

  it('chooses a code fence longer than any backtick run', () => {
    expect(fence('plain')).toBe('```');
    expect(fence('a ```` b')).toBe('`````');
  });
});
