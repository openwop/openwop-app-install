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
 * Same persistence posture as `variablesRuntime.ts`: in-process Map
 * keyed by runId; survives the process lifetime, not a restart.
 */

import type { AgentRef } from '../executor/types.js';

const runAgents = new Map<string, AgentRef>();

/** Stamp the active agent for `runId`. Later stamps win (the field
 *  rotates with the active worker per run-snapshot.schema.json). */
export function setRunAgent(runId: string, ref: AgentRef): void {
  if (typeof ref.agentId !== 'string' || ref.agentId.length === 0) return;
  runAgents.set(runId, ref);
}

/** The latest stamped AgentRef for `runId`, or null when the run has
 *  no agent provenance (legacy single-actor runs). */
export function getRunAgent(runId: string): AgentRef | null {
  return runAgents.get(runId) ?? null;
}

/** Drop the stamp for `runId`. Safe on absent runIds. */
export function clearRunAgent(runId: string): void {
  runAgents.delete(runId);
}

/** Test-only: drop EVERY run's agent stamp. */
export function __resetAllRunAgentsForTests(): void {
  runAgents.clear();
}
