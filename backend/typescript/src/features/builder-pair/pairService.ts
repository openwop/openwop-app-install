/**
 * ADR 0773 — builder-pair service: the pairing context, the canvas read, and
 * the edit-suggestion lane. Routes and chat-time tools are thin wrappers over
 * these functions, so the two cannot disagree about what is allowed.
 *
 * The invariant this file exists to hold: **the AI never writes the workflow.**
 * `suggestEdits` validates ops against the head and stores a suggestion; the
 * workflow changes only when the builder applies a kept op through its own
 * store and CAS autosave (ADR 0770 D5).
 */

import { randomUUID } from 'node:crypto';
import type { Storage } from '../../storage/storage.js';
import type { WorkflowDefinition } from '../../executor/types.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { hasWorkflowScope } from '../../host/workflowWriteAuthority.js';
import { readRegisteredWorkflowFresh, getRegisteredWorkflowAsync } from '../../host/workflowsRegistry.js';
import { WORKFLOW_ID_PATTERN } from '../../host/workflowDefinitionValidation.js';
import { revisionHashOf } from '../../host/definitionHash.js';
import { runnableNodeTypeIds } from '../../host/nodeCatalogBuilder.js';
import { currentEffectContext } from '../../host/runEffectContext.js';
import { resolveRunDigests, renderRunDigests } from '../../host/exchange/runDigests.js';
import { readAuthoredWorkflow, validateAuthoredWorkflow } from '../workflow-author/workflowAuthorService.js';
import { applyEditOps, normalizeEditOps, type OpError } from './editOps.js';
import { getChain, expandChain } from '../../host/workflowChainPackLoader.js';
import { getConversationMeta, setConversationCapabilityScope } from '../../host/conversationStore.js';
import { intersectScopes } from '../conversation-tools/scopeResolver.js';
import { PAIR_TOOL_SCOPE } from './pairToolScope.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('builder-pair');
import {
  getPairContext, putPairContext, getSuggestion, putSuggestion, updateSuggestion,
  type PairContext, type PairSelection, type WorkflowEditSuggestion, type OpState, type SuggestionVisibility,
} from './pairStores.js';

export const BUILDER_PAIR_TOGGLE_ID = 'builder-pair';

/** A refusal the caller reports (tool) or maps to HTTP (route). Never thrown. */
export interface PairRefusal {
  refused: true;
  code: 'feature_disabled' | 'acting_user_required' | 'no_pairing_context' | 'replay_refused' | 'forbidden' | 'not_found' | 'workflow_head_moved' | 'invalid_ops' | 'validation_error';
  message: string;
  details?: Record<string, unknown>;
}
const refuse = (code: PairRefusal['code'], message: string, details?: Record<string, unknown>): PairRefusal =>
  ({ refused: true, code, message, ...(details ? { details } : {}) });

export type WorkflowScope = 'workspace:read' | 'workspace:write';

export interface PairWho {
  tenantId: string;
  actingUserId?: string | undefined;
  personalTenant?: string | undefined;
  /**
   * Scopes an HTTP route ALREADY granted through the ADR 0770 D1 request gate
   * (`requireWorkflowRead`/`requireWorkflowWrite`), which classifies by
   * credential provenance — an `owk_` key or tenant-owner key has no member row,
   * so re-asking the subject-shaped {@link hasWorkflowScope} would wrongly
   * refuse it. Tools never set this: they always ask the subject predicate.
   */
  granted?: ReadonlySet<WorkflowScope>;
}

/** The ONE authority question every service function asks (Architect review A5). */
async function can(who: PairWho, scope: WorkflowScope): Promise<boolean> {
  if (who.granted?.has(scope)) return true;
  return hasWorkflowScope(who, scope);
}

export async function builderPairEnabled(who: PairWho): Promise<boolean> {
  const a = await resolveOne(BUILDER_PAIR_TOGGLE_ID, { tenantId: who.tenantId, ...(who.actingUserId ? { userId: who.actingUserId } : {}) }).catch(() => null);
  return !!a?.enabled;
}

/** The revision of a workflow that does not exist yet (a new, never-saved draft). */
export const EMPTY_REVISION = 'absent';

