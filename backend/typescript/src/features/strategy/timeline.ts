/**
 * Strategy timeline projection (ADR 0234 §C6) — a READ over what already
 * exists: initiative dates, linked project milestones, linked idea schedules.
 * Slip flags are computed at read (`overdue`, `dependencyLate`); there is no
 * scheduling solver, no baseline store, no Gantt engine. RBAC rides the
 * caller's strategy read + the same per-link gates the context resolve uses
 * (unreadable targets are silently omitted — the STRAT-2 posture).
 *
 * CORRECTION 2026-08-22 (SPC-2 / ADR 0597 §2) — the sentence above was FALSE
 * for the priority lane and had been since this file was written. The project
 * branch gated on `resolveProjectAccess`; the priority branch checked only that
 * `getList` returned something, and `getScheduleStatus` authorizes nothing of
 * its own — so this projection returned idea titles, target dates and schedule
 * states from orgs the caller cannot read, while `GET /:id/context` over the
 * SAME links correctly withheld them. A docstring asserting a security property
 * is part of the defect: it is what stops a reviewer checking. The rule now
 * lives in ONE place (`strategyService.resolvePriorityLinkTarget`) that both
 * projections call, and `canReadOrg` is a REQUIRED parameter here so a future
 * caller cannot omit it.
 */
import { getProject, resolveProjectAccess } from '../projects/projectsService.js';
import { getList, getScheduleStatus } from '../priority-matrix/priorityMatrixService.js';
import { resolvePriorityLinkTarget } from './strategyService.js';
import type { Strategy } from './types.js';

export type TimelineItemKind = 'initiative' | 'milestone' | 'idea-schedule';

export interface TimelineItem {
  kind: TimelineItemKind;
  /** initiative id · `${projectId}::${milestoneIdx}` · `${listId}::${cardId}` */
  id: string;
  title: string;
  startDate?: string;
  /** The date the item is plotted on (endDate / dueDate / targetDate). */
  dueDate?: string;
  status?: string;
  done?: boolean;
  /** Where the item came from (the FE deep-links on this). */
  source: { strategyId: string } & ({ kind: 'initiative' } | { kind: 'project'; projectId: string } | { kind: 'priority-idea'; listId: string; cardId: string });
  /** Slip flags computed at read (ADR 0234 — never stored). */
  overdue?: boolean;
  /** Initiative ids in `dependsOn` whose endDate falls after this start. */
  dependencyLate?: string[];
}

const DONE_STATUSES = new Set(['completed', 'archived', 'done']);

/**
 * The timeline items for ONE strategy. `todayIso` injected for testability.
 *
 * `canReadOrg` is REQUIRED (SPC-2): it is the same predicate the routes hand
 * `resolveStrategyContext`, and making it non-optional is what stops the two
 * projections drifting apart again.
 */
export async function resolveStrategyTimeline(
  tenantId: string,
  s: Strategy,
  callerSubject: string | undefined,
  canReadOrg: (orgId: string) => Promise<boolean>,
  todayIso: string = new Date().toISOString().slice(0, 10),
): Promise<TimelineItem[]> {
  const out: TimelineItem[] = [];

  // Initiatives (dates + dependency slip within the same strategy).
  const endById = new Map(s.initiatives.map((i) => [i.id, i.endDate]));
  for (const i of s.initiatives) {
    if (!i.startDate && !i.endDate) continue; // undated initiatives aren't plottable
    const done = i.status !== undefined && DONE_STATUSES.has(i.status);
    const late = (i.dependsOn ?? []).filter((dep) => {
      const depEnd = endById.get(dep);
      return depEnd !== undefined && i.startDate !== undefined && depEnd > i.startDate;
    });
    out.push({
      kind: 'initiative',
      id: i.id,
      title: i.title,
      ...(i.startDate ? { startDate: i.startDate } : {}),
      ...(i.endDate ? { dueDate: i.endDate } : {}),
      ...(i.status ? { status: i.status } : {}),
      done,
      source: { kind: 'initiative', strategyId: s.id },
      ...(i.endDate && i.endDate < todayIso && !done ? { overdue: true } : {}),
      ...(late.length ? { dependencyLate: late } : {}),
    });
  }

  // Linked project milestones (member-scoped project access, fail-soft per link).
  for (const l of s.links) {
    try {
      if (l.kind === 'project') {
        if ((await resolveProjectAccess(tenantId, l.projectId, callerSubject)) === 'none') continue;
        const p = await getProject(tenantId, l.projectId);
        if (!p) continue;
        (p.charter?.milestones ?? []).forEach((m, idx) => {
          if (!m.dueDate) return;
          out.push({
            kind: 'milestone',
            id: `${l.projectId}::${idx}`,
            title: `${p.name} — ${m.title}`,
            dueDate: m.dueDate,
            done: Boolean(m.done),
            source: { kind: 'project', strategyId: s.id, projectId: l.projectId },
            ...(m.dueDate < todayIso && !m.done ? { overdue: true } : {}),
          });
        });
      } else if (l.kind === 'priority-idea' || l.kind === 'priority-list') {
        // SPC-2 — the SAME gate the context resolve uses, from the SAME
        // function. `getScheduleStatus` below authorizes nothing, so this is
        // the only thing standing between an org-B list and an org-A reader.
        const { list, readable } = await resolvePriorityLinkTarget(
          l.listId,
          (id) => getList(tenantId, id),
          canReadOrg,
        );
        if (!list || !readable) continue;
        const status = await getScheduleStatus(tenantId, l.listId);
        for (const row of status.ideas) {
          if (l.kind === 'priority-idea' && row.cardId !== l.cardId) continue;
          if (!row.targetDate) continue;
          out.push({
            kind: 'idea-schedule',
            id: `${l.listId}::${row.cardId}`,
            title: row.title,
            dueDate: row.targetDate,
            status: row.state,
            done: row.state === 'done-early' || row.state === 'done-late',
            source: { kind: 'priority-idea', strategyId: s.id, listId: l.listId, cardId: row.cardId },
            ...(row.state === 'behind' ? { overdue: true } : {}),
          });
        }
      }
    } catch { /* fail-soft per link — one flaky target never sinks the timeline */ }
  }

  return out.sort((a, b) => (a.dueDate ?? a.startDate ?? '9999').localeCompare(b.dueDate ?? b.startDate ?? '9999'));
}
