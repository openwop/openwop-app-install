/**
 * ADR 0773 — the builder-pair chat-time tools (lane 1 of the three-lane rule),
 * registered through the ADR 0308 D2 `registerFeatureAgentTool` seam and
 * allowlisted on the Workflow Architect agent pack only (never added to the
 * ADR 0315 default-on baseline).
 *
 *  - `read-canvas`   — read BEFORE write: the paired workflow's head (fresh, with
 *                      its revision), the user's selection, the last run's digest.
 *  - `suggest-edits` — propose typed ops against that revision. Stores a
 *                      `WorkflowEditSuggestion`; NEVER writes the workflow.
 *
 * Both key off the tool scope's `conversationId` (the chat session, threaded
 * from `run.metadata.chatSessionId`). That id is CLIENT-supplied, so it is never
 * trusted alone: every pairing row and suggestion is keyed by the ACTING USER
 * too, and bound to the conversation RUN (`boundRunId`) so a fork is refused.
 * Refusals are typed results, never throws and never success-with-empty (the
 * AI-exchange non-negotiable).
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { Storage } from '../../storage/storage.js';
import { EDIT_OP_KINDS, MAX_OPS_PER_SUGGESTION } from './editOps.js';
import { readCanvas, suggestEdits, type PairRefusal } from './pairService.js';

/** ADR 0773 B.7 — the follow-up the chat loop sends when a turn stops with the
 *  plan unfinished (`null` once it is finished, which clears a pending one). */
export function planContinuation(drawn: number, planned: number | undefined): string | null {
  if (!planned || drawn >= planned) return null;
  return `You planned ${planned} ops and have drawn ${drawn}. Draw the next batch now with suggest-edits `
    + '(`mode: "append"`, up to 3 ops, each with a `why`). If the plan changed, say what changed and give your final answer instead.';
}

export const BUILDER_PAIR_READ_CANVAS_TOOL_ID = 'openwop:feature.builder-pair.nodes.read-canvas';
export const BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID = 'openwop:feature.builder-pair.nodes.suggest-edits';
export const BUILDER_PAIR_TOOL_IDS = [BUILDER_PAIR_READ_CANVAS_TOOL_ID, BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID] as const;

const refusalResult = (r: PairRefusal): { content: string; isError: true } => ({
  content: JSON.stringify({ error: r.code, message: r.message, ...(r.details ?? {}) }),
  isError: true,
});

const whoOf = (scope: BundleScope): { tenantId: string; actingUserId?: string; personalTenant?: string } => ({
  tenantId: scope.tenantId,
  ...(scope.actingUserId ? { actingUserId: scope.actingUserId } : {}),
  ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}),
});

/** The op-kind input schema, generated from the SSoT `EDIT_OP_KINDS` (the
 *  model is never told about an op the host does not accept). */
export const SUGGEST_EDITS_OPS_SCHEMA = {
  type: 'array',
  maxItems: MAX_OPS_PER_SUGGESTION,
  items: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...EDIT_OP_KINDS] },
      ref: { type: 'string', description: 'addNode only: a local handle for the new node. Other ops in this call may use it as nodeId/source/target.' },
      why: { type: 'string', description: 'Optional, one sentence (≤ 280 chars): why this op — shown to the user beside it. Give it for any op that is not self-evident.' },
      typeId: { type: 'string', description: 'addNode only: a typeId from the node catalog (closed world).' },
      name: { type: 'string', description: 'addNode / renameNode: the node label.' },
      config: { type: 'object', description: 'addNode only: initial config.' },
      position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
      nodeId: { type: 'string', description: 'removeNode / setConfig / renameNode: an existing nodeId, or the ref of a node this call adds.' },
      path: { type: 'string', description: 'setConfig only: a dotted config path, e.g. "retry.maxAttempts".' },
      value: { description: 'setConfig only: the new value (omit or null to clear).' },
      source: { type: 'string', description: 'addEdge only: source nodeId or ref.' },
      target: { type: 'string', description: 'addEdge only: target nodeId or ref.' },
      sourceOutput: { type: 'string' },
      targetInput: { type: 'string' },
      edgeId: { type: 'string', description: 'removeEdge / setCondition: an existing edgeId.' },
      condition: {
        description: 'addEdge / setCondition: { path, op, value? }. op is eq|neq|truthy|falsy|exists|contains; truthy/falsy/exists take NO value. setCondition with null removes the condition.',
      },
      label: { type: 'string' },
    },
    required: ['kind'],
  },
} as const;