/**
 * The tenant-guarded head: the caller's own (or a built-in) workflow, read FRESH.
 * A workflow id nobody has registered yet is an EMPTY draft — a brand-new builder
 * workflow with no nodes cannot save (the serializer refuses an empty graph), so
 * without this the empty-sheet first draft could never pair (review CR-1). An id
 * that EXISTS but is not readable by this tenant is a miss, never an empty draft.
 */
async function readHead(tenantId: string, workflowId: string): Promise<{ def: WorkflowDefinition; revision: string } | null> {
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) return null;
  const owned = await readAuthoredWorkflow(workflowId, { tenantId });
  if (!owned.found) {
    if (await getRegisteredWorkflowAsync(workflowId)) return null; // exists, not yours
    return { def: { workflowId, nodes: [], edges: [] }, revision: EMPTY_REVISION };
  }
  const fresh = await readRegisteredWorkflowFresh(workflowId);
  const def = fresh.def ?? owned.definition;
  return { def, revision: revisionHashOf(def) };
}

const uniqStrings = (v: unknown, cap: number): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200))].slice(0, cap) : [];

/**
 * ADR 0773 D2 — record what the builder is showing. Ids the head does not
 * contain are DROPPED and reported, never trusted; `lastRunId` must be a run of
 * this workflow in this tenant (else dropped).
 */
export async function writePairContext(
  storage: Storage,
  who: PairWho,
  body: { conversationId: string; workflowId: string; selection?: unknown; lastRunId?: unknown; conversationRunId?: unknown },
): Promise<PairContext | PairRefusal> {
  if (!who.actingUserId) return refuse('acting_user_required', 'Pairing needs a signed-in user.');
  if (!(await can(who, 'workspace:read'))) return refuse('forbidden', 'Missing required scope: workspace:read');
  const head = await readHead(who.tenantId, body.workflowId);
  if (!head) return refuse('not_found', 'Workflow not found.');
  const sel = (body.selection ?? {}) as { nodeIds?: unknown; edgeIds?: unknown };
  const wantNodes = uniqStrings(sel.nodeIds, 100);
  const wantEdges = uniqStrings(sel.edgeIds, 100);
  const nodeIds = new Set(head.def.nodes.map((n) => n.nodeId));
  const edgeIds = new Set((head.def.edges ?? []).map((e) => e.edgeId));
  const selection: PairSelection = {
    nodeIds: wantNodes.filter((id) => nodeIds.has(id)),
    edgeIds: wantEdges.filter((id) => edgeIds.has(id)),
  };
  const droppedIds = [...wantNodes.filter((id) => !nodeIds.has(id)), ...wantEdges.filter((id) => !edgeIds.has(id))];
  let lastRunId: string | undefined;
  if (typeof body.lastRunId === 'string' && body.lastRunId) {
    const run = await storage.getRun(body.lastRunId).catch(() => null);
    if (run && run.tenantId === who.tenantId && run.workflowId === body.workflowId) lastRunId = run.runId;
  }
  // CR-4 — keep the run binding across sends; the client re-binds only to the
  // run it actually holds (a fork's run id is never one a client holds).
  const prior = await getPairContext(who.tenantId, who.actingUserId, body.conversationId);
  const clientRun = typeof body.conversationRunId === 'string' && body.conversationRunId ? body.conversationRunId : undefined;
  const boundRunId = clientRun ?? prior?.boundRunId;
  const ctx: PairContext = {
    tenantId: who.tenantId, userId: who.actingUserId, conversationId: body.conversationId, workflowId: body.workflowId,
    selection, droppedIds, ...(lastRunId ? { lastRunId } : {}), ...(boundRunId ? { boundRunId } : {}),
    updatedAt: new Date().toISOString(),
  };
  await putPairContext(ctx);
  try {
    await narrowToPairTools(who.tenantId, body.conversationId);
  } catch (err) {
    // The context is stored and the send must not be blocked for a cost
    // optimisation: the turn runs on the full tool list. Logged, because a
    // silent fallback is how the per-round cost regresses unseen.
    log.warn('pair_tool_scope_write_failed', { conversationId: body.conversationId, error: err instanceof Error ? err.message : String(err) });
  }
  return ctx;
}

/**
 * ADR 0773 B.2 — a paired conversation is offered only the Pair tools
 * (`pairToolScope.ts`). Written as the ADR 0132 capability scope, INTERSECTED
 * with whatever scope the conversation already has, so it never widens one. The
 * write is skipped when the scope already equals the result (every send calls
 * this). Called after the pairing context is stored; on failure the caller
 * logs and the turn runs on the full tool list (dearer, never wrong).
 */
