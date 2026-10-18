/**
 * RFC 0244 §C — efficiency scalars (ADR 0889 D4). Reported, NEVER gated: no
 * caller may fail a task or a suite on these numbers.
 *
 * Counted from the events a trial produced inside its own bracket. Judge calls
 * are excluded by construction — the judge runs outside the bracket and its
 * `provider.usage` is never passed here (RFC 0244 §C / RFC 0081 UQ 5).
 */

export interface TrialEvent {
  type: string;
  payload?: unknown;
}

export interface Efficiency {
  toolCallCount: number;
  modelCallCount: number;
  inputTokens: number;
  outputTokens: number;
}

/** Both the v1 (`agent.toolCalled`) and v2 (`agent.tool-called`) spellings count. */
const TOOL_CALLED = new Set(['agent.toolCalled', 'agent.tool-called']);
const PROVIDER_USAGE = new Set(['provider.usage']);

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function countTrialEfficiency(events: ReadonlyArray<TrialEvent>): Efficiency {
  const out: Efficiency = { toolCallCount: 0, modelCallCount: 0, inputTokens: 0, outputTokens: 0 };
  for (const e of events) {
    if (TOOL_CALLED.has(e.type)) out.toolCallCount += 1;
    else if (PROVIDER_USAGE.has(e.type)) {
      out.modelCallCount += 1;
      const p = (e.payload ?? {}) as Record<string, unknown>;
      out.inputTokens += num(p.inputTokens);
      out.outputTokens += num(p.outputTokens);
    }
  }
  return out;
}

/** The per-task block: each field is the mean over the task's trials. */
export function meanEfficiency(trials: ReadonlyArray<Efficiency>): Efficiency {
  const n = trials.length || 1;
  const sum = (f: keyof Efficiency): number => trials.reduce((s, t) => s + t[f], 0) / n;
  return {
    toolCallCount: sum('toolCallCount'),
    modelCallCount: sum('modelCallCount'),
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
  };
}
