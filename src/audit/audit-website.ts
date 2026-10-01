import { FETCH_LIMITS } from '../config/settings.ts';
import type { HttpGetter } from '../net/http-getter.ts';
import { SafeFetchError, validateUrl, type SafeResponse } from '../net/safe-fetch.ts';
import type { Audit, AuditStatus, Business } from '../schemas.ts';
import { parseHtmlSignals } from './parse-html.ts';
import type { RobotsChecker } from './robots-check.ts';

export interface AuditDeps {
  readonly get: HttpGetter;
  readonly robots: RobotsChecker;
  readonly nowYear: number;
}

const ACCESS_DENIED = new Set([401, 403, 429, 451]);
const NO_HTTPS_ERRORS = /ECONNREFUSED|CERT|SSL|TLS|EPROTO|self[- ]signed|altnames|wrong version number/i;

export function emptyAudit(businessId: string, status: AuditStatus, requestedUrl: string | null, error: string | null = null): Audit {
  return {
    businessId,
    status,
    requestedUrl,
    finalUrl: null,
    httpStatus: null,
    https: null,
    httpsAvailable: null,
    redirected: null,
    responseTimeMs: null,
    htmlBytes: null,
    truncated: false,
    hasViewport: null,
    title: null,
    hasMetaDescription: null,
    hasChatWidget: null,
    chatVendor: null,
    hasContactForm: null,
    copyrightYear: null,
    error,
  };
}

/** OSM website tags are sometimes scheme-less ("example.com"); assume https in that case. */
export function normalizeWebsite(raw: string): URL | null {
  const first = raw.split(';')[0]?.trim() ?? '';
  if (!first) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(first) ? first : `https://${first}`;
  try {
    return validateUrl(withScheme, FETCH_LIMITS.allowedPorts);
  } catch {
    return null;
  }
}

function statusForFetchError(err: SafeFetchError): AuditStatus {
  switch (err.code) {
    case 'redirect_disallowed':
      return 'robots_disallowed';
    case 'blocked_ip':
    case 'blocked_port':
    case 'blocked_scheme':
      return 'blocked_url';
    case 'invalid_url':
      return 'invalid_url';
    default:
      return 'fetch_failed';
  }
}

/** Does an HTTPS version of the site respond? null = could not tell (never claimed). */
async function probeHttps(finalUrl: URL, deps: AuditDeps): Promise<boolean | null> {
  const origin = `https://${finalUrl.host}`;
  const robots = await deps.robots(new URL(`${origin}/`));
  if (!robots.allowed && robots.errorCode === null) return null;
  try {
    const res = await deps.get(`${origin}/`, { maxBytes: FETCH_LIMITS.probeMaxBytes });
    if (res.status >= 400) return null;
    return new URL(res.url).protocol === 'https:';
  } catch (err) {
    // Only a refused connection or a failed TLS handshake proves there is no working HTTPS.
    return err instanceof SafeFetchError && err.code === 'network' && NO_HTTPS_ERRORS.test(err.message) ? false : null;
  }
}

async function auditResponse(business: Business, url: URL, res: SafeResponse, deps: AuditDeps): Promise<Audit> {
  const base = { ...emptyAudit(business.id, 'ok', url.href), finalUrl: res.url, httpStatus: res.status };
  if (ACCESS_DENIED.has(res.status)) return { ...base, status: 'access_denied' };
  if (res.status >= 400) return { ...base, status: 'http_error', responseTimeMs: res.elapsedMs };

  const finalUrl = new URL(res.url);
  const https = finalUrl.protocol === 'https:';
  const signals = parseHtmlSignals(res.body, deps.nowYear);
  return {
    ...base,
    https,
    httpsAvailable: https ? true : await probeHttps(finalUrl, deps),
    redirected: res.redirects.length > 0,
    responseTimeMs: res.elapsedMs,
    htmlBytes: res.bytes,
    truncated: res.truncated,
    ...signals,
  };
}

/** Audits one business homepage. Never throws: every failure becomes an audit status. */
export async function auditWebsite(business: Business, deps: AuditDeps): Promise<Audit> {
  if (!business.website) return emptyAudit(business.id, 'no_website', null);
  const url = normalizeWebsite(business.website);
  if (!url) return emptyAudit(business.id, 'invalid_url', business.website.slice(0, 300), 'website is not a valid http(s) URL');

  try {
    const robots = await deps.robots(url);
    if (!robots.allowed) {
      if (robots.errorCode === 'blocked_ip') return emptyAudit(business.id, 'blocked_url', url.href, 'host resolves to a non-public address');
      if (robots.errorCode === 'dns_failed' || robots.errorCode === 'network') {
        return emptyAudit(business.id, 'fetch_failed', url.href, `site unreachable (${robots.errorCode})`);
      }
      const status = robots.reason === 'unreachable' ? 'robots_unreachable' : 'robots_disallowed';
      return emptyAudit(business.id, status, url.href);
    }
    const res = await deps.get(url.href, {
      maxBytes: FETCH_LIMITS.maxBytes,
      allowRedirect: async (next) => (await deps.robots(next)).allowed,
    });
    return await auditResponse(business, url, res, deps);
  } catch (err) {
    if (err instanceof SafeFetchError) return emptyAudit(business.id, statusForFetchError(err), url.href, `${err.code}: ${err.message}`.slice(0, 300));
    return emptyAudit(business.id, 'fetch_failed', url.href, `unexpected: ${(err as Error).message}`.slice(0, 300));
  }
}