async function narrowToPairTools(tenantId: string, conversationId: string): Promise<void> {
  const existing = (await getConversationMeta(tenantId, conversationId))?.capabilityScope;
  const next = intersectScopes(existing, { mode: 'restricted', enabled: [...PAIR_TOOL_SCOPE] });
  if (JSON.stringify(existing) === JSON.stringify(next)) return;
  await setConversationCapabilityScope(tenantId, conversationId, next);
}

/**
 * Shared tool preamble: toggle, acting user, pairing context for THIS
 * conversation, and the run binding (review CR-4). The ambient replay context is
 * NOT set on the chat tool loop's path, so it cannot be the fork guard; the run
 * binding is: the first tool call of the live run binds it, and a `:fork` — which
 * copies `chatSessionId` but runs under a new run id — is refused.
 */
async function toolPreamble(who: PairWho, conversationId: string | undefined, runId: string | undefined): Promise<PairContext | PairRefusal> {
  if (!(await builderPairEnabled(who))) return refuse('feature_disabled', 'Builder pairing is not enabled for this workspace.');
  if (!who.actingUserId) return refuse('acting_user_required', 'Canvas tools run only in a human-initiated turn.');
  if (!conversationId) return refuse('no_pairing_context', 'This conversation is not paired with an open builder.');
  const ctx = await getPairContext(who.tenantId, who.actingUserId, conversationId);
  if (!ctx) return refuse('no_pairing_context', 'This conversation is not paired with an open builder. Ask the user to open the workflow in the builder and use the Pair tab.');
  if (runId) {
    if (ctx.boundRunId && ctx.boundRunId !== runId) {
      return refuse('replay_refused', 'This run is not the conversation the builder is paired with (a fork or replay never touches a live canvas).');
    }
    if (!ctx.boundRunId) {
      const bound: PairContext = { ...ctx, boundRunId: runId };
      await putPairContext(bound);
      return bound;
    }
  }
  return ctx;
}

export interface CanvasRead {
  workflowId: string;
  name?: string;
  revision: string;
  definition: WorkflowDefinition;
  selection: PairSelection;
  droppedIds: string[];
  lastRun?: { runId: string; digest: string };
}

/** ADR 0773 D2 — `read-canvas`: the head (fresh, with its revision) + the selection. */
export async function readCanvas(storage: Storage, who: PairWho, conversationId: string | undefined, runId?: string): Promise<CanvasRead | PairRefusal> {
  const ctx = await toolPreamble(who, conversationId, runId);
  if ('refused' in ctx) return ctx;
  if (!(await can(who, 'workspace:read'))) return refuse('forbidden', 'Missing required scope: workspace:read');
  const head = await readHead(who.tenantId, ctx.workflowId);
  if (!head) return refuse('not_found', 'The paired workflow no longer exists.');
  const name = typeof head.def.metadata?.name === 'string' ? head.def.metadata.name : undefined;
  let lastRun: CanvasRead['lastRun'];
  if (ctx.lastRunId) {
    const digests = await resolveRunDigests(storage, { tenantId: who.tenantId, refs: [{ runId: ctx.lastRunId, ts: Date.now(), source: 'turn' }] });
    const rendered = renderRunDigests(digests, [ctx.lastRunId]).get(ctx.lastRunId);
    if (rendered) lastRun = { runId: ctx.lastRunId, digest: rendered };
  }
  return {
    workflowId: ctx.workflowId, ...(name ? { name } : {}), revision: head.revision, definition: head.def,
    selection: ctx.selection, droppedIds: ctx.droppedIds, ...(lastRun ? { lastRun } : {}),
  };
}

export interface SuggestResult {
  suggestionId: string;
  workflowId: string;
  baseRevision: string;
  /** `nodeId` = the id minted for an `addNode` — a LATER append batch may
   *  reference it as an existing node (G-05a). */
  ops: Array<{ index: number; summary: string; gateSensitive: boolean; dependsOn: number[]; nodeId?: string }>;
  mode: 'replace' | 'append';
  /** ADR 0773 B.7 — the suggestion's progress: ops drawn so far (all batches)
   *  and the total the first batch declared. `planned` is absent when none was. */
  drawn: number;
  planned?: number;
}

