/**
 * ADR 0475 — the debug-loop HTTP surface (host-extension, non-normative):
 *
 *   GET    …/workflows/:workflowId/pins            — the draft's pins
 *   PUT    …/workflows/:workflowId/pins/:nodeId    — pin a node's output
 *   DELETE …/workflows/:workflowId/pins/:nodeId    — unpin
 *   DELETE …/workflows/:workflowId/pins            — clear the debug session
 *   POST   …/workflows/:workflowId/pins/from-run   — prefill from a run's real outputs
 *   POST   …/workflows/:workflowId/debug-run       — execute-from-step over pins
 *   POST   …/runs/redrive                          — bulk redrive (new run row)
 *
 * All owner-gated (the lifecycle-verb 404 posture). A debug run is an
 * ORDINARY run built through the shared seam (`buildRunRecord` → the ADR 0099
 * insert → dispatch): the POST /v1/runs capability refusal applies, the
 * ADR 0474 revision pin stamps, and the event log opens with a SELF-DESCRIBING
 * synthetic prefix (`run.started` + a `node.completed` per pinned predecessor
 * — the fork-checkpoint semantics, so re-folding this run's own prefix
 * reproduces the pins). Execution resumes over the equivalent synthetic
 * `SerializedSnapshot` (the branch-fork mechanism): pinned predecessors are
 * `completed` with their pinned outputs, everything outside the target
 * subgraph is `skipped`. Published/production launches NEVER read pins.
 */

import type { Express, Request } from 'express';
import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from '../host/index.js';
import type { WorkflowDefinition } from '../executor/types.js';
import { OpenwopError } from '../types.js';
import { tenantOf, personalTenantOf } from '../host/requestSubject.js';
import { getOwned } from '../host/workflowOwnership.js';
import { getRegisteredWorkflowAsync } from '../host/workflowsRegistry.js';
import { loadOwnedRun } from '../host/runAccess.js';
import { resolveRunDefinition } from '../host/resolveRunDefinition.js';
import { insertRunWithStartContext } from '../host/runInsert.js';
import { buildRunRecord, dispatchRunInBackground, failRunClosedOnDispatchError } from '../host/runDispatch.js';
import { seedRunVariables, deferredConfigurableInputs } from '../host/variablesRuntime.js';
import { executeRun, snapshotFromEventPrefix, type SerializedSnapshot } from '../executor/executor.js';
import { getEventLog } from '../executor/eventLog.js';
import { capabilityGatedTypeIdRefusal } from './runs.js';
import { runQuotaMiddleware, reserveConcurrentSlot } from '../middleware/rateLimit.js';
import { requireProtocolScope } from '../host/protocolAuthorization.js';
import {
  putDebugPin,
  listDebugPins,
  deleteDebugPin,
  clearDebugPins,
} from '../host/workflowDebugPins.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('routes.workflowDebug');

const REDRIVE_MAX = 25;

/** Owner-gated head resolve: 404 posture for foreign/unknown ids (the
 *  lifecycle-verb discipline — no existence leak). */
async function loadOwnedHead(req: Request, workflowId: string): Promise<WorkflowDefinition> {
  const owned = workflowId ? await getOwned(tenantOf(req), workflowId) : null;
  const def = owned ? await getRegisteredWorkflowAsync(workflowId) : null;
  if (!owned || !def) throw new OpenwopError('workflow_not_found', 'Workflow not found in this catalog.', 404, { workflowId });
  return def;
}

/** The node partition for execute-from-step: the target subgraph, its direct
 *  upstream frontier (must be pinned), and the rest (skipped). */
