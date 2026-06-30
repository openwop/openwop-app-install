/**
 * `local.openwop-app.agent-runner` — ADR 0089 Phase 4 (Option B).
 *
 * Runs a tool-bearing manifest agent's observe→act loop AS A PERSISTED RUN. It
 * is the one node behind the synthetic `openwop-app.agent-mention` workflow
 * (`host/agentMentionWorkflows.ts`), which the conversation dispatches when a
 * @mentioned agent has opted into deep investigation (`investigationDepth:
 * 'deep'`). The chat embeds that run as a `workflow_run` bubble and streams its
 * progress + final report (the existing `runWorkflowMention` seam, run-agnostic).
 *
 * NO SECOND AGENTIC PATH (ADR 0089 §4 / review finding #1/#5). This node enters
 * agentic execution through the SINGLE gated owner — `runAgentDispatchLive` —
 * with the SAME tool deps the agent-dispatch route wires:
 *   - the run's policy-enforcing provider adapter (`ctx.callAI` /
 *     `ctx.callAIWithTools`, built by the executor from the run's
 *     `policyResolver` + BYOK secrets), so provider policy + §A14 + the ADR 0102
 *     per-tool gate (resolved via `tenantId`) all hold;
 *   - the SAME built-in tool catalog + executor (`createAgentToolProvider`).
 * It does NOT stand up a second `executeTool`, a second loop, or a second model
 * call. The agent's `modelClass`, BYOK provider/model, and credentialRef ride the
 * standard live-dispatch resolution.
 *
 * The loop's RFC 0064 `agent.*` events (reasoned / toolCalled / toolReturned /
 * decided / verified) are emitted onto THIS run's event log via `ctx.emit`, so a
 * subscribed client renders live tool progress on the run bubble — the same event
 * types the inline conversation tool turn surfaces (no new event type, no RFC).
 *
 * Replay-safe: the loop runs once, live; the run's recorded output + events are
 * what a `:fork`/replay reads (it never re-executes the tools), consistent with
 * the inline conversation turn (ADR 0089 §Q4).
 */

import type { NodeContext, NodeModule, NodeOutcome } from '../executor/types.js';
import { runAgentDispatchLive, AgentNotFoundError, type AgentEvent } from './agentDispatch.js';
import { createAgentToolProvider, builtinAgentToolIds } from './agentToolProvider.js';
import { appendChatMessageLive } from './chatMessageBus.js';
import { agentRef } from './conversationStore.js';

export const AGENT_RUNNER_TYPE_ID = 'local.openwop-app.agent-runner';

/** Resolve the agent-runner node config/inputs (the synthetic workflow seeds
 *  `agentId` + `task` as run variables threaded into the node inputs). Reads the
 *  node inputs first, then falls back to config (an author-pinned agent). */
function resolveParams(ctx: NodeContext): { agentId: string; task: string; provider?: string; model?: string; credentialRef?: string; conversationId?: string } {
  const inputs = (ctx.inputs && typeof ctx.inputs === 'object' && !Array.isArray(ctx.inputs)) ? (ctx.inputs as Record<string, unknown>) : {};
  const cfg = (ctx.config ?? {}) as Record<string, unknown>;
  const pick = (key: string): unknown => (inputs[key] !== undefined ? inputs[key] : cfg[key]);
  const agentId = typeof pick('agentId') === 'string' ? (pick('agentId') as string) : '';
  const task = typeof pick('task') === 'string' ? (pick('task') as string) : '';
  const provider = typeof pick('provider') === 'string' ? (pick('provider') as string) : undefined;
  const model = typeof pick('model') === 'string' ? (pick('model') as string) : undefined;
  const credentialRef = typeof pick('credentialRef') === 'string' ? (pick('credentialRef') as string) : undefined;
  // ADR 0125 Phase 2c — optional: post the reply AS a turn in this conversation.
  const conversationId = typeof pick('conversationId') === 'string' ? (pick('conversationId') as string) : undefined;
  return { agentId, task, ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(credentialRef ? { credentialRef } : {}), ...(conversationId ? { conversationId } : {}) };
}

/** Pull the agent's final answer text out of the dispatch result. A tool-only
 *  research agent (no return schema) yields `{ content }`; a schema agent yields
 *  the structured `result`, which we JSON-stringify for the chat bubble. */
function resultToText(result: unknown): string {
  if (result && typeof result === 'object' && typeof (result as { content?: unknown }).content === 'string') {
    return (result as { content: string }).content;
  }
  if (typeof result === 'string') return result;
  return result === undefined ? '' : JSON.stringify(result);
}

