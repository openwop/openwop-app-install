/**
 * Strategy showcase seeder — proves the cross-feature demo:
 *   - seeds 3 scored Priority Matrix lists, 5 Strategies linked to those
 *     priorities, and a "Board of Directors" carrying the org strategies;
 *   - the BOARD CAN ACCESS the plan: resolveBoardContext (what advisors receive
 *     at @@ summon) contains both strategy narrative AND linked priority ideas;
 *   - the board/analyst CAN ANALYZE it: the health rollup flags the strategy with
 *     no linked execution as off-track, and the context block surfaces the
 *     deliberate gaps (owner-less initiative, KRs behind target);
 *   - it is idempotent and clears cleanly.
 *
 * Runs in demo mode so the seed actor + convener resolve to the tenant owner
 * (accessControlService §demo single-tenant exception) — the same posture a real
 * demo deployment runs under.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { seedAdvisoryBoards } from '../src/host/advisoryBoardSeed.js';
import { seedStrategyShowcase, clearStrategyShowcase, countStrategyShowcase } from '../src/host/strategyShowcaseSeed.js';
import { listLists, listRankedIdeas } from '../src/features/priority-matrix/priorityMatrixService.js';
import { listStrategies } from '../src/features/strategy/strategyService.js';
import { buildStrategySurface } from '../src/features/strategy/surface.js';
import { listBoards } from '../src/features/advisory-board/service.js';
import { resolveBoardContext } from '../src/host/boardContextResolver.js';

let server: http.Server;
const TENANT = 'user:strategy-showcase-test';
const CONVENER = 'demo:convener';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_DEMO_MODE = 'true';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => res()); });
  for (const id of ['strategy', 'priority-matrix', 'advisory-board', 'kb', 'users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  delete process.env.OPENWOP_DEMO_MODE;
  await new Promise<void>((res) => server.close(() => res()));
});

const surface = () => buildStrategySurface({ tenantId: TENANT });

function storageOrThrow() {
  const s = __hostExtStorage();
  if (!s) throw new Error('host-ext storage not initialized');
  return s;
}

describe('strategy showcase seeder', () => {
  it('seeds priorities + strategies + a context-bearing board, and the board can access & analyze the plan', async () => {
    const storage = storageOrThrow();
    // Dependency: the board cohort reuses the seeded advisors.
    await seedAdvisoryBoards(TENANT, storage, { heal: true });
    const result = await seedStrategyShowcase(TENANT, storage);

    // ── seeded the cross-feature set ──────────────────────────────────────────
    expect(result.skipped).toBeUndefined();
    expect(result.details).toMatchObject({ strategies: 5, lists: 3, board: 1 });
    expect(result.details!.ideas).toBeGreaterThanOrEqual(15);

    // Priority Matrix: 3 lists, ideas scored + ranked (high-scored bet on top).
    const lists = (await listLists(TENANT)).filter((l) => l.createdBy === 'demo:strategy-showcase');
    expect(lists).toHaveLength(3);
    const roadmap = lists.find((l) => l.name === 'Product Roadmap Bets')!;
    const ranked = await listRankedIdeas(TENANT, roadmap.id);
    expect(ranked.length).toBeGreaterThanOrEqual(7);
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[0]!.computedPriority).toBeGreaterThan(ranked[ranked.length - 1]!.computedPriority);
    // A high-scored bet outranks a deliberately low-scored one.
    const sso = ranked.findIndex((r) => r.card.title === 'Enterprise SSO & SCIM');
    const whitelabel = ranked.findIndex((r) => r.card.title === 'White-label theming');
    expect(sso).toBeLessThan(whitelabel);

    // Strategies: 5, with links wired to the priorities.
    const strategies = (await listStrategies(TENANT, { includeArchived: false })).filter((s) => s.createdBy === 'demo:strategy-showcase');
    expect(strategies).toHaveLength(5);
    const fy26 = strategies.find((s) => s.title.startsWith('FY26'))!;
    expect(fy26.links.some((l) => l.kind === 'priority-idea')).toBe(true);

    // Board of Directors: created, carrying the 4 org strategies as contextRefs.
    const boards = await listBoards(TENANT, undefined);
    const board = boards.find((b) => b.handle === 'board-of-directors')!;
    expect(board).toBeTruthy();
    expect(board.advisors.length).toBeGreaterThan(0);
    expect(board.contextRefs ?? []).toHaveLength(4);

    // ── ACCESS: what advisors receive at @@ summon contains strategy AND the
    //    linked priorities (the board reaches both features through one block) ──
    const block = await resolveBoardContext(TENANT, board.boardId, CONVENER);
    expect(block).toBeTruthy();
    expect(block).toContain('FY26 — Scale to $50M ARR');          // strategy narrative
    expect(block).toContain('Become the category leader by FY28');
    expect(block).toContain('Enterprise SSO & SCIM');             // a LINKED priority idea
    expect(block).toContain('Net revenue retention');             // a key result (analyzable)

    // ── ANALYZE: the health rollup yields real, differentiated guidance ───────
    const health = (await surface().getHealth!({})) as { strategies: Array<{ title: string; health: string; signals?: { hasExecution?: boolean } }> };
    const emea = health.strategies.find((h) => h.title.includes('EMEA'))!;
    // A strategy with objectives but NO linked execution is flagged off-track.
    expect(emea.health).toBe('off-track');
    expect(emea.signals?.hasExecution).toBe(false);
    // A well-wired strategy is not off-track.
    const ga = health.strategies.find((h) => h.title.includes('Platform GA'))!;
    expect(ga.health).not.toBe('off-track');

    // ── idempotent: a re-seed is a no-op (no duplicates) ──────────────────────
    const again = await seedStrategyShowcase(TENANT, storage);
    expect(again.skipped).toBe('already-seeded');
    expect(again.created).toBe(0);

    // ── clears cleanly (only its own entities) ────────────────────────────────
    expect(await countStrategyShowcase(TENANT)).toBeGreaterThan(0);
    const cleared = await clearStrategyShowcase(TENANT, storage);
    expect(cleared.details).toMatchObject({ strategies: 5, lists: 3, board: 1 });
    expect(await countStrategyShowcase(TENANT)).toBe(0);
  });
});
