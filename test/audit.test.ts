import { describe, expect, it } from 'vitest';
import { auditWebsite, normalizeWebsite } from '../src/audit/audit-website.ts';
import { createRobotsChecker } from '../src/audit/robots-check.ts';
import type { HttpGetter } from '../src/net/http-getter.ts';
import { SafeFetchError } from '../src/net/safe-fetch.ts';
import { createFixtureGetter } from '../src/sources/fixture-getter.ts';
import { makeBusiness } from './helpers.ts';

const SITES = new URL('../fixtures/sites/', import.meta.url);

function deps(getter: HttpGetter = createFixtureGetter(SITES)) {
  let calls: string[] = [];
  const get: HttpGetter = (url, o) => {
    calls = [...calls, url];
    return getter(url, o);
  };
  return { get, robots: createRobotsChecker(get, 'LeadResearchAgent'), nowYear: 2026, calls: () => calls };
}

const audit = (website: string | null, d = deps()) => auditWebsite(makeBusiness({ website }), d);

describe('auditWebsite with fixtures', () => {
  it('legacy http-only site', async () => {
    expect(await audit('http://lonestar-plumbing.example/')).toMatchObject({
      status: 'ok', https: false, httpsAvailable: false, hasViewport: false, responseTimeMs: 4210,
      hasChatWidget: false, hasContactForm: false, copyrightYear: 2016, redirected: false,
    });
  });

  it('http -> https redirect counts as https and redirected', async () => {
    expect(await audit('http://hill-country-pipes.example/')).toMatchObject({
      status: 'ok', https: true, httpsAvailable: true, redirected: true, finalUrl: 'https://hill-country-pipes.example/', hasChatWidget: true,
    });
  });

  it('http site with a working https version that does not redirect', async () => {
    expect(await audit('http://mueller-plumbing.example/')).toMatchObject({ https: false, httpsAvailable: true });
  });

  it('respects robots.txt: never fetches a disallowed homepage', async () => {
    const d = deps();
    expect((await audit('https://riverside-plumbing.example/', d)).status).toBe('robots_disallowed');
    expect(d.calls()).toEqual(['https://riverside-plumbing.example/robots.txt']);
  });

  it('dns failure => fetch_failed; 500 => http_error', async () => {
    expect((await audit('http://southcongress-plumbing.example/')).status).toBe('fetch_failed');
    expect(await audit('https://pflugerville-plumbing.example/')).toMatchObject({ status: 'http_error', httpStatus: 500 });
  });

  it('no website and invalid websites are flagged without any request', async () => {
    const d = deps();
    expect((await audit(null, d)).status).toBe('no_website');
    expect((await audit('mailto:info@x.example', d)).status).toBe('invalid_url');
    expect((await audit('ftp://x.example/', d)).status).toBe('invalid_url');
    expect((await audit('http://x.example:2222/', d)).status).toBe('invalid_url');
    expect(d.calls()).toEqual([]);
  });

  it('scheme-less websites default to https', async () => {
    expect(normalizeWebsite('capitol-rooter.example')?.href).toBe('https://capitol-rooter.example/');
    expect((await audit('capitol-rooter.example')).status).toBe('ok');
  });
});

describe('auditWebsite error mapping (fake getter)', () => {
  const failing = (code: ConstructorParameters<typeof SafeFetchError>[0], robotsStatus = 404): HttpGetter => async (url) => {
    if (url.endsWith('/robots.txt')) return { url, status: robotsStatus, headers: {}, body: '', bytes: 0, truncated: false, redirects: [], elapsedMs: 1 };
    throw new SafeFetchError(code, code);
  };

  it.each([
    ['blocked_ip', 'blocked_url'],
    ['redirect_disallowed', 'robots_disallowed'],
    ['timeout', 'fetch_failed'],
    ['too_many_redirects', 'fetch_failed'],
  ] as const)('%s -> %s', async (code, status) => {
    expect((await audit('https://site.example/', deps(failing(code)))).status).toBe(status);
  });

  it('robots.txt 5xx => robots_unreachable (RFC 9309 full disallow)', async () => {
    expect((await audit('https://site.example/', deps(failing('network', 503)))).status).toBe('robots_unreachable');
  });

  it('403 => access_denied (bot protection is not a site problem)', async () => {
    const get: HttpGetter = async (url) => ({ url, status: url.endsWith('robots.txt') ? 404 : 403, headers: {}, body: '', bytes: 0, truncated: false, redirects: [], elapsedMs: 5 });
    expect((await audit('https://site.example/', deps(get))).status).toBe('access_denied');
  });

  it('checks robots.txt of a new origin before following a redirect', async () => {
    const get: HttpGetter = async (url, o) => {
      if (url === 'https://a.example/robots.txt') return { url, status: 404, headers: {}, body: '', bytes: 0, truncated: false, redirects: [], elapsedMs: 1 };
      if (url === 'https://b.example/robots.txt') return { url, status: 200, headers: {}, body: 'User-agent: *\nDisallow: /', bytes: 0, truncated: false, redirects: [], elapsedMs: 1 };
      const ok = await o.allowRedirect?.(new URL('https://b.example/'));
      if (!ok) throw new SafeFetchError('redirect_disallowed', 'no');
      throw new Error('should not reach');
    };
    expect((await audit('https://a.example/', deps(get))).status).toBe('robots_disallowed');
  });
});
