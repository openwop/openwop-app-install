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
 * Replay/fork (WF-RCL-2 — this header used to claim the OPPOSITE): recorded
 * outcomes are served only for SIDE-EFFECTING nodes (executor.ts, ADR 0341),
 * and this node is deliberately UNCLASSIFIED — so a replay `:fork` RE-EXECUTES
 * it. Its provider calls are served from the ADR 0326 invocation log
 * (divergence-checked per RFC 0041 §B), external effects inside the loop stay
 * covered by the ADR 0531 default-deny effect guard, and everything the node
 * COMPOSES — including twin borrowed recall — re-resolves LIVE. That live
 * re-read is why grant revocation holds on `:fork` (see the borrowed-recall
 * block in `execute`).
 */

import type { NodeContext, NodeModule, NodeOutcome } from '../executor/types.js';
import { runAgentDispatchLive, AgentNotFoundError, type AgentEvent, type AgentKnowledgeRetrieve } from './agentDispatch.js';
import { createLogger } from '../observability/logger.js';
import { createAgentToolProvider, builtinAgentToolIds } from './agentToolProvider.js';
import { resolveAgentIdentity } from './agentIdentity.js';
import { getBorrowedRecallResolver } from './twinRecallSurface.js';
import { appendChatMessageLive } from './chatMessageBus.js';
import { agentRef } from './conversationStore.js';
import { buildFirewallHook, SENSITIVE_APPROVAL_TOOLS } from '../features/capability-firewall/firewallHook.js';
import { getCapabilityRules, getUnknownToolPolicy, getFirewallMode, getDefaultDenyVerdict, getPlatformRules } from '../features/capability-firewall/ruleStore.js';

export const AGENT_RUNNER_TYPE_ID = 'local.openwop-app.agent-runner';

const log = createLogger('host.agentRunnerNode');

/** Resolve the agent-runner node config/inputs (the synthetic workflow seeds
 *  `agentId` + `task` as run variables threaded into the node inputs). Reads the
 *  node inputs first, then falls back to config (an author-pinned agent). */
