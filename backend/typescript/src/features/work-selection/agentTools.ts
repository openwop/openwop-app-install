/**
 * ADR 0534 P4 — the work-selection agent tool (ADR 0308 chat-drivability seam).
 *
 * A surface alone is not chat-drivable (surface-backed nodes are excluded from
 * the chat tool projection), so "what would you pick up next, and why" reaches a
 * chat agent through `registerFeatureAgentTool`.
 *
 * READ-ONLY, and deliberately so: an agent that could reorder its own queue
 * would be able to promote work past the agent-policy verdict and the run
 * budget. There is no write tool here and there should not be one.
 *
 * Two rules from ADR 0308 that this obeys literally:
 *
 *  - the tool SHARES its access predicate with the surface it mirrors — both go
 *    through `readBoardRanking` below, so the route and the tool cannot drift
 *    into disagreeing about who may see a board;
 *  - it fails EMPTY without an acting user, rather than falling back to some
 *    ambient tenant. No acting user ⇒ no authority ⇒ nothing to show.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import { getBoard, listCards, boardSubject } from '../../host/kanbanService.js';
import { resolveSubjectAccess, levelSatisfies } from '../../host/subjectAccess.js';
import { rankByPriority } from '../../host/weightedScoring.js';
import { WORK_SELECTION_CRITERIA, projectCardScores } from './compiler.js';
import { WORK_SELECTION_TOGGLE } from './service.js';

export const WORK_SELECTION_PREVIEW_TOOL_ID = 'openwop:work-selection.preview';

const CRITERION_NAMES = new Map(WORK_SELECTION_CRITERIA.criteria.map((c) => [c.id, c.name]));

export interface RankedCardView {
  cardId: string;
  title: string;
  rank: number;
  score: number;
  why: Array<{ criterionId: string; criterion: string; value: number }>;
}

/**
 * The SHARED access predicate + ranking read. The surface op and the agent tool
 * both call this, so there is exactly one answer to "may this caller see this
 * board, and what is its ranking".
 *
 * Returns `[]` for unknown OR cross-tenant boards without distinguishing them —
 * a caller probing ids must not be able to tell "does not exist" from "not
 * yours".
 */
export async function readBoardRanking(
  tenantId: string | undefined,
  boardId: string,
  now: number,
  caller: string | undefined,
): Promise<RankedCardView[]> {
  if (!tenantId || !boardId) return [];
  const board = await getBoard(boardId);
  if (!board || board.tenantId !== tenantId) return [];

  // ADR 0610 D3′ / WSC-1 (=CPC-14) — a board bound to a project is
  // membership-scoped; the tenant check above is NOT sufficient (a private
  // project's board must not rank to a non-member). Consult the ONE
  // `host/subjectAccess.ts` seam. Null ⇒ not membership-scoped ⇒ tenant gate
  // stands. Report EMPTY on refusal (the door's fail-closed posture — a caller
  // probing ids can't tell "not yours" from "does not exist").
  //
  // ADR 0716 D1 — derive the owner with `boardSubject`, the SAME canonical query
  // `routes/kanban.ts:109` uses, not the raw `ownerSubject` field. ADR 0045 added
  // `boardSubject` precisely as the bridge from the legacy `rosterId`/`ownerUserId`
  // storage fields, so reading the field directly makes this door blind to a board
  // whose ownership is recorded the legacy way — it skipped the gate before the
  // resolver was ever consulted.
  //
  // This changes NO answer today (measured): there is no `'user'`/`'agent'`
  // resolver, so both forms return null for exactly those boards, and null means
  // the same thing here as at `authorizeBoard` — the documented legacy rule that
  // agent/personal boards keep tenant-wide visibility. It matters the moment such a
  // resolver IS registered: kanban would refuse a non-owner while this door kept
  // returning the board's card TITLES, into an agent tool's context.
  const owner = boardSubject(board);
  if (owner) {
    const level = await resolveSubjectAccess(tenantId, owner, caller);
    if (level !== null && !levelSatisfies(level, 'read')) return [];
  }

  const todo = board.columns.find((c) => c.id === 'todo' || c.name.toLowerCase() === 'to do');
  if (!todo) return [];

  const candidates = (await listCards(boardId)).filter((c) => c.columnId === todo.id);
  // Project ONCE per card and reuse for both ranking and the "why" rendering.
  // Projecting again inside the map would double the work per card on a path the
  // board panel polls.
  const scoresByCard = new Map(candidates.map((c) => [c.id, projectCardScores(c, now)]));
  return rankByPriority(WORK_SELECTION_CRITERIA, candidates, (card) => scoresByCard.get(card.id) ?? {})
    .map((r) => ({
      cardId: r.item.id,
      title: r.item.title,
      rank: r.rank,
      score: r.priority,
      why: Object.entries(scoresByCard.get(r.item.id) ?? {}).map(([criterionId, value]) => ({
        criterionId,
        criterion: CRITERION_NAMES.get(criterionId) ?? criterionId,
        value,
      })),
    }));
}

const toolError = (code: string, message: string) => ({
  content: JSON.stringify({ error: { code, message } }),
  isError: true as const,
});

export function registerWorkSelectionAgentTools(): void {
  registerFeatureAgentTool({
    // UNTRUSTED — the RFC 0137 §F1 ratchet caught this, correctly. The ranks and
    // criterion values are ours, but every row carries a card TITLE, which is
    // free text any workspace member can author. In a shared workspace that is
    // an attacker-choosable string reaching the model, so it must be FENCED.
    // "The caller could already see the title" is an access argument; content
    // trust is an injection argument, and they are not the same question.
    contentTrust: 'untrusted',
    def: {
      name: WORK_SELECTION_PREVIEW_TOOL_ID,
      description:
        'Show which To Do card the autonomous work loop would pick up next on a board, and why. '
        + 'Returns every candidate ranked, each with the per-criterion values behind its score '
        + '(due-date urgency, stated priority, age, blocked). Read-only — this never reorders or starts anything. '
        + 'Use it to answer "what are you working on next?" or "why is this card not being picked up?".',
      inputSchema: {
        type: 'object',
        properties: {
          boardId: { type: 'string', description: 'The board whose To Do lane to rank.' },
        },
        required: ['boardId'],
      },
    },
    async run(input, scope) {
      if (!(await resolveFeatureToggle(WORK_SELECTION_TOGGLE, scope))) {
        return toolError('feature_disabled', 'Ranked work selection is not enabled for this workspace.');
      }
      // ADR 0308 — fail EMPTY without an acting user; never fall back to an
      // ambient tenant, which would read another caller's board.
      if (!scope.actingUserId) return { content: JSON.stringify({ ranked: [] }) };

      const boardId = typeof input.boardId === 'string' ? input.boardId : '';
      const ranked = await readBoardRanking(scope.tenantId, boardId, Date.now(), scope.actingUserId);
      return { content: JSON.stringify({ ranked, count: ranked.length }) };
    },
  });
}
