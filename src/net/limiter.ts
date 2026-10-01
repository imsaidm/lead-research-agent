/** Concurrency + spacing primitives used for polite crawling. */

export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** At most `max` tasks in flight at once. */
export function createSemaphore(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) throw new Error('semaphore size must be a positive integer');
  let active = 0;
  let waiting: (() => void)[] = [];

  const release = (): void => {
    active -= 1;
    const [next, ...rest] = waiting;
    waiting = rest;
    next?.();
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= max) await new Promise<void>((resolve) => (waiting = [...waiting, resolve]));
      active += 1;
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/** Serializes tasks and keeps at least `minIntervalMs` between task starts. */
export function createIntervalLimiter(
  minIntervalMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Limiter {
  let chain: Promise<unknown> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = chain.then(async () => {
        const wait = lastStart + minIntervalMs - now();
        if (wait > 0) await sleep(wait);
        lastStart = now();
        return task();
      });
      chain = result.catch(() => undefined);
      return result;
    },
  };
}
