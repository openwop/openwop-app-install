/**
 * RFC 0173 §C.2 — `POST /conformance/seams/sample/effect-seams/fire`
 * (`fireEffectSeam`), served at its v1 address and reached at the v2 one via
 * the ADR 0634 alias.
 *
 * WHAT IT MUST PRODUCE. The scenario fires a manifest row, forks the run in
 * `replay` mode, and reads `GET /runs/{runId}/effects` on both. Suppression
 * means the fork shows no NEW attempt. So the witness is a row in this host's
 * Layer-2 ledger — not a delivered side effect — which is why `receiverUrl` is
 * optional and an unreachable destination is fine: "the witness is the effect
 * ledger, not delivery".
 *
 * SO IT DRIVES THE REAL LEDGER API, not an INSERT. `getInvocationLog().claim()`
 * then `.put()` is the same pair every guarded effect uses (ADR 0618's atomic
 * claim, then the recorded outcome). A seam that wrote the row directly would
 * witness the projection rather than the mechanism, and would keep passing if
 * the claim path broke — the class of vacuity this repo keeps finding.
 *
 * THE SEAM NAME IS VALIDATED AGAINST THE MANIFEST. An unknown name is a 400,
 * not a silently-created row: the request names "a row in GET /host/effect-seams",
 * and accepting anything else would let a scenario witness an effect on a seam
 * this host does not declare.
 *
 * WHY `branchReFires` IS NOT CONSULTED HERE. `v2-effect-seam-no-refire:59`
 * selects its target on `branchReFires === false`, but `replay.md:78` is
 * explicit that a branch permission and replay suppression are different
 * things: "A host MAY suppress branch effects and MUST NOT report that as
 * replay suppression." Confirmed as a corpus defect by the maintainer; every
 * `guarded: true` row is a valid target. This seam therefore fires any declared
 * row and leaves the selection to the scenario.
 */
import type { Express, Request, Response, NextFunction } from 'express';

import { createHash } from 'node:crypto';

import type { Storage } from '../storage/storage.js';
import type { NodeModule } from '../executor/types.js';
import type { WorkflowDefinition } from '../executor/types.js';
import type { HostAdapterSuite } from '../host/index.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { recordRevision } from '../host/workflowRevisions.js';
import { buildRunRecord, dispatchRunInBackground } from '../host/runDispatch.js';
import { insertRunWithStartContext } from '../host/runInsert.js';
import { SEAM_ROWS } from '../host/effectSeamManifest.js';
import { getInvocationLog } from '../executor/invocationLog.js';
import { toWireRunId } from '../host/v2Ids.js';
import { sendError } from '../middleware/errorEnvelope.js';

export const FIRE_EFFECT_SEAM_PATH = '/v1/host/sample/effect-seams/fire';
/** The conformance-only node the seam's run executes. */
export const FIRE_NODE_TYPE = 'conformance.effect-seam.fire';

/**
 * The seam's transient workflow id, SCOPED TO THE CALLING TENANT and stable
 * across fires: one definition per (tenant, seam), re-registered idempotently
 * (the same key, the same bytes, the same content-hash revision). The tenant
 * rides as a hash so the id stays a legal `workflowId` and names no tenant.
 */
export function fireWorkflowId(tenantId: string, seam: string): string {
  const t = createHash('sha256').update(tenantId).digest('hex').slice(0, 16);
  return `conformance.effect-seam.fire.${t}.${seam}`;
}

/**
 * RFC 0173 §C.2 — the one node the seam's run executes. One guarded effect
 * through the REAL Layer-2 pair (claim, then the recorded outcome) under the
 * run's own identity. `sideEffecting: true` is the point: a `replay` fork must
 * reproduce this node from the source's recorded outcome and never claim again,
 * which is what `v2-effect-seam-no-refire` reads off `GET /runs/{runId}/effects`.
 */