const agentRunnerNode: NodeModule = {
  typeId: AGENT_RUNNER_TYPE_ID,
  version: '1.0.0',
  async execute(ctx): Promise<NodeOutcome> {
    const { agentId, task, provider, model, credentialRef, conversationId } = resolveParams(ctx);
    if (!agentId) {
      return { status: 'failure', error: { code: 'validation_error', message: 'agent-runner node requires an `agentId`.' } };
    }
    // The gated agentic deps come from the EXECUTOR-built ctx adapter (the run's
    // policy resolver + BYOK secrets); absent ⇒ no model surface is wired (e.g. a
    // host with no provider policy), so we cannot run the loop honestly.
    if (!ctx.callAI || !ctx.callAIWithTools) {
      return { status: 'failure', error: { code: 'no_model_available', message: 'agent-runner has no provider adapter wired on this run.' } };
    }
    // The SAME built-in tool catalog + executor the agent-dispatch route uses —
    // tenant/run-scoped (CTI-1). No second executor.
    const toolProvider = createAgentToolProvider({ tenantId: ctx.tenantId, runId: ctx.runId });
    try {
      const result = await runAgentDispatchLive(
        {
          agentId,
          task,
          // Offer the host's built-in tool ids; `runAgentDispatchLive` §A14-filters
          // them to the agent's allowlist (+ the ADR 0104 override) inside.
          availableTools: [...builtinAgentToolIds()],
          ...(ctx.compaction ? { compaction: ctx.compaction } : {}),
        },
        {
          callAI: ctx.callAI,
          callAIWithTools: ctx.callAIWithTools,
          resolveTool: toolProvider.resolveTool,
          executeTool: toolProvider.executeTool,
          // ADR 0102 — resolve this standing agent's tool permissions for the
          // per-tool gate (shadow-logged until enabled). Tenant-scoped (CTI-1).
          tenantId: ctx.tenantId,
          // BYOK/model resolution: honor the run's pinned provider/model/credential
          // (so a BYOK conversation's agent runs on the user's key); absent ⇒ the
          // managed tier (zero-BYOK turn), exactly like the dispatch route.
          ...(provider || model ? { modelOptions: { ...(provider ? { provider } : {}), ...(model ? { model } : {}), preferManaged: !provider } } : {}),
          ...(credentialRef ? { credentialRef } : {}),
        },
      );
      // Surface the loop's RFC 0064 agent.* events onto THIS run's event log so a
      // subscribed client renders live tool progress on the run bubble. Best-effort
      // ordering: emit sequentially (observability, not determinism — §Q4).
      for (const ev of result.events as AgentEvent[]) {
        await ctx.emit(ev.type, { ...ev });
      }
      if (result.status === 'failed') {
        return { status: 'failure', error: result.error ?? { code: 'agent_dispatch_failed', message: 'agent dispatch failed' } };
      }
      const replyText = resultToText(result.result);
      // ADR 0125 Phase 2c — when the run TARGETS a conversation (the scheduled-chat tick
      // passes `conversationId`; the @mention path does NOT, so it's unaffected), post
      // the agent's reply AS an `assistant` turn in that conversation. Idempotent (a
      // deterministic `sched:<runId>` id ⇒ a re-run can't duplicate the turn) and
      // BEST-EFFORT (a conversation-write failure must NEVER fail the turn — the agent
      // already replied). The node runs live-once, so the append happens once.
      if (conversationId) {
        try {
          // ADR 0154 FU-6 — append + live-delivery event so a channel's members
          // (and the poster who triggered the turn) see the reply without a refresh.
          await appendChatMessageLive({
            messageId: `sched:${ctx.runId}`, sessionId: conversationId, role: 'assistant',
            content: replyText.slice(0, 100_000), meta: null, authorSubject: agentRef(agentId),
            createdAt: new Date().toISOString(),
          });
        } catch { /* best-effort surfacing — never fail the produced turn */ }
      }
      // 'completed' or 'escalated' both produced an answer the chat can render.
      return {
        status: 'success',
        outputs: {
          agentId: result.agentId,
          status: result.status,
          text: replyText,
          toolSurface: result.toolSurface,
          ...(result.provider ? { provider: result.provider } : {}),
          ...(result.model ? { model: result.model } : {}),
        },
      };
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        return { status: 'failure', error: { code: 'agent_not_found', message: err.message } };
      }
      return { status: 'failure', error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) } };
    }
  },
};

export default agentRunnerNode;
