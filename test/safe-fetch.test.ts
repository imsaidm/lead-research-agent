import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBlockedIp } from '../src/net/ip-guard.ts';
import { createSemaphore } from '../src/net/limiter.ts';
import { safeFetch, SafeFetchError, type Resolver, type SafeFetchOptions } from '../src/net/safe-fetch.ts';

let server: Server;
let port = 0;
let hits: string[] = [];

function route(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/';
  hits = [...hits, url];
  const redirect = (location: string): void => {
    res.writeHead(302, { Location: location, 'Set-Cookie': 'session=secret' });
    res.end();
  };
  if (url === '/ok') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'a=b' });
    res.end(`<html><title>ok</title>cookie=${req.headers.cookie ?? 'none'}</html>`);
  } else if (url === '/redirect-meta') redirect('http://169.254.169.254/latest/meta-data/');
  else if (url === '/redirect-private-host') redirect(`http://internal.test:${port}/ok`);
  else if (url === '/redirect-mapped') redirect(`http://[::ffff:127.0.0.1]:${port}/ok`);
  else if (url === '/redirect-ftp') redirect('ftp://public.test/file');
  else if (url === '/redirect-file') redirect('file:///etc/passwd');
  else if (url === '/loop') redirect('/loop');
  else if (url.startsWith('/chain/')) {
    const n = Number(url.split('/')[2]);
    redirect(n >= 3 ? '/ok' : `/chain/${n + 1}`);
  } else if (url === '/cookie-redirect') redirect('/ok');
  else if (url === '/big') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('x'.repeat(2_000_000));
  } else if (url === '/gzip') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
    res.end(gzipSync('<html><title>zipped</title></html>'));
  } else if (url === '/gzip-bomb') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
    res.end(gzipSync('a'.repeat(5_000_000)));
  } else if (url === '/hang') {
    // never respond
  } else {
    res.writeHead(404);
    res.end('not found');
  }
}

const hostMap: Record<string, string[]> = {
  'public.test': ['127.0.0.1'],
  'internal.test': ['10.0.0.5'],
  'mixed.test': ['127.0.0.1', '192.168.0.10'],
  'meta.test': ['169.254.169.254'],
  'v6.test': ['::1'],
};

