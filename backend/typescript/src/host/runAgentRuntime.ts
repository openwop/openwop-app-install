/**
 * Run-agent runtime — in-process per-run agent-identity projection for
 * the workflow-engine sample (Multi-Agent Shift Phase 1).
 *
 * Per `run-snapshot.schema.json` §`agent`: when a run is driven by an
 * agent, `RunSnapshot.agent` carries that agent's AgentRef
 * (`agent-ref.schema.json`) — and in multi-worker runs it rotates with
 * the ACTIVE worker for the current node. The executor stamps the ref
 * here whenever it launches a node that carries an authoring-time
 * `nodes[].agent` pin; `GET /v1/runs/{runId}` projects the latest
 * stamp.
 *
 * Provenance flows through verbatim: a pin that carries
 * `sourceManifestId` (pack-installed agents, RFC 0003) surfaces it on
 * the runtime AgentRef so audit consumers can trace the agent back to
 * its distribution source (the agentPackProvenance conformance
 * contract).
 *
 * Durable, write-through cache (ENG-3) — same posture as `variablesRuntime.ts`:
 * stamps persist to kv Storage and `hydrateRunAgent(runId)` reloads them, so a
 * run re-dispatched by the sweeper on another instance recovers its agent
 * provenance. Degrades to in-memory-only without storage.
 */

import type { AgentRef } from '../executor/types.js';
import { tryDurableStorage } from './durable/durableStore.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runAgentRuntime');

const runAgents = new Map<string, AgentRef>();

const KEY_PREFIX = 'runagent:';
const key = (runId: string): string => `${KEY_PREFIX}${runId}`;

/** Stamp the active agent for `runId`. Later stamps win (the field
 *  rotates with the active worker per run-snapshot.schema.json). */
export function setRunAgent(runId: string, ref: AgentRef): void {
  if (typeof ref.agentId !== 'string' || ref.agentId.length === 0) return;
  runAgents.set(runId, ref);
  const storage = tryDurableStorage();
  if (storage) {
    void storage.kvSet(key(runId), JSON.stringify(ref)).catch((err) => {
      log.warn('run_agent_persist_failed', { runId, error: err instanceof Error ? err.message : String(err) });
    });
  }
}

/** Load a run's agent stamp from durable storage into the cache (ENG-3) — the
 *  executor calls this before executing a possibly-re-dispatched run. No-op when
 *  already cached or storage isn't wired. */
export async function hydrateRunAgent(runId: string): Promise<void> {
  if (runAgents.has(runId)) return;
  const storage = tryDurableStorage();
  if (!storage) return;
  try {
    const raw = await storage.kvGet(key(runId));
    if (!raw) return;
    runAgents.set(runId, JSON.parse(raw) as AgentRef);
  } catch (err) {
    log.warn('run_agent_hydrate_failed', { runId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The latest stamped AgentRef for `runId`, or null when the run has
 *  no agent provenance (legacy single-actor runs). */
export function getRunAgent(runId: string): AgentRef | null {
  return runAgents.get(runId) ?? null;
}

/** Drop the stamp for `runId`. Safe on absent runIds. */
export function clearRunAgent(runId: string): void {
  runAgents.delete(runId);
  const storage = tryDurableStorage();
  if (storage) {
    void storage.kvDelete(key(runId)).catch((err) => {
      log.warn('run_agent_delete_failed', { runId, error: err instanceof Error ? err.message : String(err) });
    });
  }
}

/** Test-only: drop EVERY run's agent stamp. */
export function __resetAllRunAgentsForTests(): void {
  runAgents.clear();
}
