/**
 * ADR 0986 D4–D6 — the bound arena (`features/evals/arena.ts`) and its Bradley–Terry
 * standings, service-level over a seeded memory storage: real conversation runs
 * (run row + `conversation.opened` / `conversation.exchanged` events) and the
 * host's per-turn attribution rows, so every refusal is exercised on the shape
 * production writes. The route-level legs (HTTP, ownership through a cookie,
 * the ONE chat's exchange) are in `adr0986-evals-leaderboard.test.ts`.
 *
 * Replaces the ADR 0123/0700 string-verdict cases. Kept from them: the EVC-2
 * rotation-evasion cap and its positive controls. The tenant-blind matchId
 * (`it.fails`, BLOCKED-ON-PRODUCT) is closed: the match id hashes the tenant.
 *
 * Sabotage witnesses (re-probed grade-tests w119): swapping the attributed models;
 * dropping the replay orientation, the unordered-pair sort, or BOTH halves of the
 * count-once double guard (the prior-match read and the create-if-absent CAS — either
 * alone is masked by the other); dropping the prompt comparison or the parts in it;
 * the same-model, `row.runId`, mixed-model, tenant, owner or workflow check; the tenant
 * in the match id; the cap's either-side count, its bound, its per-rater or per-model
 * scope; the provider/model key lookup; the bound-verdict filter; or the erasure's
 * subject match, loop or tombstone — each reds a case below.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { recordTurnAttribution, type ServedModel } from '../src/host/turnAttribution.js';
import { recordArenaMatch, arenaMatchId, arenaStandings, getArenaRating, eraseArenaRaterSubject, MAX_RATER_MATCHES_PER_MODEL } from '../src/features/evals/arena.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

let storage: Storage;
const AT = '2026-10-26T00:00:00.000Z';
beforeAll(async () => { storage = await openStorage('memory://'); initHostExtPersistence(storage); });

const openai = (model: string): ServedModel => ({ provider: 'openai', model });

/** Seed one conversation run: `prompts[i]` answered by `served[i]` (null ⇒ no
 *  attribution row). `attributeAs` writes the rows under another run id (a fork). */
async function seedRun(tenantId: string, actor: string, prompts: unknown[], served: Array<ServedModel | null>, opts: { workflowId?: string; attributeAs?: string } = {}): Promise<string> {
  const runId = `run-${randomBytes(6).toString('hex')}`;
  const now = AT;
  const record: RunRecord = { runId, workflowId: opts.workflowId ?? 'openwop-app.conversation', tenantId, status: 'completed', inputs: {}, configurable: {}, metadata: { actingUserId: actor }, createdAt: now, updatedAt: now };
  await storage.insertRun(record);
  const conversationId = `${runId}:gate:0`;
  await storage.appendEvent({ eventId: `${runId}-o`, runId, type: 'conversation.opened', nodeId: 'gate', timestamp: now, payload: { conversationId, initialTurn: { messageId: `${conversationId}:0:system`, role: 'system', from: 'host', content: 'hi', ts: 0, turnIndex: 0 } } });
  let idx = 1;
  for (let i = 0; i < prompts.length; i += 1) {
    const u = { messageId: `${conversationId}:${idx}:user`, role: 'user', from: 'user', content: prompts[i], ts: idx, turnIndex: idx };
    const a = { messageId: `${conversationId}:${idx + 1}:agent`, role: 'agent', from: 'assistant', content: `reply ${i}`, ts: idx + 1, turnIndex: idx + 1 };
    await storage.appendEvent({ eventId: `${runId}-u${i}`, runId, type: 'conversation.exchanged', nodeId: 'gate', timestamp: now, payload: { conversationId, turnIndex: idx, turn: u } });
    await storage.appendEvent({ eventId: `${runId}-a${i}`, runId, type: 'conversation.exchanged', nodeId: 'gate', timestamp: now, payload: { conversationId, turnIndex: idx + 1, turn: a } });
    const s = served[i];
    if (s) await recordTurnAttribution({ tenantId, wireMessageId: a.messageId, runId: opts.attributeAs ?? runId, served: s });
    idx += 2;
  }
  return runId;
}

