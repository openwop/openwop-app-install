/**
 * ADR 1099 D5 (P3d) — the server-kept memory of a collaborator's conversation with
 * the agent of the resource they were granted (`collaboratorTurn.ts`).
 *
 * WHY. P2 answered every turn from the latest message alone, on purpose: a history
 * sent by the browser would let a client write the assistant's past turns. So the
 * agent forgot the previous question. The history now lives here, written only by
 * the host after a turn has been answered, so the client can never author an
 * assistant turn.
 *
 * Shaped after the public widget's visitor threads (ADR 1018 D2, `visitorThreads.ts`).
 *
 * THE KEY. One conversation per grant (`grantId`): a re-grant starts a new one, and
 * two collaborators never share one.
 *
 * THE BOUNDS. A stored message is cut to {@link STORED_MESSAGE_CHARS}; a row keeps the
 * last {@link STORED_MESSAGES}; the model gets the last {@link CONTEXT_MESSAGES} before
 * the new turn, with every collaborator message re-fenced as untrusted input. Rows age
 * out after {@link MEMORY_TTL_DAYS} without a turn (default-ON kvAgeOut).
 *
 * ERASURE. A row names its collaborator, so the collaborator's erasure deletes it
 * (a `CollaboratorEraseHook`). The collaborator can also clear it themselves. Each
 * row carries `tenantId` for tenant teardown. Stored text is redacted with
 * `sanitizeFreeText` (secret-shaped strings).
 */
import { DurableCollection } from './hostExtPersistence.js';
import { registerKvAgeOut } from './kvAgeOut.js';
import { sanitizeFreeText } from '../byok/textRedaction.js';
import { defangUntrustedFence, fenceUntrustedBlock } from './untrustedContent.js';
import { registerCollaboratorEraseHook, registerCollaboratorPurgeHook } from './externalCollaborators.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.collaboratorTurnMemory');

export const STORED_MESSAGE_CHARS = 2_000;
export const STORED_MESSAGES = 40;
export const CONTEXT_MESSAGES = 12;
export const MEMORY_TTL_DAYS = 30;

export interface CollabTurnMessage { role: 'collaborator' | 'agent'; text: string; at: string }
export interface CollabTurnMemory {
  grantId: string;
  tenantId: string;
  orgId: string;
  collaboratorId: string;
  messages: CollabTurnMessage[];
  startedAt: string;
  updatedAt: string;
  rev: number;
}

// Tenant-indexed, so erasure and tenant teardown read one firm's rows, not a full scan.
const memories = new DurableCollection<CollabTurnMemory>('collab:turn:memory', (m) => m.grantId, undefined, (m) => m.tenantId);
// Default ON: the retention is part of the privacy promise, not an operator option.
// The sweep deletes through the collection, so the index marker goes with the row.
registerKvAgeOut({ id: 'collab:turn:memory', prefix: 'hostext:collab:turn:memory:', ttlDays: MEMORY_TTL_DAYS, timestampField: 'updatedAt', acceptIndexed: true });

/** What the model gets before the new turn. Collaborator text is fenced again here,
 *  every time, because it is replayed to a model. */
export async function turnContext(grantId: string): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const m = await memories.get(grantId);
  if (!m) return [];
  return m.messages.slice(-CONTEXT_MESSAGES).map((x) => (x.role === 'collaborator'
    ? { role: 'user' as const, content: fenceUntrustedBlock(x.text, 'an outside collaborator on this project') }
    // casavoga-c9 review — a stored reply can echo text the collaborator asked for,
    // including a fake fence marker; defang it so it can never close the next
    // turn's fence from inside an assistant turn.
    : { role: 'assistant' as const, content: defangUntrustedFence(x.text) }));
}

/** The conversation as the collaborator reads it back (the portal shows it). */
export async function readTurnMemory(grantId: string): Promise<CollabTurnMessage[]> {
  return (await memories.get(grantId))?.messages ?? [];
}

/** Append one ANSWERED exchange, in one CAS write. Called only after the reply exists,
 *  so a failed turn leaves no unanswered message. Never throws into the turn: the
 *  collaborator already has their reply, and losing one history entry is the lesser
 *  failure. */
export async function appendTurnExchange(input: { grantId: string; tenantId: string; orgId: string; collaboratorId: string; collaboratorText: string; agentText: string }): Promise<void> {
  const now = new Date().toISOString();
  const add: CollabTurnMessage[] = [
    { role: 'collaborator', text: sanitizeFreeText(input.collaboratorText).slice(0, STORED_MESSAGE_CHARS), at: now },
    { role: 'agent', text: sanitizeFreeText(input.agentText).slice(0, STORED_MESSAGE_CHARS), at: now },
  ];
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const cur = await memories.get(input.grantId);
      // A row from another tenant or collaborator under the same id is never extended.
      if (cur && (cur.tenantId !== input.tenantId || cur.collaboratorId !== input.collaboratorId)) return;
      const next: CollabTurnMemory = {
        grantId: input.grantId, tenantId: input.tenantId, orgId: input.orgId, collaboratorId: input.collaboratorId,
        messages: [...(cur?.messages ?? []), ...add].slice(-STORED_MESSAGES),
        startedAt: cur?.startedAt ?? now,
        updatedAt: cur && cur.updatedAt > now ? cur.updatedAt : now,
        rev: (cur?.rev ?? 0) + 1,
      };
      if (await memories.compareAndSwap(cur ?? null, next)) return;
    }
    log.warn('collab_turn_memory_append_contended', { grantId: input.grantId });
  } catch (err) {
    log.warn('collab_turn_memory_append_failed', { grantId: input.grantId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The collaborator starts over: their conversation for this grant is deleted. */
export async function clearTurnMemory(grantId: string): Promise<boolean> {
  return memories.delete(grantId);
}

let registered = false;
/** Boot: a collaborator's erasure, or their org's teardown, deletes every
 *  conversation they had. Idempotent. */
export function registerCollaboratorTurnMemory(): void {
  if (registered) return;
  registered = true;
  const forget = async (c: { tenantId: string; collaboratorId: string }): Promise<number> => {
    let n = 0;
    for (const m of await memories.listForTenantIndexed(c.tenantId)) {
      if (m.tenantId === c.tenantId && m.collaboratorId === c.collaboratorId && (await memories.delete(m.grantId))) n += 1;
    }
    return n;
  };
  registerCollaboratorEraseHook(forget);
  // An org teardown deletes the org's collaborators: their conversations go with them.
  registerCollaboratorPurgeHook(forget);
}

/** Test seam: forget every conversation. */
export async function __resetCollaboratorTurnMemoryForTests(): Promise<void> {
  for (const m of await memories.list()) await memories.delete(m.grantId);
}