const resolver: Resolver = async (host) => {
  const ips = hostMap[host];
  if (!ips) throw new Error(`ENOTFOUND ${host}`);
  return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

/** Test policy: our local test server (127.0.0.1) is the only exception to the real policy. */
const testPolicy = (ip: string): boolean => (ip === '127.0.0.1' ? false : isBlockedIp(ip));

function opts(extra: Partial<SafeFetchOptions> = {}): SafeFetchOptions {
  return {
    userAgent: 'TestAgent/1.0',
    resolver,
    isBlockedIp: testPolicy,
    allowedPorts: [port],
    timeoutMs: 2_000,
    ...extra,
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'no-error';
  } catch (err) {
    return err instanceof SafeFetchError ? err.code : `unexpected:${String(err)}`;
  }
}

beforeAll(async () => {
  server = createServer(route);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('safeFetch: allowed fetches', () => {
  it('fetches a page via a resolved public host and never sends cookies', async () => {
    const res = await safeFetch(`http://public.test:${port}/ok`, opts());
    expect(res.status).toBe(200);
    expect(res.body).toContain('cookie=none');
    expect(res.redirects).toEqual([]);
  });

  it('follows up to 3 redirects and reports the final URL', async () => {
    const res = await safeFetch(`http://public.test:${port}/chain/1`, opts());
    expect(res.status).toBe(200);
    expect(res.url).toBe(`http://public.test:${port}/ok`);
    expect(res.redirects).toHaveLength(3);
  });

  it('does not replay Set-Cookie across redirects', async () => {
    const res = await safeFetch(`http://public.test:${port}/cookie-redirect`, opts());
    expect(res.body).toContain('cookie=none');
  });

  it('decompresses gzip', async () => {
    const res = await safeFetch(`http://public.test:${port}/gzip`, opts());
    expect(res.body).toContain('zipped');
  });
});

describe('safeFetch: SSRF protection', () => {
  it('blocks loopback IP literals with the default policy before connecting', async () => {
    hits = [];
    const code = await codeOf(safeFetch(`http://127.0.0.1:${port}/ok`, opts({ isBlockedIp: undefined })));
    expect(code).toBe('blocked_ip');
    expect(hits).toEqual([]);
  });

  it('blocks localhost via real DNS resolution', async () => {
    const code = await codeOf(safeFetch(`http://localhost:${port}/ok`, opts({ resolver: undefined, isBlockedIp: undefined })));
    expect(code).toBe('blocked_ip');
  });

  it.each(['internal.test', 'meta.test', 'v6.test', 'mixed.test'])('blocks hosts resolving to private ranges (%s)', async (host) => {
    hits = [];
    expect(await codeOf(safeFetch(`http://${host}:${port}/ok`, opts()))).toBe('blocked_ip');
    expect(hits).toEqual([]);
  });

  it('blocks a redirect to the cloud metadata IP', async () => {
    expect(await codeOf(safeFetch(`http://public.test:${port}/redirect-meta`, opts({ allowedPorts: [port, 80] })))).toBe('blocked_ip');
  });

  it('blocks a redirect to a hostname that resolves to a private IP', async () => {
    hits = [];
    expect(await codeOf(safeFetch(`http://public.test:${port}/redirect-private-host`, opts()))).toBe('blocked_ip');
    expect(hits).toEqual(['/redirect-private-host']);
  });

  it('blocks a redirect to an IPv4-mapped IPv6 loopback literal', async () => {
    const code = await codeOf(
      safeFetch(`http://public.test:${port}/redirect-mapped`, opts({ isBlockedIp: (ip) => (ip === '127.0.0.1' ? false : isBlockedIp(ip)) })),
    );
    expect(code).toBe('blocked_ip');
  });

  it.each(['/redirect-ftp', '/redirect-file'])('blocks redirects to non-http schemes (%s)', async (path) => {
    expect(await codeOf(safeFetch(`http://public.test:${port}${path}`, opts()))).toBe('blocked_scheme');
  });

  it('stops after more than 3 redirects', async () => {
    expect(await codeOf(safeFetch(`http://public.test:${port}/loop`, opts()))).toBe('too_many_redirects');
  });

  it.each([
    ['file:///etc/passwd', 'blocked_scheme'],
    ['gopher://public.test/', 'blocked_scheme'],
    ['http://user:pass@public.test/', 'invalid_url'],
    ['not a url', 'invalid_url'],
    ['http://public.test:22/', 'blocked_port'],
  ])('rejects %s', async (url, code) => {
    expect(await codeOf(safeFetch(url, opts({ allowedPorts: [80, 443] })))).toBe(code);
  });

  it('lets the caller veto a redirect (robots.txt hook)', async () => {
    const code = await codeOf(safeFetch(`http://public.test:${port}/chain/1`, opts({ allowRedirect: async () => false })));
    expect(code).toBe('redirect_disallowed');
  });
});

describe('safeFetch: concurrency', () => {
  it('does not hold the limiter slot while allowRedirect runs (no deadlock)', async () => {
    const limiter = createSemaphore(1);
    const allowRedirect = async (): Promise<boolean> => limiter.run(async () => true);
    const res = await safeFetch(`http://public.test:${port}/chain/1`, opts({ limiter, allowRedirect, timeoutMs: 1_500 }));
    expect(res.status).toBe(200);
  });
});

describe('safeFetch: resource limits', () => {
  it('caps the response size and marks it truncated', async () => {
    const res = await safeFetch(`http://public.test:${port}/big`, opts({ maxBytes: 100_000 }));
    expect(res.truncated).toBe(true);
    expect(res.bytes).toBeLessThanOrEqual(100_000);
  });

  it('caps decompressed size (gzip bomb)', async () => {
    const res = await safeFetch(`http://public.test:${port}/gzip-bomb`, opts({ maxBytes: 100_000 }));
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(100_000);
  });

  it('times out slow servers', async () => {
    expect(await codeOf(safeFetch(`http://public.test:${port}/hang`, opts({ timeoutMs: 300 })))).toBe('timeout');
  });
});