const vote = (tenantId: string, runIdA: string, runIdB: string, winner: 'A' | 'B' | 'tie', rater = 'user:r1', callerKeys = ['r1']) =>
  recordArenaMatch(storage, tenantId, { runIdA, runIdB, winner, raterSubject: rater, callerKeys, createdAt: AT });

async function pair(tenantId: string, a: string, b: string, actor = 'r1', prompt: unknown = 'Write a haiku.'): Promise<[string, string]> {
  return [await seedRun(tenantId, actor, [prompt], [openai(a)]), await seedRun(tenantId, actor, [prompt], [openai(b)])];
}

describe('recordArenaMatch — a verdict is bound to two real runs', () => {
  it('records the ATTRIBUTED models and moves both ratings', async () => {
    const T = 'arena-basic';
    const [ra, rb] = await pair(T, 'alpha', 'beta');
    const r = await vote(T, ra, rb, 'A');
    expect(r.match).toMatchObject({ modelA: 'alpha', modelB: 'beta', providerA: 'openai', runIdA: ra, runIdB: rb, winner: 'A' });
    expect(r.ratingA).toBeGreaterThan(1500);
    expect(r.ratingB).toBeLessThan(1500);
    expect(await getArenaRating(T, 'alpha')).toBeCloseTo(r.ratingA);
  });

  it('a pair counts ONCE — a repeat (either order) replays the stored verdict', async () => {
    const T = 'arena-once';
    const [ra, rb] = await pair(T, 'alpha', 'beta');
    await vote(T, ra, rb, 'A');
    const again = await vote(T, rb, ra, 'tie');
    expect(again.replayed).toBe(true);
    // Answered in the REQUEST's orientation: rb is now side A, so the stored "A
    // (alpha) won" reads as B won.
    expect(again.match).toMatchObject({ runIdA: rb, modelA: 'beta', modelB: 'alpha', winner: 'B' });
    expect((await arenaStandings(T)).find((s) => s.model === 'alpha')).toMatchObject({ matches: 1 });
  });

  it('refuses runs that did not answer the same prompts (content compared whole, parts included)', async () => {
    const T = 'arena-prompt';
    const [ra] = await pair(T, 'alpha', 'x');
    const rb = await seedRun(T, 'r1', ['Write a limerick.'], [openai('beta')]);
    await expect(vote(T, ra, rb, 'A')).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'arena_prompt_mismatch' } });
    const withImage = await seedRun(T, 'r1', [[{ type: 'text', text: 'Write a haiku.' }, { type: 'image', url: 'x' }]], [openai('gamma')]);
    const textOnly = await seedRun(T, 'r1', [[{ type: 'text', text: 'Write a haiku.' }]], [openai('delta')]);
    await expect(vote(T, withImage, textOnly, 'A')).rejects.toMatchObject({ details: { reason: 'arena_prompt_mismatch' } });
  });

  it('refuses two runs answered by the same model', async () => {
    const T = 'arena-same';
    const [ra, rb] = await pair(T, 'alpha', 'alpha');
    await expect(vote(T, ra, rb, 'tie')).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'arena_same_model' } });
  });

  it('refuses a reply with no attribution, and a FORK whose turn ids resolve to the source run\'s rows', async () => {
    const T = 'arena-unattr';
    const ra = await seedRun(T, 'r1', ['p'], [openai('alpha')]);
    const bare = await seedRun(T, 'r1', ['p'], [null]);
    await expect(vote(T, ra, bare, 'A')).rejects.toMatchObject({ details: { reason: 'arena_unattributed' } });
    const fork = await seedRun(T, 'r1', ['p'], [openai('beta')], { attributeAs: 'some-other-run' });
    await expect(vote(T, ra, fork, 'A')).rejects.toMatchObject({ details: { reason: 'arena_unattributed' } });
  });

  it('refuses a run answered by more than one model', async () => {
    const T = 'arena-mixed';
    const ra = await seedRun(T, 'r1', ['p', 'q'], [openai('alpha'), openai('beta')]);
    const rb = await seedRun(T, 'r1', ['p', 'q'], [openai('gamma'), openai('gamma')]);
    await expect(vote(T, ra, rb, 'A')).rejects.toMatchObject({ details: { reason: 'arena_mixed_models' } });
  });

  it('another member\'s run, another tenant\'s run, or a non-conversation run reads as absent (404)', async () => {
    const T = 'arena-owner';
    const [ra] = await pair(T, 'alpha', 'x');
    // Each refusal names the run it refused (the run-gate's own 404, not some other one).
    const theirs = await seedRun(T, 'someone-else', ['Write a haiku.'], [openai('beta')]);
    await expect(vote(T, ra, theirs, 'A')).rejects.toMatchObject({ code: 'run_not_found', httpStatus: 404, details: { runId: theirs } });
    const elsewhere = await seedRun('arena-owner-other', 'r1', ['Write a haiku.'], [openai('beta')]);
    await expect(vote(T, ra, elsewhere, 'A')).rejects.toMatchObject({ code: 'run_not_found', httpStatus: 404, details: { runId: elsewhere } });
    const notChat = await seedRun(T, 'r1', ['Write a haiku.'], [openai('beta')], { workflowId: 'wf.other' });
    await expect(vote(T, ra, notChat, 'A')).rejects.toMatchObject({ code: 'run_not_found', httpStatus: 404, details: { runId: notChat } });
    // Positive control: the same pair shape on the caller's own conversation runs records.
    const mine = await seedRun(T, 'r1', ['Write a haiku.'], [openai('beta')]);
    expect((await vote(T, ra, mine, 'A')).match).toMatchObject({ modelA: 'alpha', modelB: 'beta' });
  });

  it('the match id is one per unordered pair, and differs per tenant', () => {
    expect(arenaMatchId('t1', 'run-a', 'run-b')).toBe(arenaMatchId('t1', 'run-b', 'run-a'));
    expect(arenaMatchId('t1', 'run-a', 'run-b')).not.toBe(arenaMatchId('t2', 'run-a', 'run-b'));
  });

  it('the same run pair in two tenants is two verdicts (the match id hashes the tenant)', async () => {
    // Run ids are global, so one pair cannot be seeded in two tenants. Instead plant a
    // FOREIGN tenant's verdict under the id a tenant-blind hash gives T2's pair (the
    // pre-0986 ledger shape, which replayed tenant X's verdict into tenant Y). With the
    // tenant in the hash, T2's vote never reads it.
    const T1 = 'arena-mid-x'; const T2 = 'arena-mid-y';
    const [a2, b2] = await pair(T2, 'alpha', 'beta');
    const [lo, hi] = [a2, b2].sort();
    const blindId = `am_${createHash('sha256').update(`${lo}\u0000${hi}`).digest('hex').slice(0, 32)}`;
    const ledger = new DurableCollection<Record<string, unknown>>('evals:arena-match', (m) => String(m.matchId), undefined, (m) => String(m.tenantId));
    await ledger.put({ matchId: blindId, tenantId: T1, modelA: 'alpha', modelB: 'beta', providerA: 'openai', providerB: 'openai', runIdA: a2, runIdB: b2, winner: 'B', raterSubject: 'user:r1', createdAt: AT });
    const r2 = await vote(T2, a2, b2, 'A');
    expect(r2.replayed).toBeUndefined();
    expect(r2.match).toMatchObject({ tenantId: T2, winner: 'A', runIdA: a2 });
    expect(r2.match.matchId).not.toBe(blindId);
  });
});

