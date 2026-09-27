/**
 * Assistant chat tools (CFP-1 / ADR 0308 seam; ADR 0023 substrate) — the
 * conversational agency for the three assistant personas (Chief of Staff,
 * Commitment Extractor, Reply Drafter) in the ONE chat.
 *
 * The port map (A1) found the personas TOOTHLESS: their allowlists declared
 * `feature.assistant.nodes.*` typeIds, but node typeIds are NOT auto-projected
 * into chat tools (`resolveTool` = `BUILTINS.get`), so every assistant-owned
 * action was silently dropped and the agents ran read-only. These tools restore
 * agency by REGISTERING the assistant-owned capabilities through the ONE
 * `registerFeatureAgentTool` seam — each a thin wrapper over the SAME
 * `ctx.features.assistant` surface method the scheduled loop nodes use (no new
 * logic, no parallel store). The action tools FEED the existing, well-built
 * approval/execution pipeline (they SUBMIT for approval — they never send).
 *
 * Authority parity (CFP-1 hard rule 1): the action tools share the write routes'
 * predicate. The routes gate mutations on `requireTenantScope(req,
 * 'workspace:write')` (routes.ts `wrapWrite`); the tools gate on the subject
 * sibling `hasAssistantWriteAuthority` — same scope token, same
 * `resolveSubjectScopesUnion` primitive, same fail-closed logic (the ADR 0458
 * CRITICAL-3 route↔tool parity pattern). Reads fail EMPTY without an acting user
 * (a scheduled/system turn must not enumerate a principal's graph); actions fail
 * TYPED. The assistant graduated OFF its toggle (always-on substrate — feature.ts
 * § Correction), so there is no per-tenant feature toggle to re-check here.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { hasAssistantWriteAuthority } from './writeAuthority.js';
import { buildAssistantSurface } from './surface.js';
import { PRIORITY_PROFILES } from './prioritization.js';
import { ENQUEUEABLE_ACTION_KINDS } from './assistantService.js';

export const ASSISTANT_LIST_COMMITMENTS_TOOL_ID = 'openwop:assistant.list-commitments';
export const ASSISTANT_LIST_PENDING_ACTIONS_TOOL_ID = 'openwop:assistant.list-pending-actions';
export const ASSISTANT_COMPOSE_BRIEFING_TOOL_ID = 'openwop:assistant.compose-briefing';
export const ASSISTANT_UPSERT_COMMITMENT_TOOL_ID = 'openwop:assistant.upsert-commitment';
export const ASSISTANT_POPULATE_BOARD_TOOL_ID = 'openwop:assistant.populate-board';
export const ASSISTANT_ENQUEUE_ACTION_TOOL_ID = 'openwop:assistant.enqueue-action';

/** The outbound action kinds the drafter/CoS may enqueue (the assistant's own
 *  kinds — `servicedesk.reply` is the service-desk feature's, enqueued there).
 *  COS-9 — single-sourced from `assistantService.ENQUEUEABLE_ACTION_KINDS` so the
 *  tool lane and the surface lane can never drift on the allowlist. */
const ENQUEUEABLE_KINDS = ENQUEUEABLE_ACTION_KINDS;


