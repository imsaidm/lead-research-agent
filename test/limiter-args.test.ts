import { describe, expect, it } from 'vitest';
import { parseCliArgs, resolveContact, resolveModel } from '../src/args.ts';
import { createIntervalLimiter, createSemaphore } from '../src/net/limiter.ts';

describe('createSemaphore', () => {
  it('never runs more than N tasks at once (website fetches: 2)', async () => {
    const sem = createSemaphore(2);
    let active = 0;
    let peak = 0;
    const task = () => sem.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBe(2);
  });

  it('releases the slot when a task throws', async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('createIntervalLimiter', () => {
  it('spaces task starts by the minimum interval (Nominatim: 1 req/s)', async () => {
    let clock = 0;
    let sleeps: number[] = [];
    const limiter = createIntervalLimiter(1_000, () => clock, async (ms) => {
      sleeps = [...sleeps, ms];
      clock += ms;
    });
    const starts: number[] = [];
    await Promise.all([1, 2, 3].map(() => limiter.run(async () => { starts.push(clock); })));
    expect(starts).toEqual([0, 1_000, 2_000]);
    expect(sleeps).toEqual([1_000, 1_000]);
  });
});

describe('parseCliArgs', () => {
  it('parses a full command line', () => {
    const r = parseCliArgs(['--niche', 'Plumber', '--city', 'Austin, TX', '--limit', '10', '--mock'], {});
    expect(r).toMatchObject({ ok: true, args: { niche: 'plumber', city: 'Austin, TX', limit: 10, mock: true, noLlm: false, drafts: 5 } });
  });

  it.each([
    [['--niche', 'astronaut', '--city', 'Austin'], /niche must be one of/],
    [['--niche', 'plumber', '--city', 'Austin', '--limit', '500'], /--limit/],
    [['--niche', 'plumber', '--city', '<script>'], /--city/],
    [['--niche', 'plumber', '--city', 'Austin', '--bogus'], /Unknown option/],
  ])('rejects %j', (argv, message) => {
    const r = parseCliArgs(argv, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it('takes the budget from the environment unless given', () => {
    const r = parseCliArgs(['--niche', 'plumber', '--city', 'Austin'], { LEAD_AGENT_BUDGET_USD: '0.2' });
    expect(r.ok && r.args.budget).toBe(0.2);
  });
});

describe('env resolution', () => {
  it('validates model ids and contact', () => {
    expect(resolveModel({})).toBe('claude-haiku-4-5-20251001');
    expect(resolveModel({ LEAD_AGENT_MODEL: 'claude-sonnet-5-5' })).toBe('claude-sonnet-5-5');
    expect(() => resolveModel({ LEAD_AGENT_MODEL: 'gpt-4; rm -rf' })).toThrow();
    expect(() => resolveContact({ LEAD_AGENT_CONTACT: 'bad\r\nInjected: header' })).toThrow();
    expect(resolveContact({ LEAD_AGENT_CONTACT: 'me@myagency.dev' })).toBe('me@myagency.dev');
  });
});

describe('contact resolution (OSM blocks placeholder contacts)', () => {
  it('returns null when unset and refuses reserved example domains', () => {
    expect(resolveContact({})).toBeNull();
    expect(() => resolveContact({ LEAD_AGENT_CONTACT: 'you@example.com' })).toThrow(/real address/);
    expect(() => resolveContact({ LEAD_AGENT_CONTACT: 'https://agency.example/' })).toThrow(/real address/);
    expect(resolveContact({ LEAD_AGENT_CONTACT: 'https://myagency.dev/contact' })).toBe('https://myagency.dev/contact');
  });
});
