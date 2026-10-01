import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { GetOptions, HttpGetter } from '../net/http-getter.ts';
import type { Limiter } from '../net/limiter.ts';
import { SafeFetchError, type SafeFetchErrorCode, type SafeResponse } from '../net/safe-fetch.ts';

/** Offline replacement for website fetches (used by --mock, tests and eval). */
const EntrySchema = z.union([
  z.object({ file: z.string(), status: z.number().int(), elapsedMs: z.number().int().nonnegative() }),
  z.object({ redirectTo: z.string(), elapsedMs: z.number().int().nonnegative() }),
  z.object({ error: z.enum(['network', 'dns_failed', 'timeout', 'blocked_ip']), message: z.string().optional() }),
]);
const ManifestSchema = z.record(z.string(), z.unknown());
type Entry = z.infer<typeof EntrySchema>;

export function loadFixtureManifest(dir: URL): Readonly<Record<string, Entry>> {
  const raw = ManifestSchema.parse(JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')));
  const entries = Object.entries(raw)
    .filter(([key]) => !key.startsWith('_'))
    .map(([key, value]) => [key, EntrySchema.parse(value)] as const);
  return Object.freeze(Object.fromEntries(entries));
}

export function createFixtureGetter(dir: URL, maxRedirects = 3, limiter: Limiter = { run: (t) => t() }): HttpGetter {
  const manifest = loadFixtureManifest(dir);

  const fetchOne = async (url: string, options: GetOptions, redirects: readonly string[], elapsed: number): Promise<SafeResponse> => {
    // Like the real getter, the concurrency slot covers one hop, never the redirect check.
    const entry = await limiter.run(async () => manifest[url]);
    if (!entry) {
      if (new URL(url).pathname === '/robots.txt') {
        return { url, status: 404, headers: {}, body: '', bytes: 0, truncated: false, redirects, elapsedMs: elapsed };
      }
      throw new SafeFetchError('network', `ECONNREFUSED (no fixture for ${url})`);
    }
    if ('error' in entry) throw new SafeFetchError(entry.error as SafeFetchErrorCode, entry.message ?? `fixture error: ${entry.error}`);
    if ('redirectTo' in entry) {
      if (redirects.length >= maxRedirects) throw new SafeFetchError('too_many_redirects', 'too many redirects');
      const next = new URL(entry.redirectTo, url);
      if (options.allowRedirect && !(await options.allowRedirect(next))) {
        throw new SafeFetchError('redirect_disallowed', 'redirect disallowed');
      }
      return fetchOne(next.href, options, [...redirects, next.href], elapsed + entry.elapsedMs);
    }
    const full = readFileSync(new URL(entry.file, dir), 'utf8');
    const body = full.slice(0, options.maxBytes);
    return {
      url,
      status: entry.status,
      headers: { 'content-type': 'text/html' },
      body,
      bytes: Buffer.byteLength(body),
      truncated: body.length < full.length,
      redirects,
      elapsedMs: elapsed + entry.elapsedMs,
    };
  };

  return (url, options) => fetchOne(url, options, [], 0);
}
