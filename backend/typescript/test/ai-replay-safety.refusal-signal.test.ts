/**
 * Owner decision on #6206 (2026-11-23): an ADR 1002 replay refusal ("no matching
 * recorded AI invocation") sends the same operator signal as every other blocked
 * effect, the `openwop.effect.blocked` counter that alerts fire on, with
 * `effect_kind: network-egress`. Without it these refusals are invisible to the
 * blocked-effect alert.
 *
 * Each lane: a served replay counts nothing (a hit is not a block), and a
 * refused one counts exactly once.
 *
 * Sabotage witness: delete the `recordEffectBlocked` call in
 * `replayInvocationSourceMissing` (`aiProvidersHost.ts`) and every refusal case
 * goes red with zero calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const blocked = vi.hoisted(() => vi.fn());
vi.mock('../src/observability/metricSeams.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordEffectBlocked: blocked,
}));

import { assertMissing, capture, createHarness, PATHS, type Harness, type PublicPath } from './support/aiReplaySafety.js';

let h: Harness;
beforeAll(async () => { process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = 'false'; h = await createHarness(); });
beforeEach(() => { blocked.mockClear(); });
afterAll(async () => { if (h) await h.close(); });

describe.each(PATHS)('%s replay refusal signal', (path: PublicPath) => {
  it('a served replay counts no block; a refused replay counts one network-egress block', async () => {
    const input = { text: 'refusal signal evidence', maxTokens: 64 };
    const source = await h.lane(path);
    h.plan(path, input, 'SIGNAL_SOURCE_' + path);
    await h.invoke(source, input);

    await h.invoke(await h.lane(path, { source }), input);
    expect(blocked, 'a recorded hit is not a blocked effect').not.toHaveBeenCalled();

    const changed = { text: 'a request the source never made', maxTokens: 64 };
    const replay = await h.lane(path, { source });
    const trap = h.plan(path, changed, 'UNSAFE_' + path);
    const before = h.requests.length;
    const outcome = await capture(() => h.invoke(replay, changed));
    const trapWasConsumed = trap.consumed;
    h.retire(trap);
    assertMissing(outcome);
    expect(trapWasConsumed).toBe(false);
    expect(h.requests).toHaveLength(before);
    expect(blocked.mock.calls).toEqual([['network-egress']]);
    h.assertDrained();
  });
});
