/**
 * ADR 0137 Phase 2 + ADR 0930 — the run-store sweep and the cadence daemon
 * (knowledge-sync clone: setInterval.unref + running-guard + per-(tenant,hour)
 * idempotency claim). Read-only over the run store; the ONLY writer is the suggestion
 * store.
 *
 * Mining is PER OWNER (ADR 0930 D1). Each run is reduced to its owner key
 * (`ownership.ts`) BEFORE any event read, and runs that are not a person's manual work are
 * dropped there (D2). Two entry points share the one gatherer:
 *
 *   - `sweepOwner` — the on-demand Scan for ONE person: their runs only, bounded by
 *     rows scanned and owned runs read (A9);
 *   - `sweepTenant` — the daemon's pass: one tenant scan, grouped by owner.
 *
 * Suppression (a pause or an erasure tombstone) is read before an owner is mined and
 * again after their rows are written: a pause that landed mid-sweep deletes what the
 * sweep just wrote (A2). The read routes also refuse to serve a suppressed owner's rows.
 *
 * @see docs/adr/0137-ambient-work-graph.md
 * @see docs/adr/0930-ambient-work-graph-per-owner.md
 */
import type { Storage } from '../../storage/storage.js';
import type { RunRecord } from '../../types.js';
import { runUnderWorkerContract } from '../../storage/eventEraAdapter.js';
import { createLogger } from '../../observability/logger.js';
import { clusterAndDetect } from './runSignature.js';
import { forgetOwner, purgeLegacySuggestions, upsertSuggestion } from './suggestionStore.js';
import { isSuppressed, suppressedOwnerKeys } from './pauseStore.js';
import { runOwnerKey } from './ownership.js';
import { isAnonTenantId } from '../../host/requestSubject.js';
import type { RunSignatureInput } from './types.js';

const log = createLogger('feature.ambient-work-graph');
const POLL_INTERVAL_MS = 60 * 60 * 1000; // hourly — recurrence is a slow signal
const MIN_COUNT = 3; // a pattern must recur ≥ 3× to be worth suggesting
const PAGE = 200;
/** ADR 0930 A9 — completed runs examined per Scan (the tenant's newest). */
export const SCAN_ROW_CAP = 1000;
/** ADR 0930 A9 — owned runs whose events one Scan reads. */
export const SCAN_OWNED_CAP = 200;
/** The daemon's per-tenant window (unchanged from ADR 0137). */
const DAEMON_ROW_CAP = 500;

export interface ScanResult {
  /** Suggestions detected (≥ threshold) for the owner(s) mined. */
  detected: number;
  /** Completed runs examined. */
  scanned: number;
  /** True when the scan stopped before the tenant's oldest completed run. */
  truncated: boolean;
}

/** Page the tenant's newest completed runs, keeping those `keep` returns a key for. */
async function collectRuns(
  storage: Storage,
  tenantId: string,
  rowCap: number,
  keep: (run: RunRecord) => string | null,
  ownedCap: number,
  needTruncated: boolean,
): Promise<{ owned: Array<{ run: RunRecord; ownerKey: string }>; scanned: number; truncated: boolean }> {
  const owned: Array<{ run: RunRecord; ownerKey: string }> = [];
  let scanned = 0;
  let before: { createdAt: string; runId: string } | undefined;
  for (;;) {
    const limit = Math.min(PAGE, rowCap - scanned);
    if (limit <= 0) break;
    const page = await storage.listRuns({ tenantId, status: 'completed', limit, ...(before ? { before } : {}) });
    for (const run of page) {
      scanned++;
      const ownerKey = keep(run);
      if (ownerKey !== null) owned.push({ run, ownerKey });
      if (owned.length >= ownedCap) break;
    }
    const last = page[page.length - 1];
    // The owned cap stops the scan where it stands, so older runs may exist (AWG2CD-7).
    if (owned.length >= ownedCap) return { owned, scanned, truncated: true };
    // A short page is the end of the tenant.
    if (page.length < limit || last === undefined) return { owned, scanned, truncated: false };
    before = { createdAt: last.createdAt, runId: last.runId };
  }
  // The row cap: say whether anything older exists — only a caller that reports it asks.
  return { owned, scanned, truncated: needTruncated ? (await storage.listRuns({ tenantId, status: 'completed', limit: 1, ...(before ? { before } : {}) })).length > 0 : true };
}

