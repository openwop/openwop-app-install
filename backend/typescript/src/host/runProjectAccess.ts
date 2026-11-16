/**
 * ADR 1133 (issue #5970) — a run a project is working on is read only by people
 * who may read that project.
 *
 * ADR 1118 made a private project admit its members and the org's admins, and
 * the document lane asks that question (`canReadDocument`). A run had no such
 * check: the run reads (`runClientAccess.ts`) and the artifact library's
 * `run-event:*` lane asked only for the org, so an org viewer outside a private
 * project could list its runs, stream their events and read what they delivered.
 *
 * The rule, the same one the document lane applies:
 *   - the run's project is DERIVED from its host-written attribution
 *     (`runProject`); nothing is stamped, so a fork or a replay is governed by
 *     the same derivation, and a project made private later hides its old runs;
 *   - a run with no project is unchanged;
 *   - a run whose project is not private is unchanged (the client-org gate
 *     stands, as for an unbound run);
 *   - a run of a PRIVATE project needs read on it through the ONE subject seam
 *     (`resolveSubjectAccess`, the projects feature's `resolveProjectAccess`, the
 *     rule `canReadDocument` applies): its members and its org's admins.
 *
 * Cost: the tenant's private projects come from a per-tenant cache (30 s TTL,
 * cleared on a visibility change or a delete), so steady state is zero reads.
 * When there are none, nothing else is read: no run, no board, no project. Otherwise board reads and project answers are
 * memoised, one per distinct board and per distinct private project. A probe that
 * throws, or no probe registered, fails closed to the full per-run check.
 */
import { resolveSubjectAccess, levelSatisfies } from './subjectAccess.js';
import { getBoard, type KanbanBoard } from './kanbanService.js';
import { runProject } from './runProjectBinding.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runProjectAccess');

type Metadata = Readonly<Record<string, unknown>> | undefined;

/** The ids of `tenantId`'s private projects. Registered by the projects feature
 *  (host never imports features). */
export type PrivateProjectProbe = (tenantId: string) => Promise<ReadonlySet<string>>;
let probe: PrivateProjectProbe | null = null;
export function registerPrivateProjectProbe(fn: PrivateProjectProbe): void { probe = fn; cache.clear(); }
/** The registered probe, so a test can wrap it and put it back. */
export function privateProjectProbe(): PrivateProjectProbe | null { return probe; }

/**
 * The probe's answer, cached per tenant for `PRIVATE_PROJECTS_TTL_MS`, because the
 * run reads that ask are the hottest paths (every poll, SSE reconnect and list).
 * The projects feature clears a tenant's entry in-process when a project's
 * visibility changes or a project is deleted (`invalidatePrivateProjects`).
 * Another instance learns within the TTL: for up to 30 s after a project is made
 * private there, its runs stay as readable as they were a moment before (ADR 1133
 * § Cost). A failed probe is not cached.
 */
export const PRIVATE_PROJECTS_TTL_MS = 30_000;
const cache = new Map<string, { at: number; ids: Promise<ReadonlySet<string> | null> }>();
export function invalidatePrivateProjects(tenantId: string): void { cache.delete(tenantId); }

function cachedPrivateProjects(tenantId: string): Promise<ReadonlySet<string> | null> {
  const now = Date.now();
  const hit = cache.get(tenantId);
  if (hit && now - hit.at < PRIVATE_PROJECTS_TTL_MS) return hit.ids;
  if (!probe) return Promise.resolve(null);
  const ids = probe(tenantId).catch((err: unknown) => {
    if (cache.get(tenantId)?.ids === ids) cache.delete(tenantId); // never cache a failure
    // Fail closed to the full per-run check, but not silently (the ART-3 rule).
    log.warn('private_project_probe_failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  cache.set(tenantId, { at: now, ids });
  if (cache.size > 10_000) cache.delete(cache.keys().next().value as string); // bounded
  return ids;
}

/** A per-request reader of `subject`'s project access in `tenantId`, for many runs. */
export interface RunProjectReader {
  /** May `subject` read a run with this metadata? */
  (metadata: Metadata): Promise<boolean>;
  /** False when the tenant has no private project, so no run can be refused and
   *  a caller may skip loading the run's metadata at all. */
  mayRefuse(): Promise<boolean>;
}

export function runProjectReader(tenantId: string, subject: string | undefined): RunProjectReader {
  let privateIds: Promise<ReadonlySet<string> | null> | undefined;
  const privates = (): Promise<ReadonlySet<string> | null> => {
    // null = unknown: check every bound project (fail closed).
    privateIds ??= cachedPrivateProjects(tenantId);
    return privateIds;
  };
  const boards = new Map<string, Promise<KanbanBoard | null>>();
  const projects = new Map<string, Promise<boolean>>();
  const boardOf = (boardId: string): Promise<KanbanBoard | null> => {
    let p = boards.get(boardId);
    if (!p) { p = getBoard(boardId); boards.set(boardId, p); }
    return p;
  };
  const mayReadProject = (projectId: string): Promise<boolean> => {
    let p = projects.get(projectId);
    if (!p) {
      p = resolveSubjectAccess(tenantId, { kind: 'project', id: projectId }, subject)
        .then((level) => level === null || levelSatisfies(level, 'read'));
      projects.set(projectId, p);
    }
    return p;
  };
  const mayRefuse = async (): Promise<boolean> => {
    const ids = await privates();
    return ids === null || ids.size > 0;
  };
  const read = async (metadata: Metadata): Promise<boolean> => {
    const ids = await privates();
    if (ids !== null && ids.size === 0) return true;
    const projectId = await runProject(tenantId, metadata ?? {}, boardOf);
    if (projectId === undefined) return true;
    if (ids !== null && !ids.has(projectId)) return true;
    return mayReadProject(projectId);
  };
  return Object.assign(read, { mayRefuse });
}
