/**
 * ADR 0133 Phase 3 + ADR 0902 — task-deck read route (authed, host-extension).
 *
 *   GET /host/openwop-app/tasks?conversationRunId=<optional>
 *
 * A read-only projection over the caller's runs + the work they delegated.
 * Always-on (ADR 0134 graduated the toggle); gating is the protocol scope and
 * ownership:
 *   - `runs:read` (ADR 0902 D1), the same scope `GET /runs` and the home tiles'
 *     `my-runs` read need;
 *   - ownership is the canonical run owner (`isRunOwnedBy`, D4), or every run in
 *     the caller's own personal workspace — the `listOwnRuns` rule;
 *   - delegated work is every descendant of an owned run through HOST-written
 *     linkage (D2/D3/D5): the `parent_run_id` column when the run is not a fork,
 *     else the dispatcher's `metadata.parentRunId`. A fork is never a child.
 * Tenant-scoped via `listRuns({tenantId})`; an unauthenticated caller gets an
 * empty deck. The scan is bounded and says so (`truncated`, D6).
 *
 * @see docs/adr/0133-run-task-deck.md
 * @see docs/adr/0902-task-deck-ownership-and-linkage.md
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import type { Storage } from '../../storage/storage.js';
import type { RunRecord } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { tenantOf } from '../featureRoute.js';
import { requireProtocolScope } from '../../host/protocolAuthorization.js';
import { isOwnPersonalWorkspace, isPersonalTenantId } from '../../host/requestSubject.js';
import { isRunOwnedBy } from '../../host/runOwner.js';
import { resolveTenantWorkflow } from '../../host/resolveLaunchDefinition.js';
import { linkedParentOf, TASK_BUCKETS, taskDeckProjection, type BlockedInfo, type TaskCard, type TaskDeck } from './taskDeckProjection.js';

type WorkflowCatalogLike = Parameters<typeof resolveTenantWorkflow>[0];

/** Rows examined, newest first (the tenant's runs, every member's). */
export const TASK_DECK_SCAN_CAP = 1000;
/** Delegation depth followed below an owned run (cycle-safe regardless). */
const MAX_DELEGATION_DEPTH = 8;
const BLOCKED_STATUSES = new Set(['paused', 'waiting-approval', 'waiting-input', 'waiting-external']);
const log = createLogger('feature.task-deck');

/** Lookups run at most this many at a time — the pool is small (TD2CD-3). */
const LOOKUP_CONCURRENCY = 8;

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

/** Every card the deck will actually SHOW (capped buckets + their nested children). */
function shownCards(deck: TaskDeck): TaskCard[] {
  const out: TaskCard[] = [];
  const walk = (c: TaskCard): void => { out.push(c); c.children.forEach(walk); };
  for (const b of TASK_BUCKETS) deck.buckets[b].forEach(walk);
  return out;
}

/** The blocked-interrupt map, for SHOWN blocked runs only (TD2CD-3: a deck with
 *  hundreds of old paused runs costs at most the cap's worth of lookups). */
async function blockedMap(storage: Storage, runs: readonly RunRecord[]): Promise<Map<string, BlockedInfo>> {
  const out = new Map<string, BlockedInfo>();
  await mapLimit(runs.filter((r) => BLOCKED_STATUSES.has(r.status)), LOOKUP_CONCURRENCY, async (r) => {
    const open = await storage.listOpenInterrupts(r.runId);
    const first = open[0];
    if (first) out.set(r.runId, { interruptId: first.interruptId, nodeId: first.nodeId, kind: first.kind });
  });
  return out;
}

/** TD2UX-3 — display names for the shown runs' workflows, through the tenant
 *  boundary (`resolveTenantWorkflow`: another tenant's id reads as unknown). */
async function workflowNameMap(catalog: WorkflowCatalogLike, tenantId: string, runs: readonly RunRecord[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(runs.filter((r) => typeof r.metadata?.['title'] !== 'string').map((r) => r.workflowId))];
  await mapLimit(ids, LOOKUP_CONCURRENCY, async (id) => {
    const wf = await resolveTenantWorkflow(catalog, tenantId, id).catch(() => null);
    const name = wf?.definition.metadata?.['name'];
    if (typeof name === 'string' && name.trim()) out.set(id, name);
  });
  return out;
}

export function emptyTaskDeck(): TaskDeck {
  return taskDeckProjection([], new Map());
}

/** Whose deck: the subject the owner stamp was minted from, and whether every
 *  run in the tenant is theirs (their own personal workspace). */
export interface DeckViewer {
  subject: string;
  wholeTenant: boolean;
}

