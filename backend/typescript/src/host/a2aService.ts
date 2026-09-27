/**
 * ADR 0552 P0/P2 — the version-NEUTRAL A2A semantic service.
 *
 * ADR 0552's decision 1 is "introduce an internal version-neutral `A2AService`
 * for card discovery, message submission, task read/resubscribe and push
 * configuration", and its boundaries table puts wire encoding in "version codecs
 * at the route boundary". This module is the semantic half: it knows about runs,
 * durable task records, tenants and principals, and it knows NOTHING about
 * JSON-RPC method names, `kind` discriminators or `TASK_STATE_*` spellings. The
 * 1.0 codec (`a2aServer10.ts`) and the 0.3 codec (`a2aServer.ts`) both call it.
 *
 * Two rules from `a2a-integration.md` §E are enforced HERE rather than in a
 * codec, because a rule that lives in one codec is a rule the other one does
 * not have:
 *
 *   1. **`tenant` is a hint, never a selector.** The tenant of record comes
 *      from the authenticated principal's binding. A disagreeing hint is
 *      neutralized to the binding and audited content-free — never honoured,
 *      and never answered in a way that reveals whether the requested tenant
 *      exists.
 *   2. **No enumeration.** A task in another tenant is indistinguishable from
 *      one that does not exist (`getA2aTaskFor` returns null for both), so
 *      `GetTask` / `CancelTask` / `SubscribeToTask` cannot be used to probe ids.
 *
 * @see spec/v1/a2a-integration.md §"A2A 1.0 versioned composition" §D.1, §D.2, §E
 */

import { createLogger } from '../observability/logger.js';
import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from './index.js';
import { startWorkflowRun } from './runStarter.js';
import { cancelRunAndCascade, isTerminalRunStatus } from './runCancel.js';
import { a2aInvocableWorkflowId } from './a2aCard.js';
import {
  getA2aTaskFor,
  getA2aMessageClaim,
  setA2aMessageClaim,
  upsertA2aTask,
  projectRunStatusToTaskState,
  isTerminalTaskState,
  type A2aTaskRecord,
} from './a2aTaskStore.js';
import type { A2a10ErrorName } from './a2aCodec10.js';

const log = createLogger('host.a2aService');

/** The tenant/principal binding an A2A operation is authorized against (§E). */
export interface A2aPrincipal {
  /** The tenant of record, from the authenticated principal — never a hint. */
  tenantId: string;
  /** A stable id for the remote peer principal (auth subject, or the api key's tenant). */
  principalId: string;
  /** The protocol version this request arrived under (a recorded fact). */
  protocolVersion: string;
}

/** The host services an A2A operation needs to touch real runs. */
export interface A2aServiceDeps {
  storage: Storage;
  hostSuite: Pick<HostAdapterSuite, 'workflowCatalog' | 'providerPolicyResolver'>;
}

/** A failure named in the upstream 1.0 catalogue (§D.7); codecs spell it. */
export interface A2aServiceFailure {
  error: A2a10ErrorName;
  message: string;
}

export type A2aServiceResult<T> = { ok: true; value: T } | { ok: false } & A2aServiceFailure;

function fail(error: A2a10ErrorName, message: string): A2aServiceResult<never> {
  return { ok: false, error, message };
}

/**
 * §E — resolve the tenant of record, neutralizing a disagreeing `tenant` hint.
 *
 * Returns the BINDING, always. The hint is only ever compared, never selected
 * on, and the audit line carries the outcome and nothing else: saying "tenant X
 * does not exist" and "tenant X is not yours" differently is the disclosure
 * RFC 0132 §A.2 forbids, applied here to A2A.
 */
export function resolveTenantOfRecord(principal: A2aPrincipal, hint: unknown): string {
  if (typeof hint === 'string' && hint.trim() !== '' && hint.trim() !== principal.tenantId) {
    log.warn('a2a_tenant_hint_neutralized', { protocolVersion: principal.protocolVersion });
  }
  return principal.tenantId;
}

/**
 * §D.1 `SendMessage` (no `taskId`) — start a run and open its durable Task.
 *
 * `Task.id` IS the `runId` (RFC 0100), which is why the record is written after
 * the run exists rather than with a synthesized id: a task id that is not a run
 * id makes `GET /v1/runs/{Task.id}` a 404 for the peer that just created it.
 *
 * IDEMPOTENCY (§D.2 / RFC 0150 §A): `(tenant, principal, messageId)` is claimed
 * before the run is started and re-read on a repeat, so a retried `SendMessage`
 * returns the FIRST task instead of minting a second run. The claim is written
 * after the run exists — a claim pointing at a run that failed to start would
 * make the retry permanently unfulfillable.
 */
