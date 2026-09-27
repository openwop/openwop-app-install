/**
 * Shared run construction + background dispatch — the core seam every run
 * creator uses, so the `RunRecord` shape and the inline-dispatch policy live in
 * ONE place instead of being re-hand-rolled per route. Used by `POST /v1/runs`
 * (`routes/runs.ts`) and the AI workflow-author `draft` route (ADR 0072); any
 * future run creator should compose these too.
 *
 * Split in two so a caller keeps its own ordering of the HTTP concerns that sit
 * BETWEEN record creation and dispatch (idempotency caching, rate-limit slot
 * reservation, audit, the 201 response):
 *   - `buildRunRecord(...)` — the pure `RunRecord` constructor.
 *   - `dispatchRunInBackground(...)` — the `setImmediate(executeRun)` tail.
 */

import { randomUUID } from 'node:crypto';
import type { RunOwnerStamp } from './runOwner.js';
import type { RunRecord } from '../types.js';
import type { WorkflowDefinition } from '../executor/types.js';
import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from './index.js';
import { executeRun, emitTerminalFailure } from '../executor/executor.js';
import { getEventLog } from '../executor/eventLog.js';
import { createLogger } from '../observability/logger.js';
import { unwindOnDispatchTerminal } from './compensationRuntime.js';

const log = createLogger('run-dispatch');


/** ADR 0474/0476/0477 — metadata keys only the host may write at run creation.
 *  `costUsd`/`costTokens` are the ADR 0476 terminal cost stamps: a client
 *  inventing spend at create time would poison fleet stats forever (the
 *  terminal stamp never overwrites). `debug`/`eval`/`redriveOf` are PROVENANCE
 *  stamps (grade-code M5): they gate fleet-stats segmentation, the promote
 *  gate, and the diagnose tool's framing — a client forging them could hide a
 *  run from stats or fake a redrive lineage. The debug/eval/redrive routes
 *  stamp them HOST-SIDE post-strip (the `launchResolved` pattern).
 *
 *  ADR 0604 (review M6) — `compaction` joins them. It is the ADR 0099 per-run
 *  frozen decision, resolved ONCE at creation by a run-start contributor that
 *  reads the tenant toggle. Proved by a three-hop trace, not by reading:
 *  `POST /v1/runs {"metadata":{"compaction":{"mode":"lossy","head":0,"tail":0}}}`
 *  reached `runStartContext`'s no-overwrite merge and froze a LOSSY decision
 *  with the tenant toggle OFF — i.e. "a client could pin a decision the host
 *  never made", the exact rationale written three lines above this constant.
 *  Pre-existing, but ADR 0604 doubles its weight: `lossy` is now the only mode
 *  with any effect, and it has no SPA editor, so the ONLY way to reach it was
 *  to bypass the operator. FALSIFIED FIRST: `compaction` has exactly one writer
 *  in `src/**` (`features/tool-output-compaction/decision.ts`) and no
 *  legitimate caller supplies it through `metadata`.
 *
 *  The redrive route re-stamps it post-strip from the STORED SOURCE ROW (never
 *  from the request), which is how a metadata-copying creator keeps inheriting
 *  a decision it must not let a client forge. */
// `personalTenant` (ADR 0627 D3 / review S2) is reserved because it GRANTS: a
// req-less tenant gate treats `personalTenant === tenantId` (personal-shaped)
// as implicit ownership, so a client-supplied value must never survive into the
// run row — it is stamped from `req.personalTenant` below, or not at all.
// `owner` (RFC 0165 §B, ADR 0625) is reserved for the same reason.
// `traceContext` (RFC 0207) is reserved for the SHAPE reason, not a grant one:
// it is the W3C trace context the run was CREATED under, read verbatim by the
// outbound MCP/A2A carriers (`host/traceContext.ts`). It is correlation and
// never authority, so a forged value grants nothing — but it would silently
// re-parent this host's cross-host calls onto a trace the caller chose while
// the observability stack reported it as the one the request arrived on. It is
// stamped host-side from the request's own `traceparent` header, or not at all.
const RESERVED_RUN_METADATA_KEYS = ['definitionRevision', 'definitionResolvedFrom', 'launchResolved', 'costUsd', 'costTokens', 'costByNode', 'debug', 'eval', 'redriveOf', 'onlineEvalScored', 'compaction', 'personalTenant', 'owner', 'traceContext'] as const;
export function stripReservedRunMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const out = { ...metadata };
  for (const k of RESERVED_RUN_METADATA_KEYS) delete out[k];
  return out;
}

export interface BuildRunRecordParams {
  workflowId: string;
  tenantId: string;
  inputs?: unknown;
  scopeId?: string;
  configurable?: Record<string, unknown>;
  /** Client-supplied metadata; `actingUserId` is merged in host-authoritatively. */
  metadata?: Record<string, unknown>;
  /** The authenticated human (ADR 0024 §4) — stamped onto `metadata.actingUserId`. */
  actingUserId?: string;
  /** The caller's OWN personal tenant (`req.personalTenant`, ADR 0015) — stamped
   *  onto `metadata.personalTenant` (ADR 0627 D3 / review S2) so the tool lane
   *  can apply the HTTP lane's implicit-owner rule without a request. */
  personalTenant?: string;
  /** RFC 0165 §B (ADR 0625) — the run's owner + Subject, minted by
   *  `host/runOwner.ts` from the caller; stamped onto the RESERVED
   *  `metadata.owner` key (a client value is stripped first). */
  owner?: RunOwnerStamp;
  callbackUrl?: string;
  idempotencyKey?: string;
  /** Pre-generated id (so the caller can build a response before dispatch); else minted. */
  runId?: string;
  /** Pre-stamped timestamp (else now). */
  now?: string;
}

