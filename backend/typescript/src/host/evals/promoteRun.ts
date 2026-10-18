/**
 * ADR 0889 D9 — turn a captured run into a regression task (RFC 0244 §A + §D).
 *
 * The recorded calls become an `in-order` trajectory (`argsMatch: "ignore"` —
 * the path, not the exact arguments, is the constraint by default) and their
 * recorded results become args-matched fixtures under `onMiss: "fail"`, so the
 * replay is deterministic and a call the original run never made cannot reach
 * a live tool. With `expectedContains` the task is golden-graded on the output
 * too; without it, it is a `kind: "trajectory"` task. The author edits from there.
 */
import type { EvalTaskDef } from './suiteStore.js';
import type { BoundaryRow } from './toolBoundary.js';

function parseResult(result: string): unknown {
  try { return JSON.parse(result); } catch { return result; }
}

export function buildTaskFromRun(opts: {
  taskId: string;
  input: unknown;
  boundary: ReadonlyArray<Pick<BoundaryRow, 'tool' | 'input' | 'result' | 'isError'>>;
  expectedContains?: string;
}): EvalTaskDef {
  const calls = opts.boundary.map((b) => ({ tool: b.tool, argsMatch: 'ignore' as const }));
  const toolResponses = opts.boundary.map((b) => ({ tool: b.tool, args: b.input, argsMatch: 'exact' as const, response: parseResult(b.result) }));
  return {
    taskId: opts.taskId,
    input: opts.input ?? {},
    expected: opts.expectedContains
      ? { kind: 'golden', match: { strategy: 'contains', value: opts.expectedContains }, trajectory: { match: 'in-order', calls } }
      : { kind: 'trajectory', trajectory: { match: 'in-order', calls } },
    fixtures: { onMiss: 'fail', toolResponses },
  };
}