const MAX_FOLLOW_UPS = 3;
const followUpsOf = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 120)).slice(0, MAX_FOLLOW_UPS);
  return out.length > 0 ? out : undefined;
};

/**
 * ADR 0773 D4 — `suggest-edits`. Validates the op list closed-world against the
 * CURRENT head and stores it as this conversation's suggestion. Never writes
 * the workflow. Refused inside a replay fork (Architect review A1): a `:fork`
 * re-fires the conversation's tool calls, and a suggestion drawn by a replay
 * would land on a live user's canvas.
 */
export async function suggestEdits(
  who: PairWho,
  conversationId: string | undefined,
  runId: string | undefined,
  input: { baseRevision?: unknown; ops?: unknown; summary?: unknown; mode?: unknown; followUps?: unknown; plannedOps?: unknown },
): Promise<SuggestResult | PairRefusal> {
  // Belt: refuse inside an executor replay context. The braces are the run
  // binding in `toolPreamble` — the chat tool loop runs OUTSIDE any effect
  // context, so this line alone guards nothing there (review CR-4).
  if (currentEffectContext()?.replaying) return refuse('replay_refused', 'A replay fork never draws a new suggestion.');
  const ctx = await toolPreamble(who, conversationId, runId);
  if ('refused' in ctx) return ctx;
  if (!(await can(who, 'workspace:write'))) {
    return refuse('forbidden', 'This user can view but not edit this workflow, so suggestions are off. Answer or explain instead.');
  }
  const head = await readHead(who.tenantId, ctx.workflowId);
  if (!head) return refuse('not_found', 'The paired workflow no longer exists.');
  if (typeof input.baseRevision !== 'string' || input.baseRevision !== head.revision) {
    return refuse('workflow_head_moved', 'The workflow changed since you read it. Call read-canvas again, then suggest against the new revision.', { revision: head.revision });
  }
  // G-05a — append a batch to THIS conversation's suggestion for THIS head, so a
  // draft lands in visible steps. Anything else (no prior, another workflow, a
  // moved head) starts a fresh suggestion.
  const prior = input.mode === 'append'
    ? await getSuggestion(who.tenantId, who.actingUserId as string, ctx.conversationId)
    : null;
  const appending = !!prior && prior.workflowId === ctx.workflowId && prior.baseRevision === head.revision;
  const suggestionId = appending ? prior.id : randomUUID().replace(/-/g, '').slice(0, 10);
  // ADR 0773 B.6 — a FIRST draft (empty canvas, not an append to a prior batch)
  // must say how many ops it plans. MEASURED: the prompt rule alone ("set
  // plannedOps on the first batch") was ignored in 3 of 3 eval runs on the
  // managed tier, so the user watched a draft land with no idea how much more
  // was coming. A typed refusal the model repairs inside the same turn, like any
  // other invalid op.
  if (!appending && head.def.nodes.length === 0
    && !(typeof input.plannedOps === 'number' && Number.isInteger(input.plannedOps) && input.plannedOps > 0)) {
    return refuse('invalid_ops', 'The suggestion was not stored. A first draft on an empty canvas must set `plannedOps` (the total number of ops you will draw) on its first batch; draw it in batches of up to 3 with `mode: "append"`.', {
      errors: [{ index: -1, message: 'plannedOps is required on the first batch of a first draft' }] satisfies OpError[],
    });
  }
  const priorOps = appending ? prior.ops : [];
  const priorMinted = new Map<string, number>();
  priorOps.forEach((o, i) => { if (o.op.kind === 'addNode') priorMinted.set(o.op.nodeId, i); });
  const legal = runnableNodeTypeIds();
  const norm = normalizeEditOps({
    suggestionId,
    head: appending ? applyEditOps(head.def, priorOps.map((o) => o.op)) : head.def,
    rawOps: input.ops,
    validate: (candidate) => validateAuthoredWorkflow(candidate),
    isKnownTypeId: (t) => legal.has(t),
    mintOffset: priorOps.length,
    indexOffset: priorOps.length,
    priorMinted,
  });
  if (!norm.ok) {
    return refuse('invalid_ops', 'The suggestion was not stored. Fix every listed op and call suggest-edits once more.', { errors: norm.errors satisfies OpError[] });
  }
  const now = new Date().toISOString();
  const followUps = followUpsOf(input.followUps) ?? (appending ? prior.followUps : undefined);
  const planned = typeof input.plannedOps === 'number' && Number.isInteger(input.plannedOps) && input.plannedOps > 0
    ? Math.min(input.plannedOps, 200) : (appending ? prior.plannedOps : undefined);
  const s: WorkflowEditSuggestion = {
    id: suggestionId, tenantId: who.tenantId, workflowId: ctx.workflowId, conversationId: ctx.conversationId,
    requestedBy: who.actingUserId as string, baseRevision: head.revision,
    summary: typeof input.summary === 'string' ? input.summary.slice(0, 500) : (appending ? prior.summary : ''),
    ops: [...priorOps, ...norm.ops],
    opState: [...(appending ? prior.opState : []), ...norm.ops.map(() => 'pending' as const)],
    visibility: appending ? prior.visibility : 'private', source: 'architect',
    ...(followUps ? { followUps } : {}), ...(planned ? { plannedOps: planned } : {}),
    createdAt: appending ? prior.createdAt : now, updatedAt: now,
  };
  await putSuggestion(s);
  return {
    suggestionId, workflowId: s.workflowId, baseRevision: s.baseRevision, mode: appending ? 'append' : 'replace',
    ops: norm.ops.map((o, k) => ({
      index: priorOps.length + k, summary: o.summary, gateSensitive: o.gateSensitive, dependsOn: o.dependsOn,
      ...(o.op.kind === 'addNode' ? { nodeId: o.op.nodeId } : {}),
    })),
    drawn: s.ops.length,
    ...(planned ? { planned } : {}),
  };
}

