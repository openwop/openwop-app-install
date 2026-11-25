/**
 * ADR 1099 D5 — the default-deny tool turn shared by the two lanes that act for a
 * caller who is not a member of the tenant: the RFC 0132 anonymous actor
 * (`anonymousActor.ts`) and the collaborator turn (`collaboratorTurn.ts`).
 *
 * Extracted from `runAnonReadTurn` with no behaviour change. It owns what both lanes
 * must do the same way:
 *   - create a durable run owned by the tenant, with the lane's metadata and owner;
 *   - compile the tools to EXACTLY `toolIds` (compiled against themselves, so never
 *     the ADR 0315 default-on baseline);
 *   - leave `actingUserId` undefined, so member-keyed and secret tools fail closed;
 *   - build the lane's capability firewall (ADR 0834 D1), forced safe, no approvals;
 *   - run the one shared tool loop, then settle the run (status, online evals, cost).
 *
 * What a lane decides stays in the lane: `executeTool` wraps every call (its audit,
 * its holds, its caps), and `onForbidden` hears a tool the model asked for that was
 * never compiled.
 */
import { randomUUID } from 'node:crypto';
import type { Storage } from '../storage/storage.js';
import type { AiCallMessage, AiToolCallRequest, AiToolCallResult } from '../executor/types.js';
import { buildRunRecord } from './runDispatch.js';
import { compileAgentTools, runChatToolLoop, type AgentEvent } from './agentDispatch.js';
import { createScopedAgentToolProvider } from './agentToolProvider.js';
import { buildLaneFirewall, type FirewallLane } from './laneFirewall.js';
import type { RunOwnerStamp } from './runOwner.js';
import { scoreOnlineEvalsOnTerminal } from './workflowEvalOnline.js';
import { stampRunCostOnTerminal } from '../observability/costEmitter.js';
import { foldWorkflowSpendOnTerminal } from './workflowBudgets.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.scopedToolTurn');

type ToolProvider = ReturnType<typeof createScopedAgentToolProvider>;
export type ScopedExecuteTool = ToolProvider['executeTool'];

/** What a lane's callbacks are handed once the run exists. */
export interface ScopedTurnRun {
  runId: string;
  /** Append one event to the turn's run. */
  emit: (event: { type: string; payload: Record<string, unknown> }) => Promise<void>;
}

export interface ScopedToolTurnParams {
  storage: Storage;
  /** The tenant the run is owned by and every tool is scoped to. */
  tenantId: string;
  lane: Extract<FirewallLane, 'anon' | 'collab'>;
  /** The synthetic workflow id the run carries (the run is a durable owner and audit
   *  anchor for the turn, not a workflow execution). */
  workflowId: string;
  runMetadata: Record<string, unknown>;
  owner: RunOwnerStamp;
  agent: { agentId: string; persona: string; systemPrompt: string };
  /** The exact tools the model may call. */
  toolIds: readonly string[];
  /** Where those tools are resolved and executed. Default: the tenant-scoped agent tool
   *  provider (`actingUserId` undefined). The collaborator lane passes its own source,
   *  built only from the client-tool registry, so no member tool can resolve at all. */
  toolSource?: (scope: { tenantId: string; runId: string }) => { resolveTool: ToolProvider['resolveTool']; executeTool: ScopedExecuteTool };
  messages: AiCallMessage[];
  callAIWithTools: (r: AiToolCallRequest) => Promise<AiToolCallResult>;
  maxRounds?: number;
  /** Every tool call goes through this. `base` is the tenant-scoped provider's own
   *  executor; the lane decides whether, and how, to call it. */
  executeTool: (call: Parameters<ScopedExecuteTool>[0], ctx: ScopedTurnRun & { base: ScopedExecuteTool }) => ReturnType<ScopedExecuteTool>;
  /** The model asked for a tool outside `toolIds`; the loop already refused it. */
  onForbidden?: (toolName: string, run: ScopedTurnRun) => Promise<void>;
  /** The lane firewall refused a compiled tool. Awaited before the turn settles. */
  onFirewallDecision?: (d: { toolName: string; decision: 'deny' | 'require-approval' }, run: ScopedTurnRun) => Promise<void>;
}

export interface ScopedToolTurnResult {
  runId: string;
  finalText: string;
  failed: boolean;
}

