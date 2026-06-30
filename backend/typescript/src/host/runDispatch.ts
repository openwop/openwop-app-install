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
import type { RunRecord } from '../types.js';
import type { WorkflowDefinition } from '../executor/types.js';
import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from './index.js';
import { executeRun } from '../executor/executor.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('run-dispatch');

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
    metadata: { ...(params.metadata ?? {}), ...(params.actingUserId ? { actingUserId: params.actingUserId } : {}) },
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
 * single-instance reference runnable. Failures are logged, never thrown.
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
    }).catch((err) => {
      log.error('inline dispatch failed', { runId: opts.run.runId, error: err instanceof Error ? err.message : String(err) });
    });
  });
}
