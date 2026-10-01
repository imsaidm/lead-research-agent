import { FETCH_LIMITS } from '../config/settings.ts';
import { createFixtureGetter } from '../sources/fixture-getter.ts';
import type { HttpGetter } from './http-getter.ts';
import { createSafeGetter } from './http-getter.ts';
import { createSemaphore } from './limiter.ts';

export type GetterConfig = { readonly kind: 'real'; readonly userAgent: string } | { readonly kind: 'fixture'; readonly sites: URL };

/** One website getter per run, always behind the global 2-concurrent-fetch limit. */
export function createHttpGetterFor(config: GetterConfig): HttpGetter {
  const limiter = createSemaphore(FETCH_LIMITS.websiteConcurrency);
  if (config.kind === 'real') return createSafeGetter(config.userAgent, limiter);
  return createFixtureGetter(config.sites, FETCH_LIMITS.maxRedirects, limiter);
}