export const fireEffectSeamNode: NodeModule = {
  typeId: FIRE_NODE_TYPE,
  version: '1.0.0',
  sideEffecting: true,
  async execute(ctx) {
    const cfg = (ctx.config ?? {}) as { seam?: unknown; kind?: unknown; receiverUrl?: unknown };
    if (typeof cfg.seam !== 'string' || cfg.seam.length === 0) {
      return { status: 'failure', error: { code: 'invalid_request', message: `${FIRE_NODE_TYPE} requires config.seam` } };
    }
    const log = getInvocationLog();
    const invocationId = `seamfire-${cfg.seam}`;
    const attempt = typeof ctx.attempt === 'number' && ctx.attempt >= 1 ? ctx.attempt : 1;
    const won = await log.claim({ runId: ctx.runId, nodeId: ctx.nodeId, invocationId }, { nowMs: Date.now(), staleAfterMs: 60_000 });
    if (!won) {
      return { status: 'failure', error: { code: 'conflict', message: `the invocation claim for seam ${cfg.seam} is already held on this run` } };
    }
    // Content-free: the projection never surfaces `result`, and the
    // destination is deliberately unreachable — the witness is the row.
    await log.put(
      { runId: ctx.runId, nodeId: ctx.nodeId, attempt, invocationId },
      { seam: cfg.seam, kind: cfg.kind, receiverUrl: typeof cfg.receiverUrl === 'string' ? cfg.receiverUrl : 'https://unreachable.invalid/seam' },
    );
    return { status: 'success', outputs: { seam: cfg.seam } };
  },
};

/**
 * THE RUN IS CREATED IN THE CALLER'S TENANT, not a fixture tenant, and the
 * end-to-end test is what forced that.
 *
 * The first draft used its own `sample-effect-tenant`, by analogy with the
 * era-2 seed seam. But the scenario FIRES the seam and then reads
 * `GET /runs/{runId}/effects` on the returned run — as the same caller. A run
 * in a foreign tenant answers `403 id_tenant_mismatch` (`identity.md` §5), so
 * the witness would have been unreadable by the only party meant to read it.
 * A test asserting the 201 alone would never have shown this.
 */
function callerTenant(req: Request): string {
  return (req as Request & { tenantId?: string }).tenantId ?? 'default';
}

export function validateFireBody(body: unknown): { error: string } | { seam: string; receiverUrl?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b['seam'] !== 'string' || b['seam'].length === 0) return { error: 'seam must be a non-empty string' };
  if (b['receiverUrl'] !== undefined && typeof b['receiverUrl'] !== 'string') {
    return { error: 'receiverUrl must be a string when present' };
  }
  return { seam: b['seam'], ...(typeof b['receiverUrl'] === 'string' ? { receiverUrl: b['receiverUrl'] } : {}) };
}

