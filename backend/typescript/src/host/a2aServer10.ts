/**
 * ADR 0552 P2 — the A2A **1.0** codec at the route boundary.
 *
 * The sibling of `a2aServer.ts` (the `a2a-0.3-legacy` codec), not its
 * replacement: ADR 0552's boundaries table puts "wire encoding" in "version
 * codecs at the route boundary" and keeps ONE semantic service and ONE durable
 * task record underneath. Everything with real consequences — starting runs,
 * authorizing reads, cancelling, the tenant binding — lives in `a2aService.ts`;
 * this file is JSON-RPC method names, `TASK_STATE_*` spelling and the §D.7
 * error catalogue.
 *
 * WHY A SEPARATE FILE rather than a branch inside the 0.3 handler: 1.0 renamed
 * every operation and removed both discriminators the 0.3 handler leans on, so
 * a shared switch would be two disjoint switches sharing a brace. Keeping them
 * apart is also what lets the 0.3 codec stay byte-identical in behaviour, which
 * is ADR 0552 P0's standing gate ("existing v0.3 tests pass unchanged").
 *
 * @see spec/v1/a2a-integration.md §"A2A 1.0 versioned composition" §D
 */

import { createLogger } from '../observability/logger.js';
import {
  A2A_10_ERROR,
  A2A_10_METHODS,
  errorData10,
  message10,
  messageText10,
  projectTaskRecordToA2aTask10,
  type A2a10ErrorName,
} from './a2aCodec10.js';
import { a2aCardCapabilities } from './a2aCard.js';
import {
  cancelTask,
  readTask,
  refreshTaskFromRun,
  resolveTenantOfRecord,
  submitMessageTask,
  type A2aPrincipal,
  type A2aServiceDeps,
} from './a2aService.js';
import {
  listA2aTasksForTenant,
  setA2aTaskPushConfig,
  A2aPushUrlDeniedError,
  type A2aTaskRecord,
} from './a2aTaskStore.js';
import type { A2aJsonRpcRequest, A2aJsonRpcResponse } from './a2aServer.js';

const log = createLogger('host.a2aServer10');

/** Everything the 1.0 codec needs that is not the request itself. */
export interface A2aServer10Options {
  /** The 1.0 Agent Card, for `GetExtendedAgentCard`'s refusal message context. */
  agentCard: unknown;
  /** The §E binding this request is authorized under. */
  principal: A2aPrincipal;
  /** Real runs. Absent ⇒ the host cannot serve 1.0 at all (see below). */
  deps: A2aServiceDeps | null;
}

function ok(id: string | number, result: unknown): A2aJsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/**
 * A 1.0 JSON-RPC error. `data` is the A2A 1.0.1 §9.5 `Any[]` carrying one
 * `google.rpc.ErrorInfo` with the closed upstream `reason` and nothing else —
 * the same discipline §D.7 puts on the client direction, applied to what this
 * host emits: "Error `message` text in either direction MUST NOT carry stack
 * traces, provider bodies, credentials, or the other side's raw error body."
 *
 * ADR 0744: the bare `{ reason }` object this used to emit is not the upstream
 * shape. No `metadata` rides a `TASK_NOT_FOUND`, so an unknown task and a
 * foreign-tenant task answer identically apart from the id the caller sent.
 */
function err10(id: string | number, name: A2a10ErrorName, message: string): A2aJsonRpcResponse {
  const { code, reason } = A2A_10_ERROR[name];
  return { jsonrpc: '2.0', id, error: { code, message, data: errorData10(reason) } };
}

/** The 0.3 method names, refused loudly under a 1.0 header (a client bug). */
const LEGACY_METHOD_NAMES = new Set([
  'message/send',
  'message/stream',
  'tasks/get',
  'tasks/cancel',
  'tasks/resubscribe',
  'tasks/list',
  'agent/getCard',
  'agent/getAuthenticatedExtendedCard',
  'tasks/pushNotificationConfig/set',
]);

function taskIdOf(params: Record<string, unknown> | undefined): string | undefined {
  return typeof params?.id === 'string' ? params.id : undefined;
}

/**
 * Render one durable record as a 1.0 `Task`, carrying the peer's own message
 * back in `history[]`.
 *
 * `history[]` holds A2A `Message`s and NOTHING else — §D.4: "MUST NOT contain
 * run-internal LLM transcripts, tool I/O, or `agent.*` reasoning events". The
 * only entry this host puts there is the message the peer itself sent, echoed
 * under `ROLE_USER`, which discloses nothing the peer did not already have.
 */