/**
 * ADR 0773 G-05d — a chain template drawn as a GHOST suggestion on an empty
 * draft. The chain is expanded exactly as `from-chain` expands it (Path A,
 * params frozen), then turned into addNode/addEdge ops — `inputs` and
 * `triggerRule` carried so no frozen param is dropped. Nothing is registered: the
 * user keeps it into their canvas, and the ordinary autosave writes it.
 * Chains with sub-chains are refused (they need ADR 0770 D3's co-registration —
 * the gallery's `from-chain` is their path).
 */
export async function suggestFromChain(
  who: PairWho,
  body: { conversationId: string; workflowId: string; chainId: string; params?: unknown },
): Promise<SuggestResult | PairRefusal> {
  if (!who.actingUserId) return refuse('acting_user_required', 'Sign in to start from a template.');
  if (!(await can(who, 'workspace:write'))) return refuse('forbidden', 'Missing required scope: workspace:write');
  const head = await readHead(who.tenantId, body.workflowId);
  if (!head) return refuse('not_found', 'Workflow not found.');
  if (head.def.nodes.length > 0) return refuse('validation_error', 'A template can only be drawn onto an empty workflow.');
  const found = getChain(body.chainId);
  if (!found) return refuse('not_found', 'Workflow template not found.');
  if (found.chain.subChains?.length) {
    return refuse('validation_error', 'This template contains nested workflows; open it from the gallery instead.');
  }
  const params = (body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {}) as Record<string, unknown>;
  // A missing REQUIRED param would freeze to '' and the node would SUCCEED on
  // empty input (ADR 0507's fabrication class) — refuse instead of drawing it.
  const required = Array.isArray((found.chain.parameters as { required?: unknown }).required)
    ? ((found.chain.parameters as { required: unknown[] }).required.filter((k): k is string => typeof k === 'string'))
    : [];
  const missing = required.filter((k) => params[k] === undefined || params[k] === '');
  if (missing.length > 0) {
    return refuse('validation_error', `This template needs inputs (${missing.join(', ')}); open it from the gallery to fill them in.`, { missing });
  }
  let expanded: WorkflowDefinition;
  try {
    expanded = expandChain(found.chain, { params });
  } catch (err) {
    return refuse('validation_error', err instanceof Error ? err.message : 'The template could not be expanded.');
  }
  const rawOps = [
    ...expanded.nodes.map((n) => ({
      kind: 'addNode', ref: n.nodeId, typeId: n.typeId, ...(n.name ? { name: n.name } : {}),
      ...(n.config ? { config: n.config } : {}), ...(n.inputs ? { inputs: n.inputs } : {}), ...(n.position ? { position: n.position } : {}),
    })),
    ...(expanded.edges ?? []).map((e) => ({
      kind: 'addEdge', source: e.sourceNodeId, target: e.targetNodeId,
      ...(e.sourceOutput ? { sourceOutput: e.sourceOutput } : {}), ...(e.targetInput ? { targetInput: e.targetInput } : {}),
      ...(e.condition ? { condition: e.condition } : {}), ...(e.label ? { label: e.label } : {}), ...(e.triggerRule ? { triggerRule: e.triggerRule } : {}),
    })),
  ];
  const suggestionId = randomUUID().replace(/-/g, '').slice(0, 10);
  const legal = runnableNodeTypeIds();
  const norm = normalizeEditOps({
    suggestionId, head: head.def, rawOps,
    validate: (candidate) => validateAuthoredWorkflow(candidate),
    isKnownTypeId: (t) => legal.has(t),
  });
  if (!norm.ok) return refuse('invalid_ops', 'The template could not be drawn on this workspace.', { errors: norm.errors });
  const now = new Date().toISOString();
  const s: WorkflowEditSuggestion = {
    id: suggestionId, tenantId: who.tenantId, workflowId: body.workflowId, conversationId: body.conversationId,
    requestedBy: who.actingUserId, baseRevision: head.revision,
    summary: found.chain.label ?? body.chainId, ops: norm.ops, opState: norm.ops.map(() => 'pending' as const),
    visibility: 'private', source: 'chain', createdAt: now, updatedAt: now,
  };
  await putSuggestion(s);
  return {
    suggestionId, workflowId: s.workflowId, baseRevision: s.baseRevision, mode: 'replace',
    ops: norm.ops.map((o, index) => ({ index, summary: o.summary, gateSensitive: o.gateSensitive, dependsOn: o.dependsOn })),
    drawn: s.ops.length, // a template is drawn whole: no plan to continue
  };
}

