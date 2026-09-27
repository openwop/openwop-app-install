/**
 * Prioritization Analyst chat tools (CFP-1 / ADR 0058 §chat-drivability, the ADR
 * 0308 D2 deliverable-tool seam) — the REAL conversational tools the
 * `feature.priority-matrix.agents.prioritization-analyst` pack allowlists.
 *
 * The founding defect (CHAT-FIRST-PORT-AUDIT #1): the pack allowlisted
 * `openwop:feature.priority-matrix.nodes.*` — node typeIds NO host registrant
 * projects into the conversational tool universe — so every chat turn resolved
 * zero tools and the analyst fell back to a plain completion while its prompt
 * claimed it could capture, score, and rank ideas. These tools make the exchange
 * real: three surface-backed READS (lists / ranked ideas / schedule status) +
 * three proposal-safe ACTIONS (submit an idea, score an idea, generate a
 * planning agenda).
 *
 * Authority parity (hard rule 1): each tool enforces the SAME per-org RBAC as
 * the matching route — `workspace:read` in the list's org for reads,
 * `workspace:write` for writes, via the SAME `resolveEffectiveAccess` the routes
 * call (routes.ts `hasOrgScope` / `loadListScoped`), so route and tool cannot
 * drift. Reads FAIL EMPTY without an acting user (no subjectless enumeration);
 * writes fail TYPED. An unreadable/absent list is a uniform not-found (empty for
 * reads) — the routes' no-existence-leak posture. The toggle is resolved
 * per-tenant in each run() (disabled ⇒ typed `feature_disabled`).
 *
 * An idea IS a `host.kanban` card and a scenario stays human-selected — the
 * feature owns no `promote` verb (authority-granting stays route-only). These
 * tools carry only the proposal-safe surface writes (ADR 0235 §D1 posture); the
 * scenario-decision / plan-of-record queue is deliberately out of scope here.
 *
 * Clean `openwop:priority-matrix.<verb>` ids (the app-builder convention), NOT
 * the node-typeId-shaped ids the pack used to allowlist: those never resolved,
 * so nothing depends on them.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { releaseIgnition, claimIgnition, recordIgnitionRun, ignitionKey } from '../../host/ignitionGuard.js';
// PMX-14 (ADR 0590) — the shared kit helpers replace this module's former
// byte-identical local re-declarations (toolError/ok/str).
import { resolveFeatureToggle, toolOk as ok, toolError, str, type ToolResult } from '../../host/agentToolKit.js';
// PMX-14 — the routes' OWN predicate (the CRM `orgScopeGranted` pattern): one
// predicate, imported, so route and tool can no longer drift independently.
import { orgScopeGranted } from './routes.js';
import type { Scope } from '../../host/accessControlService.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import {
  listLists, getList, listRankedIdeas, submitIdea, setIdeaScore, getScheduleStatus, createPlanningSession,
} from './priorityMatrixService.js';
import type { PriorityList } from './types.js';
import { resolveSubjectAccess, levelSatisfies } from '../../host/subjectAccess.js';

export const PM_LIST_LISTS_TOOL_ID = 'openwop:priority-matrix.list-lists';
export const PM_RANKED_IDEAS_TOOL_ID = 'openwop:priority-matrix.list-ranked-ideas';
export const PM_SCHEDULE_STATUS_TOOL_ID = 'openwop:priority-matrix.schedule-status';
export const PM_SUBMIT_IDEA_TOOL_ID = 'openwop:priority-matrix.submit-idea';
export const PM_SCORE_IDEA_TOOL_ID = 'openwop:priority-matrix.score-idea';
export const PM_GENERATE_AGENDA_TOOL_ID = 'openwop:priority-matrix.generate-agenda';

/** Per-call toggle honesty (ADR 0308 D2): per-tenant, dynamic, fail-closed. */
async function pmEnabled(scope: BundleScope): Promise<boolean> {
  return resolveFeatureToggle('priority-matrix', scope);
}

/** PMX-14 — the routes' predicate, not a copy of it. */
async function hasOrgScope(tenantId: string, actingUserId: string, orgId: string, scope: Scope): Promise<boolean> {
  return orgScopeGranted(tenantId, actingUserId, orgId, scope);
}