/** The HTTP lane's viewer — the same derivation as `/dashboard/my-runs`. */
export function deckViewerOfRequest(req: Request): DeckViewer | undefined {
  const subject = req.userId ?? req.principal?.principalId;
  if (typeof subject !== 'string' || subject.length === 0) return undefined;
  return { subject, wholeTenant: isOwnPersonalWorkspace(req) };
}

/** The tool lane's viewer — the run's acting human, and the personal-workspace
 *  rule from the run's host-stamped `personalTenant` (ADR 0627 D3). */
export function deckViewerOfScope(scope: { tenantId: string; actingUserId?: string | undefined; personalTenant?: string | undefined }): DeckViewer | undefined {
  if (!scope.actingUserId) return undefined;
  return { subject: scope.actingUserId, wholeTenant: isPersonalTenantId(scope.personalTenant) && scope.personalTenant === scope.tenantId };
}

/** XCH-HOLE-4 (LLM-EXCHANGE-AUDIT Wave 4) + ADR 0902 D4: the ONE owner of "the
 *  deck of runs this person owns" — the HTTP route and the `openwop:tasks.deck`
 *  agent tool both call THIS with a `DeckViewer`, so the ownership rule can never
 *  drift between them. */
export async function buildOwnedTaskDeck(
  storage: Storage,
  catalog: WorkflowCatalogLike,
  tenantId: string,
  viewer: DeckViewer,
  conversationRunId?: string,
): Promise<TaskDeck> {
  // One past the cap says whether older runs exist beyond the scan.
  const fetched = await storage.listRuns({ tenantId, limit: TASK_DECK_SCAN_CAP + 1 });
  const truncated = fetched.length > TASK_DECK_SCAN_CAP;
  const runs = fetched.slice(0, TASK_DECK_SCAN_CAP);
  if (truncated) log.info('task_deck_scan_truncated', { tenantId, scanned: TASK_DECK_SCAN_CAP });

  // Owned runs, then every descendant through host-written linkage (D5).
  const childrenOf = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const p = linkedParentOf(r);
    if (p) childrenOf.set(p, [...(childrenOf.get(p) ?? []), r]);
  }
  const inScope = new Map<string, RunRecord>();
  let frontier = runs.filter((r) => viewer.wholeTenant || isRunOwnedBy(r, viewer.subject));
  for (const r of frontier) inScope.set(r.runId, r);
  for (let depth = 0; depth < MAX_DELEGATION_DEPTH && frontier.length > 0; depth++) {
    const next: RunRecord[] = [];
    for (const r of frontier) {
      for (const c of childrenOf.get(r.runId) ?? []) {
        if (!inScope.has(c.runId)) { inScope.set(c.runId, c); next.push(c); }
      }
    }
    frontier = next;
  }
  let scoped = [...inScope.values()];

  // Optional narrowing to one conversation/parent run + its descendants. Only
  // takes effect within the already-owned set, so it cannot widen access.
  if (conversationRunId) {
    const keep = new Set<string>();
    if (inScope.has(conversationRunId)) {
      let level = [conversationRunId];
      keep.add(conversationRunId);
      for (let depth = 0; depth < MAX_DELEGATION_DEPTH && level.length > 0; depth++) {
        level = level.flatMap((id) => (childrenOf.get(id) ?? []).map((c) => c.runId)).filter((id) => inScope.has(id) && !keep.has(id));
        for (const id of level) keep.add(id);
      }
    }
    scoped = scoped.filter((r) => keep.has(r.runId));
  }

  // Bucket and cap first; the per-card lookups then cost only what is shown.
  const shownIds = new Set(shownCards(taskDeckProjection(scoped, new Map())).map((c) => c.runId));
  const shown = scoped.filter((r) => shownIds.has(r.runId));
  const [blocked, names] = await Promise.all([blockedMap(storage, shown), workflowNameMap(catalog, tenantId, shown)]);
  return { ...taskDeckProjection(scoped, blocked, names), truncated };
}

export function registerTaskDeckRoutes(deps: RouteDeps): void {
  const { app, storage, hostSuite } = deps;

  app.get('/host/openwop-app/tasks', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'runs:read'); // ADR 0902 D1 — a run read
      const tenantId = tenantOf(req);
      const viewer = deckViewerOfRequest(req);
      if (!viewer) { res.json({ deck: emptyTaskDeck() }); return; } // anon → nothing owned
      const conversationRunId = typeof req.query.conversationRunId === 'string' ? req.query.conversationRunId : undefined;
      const deck = await buildOwnedTaskDeck(storage, hostSuite.workflowCatalog, tenantId, viewer, conversationRunId);
      res.json({ deck });
    } catch (err) { next(err); }
  });
}
