/**
 * Manual-test run client (ADR 0183). Reads/writes per-user run progress from the backend
 * (`/host/openwop-app/manual-tests/*`, keyed by the authed caller) so a run is durable +
 * cross-device. localStorage is a best-effort OFFLINE CACHE/FALLBACK: writes go to localStorage
 * immediately (optimistic + survives a backend blip) then sync to the server; reads prefer the
 * server and fall back to the cache when it's unreachable. Result: no lost progress either way.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import type { TestStatus } from './manualTestTypes.js';

export interface CaseResult { status: TestStatus; note: string; ts: string }
export type Results = Record<string, CaseResult>;

const ROOT = `${config.baseUrl}/host/openwop-app/manual-tests`;
const PREFIX = 'openwop.manualTests.';

function readCache(suiteKey: string): Results {
  try { return JSON.parse(localStorage.getItem(PREFIX + suiteKey) ?? '{}') as Results; } catch { return {}; }
}
function writeCache(suiteKey: string, r: Results): void {
  try { localStorage.setItem(PREFIX + suiteKey, JSON.stringify(r)); } catch { /* storage disabled — server is the source of truth */ }
}

/** Load one suite's results — server first, localStorage cache on failure. */
export async function loadResults(suiteKey: string): Promise<Results> {
  try {
    const res = await fetch(`${ROOT}/runs/${encodeURIComponent(suiteKey)}`, fetchOpts({ headers: authedHeaders() }));
    if (res.ok) {
      const body = (await res.json()) as { run?: { results?: Results } | null };
      const results = body.run?.results ?? {};
      writeCache(suiteKey, results); // refresh the offline cache
      return results;
    }
  } catch { /* offline / backend down → fall back to cache */ }
  return readCache(suiteKey);
}

/**
 * Persist a suite's results — optimistic localStorage write, then server sync.
 *
 * Returns whether the SERVER accepted it, which the caller must surface. This
 * used to return `void` and never check `res.ok`, so a 403/500 resolved
 * normally and was indistinguishable from a successful save.
 *
 * That was not merely silent, it was DESTRUCTIVE. The old comment said "next
 * load reconciles", but reconciliation runs the other way: `loadResults`
 * refreshes the cache from the server on every successful read, so results the
 * server never received were overwritten by the stale server copy and lost.
 * In a tool whose only job is recording test results, the user had no way to
 * know — they saw their result, then later saw it gone.
 */
export interface SaveOutcome {
  ok: boolean;
  /** 'unreachable' = the request never completed; 'rejected' = the server said no. */
  reason?: 'unreachable' | 'rejected';
  status?: number;
}

export async function saveResults(suiteKey: string, results: Results): Promise<SaveOutcome> {
  writeCache(suiteKey, results);
  try {
    const res = await fetch(`${ROOT}/runs/${encodeURIComponent(suiteKey)}`, fetchOpts({
      method: 'PUT', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ results }),
    }));
    if (!res.ok) return { ok: false, reason: 'rejected', status: res.status };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/**
 * All of the caller's runs (server), for list-view progress.
 *
 * `null` means WE COULD NOT READ, which is not the same as `{}` — no runs yet.
 * It used to return `{}` for both, so a failed read rendered as "0 of 47
 * tested" against every suite: a confident, wrong answer telling a tester their
 * recorded work does not exist. The old docstring waved this off with "the
 * per-suite view still hydrates from cache", but the LIST view is the surface
 * showing the number, and it showed zeros.
 */
export async function loadAllRuns(): Promise<Record<string, Results> | null> {
  try {
    const res = await fetch(`${ROOT}/runs`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) return null;
    const body = (await res.json()) as { runs?: { suiteKey: string; results: Results }[] };
    const out: Record<string, Results> = {};
    for (const run of body.runs ?? []) out[run.suiteKey] = run.results;
    return out;
  } catch { return null; }
}
