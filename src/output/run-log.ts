import { appendFileSync } from 'node:fs';

/**
 * Append-only JSONL run log (one event per line, written immediately so a
 * crashed or budget-stopped run still leaves a trail). Secrets are never
 * passed in; long strings are truncated defensively.
 */
export interface RunLog {
  event(type: string, data?: Readonly<Record<string, unknown>>): void;
}

const MAX_STRING = 2_000;

function truncateDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated]` : value;
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => truncateDeep(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateDeep(v, depth + 1)]));
}

/** Logging must never crash a run: IO errors are reported once on stderr and further events are dropped. */
export function createRunLog(filePath: string | null, clock: () => Date = () => new Date()): RunLog {
  let broken = false;
  return {
    event(type, data = {}) {
      if (!filePath || broken) return;
      try {
        const line = JSON.stringify({ ts: clock().toISOString(), type, ...(truncateDeep(data) as object) });
        appendFileSync(filePath, `${line}\n`, 'utf8');
      } catch (err) {
        broken = true;
        process.stderr.write(`warning: run log disabled (${errorMessage(err)})\n`);
      }
    },
  };
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'unknown error';
}

export const NULL_LOG: RunLog = Object.freeze({ event: () => undefined });
