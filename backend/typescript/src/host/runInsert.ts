/**
 * ADR 0099 — the single run-insert seam.
 *
 * Every run-creation path funnels its `storage.insertRun` through here so that
 * cross-cutting run-start decisions (tool-output compaction, future contributors)
 * are frozen into `run.metadata` at creation EXACTLY ONCE, regardless of which
 * subsystem started the run (POST /v1/runs, the scheduler/heartbeat starter,
 * Kanban + trigger-bridge ingestion, MCP-initiated runs, CRM, sub-workflows, …).
 * This is the "single owner" the architecture wants — a new run-creation path
 * inherits the stamp by using this helper instead of `storage.insertRun`
 * directly, rather than silently missing it.
 *
 * The tenant is derived from the run itself (`run.tenantId`), so migrating a call
 * site is a one-line swap. `stampRunStartContext` never overwrites an existing
 * key, so a `:fork`-copied decision is preserved (read verbatim, never
 * re-resolved) and the stamp is a no-op when no contributor is registered or the
 * feature is OFF.
 */

import type { Storage } from '../storage/storage.js';
import type { RunRecord } from '../types.js';
import { stampRunStartContext, type RunStartContext } from './runStartContext.js';
import { extractRunAttribution } from './agentRunActivityIndex.js';

export async function insertRunWithStartContext(
  storage: Storage,
  run: RunRecord,
  ctx?: Partial<RunStartContext>,
): Promise<void> {
  // ADR 0099 Phase 2 — derive the attributed agent (for per-agent lossy opt-in)
  // from the run's own attribution block, via the shared convention reader.
  // `agentProfile` is keyed by ROSTER id (upsertAgentProfile(tenantId, rosterId)),
  // so the rosterId is the profile-lookup key.
  const attribution = extractRunAttribution(run.metadata);
  const agentId = ctx?.agentId ?? attribution?.rosterId;
  run.metadata = await stampRunStartContext(run.metadata, {
    tenantId: ctx?.tenantId ?? run.tenantId,
    ...(agentId ? { agentId } : {}),
  });
  await storage.insertRun(run);
}