export function partitionForDebug(
  def: WorkflowDefinition,
  fromNodeId: string,
  mode: 'from-here' | 'only',
): { target: Set<string>; predecessors: Set<string>; rest: Set<string> } {
  const nodeIds = new Set(def.nodes.map((n) => n.nodeId));
  if (!nodeIds.has(fromNodeId)) {
    throw new OpenwopError('validation_error', `fromNodeId '${fromNodeId}' is not a node of this workflow.`, 400, { fromNodeId });
  }
  const downstream = new Map<string, string[]>();
  for (const e of def.edges ?? []) {
    downstream.set(e.sourceNodeId, [...(downstream.get(e.sourceNodeId) ?? []), e.targetNodeId]);
  }
  const target = new Set<string>([fromNodeId]);
  if (mode === 'from-here') {
    const queue = [fromNodeId];
    while (queue.length > 0) {
      for (const next of downstream.get(queue.pop()!) ?? []) {
        if (!target.has(next)) {
          target.add(next);
          queue.push(next);
        }
      }
    }
  }
  const predecessors = new Set<string>();
  for (const e of def.edges ?? []) {
    if (target.has(e.targetNodeId) && !target.has(e.sourceNodeId)) predecessors.add(e.sourceNodeId);
  }
  const rest = new Set<string>([...nodeIds].filter((id) => !target.has(id) && !predecessors.has(id)));
  return { target, predecessors, rest };
}

