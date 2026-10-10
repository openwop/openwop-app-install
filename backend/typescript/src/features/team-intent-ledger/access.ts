/**
 * ADR 0831 — the ONE access predicate for the team ledger, shared by the REST
 * routes and the agent tools (CLAUDE.md § "AI↔app information exchange": a tool
 * SHARES its route's predicate). The project's RBAC (ADR 0054 D5): no read
 * access ⇒ indistinguishable from "no such project".
 */
import { getProject, resolveProjectAccess, type Project } from '../projects/projectsService.js';

export type LedgerAccess = { project: Project; level: 'read' | 'write' } | null;

/** The caller's access to a project's ledger, or null (missing, foreign, invisible). */
export async function ledgerAccess(tenantId: string, projectId: string, subject: string | undefined): Promise<LedgerAccess> {
  const project = await getProject(tenantId, projectId);
  if (!project) return null;
  const level = await resolveProjectAccess(tenantId, project.id, subject);
  if (level === 'none') return null;
  return { project, level: level === 'write' ? 'write' : 'read' };
}
