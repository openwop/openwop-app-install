/**
 * ADR 1005 D5 — the RFC 0082 §B channel pin, as a host seam.
 *
 * A workflow node whose `agent` binds a deployment `channel` (no exact `version`)
 * resolves it to ONE concrete version per `(run, agentId, channel)`, and records
 * that version on `agent.invocation.started` (`resolvedChannel` +
 * `resolvedAgentVersion`). The record is the recorded fact:
 *
 *   1. a pin already in THIS run's log is reused (a resume, a retry, a second
 *      node, or the prefix a fork inherited);
 *   2. else a fork re-reads its parent's pin for the pair. A replay never
 *      re-resolves a channel that may have moved since;
 *   3. else the registered resolver reads live deployment state.
 *
 * The deployment store lives in `features/agent-deployments/`, which registers
 * the resolver here, so `executor/` never imports a feature (ADR 0001). No
 * resolver, or the facet switched off, fails the node closed: a channel never
 * falls back to an arbitrary version.
 */

import type { Storage } from '../storage/storage.js';
import type { RunRecord } from '../types.js';
import { getEventLog } from '../executor/eventLog.js';
import { eventTypeSpellings } from '../storage/eventEra.js';
import { agentDeploymentEnabled } from './agentDeploymentFlag.js';
import { agentVersionsServed, servingVersion } from './agentServing.js';
import { getAgentRegistry } from '../executor/agentRegistry.js';

export type ChannelResolution =
  | { ok: true; version: string }
  | { ok: false; reason: 'no_active_deployment' | 'channel_not_advertised' };

export interface AgentChannelResolver {
  /** `drawKey` seeds the canary draw, so one key always lands on one version. */
  resolve(tenantId: string, agentId: string, channel: string, drawKey: string): Promise<ChannelResolution>;
  /** ADR 1014 P0 — can this host run `version` of the agent? A version it cannot
   *  load must never be recorded as the one that ran. Absent = every version. */
  available?(tenantId: string, agentId: string, version: string): Promise<boolean>;
}

let resolver: AgentChannelResolver | undefined;

export function registerAgentChannelResolver(r: AgentChannelResolver | undefined): void {
  resolver = r;
}


/** True when a channel can be resolved on this host: the facet is on and the store registered. */
export function agentChannelsServed(): boolean {
  return agentDeploymentEnabled() && resolver !== undefined;
}

const STARTED = 'agent.invocation.started';
const COMPLETED = 'agent.invocation.completed';

export interface ChannelPin {
  invocationId: string;
  agentId: string;
  channel: string;
  version: string;
}

export type PinOutcome =
  | { ok: true; pin: ChannelPin }
  | { ok: false; error: { code: 'validation_error'; message: string; details: Record<string, unknown> } };

async function recordedPin(storage: Storage, runId: string, agentId: string, channel: string): Promise<string | undefined> {
  const types = eventTypeSpellings(STARTED);
  let fromSeq = -1; // exclusive, as `drainRunEvents` reads it
  for (;;) {
    const page = await storage.listEvents(runId, { fromSeq, limit: 500 });
    for (const e of page) {
      if (!types.has(e.type)) continue;
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (p.agentId === agentId && p.resolvedChannel === channel && typeof p.resolvedAgentVersion === 'string') return p.resolvedAgentVersion;
    }
    if (page.length < 500) return undefined;
    fromSeq = page[page.length - 1]!.sequence;
  }
}

/**
 * Resolve (or re-read) the pin for a channel-bound node and append its
 * `agent.invocation.started`. Returns null when the node binds no channel.
 */