export function resolveParams(ctx: NodeContext): { agentId: string; task: string; provider?: string; model?: string; credentialRef?: string; conversationId?: string; offerTools?: string[] } {
  const inputs = (ctx.inputs && typeof ctx.inputs === 'object' && !Array.isArray(ctx.inputs)) ? (ctx.inputs as Record<string, unknown>) : {};
  const cfg = (ctx.config ?? {}) as Record<string, unknown>;
  // The AUTONOMOUS dispatchers (ADR 0313 heartbeat bare-card fallback, ADR 0125
  // scheduled-chat tick, ADR 0309 schedule-followup) freeze {agentId, task,
  // credentialRef, conversationId} onto `run.configurable`, NOT `run.inputs` —
  // and `seedRunVariables` only seeds the variable bag from `inputs`, so without
  // this fallback the `{type:'variable'}` node inputs resolve to undefined and the
  // node fails "requires an agentId" (the whole turn is dead on arrival). The
  // @mention path passes them as `inputs` (which still wins). Both `inputs` and
  // `configurable` live on the run record, so this stays replay/fork-deterministic.
  const configurable = (ctx.configurable && typeof ctx.configurable === 'object' && !Array.isArray(ctx.configurable)) ? (ctx.configurable as Record<string, unknown>) : {};
  const pick = (key: string): unknown => (inputs[key] !== undefined ? inputs[key] : cfg[key] !== undefined ? cfg[key] : configurable[key]);
  const agentId = typeof pick('agentId') === 'string' ? (pick('agentId') as string) : '';
  const task = typeof pick('task') === 'string' ? (pick('task') as string) : '';
  const provider = typeof pick('provider') === 'string' ? (pick('provider') as string) : undefined;
  const model = typeof pick('model') === 'string' ? (pick('model') as string) : undefined;
  const credentialRef = typeof pick('credentialRef') === 'string' ? (pick('credentialRef') as string) : undefined;
  // ADR 0125 Phase 2c — optional: post the reply AS a turn in this conversation.
  const conversationId = typeof pick('conversationId') === 'string' ? (pick('conversationId') as string) : undefined;
  // ADR 0458 P2 — the CONFINEMENT lever. When set (even to []), this REPLACES the
  // host-offered tool catalog for this dispatch: the surface actually offered is
  // `filterTools(offerTools, effectiveAllowlist)`, so `offerTools:[]` yields a
  // ZERO-tool surface regardless of the agent's manifest allowlist OR the ADR 0315
  // default-on baseline union. It is per-NODE, per-RUN config — no shared mutable
  // state — so a confined dispatch cannot RACE a concurrent chat the way a stored
  // (tenant, agent) ADR 0104 override would. Absent ⇒ the full builtin catalog
  // (the @mention/heartbeat default is unchanged). The factory's sim stage sets
  // `offerTools:[]` so a convened sim persona is offered no write/egress tool.
  const offerToolsRaw = pick('offerTools');
  const offerTools = Array.isArray(offerToolsRaw)
    ? offerToolsRaw.filter((t): t is string => typeof t === 'string')
    : undefined;
  return { agentId, task, ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(credentialRef ? { credentialRef } : {}), ...(conversationId ? { conversationId } : {}), ...(offerTools ? { offerTools } : {}) };
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
    const { agentId, task, provider, model, credentialRef, conversationId, offerTools } = resolveParams(ctx);
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
    // tenant/run-scoped (CTI-1). No second executor. ADR 0277 P2 — the profile
    // id scopes the knowledge tools to the agent's bound collections.
    const runnerIdentity = await resolveAgentIdentity(ctx.tenantId, agentId, { allowReverseScan: true });
    // ADR 0324 scope-composer law — an actingUserId-gated tool (e.g. the KickTodo
    // today/progress reads a run-embedded agent offers, ADR 0459 P1) fails EMPTY
    // without the run's acting human. Thread `ctx.actingUserId` (stamped on
    // run.metadata at creation; absent on headless/system runs, which correctly
    // keeps those tools fail-closed) into the tool scope so the offered read tools
    // authorize. Additive: absent ⇒ prior behavior (no actingUserId) unchanged.
    const toolProvider = createAgentToolProvider({
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      agentProfileId: runnerIdentity.profileId,
      ...(ctx.actingUserId ? { actingUserId: ctx.actingUserId } : {}),
    });
    // ADR 0150 — the RUN-LANE capability firewall. The chat lane gates the
    // SENSITIVE tools (code-exec / file-write / off-host egress) behind an
    // approval card (conversationToolLoop wires SENSITIVE_APPROVAL_TOOLS); a
    // workflow / scheduled / heartbeat dispatch enters through THIS node and had
    // NO firewall, so those actions ran ungated. Build the same hook here with
    // the tenant's rules + posture, ALWAYS in safe mode — there is no interactive
    // user to pre-authorize a headless run, so `bypassApproval` is always false
    // and no tool is pre-approved. A `require-approval` verdict is collected by
    // the tool loop as a pending approval and surfaced by dispatch as an ESCALATED
    // outcome (this node's `escalated` handling), so the SENSITIVE action never
    // executes without either an approval or an escalation a human sees.
    const [fwRules, fwUnknownPolicy, fwMode, fwDefaultDenyVerdict, fwPlatformRules] = await Promise.all([
      getCapabilityRules(ctx.tenantId),
      getUnknownToolPolicy(ctx.tenantId),
      getFirewallMode(ctx.tenantId),
      getDefaultDenyVerdict(ctx.tenantId),
      getPlatformRules(),
    ]);
    const firewall = buildFirewallHook({
      rules: fwRules,
      unknownToolPolicy: fwUnknownPolicy,
      requireApprovalTools: SENSITIVE_APPROVAL_TOOLS,
      gateHostMediatedEgress: true, // ADR 0610 D5 / PMC-1 — gate the host-mediated egress CLASS in safe mode
      bypassApproval: false,
      mode: fwMode,
      defaultDenyVerdict: fwDefaultDenyVerdict,
      platformRules: fwPlatformRules,
    });
    // ADR 0044 Phase 2 — when this run's agent is a granted TWIN, compose its
    // OWNER's corpus into the dispatch (the SAME borrowed retriever the ad-hoc
    // agent-dispatch route and the interactive chat compose — one resolver, all
    // three lanes). `getBorrowedRecallResolver()` is the LIVE authorization gate
    // the `twin` feature fills: it re-checks toggle + link + AUDIENCE + active
    // grant and returns `undefined` when any is absent (fail-closed), so a
    // non-twin / not-granted / toggle-off agent is unaffected. It keys on the
    // ROSTER id (getTwinLink → getRosterEntry) = `runnerIdentity.profileId`.
    // `runAgentDispatchLive` fences everything it returns into the untrusted
    // block (§C/Phase 2).
    //
    // AUDIENCE (ADR 0589 §D2 — WF-RCL-6: this comment used to list scheduled/
    // heartbeat runs as unconditional beneficiaries, which D2 retired): the
    // acting human on this lane is `ctx.actingUserId` (the ADR 0324 stamp). A
    // run that STAMPS it — an @mention, or a scheduler that records its enabling
    // human (`features/assistant/loops.ts`, `features/crm/gmailSyncService.ts`
    // do) — keeps recall when that human IS the twin's owner. An UNATTRIBUTED
    // run is DENIED BY DESIGN: its output lands in a workspace-visible run
    // record — the same exposure with less information about it. `runId` rides
    // along for the ADR 0044 §5 audit row.
    //
    // REPLAY/FORK (WF-RCL-2 / RCL-DEBT-1 — this comment used to claim recall
    // "never re-resolves on replay", which is BACKWARDS): recorded outcomes are
    // served only for SIDE-EFFECTING nodes (executor.ts, ADR 0341), and this
    // node is deliberately unclassified — so a replay `:fork` RE-EXECUTES it and
    // recall RE-RESOLVES LIVE (provider calls are invocation-log-served; a
    // revocation-changed prompt diverges per RFC 0041 §B). That live re-read is
    // WHY revocation holds on `:fork` — no run stamp exists anywhere on this
    // path (`twinRecallSurface.ts`, `borrowedRecall.ts`). Do NOT classify this
    // node side-effecting and do NOT "optimize" in a grant/run stamp: either
    // would freeze borrowed content past revocation.
    const borrowedResolver = getBorrowedRecallResolver();
    let borrowedRetrieve: AgentKnowledgeRetrieve | undefined;
    let borrowedOwnerName: string | undefined;
    if (borrowedResolver) {
      try {
        const source = await borrowedResolver(ctx.tenantId, runnerIdentity.profileId, {
          ...(ctx.actingUserId ? { callerUserId: ctx.actingUserId } : {}),
          ...(ctx.runId ? { runId: ctx.runId } : {}),
          // PR #3409 review F1 — the per-dispatch identity within the run: a
          // chain can hold SEVERAL agent nodes, each a genuine recall, while a
          // crash-resume replay re-runs the SAME node under the same
          // (runId, nodeId). Bare runId collapsed the former; this keys the
          // consent-ledger replay guard on the node.
          dispatchId: `node:${ctx.nodeId}`,
        });
        borrowedRetrieve = source?.retrieve;
        borrowedOwnerName = source?.ownerName;
      } catch (err) {
        // RCL-4 / WF-RCL-1 — a twin-path FAULT (a storage throw in getTwinLink /
        // getActiveGrant / getUser inside the resolver) must DEGRADE this
        // dispatch the way the chat lane degrades (`chatContext.ts` catches and
        // ledgers), not kill the node: the seam's own contract says
        // "Best-effort" (`agentDispatch.ts`), and this was the one lane where a
        // transient consent-store read failed the WHOLE workflow node.
        // Deliberately its OWN catch — moving the await inside the dispatch
        // `try` below is a NO-OP (that catch also fails the node). The fault
        // SENTINEL resolves a retriever that immediately fires `onSourceError`,
        // so dispatch pushes the borrowed degradation label and the model is
        // told the owner corpus could not be READ — a faulted authorization
        // read must never present as "not granted" (the empty-as-success
        // family). Fail-closed on content: the sentinel returns no chunks.
        log.warn('twin_recall_resolve_failed_degrading', {
          tenantId: ctx.tenantId, agentId: runnerIdentity.profileId, runId: ctx.runId,
          error: err instanceof Error ? err.message : String(err),
        });
        borrowedRetrieve = async (_query, onSourceError) => { onSourceError?.('kb'); return []; };
      }
    }
    try {
      const result = await runAgentDispatchLive(
        {
          // ADR 0277 — dispatch the RESOLVED manifest id, never the raw input. A
          // roster id (`host:<slug>`) is a legitimate thing to hand this node (it
          // is what a DM's participant and a scheduled job's attribution carry),
          // and `resolveAgentIdentity` above already maps it to the agent it
          // wraps. Dispatching the raw id missed the registry: measured on
          // kicktodo.com 2026-09-16, every KickBot reminder coach turn failed
          // `agent 'host:kickbot' is not installed on this host` and the
          // participant was pushed a "Workflow failed" notice at the reminder slot.
          // The reply below still authors as the id we were GIVEN, so a DM whose
          // participant is `agent:host:<slug>` keeps matching its own author.
          agentId: runnerIdentity.agentId,
          tenantId: ctx.tenantId, // ADR 0379 P2 — user agents live under the tenant key
          task,
          // Offer the host's built-in tool ids; `runAgentDispatchLive` §A14-filters
          // them to the agent's allowlist (+ the ADR 0104 override) inside. ADR 0458
          // P2 — an explicit `offerTools` (e.g. the sim stage's []) REPLACES the
          // catalog, confining the surface without a racy stored override.
          availableTools: offerTools ?? [...builtinAgentToolIds()],
          ...(ctx.compaction ? { compaction: ctx.compaction } : {}),
        },
        {
          callAI: ctx.callAI,
          callAIWithTools: ctx.callAIWithTools,
          resolveTool: toolProvider.resolveTool,
          executeTool: toolProvider.executeTool,
          // ADR 0150 — gate the SENSITIVE tools on the run lane (see the hook build above).
          firewall,
          // ADR 0102 — resolve this standing agent's tool permissions for the
          // per-tool gate (shadow-logged until enabled). Tenant-scoped (CTI-1).
          tenantId: ctx.tenantId,
          // BYOK/model resolution: honor the run's pinned provider/model/credential
          // (so a BYOK conversation's agent runs on the user's key); absent ⇒ the
          // managed tier (zero-BYOK turn), exactly like the dispatch route.
          ...(provider || model ? { modelOptions: { ...(provider ? { provider } : {}), ...(model ? { model } : {}), preferManaged: !provider } } : {}),
          ...(credentialRef ? { credentialRef } : {}),
          // ADR 0044 Phase 2 — the granted twin's borrowed owner-corpus (undefined
          // for every non-twin agent; dispatch fences it into the untrusted block).
          // RCL-6 — the owner's name labels the fenced block (consented disclosure).
          ...(borrowedRetrieve ? { borrowedRetrieve } : {}),
          ...(borrowedOwnerName ? { borrowedOwnerName } : {}),
        },
      );
      // Surface the loop's RFC 0064 agent.* events onto THIS run's event log so a
      // subscribed client renders live tool progress on the run bubble. Best-effort
      // ordering: emit sequentially (observability, not determinism — §Q4).
      for (const ev of result.events as AgentEvent[]) {
        const [type, payload] = agentEventToEmit(ev);
        await ctx.emit(type, payload);
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
          }, ctx.tenantId);
        } catch { /* best-effort surfacing — never fail the produced turn */ }
      }
      // 'completed' or 'escalated' both produced an answer the chat can render.
      return {
        status: 'success',
        outputs: {
          agentId: result.agentId,
          status: result.status,
          text: replyText,
          // ADR 0458 P2 — ADDITIVE structured output. Previously the node dropped
          // the typed `AgentDispatchResult.result` and surfaced only the
          // JSON-stringified `text`; a downstream node (the factory's sim-collect)
          // needs the STRUCTURED return (e.g. a `{sim, verdict, summary, flags}`
          // schema agent's payload) without re-parsing text. Emitted only when the
          // dispatch produced one; `text` is unchanged for existing consumers.
          ...(result.result !== undefined ? { result: result.result } : {}),
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

/**
 * ADR 0722 — split an `AgentEvent` into (type, payload) for `ctx.emit`.
 *
 * `type` is the union DISCRIMINATOR, not a payload field. The loop used to
 * spread the whole event object into the emit, which put `type` into every `agent.*` payload,
 * where the closed corpus defs refuse it (MEASURED in the payload audit as
 * `agent.reasoned.type` and `agent.decided.type`). Exported so the split has a
 * witness of its own rather than needing a provider-backed node run.
 */
export function agentEventToEmit(ev: AgentEvent): [string, Record<string, unknown>] {
  const { type, ...payload } = ev as AgentEvent & Record<string, unknown>;
  return [type, payload];
}

export default agentRunnerNode;