export async function submitMessageTask(
  deps: A2aServiceDeps,
  principal: A2aPrincipal,
  input: { messageId: string; text: string; contextId?: string; tenantHint?: unknown },
): Promise<A2aServiceResult<A2aTaskRecord>> {
  const tenantId = resolveTenantOfRecord(principal, input.tenantHint);

  const claimed = await getA2aMessageClaim(tenantId, principal.principalId, input.messageId);
  if (claimed) {
    const existing = await getA2aTaskFor(claimed, tenantId, 'strict');
    if (existing) return { ok: true, value: await refreshTaskFromRun(deps, existing) };
    // The claim outlived its task (retention swept the record). Fall through and
    // open a new one rather than answering not-found for a message the caller
    // is legitimately retrying.
  }

  const workflowId = a2aInvocableWorkflowId();
  let runId: string | null;
  try {
    runId = await startWorkflowRun(deps, {
      tenantId,
      workflowId,
      inputs: { message: input.text },
      metadata: {
        a2a: {
          messageId: input.messageId,
          protocolVersion: principal.protocolVersion,
          ...(input.contextId ? { contextId: input.contextId } : {}),
        },
      },
    });
  } catch (err) {
    // startWorkflowRun throws a typed refusal for an exhausted workflow budget.
    return fail('UNSUPPORTED_OPERATION', err instanceof Error ? err.message : 'run could not be started');
  }
  if (!runId) {
    return fail('UNSUPPORTED_OPERATION', `no invocable workflow resolved for skill ${workflowId}`);
  }

  const run = await deps.storage.getRun(runId);
  const projected = projectRunStatusToTaskState(run?.status ?? 'pending', run ? await openCredentialInterrupt(deps, run) : undefined);
  const rec = await upsertA2aTask({
    taskId: runId,
    runId,
    tenantId,
    principalId: principal.principalId,
    protocolVersion: principal.protocolVersion,
    ...(input.contextId ? { contextId: input.contextId } : {}),
    state: projected.state,
    ...(projected.interruptKind ? { interruptKind: projected.interruptKind } : {}),
    ...(projected.statusMessage ? { statusMessage: projected.statusMessage } : {}),
  });
  await setA2aMessageClaim(tenantId, principal.principalId, input.messageId, runId);
  return { ok: true, value: rec };
}

/**
 * Re-project the durable record from the LIVE run status (§D.4 `status.state` ←
 * `run.status`).
 *
 * Without this, `GetTask` answers whatever the record was stamped with at the
 * last transition the A2A path happened to observe — which is correct only
 * while the run is not advancing, i.e. exactly when nobody is asking. Records
 * with no resolvable run (the 0.3-era `a2a:<agentId>` ids) are returned as
 * stored; the projection has nothing to read.
 */
export async function refreshTaskFromRun(deps: A2aServiceDeps, rec: A2aTaskRecord): Promise<A2aTaskRecord> {
  const run = await deps.storage.getRun(rec.runId);
  if (!run) return rec;
  const projected = projectRunStatusToTaskState(run.status, await openCredentialInterrupt(deps, run));
  if (projected.state === rec.state && (projected.interruptKind ?? undefined) === rec.interruptKind && projected.statusMessage === rec.statusMessage) return rec;
  return upsertA2aTask({
    ...rec,
    state: projected.state,
    ...(projected.interruptKind ? { interruptKind: projected.interruptKind } : { interruptKind: undefined }),
    ...(projected.statusMessage ? { statusMessage: projected.statusMessage } : { statusMessage: undefined }),
  });
}

/** RFC 0199 §D.1 — the open `credential` interrupt that turns `waiting-input`
 *  into `auth-required`. Read only for a `waiting-input` run (one point lookup). */
async function openCredentialInterrupt(deps: A2aServiceDeps, run: { runId: string; status: string }): Promise<{ kind: string; data: unknown } | undefined> {
  if (run.status !== 'waiting-input') return undefined;
  return (await deps.storage.listOpenInterrupts(run.runId)).find((i) => i.kind === 'credential');
}

/**
 * §D.1 `GetTask` — the durable Task the caller may read, refreshed from the run.
 * Null means "not found" AND "not yours", inseparably (§E, no enumeration).
 */
export async function readTask(
  deps: A2aServiceDeps,
  principal: A2aPrincipal,
  taskId: string,
  mode: 'strict' | 'legacy',
): Promise<A2aTaskRecord | null> {
  const rec = await getA2aTaskFor(taskId, principal.tenantId, mode);
  if (!rec) return null;
  return refreshTaskFromRun(deps, rec);
}

/**
 * §D.1 `CancelTask` — `POST /v1/runs/{runId}/cancel` under the peer's binding.
 *
 * A terminal run is `TaskNotCancelableError` (§D.7), NOT a silent success: the
 * REST route answers a terminal cancel with `200 {status}` because a human
 * clicking cancel twice means "make sure it is stopped", while a peer's
 * `CancelTask` on a finished task is a contract violation upstream gives a code
 * for.
 */
export async function cancelTask(
  deps: A2aServiceDeps,
  principal: A2aPrincipal,
  taskId: string,
  mode: 'strict' | 'legacy',
): Promise<A2aServiceResult<A2aTaskRecord>> {
  const rec = await getA2aTaskFor(taskId, principal.tenantId, mode);
  if (!rec) return fail('TASK_NOT_FOUND', `task not found: ${taskId}`);
  const run = await deps.storage.getRun(rec.runId);
  if (!run || run.tenantId !== principal.tenantId) {
    // A record whose backing run is gone or foreign is not cancelable, and
    // saying which would separate the two cases for a prober.
    if (isTerminalTaskState(rec.state)) return fail('TASK_NOT_CANCELABLE', 'task is in a terminal state');
    return fail('TASK_NOT_FOUND', `task not found: ${taskId}`);
  }
  if (isTerminalRunStatus(run.status)) return fail('TASK_NOT_CANCELABLE', 'task is in a terminal state');
  await cancelRunAndCascade(deps.storage, run, 'cancelled by A2A peer');
  return { ok: true, value: await upsertA2aTask({ ...rec, state: 'canceled' }) };
}