/** Read one run's tool-call sequence (names only — privacy-safe). Null when it called none. */
async function toInput(storage: Storage, run: RunRecord, ownerKey: string): Promise<RunSignatureInput | null> {
  const toolNames: string[] = [];
  let agentId: string | undefined;
  for (const e of await storage.listEvents(run.runId)) {
    if (e.type === 'agent.toolCalled') {
      const p = e.payload as { toolName?: unknown; agentId?: unknown };
      if (typeof p.toolName === 'string') toolNames.push(p.toolName);
      if (!agentId && typeof p.agentId === 'string') agentId = p.agentId;
    }
  }
  if (toolNames.length === 0) return null; // no tools → not a workflow pattern
  const goal = typeof run.metadata?.goal === 'string' ? run.metadata.goal : undefined;
  return { runId: run.runId, ownerKey, toolNames, createdAt: run.createdAt, ...(agentId ? { agentId } : {}), ...(goal ? { goal } : {}) };
}

/** Cluster and store one owner's inputs, then honour a suppression that landed meanwhile. */
async function storeOwner(tenantId: string, ownerKey: string, inputs: readonly RunSignatureInput[]): Promise<number> {
  const detected = clusterAndDetect(tenantId, ownerKey, inputs, { minCount: MIN_COUNT });
  for (const s of detected) await upsertSuggestion(s);
  if (await isSuppressed(tenantId, ownerKey)) {
    await forgetOwner(tenantId, ownerKey, { keepDismissals: true });
    return 0;
  }
  return detected.length;
}

/** The on-demand Scan for ONE person (ADR 0930 D3/A9). A suppressed owner is not mined. */
export async function sweepOwner(deps: { storage: Storage }, tenantId: string, ownerKey: string): Promise<ScanResult> {
  await purgeLegacySuggestions(tenantId);
  if (await isSuppressed(tenantId, ownerKey)) return { detected: 0, scanned: 0, truncated: false };
  const { owned, scanned, truncated } = await collectRuns(
    deps.storage, tenantId, SCAN_ROW_CAP,
    (run) => (runOwnerKey(run) === ownerKey ? ownerKey : null),
    SCAN_OWNED_CAP,
    true,
  );
  const inputs: RunSignatureInput[] = [];
  for (const { run } of owned) {
    const input = await toInput(deps.storage, run, ownerKey);
    if (input) inputs.push(input);
  }
  return { detected: await storeOwner(tenantId, ownerKey, inputs), scanned, truncated };
}

/** The daemon's pass over one tenant: one scan, mined per owner. Returns suggestions
 *  detected. An anonymous sandbox is never mined (ADR 0930 A6). */
export async function sweepTenant(deps: { storage: Storage }, tenantId: string): Promise<number> {
  if (isAnonTenantId(tenantId)) return 0;
  await purgeLegacySuggestions(tenantId);
  const suppressed = await suppressedOwnerKeys(tenantId);
  const { owned } = await collectRuns(deps.storage, tenantId, DAEMON_ROW_CAP, (run) => {
    const key = runOwnerKey(run);
    return key !== null && !suppressed.has(key) ? key : null;
  }, DAEMON_ROW_CAP, false);
  const byOwner = new Map<string, RunSignatureInput[]>();
  for (const { run, ownerKey } of owned) {
    const input = await toInput(deps.storage, run, ownerKey);
    if (!input) continue;
    const list = byOwner.get(ownerKey) ?? [];
    list.push(input);
    byOwner.set(ownerKey, list);
  }
  let detected = 0;
  for (const [ownerKey, inputs] of byOwner) detected += await storeOwner(tenantId, ownerKey, inputs);
  return detected;
}

/** One daemon pass: sweep every candidate tenant under a per-(tenant,hour) idempotency
 *  claim (so multi-instance deploys don't double-sweep). The feature is always-on (toggle
 *  removed); the daemon itself is env-gated (OPENWOP_WORKGRAPH_SWEEP_ENABLED), so this
 *  runs only when an operator opts into continuous background mining. */
export async function processDueSweeps(deps: { storage: Storage }, listTenants: () => Promise<string[]>, now: number): Promise<number> {
  let swept = 0;
  const daySlot = new Date(now).toISOString().slice(0, 13); // hour slot
  for (const tenantId of await listTenants()) {
    try {
      if (isAnonTenantId(tenantId)) continue;
      if (!(await deps.storage.claimOnce(`work-graph-sweep:${tenantId}:${daySlot}`, new Date(now).toISOString())).claimed) continue;
      await sweepTenant(deps, tenantId);
      swept++;
    } catch (err) {
      log.warn('work_graph_tenant_sweep_failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return swept;
}

export interface WorkGraphDaemon { stop: () => void; }

export function startWorkGraphDaemon(deps: { storage: Storage }, listTenants: () => Promise<string[]>): WorkGraphDaemon {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try { await processDueSweeps(deps, listTenants, Date.now()); }
    catch (err) { log.warn('work_graph_daemon_tick_error', { error: err instanceof Error ? err.message : String(err) }); }
    finally { running = false; }
  };
  const timer = setInterval(() => void runUnderWorkerContract(tick), POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('work_graph_daemon_started', { pollIntervalMs: POLL_INTERVAL_MS });
  return { stop: () => clearInterval(timer) };
}