/**
 * The routes' `loadListScoped` for a WRITE tool: load a list + gate on the
 * caller's scope in the list's org. Typed errors — acting user required,
 * not-found (no existence leak) on a missing/unreadable list, forbidden without
 * write. `readScope` writes need `workspace:write`; the base read is implicit.
 */
async function loadListForWrite(scope: BundleScope, listId: string | undefined): Promise<{ list: PriorityList; actingUserId: string } | ToolResult> {
  const actingUserId = scope.actingUserId;
  if (!actingUserId) return toolError('acting_user_required', 'Ideas can only be captured or scored from a human-initiated turn.');
  if (!listId) return toolError('validation_error', '`listId` is required.');
  const list = await getList(scope.tenantId, listId);
  if (!list || !(await hasOrgScope(scope.tenantId, actingUserId, list.orgId, 'workspace:read'))) {
    return toolError('not_found', `Priority list '${listId}' not found in this workspace.`);
  }
  if (!(await hasOrgScope(scope.tenantId, actingUserId, list.orgId, 'workspace:write'))) {
    return toolError('forbidden_scope', 'The user does not have write access to that list\'s organization.');
  }
  return { list, actingUserId };
}

/** ADR 0610 D3′ / CPC-14 — a project-bound list is membership-scoped; the org gate
 *  is not sufficient. Consult the ONE subjectAccess seam (the SAME predicate the
 *  REST `loadListScoped` uses — ADR 0308/0610 D2: the routes and the agent tools
 *  must not drift). Null ⇒ not membership-scoped ⇒ org gate stands. */
async function listProjectReadable(scope: BundleScope, list: PriorityList): Promise<boolean> {
  if (!list.projectId) return true;
  const level = await resolveSubjectAccess(scope.tenantId, { kind: 'project', id: list.projectId }, scope.actingUserId);
  return level === null || levelSatisfies(level, 'read');
}

/** A list loaded for a READ tool: fail EMPTY (null) without an acting user or on
 *  a missing/unreadable list — the no-existence-leak posture for reads. */
async function loadListForRead(scope: BundleScope, listId: string | undefined): Promise<PriorityList | null> {
  if (!scope.actingUserId || !listId) return null;
  const list = await getList(scope.tenantId, listId);
  if (!list || !(await hasOrgScope(scope.tenantId, scope.actingUserId, list.orgId, 'workspace:read'))) return null;
  if (!(await listProjectReadable(scope, list))) return null;
  return list;
}

