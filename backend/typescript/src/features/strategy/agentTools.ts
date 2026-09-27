/**
 * Strategy Analyst chat tools (CFP-1 / ADR 0080 §Phase C, the ADR 0308 D2
 * deliverable-tool seam) — the REAL conversational tools the
 * `feature.strategy.agents.strategy-analyst` pack allowlists.
 *
 * The founding defect (CHAT-FIRST-PORT-AUDIT #1): the pack allowlisted
 * `openwop:feature.strategy.nodes.*` — node typeIds NO host registrant projects
 * into the conversational tool universe — so every chat turn resolved zero tools
 * and the analyst fell back to a plain completion while its prompt claimed it
 * could audit the portfolio. These tools make the exchange real: four
 * surface-backed READS the model grounds on (list / get / context / health) +
 * ONE ACTION that drafts a board memo as a Document (the strategy surface stays
 * read-only — ADR 0079 / ADR 0231).
 *
 * Authority parity (hard rule 1): each read enforces the SAME RBAC as the
 * matching strategy route — the shared `canSubjectReadStrategy` /
 * `subjectHasOrgScope` predicates the routes call (routes.ts), so route and tool
 * cannot drift. Reads FAIL EMPTY without an acting user (a scheduled/system turn
 * with no human principal must not enumerate a tenant's portfolio — the KickTodo
 * goals-tool posture); the toggle is resolved per-tenant in each run() (disabled
 * ⇒ typed `feature_disabled`). The board-memo write requires an acting user +
 * `workspace:write` in the target org, and persists through the Documents owner
 * (`createDocument`/`addVersion`) with a deterministic idempotency key.
 *
 * Clean `openwop:strategy.<verb>` ids (the app-builder convention), NOT the
 * node-typeId-shaped ids the pack used to allowlist: those never resolved, so
 * nothing depends on them, and the node-projection namespace stays unambiguous.
 */

import { createHash } from 'node:crypto';
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import {
  listStrategies, getStrategy, canSubjectReadStrategy, orgReadPredicate,
  resolveStrategyContext, resolveStrategyHealth,
  strategiesLinkingProject, strategiesLinkingPriorityList, strategiesLinkingPriorityIdea, strategiesLinkingBoard,
} from './strategyService.js';
import { createDocument, addVersion } from '../documents/documentsService.js';
import type { Strategy } from './types.js';

export const STRATEGY_LIST_TOOL_ID = 'openwop:strategy.list-strategies';
export const STRATEGY_GET_TOOL_ID = 'openwop:strategy.get-strategy';
export const STRATEGY_CONTEXT_TOOL_ID = 'openwop:strategy.get-context';
export const STRATEGY_HEALTH_TOOL_ID = 'openwop:strategy.get-health';
export const STRATEGY_BOARD_MEMO_TOOL_ID = 'openwop:strategy.create-board-memo';

type ToolResult = { content: string; isError?: boolean };

/** Structured tool error — the agent loop surfaces `content` verbatim to the
 *  model, so the message must say what failed and what to do next. */
function toolError(error: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error, message, ...(extra ?? {}) }), isError: true };
}

const ok = (payload: unknown): ToolResult => ({ content: JSON.stringify(payload) });
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Per-call toggle honesty (ADR 0308 D2): per-tenant, dynamic, fail-closed. */
async function strategyEnabled(scope: BundleScope): Promise<boolean> {
  return resolveFeatureToggle('strategy', scope);
}

// ADR 0597 §Correction 1 — the local copy of `orgReadPredicate` is gone; the
// ONE rule now lives in `strategyService` (memoized, so a tool call's org reads
// collapse to O(distinct orgs) instead of one member-table scan per link).

/** The caller's readable shared strategies (the routes' `readableStrategies`). */
async function readableStrategies(tenantId: string, actingUserId: string): Promise<Strategy[]> {
  const all = await listStrategies(tenantId, { includeArchived: false });
  const out: Strategy[] = [];
  for (const s of all) if (await canSubjectReadStrategy(tenantId, actingUserId, s)) out.push(s);
  return out;
}

/** The same org resolution + `workspace:write` gate the documents/app-builder
 *  deliverable tools use: explicit `orgId`, else the workspace's sole org; with
 *  several orgs the model must name one. */
