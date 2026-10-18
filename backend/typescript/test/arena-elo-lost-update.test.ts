/**
 * ADR 0700 (`EVC-7`) — seven of eight arena verdicts vanished.
 *
 * `recordArenaMatch` applied both rating rows with plain `put`s after a read — a
 * read-modify-write with no compare-and-swap. BORN RED, and not marginally: eight
 * identical verdicts (eight DISTINCT raters, A wins each time, so the per-rater cap
 * never interacts) left alpha at **1516** concurrently against **1594.95**
 * sequentially. Base 1500 ⇒ truth +94.95, store +16.00 — exactly ONE verdict's worth.
 *
 * NOTE ON FIXTURES: `matches` is keyed by `matchId` ALONE (arena.ts), so ids must be
 * distinct per scenario. Reusing them across tenants trips the idempotency guard and
 * silently records nothing — that invalidated the first version of this comparison,
 * and "8 wins produced exactly the base rating" is what gave it away.
 *
 * Witnessed (wave 25 probes): replacing the CAS with a bare `put` reds legs 1, 2, 3 and 5;
 * a tenant-blind rating read reds leg 4. Legs 2 and 3 assert MAGNITUDES (several
 * verdicts' worth), because "winner rose / loser fell / tie ≈ base" is satisfied by ONE
 * landed verdict — the defect state itself.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { recordArenaMatch, getArenaRating } from '../src/features/evals/arena.js';
import { ELO_BASE } from '../src/features/evals/elo.js';

const at = new Date().toISOString();
const mk = (tag: string, i: number, winner: 'A' | 'B' | 'tie' = 'A') =>
  ({ matchId: `${tag}-m${i}`, modelA: 'alpha', modelB: 'beta', winner, raterSubject: `user:${tag}-r${i}`, createdAt: at });

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('ADR 0700 — concurrent verdicts are not lost', () => {
  it('leg 1: concurrent and sequential agree — the defect was an 83% signal loss', async () => {
    const N = 8;
    await Promise.all(Array.from({ length: N }, (_, i) => recordArenaMatch('t-conc', mk('c', i))));
    const conc = await getArenaRating('t-conc', 'alpha');
    for (let i = 0; i < N; i += 1) await recordArenaMatch('t-seq', mk('s', i));
    const seq = await getArenaRating('t-seq', 'alpha');

    expect(seq, 'the sequential control really moved (or this leg proves nothing)').toBeGreaterThan(ELO_BASE + 50);

    // THE INVARIANT IS "NO VERDICT IS LOST", NOT "concurrent === sequential".
    // Elo is PATH-DEPENDENT: run sequentially each win yields a smaller delta as the
    // winner's rating rises (1500 -> 1594.95 for eight). Run concurrently, all eight
    // compute their delta from the SAME 1500/1500 snapshot, so eight full +16s land
    // (1628). Concurrent legitimately OVERSHOOTS sequential — that is ADR 0700 D1b's
    // stated residual, measured: two independent per-row CAS loops do not make the
    // pair atomic. The first version of this leg asserted `|conc - seq| < 1`, which
    // demanded a path-independence Elo does not have.
    //
    // What the fix guarantees, and what this pins: EIGHT verdicts land, not ONE.
    // Before: conc === 1516 (base + 16, a single verdict). After: conc === 1628.
    const oneVerdict = 16;
    expect(conc - ELO_BASE, 'all eight verdicts landed, not one').toBeGreaterThan(oneVerdict * 6);
    expect(conc, 'and concurrent is at least sequential — un-damped deltas').toBeGreaterThanOrEqual(seq - 1);
  });

  it('leg 2: BOTH rows accumulate every verdict — the loser lost the same way', async () => {
    const N = 6;
    await Promise.all(Array.from({ length: N }, (_, i) => recordArenaMatch('t-cnt', mk('n', i))));
    // Six verdicts move each row ≈ 6 × 16 (≥ 85.7 even if they serialised); the defect
    // landed ONE (+16 / −16). "rose / fell" alone was satisfied by that single verdict.
    const alpha = await getArenaRating('t-cnt', 'alpha');
    const beta = await getArenaRating('t-cnt', 'beta');
    expect(alpha - ELO_BASE, 'the winner rose by several verdicts, not one').toBeGreaterThan(16 * 4);
    expect(ELO_BASE - beta, 'and the loser fell by several verdicts, not one').toBeGreaterThan(16 * 4);
  });

  it('leg 3: a tie is still applied under CAS (the delta path is not win-only)', async () => {
    // Unequal models first (alpha 1516 / beta 1484), so a tie MOVES them: beta gains
    // 32 × (0.5 − E) ≈ 1.47 per tie. Four concurrent ties must land four times.
    await recordArenaMatch('t-tie', mk('tseed', 0));
    const before = await getArenaRating('t-tie', 'beta');
    await Promise.all(Array.from({ length: 4 }, (_, i) => recordArenaMatch('t-tie', mk('t', i, 'tie'))));
    const gained = (await getArenaRating('t-tie', 'beta')) - before;
    expect(gained, 'four ties landed, not one (one ≈ 1.47)').toBeGreaterThan(1.47 * 3);
    expect(gained, 'and a tie is not scored as a win (a win ≈ 17.4)').toBeLessThan(10);
  });

  it('leg 4: distinct tenants never share a rating row', async () => {
    await recordArenaMatch('t-x', mk('x', 0));
    expect(await getArenaRating('t-y', 'alpha'), 'a different tenant is untouched').toBe(ELO_BASE);
  });

  it('leg 5 (structural): the write goes through compareAndSwap, and no bare put remains', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'features', 'evals', 'arena.ts'), 'utf8')
      .split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); }).join('\n');
    expect(src, 'the accumulator is CAS-guarded').toMatch(/ratings\.compareAndSwap\(/);
    expect(src, 'a bare ratings.put would reintroduce the lost update').not.toMatch(/await ratings\.put\(/);
  });
});
