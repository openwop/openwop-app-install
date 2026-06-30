/**
 * Strategy + Priority Matrix + Board of Advisors SHOWCASE seeder.
 *
 * Composes the three features into one coherent fictional company (see
 * `seed-data/strategyShowcase.ts`): scored priority lists, strategies LINKED to
 * those priorities, and a "Board of Directors" advisory board carrying the org
 * strategies as context — so the board (or the Strategy Analyst agent) can access
 * and analyze the whole plan and give grounded guidance.
 *
 * Gated on ALL THREE toggles (strategy + priority-matrix + advisory-board); the
 * board cohort reuses the advisors seeded by the `advisors` step (dependsOn).
 * Idempotent + all-or-nothing: the cross-references (strategy links, board
 * contextRefs) only line up when the set is built together, so a re-seed is a
 * no-op once present and `clear()` removes the whole set. RBAC: seeding runs in
 * demo mode where any subject resolves to the tenant owner, so the seed actor can
 * link priorities + attach strategy contextRefs (accessControlService §demo
 * single-tenant exception).
 */
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import { listRoster } from './rosterService.js';
import { createList, submitIdea, setIdeaScore, listLists, deleteList } from '../features/priority-matrix/priorityMatrixService.js';
import { createStrategy, listStrategies, hardDeleteStrategy } from '../features/strategy/strategyService.js';
import type { StrategyLink } from '../features/strategy/types.js';
import { createBoard, listBoards, deleteBoard } from '../features/advisory-board/service.js';
import { SHOWCASE, type ShowcaseLink } from './seed-data/strategyShowcase.js';

const log = createLogger('seed.strategyShowcase');

/** Marks every entity this seeder creates (for count + clear). */
export const SHOWCASE_SEED_ACTOR = 'demo:strategy-showcase';

async function gatesOpen(tenantId: string): Promise<boolean> {
  const [s, p, a] = await Promise.all([
    resolveOne('strategy', { tenantId }),
    resolveOne('priority-matrix', { tenantId }),
    resolveOne('advisory-board', { tenantId }),
  ]);
  return Boolean(s?.enabled && p?.enabled && a?.enabled);
}

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}

export interface ShowcaseSeedResult {
  created: number;
  skipped?: 'toggle-off' | 'already-seeded';
  details?: { strategies: number; lists: number; ideas: number; board: number };
}

/** Count the canonical showcase entities present for a tenant. */
export async function countStrategyShowcase(tenantId: string): Promise<number> {
  const [strategies, lists, boards] = await Promise.all([
    listStrategies(tenantId, { includeArchived: true }),
    listLists(tenantId),
    listBoards(tenantId, undefined),
  ]);
  const strat = strategies.filter((s) => s.createdBy === SHOWCASE_SEED_ACTOR).length;
  const list = lists.filter((l) => l.createdBy === SHOWCASE_SEED_ACTOR).length;
  const board = boards.filter((b) => b.handle === SHOWCASE.board.handle).length;
  return strat + list + board;
}