export async function pinAgentChannel(input: {
  storage: Storage;
  run: RunRecord;
  nodeId: string;
  agent: { agentId: string; channel?: string; version?: string } | undefined;
  execution: number;
}): Promise<PinOutcome | null> {
  const { storage, run, nodeId, agent } = input;
  const channel = agent?.channel;
  if (!agent || typeof channel !== 'string' || channel.length === 0) return null;
  const fail = (reason: string, message: string): PinOutcome => ({
    ok: false,
    error: { code: 'validation_error', message, details: { reason, agentId: agent.agentId, channel } },
  });

  let version = await recordedPin(storage, run.runId, agent.agentId, channel);
  if (version === undefined && run.parentRunId) version = await recordedPin(storage, run.parentRunId, agent.agentId, channel);
  if (version === undefined) {
    if (!agentChannelsServed() || !resolver) {
      return fail('channel_not_advertised', `This host does not resolve deployment channels, so ${agent.agentId}@${channel} cannot run.`);
    }
    const r = await resolver.resolve(run.tenantId, agent.agentId, channel, `${run.runId}|${agent.agentId}|${channel}`);
    if (!r.ok) {
      return fail(r.reason, r.reason === 'channel_not_advertised'
        ? `Channel ${channel} is not one this host resolves.`
        : `No version of ${agent.agentId} is active on channel ${channel}.`);
    }
    version = r.version;
  }
  // ADR 1014 P0 — a fresh, reused or inherited pin alike: the version recorded on
  // `agent.invocation.started` must be one this host can run, else fail closed.
  if (resolver?.available && !(await resolver.available(run.tenantId, agent.agentId, version))) {
    return {
      ok: false,
      error: {
        code: 'validation_error',
        message: `${agent.agentId} ${version} (resolved from ${channel}) is not installed on this host, so it cannot run.`,
        details: { reason: 'agent_version_unavailable', agentId: agent.agentId, channel, version },
      },
    };
  }

  const pin: ChannelPin = { invocationId: `${run.runId}:${nodeId}:${input.execution}`, agentId: agent.agentId, channel, version };
  await getEventLog().append({
    runId: run.runId,
    nodeId,
    type: STARTED,
    payload: { invocationId: pin.invocationId, agentId: pin.agentId, source: 'workflow-node', resolvedChannel: channel, resolvedAgentVersion: version },
  });
  return { ok: true, pin };
}

/** Close the RFC 0077 bracket after the node's terminal event. */
export async function completeAgentInvocation(runId: string, nodeId: string, pin: ChannelPin, outcome: 'completed' | 'failed'): Promise<void> {
  await getEventLog().append({ runId, nodeId, type: COMPLETED, payload: { invocationId: pin.invocationId, agentId: pin.agentId, outcome } });
}

/** ADR 1014 Q1 — the channel an unbound caller runs. */
const SERVED_CHANNEL = 'stable';

/** ADR 1014 M6 — what `pinServedAgent` decided for one node execution. */
export type ServedPinOutcome =
  | { ok: true; pin?: ChannelPin }
  | { ok: false; error: { code: 'agent_version_unavailable'; message: string } };

/**
 * ADR 1014 M6 — an UNPINNED agent invoked from a run (an agent-runner node with no
 * channel or version, a chat responder turn) runs what `stable` serves (D4, Q1),
 * resolved ONCE per `(run, agent)` and recorded exactly like a channel pin: the
 * `agent.invocation.started` carries `resolvedChannel: 'stable'` +
 * `resolvedAgentVersion`. So a resume, a retry and a second node reuse it, and a
 * fork re-reads its parent's, instead of drawing again against a deployment that
 * may have moved.
 *
 * Returns `{ ok: true }` with no pin when versions are not served, the agent is
 * unknown (the caller keeps its own not-found handling) or the agent has no
 * deployment rows (it runs its head, as with the flag off). A deployment that
 * serves nothing this host can run fails closed.
 */
export async function pinServedAgent(input: {
  storage: Storage;
  run: RunRecord;
  nodeId: string;
  agentId: string;
  execution: number;
}): Promise<ServedPinOutcome> {
  const { storage, run, nodeId } = input;
  if (!agentVersionsServed()) return { ok: true };
  const head = await getAgentRegistry().resolve(input.agentId, run.tenantId);
  if (!head) return { ok: true };
  const agentId = head.agentId;
  const unavailable = (version?: string): ServedPinOutcome => ({
    ok: false,
    error: { code: 'agent_version_unavailable', message: `${agentId} has no version this host can serve${version ? ` (${version})` : ''}.` },
  });

  let version = await recordedPin(storage, run.runId, agentId, SERVED_CHANNEL);
  if (version === undefined && run.parentRunId) version = await recordedPin(storage, run.parentRunId, agentId, SERVED_CHANNEL);
  if (version === undefined) {
    const v = await servingVersion(run.tenantId, agentId, `${run.runId}|${agentId}|${SERVED_CHANNEL}`);
    if (v === undefined) return { ok: true };
    if (v === null) return unavailable();
    version = v;
  }
  if (version !== head.packVersion && !(await getAgentRegistry().resolve(agentId, run.tenantId, version))) return unavailable(version);

  const pin: ChannelPin = { invocationId: `${run.runId}:${nodeId}:${input.execution}`, agentId, channel: SERVED_CHANNEL, version };
  await getEventLog().append({
    runId: run.runId,
    nodeId,
    type: STARTED,
    payload: { invocationId: pin.invocationId, agentId, source: 'workflow-node', resolvedChannel: SERVED_CHANNEL, resolvedAgentVersion: version },
  });
  return { ok: true, pin };
}
