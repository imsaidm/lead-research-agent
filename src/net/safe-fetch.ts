import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { FETCH_LIMITS } from '../config/settings.ts';
import { isBlockedIp as defaultIsBlockedIp } from './ip-guard.ts';
import type { Limiter } from './limiter.ts';

/**
 * SSRF-hardened HTTP GET for untrusted URLs (website values from OSM).
 * - only http/https on their default ports (80/443), no credentials in URLs
 * - DNS is resolved up front; EVERY address is checked against the IP policy and
 *   the socket may only use those checked addresses (no second lookup => no DNS rebinding)
 * - redirects are followed manually (max 3) and re-validated hop by hop
 * - one deadline for the whole fetch (DNS, connect, body, redirect checks),
 *   byte cap on the decompressed body
 * - no cookie jar: Cookie is never sent, Set-Cookie is ignored
 * - the concurrency limiter is held per network hop only, never while waiting
 *   on `allowRedirect` (which may itself fetch robots.txt)
 */

export type SafeFetchErrorCode =
  | 'invalid_url'
  | 'blocked_scheme'
  | 'blocked_port'
  | 'blocked_ip'
  | 'dns_failed'
  | 'too_many_redirects'
  | 'redirect_disallowed'
  | 'timeout'
  | 'network';

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  constructor(code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
  }
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface SafeFetchOptions {
  readonly userAgent: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly allowedPorts?: readonly number[];
  readonly accept?: string;
  /** Injected for tests; defaults to the system resolver. */
  readonly resolver?: Resolver;
  /** Injected for tests; defaults to the strict policy in ip-guard.ts. */
  readonly isBlockedIp?: (ip: string) => boolean;
  /** Called before following each redirect (used for robots.txt on new origins). */
  readonly allowRedirect?: (url: URL) => Promise<boolean>;
  /** Shared concurrency limit, held only while a single hop is in flight. */
  readonly limiter?: Limiter;
}

export interface SafeResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly redirects: readonly string[];
  readonly elapsedMs: number;
}

const systemResolver: Resolver = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });
const DEFAULT_PORT: Readonly<Record<string, number>> = Object.freeze({ 'http:': 80, 'https:': 443 });
const UNLIMITED: Limiter = { run: (task) => task() };

/** Rejects as soon as the signal aborts, so no await can outlive the deadline. */
function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SafeFetchError('timeout', 'request timed out'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new SafeFetchError('timeout', 'request timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function validateUrl(raw: string, allowedPorts: readonly number[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError('invalid_url', 'URL could not be parsed');
  }
  const defaultPort = DEFAULT_PORT[url.protocol];
  if (defaultPort === undefined) throw new SafeFetchError('blocked_scheme', `scheme ${url.protocol} is not allowed`);
  if (url.username || url.password) throw new SafeFetchError('invalid_url', 'credentials in URL are not allowed');
  if (!url.hostname) throw new SafeFetchError('invalid_url', 'missing host');
  const port = url.port ? Number(url.port) : defaultPort;
  const otherDefault = Object.values(DEFAULT_PORT).filter((p) => p !== defaultPort);
  if (!allowedPorts.includes(port) || otherDefault.includes(port)) {
    throw new SafeFetchError('blocked_port', `port ${port} is not allowed for ${url.protocol}`);
  }
  return url;
}

async function resolveSafely(hostname: string, resolver: Resolver, blocked: (ip: string) => boolean, signal: AbortSignal): Promise<readonly ResolvedAddress[]> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    if (blocked(bare)) throw new SafeFetchError('blocked_ip', 'destination address is not allowed');
    return [{ address: bare, family: isIP(bare) }];
  }
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await withDeadline(resolver(bare), signal);
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    throw new SafeFetchError('dns_failed', `DNS lookup failed: ${(err as Error).message}`.slice(0, 200));
  }
  if (addresses.length === 0) throw new SafeFetchError('dns_failed', 'no DNS records');
  if (addresses.some((a) => blocked(a.address))) {
    throw new SafeFetchError('blocked_ip', 'host resolves to a non-public address');
  }
  return addresses;
}

/** Hands the socket only the addresses we already validated (all of them, for IPv4/IPv6 fallback). */
function pinnedLookup(pinned: readonly ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const usable = options.family ? pinned.filter((a) => a.family === options.family) : pinned;
    const list = usable.length > 0 ? usable : pinned;
    if (options.all) {
      (callback as (e: null, a: ResolvedAddress[]) => void)(null, [...list]);
    } else {
      const first = list[0] as ResolvedAddress;
      callback(null, first.address, first.family);
    }
  };
}

