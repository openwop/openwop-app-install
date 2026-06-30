/**
 * Borrowed-recall resolver (ADR 0044 Phase 2) — the twin feature's implementation
 * of the host `BorrowedRecallResolver` seam. For a dispatching agent, it is the
 * LIVE authorization gate + the owner-corpus composition:
 *
 *   1. toggle `twin-recall` on for the tenant?            (fail-closed)
 *   2. is the agent LINKED to a user?                     (`twinService.getTwinLink`)
 *   3. is there an ACTIVE grant from that user?           (`twinService.getActiveGrant`)
 *   4. compose the owner's granted scopes via the SHARED `resolveSubjectKnowledgeRetrieve`
 *      (ADR 0042) over `user:<ownerId>` — memory notes and/or bound KB docs.
 *
 * The returned retriever audits ACTUAL use (when it yields chunks). Dispatch
 * fences everything it returns (`borrowedRetrieve`), so the owner's content is
 * cited-as-data, never followed as instructions.
 *
 * Boundary: this reads the owner's `Profile.knowledge` from the profiles feature —
 * a feature→feature read, the same pattern `agent-knowledge` uses to read `kb`.
 * Everything else is host-owned.
 *
 * @see docs/adr/0044-twin-cross-subject-recall.md
 */

import { resolveOne } from '../../host/featureToggles/service.js';
import { getTwinLink, getActiveGrant } from '../../host/twinService.js';
import { getProfile } from '../profiles/profilesService.js';
import { createSubjectMemoryPort, subjectMemoryScope } from '../../host/subjectMemory.js';
import { resolveSubjectKnowledgeRetrieve, type SubjectKnowledgeBinding } from '../../host/agentKnowledgeComposition.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import type { AgentKnowledgeRetrieve } from '../../host/agentDispatch.js';

const TOGGLE_ID = 'twin-recall';

export async function resolveBorrowedRecall(tenantId: string, agentId: string): Promise<AgentKnowledgeRetrieve | undefined> {
  // 1. toggle (tenant-bucketed) — fail-closed on any resolution error.
  let on = false;
  try { on = (await resolveOne(TOGGLE_ID, { tenantId }))?.enabled ?? false; } catch { on = false; }
  if (!on) return undefined;

  // 2–3. live LINK + active GRANT.
  const link = await getTwinLink(tenantId, agentId);
  if (!link) return undefined;
  const grant = await getActiveGrant(tenantId, agentId, link.userId);
  if (!grant) return undefined;

  // 4. compose the owner's granted scopes (memory notes + bound KB docs).
  const wantKnowledge = grant.scopes.includes('knowledge');
  const wantMemory = grant.scopes.includes('memory');
  const sources: ('kb' | 'memory')[] = [...(wantKnowledge ? (['kb'] as const) : []), ...(wantMemory ? (['memory'] as const) : [])];
  const ownerProfile = wantKnowledge ? await getProfile(tenantId, link.userId) : null;
  const binding: SubjectKnowledgeBinding = {
    collectionIds: wantKnowledge ? (ownerProfile?.knowledge?.collectionIds ?? []) : [],
    retrieval: { sources },
  };
  const memory = createSubjectMemoryPort(tenantId);
  const retrieve = resolveSubjectKnowledgeRetrieve(tenantId, binding, memory, subjectMemoryScope({ kind: 'user', id: link.userId }));
  if (!retrieve) return undefined;

  // Audit ACTUAL use (only when chunks are returned), so a user can see when their
  // memory was recalled (ADR 0044 §5). Best-effort; never blocks the turn.
  return async (query: string) => {
    const chunks = await retrieve(query);
    if (chunks.length > 0) {
      try {
        await hostExtStorage().appendAudit({
          timestamp: new Date().toISOString(),
          principalId: agentId,
          action: 'twin.recall',
          resource: `user:${link.userId}`,
          outcome: 'ok',
          payload: { scopes: grant.scopes, grantVersion: grant.version, chunks: chunks.length },
        });
      } catch {
        /* best-effort audit */
      }
    }
    return chunks;
  };
}
