/**
 * ADR 1094 — a paged portfolio read across projects. One page of the projects
 * the caller can see (the ADR 0054 visibility scan), filtered by org, lead and
 * status, each with its manual and computed health (ADR 1091), lead, member
 * count and next open milestone.
 */

import { OpenwopError } from '../../types.js';
import { listMembers } from '../../host/accessControlService.js';
import { resolveComputedProjectHealth, type ComputedProjectHealth } from '../../host/projectHealthProviders.js';
import { listVisibleProjects, type Project, type ProjectHealth, type ProjectStatus } from './projectsService.js';

export const PORTFOLIO_DEFAULT_LIMIT = 25;
export const PORTFOLIO_MAX_LIMIT = 100;
/** Rows whose health providers run at once. */
export const PORTFOLIO_CONCURRENCY = 5;
const STATUSES: readonly ProjectStatus[] = ['planning', 'active', 'paused', 'done', 'archived'];

export interface PortfolioRow {
  id: string; name: string; orgId: string; status: ProjectStatus; access: 'read' | 'write';
  health: { manual: ProjectHealth | null; computed?: ComputedProjectHealth & { providerId: string } };
  lead?: { ref: string; name: string };
  memberCount: number;
  nextMilestone?: { title: string; dueDate: string };
}
export interface PortfolioPage { rows: PortfolioRow[]; total: number; nextCursor?: string }

const bad = (message: string, field: string): OpenwopError => new OpenwopError('validation_error', message, 400, { field });

export async function getProjectPortfolio(args: { tenantId: string; callerSubject?: string; orgId?: unknown; lead?: unknown; status?: unknown; cursor?: unknown; limit?: unknown }): Promise<PortfolioPage> {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  let limit = PORTFOLIO_DEFAULT_LIMIT;
  if (args.limit !== undefined && args.limit !== '') {
    const n = Number(args.limit);
    if (!Number.isInteger(n) || n < 1 || n > PORTFOLIO_MAX_LIMIT) throw bad(`limit must be an integer from 1 to ${PORTFOLIO_MAX_LIMIT}.`, 'limit');
    limit = n;
  }
  const cursor = str(args.cursor) || '0';
  if (!/^\d{1,6}$/.test(cursor)) throw bad('`cursor` must be the value a previous page returned.', 'cursor');
  const status = str(args.status);
  if (status && !STATUSES.includes(status as ProjectStatus)) throw bad(`status must be one of: ${STATUSES.join(', ')}.`, 'status');
  const orgId = str(args.orgId);
  const leadRaw = str(args.lead);
  const lead = leadRaw === 'me' ? args.callerSubject : leadRaw || undefined;
  if (leadRaw === 'me' && !args.callerSubject) throw bad('`lead: me` needs a signed-in person.', 'lead');

  const leadOf = (p: Project): string | undefined => (p.members ?? []).find((m) => m.role === 'lead')?.ref;
  const all = (await listVisibleProjects(args.tenantId, args.callerSubject))
    .filter(({ project: p }) => (!orgId || p.orgId === orgId)
      && (status ? (p.charter?.status ?? 'active') === status : p.charter?.status !== 'archived')
      // A member ref is `user:` + the user id (which may itself start with `user:`): match a bare subject or a ref.
      && (!lead || leadOf(p) === `user:${lead}` || leadOf(p) === lead))
    .sort((a, b) => a.project.name.localeCompare(b.project.name) || a.project.id.localeCompare(b.project.id));
  const offset = Number(cursor);
  const page = all.slice(offset, offset + limit);

  const namesByOrg = new Map<string, Map<string, string>>();
  const nameOf = async (org: string, ref: string): Promise<string> => {
    let names = namesByOrg.get(org);
    if (!names) {
      names = new Map((await listMembers(args.tenantId, org)).filter((m) => m.subject).map((m) => [m.subject!, m.displayName?.trim() || 'a member']));
      namesByOrg.set(org, names);
    }
    return names.get(ref.slice('user:'.length)) ?? 'a former member';
  };

  const rows: PortfolioRow[] = new Array(page.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < page.length) {
      const k = next++;
      const { project: p, level } = page[k]!;
      const { computed } = await resolveComputedProjectHealth({ tenantId: args.tenantId, project: p, ...(args.callerSubject ? { callerUserId: args.callerSubject } : {}) });
      const leadRef = leadOf(p);
      const milestone = (p.charter?.milestones ?? []).filter((m) => !m.done && m.dueDate).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))[0];
      rows[k] = {
        id: p.id, name: p.name, orgId: p.orgId, status: p.charter?.status ?? 'active', access: level,
        health: { manual: p.charter?.health ?? null, ...(computed ? { computed } : {}) },
        ...(leadRef ? { lead: { ref: leadRef, name: await nameOf(p.orgId, leadRef) } } : {}),
        memberCount: p.members?.length ?? 0,
        ...(milestone ? { nextMilestone: { title: milestone.title, dueDate: milestone.dueDate! } } : {}),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(PORTFOLIO_CONCURRENCY, page.length) }, worker));
  return { rows, total: all.length, ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}) };
}
