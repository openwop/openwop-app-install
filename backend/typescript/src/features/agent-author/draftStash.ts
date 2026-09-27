/**
 * Agent Author draft stash (ADR 0514 OQ1) — the handoff channel for the
 * draft-only persist mode: the Agent Author stashes a VALIDATED draft here
 * and the manual wizard offers it as a prefill ("dismissible suggestions"
 * without a roster write).
 *
 * ONE row per (tenant, user), overwritten on re-stash and deleted on
 * consume/dismiss — a stash is a hand-off, not a document store. Only a
 * closed-world-VALID draft is ever written (the caller validates first; model
 * output reaches durable state only through validation — the doctrine).
 *
 * SUBJECT-KEYED (ADR 0464): rows key on the acting user, so this module
 * self-polices like `tutorials/progressStore` — the build ratchet enumerates
 * only `src/host/**`, so the eraser is registered HERE and the feature test
 * asserts it deletes.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import type { AgentDraft } from './agentAuthorService.js';

export interface StashedAgentDraft {
  key: string; // `${tenantId}:${userId}` — deterministic, one per subject
  tenantId: string;
  /** The acting user the stash belongs to — server-stamped, never client input. */
  userId: string;
  draft: AgentDraft;
  stashedAt: string;
}

const stash = new DurableCollection<StashedAgentDraft>(
  'agent-author:draft-stash',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

const keyOf = (tenantId: string, userId: string): string => `${tenantId}:${userId}`;

export async function stashAgentDraft(tenantId: string, userId: string, draft: AgentDraft): Promise<StashedAgentDraft> {
  const row: StashedAgentDraft = { key: keyOf(tenantId, userId), tenantId, userId, draft, stashedAt: new Date().toISOString() };
  await stash.put(row);
  return row;
}

export async function getStashedDraft(tenantId: string, userId: string): Promise<StashedAgentDraft | null> {
  const row = await stash.get(keyOf(tenantId, userId));
  // Field check, not key-parse (the tutorials key discipline): the key embeds
  // both parts, but the row's own fields are the authority.
  return row && row.tenantId === tenantId && row.userId === userId ? row : null;
}

export async function clearStashedDraft(tenantId: string, userId: string): Promise<void> {
  await stash.delete(keyOf(tenantId, userId));
}

/** DELETE rather than anonymize — a stashed draft has no value and no
 *  retention duty once its subject is gone (the progressStore reasoning). */
export async function eraseAgentDraftStashForSubject(tenantId: string, subjectKey: string): Promise<void> {
  const row = await stash.get(keyOf(tenantId, subjectKey));
  if (row && row.tenantId === tenantId && row.userId === subjectKey) await stash.delete(row.key);
}

registerSubjectEraser(eraseAgentDraftStashForSubject);
