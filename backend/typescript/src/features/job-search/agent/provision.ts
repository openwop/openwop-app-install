/**
 * ADR 0543 P1 — provision the career agent.
 *
 * The persona is DATA (`packs/feature.career-agent.agents`). This module only
 * WIRES it into the tenant's existing primitives: a roster member, a kanban
 * board it owns, and default instructions. Per the house law, nothing unique to
 * a named agent lives in host source — there is no `if (agent === 'career')`
 * anywhere, and the heartbeat needs no change to run it.
 *
 * ## What this deliberately does NOT do (D1)
 *
 * No loop. The heartbeat daemon selects the work (ranked by ADR 0534), the
 * kanban board holds it, ADR 0535 recovers it when a run dies, and the run budget
 * bounds it. Every row of that was already shipped; a `pilot` service here would
 * be a second execution model beside a working one.
 *
 * ## Idempotency
 *
 * Provisioning is re-runnable — a tenant toggling the feature, a seeder, and an
 * explicit route can all reach it. The roster persona is therefore looked up by
 * a DETERMINISTIC persona slug rather than minted with a random id: a random id
 * on a re-runnable path is the duplicate-generator this repo has been bitten by,
 * and it produces a second "career agent" nobody asked for.
 */
import { createLogger } from '../../../observability/logger.js';
import { createRosterEntry, listRoster } from '../../../host/rosterService.js';
import { createBoard, listBoards, listCards, createCard, type KanbanCard } from '../../../host/kanbanService.js';
import { applyGrants } from '../../../host/applyGrant.js';
import { OpenwopError } from '../../../types.js';

const log = createLogger('job-search.agent.provision');

/** The persona slug. Stable, and the idempotency key for the roster lookup. */
export const CAREER_PERSONA = 'career-agent';
/** The pack-declared agent id this roster member dispatches to. */
export const CAREER_AGENT_ID = 'career-agent';
export const CAREER_BOARD_NAME = 'Job search';

export interface ProvisionResult {
  rosterId: string;
  boardId: string;
  /** False when everything already existed — a re-run, not a new agent. */
  created: boolean;
}

/**
 * Ensure the career agent exists for a tenant.
 *
 * `autonomyLevel: 'review'` is the deliberate default. The agent proposes every
 * pick until a person changes that — and auto-SUBMIT is separately bounded by the
 * ADR 0541 grant, so the two gates are independent by construction. A single
 * "autonomous" switch that meant both would make one decision look like two.
 */
export async function provisionCareerAgent(tenantId: string): Promise<ProvisionResult> {
  const roster = await listRoster(tenantId);
  const existing = roster.find((r) => r.persona === CAREER_PERSONA);

  let rosterId = existing?.rosterId ?? '';
  let created = false;
  if (!existing) {
    const entry = await createRosterEntry({
      tenantId,
      persona: CAREER_PERSONA,
      agentRef: { agentId: CAREER_AGENT_ID },
      label: 'Career agent',
      description: 'Finds roles, scores fit, and prepares applications within the limits you set.',
      enabled: true,
      autonomyLevel: 'review',
    });
    rosterId = entry.rosterId;
    created = true;
  }

  // The board is the agent's WORK QUEUE, and it is a normal kanban board on
  // purpose: ranked selection (ADR 0534), stranded-card recovery (ADR 0535) and
  // the run budget all operate on it with no knowledge of this feature.
  const boards = await listBoards(tenantId);
  const board = boards.find((b) => b.rosterId === rosterId || b.name === CAREER_BOARD_NAME);
  let boardId = board?.id ?? '';
  if (!board) {
    const made = await createBoard({ tenantId, name: CAREER_BOARD_NAME, rosterId });
    boardId = made.id;
    created = true;
  }

  log.info('career_agent_provisioned', { tenantId, rosterId, boardId, created });
  return { rosterId, boardId, created };
}

/** The stable workflow id campaign cards dispatch. Registered chain-backed in
 *  `feature.ts` (which imports THIS const — one owner, no twin). */
export const CAREER_CAMPAIGN_CARD_WORKFLOW_ID = 'career.campaign';

export interface QueueCampaignResult {
  card: KanbanCard;
  boardId: string;
  /** False when an identical card was already waiting — the idempotent retry. */
  created: boolean;
}

/**
 * WF-JS-1 — file the campaign card: the STACK-lane intake for a campaign pass.
 *
 * This function only QUEUES. Execution stays with the heartbeat loop — ranked
 * pick (ADR 0534), agent policy, run budget, and (at the default
 * `autonomyLevel:'review'`) a human approval card before the run starts. A
 * "run it now" path here would be a second executor beside the loop.
 *
 * Fail-closed: refuses (409) when the tenant holds NO live grant — a card that
 * could only ever produce a wall of `refused: no-grant` rows is intake theatre,
 * and the user is better served by the refusal naming the real precondition.
 *
 * Idempotent: an identical card already in a NON-terminal column is returned
 * as-is (`created:false`) — clicking twice queues once. A completed/failed
 * card does not block a new queue (a new pass is a new ask).
 */
export async function queueCampaignCard(tenantId: string, actor: string, now: number): Promise<QueueCampaignResult> {
  const grants = await applyGrants.listByPrefix(`${tenantId}:`);
  const live = grants.filter((g) => !g.revokedAt && Date.parse(g.expiresAt) > now && g.submitsUsed < g.maxSubmits);
  if (live.length === 0) {
    // `invalid_request` @409 is the house shape for "a stated precondition is
    // missing — do X first" (the app-builder's unbound-repo precedent). The
    // canonical error-code union is closed; a bespoke code would be wire drift.
    throw new OpenwopError(
      'invalid_request',
      'No active apply grant — issue one on the Auto-apply authority page first. A campaign pass without a grant could not submit anything.',
      409,
      { reason: 'no_active_grant' },
    );
  }

  const { boardId } = await provisionCareerAgent(tenantId);
  const board = (await listBoards(tenantId)).find((b) => b.id === boardId);
  const todoColumn = board?.columns.find((c) => c.id === 'todo') ?? board?.columns[0];
  if (!board || !todoColumn) {
    throw new OpenwopError('internal_error', 'The career agent board is missing its To Do column.', 500, {});
  }

  const existing = (await listCards(boardId)).find(
    (c) =>
      c.workflowId === CAREER_CAMPAIGN_CARD_WORKFLOW_ID &&
      !board.columns.find((col) => col.id === c.columnId)?.terminal,
  );
  if (existing) return { card: existing, boardId, created: false };

  const card = await createCard({
    boardId,
    columnId: todoColumn.id,
    title: 'Run a job-search campaign pass',
    description:
      'One pass over the stored listings under your apply grant: score, screen, answer from the bank, and apply where a board supports it — within the grant ceiling, hourly pace, and daily cap.',
    workflowId: CAREER_CAMPAIGN_CARD_WORKFLOW_ID,
    source: 'api',
    sourceLabel: 'Auto-apply authority',
    createdBy: actor,
  });
  log.info('campaign_card_queued', { tenantId, boardId, cardId: card.id });
  return { card, boardId, created: true };
}
