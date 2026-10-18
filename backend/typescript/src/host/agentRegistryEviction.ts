/**
 * ADR 0775 P3d (D5 H2) — cross-instance eviction of user-authored agents.
 *
 * The agent registry is an in-process map, hydrated at boot and read-through
 * only on a MISS (`bootstrap/agentPackResolver.ts`). So when one instance
 * deleted or edited a user agent, only that instance dropped or replaced its
 * copy; every other instance kept serving the old agent (or the old system
 * prompt) until it restarted. That was architect finding H2.
 *
 * Every instance now listens on one storage pub/sub channel (LISTEN/NOTIFY on
 * Postgres, an in-process emitter on sqlite). A delete or edit broadcasts the
 * agent; each OTHER instance removes its copy, so its next `resolve()` misses
 * and re-reads storage: a deleted agent then resolves to nothing, an edited one
 * to the new record. The writing instance skips its own message, because it
 * already holds the right state (a fresh copy after an edit).
 */
import { randomUUID } from 'node:crypto';
import { getAgentRegistry } from '../executor/agentRegistry.js';
import { createLogger } from '../observability/logger.js';
import { publishHostExtEvent, subscribeHostExtEvent } from './hostExtPersistence.js';

const log = createLogger('host.agentRegistryEviction');

export const AGENT_EVICTION_CHANNEL = 'agent-registry:evict';

/** This process. Exported for tests that simulate a second instance. */
export const INSTANCE_ID = randomUUID();

interface EvictionMessage {
  tenantId: string;
  agentId: string;
  origin: string;
}

/** Tell every other instance to drop `agentId` (a user agent of `tenantId`).
 *  Best-effort: a failed publish is logged, never thrown, because the write it
 *  follows has already landed. The cost of a lost message is the old behaviour. */
export async function broadcastAgentEviction(tenantId: string, agentId: string): Promise<void> {
  const message: EvictionMessage = { tenantId, agentId, origin: INSTANCE_ID };
  try {
    await publishHostExtEvent(AGENT_EVICTION_CHANNEL, JSON.stringify(message));
  } catch (err) {
    log.warn('agent_eviction_publish_failed', { tenantId, agentId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Apply one eviction message. Exported for tests; `origin` defaults to this process. */
export function applyAgentEviction(payload: string, self: string = INSTANCE_ID): boolean {
  let message: Partial<EvictionMessage>;
  try {
    message = JSON.parse(payload) as Partial<EvictionMessage>;
  } catch {
    return false;
  }
  if (typeof message.tenantId !== 'string' || typeof message.agentId !== 'string') return false;
  if (message.origin === self) return false;
  return getAgentRegistry().remove(message.agentId, message.tenantId);
}

/** Subscribe this instance. Returns the unsubscribe. */
export async function startAgentRegistryEvictionListener(): Promise<() => Promise<void>> {
  return subscribeHostExtEvent(AGENT_EVICTION_CHANNEL, (payload) => {
    if (applyAgentEviction(payload)) log.info('agent_evicted_by_peer', { payload });
  });
}