async function resolveWriteOrg(
  scope: BundleScope,
  orgIdInput: string | undefined,
): Promise<{ orgId: string; actingUserId: string } | ToolResult> {
  const actingUserId = scope.actingUserId;
  if (!actingUserId) return toolError('acting_user_required', 'A board memo can only be drafted from a human-initiated turn.');
  const orgs = await listOrgs(scope.tenantId);
  const orgId = orgIdInput ?? (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) return toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`);
  if (!orgs.some((o) => o.orgId === orgId)) return toolError('not_found', 'Organization not found in this workspace.');
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: actingUserId, orgId });
  if (!access.scopes.includes('workspace:write')) {
    return toolError('forbidden_scope', 'The user does not have write access to that organization.');
  }
  return { orgId, actingUserId };
}

export function registerStrategyAgentTools(): void {
  // ── READ: the workspace's shared strategies (compact refs). ──────────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: STRATEGY_LIST_TOOL_ID,
      description:
        'List the workspace\'s shared strategies (compact refs: id, title, scope, status, planning horizon, org). '
        + 'Call this FIRST to see the portfolio before auditing alignment gaps or drafting a memo. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope) {
      if (!(await strategyEnabled(scope))) {
        return toolError('feature_disabled', 'The Strategy feature is not enabled for this workspace — tell the user you cannot read strategies here.');
      }
      // Fail EMPTY without a human principal (no subjectless portfolio enumeration).
      if (!scope.actingUserId) return ok({ strategies: [] });
      const readable = await readableStrategies(scope.tenantId, scope.actingUserId);
      return ok({
        strategies: readable.map((s) => ({
          id: s.id, title: s.title, scope: s.scope, status: s.status, horizon: s.planningHorizon, orgId: s.orgId,
        })),
      });
    },
  });

  // ── READ: one strategy, RESOLVED (objectives + linked execution + health). ──
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: STRATEGY_GET_TOOL_ID,
      description:
        'Read ONE strategy resolved with its objectives / key results, its linked projects and priority ideas, and '
        + 'its health rollup — the same packet the detail page renders. Use it to reason about a specific strategy\'s '
        + 'alignment gaps. Pass `strategyId`. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { strategyId: { type: 'string', description: 'The strategy id (from list-strategies).' } },
        required: ['strategyId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!(await strategyEnabled(scope))) {
        return toolError('feature_disabled', 'The Strategy feature is not enabled for this workspace.');
      }
      if (!scope.actingUserId) return ok({ strategy: null });
      const strategyId = str(input.strategyId);
      if (!strategyId) return toolError('validation_error', '`strategyId` is required.');
      const s = await getStrategy(scope.tenantId, strategyId);
      // Uniform not-found on a missing OR unreadable strategy (the route's
      // no-existence-leak posture): return an empty result, never a distinct error.
      if (!s || !(await canSubjectReadStrategy(scope.tenantId, scope.actingUserId, s))) return ok({ strategy: null });
      const entries = await resolveStrategyContext(scope.tenantId, [s], scope.actingUserId, orgReadPredicate(scope.tenantId, scope.actingUserId));
      return ok({ strategy: entries[0] ?? null });
    },
  });

  // ── READ: the strategy context packet for a consumer ref. ────────────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: STRATEGY_CONTEXT_TOOL_ID,
      description:
        'Resolve the strategies linked to a consumer surface — a project, a priority list (optionally one idea), or an '
        + 'advisory board — with each strategy\'s compact context packet. Pass ONE of `projectId`, `priorityListId` '
        + '(+ optional `cardId`), or `boardId`. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'A project id to find the strategies linking it.' },
          priorityListId: { type: 'string', description: 'A priority list id.' },
          cardId: { type: 'string', description: 'A priority idea (card) id — with priorityListId, narrows to one idea.' },
          boardId: { type: 'string', description: 'An advisory board id.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!(await strategyEnabled(scope))) {
        return toolError('feature_disabled', 'The Strategy feature is not enabled for this workspace.');
      }
      if (!scope.actingUserId) return ok({ strategies: [] });
      const projectId = str(input.projectId);
      const priorityListId = str(input.priorityListId);
      const cardId = str(input.cardId);
      const boardId = str(input.boardId);
      let linked: Strategy[];
      if (projectId) linked = await strategiesLinkingProject(scope.tenantId, projectId);
      else if (priorityListId && cardId) linked = await strategiesLinkingPriorityIdea(scope.tenantId, priorityListId, cardId);
      else if (priorityListId) linked = await strategiesLinkingPriorityList(scope.tenantId, priorityListId);
      else if (boardId) linked = await strategiesLinkingBoard(scope.tenantId, boardId);
      else return toolError('validation_error', 'One of `projectId`, `priorityListId`, or `boardId` is required.');
      const readable: Strategy[] = [];
      for (const s of linked) if (await canSubjectReadStrategy(scope.tenantId, scope.actingUserId, s)) readable.push(s);
      const strategies = await resolveStrategyContext(scope.tenantId, readable, scope.actingUserId, orgReadPredicate(scope.tenantId, scope.actingUserId));
      return ok({ strategies });
    },
  });

  // ── READ: per-strategy health rollup over the readable portfolio. ────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: STRATEGY_HEALTH_TOOL_ID,
      description:
        'Get a per-strategy HEALTH rollup (on-track / at-risk / off-track) across the workspace\'s readable strategies, '
        + 'with the component signals (linked project counts, milestone completion, execution presence) so you can name '
        + 'the specific alignment gaps WITHOUT inventing precision. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope) {
      if (!(await strategyEnabled(scope))) {
        return toolError('feature_disabled', 'The Strategy feature is not enabled for this workspace.');
      }
      if (!scope.actingUserId) return ok({ strategies: [] });
      const readable = await readableStrategies(scope.tenantId, scope.actingUserId);
      const strategies = await resolveStrategyHealth(scope.tenantId, readable, scope.actingUserId, orgReadPredicate(scope.tenantId, scope.actingUserId));
      return ok({ strategies });
    },
  });

  // ── ACTION: draft a board memo as a Document (the ONE write; strategy stays
  //    read-only). Persists through the Documents owner (ADR 0308 / ADR 0080). ──
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: STRATEGY_BOARD_MEMO_TOOL_ID,
      description:
        'Draft a board-ready memo you composed and persist it as a Document (kind board-update). You write the '
        + 'markdown prose; this saves it. Ground it first with the read tools (get-health / get-strategy). Pass '
        + '`markdown` (required), an optional `title`, and `orgId` only when the workspace has more than one '
        + 'organization. Returns { documentId, version } — tell the user the memo is drafted and where to find it. '
        + 'The strategy itself is never modified.',
      inputSchema: {
        type: 'object',
        properties: {
          markdown: { type: 'string', minLength: 1, description: 'The full memo body in markdown (you author it).' },
          title: { type: 'string', description: 'Optional memo title (defaults to "Board update").' },
          orgId: { type: 'string', description: 'Organization id — only needed when the workspace has more than one organization.' },
        },
        required: ['markdown'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!(await strategyEnabled(scope))) {
        return toolError('feature_disabled', 'The Strategy feature is not enabled for this workspace — tell the user you cannot draft a memo here.');
      }
      const markdown = str(input.markdown);
      if (!markdown) return toolError('validation_error', '`markdown` is required — author the memo body before calling this.');
      const gate = await resolveWriteOrg(scope, str(input.orgId));
      if ('content' in gate) return gate;
      const title = str(input.title) ?? 'Board update';

      // The Document IS the memo; without the documents feature there is no honest
      // place to persist it — degrade like the create-board-memo node (return the
      // markdown inline, persisted:false), never a silent success-with-empty.
      const docsOn = await resolveFeatureToggle('documents', scope);
      if (!docsOn) {
        return ok({ persisted: false, markdown, note: 'The Documents feature is off — the memo is NOT saved. Show the user the markdown and tell them to enable Documents to persist it.' });
      }

      // Provenance rides the Document (the ADR 0045 posture): an agent-authored
      // memo records which agent, but the memo is owned by the acting human.
      const producedBy = scope.agentProfileId
        ? { kind: 'agent' as const, id: scope.agentProfileId }
        : { kind: 'user' as const, id: gate.actingUserId };
      // Deterministic id (retry-safe within a run): an identical memo re-uses the
      // same Document instead of duplicating it (the createDocument short-circuit).
      const key = createHash('sha256').update([scope.runId ?? scope.tenantId, gate.orgId, title, markdown].join('\u0000')).digest('hex').slice(0, 32);
      const documentId = `doc:strategy-board-memo:${key}`;
      try {
        const doc = await createDocument({
          tenantId: scope.tenantId, orgId: gate.orgId, title, kind: 'board-update', format: 'markdown',
          provenance: { producedBy }, createdBy: gate.actingUserId, documentId,
        });
        const version = await addVersion(scope.tenantId, gate.orgId, doc.documentId, {
          content: markdown, producedBy, idempotencyKey: `strategy-board-memo:${key}`,
        });
        return ok({
          persisted: true, documentId: doc.documentId, version: version.version, title,
          note: 'Board memo drafted and saved as a Document. Tell the user the memo title and that it is a draft in Documents.',
        });
      } catch (err) {
        return toolError('persist_failed', `The memo could not be saved: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