function renderTask(rec: A2aTaskRecord, echo?: { messageId: string; text: string }): Record<string, unknown> {
  return projectTaskRecordToA2aTask10(rec, {
    history: echo
      ? [
          message10({
            messageId: echo.messageId,
            role: 'ROLE_USER',
            text: echo.text,
            taskId: rec.taskId,
            ...(rec.contextId ? { contextId: rec.contextId } : {}),
          }),
        ]
      : [],
  });
}

/**
 * Handle one A2A **1.0** JSON-RPC request (§D.1 operations).
 *
 * Every durable-task operation needs `deps`: at 1.0 a Task IS a run (RFC 0100),
 * so a host with no storage wired cannot honestly answer any of them. It
 * answers `UnsupportedOperationError` rather than inventing an in-memory task
 * that `GET /v1/runs/{id}` would 404 on.
 */
export async function handleA2aRequest10(
  req: A2aJsonRpcRequest,
  opts: A2aServer10Options,
): Promise<A2aJsonRpcResponse> {
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return { jsonrpc: '2.0', id: req?.id ?? 0, error: { code: -32600, message: 'invalid request' } };
  }
  if (LEGACY_METHOD_NAMES.has(req.method)) {
    return {
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: `method not found under A2A 1.0: ${req.method} (0.3 name)` },
    };
  }
  const { principal, deps } = opts;
  const params = req.params;
  const caps = a2aCardCapabilities();

  switch (req.method) {
    case A2A_10_METHODS.sendMessage: {
      if (!deps) return err10(req.id, 'UNSUPPORTED_OPERATION', 'durable tasks are not wired on this host');
      const message = params?.message as Record<string, unknown> | undefined;
      const messageId = typeof message?.messageId === 'string' ? message.messageId : undefined;
      if (!messageId) {
        return err10(req.id, 'CONTENT_TYPE_NOT_SUPPORTED', 'message.messageId is required (A2A 1.0 §D.2)');
      }
      // §D.2 `taskId` present ⇒ this is a reply into an existing task, not a new
      // one. This host has no declared input path for a message into a running
      // task (resuming a HITL gate over A2A is ADR 0552 P3), and §D.2 is
      // explicit that the alternative to a declared path is an error, never a
      // silent drop: "the host MUST NOT silently drop the message: it MUST
      // either deliver it through a declared input path or return
      // UnsupportedOperationError."
      const taskId = typeof message?.taskId === 'string' ? message.taskId : undefined;
      if (taskId) {
        const existing = await readTask(deps, principal, taskId, 'strict');
        if (!existing) return err10(req.id, 'TASK_NOT_FOUND', `task not found: ${taskId}`);
        return err10(req.id, 'UNSUPPORTED_OPERATION', 'this host has no A2A input path into a running task');
      }
      const text = messageText10(message);
      const contextId = typeof message?.contextId === 'string' ? message.contextId : undefined;
      const submitted = await submitMessageTask(deps, principal, {
        messageId,
        text,
        ...(contextId ? { contextId } : {}),
        tenantHint: params?.tenant,
      });
      if (!submitted.ok) return err10(req.id, submitted.error, submitted.message);
      // `SendMessageResponse` is a oneof `{ task } | { message }`; a
      // run-creating host answers with the task.
      return ok(req.id, { task: renderTask(submitted.value, { messageId, text }) });
    }

    case A2A_10_METHODS.getTask: {
      if (!deps) return err10(req.id, 'TASK_NOT_FOUND', 'task not found');
      const id = taskIdOf(params);
      if (!id) return err10(req.id, 'TASK_NOT_FOUND', 'params.id is required');
      const rec = await readTask(deps, principal, id, 'strict');
      // §E — a task in another tenant answers exactly as a missing one does.
      if (!rec) return err10(req.id, 'TASK_NOT_FOUND', `task not found: ${id}`);
      return ok(req.id, renderTask(rec));
    }

    case A2A_10_METHODS.listTasks: {
      if (!deps) return ok(req.id, { tasks: [], nextPageToken: '', totalSize: 0 });
      // The tenant of record, never the `tenant` hint (§E).
      const tenantId = resolveTenantOfRecord(principal, params?.tenant);
      const contextId = typeof params?.contextId === 'string' ? params.contextId : undefined;
      const all = await listA2aTasksForTenant(tenantId);
      const filtered = contextId ? all.filter((t) => t.contextId === contextId) : all;
      const pageSize = typeof params?.pageSize === 'number' && params.pageSize > 0 ? params.pageSize : filtered.length;
      const page = await Promise.all(filtered.slice(0, pageSize).map((t) => refreshTaskFromRun(deps, t)));
      return ok(req.id, {
        tasks: page.map((t) => renderTask(t)),
        // Single page: this host has no run-list cursor to hand back, and an
        // invented token that a peer could not resolve is worse than none.
        nextPageToken: '',
        totalSize: filtered.length,
      });
    }

    case A2A_10_METHODS.cancelTask: {
      if (!deps) return err10(req.id, 'TASK_NOT_FOUND', 'task not found');
      const id = taskIdOf(params);
      if (!id) return err10(req.id, 'TASK_NOT_FOUND', 'params.id is required');
      const cancelled = await cancelTask(deps, principal, id, 'strict');
      if (!cancelled.ok) return err10(req.id, cancelled.error, cancelled.message);
      return ok(req.id, renderTask(cancelled.value));
    }

    case A2A_10_METHODS.subscribeToTask:
    case A2A_10_METHODS.sendStreamingMessage: {
      // The card advertises `capabilities.streaming` from the same flag, so
      // refusing here when it is off is the card's claim enforced, not a
      // second policy.
      if (!caps.streaming) {
        return err10(req.id, 'UNSUPPORTED_OPERATION', 'streaming is not supported by this agent (capabilities.streaming=false)');
      }
      if (!deps) return err10(req.id, 'TASK_NOT_FOUND', 'task not found');
      const id = taskIdOf(params);
      if (!id) return err10(req.id, 'TASK_NOT_FOUND', 'params.id is required');
      const rec = await readTask(deps, principal, id, 'strict');
      if (!rec) return err10(req.id, 'TASK_NOT_FOUND', `task not found: ${id}`);
      // RFC 0100 §3 re-attach: replay the current Task, read-only, no
      // re-execution. The `StreamResponse` oneof's `task` member, as §D.5 says
      // is sent first on subscribe.
      return ok(req.id, { task: renderTask(rec) });
    }

    case A2A_10_METHODS.createPushConfig: {
      if (!caps.pushNotifications) {
        return err10(req.id, 'PUSH_NOTIFICATION_NOT_SUPPORTED', 'this host does not support A2A push notifications');
      }
      if (!deps) return err10(req.id, 'TASK_NOT_FOUND', 'task not found');
      const cfg = (params?.config ?? params?.taskPushNotificationConfig ?? params) as
        | { taskId?: unknown; url?: unknown }
        | undefined;
      const id = typeof cfg?.taskId === 'string' ? cfg.taskId : taskIdOf(params);
      const url = typeof cfg?.url === 'string' ? cfg.url : undefined;
      if (!id || !url) return err10(req.id, 'CONTENT_TYPE_NOT_SUPPORTED', 'taskId and url are required');
      // §E — authorize the task BEFORE touching the push store, so a push
      // config cannot be attached to (or probe for) a foreign task.
      const rec = await readTask(deps, principal, id, 'strict');
      if (!rec) return err10(req.id, 'TASK_NOT_FOUND', `task not found: ${id}`);
      try {
        const updated = await setA2aTaskPushConfig(id, { url });
        if (!updated) return err10(req.id, 'TASK_NOT_FOUND', `task not found: ${id}`);
        // §D.6 — `token` / `authentication.credentials` are CALLER SECRETS and
        // never enter the persisted record or the response. Only the target
        // is echoed.
        return ok(req.id, { taskId: updated.taskId, url: updated.pushConfig?.url });
      } catch (e) {
        if (e instanceof A2aPushUrlDeniedError) {
          log.warn('a2a10_push_egress_denied', { taskId: id });
          return err10(req.id, 'UNSUPPORTED_OPERATION', 'push target refused by the webhook egress guard');
        }
        throw e;
      }
    }

    case A2A_10_METHODS.getPushConfig:
    case A2A_10_METHODS.listPushConfigs:
    case A2A_10_METHODS.deletePushConfig:
      // ADR 0744 H6 — A2A 1.0.1 §3.3.4: with push not advertised EVERY
      // push-config operation answers `PushNotificationNotSupportedError`
      // (-32003), not `-32601 method not found` (which says the operation does
      // not exist in the protocol). With push advertised this host still has
      // no Get/List/Delete (single un-addressable config per task — the push
      // sink issue tracks it), and says so as UnsupportedOperationError rather
      // than inventing an answer.
      if (!caps.pushNotifications) {
        return err10(req.id, 'PUSH_NOTIFICATION_NOT_SUPPORTED', 'this host does not support A2A push notifications');
      }
      return err10(req.id, 'UNSUPPORTED_OPERATION', 'push-config read/delete is not implemented on this host');

    case A2A_10_METHODS.getExtendedCard:
      // §C: served only when `capabilities.extendedAgentCard: true`, which the
      // 1.0 card advertises as false.
      return err10(req.id, 'EXTENDED_AGENT_CARD_NOT_CONFIGURED', 'this host serves no extended agent card');

    default:
      return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } };
  }
}
