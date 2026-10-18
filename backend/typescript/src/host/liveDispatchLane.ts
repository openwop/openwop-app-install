/**
 * ADR 0889 D3 — the ONE composition of a live, runless agent dispatch.
 *
 * Extracted verbatim from `POST /host/openwop-app/agents/:agentId/dispatch`
 * (`routes/agents.ts`) so the eval runner composes the SAME lane instead of a
 * copy: identity, the scoped tool provider (ADR 0830 D1), memory, knowledge,
 * borrowed recall (ADR 0044), compaction (ADR 0099) and the lane firewall
 * (ADR 0834). The route's behaviour is unchanged; every comment below that
 * explains a past defect moved with its line.
 *
 * The eval runner then substitutes only what an eval must not share with
 * production (ADR 0889 D3): the model pin, the memory port (an ephemeral
 * per-trial store seeded from `fixtures.memorySeed`), and the tool executor
 * (the fixture interceptor). Every substitution is an explicit override here,
 * so the default path is byte-for-byte the route's.
 */
import type { LiveDispatchDeps, AgentMemoryPort } from './agentDispatch.js';
import { stampRunStartContext } from './runStartContext.js';
import { readCompactionDecision } from '../executor/compaction.js';
import { createAiProvidersAdapter } from '../aiProviders/aiProvidersHost.js';
import { createScopedAgentToolProvider } from './agentToolProvider.js';
import { buildLaneFirewall } from './laneFirewall.js';
import { createAgentMemoryPort, agentMemoryScope } from './agentMemoryAdapter.js';
import { resolveAgentIdentity } from './agentIdentity.js';
import { resolveAgentKnowledgeRetrieve } from './agentKnowledgeComposition.js';
import { getBorrowedRecallResolver } from './twinRecallSurface.js';
import { createLogger } from '../observability/logger.js';
import type { ResolveModelOptions } from './modelClassResolver.js';

const log = createLogger('host.liveDispatchLane');

type Adapter = ReturnType<typeof createAiProvidersAdapter>;
type AdapterEmit = (type: string, payload: unknown) => Promise<{ eventId: string; sequence: number }>;

export interface LiveDispatchLaneInput {
  tenantId: string;
  /** The addressed id (registry id on the dispatch route) — ADR 0775 D3. */
  agentId: string;
  /** Minted ONCE per dispatch and shared by the adapter, the borrowed-recall
   *  audit row and the firewall resource (RCL-3(b)). */
  dispatchRunId: string;
  /** The acting subject (`callerSubject(req)`) — ADR 0830 D1. */
  actingUserId?: string;
  personalTenant?: string;
  /** The session's own user, when one exists (borrowed recall + knowledge reader). */
  userId?: string;
  policyResolver?: Parameters<typeof createAiProvidersAdapter>[0]['policyResolver'];
  /** The adapter's node id (`agent.dispatch` on the route; per trial in an eval). */
  nodeId?: string;
  /** Sink for `provider.usage` and other adapter events (absent ⇒ not emitted, as on the route). */
  emit?: AdapterEmit;
  /** ADR 0889 — overrides. Absent ⇒ the route's behaviour. */
  modelOptions?: ResolveModelOptions;
  credentialRef?: string;
  secrets?: Record<string, string>;
  memory?: AgentMemoryPort;
  wrapExecuteTool?: (inner: NonNullable<LiveDispatchDeps['executeTool']>) => NonNullable<LiveDispatchDeps['executeTool']>;
  /** ADR 0889 A6 — a run-bound caller (the eval runner) passes its run's FROZEN
   *  decision; absent ⇒ the runless resolution below (the dispatch route). */
  compaction?: ReturnType<typeof readCompactionDecision>;
  /** ADR 0889 grade remediation (WF-EV-2) — the caller's abort. Once it fires, no
   *  further model round or tool call starts, and an in-flight one is abandoned
   *  (its promise rejects with the signal's reason). The adapter takes no signal,
   *  so an in-flight provider fetch runs to its own timeout; its result is dropped.
   *  Absent ⇒ the route's behaviour. */
  signal?: AbortSignal;
  /** ADR 0889 grade remediation (EVAL-12) — `false` skips the ADR 0044 borrowed
   *  recall. An eval trial is not a real dispatch: it must neither read the owner's
   *  corpus nor write a consent-ledger audit row per trial. Absent ⇒ resolved. */
  borrowedRecall?: boolean;
}

