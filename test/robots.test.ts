import { describe, expect, it } from 'vitest';
import { decideFromRobotsResponse, isPathAllowed, parseRobots } from '../src/net/robots.ts';

const UA = 'LeadResearchAgent';

describe('parseRobots + isPathAllowed', () => {
  it('allows everything for an empty file', () => {
    expect(isPathAllowed(parseRobots(''), UA, '/')).toBe(true);
  });

  it('honours a global disallow', () => {
    const r = parseRobots('User-agent: *\nDisallow: /\n');
    expect(isPathAllowed(r, UA, '/')).toBe(false);
  });

  it('prefers the group matching our product token over *', () => {
    const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: leadresearchagent\nAllow: /\n');
    expect(isPathAllowed(r, UA, '/')).toBe(true);
  });

  it('a specific group that disallows us wins even if * allows', () => {
    const r = parseRobots('User-agent: *\nAllow: /\n\nUser-agent: LeadResearchAgent\nDisallow: /\n');
    expect(isPathAllowed(r, UA, '/')).toBe(false);
  });

  it('ignores groups for other bots', () => {
    const r = parseRobots('User-agent: Googlebot\nDisallow: /\n');
    expect(isPathAllowed(r, UA, '/')).toBe(true);
  });

  it('uses longest match; allow wins ties', () => {
    const r = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /tie\nAllow: /tie\n');
    expect(isPathAllowed(r, UA, '/private/x')).toBe(false);
    expect(isPathAllowed(r, UA, '/private/ok/page')).toBe(true);
    expect(isPathAllowed(r, UA, '/tie')).toBe(true);
    expect(isPathAllowed(r, UA, '/')).toBe(true);
  });

  it('supports * and $ wildcards', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.php$\nDisallow: /a*b\n');
    expect(isPathAllowed(r, UA, '/index.php')).toBe(false);
    expect(isPathAllowed(r, UA, '/index.php?x=1')).toBe(true);
    expect(isPathAllowed(r, UA, '/axxb/c')).toBe(false);
  });

  it('merges consecutive user-agent lines into one group and ignores comments/empty disallow', () => {
    const r = parseRobots('# hi\nUser-agent: foo\nUser-agent: *\nDisallow: # nothing\n');
    expect(isPathAllowed(r, UA, '/')).toBe(true);
  });

  it('handles CRLF and BOM', () => {
    const r = parseRobots('\uFEFFUser-agent: *\r\nDisallow: /\r\n');
    expect(isPathAllowed(r, UA, '/')).toBe(false);
  });
});

describe('decideFromRobotsResponse (RFC 9309)', () => {
  it('2xx: parse rules', () => {
    expect(decideFromRobotsResponse({ status: 200, body: 'User-agent: *\nDisallow: /' }, UA, '/')).toEqual({ allowed: false, reason: 'disallowed' });
  });
  it('4xx: full allow', () => {
    expect(decideFromRobotsResponse({ status: 404, body: '' }, UA, '/')).toEqual({ allowed: true, reason: 'no_robots' });
  });
  it('5xx: complete disallow (unreachable)', () => {
    expect(decideFromRobotsResponse({ status: 503, body: '' }, UA, '/')).toEqual({ allowed: false, reason: 'unreachable' });
  });
  it('network error: complete disallow (unreachable)', () => {
    expect(decideFromRobotsResponse(null, UA, '/')).toEqual({ allowed: false, reason: 'unreachable' });
  });
});
