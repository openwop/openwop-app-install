/**
 * A7 — a real A2A (Agent-to-Agent) SERVER handler (RFC 0076), turning the
 * sample host from "A2A client only / server stubs" into one that answers as an
 * A2A agent. A peer can discover this host's agent card and `message/send` a
 * task, which is routed to a real manifest-agent dispatch (the deterministic
 * RFC 0070 seam — replay-safe, no external dependency).
 *
 * ADR 0035 / RFC 0100 ("Async / Durable A2A Tasks") extends this beyond the
 * synchronous core: when `durableTasks` is wired (a task store is injected),
 * `message/send` PERSISTS an `A2ATaskState` per backing run (`a2aTaskStore.ts`),
 * `tasks/get` returns the live persisted state after a caller disconnect,
 * `tasks/resubscribe` re-attaches the update stream from the current state
 * forward without re-executing, and `tasks/pushNotificationConfig/set`
 * registers an SSRF-guarded push target that fires on the terminal/blocking
 * transitions. The run-status → TaskState mapping is the one
 * `a2a-integration.md` §"State projection" already specifies — persisted, not
 * changed (it does not fork the run lifecycle). When NO task store is injected,
 * the handler behaves exactly as the synchronous core did (no regression):
 * `tasks/get` is not-found and no Task is persisted.
 *
 * @see RFCS/0100-async-durable-a2a-tasks.md
 * @see spec/v1/a2a-integration.md
 * @see docs/adr/0035-async-durable-a2a-tasks.md
 */

import { runAgentDispatch, AgentNotFoundError } from './agentDispatch.js';
import { getAgentRegistry } from '../executor/agentRegistry.js';
import {
  getA2aTask,
  upsertA2aTask,
  setA2aTaskPushConfig,
  projectTaskRecordToA2aTask,
  taskStatusUpdateEvent,
  isTerminalTaskState,
  A2aPushUrlDeniedError,
  type A2aTaskRecord,
  type A2aTaskState,
  type A2aInterruptKind,
} from './a2aTaskStore.js';

export interface A2aJsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface A2aJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface A2aServerOptions {
  /** The agent card this host publishes (served on `agent/getCard`). */
  agentCard: unknown;
  /** Per-turn tools the dispatched agent may use (intersected with its allowlist). */
  availableTools?: string[];
  /**
   * ADR 0035 / RFC 0100 — enable durable Tasks. When `true`, `message/send`
   * persists an `A2ATaskState`, `tasks/get`/`tasks/resubscribe`/push-config are
   * served from the store, and the `a2a.durableTasks` capability is advertised.
   * When `false`/absent the handler is the synchronous core (today's behavior).
   */
  durableTasks?: boolean;
}

function ok(id: string | number, result: unknown): A2aJsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id: string | number, code: number, message: string): A2aJsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Pull the text out of an A2A message `{ parts: [{ kind:'text', text }] }`. */
function messageText(message: unknown): string {
  const parts = (message as { parts?: Array<{ text?: string }> })?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('').trim();
}

/** Read `params.id` (the A2A `Task.id`) for tasks/* methods. */
function taskIdOf(params: Record<string, unknown> | undefined): string | undefined {
  return typeof params?.id === 'string' ? params.id : undefined;
}

/** Whether a manifest agent is registered (so a durable Task is opened only for
 *  a real agent — an unknown agent is a request error with no Task created). */
function agentExists(agentId: string): boolean {
  return getAgentRegistry().has(agentId);
}

/**
 * Project a deterministic agent-dispatch outcome onto a durable A2A TaskState.
 * An `escalated` turn is a HITL-style block: it projects to `input-required`
 * (`clarification` — the agent is asking the caller for input, matching the
 * `waiting-input` → INPUT_REQUIRED row of a2a-integration.md §"State
 * projection"). The mapping is the spec table — not a new one.
 */
function projectDispatchOutcome(
  status: 'completed' | 'failed' | 'escalated',
): { state: A2aTaskState; interruptKind?: A2aInterruptKind } {
  switch (status) {
    case 'completed':
      return { state: 'completed' };
    case 'escalated':
      return { state: 'input-required', interruptKind: 'clarification' };
    case 'failed':
      return { state: 'failed' };
  }
}

/**
 * Handle one A2A JSON-RPC request. Supports:
 *  - `agent/getCard`            → the published agent card (discovery).
 *  - `message/send`             → dispatch `params.agentId` over `params.message`;
 *                                 when durable, persist the projected Task and
 *                                 advance it (submitted → working → terminal /
 *                                 input-required); returns the A2A Task.
 *  - `tasks/get`                → durable: the live persisted Task; sync: not-found.
 *  - `tasks/resubscribe`        → durable: re-attach the update stream (read-only,
 *                                 no re-execution); sync: not-found.
 *  - `tasks/pushNotificationConfig/set` → durable: register an SSRF-guarded push.
 */