/** Guard one async call with `signal`: refused once aborted, abandoned when it fires mid-flight. */
export function guardWithSignal<A extends unknown[], R>(signal: AbortSignal, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    if (signal.aborted) throw signal.reason;
    const pending = fn(...args);
    // The abandoned call may still reject later; never let that surface as unhandled.
    pending.catch(() => undefined);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([pending, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  };
}

export interface LiveDispatchLane {
  deps: LiveDispatchDeps;
  compaction?: ReturnType<typeof readCompactionDecision>;
  adapter: Adapter;
}

export async function buildLiveDispatchLane(input: LiveDispatchLaneInput): Promise<LiveDispatchLane> {
  const { tenantId, dispatchRunId } = input;
  const adapter = createAiProvidersAdapter({
    runId: dispatchRunId,
    nodeId: input.nodeId ?? 'agent.dispatch',
    tenantId,
    attempt: 1,
    secrets: input.secrets ?? {},
    policyResolver: input.policyResolver,
    ...(input.emit ? { emit: input.emit } : {}),
  } as Parameters<typeof createAiProvidersAdapter>[0]);
  // A2 — wire the host's built-in tool catalog + executor so a tool-using
  // turn runs end-to-end. ADR 0277 P2 — normalize once: the profile id scopes
  // the knowledge tools; the memory scope + knowledge composition key off it too.
  const dispatchIdentity = await resolveAgentIdentity(tenantId, input.agentId, { allowReverseScan: true });
  // ADR 0830 D1 — through the ONE scope composer (ADR 0324), WITH the caller. A
  // hand-rolled literal carried no `actingUserId`, so every tool on this lane ran
  // as a system run (tenant-trusted) for any signed-in caller —
  // `openwop:knowledge.search` included, which then read every org's KB.
  const toolProvider = createScopedAgentToolProvider({
    tenantId, runId: input.agentId, agentProfileId: dispatchIdentity.profileId,
    ...(input.actingUserId ? { actingUserId: input.actingUserId } : {}),
    ...(input.personalTenant ? { personalTenant: input.personalTenant } : {}),
  } as Parameters<typeof createScopedAgentToolProvider>[0]);
  // ADR 0889 D3 — an eval passes its own ephemeral port; production keeps the
  // durable agent memory.
  const memory = input.memory ?? createAgentMemoryPort(tenantId);
  const memoryScope = agentMemoryScope(dispatchIdentity.profileId);
  // ADR 0038 Phase 3 — compose the agent's BOUND knowledge (cited KB docs +
  // private memory) into the turn. ADR 0664 D6 — re-resolve the READER where a
  // principal exists. `actor` stays undefined: per-user memory posture unchanged.
  const knowledgeRetrieve = await resolveAgentKnowledgeRetrieve(
    tenantId, dispatchIdentity.profileId, memory, undefined,
    input.userId ? { subject: input.userId } : undefined,
  );
  // ADR 0044 Phase 2 — a granted twin composes its OWNER's corpus, fenced
  // structurally by dispatch. WF-TWIN-5 — keyed by the RESOLVED profile id.
  // ADR 0666 D5 — its OWN catch, degrading to the fault sentinel rather than
  // failing the request (a faulted authorization read must not present as
  // "not granted").
  const borrowedResolver = input.borrowedRecall === false ? null : getBorrowedRecallResolver();
  let borrowedSource: Awaited<ReturnType<NonNullable<typeof borrowedResolver>>>;
  try {
    borrowedSource = borrowedResolver
      ? await borrowedResolver(tenantId, dispatchIdentity.profileId, {
          ...(input.userId ? { callerUserId: input.userId } : {}),
          runId: dispatchRunId,
        })
      : undefined;
  } catch (err) {
    log.warn('twin_recall_resolve_failed_degrading', {
      tenantId, agentId: dispatchIdentity.profileId, runId: dispatchRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    borrowedSource = { retrieve: async (_q, onSourceError) => { onSourceError?.('kb'); return []; }, ownerUserId: '' };
  }
  const borrowedRetrieve = borrowedSource?.retrieve;
  // ADR 0099 §residuals — this dispatch is RUNLESS, so resolve the compaction
  // decision through the SAME core run-start seam.
  const compactionMeta = await stampRunStartContext({}, { tenantId, agentId: input.agentId });
  const compaction = readCompactionDecision(compactionMeta);
  const effectiveCompaction = 'compaction' in input ? input.compaction : compaction;
  // CFP Phase-2 HIGH-1 / ADR 0834 D1 — the ONE lane factory gates every tool this
  // lane can execute (always safe here: no interactive user).
  const { hook: firewall } = await buildLaneFirewall({ tenantId, lane: 'dispatch', resource: dispatchRunId, dedupeKey: dispatchRunId });
  const wrapped = input.wrapExecuteTool ? input.wrapExecuteTool(toolProvider.executeTool) : toolProvider.executeTool;
  const { signal } = input;
  const executeTool = signal ? guardWithSignal(signal, wrapped) : wrapped;
  const deps: LiveDispatchDeps = {
    callAI: signal ? guardWithSignal(signal, adapter.callAI) : adapter.callAI,
    callAIWithTools: signal ? guardWithSignal(signal, adapter.callAIWithTools) : adapter.callAIWithTools,
    resolveTool: toolProvider.resolveTool,
    executeTool,
    // ADR 0102 — per-tool permission gate (shadow-logged until enabled).
    tenantId,
    // ADR 0775 D3 — the addressed id, so every roster member sharing it binds.
    agentAddressedId: input.agentId,
    // A4 — cross-run agent memory (RFC 0004), gated inside dispatch on the
    // manifest's `memoryShape.longTerm`.
    memory,
    memoryScope,
    ...(knowledgeRetrieve ? { knowledgeRetrieve } : {}),
    ...(borrowedRetrieve ? { borrowedRetrieve } : {}),
    ...(borrowedSource?.ownerName ? { borrowedOwnerName: borrowedSource.ownerName } : {}),
    firewall,
    ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
    ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
  } as LiveDispatchDeps;
  return { deps, ...(effectiveCompaction ? { compaction: effectiveCompaction } : {}), adapter };
}