function decoder(encoding: string | undefined, raw: Readable): Readable {
  const enc = (encoding ?? '').toLowerCase().trim();
  if (enc === 'gzip' || enc === 'x-gzip') return raw.pipe(createGunzip());
  if (enc === 'deflate') return raw.pipe(createInflate());
  if (enc === 'br') return raw.pipe(createBrotliDecompress());
  return raw;
}

interface HopResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly location: string | null;
  readonly body: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const entries = Object.entries(headers)
    .filter(([key]) => key !== 'set-cookie')
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : (value ?? '')] as const);
  return Object.fromEntries(entries);
}

type HopOptions = Required<Pick<SafeFetchOptions, 'userAgent' | 'maxBytes' | 'accept'>>;

function requestOnce(url: URL, pinned: readonly ResolvedAddress[], o: HopOptions, signal: AbortSignal): Promise<HopResult> {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise<HopResult>((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: pinnedLookup(pinned),
        signal,
        headers: { 'User-Agent': o.userAgent, Accept: o.accept, 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en-US,en;q=0.8' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = status >= 300 && status < 400 ? (res.headers.location ?? null) : null;
        if (location !== null) {
          res.resume();
          resolve({ status, headers: flattenHeaders(res.headers), location, body: '', bytes: 0, truncated: false });
          return;
        }
        const stream = decoder(res.headers['content-encoding'], res);
        // Local buffer list: push is O(1); copying per chunk would be quadratic for drip-fed bodies.
        const chunks: Buffer[] = [];
        let bytes = 0;
        let done = false;
        const finish = (truncated: boolean): void => {
          if (done) return;
          done = true;
          resolve({ status, headers: flattenHeaders(res.headers), location: null, body: Buffer.concat(chunks).toString('utf8'), bytes, truncated });
        };
        stream.on('data', (chunk: Buffer) => {
          if (done) return;
          const room = o.maxBytes - bytes;
          const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
          chunks.push(slice);
          bytes += slice.length;
          if (bytes >= o.maxBytes) {
            finish(true);
            res.destroy();
            stream.destroy();
          }
        });
        stream.on('end', () => finish(false));
        stream.on('error', (err) => (done ? undefined : reject(err)));
        res.on('error', (err) => (done ? undefined : reject(err)));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function toSafeError(err: unknown, signal: AbortSignal): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  if (signal.aborted) return new SafeFetchError('timeout', 'request timed out');
  const e = err as NodeJS.ErrnoException;
  return new SafeFetchError('network', `${e.code ?? 'ERROR'}: ${e.message}`.slice(0, 200));
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeResponse> {
  const allowedPorts = options.allowedPorts ?? FETCH_LIMITS.allowedPorts;
  const maxRedirects = options.maxRedirects ?? FETCH_LIMITS.maxRedirects;
  const resolver = options.resolver ?? systemResolver;
  const blocked = options.isBlockedIp ?? defaultIsBlockedIp;
  const limiter = options.limiter ?? UNLIMITED;
  const hopOpts: HopOptions = {
    userAgent: options.userAgent,
    maxBytes: options.maxBytes ?? FETCH_LIMITS.maxBytes,
    accept: options.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
  };
  const signal = AbortSignal.timeout(options.timeoutMs ?? FETCH_LIMITS.timeoutMs);
  const started = performance.now();
  let current = validateUrl(rawUrl, allowedPorts);
  let redirects: readonly string[] = [];

  try {
    for (;;) {
      const pinned = await resolveSafely(current.hostname, resolver, blocked, signal);
      const target = current;
      const hop = await withDeadline(limiter.run(() => requestOnce(target, pinned, hopOpts, signal)), signal);
      if (hop.location === null) {
        return {
          url: current.href, status: hop.status, headers: hop.headers, body: hop.body, bytes: hop.bytes,
          truncated: hop.truncated, redirects, elapsedMs: Math.round(performance.now() - started),
        };
      }
      if (redirects.length >= maxRedirects) throw new SafeFetchError('too_many_redirects', `more than ${maxRedirects} redirects`);
      let next: URL;
      try {
        next = new URL(hop.location, current);
      } catch {
        throw new SafeFetchError('invalid_url', 'redirect location could not be parsed');
      }
      next = validateUrl(next.href, allowedPorts);
      if (options.allowRedirect && !(await withDeadline(options.allowRedirect(next), signal))) {
        throw new SafeFetchError('redirect_disallowed', 'redirect target disallowed by policy (robots.txt)');
      }
      redirects = [...redirects, next.href];
      current = next;
    }
  } catch (err) {
    throw toSafeError(err, signal);
  }
}
