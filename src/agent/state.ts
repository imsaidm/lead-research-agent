import type { Audit, Business, DraftResult } from '../schemas.ts';
import type { GeoArea } from '../sources/osm-parse.ts';

export type RunMode = 'agent' | 'template';

export interface Task {
  readonly runId: string;
  readonly niche: string;
  readonly city: string;
  readonly limit: number;
  readonly maxDrafts: number;
  readonly nowYear: number;
  /** 'agent' = Claude (or the mock LLM) orchestrates; 'template' = fixed pipeline, no LLM. */
  readonly mode: RunMode;
  /** Offline fixtures + mock LLM. */
  readonly offline: boolean;
  readonly model: string | null;
}

export interface RunState {
  readonly area: GeoArea | null;
  readonly businesses: readonly Business[];
  readonly searched: boolean;
  readonly audits: Readonly<Record<string, Audit>>;
  readonly drafts: Readonly<Record<string, DraftResult>>;
}

export const INITIAL_STATE: RunState = Object.freeze({
  area: null,
  businesses: [],
  searched: false,
  audits: {},
  drafts: {},
});

export interface StateStore {
  get(): RunState;
  update(fn: (state: RunState) => RunState): RunState;
}

/** Holds the current immutable snapshot; every update replaces it with a new frozen object. */
export function createStore(initial: RunState = INITIAL_STATE): StateStore {
  let state = Object.freeze({ ...initial });
  return {
    get: () => state,
    update(fn) {
      state = Object.freeze(fn(state));
      return state;
    },
  };
}
