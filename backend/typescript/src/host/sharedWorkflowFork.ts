/**
 * ADR 0789 — copy-on-write for SHARED workflow definitions.
 *
 * Seeded workflows (`wf.seed.*`, `openwop-app.authored.*`, the seeded demo
 * walkthroughs) are ONE definition row in the global by-id registry; only the
 * OWNERSHIP row is per tenant. So a tenant write that lands on the shared id
 * changes the steps every other seeded tenant runs, with that tenant's keys.
 *
 * The rule this module implements: a shared id is NEVER written through a tenant
 * lane. A tenant that changes one gets its own copy under a fresh tenant-owned id:
 *
 *   1. register the fork's definition (durable, awaited);
 *   2. record its first revision (attributed like any save);
 *   3. record ownership — the ownership index is what makes it visible in
 *      `/builder` and the `/` picker (ADR 0163 R3), so this is not optional;
 *   4. re-point this tenant's references (schedules, cards, …) via the registry's
 *      fork hooks — never another tenant's;
 *   5. only then drop this tenant's ownership of the shared id.
 *
 * Ordered so a crash part-way fails SAFE: before step 5 the tenant simply owns
 * both (a visible duplicate), and the shared row is never touched at any step.
 * Runs already stamped with the shared id keep resolving it — it never changes.
 */
import type { WorkflowDefinition } from '../executor/types.js';
import { registerWorkflowDurable, getRegisteredWorkflowAsync, runWorkflowForkHooks } from './workflowsRegistry.js';
import { recordRevision, getRevision } from './workflowRevisions.js';
import { OpenwopError } from '../types.js';
import { recordOwnership, removeOwnership, getOwned, listOwned, claimForkOf, setRepointPending } from './workflowOwnership.js';
import { lifecycleOf, withLifecycle } from './workflowLifecycle.js';
import { revisionHashOf } from './definitionHash.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.sharedWorkflowFork');

/**
 * ADR 0789 — the builder's "this canvas is unchanged since it was loaded" marker.
 *
 * Why the CLIENT says it rather than the server diffing: the builder's serializer
 * normalises what it sends (drops a default `triggerRule`, empty `config`, default
 * ports, node names equal to the catalog label, and fills first-port defaults
 * from ITS catalog), so a hash of an untouched seeded workflow's round-trip is not
 * the stored hash, and the port defaults are not derivable server-side. Without
 * this, the first Run of an untouched seeded workflow forked it.
 *
 * Trusting it is safe because it can only SUPPRESS a write: a client that lies
 * gets a same-id no-op, i.e. its edit is not saved. It can never cause a write to
 * the shared row, which no tenant lane performs at all.
 */
export const CANVAS_PRISTINE_HEADER = 'x-openwop-canvas-pristine';

// ADR 0794 — the fork id is minted by the one mint module; re-exported for its callers.
export { forkWorkflowId } from './workflowId.js';
import { forkWorkflowId } from './workflowId.js';

export interface ForkResult {
  workflowId: string;
  forkedFrom: string;
  revision: string;
  repointed: Record<string, number>;
  repointFailed: string[];
}

/**
 * Fork `def` (a tenant's edited copy of the shared `def.workflowId`) onto a new
 * tenant-owned id. The caller has already authorized the write (the tenant OWNS
 * the shared id) and validated `def`.
 *
 * Every step is idempotent and keyed on ONE fork id, claimed by compare-and-swap
 * on the shared ownership row (`claimForkOf`). So two concurrent first saves (two
 * tabs, two instances) converge on the same fork, last writer wins exactly as an
 * ordinary autosave; and a save after a crash part-way re-claims the same id and
 * completes the remaining steps instead of minting a second copy.
 */
