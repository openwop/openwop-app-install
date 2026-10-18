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

/**
 * MT-LOSS-1 — a suite whose last save the server did NOT accept. While this is
 * set, the local cache holds results the server never received, so a healthy
 * read must MERGE into it, not overwrite it (see `loadResults`). Cleared by the
 * next accepted save, which sends the whole merged set.
 */
const UNSYNCED = '.unsynced';
function markUnsynced(suiteKey: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(PREFIX + suiteKey + UNSYNCED, '1');
    else localStorage.removeItem(PREFIX + suiteKey + UNSYNCED);
  } catch { /* storage disabled — nothing local to protect */ }
}
function isUnsynced(suiteKey: string): boolean {
  try { return localStorage.getItem(PREFIX + suiteKey + UNSYNCED) === '1'; } catch { return false; }
}

/** Per case, the newer of the two (ISO `ts`); a case only one side has is kept. */
function mergeNewer(server: Results, local: Results): Results {
  const out: Results = { ...server };
  for (const [id, mine] of Object.entries(local)) {
    const theirs = out[id];
    if (!theirs || mine.ts >= theirs.ts) out[id] = mine;
  }
  return out;
}

/** Load one suite's results — server first, localStorage cache on failure. */
export async function loadResults(suiteKey: string): Promise<Results> {
  try {
    const res = await fetch(`${ROOT}/runs/${encodeURIComponent(suiteKey)}`, fetchOpts({ headers: authedHeaders() }));
    if (res.ok) {
      const body = (await res.json()) as { run?: { results?: Results } | null };
      const server = body.run?.results ?? {};
      // MT-LOSS-1 — refreshing the cache from the server erased results whose
      // save the server had rejected: the tester saw their result, then saw it
      // gone. While the suite is unsynced, the server copy is merged in instead.
      const results = isUnsynced(suiteKey) ? mergeNewer(server, readCache(suiteKey)) : server;
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
 * refreshed the cache from the server on every successful read, so results the
 * server never received were overwritten by the stale server copy and lost
 * (MT-LOSS-1, now closed: a failed save marks the suite unsynced and the next
 * healthy read merges instead of overwriting).
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
    if (!res.ok) { markUnsynced(suiteKey, true); return { ok: false, reason: 'rejected', status: res.status }; }
    markUnsynced(suiteKey, false);
    return { ok: true };
  } catch {
    markUnsynced(suiteKey, true);
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