describe('EVC-2 — the per-(rater, model) cap survives the rebuild', () => {
  it('opponent rotation does not evade it; either side counts; another rater and disjoint models are unaffected', async () => {
    const T = 'arena-cap';
    // The prior verdicts put 'ca' on BOTH sides, so a one-sided count sees only half.
    for (let i = 0; i < MAX_RATER_MATCHES_PER_MODEL; i += 1) {
      const [ra, rb] = i % 2 === 0 ? await pair(T, 'ca', `opp-${i}`) : await pair(T, `opp-${i}`, 'ca');
      await vote(T, ra, rb, i % 2 === 0 ? 'A' : 'B', 'user:stuffer', ['r1']);
    }
    const [x1, x2] = await pair(T, 'ca', 'opp-fresh');
    await expect(vote(T, x1, x2, 'A', 'user:stuffer', ['r1'])).rejects.toMatchObject({ code: 'rate_limited', details: { reason: 'arena_rater_cap' } });
    const [y1, y2] = await pair(T, 'opp-fresh2', 'ca');
    await expect(vote(T, y1, y2, 'B', 'user:stuffer', ['r1'])).rejects.toMatchObject({ code: 'rate_limited', details: { reason: 'arena_rater_cap', model: 'openai/ca' } });
    const [h1, h2] = await pair(T, 'ca', 'opp-h', 'honest');
    expect((await vote(T, h1, h2, 'A', 'user:honest', ['honest'])).match.modelA).toBe('ca');
    const [d1, d2] = await pair(T, 'px', 'py');
    expect((await vote(T, d1, d2, 'A', 'user:stuffer', ['r1'])).match.modelA).toBe('px');
  });
});

