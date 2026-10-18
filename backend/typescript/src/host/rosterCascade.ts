/**
 * Cascade delete for one standing-agent roster member (RFC 0086 host-extension,
 * non-normative).
 *
 * Deleting a roster member must not leave its dependent surfaces dangling. The
 * bare `deleteRosterEntry` used to drop only the roster row, orphaning the
 * member's board (+ cards), schedule jobs, pending/resolved approvals, org-chart
 * membership, sidebar pins, and its host-synthesized chat-callable inventory
 * agent. This is the ONE cascade implementation shared by the roster `DELETE`
 * route and the demo "Clear demo data" path, so the two can't drift and the
 * Roster page's "removes the agent and its board/schedules" promise is honest.
 *
 * Tenant-scoped: the caller MUST have verified `entry.tenantId === tenant`
 * before calling (the route does a 404-gated ownership check). Reaps by id, so
 * a member whose roster row is already gone still clears any orphaned
 * boards/schedules/approvals keyed to the same `rosterId`.
 */

import { broadcastAgentEviction } from './agentRegistryEviction.js';
import { deleteRosterEntry, getRosterEntry, listRoster } from './rosterService.js';
import { getAgentRegistry } from '../executor/agentRegistry.js';
import { agentStorageId } from '../executor/agentIdAliases.js';
import { deleteBoard, listBoardsForSubject } from './kanbanService.js';
import { deleteJob, listJobsByRoster } from './schedulingService.js';
import { deleteApprovalsForRoster } from './approvalService.js';
import { deleteChart, getChart, putChart } from './orgChartService.js';
import { unpinAgentsForTenant } from '../features/profiles/profilesService.js';
import { deleteAgentProfile } from './agentProfileService.js';
import { clearMemoryScope } from './inMemorySurfaces.js';
import { agentMemoryScope } from './agentMemoryAdapter.js';
import { purgeNamespaceVectors } from './vector/vectorTenantPurge.js';
import { clearSubjectNotes } from './subjectMemory.js';
import { clearTwinGrantsForAgent } from './twinService.js';
import { fireRosterMemberDeleted } from './rosterLifecycle.js';
import { createLogger } from '../observability/logger.js';
import type { Storage } from '../storage/storage.js';

const log = createLogger('host.rosterCascade');

export interface RosterCascadeResult {
  rosterId: string;
  boards: number;
  schedules: number;
  approvals: number;
  chatAgentDeleted: boolean;
  orgChartUpdated: boolean;
  /** ADR 0038 — the agent's `agentProfile` (incl. knowledge bindings) was removed. */
  profileDeleted: boolean;
  /** ADR 0038 — entries purged from the agent's `agent:<id>` memory namespace. */
  memoryEntriesCleared: number;
}

/**
 * Delete a roster member AND every dependent surface it owns. Idempotent-ish:
 * safe to call for an id whose roster row is already gone (it still reaps
 * orphans). Returns per-subsystem counts for logging/telemetry.
 */