/** The caller's OWN suggestion for this conversation. Peers see a shared one only
 *  through the sanitized room listing (review CR-3). */
export async function readSuggestionFor(who: PairWho, conversationId: string): Promise<WorkflowEditSuggestion | null> {
  if (!who.actingUserId) return null;
  if (!(await can(who, 'workspace:read'))) return null;
  return getSuggestion(who.tenantId, who.actingUserId, conversationId);
}

const OP_STATES: ReadonlySet<string> = new Set(['pending', 'kept', 'dropped']);

/** Record keep/drop decisions and visibility. Requester only (a peer reads a shared suggestion; it never resolves one). */
export async function patchSuggestion(
  who: PairWho,
  conversationId: string,
  body: { opState?: unknown; visibility?: unknown; suggestionId?: unknown },
): Promise<WorkflowEditSuggestion | PairRefusal> {
  if (!who.actingUserId) return refuse('not_found', 'Suggestion not found.');
  const s = await getSuggestion(who.tenantId, who.actingUserId, conversationId);
  if (!s) return refuse('not_found', 'Suggestion not found.');
  if (typeof body.suggestionId === 'string' && body.suggestionId !== s.id) {
    return refuse('workflow_head_moved', 'That suggestion was superseded by a newer one.', { suggestionId: s.id });
  }
  if (!(await can(who, 'workspace:write'))) return refuse('forbidden', 'Missing required scope: workspace:write');
  const next: OpState[] = [...s.opState];
  if (Array.isArray(body.opState)) {
    for (const entry of body.opState as unknown[]) {
      const e = entry as { index?: unknown; state?: unknown };
      if (typeof e.index !== 'number' || !Number.isInteger(e.index) || e.index < 0 || e.index >= next.length) {
        return refuse('validation_error', `opState index ${String(e.index)} is out of range.`);
      }
      if (typeof e.state !== 'string' || !OP_STATES.has(e.state)) return refuse('validation_error', 'opState.state must be pending, kept or dropped.');
      next[e.index] = e.state as OpState;
    }
  }
  let visibility: SuggestionVisibility = s.visibility;
  if (body.visibility !== undefined) {
    if (body.visibility !== 'private' && body.visibility !== 'room') return refuse('validation_error', "visibility must be 'private' or 'room'.");
    visibility = body.visibility;
  }
  const updated: WorkflowEditSuggestion = { ...s, opState: next, visibility, updatedAt: new Date().toISOString() };
  await updateSuggestion(updated);
  return updated;
}
