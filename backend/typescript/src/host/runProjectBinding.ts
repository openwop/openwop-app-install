/**
 * ADR 0852 D2 — which project a run is working on, when the answer lives in a
 * feature the ledger must not depend on (a campaign run ⇒ the campaign's
 * project). A feature registers a resolver that reads HOST-WRITTEN run metadata
 * and returns a project id; the team ledger's run-start contributor asks here
 * after its own kanban / schedule branches.
 *
 * Resolvers read only keys that `POST /runs` strips from caller input
 * (`stripCallerAttribution`), so a caller cannot point a run at someone else's
 * project through them. Fail-soft: a resolver that throws resolves nothing.
 */
import { createLogger } from '../observability/logger.js';
import { getBoard } from './kanbanService.js';

const log = createLogger('host.runProjectBinding');

export type RunProjectResolver = (tenantId: string, metadata: Readonly<Record<string, unknown>>) => Promise<string | undefined>;

const resolvers: Array<{ id: string; fn: RunProjectResolver }> = [];

export function registerRunProjectResolver(id: string, fn: RunProjectResolver): void {
  if (resolvers.some((r) => r.id === id)) return; // idempotent across re-registration
  resolvers.push({ id, fn });
}

/** The first project id a resolver returns for this run's metadata, if any. */
export async function resolveRunProject(tenantId: string, metadata: Readonly<Record<string, unknown>>): Promise<string | undefined> {
  for (const r of resolvers) {
    try {
      const id = await r.fn(tenantId, metadata);
      if (id) return id;
    } catch (err) {
      log.warn('run_project_resolver_failed', { id: r.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return undefined;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * ADR 1133 — THE answer to "which project is this run working on", from its
 * host-written attribution: a card run on a project board
 * (`metadata.kanban.boardId` → the board's `ownerSubject`), a project-fired
 * schedule (`metadata.schedule.ownerScope = 'project:<id>'`), then the
 * registered feature resolvers above. The team ledger, the handoff cards and the
 * run read gate (`runProjectAccess.ts`) all ask here; before this the first two
 * kept partial copies (the handoff copy had no schedule branch).
 *
 * `boardOf` lets a caller that asks for many runs memoise the board read.
 */
export async function runProject(
  tenantId: string,
  metadata: Readonly<Obj>,
  boardOf: (boardId: string) => Promise<{ tenantId: string; ownerSubject?: { kind: string; id: string } } | null> = getBoard,
): Promise<string | undefined> {
  const k = metadata.kanban;
  if (isObj(k) && typeof k.boardId === 'string') {
    const board = await boardOf(k.boardId);
    if (board && board.tenantId === tenantId && board.ownerSubject?.kind === 'project') return board.ownerSubject.id;
  }
  const s = metadata.schedule;
  if (isObj(s) && typeof s.ownerScope === 'string' && s.ownerScope.startsWith('project:')) {
    const id = s.ownerScope.slice('project:'.length);
    if (id) return id; // a bare `project:` binds nothing (the ADR 1109 `runSubjectOf` rule)
  }
  return resolveRunProject(tenantId, metadata);
}
