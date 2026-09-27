/**
 * ADR 0481 — the WORKFLOW collab resource (ADR 0364 P2): builder multiplayer
 * over the existing collab transport. One room per workflow
 * (`wf:<workflowId>` — namespaced so the two resource kinds can never
 * collide in the room map, leases, snapshots, or seed claims).
 *
 * Authority (the D2 lock/derive doctrine): while a room lives, the room is
 * the head's ONLY writer — REST save/rollback/lifecycle 409
 * (`workflow_room_live`, checked via `workflowRoomLive` below). The derive
 * reads the `definition` ROOT SCALAR each client writes on its autosave
 * cadence (the FE-serialized head candidate — NO server-side serializer to
 * drift; every room member is an authorized editor with identical REST save
 * authority, so the scalar grants nothing new), validates it closed-world,
 * and writes the head through the full save trio — the ADR 0474 pairing
 * ratchet holds at the derive site. A failing validation SKIPS the derive
 * (stale beats invalid — the canvas doctrine).
 */
import type * as Y from 'yjs';
import type { Request } from 'express';
import { registerCollabResourceDriver, hasLiveRoomGlobal, pruneCollabSnapshot, type RoomMeta } from './collabRoom.js';
import { COLLAB_TOGGLE_ID, mintCollabTicket, claimCollabSeed, deleteCollabSeedClaim, deleteCollabSeedClaimsAnyTenant } from './collabServer.js';
import { getOwned, recordOwnership } from '../workflowOwnership.js';
import { lifecycleOf } from '../workflowLifecycle.js';
import { recordRevision } from '../workflowRevisions.js';
import { registerWorkflow, getRegisteredWorkflowAsync, onWorkflowDeleted } from '../workflowsRegistry.js';
import { validateWorkflowDefinition } from '../workflowDefinitionValidation.js';
import { getChainBackedWorkflow } from '../chainBackedWorkflows.js';
import { assertNoDisabledPacks } from '../packEnablement.js';
import { preserveDroppedFields } from '../preserveDroppedFields.js';
import { requireFeatureEnabled, toggleSubjectOf } from '../../features/featureRoute.js';
import { resolveOne } from '../featureToggles/service.js';
import { tenantOf } from '../requestSubject.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import type { BackendFeature } from '../../features/types.js';
import type { WorkflowDefinition } from '../../executor/types.js';

const log = createLogger('host.collab.workflow');

export const WORKFLOW_COLLAB_TOGGLE_ID = 'workflow-collab';
export const WORKFLOW_ROOM_PREFIX = 'wf:';

/** Mirrors routes/workflows.ts PUBLIC_WORKFLOW_ID (kept small + cross-
 *  referenced there): reserved public namespaces never open rooms — every
 *  tenant can read them, and a room would make one tenant their author. */
const RESERVED_PUBLIC_ID = /^(wf\.seed\.|tmpl\.|openwop-app\.)/;

export const workflowRoomId = (workflowId: string): string => `${WORKFLOW_ROOM_PREFIX}${workflowId}`;

/** The REST-lock predicate (save/rollback/lifecycle call this): true iff ANY
 *  instance holds a live room for the workflow. */
export async function workflowRoomLive(workflowId: string): Promise<boolean> {
  return hasLiveRoomGlobal(workflowRoomId(workflowId));
}

/** Shared eligibility: which workflows may open rooms at all. */
export async function workflowCollabEligible(tenantId: string, workflowId: string): Promise<boolean> {
  if (!workflowId || RESERVED_PUBLIC_ID.test(workflowId)) return false;
  if (getChainBackedWorkflow(workflowId)) return false; // the chain is the author
  return (await getOwned(tenantId, workflowId)) !== null;
}

/* ── the derive driver ──────────────────────────────────────────────────── */