/** Construct a `pending` RunRecord. Pure — does not touch storage. */
export function buildRunRecord(params: BuildRunRecordParams): RunRecord {
  const runId = params.runId ?? randomUUID();
  const now = params.now ?? new Date().toISOString();
  return {
    runId,
    workflowId: params.workflowId,
    tenantId: params.tenantId,
    scopeId: params.scopeId,
    status: 'pending',
    inputs: params.inputs ?? null,
    // ADR 0474 (review M1) — the revision pin keys are HOST-authoritative:
    // a client-supplied `definitionRevision` would be preserved by the insert
    // seam's never-overwrite rule and could pin a run to a definition it never
    // executed (poisoning resume/fork). Strip them before the authoritative
    // stamps land (the `actingUserId` discipline).
    metadata: {
      ...stripReservedRunMetadata(params.metadata),
      ...(params.actingUserId ? { actingUserId: params.actingUserId } : {}),
      ...(params.personalTenant ? { personalTenant: params.personalTenant } : {}),
      ...(params.owner ? { owner: params.owner } : {}),
    },
    configurable: params.configurable ?? {},
    callbackUrl: params.callbackUrl,
    idempotencyKey: params.idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Dispatch a run on the next tick (so the HTTP response returns first). Real
 * impls hand off to Cloud Tasks / Pub/Sub / SQS; `setImmediate` keeps the
 * single-instance reference runnable. Failures are logged AND fail the run
 * closed (never thrown).
 *
 * FAIL-CLOSED (board-chat "Timed out waiting for the conversation to start"
 * incident, 2026-07-09): a throw here used to be log-only, leaving the run
 * `pending` FOREVER — the chat FE then burned its full gate-open budget and
 * surfaced a blind timeout instead of the real cause. Now a dispatch failure
 * marks the run `failed` (only when the executor didn't already reach a
 * terminal state itself) and appends a `run.failed` event carrying the error,
 * so pollers fail fast with a named reason.
 */
export function dispatchRunInBackground(opts: {
  storage: Storage;
  run: RunRecord;
  definition: WorkflowDefinition;
  hostSuite: HostAdapterSuite;
}): void {
  setImmediate(() => {
    executeRun(opts.storage, opts.run, opts.definition, {
      policyResolver: opts.hostSuite.providerPolicyResolver,
    }).catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error('inline dispatch failed', { runId: opts.run.runId, error: message });
      await failRunClosedOnDispatchError(opts.storage, opts.run.runId, message);
    });
  });
}

/** Mark a run whose background dispatch threw as `failed` (with a `run.failed`
 *  event carrying the cause) — ONLY when the executor didn't already reach a
 *  terminal state itself. Best-effort: a marking failure is logged, never
 *  thrown (the dispatch path must stay non-throwing). Exported for tests. */
export async function failRunClosedOnDispatchError(storage: Storage, runId: string, message: string): Promise<void> {
  try {
    const current = await storage.getRun(runId);
    if (current && !['completed', 'failed', 'cancelled'].includes(current.status)) {
      // The STATUS is not the only record of terminality — the event LOG is the
      // durable one, and `finalizeRun` appends the terminal event BEFORE it writes
      // the status. A throw between the two (MEASURED in production 2026-09-21:
      // run 2c4095e7 appended `run.completed` at +1.27 s, then its status write
      // hit `timeout exceeded when trying to connect`) left the row `running`,
      // and this path then appended `node.failed` + `run.dead_lettered` +
      // `run.failed` BEHIND `run.completed` and flipped a completed run to
      // `failed`. When the log is already closed, repair the row to match it
      // instead: never a second terminal. (Left `running`, the row would also be
      // re-executable by the ADR 0740 claim once its lease lapsed.)
      const logged = await terminalStatusFromLog(runId);
      if (logged) {
        log.error('dispatch failed after the run reached terminal — repairing status from the event log', { runId, logged, error: message });
        await storage.updateRun(runId, { status: logged, completedAt: new Date().toISOString() });
        return;
      }
      // Grade-data G6 — reuse the executor's canonical terminal-failure
      // sequence (node.failed then run.failed, one owner) instead of a
      // hand-emitted run.failed: node-graph consumers keying on node
      // terminals see a consistent shape either way.
      // RFC 0151 §B — same reason as the sweeper's path: usually a no-op (the
      // run never executed, so nothing is minted), but a resumed run with
      // committed effects would otherwise strand its plan.
      await unwindOnDispatchTerminal(storage, runId, 'dispatch-failed');
      await emitTerminalFailure({
        storage, runId, nodeId: '_dispatch',
        error: { code: 'dispatch_failed', message },
      });
    }
  } catch (markErr) {
    log.error('inline dispatch fail-closed marking failed', { runId, error: markErr instanceof Error ? markErr.message : String(markErr) });
  }
}

const TERMINAL_EVENT_STATUS: Readonly<Record<string, 'completed' | 'failed' | 'cancelled'>> = {
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled',
};

/** The status a run's durable log already closed it with, or null. Reads only
 *  the tail: a terminal event is appended last, and this is a failure path. */
async function terminalStatusFromLog(runId: string): Promise<'completed' | 'failed' | 'cancelled' | null> {
  const eventLog = getEventLog();
  const max = await eventLog.getMaxSequence(runId);
  const tail = await eventLog.list(runId, { fromSeq: Math.max(-1, max - 50), limit: 51 });
  for (let i = tail.length - 1; i >= 0; i--) {
    const status = TERMINAL_EVENT_STATUS[tail[i]!.type];
    if (status) return status;
  }
  return null;
}