export async function handleA2aRequest(
  req: A2aJsonRpcRequest,
  opts: A2aServerOptions,
): Promise<A2aJsonRpcResponse> {
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return rpcError(req?.id ?? 0, -32600, 'invalid request');
  }
  const durable = opts.durableTasks === true;

  switch (req.method) {
    case 'agent/getCard':
      return ok(req.id, opts.agentCard);

    case 'message/send': {
      const agentId = typeof req.params?.agentId === 'string' ? req.params.agentId : undefined;
      if (!agentId) return rpcError(req.id, -32602, 'params.agentId is required');
      const task = messageText(req.params?.message);
      // The taskId/runId binding (a2a-integration.md §2 — runId becomes Task.id).
      // A `message/send` carrying an existing task id is a resume into that Task
      // (a2a-integration.md §4); otherwise a fresh handoff opens one.
      const contextId =
        typeof req.params?.contextId === 'string'
          ? req.params.contextId
          : undefined;
      const taskId = taskIdOf(req.params) ?? `a2a:${agentId}`;
      // Carry forward any existing record's contextId + push-config across a
      // resume re-send into the same task id (read once, reused on each upsert).
      const existing = durable ? await getA2aTask(taskId) : null;
      const carry = {
        ...(contextId ? { contextId } : existing?.contextId ? { contextId: existing.contextId } : {}),
        ...(existing?.pushConfig ? { pushConfig: existing.pushConfig } : {}),
      };

      // Durable lifecycle: persist `working` for the turn, so a caller that
      // disconnects `tasks/get`s a live `working`, not a stale absence (RFC 0100
      // §3). The deterministic dispatch is synchronous; a production host backing
      // a long-running run leaves the Task `working`/`input-required` across the
      // pause and projects from the live run-status. We do NOT fork the
      // lifecycle — `working` then the projected outcome is the spec table.
      // Persisted AFTER agentId validation so a never-existing task isn't
      // created for an unknown agent (which is a request error, not a Task).
      try {
        if (durable) {
          // Validate the agent exists before opening a durable Task: an unknown
          // agent maps to a JSON-RPC error with NO Task created.
          if (!agentExists(agentId)) {
            return rpcError(req.id, -32001, `agent not found: ${agentId}`);
          }
          await upsertA2aTask({ taskId, runId: taskId, ...carry, state: 'working' });
        }

        const r = runAgentDispatch({
          agentId,
          task,
          ...(opts.availableTools ? { availableTools: opts.availableTools } : {}),
          validateHandoff: false,
        });
        const projected = projectDispatchOutcome(r.status);

        if (durable) {
          const rec = await upsertA2aTask({
            taskId,
            runId: taskId,
            ...carry,
            state: projected.state,
            ...(projected.interruptKind ? { interruptKind: projected.interruptKind } : {}),
          });
          return ok(req.id, {
            ...projectTaskRecordToA2aTask(rec),
            agentId: r.agentId,
            result: r.result,
          });
        }

        // Synchronous core (no store): today's response shape, unchanged.
        return ok(req.id, {
          kind: 'task',
          id: taskId,
          status: { state: projected.state },
          agentId: r.agentId,
          result: r.result,
        });
      } catch (err) {
        // A dispatch failure AFTER the durable Task opened transitions it to the
        // terminal `failed` projection (run.failed → FAILED) rather than leaving
        // a dangling `working` — and fires the push on the `failed` transition.
        if (durable) {
          try {
            await upsertA2aTask({ taskId, runId: taskId, ...carry, state: 'failed' });
          } catch {
            /* store failure must not mask the original dispatch error */
          }
        }
        if (err instanceof AgentNotFoundError) return rpcError(req.id, -32001, err.message);
        return rpcError(req.id, -32603, err instanceof Error ? err.message : String(err));
      }
    }

    case 'tasks/get': {
      if (!durable) {
        return rpcError(req.id, -32001, 'task not found (synchronous server keeps no task store)');
      }
      const taskId = taskIdOf(req.params);
      if (!taskId) return rpcError(req.id, -32602, 'params.id is required');
      const rec = await getA2aTask(taskId);
      if (!rec) return rpcError(req.id, -32001, `task not found: ${taskId}`);
      return ok(req.id, projectTaskRecordToA2aTask(rec));
    }

    case 'tasks/resubscribe': {
      if (!durable) {
        return rpcError(req.id, -32001, 'task not found (synchronous server keeps no task store)');
      }
      const taskId = taskIdOf(req.params);
      if (!taskId) return rpcError(req.id, -32602, 'params.id is required');
      const rec = await getA2aTask(taskId);
      if (!rec) return rpcError(req.id, -32001, `task not found: ${taskId}`);
      // Read-only re-attachment (RFC 0100 §3): re-deliver the current state as a
      // `TaskStatusUpdateEvent` from the current state forward, WITHOUT
      // re-executing the run or re-accepting the originating message. The
      // backing runId is unchanged — resubscribe is an observer, not a new run.
      return ok(req.id, taskStatusUpdateEvent(rec, isTerminalTaskState(rec.state)));
    }

    case 'tasks/pushNotificationConfig/set': {
      if (!durable) {
        return rpcError(req.id, -32601, `method not found: ${req.method}`);
      }
      const taskId =
        taskIdOf(req.params) ??
        (typeof req.params?.taskId === 'string' ? req.params.taskId : undefined);
      if (!taskId) return rpcError(req.id, -32602, 'params.id is required');
      const cfg = req.params?.pushNotificationConfig as
        | { url?: unknown; tokenFingerprint?: unknown }
        | undefined;
      const url = typeof cfg?.url === 'string' ? cfg.url : undefined;
      if (!url) return rpcError(req.id, -32602, 'params.pushNotificationConfig.url is required');
      try {
        const rec = await setA2aTaskPushConfig(taskId, {
          url,
          ...(typeof cfg?.tokenFingerprint === 'string'
            ? { tokenFingerprint: cfg.tokenFingerprint }
            : {}),
        });
        if (!rec) return rpcError(req.id, -32001, `task not found: ${taskId}`);
        return ok(req.id, { taskId: rec.taskId, pushNotificationConfig: { url: rec.pushConfig?.url } });
      } catch (err) {
        // SSRF refusal — surface as an invalid-params JSON-RPC error.
        if (err instanceof A2aPushUrlDeniedError) return rpcError(req.id, -32602, err.message);
        return rpcError(req.id, -32603, err instanceof Error ? err.message : String(err));
      }
    }

    default:
      return rpcError(req.id, -32601, `method not found: ${req.method}`);
  }
}

export type { A2aTaskRecord };
