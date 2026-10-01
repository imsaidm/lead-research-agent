import { FETCH_LIMITS } from '../config/settings.ts';
import type { Limiter } from './limiter.ts';
import { safeFetch, type SafeResponse } from './safe-fetch.ts';

/** What the audit needs from the network. Real = SSRF-safe fetch; mock = fixtures. */
export interface GetOptions {
  readonly maxBytes: number;
  readonly accept?: string;
  readonly allowRedirect?: (url: URL) => Promise<boolean>;
}

export type HttpGetter = (url: string, options: GetOptions) => Promise<SafeResponse>;

/** Real getter: every website request goes through safeFetch and the shared per-hop concurrency limiter. */
export function createSafeGetter(userAgent: string, limiter: Limiter): HttpGetter {
  return (url, options) =>
    safeFetch(url, {
      userAgent,
      limiter, // held per hop only, so redirect checks that fetch robots.txt cannot deadlock
      timeoutMs: FETCH_LIMITS.timeoutMs,
      maxRedirects: FETCH_LIMITS.maxRedirects,
      maxBytes: options.maxBytes,
      ...(options.accept ? { accept: options.accept } : {}),
      ...(options.allowRedirect ? { allowRedirect: options.allowRedirect } : {}),
    });
}