async function deriveWorkflowHead(roomId: string, doc: Y.Doc, meta: RoomMeta): Promise<void> {
  const workflowId = roomId.slice(WORKFLOW_ROOM_PREFIX.length);
  const root = doc.getMap<unknown>('doc');
  const raw = root.get('definition');
  if (typeof raw !== 'string' || raw.length === 0) return; // nothing serialized yet
  let candidate: WorkflowDefinition;
  try {
    candidate = JSON.parse(raw) as WorkflowDefinition;
  } catch {
    log.warn('collab workflow derive skipped — definition scalar is not JSON', { workflowId });
    return;
  }
  // The scalar must be for THIS workflow (a client bug writing another id
  // would otherwise cross-write heads through the derive's authority).
  if (candidate.workflowId !== workflowId) {
    log.warn('collab workflow derive skipped — definition id mismatch', { workflowId, got: candidate.workflowId });
    return;
  }
  // The tenant must still own the head (deletion raced the derive) and it
  // must remain room-eligible (a chain-conversion mid-session).
  if (!(await workflowCollabEligible(meta.tenantId, workflowId))) {
    log.warn('collab workflow derive skipped — no longer eligible', { workflowId });
    return;
  }
  // validateWorkflowDefinition THROWS on a bad body (the route contract) —
  // here a failing candidate SKIPS the derive (stale beats invalid).
  let validated: WorkflowDefinition;
  try {
    validated = validateWorkflowDefinition(candidate);
  } catch (err) {
    log.warn('collab workflow derive skipped — failed validation (stale beats invalid)', { workflowId, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  candidate = validated;
  // Code-review M1 — the ADR 0194 registration choke applies to EVERY
  // registration path: a room member must not register nodes from packs the
  // workspace disabled (REST would 403 the same write).
  try {
    await assertNoDisabledPacks(candidate, meta.tenantId);
  } catch (err) {
    log.warn('collab workflow derive skipped — disabled packs', { workflowId, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  // The room carries content, NEVER lifecycle (verb-owned): strip whatever
  // the client serialized (code-review M3 — a headless-lifecycle workflow
  // would otherwise register a client-chosen transient/archivedAt verbatim),
  // then reapply the CURRENT head's.
  const current = await getRegisteredWorkflowAsync(workflowId);
  // ADR 0524 — a room peer on an older bundle serializes a definition with no
  // node `inputs` (and no def-level `variables`), and the room's `definition`
  // scalar is last-writer-wins, so that peer would erase what a corrected peer
  // just restored — with REST autosave suspended, nothing corrects it.
  //
  // The derive MERGES, exactly like the REST route, reusing the head read above.
  //
  // §Correction (code review): an earlier cut SKIPPED the derive here, on the
  // reasoning that "the room re-derives on the next edit, so skipping costs one
  // derive rather than the data". Both halves of that were wrong. `evict()`
  // runs a FORCED derive at room close — the documented canonical parity point —
  // so a skip there means the entire session's graph never reaches the head,
  // while REST save 409s (`workflow_room_live`) for the whole session. And it is
  // STICKY: a pre-0523 peer writes stripped nodes into the durable Y snapshot,
  // so every later peer deserializes stripped, serializes stripped, and skips
  // again — across sessions, until someone retypes the values by hand.
  //
  // So this lane MERGES, exactly like the REST route. Consistency is the point:
  // two write paths with different loss semantics is how this class started.
  const collabMerge = preserveDroppedFields(candidate, current ?? null);
  if (collabMerge.preserved.length > 0) {
    log.warn('collab workflow derive restored fields a peer dropped', {
      workflowId, preserved: collabMerge.preserved,
    });
    candidate = collabMerge.definition;
  }
  const lifecycle = (current?.metadata as { lifecycle?: unknown } | undefined)?.lifecycle;
  const strippedMeta = { ...(candidate.metadata ?? {}) } as Record<string, unknown>;
  delete strippedMeta.lifecycle;
  const def: WorkflowDefinition = {
    ...candidate,
    metadata: (lifecycle !== undefined ? { ...strippedMeta, lifecycle } : strippedMeta) as WorkflowDefinition['metadata'],
  } as WorkflowDefinition;
  registerWorkflow(def);
  // Code-review H2 — the delete-resurrection TOCTOU: a DELETE landing between
  // the eligibility check and registerWorkflow would be silently undone (and
  // the orphan def publicly readable). Re-check ownership AFTER the register;
  // gone ⇒ tear the resurrection back down (hook prunes are idempotent).
  if (!(await getOwned(meta.tenantId, workflowId))) {
    const { deleteRegisteredWorkflow } = await import('../workflowsRegistry.js');
    deleteRegisteredWorkflow(workflowId, [meta.tenantId]);
    log.warn('collab derive raced a delete — resurrection torn down', { workflowId });
    return;
  }
  const name = typeof def.metadata?.name === 'string' ? def.metadata.name : undefined;
  // Code-review M2 — pass the denormalized lifecycle flags like every other
  // write site (omitting them CLEARED transient/archivedAt on the row).
  const lc = lifecycleOf(def);
  await recordOwnership(meta.tenantId, workflowId, {
    ...(name !== undefined ? { name } : {}),
    nodeCount: def.nodes.length,
    ...(lc.transient !== undefined ? { transient: lc.transient } : {}),
    ...(lc.archivedAt !== undefined ? { archivedAt: lc.archivedAt } : {}),
  });
  await recordRevision(meta.tenantId, def, { createdBy: 'collab' });
  log.info('collab derived workflow head', { workflowId, nodes: def.nodes.length });
}

registerCollabResourceDriver('workflow', {
  derive: (roomId, doc, meta) => deriveWorkflowHead(roomId, doc, meta),
});

/* ── deletion hygiene ───────────────────────────────────────────────────── */

onWorkflowDeleted(async (workflowId, tenantIds) => {
  const roomId = workflowRoomId(workflowId);
  await pruneCollabSnapshot(roomId);
  // Code-review H1 — the seed claim MUST die with the workflow: a stale
  // consumed claim over an empty snapshot means seed:false for every client
  // of a recreated id, forever (no heal path in this lane).
  if (tenantIds && tenantIds.length > 0) {
    for (const t of tenantIds) await deleteCollabSeedClaim(t, roomId);
  } else {
    await deleteCollabSeedClaimsAnyTenant(roomId);
  }
});

/* ── the feature: toggle + ticket/claim-seed routes ─────────────────────── */

async function requireWorkflowCollabAccess(req: Request): Promise<{ tenantId: string; workflowId: string }> {
  await requireFeatureEnabled(req, COLLAB_TOGGLE_ID, 'Real-time collaboration');
  const tenantId = tenantOf(req);
  const workflowId = req.params.workflowId ?? '';
  // The resource's own toggle — same UNIFORM 404 body as every other miss.
  const assignment = await resolveOne(WORKFLOW_COLLAB_TOGGLE_ID, toggleSubjectOf(req));
  if (!assignment?.enabled) throw new OpenwopError('not_found', 'workflow not found', 404, {});
  if (!(await workflowCollabEligible(tenantId, workflowId))) {
    throw new OpenwopError('not_found', 'workflow not found', 404, {});
  }
  return { tenantId, workflowId };
}

export const workflowCollabFeature: BackendFeature = {
  id: WORKFLOW_COLLAB_TOGGLE_ID,
  registerRoutes: ({ app }) => {
    app.post('/v1/host/openwop-app/workflow-collab/:workflowId/ticket', (req, res, next) => {
      void (async () => {
        try {
          const { tenantId, workflowId } = await requireWorkflowCollabAccess(req);
          // The ticket is scoped to the NAMESPACED room id — it can never
          // authorize a canvas room for a same-named id (and vice versa).
          res.json({ ticket: mintCollabTicket(tenantId, workflowRoomId(workflowId), Date.now(), req.principal?.principalId) });
        } catch (err) { next(err); }
      })();
    });
    app.post('/v1/host/openwop-app/workflow-collab/:workflowId/claim-seed', (req, res, next) => {
      void (async () => {
        try {
          const { tenantId, workflowId } = await requireWorkflowCollabAccess(req);
          const seed = await claimCollabSeed(tenantId, workflowRoomId(workflowId), req.principal?.principalId ?? tenantId);
          res.json({ seed });
        } catch (err) { next(err); }
      })();
    });
  },
  toggleDefault: {
    id: WORKFLOW_COLLAB_TOGGLE_ID,
    label: 'Workflow builder multiplayer',
    description:
      'Real-time co-editing of workflow drafts in the builder (Yjs CRDT over the shared collab transport, ADR 0481). OFF by default — ADR 0364 Phase 4 records the toggle flip as a product decision, and the Playwright browser canary (the Gate B residual) is a recorded precondition for production enablement. Live only when BOTH this and realtime-collab are on.',
    category: 'Documents',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'workflow-collab',
  },
};