export async function forkSharedWorkflow(
  tenantId: string,
  def: WorkflowDefinition,
  opts: { createdBy?: string; declaredFields?: readonly string[] } = {},
): Promise<ForkResult> {
  const sharedId = def.workflowId;
  let candidate = forkWorkflowId(sharedId);
  // A random 8-hex collision is negligible, but a collision would overwrite
  // whatever holds the id, so check rather than assume.
  for (let i = 0; i < 3 && (await getRegisteredWorkflowAsync(candidate)); i += 1) candidate = forkWorkflowId(sharedId);
  const priorOwnership = await getOwned(tenantId, sharedId);
  const claimed = await claimForkOf(tenantId, sharedId, candidate);
  // `null`: a concurrent fork already COMPLETED (it removed the shared row) — this
  // request lands on that fork like an ordinary save of it.
  const workflowId = claimed ?? (await forkOfShared(tenantId, sharedId));
  if (!workflowId) {
    throw new OpenwopError('workflow_not_found', 'workflow not found', 404, { workflowId: sharedId });
  }
  const existingFork = await getOwned(tenantId, workflowId);
  // The fork is the tenant's own draft-or-saved workflow: it inherits the
  // tenant's view of the lifecycle (the ownership row), never another tenant's.
  const lc = lifecycleOf(def);
  const forked: WorkflowDefinition = withLifecycle({ ...def, workflowId }, {
    transient: lc.transient,
    archivedAt: priorOwnership?.archivedAt ?? lc.archivedAt,
    generatedBy: lc.generatedBy,
  });
  // A tenant that PROMOTED the seeded workflow launches its published revision in
  // production (`resolveLaunchWorkflow`). The re-pointed schedules and triggers
  // must keep launching THAT, not this unpromoted edit: carry the published
  // content over as the fork's pinned revision, and record the edit as the head.
  let publishedRevision = existingFork?.publishedRevision;
  if (!publishedRevision && priorOwnership?.publishedRevision) {
    const pub = await getRevision(sharedId, priorOwnership.publishedRevision);
    if (pub) {
      publishedRevision = (await recordRevision(tenantId, { ...pub.definition, workflowId })) ?? undefined;
    }
  }
  await registerWorkflowDurable(forked);
  await recordRevision(tenantId, forked, {
    ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
    ...(opts.declaredFields ? { declaredFields: [...opts.declaredFields] } : {}),
  });
  const flc = lifecycleOf(forked);
  const name = typeof forked.metadata?.name === 'string' ? forked.metadata.name : priorOwnership?.name;
  await recordOwnership(tenantId, workflowId, {
    ...(name !== undefined ? { name } : {}),
    nodeCount: forked.nodes.length,
    ...(flc.transient !== undefined ? { transient: flc.transient } : {}),
    ...(flc.archivedAt !== undefined ? { archivedAt: flc.archivedAt } : {}),
    ...(publishedRevision ? { publishedRevision } : {}),
    forkedFrom: sharedId,
  });
  const { repointed, failed } = await runWorkflowForkHooks(tenantId, sharedId, workflowId);
  // Owed hooks are persisted on the fork's row and re-run on its next save
  // (`retryPendingRepoints`) — a failure is never only a log line.
  await setRepointPending(tenantId, workflowId, failed);
  await removeOwnership(tenantId, sharedId);
  log.info('shared_workflow_forked', { tenantId, forkedFrom: sharedId, workflowId, repointed, repointFailed: failed });
  return { workflowId, forkedFrom: sharedId, revision: revisionHashOf(forked), repointed, repointFailed: failed };
}

/**
 * ADR 0789 — re-run the fork hooks a previous fork recorded as failed. Called on
 * every save of a fork whose row carries `repointPending`; the hooks are
 * idempotent, so a re-run moves only what is still on the shared id. Returns the
 * hooks still failing (persisted again).
 */
export async function retryPendingRepoints(tenantId: string, workflowId: string): Promise<string[]> {
  const row = await getOwned(tenantId, workflowId);
  if (!row?.forkedFrom || !row.repointPending || row.repointPending.length === 0) return [];
  const { repointed, failed } = await runWorkflowForkHooks(tenantId, row.forkedFrom, workflowId, row.repointPending);
  await setRepointPending(tenantId, workflowId, failed);
  log.info('shared_workflow_repoint_retried', { tenantId, workflowId, forkedFrom: row.forkedFrom, repointed, stillFailing: failed });
  return failed;
}

/** ADR 0789 — the tenant's fork of `sharedId`, if it has one (a tenant-scoped
 *  list, only reached when the tenant no longer owns the shared id). */
export async function forkOfShared(tenantId: string, sharedId: string): Promise<string | undefined> {
  return (await listOwned(tenantId)).find((r) => r.forkedFrom === sharedId)?.workflowId;
}

/** The shared ids this tenant has already forked away from — a re-seed must not
 *  hand them back (one tenant-scoped list, not a scan). */
export async function forkedSharedIds(tenantId: string): Promise<Set<string>> {
  return new Set((await listOwned(tenantId)).map((r) => r.forkedFrom).filter((v): v is string => typeof v === 'string'));
}