export async function deleteRosterMemberCascade(
  tenantId: string,
  storage: Storage,
  rosterId: string,
): Promise<RosterCascadeResult> {
  const entry = await getRosterEntry(tenantId, rosterId);

  // Boards (and their cards, via deleteBoard's own cascade) bound to this member.
  const boards = await listBoardsForSubject(tenantId, { kind: 'agent', id: rosterId });
  for (const b of boards) await deleteBoard(b.id);

  // Schedule jobs owned by this member.
  const jobs = await listJobsByRoster(tenantId, rosterId);
  for (const j of jobs) await deleteJob(j.jobId);

  // Pending/resolved approvals proposed for this member (+ their index rows).
  const approvals = await deleteApprovalsForRoster(tenantId, rosterId);

  // Drop just this member from the org chart (and any now-empty department),
  // rather than nuking the whole chart — other members may remain. Clear any
  // dangling `reportsTo` edge that pointed at the removed member.
  let orgChartUpdated = false;
  const chart = await getChart(tenantId);
  if (chart && chart.members.some((m) => m.rosterId === rosterId)) {
    const members = chart.members
      .filter((m) => m.rosterId !== rosterId)
      .map((m) => (m.reportsTo === rosterId ? { ...m, reportsTo: null } : m));
    if (members.length === 0) {
      await deleteChart(tenantId);
      orgChartUpdated = true;
    } else {
      const liveDeptIds = new Set(members.map((m) => m.departmentId));
      const departments = chart.departments.filter((d) => liveDeptIds.has(d.departmentId));
      const res = await putChart({ tenantId, departments, members });
      if ('error' in res) {
        log.warn('roster_cascade_orgchart_failed', { tenantId, rosterId, error: res.error.code });
      } else {
        orgChartUpdated = true;
      }
    }
  }

  // A deleted agent must not linger in anyone's sidebar pins (ADR 0023).
  await unpinAgentsForTenant(tenantId, [rosterId]);

  // ADR 0038 — purge the agent's profile (its knowledge bindings live here) AND
  // its per-agent memory namespace (curated notes + turn summaries), else they
  // orphan forever (storage bloat + a data-retention/erasure gap).
  const profileDeleted = await deleteAgentProfile(tenantId, rosterId);
  // Clear BOTH the durable curated notes (ADR 0041 source of truth) and the
  // in-memory recall scope (turn summaries + the notes' recall mirror).
  const durableNotesCleared = await clearSubjectNotes(tenantId, { kind: 'agent', id: rosterId });
  const memoryEntriesCleared = (await clearMemoryScope(tenantId, agentMemoryScope(rosterId))) + durableNotesCleared;
  // ADR 0664 D1 — and the VECTOR namespace, which the two clears above do not touch.
  //
  // Without this, deletion was incomplete in a way that RE-SURFACED: `rosterId` is
  // `host:${slugify(persona)}` (`rosterService.ts:145`), so re-creating an agent under the
  // same persona name reuses the same namespace, and `subjectMemory`'s recall returns
  // `md.content` from the vector path IN PREFERENCE to recency — so the new agent's first
  // recall served the deleted agent's private notes.
  //
  // Namespace-scoped, not id-scoped: the id-collecting shape the sibling eraser uses
  // (`subjectMemory.ts:410-416`) cannot work here (the clears above return counts, not ids)
  // and would be incomplete anyway — dispatch turn-summaries are indexed with no durable
  // note row, and a pgvector deployment holds rows this process never saw.
  //
  // Best-effort, like the sibling: a vector backend that is down must not block the durable
  // delete. But the failure is LOGGED with its backend named, never folded into a success.
  const vectorPurge = await purgeNamespaceVectors(tenantId, agentMemoryScope(rosterId));
  if (vectorPurge.failed.length > 0) {
    log.error('roster_cascade_vector_purge_partial', {
      tenantId, rosterId, failed: vectorPurge.failed, purged: vectorPurge.purged,
    });
  }
  // ADR 0044 — the twin link dies with the profile; clear its consent grants too.
  await clearTwinGrantsForAgent(tenantId, rosterId);

  // ADR 0775 D5 — the roster row goes AFTER every rosterId-keyed sweep above.
  // It used to go first, so a throw in a later sweep returned 500 and the
  // route's 404 pre-check then refused every retry, stranding the orphans
  // (`ARWF-12`). Every sweep above is keyed by `rosterId` and idempotent, so a
  // retry now re-runs the whole cascade while the row still exists.
  await deleteRosterEntry(tenantId, rosterId);
  // Grade-code ARCD-3 — a profile/capability PUT that passed `requireOwnedAgent`
  // while the row still existed can land between the sweep above and the row
  // delete, recreating a profile nothing reaches. Sweep it once more now that
  // no new write can pass the owned-agent check. Idempotent.
  await deleteAgentProfile(tenantId, rosterId);

  // The host-synthesized chat-callable inventory agent — ONLY the per-tenant
  // `user.<slug>` form the seed / create-wizard mint, never a shared pack agent
  // (whose id never begins `user.`). ADR 0379 P2: the tenant check lives in the
  // delete predicate, so a persona-scoped `user.<slug>` is matched by prefix.
  //
  // ADR 0775 D5 (`ARWF-6`) — and ONLY when no OTHER roster member still points
  // at it: `POST /roster` accepts any agentRef, so two members may share one
  // chat agent, and deleting one used to delete the other's. The count runs
  // AFTER this member's row is gone, so two concurrent deletes of the last two
  // sharers both see zero and both delete (idempotent) — counting first would
  // let each see the other and orphan the agent. Deleting also EVICTS it from
  // this instance's registry (the pair `DELETE /agents/:agentId` performs);
  // before, the instance kept serving the deleted persona until restart. Other
  // instances still do until their restart (ADR 0775 P3).
  let chatAgentDeleted = false;
  let chatAgentRetired = false;
  const chatAgentId = entry?.agentRef.agentId;
  if (chatAgentId && chatAgentId.startsWith('user.')) {
    const stillReferenced = (await listRoster(tenantId)).some((e) => agentStorageId(e.agentRef.agentId) === agentStorageId(chatAgentId));
    if (!stillReferenced) {
      chatAgentRetired = true;
      chatAgentDeleted = await storage.deleteUserAgent(tenantId, chatAgentId);
      getAgentRegistry().remove(chatAgentId, tenantId);
      // ADR 0775 P3d — and on every other instance (architect H2).
      await broadcastAgentEviction(tenantId, chatAgentId);
    }
  }

  // ADR 0288 — fire the roster-lifecycle seam LAST so feature-owned refs the
  // host cascade cannot reach (scheduled chats, public widgets, advisory
  // membership) disable/prune themselves. Best-effort; never blocks the delete.
  // ADR 0775 D5 — the chat `agentId` rides the event ONLY when this cascade
  // RETIRED that agent (no other member references it — whether or not a
  // stored row existed to delete). Consumers key widgets and scheduled chats by
  // it, so naming a chat agent another member still uses disabled THAT
  // member's widgets and paused its chats. A non-`user.` (pack) agent is never
  // retired, so it is never named either.
  const lifecycleConsumersRan = await fireRosterMemberDeleted({
    tenantId, rosterId, ...(chatAgentRetired && chatAgentId ? { agentId: chatAgentId } : {}),
  });

  log.info('roster_member_cascade_deleted', {
    tenantId, rosterId, boards: boards.length, schedules: jobs.length, approvals, chatAgentDeleted, orgChartUpdated, profileDeleted, memoryEntriesCleared, lifecycleConsumersRan,
  });
  return { rosterId, boards: boards.length, schedules: jobs.length, approvals, chatAgentDeleted, orgChartUpdated, profileDeleted, memoryEntriesCleared };
}