export function registerBuilderPairAgentTools(storage: Storage): void {
  registerFeatureAgentTool({
    // UNTRUSTED: returns stored, user- and pack-authored definition text.
    contentTrust: 'untrusted',
    effect: 'read', // ADR 0784: the one-time pairing bind is bookkeeping, not a change
    // The definition is the ground truth the next write is validated against;
    // an elided node list would make the model suggest against a fiction.
    schemaCarrying: true,
    def: {
      name: BUILDER_PAIR_READ_CANVAS_TOOL_ID,
      description:
        'Read the workflow the user has open in the builder: its full definition, its `revision`, the nodes/edges the user '
        + 'has SELECTED (what "this" refers to), and a digest of the last run they are looking at. ALWAYS call this before '
        + 'suggest-edits — suggestions are checked against the revision it returns. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope: BundleScope) {
      const out = await readCanvas(storage, whoOf(scope), scope.conversationId, scope.runId);
      if ('refused' in out) return refusalResult(out);
      return { content: JSON.stringify(out) };
    },
  });

  registerFeatureAgentTool({
    // UNTRUSTED: the op summaries echo node names read from the stored,
    // user-authored definition (RFC 0137 §F1 — joining the trusted set would
    // leave that text unfenced on the chat path).
    contentTrust: 'untrusted',
    effect: 'write',
    def: {
      name: BUILDER_PAIR_SUGGEST_EDITS_TOOL_ID,
      description:
        'Suggest changes to the open workflow as a list of typed ops. The user sees them drawn on the canvas and keeps or '
        + 'drops each one — this NEVER changes the workflow by itself. Pass `baseRevision` from read-canvas. Prefer the '
        + 'SMALLEST correct change (an edge condition beats a new node). Do not touch an approval gate unless the user asked. '
        + 'A new call replaces your previous suggestion in this conversation. On `invalid_ops`, fix every listed op and call '
        + 'once more; on `workflow_head_moved`, call read-canvas again first. Returns { suggestionId, ops[] } — tell the user '
        + 'what you drew in one or two sentences.',
      inputSchema: {
        type: 'object',
        properties: {
          baseRevision: { type: 'string', description: 'The `revision` read-canvas returned.' },
          summary: { type: 'string', description: 'One sentence: what this change does.' },
          ops: SUGGEST_EDITS_OPS_SCHEMA,
          mode: {
            type: 'string', enum: ['replace', 'append'],
            description: 'append = add these ops to your CURRENT suggestion in this conversation (draft a larger change in batches of ≤ 3 ops so the user watches it land). New ops may reference nodes an earlier batch added by the nodeId it returned. Default replace.',
          },
          plannedOps: { type: 'integer', description: 'how many ops you expect to place in total (for the "placing n of N" progress). REQUIRED on the first batch of a first draft on an empty canvas.' },
          followUps: {
            type: 'array', maxItems: 3, items: { type: 'string' },
            description: 'Up to three short follow-up asks the user might want next (e.g. "Test with a 95-score lead").',
          },
        },
        required: ['baseRevision', 'ops'],
      },
    },
    async run(input, scope: BundleScope) {
      const out = await suggestEdits(whoOf(scope), scope.conversationId, scope.runId, input);
      if ('refused' in out) return refusalResult(out);
      // ADR 0773 B.7 — the plan is not finished: tell the chat loop, which
      // asks the model once to keep drawing if it stops here. MEASURED: a first
      // draft planned 7 ops and stopped after 2 in 2 of 3 managed-tier runs.
      return { content: JSON.stringify(out), continueTurn: planContinuation(out.drawn, out.planned) };
    },
  });
}
