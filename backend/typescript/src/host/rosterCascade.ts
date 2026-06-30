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

import { deleteRosterEntry, getRosterEntry } from './rosterService.js';
import { deleteBoard, listBoardsForSubject } from './kanbanService.js';
import { deleteJob, listJobsByRoster } from './schedulingService.js';
import { deleteApprovalsForRoster } from './approvalService.js';
import { deleteChart, getChart, putChart } from './orgChartService.js';
import { unpinAgentsForTenant } from '../features/profiles/profilesService.js';
import { deleteAgentProfile } from './agentProfileService.js';
import { clearMemoryScope } from './inMemorySurfaces.js';
import { agentMemoryScope } from './agentMemoryAdapter.js';
import { clearSubjectNotes } from './subjectMemory.js';
import { clearTwinGrantsForAgent } from './twinService.js';
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
  const entry = await getRosterEntry(rosterId);

  // Boards (and their cards, via deleteBoard's own cascade) bound to this member.
  const boards = await listBoardsForSubject(tenantId, { kind: 'agent', id: rosterId });
  for (const b of boards) await deleteBoard(b.id);

  // Schedule jobs owned by this member.
  const jobs = await listJobsByRoster(tenantId, rosterId);
  for (const j of jobs) await deleteJob(j.jobId);

  // Pending/resolved approvals proposed for this member (+ their index rows).
  const approvals = await deleteApprovalsForRoster(tenantId, rosterId);

  // The host-synthesized chat-callable inventory agent — but ONLY the per-tenant
  // `user.<tenant>.<slug>` form the seed / create-wizard mint. Never a shared
  // pack agent (whose id never begins `user.`), so a roster delete can't yank an
  // agent definition out from under another reference.
  let chatAgentDeleted = false;
  const chatAgentId = entry?.agentRef.agentId;
  if (chatAgentId && chatAgentId.startsWith(`user.${tenantId}.`)) {
    chatAgentDeleted = await storage.deleteUserAgent(chatAgentId);
  }

  // The roster row itself.
  await deleteRosterEntry(rosterId);

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
  const memoryEntriesCleared = clearMemoryScope(tenantId, agentMemoryScope(rosterId)) + durableNotesCleared;
  // ADR 0044 — the twin link dies with the profile; clear its consent grants too.
  await clearTwinGrantsForAgent(tenantId, rosterId);

  log.info('roster_member_cascade_deleted', {
    tenantId, rosterId, boards: boards.length, schedules: jobs.length, approvals, chatAgentDeleted, orgChartUpdated, profileDeleted, memoryEntriesCleared,
  });
  return { rosterId, boards: boards.length, schedules: jobs.length, approvals, chatAgentDeleted, orgChartUpdated, profileDeleted, memoryEntriesCleared };
}