export function registerFireEffectSeam(app: Express, deps: { storage: Storage; hostSuite: HostAdapterSuite }): void {
  const { storage, hostSuite } = deps;

  // SEAMS PROFILE ONLY. The node — and, per fire, the transient workflow — exist
  // only on a host booted with the conformance seam surface on. CLAUDE.md
  // forbids a pinned in-tree workflow; this is not one: nothing is registered on
  // a normal boot, and the per-fire definition is written ONLY as a
  // tenant-scoped revision — never to the workflow registry and never
  // `recordOwnership`-ed — so it is absent from the catalog, the tenant
  // ownership index, `/builder` and the `/` picker. The precedent is
  // `artifactTypeSeam.ts` (RFC 0142 leg B), a conformance witness workflow on a
  // request path; this seam goes one step further and makes no `wfreg:` row.
  // Pinned by `effect-seam-fire-absent-without-seams.test.ts` and
  // `v2-fire-effect-seam.test.ts`.
  if (process.env.OPENWOP_TEST_SEAM_ENABLED === 'true') getNodeRegistry().register(fireEffectSeamNode);

  app.post(FIRE_EFFECT_SEAM_PATH, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
        sendError(res, 404, 'not_found', 'The conformance seam surface is not enabled on this host.');
        return;
      }
      const parsed = validateFireBody(req.body);
      if ('error' in parsed) {
        sendError(res, 400, 'validation_error', parsed.error);
        return;
      }
      const row = SEAM_ROWS.find((r) => r.seam === parsed.seam);
      if (!row) {
        sendError(
          res,
          400,
          'validation_error',
          `unknown seam "${parsed.seam}" — it must name a row in GET /host/effect-seams (${SEAM_ROWS.map((r) => r.seam).join(', ')})`,
        );
        return;
      }

      // A REAL RUN, not a hand-built row (fix 2026-09-26). This seam used to
      // `insertRun` a `completed` record for an unregistered workflowId and
      // append ZERO events. The ledger row was real, but the run was not: the
      // scenario's `:fork {mode:'replay'}` defaults `fromSeq` to 0, an empty log
      // has no sequence 0, and `runs.md` §Fork REQUIRES `422 fork_point_invalid`
      // for that — so `v2-effect-seam-no-refire` recorded `blocked` on every
      // lane, in-process and prod alike, and suppression was never witnessed.
      // (Past the 422 it would have 404ed: nothing resolved the workflowId.)
      //
      // Now the seam records a one-node definition as a tenant-scoped REVISION
      // (a fork on another instance resolves it through the run's
      // `definitionRevision` pin) and runs it through the normal dispatch. The node,
      // `conformance.effect-seam.fire` (`fireEffectSeamNode` above), does the same
      // Layer-2 claim + put this handler used to do inline, and is flagged
      // `sideEffecting` — so a replay fork reproduces it from the source outcome
      // and never claims again. The artifactTypeSeam precedent, one lane over.
      if (!getNodeRegistry().isResolvable(FIRE_NODE_TYPE)) {
        sendError(res, 404, 'not_found', `the effect-seam fire node (${FIRE_NODE_TYPE}) is not registered — the seam surface was off when this host booted`);
        return;
      }
      const tenant = callerTenant(req);
      const workflowId = fireWorkflowId(tenant, row.seam);
      const definition: WorkflowDefinition = {
        workflowId,
        nodes: [{
          nodeId: 'seam-fire',
          typeId: FIRE_NODE_TYPE,
          config: { seam: row.seam, kind: row.kind, ...(parsed.receiverUrl ? { receiverUrl: parsed.receiverUrl } : {}) },
        }],
        edges: [],
        metadata: { name: `RFC 0173 §C.2 — fire ${row.seam}`, tags: ['conformance', 'seam'] },
      };
      // The REVISION store, not the workflow registry: the run's
      // `definitionRevision` pin (stamped below from the same content hash) is
      // what `resolveRunDefinition` reads first, so a fork on any instance
      // resolves this definition with no `wfreg:` row at all. A registry write
      // would be a new in-tree pin site (the shrink-only WF-KB-2 ratchet) and a
      // catalog entry nobody owns. Tenant-scoped and idempotent: identical
      // content under the same id is a no-op (`recordRevision`).
      await recordRevision(tenant, definition, { createdBy: 'conformance-seam' });
      const run = buildRunRecord({ workflowId, tenantId: tenant, inputs: { seam: row.seam }, now: new Date().toISOString() });
      run.metadata = { ...(run.metadata ?? {}), seededBy: 'conformance-seam', seam: row.seam };
      await insertRunWithStartContext(storage, run, { definition });
      dispatchRunInBackground({ storage, run, definition, hostSuite });
      const runId = run.runId;

      // Answer only once the run is terminal: the scenario reads the ledger and
      // forks immediately, so a 201 before the node ran would hand it an empty
      // projection. Bounded — a hang is reported, never an endless request.
      let status = 'pending';
      for (let i = 0; i < 80; i++) {
        status = (await storage.getRun(runId))?.status ?? 'pending';
        if (status !== 'pending' && status !== 'running') break;
        await new Promise((r) => setTimeout(r, 125));
      }
      if (status !== 'completed') {
        sendError(res, 500, 'internal_error', `the seam's run ended ${status}, so no effect was recorded for ${row.seam}`);
        return;
      }

      res.status(201).json({ runId: toWireRunId(runId, tenant) });
    } catch (err) {
      next(err);
    }
  });
}
