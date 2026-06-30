/**
 * Projects (ADR 0046 / ADR 0045 Phase 3). A `kind:'project'` Subject — a bare work
 * container that owns the SAME surfaces an agent/person does (board, memory,
 * assigned workflows) over the unified subject model, with no cognition and no
 * authority of its own (org-scoped). Adds no new infrastructure: the board rides
 * the generic `ownerSubject` (kanban), memory rides the `project:<id>` scope
 * (subjectMemory).
 *
 * § Correction (2026-06-15) — GRADUATED off the feature toggle (always-on). The
 * routes serve unconditionally; access is still org-scoped (a caller acts only on
 * projects in orgs where they hold the scope, and the list filters to readable
 * projects), so always-on is safe — the toggle only ever gated visibility.
 *
 * @see docs/adr/0046-project-subject.md
 */

import type { BackendFeature } from '../types.js';
import { setSubjectOrgResolver } from '../../host/subjectOrgScope.js';
import { setSubjectAccessResolver } from '../../host/subjectAccess.js';
import { registerProjectsRoutes } from './routes.js';
import { getProject, resolveProjectAccess } from './projectsService.js';

export const projectsFeature: BackendFeature = {
  id: 'projects',
  registerRoutes: (deps) => {
    registerProjectsRoutes(deps);
    // ADR 0054 § Correction (2026-06-16) — the `project-collab` toggle is RETIRED;
    // the collaborative surfaces (members / visibility / chat) are now always-on.
    // WRITE stays org-scoped via `requireProject('workspace:write')` (membership
    // never grants authority), and a `private` project is read-gated to its members
    // via the `subjectAccess` seam below — so always-on is safe. The id is listed in
    // features/index.ts RETIRED_TOGGLE_IDS so any stale durable override is cleared.
    // Fill the subject→org seam so kanban + documents can DERIVE a PROJECT board's
    // owning org (ADR 0046). A `kind:'project'` board's org is the project's
    // current org; every other kind is tenant-global/personal (null).
    setSubjectOrgResolver(async (tenantId, subject) =>
      subject.kind === 'project' ? (await getProject(tenantId, subject.id))?.orgId ?? null : null,
    );
    // Fill the subject→access seam so kanban gates a PROJECT board's surfaces on
    // the caller's RESOLVED access (org authority composed with the project's
    // visibility + members, ADR 0054 D5). Non-project subjects → null (legacy gate).
    setSubjectAccessResolver(async (tenantId, subject, caller) =>
      subject.kind === 'project' ? resolveProjectAccess(tenantId, subject.id, caller) : null,
    );
  },
  // No `toggleDefault` — always-on. The collaborative surfaces (members /
  // visibility / chat, ADR 0054) are also always-on as of 2026-06-16 (§ Correction
  // in registerRoutes); WRITE stays org-scoped, READ honors project visibility.
};
