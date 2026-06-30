/**
 * ADR 0137 Phase 2 — the run-store sweep + the cadence daemon (knowledge-sync clone:
 * setInterval.unref + running-guard + per-(tenant,day) idempotency claim). Read-only over
 * the run store; the ONLY writer is the suggestion store. `sweepTenant` is the single
 * sweep owner — both the daemon and the P3 on-demand refresh call it.
 *
 * @see docs/adr/0137-ambient-work-graph.md
 */
import type { Storage } from '../../storage/storage.js';
import { createLogger } from '../../observability/logger.js';
import { clusterAndDetect } from './runSignature.js';
import { upsertSuggestion } from './suggestionStore.js';
import type { RunSignatureInput } from './types.js';

const log = createLogger('feature.ambient-work-graph');
const POLL_INTERVAL_MS = 60 * 60 * 1000; // hourly — recurrence is a slow signal
const RUN_SCAN_LIMIT = 500;
const MIN_COUNT = 3; // a pattern must recur ≥ 3× to be worth suggesting

/** Gather the signature inputs for a tenant: completed runs + their tool-call sequence
 *  (names only — privacy-safe). Bounded by RUN_SCAN_LIMIT. */
export async function gatherRunInputs(storage: Storage, tenantId: string, limit = RUN_SCAN_LIMIT): Promise<RunSignatureInput[]> {
  const runs = await storage.listRuns({ tenantId, status: 'completed', limit });
  const inputs: RunSignatureInput[] = [];
  for (const run of runs) {
    const toolNames: string[] = [];
    let agentId: string | undefined;
    for (const e of await storage.listEvents(run.runId)) {
      if (e.type === 'agent.toolCalled') {
        const p = e.payload as { toolName?: unknown; agentId?: unknown };
        if (typeof p.toolName === 'string') toolNames.push(p.toolName);
        if (!agentId && typeof p.agentId === 'string') agentId = p.agentId;
      }
    }
    if (toolNames.length === 0) continue; // no tools → not a workflow pattern
    const goal = typeof run.metadata?.goal === 'string' ? run.metadata.goal : undefined;
    inputs.push({ runId: run.runId, toolNames, createdAt: run.createdAt, ...(agentId ? { agentId } : {}), ...(goal ? { goal } : {}) });
  }
  return inputs;
}

/** Sweep one tenant: detect recurring patterns → upsert suggestions (status preserved).
 *  Returns the number of suggestions detected. */
export async function sweepTenant(deps: { storage: Storage }, tenantId: string, limit = RUN_SCAN_LIMIT): Promise<number> {
  const inputs = await gatherRunInputs(deps.storage, tenantId, limit);
  const detected = clusterAndDetect(tenantId, inputs, { minCount: MIN_COUNT });
  for (const s of detected) await upsertSuggestion(s);
  return detected.length;
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
      if (!(await deps.storage.claimIdempotency(`work-graph-sweep:${tenantId}:${daySlot}`, new Date(now).toISOString())).claimed) continue;
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
  const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('work_graph_daemon_started', { pollIntervalMs: POLL_INTERVAL_MS });
  return { stop: () => clearInterval(timer) };
}
