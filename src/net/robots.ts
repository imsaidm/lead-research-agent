/**
 * Minimal RFC 9309 robots.txt support (pure functions).
 * Group selection: the group whose user-agent matches our product token
 * (case-insensitive, prefix match) wins; otherwise the `*` group.
 * Rule matching: longest pattern wins, `allow` wins ties; `*` and `$` supported.
 * Parsing is linear and capped so a hostile robots.txt cannot burn CPU.
 */

export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
}

export interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
}

export interface Robots {
  readonly groups: readonly RobotsGroup[];
}

export type RobotsReason = 'allowed' | 'disallowed' | 'no_robots' | 'unreachable';

export interface RobotsDecision {
  readonly allowed: boolean;
  readonly reason: RobotsReason;
}

export const ROBOTS_LIMITS = Object.freeze({ maxLines: 5_000, maxRules: 1_000, maxPatternLength: 500 });

export function parseRobots(text: string): Robots {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/, ROBOTS_LIMITS.maxLines);
  // Local, append-only builders (linear time); the result is frozen before it escapes.
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let lastWasAgent = false;
  let ruleCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const sep = line.indexOf(':');
    if (sep < 1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    const last = groups[groups.length - 1];

    if (field === 'user-agent') {
      if (last && lastWasAgent) last.agents.push(value.toLowerCase());
      else groups.push({ agents: [value.toLowerCase()], rules: [] });
      lastWasAgent = true;
    } else if ((field === 'allow' || field === 'disallow') && last) {
      lastWasAgent = false;
      if (value === '' || ruleCount >= ROBOTS_LIMITS.maxRules) continue; // empty disallow = allow everything
      last.rules.push({ allow: field === 'allow', pattern: value.slice(0, ROBOTS_LIMITS.maxPatternLength) });
      ruleCount += 1;
    } else {
      lastWasAgent = false;
    }
  }
  return Object.freeze({ groups: Object.freeze(groups.map((g) => Object.freeze({ agents: [...g.agents], rules: [...g.rules] }))) });
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

function selectGroups(robots: Robots, productToken: string): readonly RobotsGroup[] {
  const token = productToken.toLowerCase();
  const specific = robots.groups.filter((g) => g.agents.some((a) => a !== '*' && token.startsWith(a)));
  if (specific.length > 0) return specific;
  return robots.groups.filter((g) => g.agents.includes('*'));
}

export function isPathAllowed(robots: Robots, productToken: string, path: string): boolean {
  const rules = selectGroups(robots, productToken).flatMap((g) => g.rules);
  const best = rules
    .filter((r) => patternToRegex(r.pattern).test(path))
    .reduce<RobotsRule | null>((winner, r) => {
      if (!winner) return r;
      if (r.pattern.length !== winner.pattern.length) return r.pattern.length > winner.pattern.length ? r : winner;
      return r.allow ? r : winner;
    }, null);
  return best ? best.allow : true;
}

/** What we learned from fetching robots.txt once per origin. null = network error/timeout. */
export interface FetchedRobots {
  readonly status: number;
  readonly robots: Robots;
}

export function toFetchedRobots(response: { readonly status: number; readonly body: string }): FetchedRobots {
  const ok = response.status >= 200 && response.status < 300;
  return { status: response.status, robots: ok ? parseRobots(response.body) : { groups: [] } };
}

/** RFC 9309: 2xx -> rules; 4xx (and unresolved redirects) -> allow all; 5xx/unreachable -> disallow all. */
export function decide(fetched: FetchedRobots | null, productToken: string, path: string): RobotsDecision {
  if (fetched === null || fetched.status >= 500) return { allowed: false, reason: 'unreachable' };
  if (fetched.status >= 300) return { allowed: true, reason: 'no_robots' };
  const allowed = isPathAllowed(fetched.robots, productToken, path);
  return { allowed, reason: allowed ? 'allowed' : 'disallowed' };
}

/** Convenience wrapper: one response, one path. */
export function decideFromRobotsResponse(
  response: { readonly status: number; readonly body: string } | null,
  productToken: string,
  path: string,
): RobotsDecision {
  return decide(response === null ? null : toFetchedRobots(response), productToken, path);
}