describe('getArenaRating', () => {
  it('a bare model id served by two providers must be named by its provider/model key', async () => {
    const T = 'arena-ambiguous';
    const a = await seedRun(T, 'r1', ['p'], [{ provider: 'openai', model: 'm' }]);
    const b = await seedRun(T, 'r1', ['p'], [{ provider: 'openrouter', model: 'm' }]);
    await vote(T, a, b, 'A');
    await expect(getArenaRating(T, 'm')).rejects.toMatchObject({ code: 'validation_error' });
    expect(await getArenaRating(T, 'openai/m')).toBeGreaterThan(1500);
  });
});

describe('arenaStandings', () => {
  it('excludes pre-0986 string verdicts (never bound to runs)', async () => {
    const T = 'arena-legacy';
    const ledger = new DurableCollection<Record<string, unknown>>('evals:arena-match', (m) => String(m.matchId), undefined, (m) => String(m.tenantId));
    await ledger.put({ matchId: 'legacy-1', tenantId: T, modelA: 'forged', modelB: 'other', winner: 'A', raterSubject: 'user:x', createdAt: AT });
    expect(await arenaStandings(T)).toEqual([]);
  });
});

describe('eraseArenaRaterSubject (ADR 0986 D6)', () => {
  it('tombstones the rater on every verdict and keeps the verdict', async () => {
    const T = 'arena-erase';
    // Two verdicts by the erased person, one by somebody else (who must keep theirs).
    const [ra, rb] = await pair(T, 'alpha', 'beta', 'erased-user');
    await vote(T, ra, rb, 'B', 'user:erased-user', ['erased-user']);
    const [rc, rd] = await pair(T, 'gamma', 'delta', 'erased-user');
    await vote(T, rc, rd, 'A', 'user:erased-user', ['erased-user']);
    const [re, rf] = await pair(T, 'alpha', 'epsilon', 'keeper');
    await vote(T, re, rf, 'A', 'user:keeper', ['keeper']);
    await eraseArenaRaterSubject(T, 'erased-user');
    const ledger = new DurableCollection<{ tenantId: string; raterSubject: string }>('evals:arena-match', (m) => JSON.stringify(m), undefined, (m) => m.tenantId);
    const rows = await ledger.listForTenantIndexed(T);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.raterSubject).sort()).toEqual(['erased', 'erased', 'user:keeper']);
    expect((await arenaStandings(T)).find((s) => s.model === 'beta')).toMatchObject({ wins: 1 });
  });

  it('also reaches a pre-0986 verdict written with the doubled `user:user:` rater', async () => {
    const T = 'arena-erase-legacy';
    const ledger = new DurableCollection<Record<string, unknown>>('evals:arena-match', (m) => String(m.matchId), undefined, (m) => String(m.tenantId));
    await ledger.put({ matchId: 'legacy-doubled', tenantId: T, modelA: 'a', modelB: 'b', winner: 'A', raterSubject: 'user:user:abc', createdAt: AT });
    await eraseArenaRaterSubject(T, 'user:abc');
    expect((await ledger.get('legacy-doubled'))?.raterSubject).toBe('erased');
  });
});
