/**
 * A7 — a real A2A (Agent-to-Agent) SERVER handler (RFC 0076), turning the
 * sample host from "A2A client only / server stubs" into one that answers as an
 * A2A agent. A peer can discover this host's agent card and `message/send` a
 * task, which is routed to a real manifest-agent dispatch (the deterministic
 * RFC 0070 seam — replay-safe, no external dependency). A production host adds
 * streaming + push-config; this is the synchronous request/response core.
 */

import { runAgentDispatch, AgentNotFoundError } from './agentDispatch.js';

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

/**
 * Handle one A2A JSON-RPC request. Supports:
 *  - `agent/getCard`  → the published agent card (discovery).
 *  - `message/send`   → dispatch `params.agentId` over `params.message`, returning
 *                       an A2A Task with terminal state + the agent's result.
 *  - `tasks/get`      → not-found in the synchronous core (tasks are not persisted).
 */
export function handleA2aRequest(req: A2aJsonRpcRequest, opts: A2aServerOptions): A2aJsonRpcResponse {
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return rpcError(req?.id ?? 0, -32600, 'invalid request');
  }
  switch (req.method) {
    case 'agent/getCard':
      return ok(req.id, opts.agentCard);

    case 'message/send': {
      const agentId = typeof req.params?.agentId === 'string' ? req.params.agentId : undefined;
      if (!agentId) return rpcError(req.id, -32602, 'params.agentId is required');
      const task = messageText(req.params?.message);
      try {
        const r = runAgentDispatch({
          agentId,
          task,
          ...(opts.availableTools ? { availableTools: opts.availableTools } : {}),
          validateHandoff: false,
        });
        // Map the dispatch outcome onto an A2A Task object.
        const state = r.status === 'completed' ? 'completed' : r.status === 'escalated' ? 'input-required' : 'failed';
        return ok(req.id, {
          kind: 'task',
          id: `a2a:${agentId}`,
          status: { state },
          agentId: r.agentId,
          result: r.result,
        });
      } catch (err) {
        if (err instanceof AgentNotFoundError) return rpcError(req.id, -32001, err.message);
        return rpcError(req.id, -32603, err instanceof Error ? err.message : String(err));
      }
    }

    case 'tasks/get':
      return rpcError(req.id, -32001, 'task not found (synchronous server keeps no task store)');

    default:
      return rpcError(req.id, -32601, `method not found: ${req.method}`);
  }
}