export function registerWorkflowDebugRoutes(app: Express, deps: { storage: Storage; hostSuite: HostAdapterSuite }): void {
  const BASE = '/v1/host/openwop-app/workflows/:workflowId';

  app.get(`${BASE}/pins`, async (req, res, next) => {
    try {
      const workflowId = req.params.workflowId ?? '';
      await loadOwnedHead(req, workflowId);
      const pins = await listDebugPins(tenantOf(req), workflowId);
      res.json({
        items: pins.map(({ nodeId, output, sourceRunId, createdAt }) => ({
          nodeId, output, ...(sourceRunId ? { sourceRunId } : {}), createdAt,
        })),
      });
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/pins/:nodeId`, async (req, res, next) => {
    try {
      const workflowId = req.params.workflowId ?? '';
      const def = await loadOwnedHead(req, workflowId);
      const nodeId = req.params.nodeId ?? '';
      if (!def.nodes.some((n) => n.nodeId === nodeId)) {
        throw new OpenwopError('validation_error', `'${nodeId}' is not a node of this workflow.`, 400, { nodeId });
      }
      const output = (req.body as { output?: unknown } | undefined)?.output;
      if (!output || typeof output !== 'object' || Array.isArray(output)) {
        throw new OpenwopError('validation_error', 'output must be an object (the node.completed outputs shape).', 400, {});
      }
      const pin = await putDebugPin({
        tenantId: tenantOf(req),
        workflowId,
        nodeId,
        output: output as Record<string, unknown>,
        ...(req.userId ? { createdBy: req.userId } : {}),
      });
      res.json({ nodeId: pin.nodeId, createdAt: pin.createdAt });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/pins/:nodeId`, async (req, res, next) => {
    try {
      const workflowId = req.params.workflowId ?? '';
      await loadOwnedHead(req, workflowId);
      const removed = await deleteDebugPin(tenantOf(req), workflowId, req.params.nodeId ?? '');
      res.json({ removed });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/pins`, async (req, res, next) => {
    try {
      const workflowId = req.params.workflowId ?? '';
      await loadOwnedHead(req, workflowId);
      const removed = await clearDebugPins(tenantOf(req), workflowId);
      res.json({ removed });
    } catch (err) { next(err); }
  });

  // Prefill pins from an owned run's REAL outputs (failed-run→editor). OQ1:
  // a run of an older revision may carry outputs for since-renamed nodes —
  // unmatched ids are reported, never silently dropped.
  app.post(`${BASE}/pins/from-run`, async (req, res, next) => {
    try {
      const workflowId = req.params.workflowId ?? '';
      const def = await loadOwnedHead(req, workflowId);
      const runId = (req.body as { runId?: unknown } | undefined)?.runId;
      if (typeof runId !== 'string' || runId.length === 0) {
        throw new OpenwopError('validation_error', 'runId is required.', 400, {});
      }
      const run = await loadOwnedRun(req, deps.storage, runId, 'runs:read');
      if (run.workflowId !== workflowId) {
        throw new OpenwopError('validation_error', 'The run does not belong to this workflow.', 400, { runId });
      }
      const events = await deps.storage.listEvents(runId, { fromSeq: -1, limit: 100_000 });
      // Fold ONLY the completed events: the full-prefix fold refuses (null) on
      // an open interrupt, but for PREFILL a completed node's output is real
      // data regardless of what else was in flight.
      const snapshot = snapshotFromEventPrefix(events.filter((e) => e.type === 'node.completed'));
      const nodeIds = new Set(def.nodes.map((n) => n.nodeId));
      const pinned: string[] = [];
      const unmatched: string[] = [];
      const skipped: Array<{ nodeId: string; reason: string }> = [];
      for (const [nodeId, output] of snapshot?.nodeOutputs ?? []) {
        if (!nodeIds.has(nodeId)) {
          unmatched.push(nodeId);
          continue;
        }
        try {
          await putDebugPin({
            tenantId: tenantOf(req),
            workflowId,
            nodeId,
            output,
            sourceRunId: runId,
            ...(req.userId ? { createdBy: req.userId } : {}),
          });
          pinned.push(nodeId);
        } catch (err) {
          // Review M3 — the honest partial: one oversized output (routine for
          // an LLM node) must not fail the whole prefill after earlier pins
          // were written. Skip-and-report, mirroring the `unmatched` contract.
          skipped.push({ nodeId, reason: err instanceof OpenwopError ? err.code : 'internal_error' });
        }
      }
      res.json({
        pinned,
        ...(unmatched.length > 0 ? { unmatched } : {}),
        ...(skipped.length > 0 ? { skipped } : {}),
      });
    } catch (err) { next(err); }
  });

  // Execute-from-step over pins — an ORDINARY draft run resumed over a
  // synthetic branch-fork snapshot. Missing pins are a 422 NAMING the nodes.
  // Run-creating ⇒ the SAME per-session run quota as POST /v1/runs (not a
  // quota side door).
  app.post(`${BASE}/debug-run`, runQuotaMiddleware(), async (req, res, next) => {
    try {
      // Review H2 — a debug run IS a run creation: the same RFC 0049 scope
      // floor as POST /v1/runs (no-op unless enforcement is on).
      await requireProtocolScope(req, 'runs:create');
      const workflowId = req.params.workflowId ?? '';
      const def = await loadOwnedHead(req, workflowId);
      const body = (req.body ?? {}) as { fromNodeId?: unknown; mode?: unknown; inputs?: unknown };
      const fromNodeId = typeof body.fromNodeId === 'string' ? body.fromNodeId : '';
      if (!fromNodeId) throw new OpenwopError('validation_error', 'fromNodeId is required.', 400, {});
      if (body.mode !== undefined && body.mode !== 'from-here' && body.mode !== 'only') {
        throw new OpenwopError('validation_error', "mode must be 'from-here' or 'only'.", 400, {});
      }
      const mode: 'from-here' | 'only' = body.mode === 'only' ? 'only' : 'from-here';

      // The same refusal POST /v1/runs applies — a debug run is not a side door.
      const refusal = capabilityGatedTypeIdRefusal(def.nodes);
      if (refusal) throw refusal;

      const { target, predecessors, rest } = partitionForDebug(def, fromNodeId, mode);
      const pins = new Map(
        (await listDebugPins(tenantOf(req), workflowId)).map((p) => [p.nodeId, p.output] as const),
      );
      const missing = [...predecessors].filter((id) => !pins.has(id)).sort();
      if (missing.length > 0) {
        throw new OpenwopError(
          'validation_error',
          `Pin the output of ${missing.length} upstream node(s) first: ${missing.join(', ')}.`,
          422,
          { reason: 'missing_pins', missingPins: missing },
        );
      }

      // Execute the PRUNED subgraph (predecessors + target): REST nodes are
      // excluded from the executed definition rather than snapshot-marked
      // 'skipped' — the scheduler's completion rule ("a terminal-by-graph
      // node must complete") then holds naturally on the subgraph's own
      // terminals (in 'only' mode the target IS the terminal). The ADR 0474
      // revision pin still stamps from the FULL head — the content the user
      // is debugging — via the insert seam below.
      const inSubgraph = new Set([...target, ...predecessors]);
      const debugDef: WorkflowDefinition = {
        ...def,
        nodes: def.nodes.filter((n) => inSubgraph.has(n.nodeId)),
        edges: (def.edges ?? []).filter((e) => inSubgraph.has(e.sourceNodeId) && inSubgraph.has(e.targetNodeId)),
      };

      const inputs = body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs)
        ? (body.inputs as Record<string, unknown>)
        : {};
      const run = buildRunRecord({
        workflowId,
        tenantId: tenantOf(req),
        inputs,
        metadata: { launch: 'draft' },
        actingUserId: req.userId ?? req.principal?.principalId,
        ...(personalTenantOf(req) ? { personalTenant: personalTenantOf(req) } : {}),
      });
      // Host-authoritative honesty stamps (post-strip, pre-insert — the
      // review-H1 lesson): a debug run always executes the HEAD (you debug the
      // edit), and `debug` is RESERVED (grade-code M5) so only this route can
      // mark a run as a debug run.
      run.metadata.launchResolved = 'head';
      run.metadata.debug = { fromNodeId, mode, pinnedNodes: [...predecessors].sort() };
      await insertRunWithStartContext(deps.storage, run, { definition: def });
      seedRunVariables(run.runId, def.variables, deferredConfigurableInputs(def, run.configurable, inputs));

      // Self-describing synthetic prefix (the fork-copied-prefix semantics):
      // the event log itself records what the pins asserted, so folding THIS
      // run's prefix reproduces the checkpoint (replay/fork honesty).
      await getEventLog().append({ runId: run.runId, type: 'run.started', payload: { workflowId } });
      for (const nodeId of [...predecessors].sort()) {
        await getEventLog().append({
          runId: run.runId,
          type: 'node.completed',
          nodeId,
          payload: { outputs: pins.get(nodeId)!, pinned: true },
        });
      }

      const snapshot: SerializedSnapshot = {
        schemaVersion: 1,
        nodeState: [...predecessors].map((id) => [id, 'completed'] as [string, string]),
        nodeOutputs: [...predecessors].map((id) => [id, pins.get(id)!] as [string, Record<string, unknown>]),
        nodeErrors: [],
      };

      reserveConcurrentSlot(req, run.runId);
      deps.hostSuite.auditSink.record({
        principalId: req.principal?.principalId ?? 'anonymous',
        action: 'run.create',
        resource: `run:${run.runId}`,
        outcome: 'success',
        payload: { workflowId, tenantId: run.tenantId, debug: true },
      });
      res.status(201).json({
        runId: run.runId,
        pinnedNodes: [...predecessors].sort(),
        skipped: [...rest].sort(),
        executing: [...target].sort(),
      });
      setImmediate(() => {
        // NO `resumeNodeId`: that option is the INTERRUPT-resume path (it
        // marks the named node completed instead of executing it). Snapshot-
        // only is the fork-checkpoint path — readiness is re-derived from
        // every settled node, so the target actually runs.
        executeRun(deps.storage, run, debugDef, {
          policyResolver: deps.hostSuite.providerPolicyResolver,
          resumeSnapshot: snapshot,
        }).catch(async (err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.error('debug-run dispatch failed', { runId: run.runId, error: message });
          await failRunClosedOnDispatchError(deps.storage, run.runId, message);
        });
      });
    } catch (err) { next(err); }
  });

  // Bulk redrive — a NEW RUN ROW from stored inputs + the AS-RUN revision
  // (`resolveRunDefinition` pin-first), modeled on the fork-branch path:
  // idempotencyKey cleared, causationId never copied, actingUserId RE-stamped
  // (the confused-deputy guard). Partial success is explicit, never silent.
  // "Fresh" means fresh IDENTITY, not fresh configuration: execution parameters
  // (inputs, configurable, the revision pin, and the ADR 0099 frozen compaction
  // decision) are INHERITED — see `derivedFromRun` below (ADR 0604 review H1).
  app.post('/v1/host/openwop-app/runs/redrive', runQuotaMiddleware(), async (req, res, next) => {
    try {
      const runIds = (req.body as { runIds?: unknown } | undefined)?.runIds;
      if (
        !Array.isArray(runIds) || runIds.length === 0 || runIds.length > REDRIVE_MAX
        || !runIds.every((r): r is string => typeof r === 'string' && r.length > 0)
      ) {
        throw new OpenwopError('validation_error', `runIds must be 1-${REDRIVE_MAX} run ids.`, 400, {});
      }
      const results: Array<{ runId: string; redriveRunId?: string; error?: string }> = [];
      for (const sourceRunId of runIds) {
        try {
          const source = await loadOwnedRun(req, deps.storage, sourceRunId, 'runs:create');
          if (source.status !== 'failed' && source.status !== 'cancelled') {
            results.push({ runId: sourceRunId, error: 'not_redrivable' });
            continue;
          }
          const resolved = await resolveRunDefinition(source, deps.hostSuite.workflowCatalog);
          if (!resolved) {
            results.push({ runId: sourceRunId, error: 'workflow_not_found' });
            continue;
          }
          // buildRunRecord strips the reserved pin keys from the copied
          // metadata; the insert seam re-stamps `definitionRevision` from the
          // RESOLVED definition (pin-first ⇒ the redrive pins the AS-RUN hash).
          // Review M1/M2 — a redrive is a FRESH FULL run acting as the CALLER:
          // never inherit the source's debug/draft provenance (`debug`,
          // `launch` — the redrive executes the full definition with no pins),
          // its ADR 0371 retention pin, or its `actingUserId` (the conditional
          // merge below would keep a stale identity when the caller has none —
          // the fork path overwrites unconditionally for the same reason).
          //
          // ADR 0604 (review H1) — THE OTHER HALF OF THIS SENTENCE. The line
          // above draws a line between CALLER PROVENANCE (stripped: `debug`,
          // `launch`, `pinned`, `actingUserId`, plus the reserved keys
          // `buildRunRecord` removes) and EXECUTION PARAMETERS (copied
          // verbatim: `inputs`, `configurable`, and the source's revision pin,
          // which `resolveRunDefinition(source, …)` below resolves FROM). It
          // never said which side `run.metadata.compaction` — the ADR 0099
          // per-run frozen decision — falls on, and the answer was NEITHER: the
          // key is not reserved, so a PRESENT decision was inherited, while an
          // ABSENT one was re-resolved against the CURRENT toggle by the insert
          // seam. Proved by execution: a born-OFF source redriven while the
          // toggle is on came back `{"mode":"lossless"}` — a decision the run it
          // re-drives was never created under.
          //
          // It is an EXECUTION PARAMETER, so it is inherited, and
          // `derivedFromRun: true` on the insert below is what makes that true
          // in BOTH directions (see `RunStartContext.derivedFromRun`): a redrive
          // re-executes the SAME definition with the SAME inputs and the SAME
          // configurable, and changing what the model sees mid-way would make
          // the redrive incomparable to the failure it exists to reproduce. It
          // is also the conservative branch — the alternative (strip
          // `compaction` and re-resolve) would GRANT compaction to the redrive
          // of a run born without it, which is the acquisition defect ADR 0604
          // closed on `:fork`.
          const copiedMeta = { ...((source.metadata as Record<string, unknown> | undefined) ?? {}) };
          for (const k of ['debug', 'launch', 'pinned', 'actingUserId']) delete copiedMeta[k];
          const run = buildRunRecord({
            workflowId: source.workflowId,
            tenantId: source.tenantId,
            scopeId: source.scopeId,
            inputs: source.inputs,
            configurable: source.configurable,
            metadata: copiedMeta,
            actingUserId: req.userId ?? req.principal?.principalId,
            // ADR 0627 D3 (review S1) — like `actingUserId`, the personal tenant is
            // the REDRIVING caller's (stamped from `req`, never copied from the
            // source row: a copied value would lend the redriver the source
            // owner's implicit-owner authority).
            ...(personalTenantOf(req) ? { personalTenant: personalTenantOf(req) } : {}),
          });
          run.metadata.definitionResolvedFrom = resolved.resolvedFrom; // honesty stamp (the fork precedent)
          // RESERVED post-strip stamp (grade-code M5) — `eval` is stripped from
          // copiedMeta by buildRunRecord too (grade-code L7: a redriven eval
          // case is a fresh production run, not an eval-set member).
          run.metadata.redriveOf = sourceRunId;
          // ADR 0604 review M6 + H1 — `compaction` became RESERVED in the same
          // batch, so `buildRunRecord` now strips it out of `copiedMeta` too.
          // Re-stamp it here, post-strip, from the STORED SOURCE ROW: the
          // redrive INHERITS the source's frozen decision (see `derivedFromRun`
          // below), and taking it from the row rather than the request is
          // exactly what makes inheritance and forgeability separable. Without
          // this line the two fixes cancel: a born-ON run would be redriven
          // UNCOMPACTED, which is the same class of silent divergence H1
          // closed, arriving from the other direction.
          const inheritedCompaction = (source.metadata as Record<string, unknown> | undefined)?.compaction;
          if (inheritedCompaction !== undefined) run.metadata.compaction = inheritedCompaction;
          // ADR 0551 P1 — `enqueueDispatch`: a redrive resolves its definition
          // from the catalog/pinned revision, so the durable worker can too.
          // (The debug-run lane above deliberately does NOT enqueue — it
          // executes an ad-hoc `debugDef` the worker could never re-resolve.)
          // `derivedFromRun` — ADR 0604 review H1; see the copy above. This is
          // the SECOND of exactly two run-creation sites in the host that copy
          // another run's metadata (`routes/runs.ts` `:fork` is the first), and
          // `test/run-metadata-copy-sites.test.ts` is the ratchet over that
          // population.
          await insertRunWithStartContext(deps.storage, run, { definition: resolved.definition, enqueueDispatch: true, derivedFromRun: true });
          seedRunVariables(
            run.runId,
            resolved.definition.variables,
            deferredConfigurableInputs(resolved.definition, run.configurable, run.inputs),
          );
          reserveConcurrentSlot(req, run.runId);
          deps.hostSuite.auditSink.record({
            principalId: req.principal?.principalId ?? 'anonymous',
            action: 'run.create',
            resource: `run:${run.runId}`,
            outcome: 'success',
            payload: { workflowId: source.workflowId, tenantId: source.tenantId, redriveOf: sourceRunId },
          });
          dispatchRunInBackground({ storage: deps.storage, run, definition: resolved.definition, hostSuite: deps.hostSuite });
          results.push({ runId: sourceRunId, redriveRunId: run.runId });
        } catch (err) {
          results.push({
            runId: sourceRunId,
            error: err instanceof OpenwopError ? err.code : 'internal_error',
          });
        }
      }
      // Review H3 — charge the run quota PER MINTED RUN (the middleware's
      // finish hook reads this; default 1). A 25-run redrive costs 25 units.
      res.locals.runQuotaUnits = Math.max(1, results.filter((r) => r.redriveRunId).length);
      res.json({ results });
    } catch (err) { next(err); }
  });
}