export function registerPriorityMatrixAgentTools(): void {
  // ── READ: the workspace's readable priority lists (with their criteria). ──
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: PM_LIST_LISTS_TOOL_ID,
      description:
        'List the workspace\'s priority lists you can read — each with its id, name, and weighted criteria (name, '
        + 'weight, direction). Call this FIRST to find the list to capture, score, or rank ideas in. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope) {
      if (!(await pmEnabled(scope))) {
        return toolError('feature_disabled', 'The Priority Matrix feature is not enabled for this workspace — tell the user you cannot prioritize here.');
      }
      if (!scope.actingUserId) return ok({ lists: [] });
      const all = await listLists(scope.tenantId);
      const readable = new Map<string, boolean>();
      const out: Array<Record<string, unknown>> = [];
      for (const l of all) {
        let can = readable.get(l.orgId);
        if (can === undefined) { can = await hasOrgScope(scope.tenantId, scope.actingUserId, l.orgId, 'workspace:read'); readable.set(l.orgId, can); }
        if (!can) continue;
        // ADR 0610 D3′ — a project-bound list needs the per-row membership gate too.
        if (!(await listProjectReadable(scope, l))) continue;
        out.push({
          listId: l.id, name: l.name,
          criteria: l.criteriaSet.criteria.map((c) => ({ id: c.id, name: c.name, weight: c.weight, direction: c.direction })),
        });
      }
      return ok({ lists: out });
    },
  });

  // ── READ: a list's ideas ranked by computed weighted priority. ───────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    // ADR 0604 (TOCC-2) — closed world: an elided enum/id list here makes the
    // model author against a catalog that is not this host's.
    schemaCarrying: true,
    def: {
      name: PM_RANKED_IDEAS_TOOL_ID,
      description:
        'Read one list\'s ideas RANKED by their computed weighted priority (descending), with each idea\'s status, '
        + 'computed priority, and rank. Use it to explain the ranking or find the top ideas. Pass `listId`. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { listId: { type: 'string', description: 'The priority list id (from list-lists).' } },
        required: ['listId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!(await pmEnabled(scope))) return toolError('feature_disabled', 'The Priority Matrix feature is not enabled for this workspace.');
      const list = await loadListForRead(scope, str(input.listId));
      if (!list) return ok({ ideas: [] });
      const ideas = await listRankedIdeas(scope.tenantId, list.id, scope.actingUserId);
      // R2 PM2-M1 — the persona is instructed to "explain the reasoning per criterion
      // (e.g. 'high strategic-alignment, low cost')" and to ground every ranking claim in
      // this tool, and the tool threw the per-criterion scores away ONE LINE before the
      // model saw them. So the only way to obey the prompt was to invent the reasoning —
      // a read-before-you-write surface returning the wrong half of the data.
      return ok({
        ideas: ideas.map((i) => ({
          cardId: i.card.id, title: i.card.title, status: i.status.columnName, priority: i.computedPriority, rank: i.rank,
          // R3 — `priority: 0` is a SENTINEL, not a score; without a flag the model
          // reported 0 as "scored worst".
          //
          // CORRECTED (ADR 0667 D1c): this note used to justify the flag by claiming "a
          // scored idea can never produce exactly 0", and keyed `unscored` on
          // `priority === 0`. Both were wrong, and the second lied TO THE MODEL: in ratio
          // mode a WSJF idea scored 10/10/10 with a blank job-size returns exactly 0, so
          // a 3-of-4-scored idea was reported as `unscored: true`. Conversely a partially
          // scored idea with a non-zero priority was reported as fully authoritative.
          // Both now key on `completeness`, which cannot conflate the two.
          ...(i.completeness.scored === 0 ? { unscored: true } : {}),
          ...(i.completeness.complete ? {} : { partiallyScored: { scored: i.completeness.scored, declared: i.completeness.declared, missing: i.completeness.missing } }),
          scores: i.scores, ...(i.voterCount !== undefined ? { voterCount: i.voterCount } : {}),
        })),
        criteria: (list.criteriaSet.criteria ?? []).map((c) => ({ id: c.id, name: c.name, weight: c.weight, direction: c.direction })),
        note: '`scores` is criterionId → 1..10 as scored; `criteria` gives each id its name, weight and direction (a `cost` criterion is better when LOWER). `partiallyScored` means the idea is NOT scored on every criterion — its `priority` is provisional and it is ranked below fully-scored ideas; say so rather than presenting its rank as settled. Explain a ranking only from these; never infer a score that is absent.',
      });
    },
  });

  // ── READ: per-idea schedule status + a list rollup (ahead/behind). ───────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: PM_SCHEDULE_STATUS_TOOL_ID,
      description:
        'Read one list\'s SCHEDULE status — per-idea ahead/behind derived from target dates + card status, plus a '
        + 'list rollup. Use it to report which prioritized ideas are slipping. Pass `listId`. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { listId: { type: 'string', description: 'The priority list id.' } },
        required: ['listId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!(await pmEnabled(scope))) return toolError('feature_disabled', 'The Priority Matrix feature is not enabled for this workspace.');
      const list = await loadListForRead(scope, str(input.listId));
      if (!list) return ok({ ideas: [], rollup: null });
      const out = await getScheduleStatus(scope.tenantId, list.id);
      return ok({ ideas: out.ideas, rollup: out.rollup });
    },
  });

  // ── ACTION: capture a new idea into a list (lands in the New status). ────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: PM_SUBMIT_IDEA_TOOL_ID,
      description:
        'Capture a new idea into a priority list — it lands as a real card in the New status the team then scores. '
        + 'Pass `listId`, a `title`, and an optional `description`. Returns { cardId, title }. Tell the user the idea '
        + 'was added and where.',
      inputSchema: {
        type: 'object',
        properties: {
          listId: { type: 'string', description: 'The priority list to add the idea to.' },
          title: { type: 'string', minLength: 1, description: 'The idea title.' },
          description: { type: 'string', description: 'Optional detail for the idea.' },
        },
        required: ['listId', 'title'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!(await pmEnabled(scope))) return toolError('feature_disabled', 'The Priority Matrix feature is not enabled for this workspace — tell the user you cannot capture ideas here.');
      const gate = await loadListForWrite(scope, str(input.listId));
      if ('content' in gate) return gate;
      const title = str(input.title);
      if (!title) return toolError('validation_error', '`title` is required.');
      // LOW-1 idempotent create — a retried identical capture (same list + title)
      // inside the window returns the card already created, never a duplicate.
      const key = ignitionKey('priority-matrix.submit-idea', gate.list.id, title.toLowerCase());
      const claim = await claimIgnition(scope.tenantId, key);
      // R2 PM2-B3 — a HELD claim with no recorded run is not a dedup, it is the debris of
      // a previous attempt that threw: `releaseIgnition` was never called on failure, so
      // once `submitIdea` failed (a list at the 1,000-idea cap, a storage blip) EVERY
      // retry for the rest of the window returned `deduped: true` with NO `cardId` — a
      // success telling the user the idea was captured, forever, with no card and none
      // coming. `generate-agenda` one tool down already guards `claim.existingRunId` for
      // exactly this; `submit-idea` did not.
      if (!claim.claimed && claim.existingRunId) {
        return ok({ cardId: claim.existingRunId, title, status: 'new', deduped: true, note: 'That idea was just captured — reusing the existing card.' });
      }
      let card;
      try {
        // PMXU-1 (ADR 0590) — the acting user authorizes the write, but the
        // WRITER is the model: stamp source:'agent' so an AI-captured idea is
        // distinguishable from a human's (the scenarioProposed chip pattern).
        card = await submitIdea(scope.tenantId, gate.list.id, gate.actingUserId, {
          title,
          ...(str(input.description) ? { description: str(input.description) } : {}),
        }, undefined, 'agent');
      } catch (err) {
        // Hand the claim back, so a retry is a real retry rather than a permanent lie.
        if (claim.claimed) await releaseIgnition(scope.tenantId, key);
        throw err;
      }
      await recordIgnitionRun(scope.tenantId, key, card.id);
      return ok({ cardId: card.id, title: card.title, status: card.columnId, note: 'Idea captured. Tell the user it was added to the list in the New status.' });
    },
  });

  // ── ACTION: score an idea against the list's weighted criteria. ──────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: PM_SCORE_IDEA_TOOL_ID,
      description:
        'Score one idea against the list\'s weighted criteria — pass `scores` as a map of criterionId → 1..10 (get the '
        + 'criterion ids from list-lists). In a multi-voter list this records YOUR cast vote. Pass `listId`, `cardId`, '
        + 'and `scores`. Returns the new computed priority.',
      inputSchema: {
        type: 'object',
        properties: {
          listId: { type: 'string', description: 'The priority list id.' },
          cardId: { type: 'string', description: 'The idea (card) id to score.' },
          scores: { type: 'object', description: 'Map of criterionId → integer 1..10.', additionalProperties: { type: 'number' } },
        },
        required: ['listId', 'cardId', 'scores'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!(await pmEnabled(scope))) return toolError('feature_disabled', 'The Priority Matrix feature is not enabled for this workspace.');
      const gate = await loadListForWrite(scope, str(input.listId));
      if ('content' in gate) return gate;
      const cardId = str(input.cardId);
      if (!cardId) return toolError('validation_error', '`cardId` is required.');
      if (!input.scores || typeof input.scores !== 'object') return toolError('validation_error', '`scores` must be a map of criterionId → 1..10.');
      // R2 PM2-B2 — `setIdeaScore` silently DROPS any key that is not a criterion id and
      // any value outside 1..10, with no count and no rejected list, and this returned
      // `ok({ computedPriority })` regardless. A model passing criterion NAMES instead of
      // ids — an extremely common slip, and the shape `list-lists` hands it — scored
      // nothing, got `computedPriority: 0`, and told the user "I scored it; its priority
      // is 0". The idea dropped to last place and the score-change trail recorded an empty
      // scores map as a legitimate scoring event. CLAUDE.md's non-negotiable is that
      // invalid model output is a TYPED FAILURE, never success-with-empty.
      const valid = new Map((gate.list.criteriaSet.criteria ?? []).map((c) => [c.id, c.name]));
      // R3 — the service (`setIdeaScore`) accepts numeric strings; this tool refused
      // them, so `{"effort": "7"}` — a shape providers emit constantly — was a hard
      // validation_error the service itself would have taken. Coerce BEFORE validating;
      // non-numeric strings still fail the range check below.
      const submitted = Object.entries(input.scores as Record<string, unknown>).map(([k, v]) =>
        [k, typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v] as [string, unknown]);
      const unknown = submitted.filter(([k]) => !valid.has(k)).map(([k]) => k);
      const outOfRange = submitted.filter(([k, v]) => valid.has(k) && !(typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 10)).map(([k]) => k);
      if (submitted.length === 0 || unknown.length > 0 || outOfRange.length > 0) {
        return toolError('validation_error', [
          submitted.length === 0 ? 'No scores were supplied.' : '',
          unknown.length > 0 ? `Unknown criterion id(s): ${unknown.join(', ')}.` : '',
          outOfRange.length > 0 ? `Scores must be integers 1..10; out of range: ${outOfRange.join(', ')}.` : '',
          `This list's criteria are: ${[...valid.entries()].map(([id, name]) => `${id} (${name})`).join(', ')}.`,
        ].filter(Boolean).join(' '));
      }
      // PMXU-1 (ADR 0590) — an AI-cast score is stamped source:'agent'.
      // ADR 0667 D4 (PMXWF-11) — 'merge': a model naming three criteria asserts three
      // values, not the ABSENCE of the rest. Under the previous full replace it deleted
      // every criterion it did not mention and was answered 'Score recorded.'
      const row = await setIdeaScore(scope.tenantId, gate.list.id, cardId, gate.actingUserId, Object.fromEntries(submitted) as Record<string, number>, 'agent', 'merge');
      return ok({ cardId: row.cardId, computedPriority: row.computedPriority, note: 'Score recorded. The criteria you named were MERGED into any existing scores — criteria you omit are left as they were, not cleared. Tell the user the idea\'s new computed priority.' });
    },
  });

  // ── ACTION: generate a planning-session agenda from a list's top ideas. ──
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: PM_GENERATE_AGENDA_TOOL_ID,
      description:
        'Generate a planning-session AGENDA from a list\'s top-N ranked ideas — composes it as a Document (kind '
        + 'board-agenda) when Documents is enabled, otherwise returns the agenda markdown inline. Pass `listId`, an '
        + 'optional `name`, and an optional `n` (top ideas to include; default 5). Returns { sessionId, agendaMarkdown, '
        + 'agendaDocumentId? }.',
      inputSchema: {
        type: 'object',
        properties: {
          listId: { type: 'string', description: 'The priority list id.' },
          name: { type: 'string', description: 'Optional session name.' },
          n: { type: 'integer', minimum: 1, maximum: 50, description: 'Top-N ideas to include (default 5).' },
        },
        required: ['listId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!(await pmEnabled(scope))) return toolError('feature_disabled', 'The Priority Matrix feature is not enabled for this workspace.');
      const gate = await loadListForWrite(scope, str(input.listId));
      if ('content' in gate) return gate;
      const n = typeof input.n === 'number' && Number.isFinite(input.n) ? input.n : 5;
      // LOW-1 idempotent create — a retried identical agenda request (same list +
      // name + top-N) inside the window returns the session already created.
      const key = ignitionKey('priority-matrix.generate-agenda', gate.list.id, (str(input.name) ?? '').toLowerCase(), String(n));
      const claim = await claimIgnition(scope.tenantId, key);
      if (!claim.claimed && claim.existingRunId) {
        return ok({ sessionId: claim.existingRunId, deduped: true, note: 'That agenda was just generated — reusing the existing session.' });
      }
      const session = await createPlanningSession(scope.tenantId, gate.list.id, gate.actingUserId, {
        ...(str(input.name) ? { name: str(input.name) } : {}),
        mode: 'top-n',
        n,
      });
      await recordIgnitionRun(scope.tenantId, key, session.id);
      return ok({
        sessionId: session.id, name: session.name, agendaMarkdown: session.agendaMarkdown,
        ...(session.agendaDocumentId ? { agendaDocumentId: session.agendaDocumentId } : {}),
        note: 'Agenda generated. Tell the user the session name and, if saved as a Document, that it is in Documents.',
      });
    },
  });
}
