import { describe, expect, it } from 'vitest';
import { auditWebsite } from '../src/audit/audit-website.ts';
import { createRobotsChecker } from '../src/audit/robots-check.ts';
import { createHttpGetterFor } from '../src/net/getter-factory.ts';
import type { HttpGetter } from '../src/net/http-getter.ts';
import { parseRobots, isPathAllowed } from '../src/net/robots.ts';
import { safeFetch, SafeFetchError, validateUrl } from '../src/net/safe-fetch.ts';
import { makeBusiness } from './helpers.ts';

const SITES = new URL('../fixtures/sites/', import.meta.url);
const res = (url: string, status: number, body = '') => ({ url, status, headers: {}, body, bytes: body.length, truncated: false, redirects: [], elapsedMs: 1 });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'no-error';
  } catch (err) {
    return err instanceof SafeFetchError ? err.code : `unexpected:${String(err)}`;
  }
}

describe('security review regressions', () => {
  it('no deadlock: many concurrent audits whose redirects need robots.txt under a 2-slot limiter', async () => {
    const get = createHttpGetterFor({ kind: 'fixture', sites: SITES });
    const robots = createRobotsChecker(get, 'LeadResearchAgent');
    const audits = Array.from({ length: 6 }, (_, i) =>
      auditWebsite(makeBusiness({ id: `osm-node-${i + 1}`, website: 'http://hill-country-pipes.example/' }), { get, robots, nowYear: 2026 }),
    );
    const results = await Promise.race([
      Promise.all(audits),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('deadlock')), 3_000)),
    ]);
    expect(results.every((a) => a.status === 'ok' && a.redirected)).toBe(true);
  });

  it('DNS lookups are bounded by the fetch deadline', async () => {
    const never = () => new Promise<never>(() => undefined);
    expect(await codeOf(safeFetch('http://slow-dns.test/', { userAgent: 't', resolver: never, timeoutMs: 200 }))).toBe('timeout');
  });

  it('ports must match the scheme (no http on 443, no https on 80)', () => {
    expect(() => validateUrl('http://x.example:443/', [80, 443])).toThrow(/port 443/);
    expect(() => validateUrl('https://x.example:80/', [80, 443])).toThrow(/port 80/);
    expect(validateUrl('https://x.example:443/', [80, 443]).href).toBe('https://x.example/');
  });

  it('robots.txt is evaluated for the actual path, not just "/"', async () => {
    const get: HttpGetter = async (url) =>
      url.endsWith('/robots.txt') ? res(url, 200, 'User-agent: *\nDisallow: /private') : res(url, 200, '<title>x</title>');
    const robots = createRobotsChecker(get, 'LeadResearchAgent');
    const audit = await auditWebsite(makeBusiness({ website: 'https://x.example/private/page' }), { get, robots, nowYear: 2026 });
    expect(audit.status).toBe('robots_disallowed');
  });

  it('a huge robots.txt parses in linear time with capped rules', () => {
    const big = `User-agent: *\n${'Disallow: /x\n'.repeat(40_000)}`;
    const started = performance.now();
    const robots = parseRobots(big);
    expect(performance.now() - started).toBeLessThan(500);
    expect(robots.groups[0]?.rules.length).toBe(1_000);
    expect(isPathAllowed(robots, 'LeadResearchAgent', '/x')).toBe(false);
  });

  it('an ambiguous HTTPS probe error (reset) is "unknown", never "no HTTPS"', async () => {
    const get: HttpGetter = async (url) => {
      if (url.endsWith('/robots.txt')) return res(url, 404);
      if (url.startsWith('https:')) throw new SafeFetchError('network', 'ECONNRESET: socket hang up');
      return res(url, 200, '<meta name="viewport" content="width=device-width"><title>x</title>');
    };
    const audit = await auditWebsite(makeBusiness({ website: 'http://x.example/' }), { get, robots: createRobotsChecker(get, 'LeadResearchAgent'), nowYear: 2026 });
    expect(audit).toMatchObject({ https: false, httpsAvailable: null });
  });
});