export async function seedStrategyShowcase(tenantId: string, _storage: Storage): Promise<ShowcaseSeedResult> {
  if (!(await gatesOpen(tenantId))) {
    log.debug('strategy_showcase_skipped_toggle_off', { tenantId });
    return { created: 0, skipped: 'toggle-off' };
  }
  // Idempotency: skip if ANY showcase entity already exists. Check BOTH lists
  // (created first) and strategies, so a re-seed never duplicates even if a prior
  // run died part-way (e.g. after the lists but before the strategies).
  const [existingStrategies, existingLists] = await Promise.all([
    listStrategies(tenantId, { includeArchived: true }),
    listLists(tenantId),
  ]);
  if (existingStrategies.some((s) => s.createdBy === SHOWCASE_SEED_ACTOR) || existingLists.some((l) => l.createdBy === SHOWCASE_SEED_ACTOR)) {
    return { created: 0, skipped: 'already-seeded' };
  }

  const orgId = await orgIdFor(tenantId);

  // 1) Priority lists + scored ideas. Capture generated ids for the symbolic links.
  const listIdByKey = new Map<string, string>();
  const cardIdByKey = new Map<string, string>(); // `${listKey}:${ideaKey}` -> cardId
  let ideaCount = 0;
  for (const l of SHOWCASE.lists) {
    const list = await createList(tenantId, orgId, SHOWCASE_SEED_ACTOR, { name: l.name, presetId: l.presetId });
    listIdByKey.set(l.key, list.id);
    for (const idea of l.ideas) {
      const card = await submitIdea(tenantId, list.id, SHOWCASE_SEED_ACTOR, { title: idea.title, description: idea.description });
      cardIdByKey.set(`${l.key}:${idea.key}`, card.id);
      await setIdeaScore(tenantId, list.id, card.id, SHOWCASE_SEED_ACTOR, idea.scores);
      ideaCount += 1;
    }
  }

  // 2) Strategies, resolving each symbolic link to the real list/card ids.
  const resolveLink = (link: ShowcaseLink): StrategyLink | null => {
    const listId = listIdByKey.get(link.listKey);
    if (!listId) return null;
    if (link.kind === 'priority-list') return { kind: 'priority-list', listId };
    const cardId = cardIdByKey.get(`${link.listKey}:${link.ideaKey}`);
    return cardId ? { kind: 'priority-idea', listId, cardId } : null;
  };
  const strategyIdByKey = new Map<string, string>();
  for (const s of SHOWCASE.strategies) {
    const links = s.links.map(resolveLink).filter((l): l is StrategyLink => l !== null);
    const strategy = await createStrategy(tenantId, orgId, SHOWCASE_SEED_ACTOR, {
      scope: s.scope,
      title: s.title,
      summary: s.summary,
      rationale: s.rationale,
      planningHorizon: s.planningHorizon,
      period: s.period,
      accountableExecutive: s.accountableExecutive,
      status: s.status,
      confidence: s.confidence,
      risk: s.risk,
      objectives: s.objectives,
      initiatives: s.initiatives,
      links,
    });
    strategyIdByKey.set(s.key, strategy.id);
  }

  // 3) Board of Directors — reuse the seeded advisor cohort, carry the org
  //    strategies as contextRefs (resolved per-convener at @@ summon).
  let boardCreated = 0;
  const advisors = (await listRoster(tenantId))
    .filter((r) => r.roleKey === 'advisor')
    .map((r) => r.rosterId)
    .slice(0, 8);
  const contextRefs = SHOWCASE.board.contextStrategyKeys
    .map((k) => strategyIdByKey.get(k))
    .filter((id): id is string => typeof id === 'string')
    .map((strategyId) => ({ kind: 'strategy' as const, strategyId }));
  if (advisors.length > 0) {
    try {
      await createBoard(tenantId, orgId, SHOWCASE_SEED_ACTOR, {
        name: SHOWCASE.board.name,
        handle: SHOWCASE.board.handle,
        advisors,
        contextRefs,
        visibility: 'shared',
        personaKind: 'original',
      });
      boardCreated = 1;
    } catch (err) {
      // contextRefs validation rejects strategies the seed actor can't read —
      // which only happens OUTSIDE demo mode (where the actor is the tenant
      // owner). Don't fail the whole step: the strategies + priorities are the
      // core of the showcase; the context-bearing board needs demo mode.
      log.warn('strategy_showcase_board_skipped', { tenantId, error: err instanceof Error ? err.message : String(err) });
    }
  } else {
    log.warn('strategy_showcase_board_skipped_no_advisors', { tenantId });
  }

  const details = { strategies: strategyIdByKey.size, lists: listIdByKey.size, ideas: ideaCount, board: boardCreated };
  log.info('strategy_showcase_seeded', { tenantId, ...details });
  return { created: details.strategies + details.lists + details.ideas + details.board, details };
}

export async function clearStrategyShowcase(tenantId: string, _storage: Storage): Promise<{ cleared: number; details: { strategies: number; lists: number; board: number } }> {
  let strategies = 0, lists = 0, board = 0;

  for (const b of await listBoards(tenantId, undefined)) {
    if (b.handle !== SHOWCASE.board.handle) continue;
    await deleteBoard(tenantId, SHOWCASE_SEED_ACTOR, b.boardId);
    board += 1;
  }
  for (const s of await listStrategies(tenantId, { includeArchived: true })) {
    if (s.createdBy !== SHOWCASE_SEED_ACTOR) continue;
    if (await hardDeleteStrategy(tenantId, s.id)) strategies += 1;
  }
  for (const l of await listLists(tenantId)) {
    if (l.createdBy !== SHOWCASE_SEED_ACTOR) continue;
    if (await deleteList(tenantId, l.id)) lists += 1;
  }

  return { cleared: strategies + lists + board, details: { strategies, lists, board } };
}
