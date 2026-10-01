import { FETCH_LIMITS } from '../config/settings.ts';
import type { HttpGetter } from '../net/http-getter.ts';
import { decide, toFetchedRobots, type FetchedRobots, type RobotsDecision } from '../net/robots.ts';
import { SafeFetchError, type SafeFetchErrorCode } from '../net/safe-fetch.ts';

export interface RobotsCheckResult extends RobotsDecision {
  /** Set when robots.txt could not be fetched; lets the audit tell "site down" from "blocked". */
  readonly errorCode: SafeFetchErrorCode | null;
}

/** Decides whether `url` (its path + query) may be fetched. */
export type RobotsChecker = (url: URL) => Promise<RobotsCheckResult>;

interface OriginRobots {
  readonly fetched: FetchedRobots | null;
  readonly errorCode: SafeFetchErrorCode | null;
}

/** Fetches and parses robots.txt once per origin per run, then evaluates each URL's path against it. */
export function createRobotsChecker(get: HttpGetter, productToken: string): RobotsChecker {
  const cache = new Map<string, Promise<OriginRobots>>();

  const load = async (origin: string): Promise<OriginRobots> => {
    try {
      const res = await get(`${origin}/robots.txt`, { maxBytes: FETCH_LIMITS.robotsMaxBytes, accept: 'text/plain,*/*;q=0.5' });
      return { fetched: toFetchedRobots(res), errorCode: null };
    } catch (err) {
      return { fetched: null, errorCode: err instanceof SafeFetchError ? err.code : 'network' };
    }
  };

  return async (url) => {
    const pending = cache.get(url.origin) ?? load(url.origin);
    cache.set(url.origin, pending);
    const { fetched, errorCode } = await pending;
    return { ...decide(fetched, productToken, `${url.pathname}${url.search}`), errorCode };
  };
}
