/**
 * RFC 0244 §A — trajectory grading (ADR 0889 D4).
 *
 * A trajectory is a CONSTRAINT on the tool path, never the primary score: a
 * trial with a declared trajectory cannot pass unless it matched, but its score
 * stays the output score (`kind: "trajectory"` tasks score 1/0 on the match).
 *
 * Pure: the observed calls come from the eval runner's tool interceptor (the
 * call as executed, before any wire redaction — RFC 0244 UQ 6), so this module
 * never reads the event log.
 */

export type TrajectoryMatchMode = 'exact' | 'in-order' | 'any-order' | 'subset';
export type ArgsMatch = 'ignore' | 'exact' | 'subset';

export interface ExpectedCall {
  tool: string;
  args?: unknown;
  argsMatch?: ArgsMatch;
}

export interface TrajectoryExpectation {
  match: TrajectoryMatchMode;
  calls: ExpectedCall[];
  forbidden?: string[];
  includeDelegates?: boolean;
}

export interface ObservedCall {
  tool: string;
  input: unknown;
  /** The agent that made the call; a delegate's calls are filtered unless `includeDelegates`. */
  agentId?: string;
}

/** The content-free counts block on the per-task summary entry. */
export interface TrajectoryResult {
  mode: TrajectoryMatchMode;
  matched: boolean;
  expectedCount: number;
  observedCount: number;
  matchedCount: number;
  forbiddenCount: number;
}

/** JSON deep-equal, key order insensitive. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (typeof a === 'object') {
    if (Array.isArray(b)) return false;
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
    const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && jsonEqual(ao[k], bo[k]));
  }
  return false;
}

/**
 * `subset`: every key path in `expected` is present in `actual` with a
 * JSON-deep-equal value. Arrays and scalars at a leaf compare by deep-equal —
 * a subset rule does not recurse into arrays (an array is a value, not a map).
 */
export function jsonSubset(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) return jsonEqual(expected, actual);
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const eo = expected as Record<string, unknown>;
  const ao = actual as Record<string, unknown>;
  return Object.keys(eo).every((k) => Object.prototype.hasOwnProperty.call(ao, k) && jsonSubset(eo[k], ao[k]));
}

export function argsMatch(mode: ArgsMatch | undefined, expected: unknown, actual: unknown): boolean {
  switch (mode ?? 'ignore') {
    case 'ignore': return true;
    case 'exact': return jsonEqual(expected, actual);
    case 'subset': return jsonSubset(expected, actual);
  }
}

export function callMatches(e: ExpectedCall, o: ObservedCall): boolean {
  if (e.tool !== o.tool) return false;
  // An expected call that names `args` but no mode means "ignore" (RFC 0244 §A default).
  return argsMatch(e.argsMatch, e.args, o.input);
}

/** Maximum bipartite matching (Kuhn) — each expected call to a DISTINCT observed call. */
function maxDistinctMatching(expected: ExpectedCall[], observed: ObservedCall[]): number {
  const ownerOf: number[] = new Array(observed.length).fill(-1);
  const tryAssign = (ei: number, seen: boolean[]): boolean => {
    for (let oi = 0; oi < observed.length; oi += 1) {
      if (seen[oi] || !callMatches(expected[ei], observed[oi])) continue;
      seen[oi] = true;
      if (ownerOf[oi] === -1 || tryAssign(ownerOf[oi], seen)) {
        ownerOf[oi] = ei;
        return true;
      }
    }
    return false;
  };
  let count = 0;
  for (let ei = 0; ei < expected.length; ei += 1) {
    if (tryAssign(ei, new Array(observed.length).fill(false))) count += 1;
  }
  return count;
}

/** Greedy in-order subsequence match: how many expected calls (in order) appear. */
function inOrderMatched(expected: ExpectedCall[], observed: ObservedCall[]): number {
  let ei = 0;
  for (const o of observed) {
    if (ei < expected.length && callMatches(expected[ei], o)) ei += 1;
  }
  return ei;
}

/**
 * Select the trial's observed trajectory: the target agent's own calls, or
 * every call in the bracket with `includeDelegates` (RFC 0244 UQ 2). A call
 * with no `agentId` was made through the target's own interceptor.
 */
export function observedFor(calls: ReadonlyArray<ObservedCall>, targetAgentId: string, includeDelegates: boolean | undefined): ObservedCall[] {
  if (includeDelegates) return [...calls];
  return calls.filter((c) => c.agentId === undefined || c.agentId === targetAgentId);
}

export function gradeTrajectory(exp: TrajectoryExpectation, observed: ReadonlyArray<ObservedCall>): TrajectoryResult {
  const calls = exp.calls ?? [];
  const obs = [...observed];
  const forbidden = new Set(exp.forbidden ?? []);
  const forbiddenCount = obs.filter((o) => forbidden.has(o.tool)).length;

  // `matchedCount` is MODE-INDEPENDENT on the wire (RFC 0244 §A, as locked
  // with the corpus 2026-10-14): the size of a maximum one-to-one matching of
  // expected to observed calls, ignoring order. Only `matched` is per mode.
  const matchedCount = maxDistinctMatching(calls, obs);
  let matched: boolean;
  switch (exp.match) {
    case 'exact':
      matched = obs.length === calls.length && calls.every((e, i) => callMatches(e, obs[i]));
      break;
    case 'in-order':
      matched = inOrderMatched(calls, obs) === calls.length;
      break;
    case 'any-order':
      matched = matchedCount === calls.length;
      break;
    case 'subset':
      // Every observed call must match SOME expected call (repeats allowed).
      matched = obs.every((o) => calls.some((e) => callMatches(e, o)));
      break;
  }
  return {
    mode: exp.match,
    matched: matched && forbiddenCount === 0,
    expectedCount: calls.length,
    observedCount: obs.length,
    matchedCount,
    forbiddenCount,
  };
}