export async function runScopedToolTurn(params: ScopedToolTurnParams): Promise<ScopedToolTurnResult> {
  const { storage, tenantId } = params;
  const now = new Date().toISOString();
  const run = buildRunRecord({ workflowId: params.workflowId, tenantId, metadata: params.runMetadata, owner: params.owner, now });
  // ADR 0604 (TOCC-1, RECORDED NOT FIXED) — a DELIBERATE `storage.insertRun`: the
  // one run-creation path that does NOT go through `insertRunWithStartContext`, so
  // these runs never carry a frozen `run.metadata.compaction`. The seam also runs
  // the AUTHORITY contributor, which mints an authority block from
  // `currentAuthority()`; doing that for a non-member principal is a
  // security-relevant change for its own reviewed decision. Moved here unchanged
  // from `runAnonReadTurn` (ADR 1099 D5).
  await storage.insertRun(run);
  const runId = run.runId;
  const ctx: ScopedTurnRun = {
    runId,
    emit: async (event) => {
      await storage.appendEvent({ eventId: randomUUID(), runId, type: event.type, payload: event.payload, timestamp: new Date().toISOString() });
    },
  };

  const toolIds = [...params.toolIds];
  const toolProvider = params.toolSource ? params.toolSource({ tenantId, runId }) : createScopedAgentToolProvider({ tenantId, runId });
  const tools = compileAgentTools(
    { agentId: params.agent.agentId, persona: params.agent.persona, systemPrompt: params.agent.systemPrompt, toolAllowlist: toolIds } as Parameters<typeof compileAgentTools>[0],
    toolIds,
    toolProvider.resolveTool,
    toolIds,
  );
  const executeTool: ScopedExecuteTool = (call) => params.executeTool(call, { ...ctx, base: toolProvider.executeTool });

  const compiled = new Set(toolIds);
  const onEvent = async (e: AgentEvent): Promise<void> => {
    if (!params.onForbidden) return;
    if (e.type === 'agent.toolReturned' && (e as { status?: unknown }).status === 'forbidden') {
      const toolName = typeof (e as { toolName?: unknown }).toolName === 'string' ? String((e as { toolName?: unknown }).toolName) : 'unknown';
      // A firewall refusal of a compiled tool is reported through onFirewallDecision.
      if (!compiled.has(toolName)) await params.onForbidden(toolName, ctx);
    }
  };
  // ADR 0834 D1 / S3 — forced safe (no bypass), no approvals (these lanes have no
  // ledger and no approver): a held call is refused, never queued past a policy.
  const { hook: firewall } = await buildLaneFirewall({ tenantId, lane: params.lane, resource: runId, dedupeKey: runId });
  // The loop's sink is synchronous; the audits are collected and awaited after it.
  const firewallAudits: Promise<void>[] = [];
  const onFirewallDecision = (d: { toolName: string; decision: 'deny' | 'require-approval' }): void => {
    if (params.onFirewallDecision) firewallAudits.push(params.onFirewallDecision(d, ctx).catch(() => {}));
  };

  const loop = await runChatToolLoop(
    {
      provider: 'openwop-free', model: 'openwop-free', credentialRef: 'managed:openwop-free',
      systemPrompt: params.agent.systemPrompt,
      messages: params.messages,
      tools,
      agentId: params.agent.agentId,
      persona: params.agent.persona,
      ...(params.maxRounds ? { maxRounds: params.maxRounds } : {}),
      onEvent,
      firewall,
      onFirewallDecision,
    },
    { callAIWithTools: params.callAIWithTools, executeTool },
  );
  await Promise.all(firewallAudits);

  const doneAt = new Date().toISOString();
  try {
    await storage.updateRun(runId, { status: loop.error ? 'failed' : 'completed', completedAt: doneAt, updatedAt: doneAt });
    // ADR 0480 (code-review M1) — a production terminal the executor sites never see.
    void scoreOnlineEvalsOnTerminal(storage, runId);
    // ADR 0482 grade-fix M1 — the turn's model spend is stamped and folded like every
    // other terminal, so no spend seam goes uncounted.
    void stampRunCostOnTerminal(storage, runId)
      .then((usd) => foldWorkflowSpendOnTerminal(storage, runId, usd));
  } catch (err) {
    log.warn(params.lane === 'anon' ? 'anon_run_terminal_patch_failed' : 'collab_run_terminal_patch_failed', { runId, error: err instanceof Error ? err.message : String(err) });
  }

  return { runId, finalText: loop.finalText, failed: Boolean(loop.error) };
}