/** Structured tool error (the agent loop surfaces `content` verbatim to the model). */
function toolError(error: string, message: string): { content: string; isError: true } {
  return { content: JSON.stringify({ error, message }), isError: true };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');


/** The assistant graph surface (the SAME methods the loop nodes call). */
function surfaceFor(scope: BundleScope): ReturnType<typeof buildAssistantSurface> {
  return buildAssistantSurface({ tenantId: scope.tenantId });
}

export function registerAssistantAgentTools(): void {
  // ── Reads (grounding; fail EMPTY without an acting user) ──────────────

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: ASSISTANT_LIST_COMMITMENTS_TOOL_ID,
      description:
        "List the workspace memory graph's commitments (owner, description, due date, status, extraction confidence, "
        + 'and the source they were extracted from). Read this BEFORE upserting or projecting a commitment so you do not '
        + 'duplicate or contradict what is already tracked. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Optional filter: open | done | dropped.' },
          projectId: { type: 'string', description: 'Optional: only commitments linked to this project.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return { content: JSON.stringify({ commitments: [] }) };
      const out = await surfaceFor(scope).listCommitments!({
        ...(str(input.status) ? { status: str(input.status) } : {}),
        ...(str(input.projectId) ? { projectId: str(input.projectId) } : {}),
      });
      return { content: JSON.stringify(out) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: ASSISTANT_LIST_PENDING_ACTIONS_TOOL_ID,
      description:
        'List the assistant action-approval queue: drafts already enqueued and awaiting the principal\'s approval '
        + '(kind, status, draft). Read this before enqueuing a new action so you do not queue a duplicate. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', description: "Optional filter: 'pending'." } },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return { content: JSON.stringify({ pendingActions: [] }) };
      const out = await surfaceFor(scope).listPendingActions!({
        ...(str(input.status) ? { status: str(input.status) } : {}),
      });
      return { content: JSON.stringify(out) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: ASSISTANT_COMPOSE_BRIEFING_TOOL_ID,
      description:
        "Compose the principal's briefing from the CURRENT memory graph: top open commitments, what is at risk "
        + '(due within 48h or overdue), upcoming meetings, and the count awaiting approval — each commitment carries '
        + 'its source and a "why this is surfaced" line. Read this to ground a morning brief or a "what needs me?" answer. '
        + 'To persist the brief as a durable document, compose from this and call openwop:documents.draft. Read-only.',
      inputSchema: {
        type: 'object',
        // UX_UPGRADE-assistant R2 (AST2-M1) — this used to advertise
        // "balanced (default) | deadline | relationship". Neither `deadline`
        // nor `relationship` has ever existed: the keys are `conservative |
        // balanced | aggressive` (`prioritization.ts` → PRIORITY_PROFILES,
        // which is the SSoT). A model following the description passed a key
        // that `briefing.ts` then dereferenced unguarded — a TypeError, i.e. a
        // crash reachable from a well-behaved model doing exactly what it was
        // told. The `enum` is DERIVED from the SSoT rather than restated, so
        // adding a profile cannot drift this description again.
        properties: {
          profile: {
            type: 'string',
            enum: Object.keys(PRIORITY_PROFILES),
            description: `Optional prioritization profile (default \`balanced\`): ${Object.keys(PRIORITY_PROFILES).join(' | ')}.`,
          },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return { content: JSON.stringify({ brief: null, note: 'A briefing reads the principal\'s graph — available only on a human-initiated turn.' }) };
      const out = await surfaceFor(scope).composeBriefing!({
        ...(str(input.profile) ? { profile: str(input.profile) } : {}),
      });
      return { content: JSON.stringify(out) };
    },
  });

  // ── Actions (SUBMIT only; workspace:write authority; fail TYPED) ──────

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: ASSISTANT_UPSERT_COMMITMENT_TOOL_ID,
      description:
        'Record (or update) a commitment in the workspace memory graph. Idempotent: the graph dedups by (source + '
        + 'description), so re-recording the same commitment is safe and returns the existing one. Pass the owner, a '
        + 'one-line imperative description, the source it came from, and an optional due date + confidence. This writes '
        + 'internal state only — it is not an outbound action.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', minLength: 1, description: 'The commitment, as one imperative line.' },
          owner: {
            type: 'object',
            description: "Who owes it: {kind:'self'} for the principal, {kind:'crm-contact', orgId, contactId}, or {kind:'email', address}.",
            additionalProperties: true,
          },
          source: {
            type: 'object',
            description: 'Where it came from: {kind, externalId, url?, contentTrust?, text?}. Pass through the source you were given so re-extraction is idempotent.',
            additionalProperties: true,
          },
          dueAt: { type: 'string', description: 'Optional ISO-8601 due date.' },
          confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Optional extraction confidence 0..1.' },
          projectId: { type: 'string', description: 'Optional project to link the commitment to.' },
        },
        required: ['description'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return toolError('acting_user_required', 'Commitments can only be recorded from a human-initiated turn.');
      if (!(await hasAssistantWriteAuthority(scope.tenantId, scope.actingUserId))) {
        return toolError('forbidden_scope', 'You need write access to this workspace to record a commitment.');
      }
      const description = str(input.description);
      if (!description) return toolError('validation_error', '`description` is required.');
      const out = await surfaceFor(scope).upsertCommitment!({
        description,
        ...(input.owner && typeof input.owner === 'object' ? { owner: input.owner } : {}),
        ...(input.source && typeof input.source === 'object' ? { source: input.source } : {}),
        ...(str(input.dueAt) ? { dueAt: str(input.dueAt) } : {}),
        ...(typeof input.confidence === 'number' ? { confidence: input.confidence } : {}),
        ...(str(input.projectId) ? { projectId: str(input.projectId) } : {}),
      });
      return { content: JSON.stringify(out) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: ASSISTANT_POPULATE_BOARD_TOOL_ID,
      description:
        "Project a tracked commitment onto the owner's kanban board (through the kanban owner) so the work is visible and "
        + 'actionable. Idempotent by back-reference: an already-projected commitment returns its existing card; a '
        + 'human-dismissed card is NOT recreated. Read the commitments first (openwop:assistant.list-commitments) to get '
        + 'the commitmentId. Writes internal state only.',
      inputSchema: {
        type: 'object',
        properties: {
          commitmentId: { type: 'string', minLength: 1, description: 'The commitment to project (from list-commitments).' },
          boardId: { type: 'string', description: "Optional target board id (defaults to the owner's board)." },
          ownerUserId: { type: 'string', description: "Optional board-owner user id (defaults to the commitment's owner)." },
        },
        required: ['commitmentId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return toolError('acting_user_required', 'The board can only be populated from a human-initiated turn.');
      if (!(await hasAssistantWriteAuthority(scope.tenantId, scope.actingUserId))) {
        return toolError('forbidden_scope', 'You need write access to this workspace to populate the board.');
      }
      const commitmentId = str(input.commitmentId);
      if (!commitmentId) return toolError('validation_error', '`commitmentId` is required.');
      const out = await surfaceFor(scope).projectToBoard!({
        commitmentId,
        ...(str(input.boardId) ? { boardId: str(input.boardId) } : {}),
        ...(str(input.ownerUserId) ? { ownerUserId: str(input.ownerUserId) } : {}),
      });
      return { content: JSON.stringify(out) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: ASSISTANT_ENQUEUE_ACTION_TOOL_ID,
      description:
        'DRAFT an outbound action and submit it to the principal for one-tap approval — this NEVER sends. The draft lands '
        + 'in the approvals inbox; on approval the host executes it under the approver\'s identity + connected write scopes. '
        + `Set kind to one of: ${ENQUEUEABLE_KINDS.join(', ')}. Put the recipient/subject/etc. in payload; put the body in `
        + 'draft. Reference the originating commitment via sourceCommitmentId when there is one. Returns the queued actionId '
        + '+ status — tell the user you drafted it for their approval; do not claim it was sent.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...ENQUEUEABLE_KINDS], description: 'The outbound action kind.' },
          draft: { type: 'string', minLength: 1, description: 'The proposed body/message text in the principal\'s voice.' },
          payload: { type: 'object', description: 'Structured action data (e.g. {to, subject} for email.send; event fields for calendar.*).', additionalProperties: true },
          reason: { type: 'string', description: 'Optional one-line rationale shown on the approval card.' },
          sourceCommitmentId: { type: 'string', description: 'Optional: the commitment this action fulfils.' },
          riskLevel: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional risk hint for the approval card.' },
        },
        required: ['kind', 'draft'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return toolError('acting_user_required', 'Actions can only be drafted from a human-initiated turn.');
      if (!(await hasAssistantWriteAuthority(scope.tenantId, scope.actingUserId))) {
        return toolError('forbidden_scope', 'You need write access to this workspace to draft an action for approval.');
      }
      const kind = str(input.kind);
      if (!(ENQUEUEABLE_KINDS as readonly string[]).includes(kind)) {
        return toolError('validation_error', `\`kind\` must be one of: ${ENQUEUEABLE_KINDS.join(', ')}.`);
      }
      const draft = str(input.draft);
      if (!draft) return toolError('validation_error', '`draft` is required.');
      try {
        const out = await surfaceFor(scope).enqueueAction!({
          kind,
          draft,
          ...(input.payload && typeof input.payload === 'object' ? { payload: input.payload } : {}),
          ...(str(input.reason) ? { reason: str(input.reason) } : {}),
          ...(str(input.sourceCommitmentId) ? { sourceCommitmentId: str(input.sourceCommitmentId) } : {}),
          ...(str(input.riskLevel) ? { riskLevel: str(input.riskLevel) } : {}),
        });
        const pendingAction = (out.pendingAction ?? {}) as { actionId?: string; status?: string };
        return {
          content: JSON.stringify({
            queued: { actionId: pendingAction.actionId, status: pendingAction.status },
            note: 'Action drafted and submitted for the principal\'s approval — NOT sent. Tell the user it is waiting on their approval.',
          }),
        };
      } catch (err) {
        // The enqueue path fails CLOSED on workspace/agent policy (a `disabled`
        // action kind, or the acting agent's `permissions.never`) — surface it as
        // a typed refusal so the model tells the user, never a silent success.
        const e = err as { code?: string; message?: string };
        return toolError(e.code ?? 'enqueue_failed', e.message ?? 'The action could not be drafted.');
      }
    },
  });
}
