/**
 * Invocation-backend absence is tested as a single one-way boot sequence.
 * Run this entry in its own fresh native process: it never uninstalls or resets
 * the production invocation backend to manufacture an absence.
 */
import { expect, it } from 'vitest';
import {
  assertAnswer, assertMissing, capture, createHarness, getInvocationLog, PATHS,
  type Captured, type Lane, type PublicPath,
} from './support/aiReplaySafety.js';

it('refuses all four replay entry points before backend admission, then permits genuine live and recorded-hit calls', async () => {
  const h = await createHarness({ installInvocationLog: false });
  try {
    expect(() => getInvocationLog(), 'fresh-process absence is an actual setup precondition').toThrow('InvocationLog backend not installed');
    const input = { text: 'one-way cold boot evidence', maxTokens: 64 };
    const negatives: Array<{ path: PublicPath; outcome: Captured; before: number; after: number; consumed: boolean; usage: unknown[] }> = [];
    // No case declaration order or hidden reset supplies this state.
    for (const path of PATHS) {
      const source = await h.lane(path);
      if (path !== 'byok-plain') {
        // viaReplayLane's historic live-without-backend support must survive.
        const before = h.requests.length;
        const live = h.plan(path, input, 'PREBOOT_LIVE_' + path);
        assertAnswer(await h.invoke(source, input), path, 'PREBOOT_LIVE_' + path);
        expect(live.consumed).toBe(true);
        expect(h.requests).toHaveLength(before + 1);
        expect(h.requests.at(-1)?.context).toEqual({ runId: source.runId, nodeId: source.nodeId, replaying: false });
      }
      const replay = await h.lane(path, { source });
      const before = h.requests.length;
      const trap = h.plan(path, input, 'UNSAFE_WITHOUT_LOG_' + path);
      const outcome = await capture(() => h.invoke(replay, input));
      const after = h.requests.length, consumed = trap.consumed, usage = await h.usage(replay);
      h.retire(trap);
      negatives.push({ path, outcome, before, after, consumed, usage });
    }
    // This is the sole real backend installation, never an uninstall/reset.
    h.installInvocationLog();
    const admitted: Array<{ path: PublicPath; source: Lane }> = [];
    for (const path of PATHS) {
      const source = await h.lane(path), answer = 'POSTBOOT_SOURCE_' + path;
      const before = h.requests.length, live = h.plan(path, input, answer);
      const sourceResult = await h.invoke(source, input);
      assertAnswer(sourceResult, path, answer);
      expect(live.consumed).toBe(true);
      expect(h.requests).toHaveLength(before + 1);
      expect(h.requests.at(-1)?.context).toEqual({ runId: source.runId, nodeId: source.nodeId, replaying: false });
      const key = h.key(source), log = getInvocationLog(), payload: unknown = await log.get(key);
      expect(payload).toMatchObject({ content: answer });
      const replay = await h.lane(path, { source });
      const afterSource = h.requests.length;
      const replayResult = await h.invoke(replay, input);
      assertAnswer(replayResult, path, answer);
      expect(replayResult).toEqual(sourceResult);
      expect(h.requests).toHaveLength(afterSource);
      const replayKey = h.key(replay);
      expect(await log.get(replayKey)).toEqual(payload);
      expect(await log.llmCacheKey(replayKey)).toBe(await log.llmCacheKey(key));
      const sourceUsage = await h.usage(source);
      expect(sourceUsage).toHaveLength(1);
      expect(await h.usage(replay)).toEqual(sourceUsage);
      admitted.push({ path, source });
    }
    expect(admitted.map(row => row.path)).toEqual([...PATHS]);
    for (const observation of negatives) {
      assertMissing(observation.outcome);
      expect(observation.consumed, observation.path).toBe(false);
      expect(observation.after, observation.path).toBe(observation.before);
      expect(observation.usage, observation.path).toEqual([]);
    }
    h.assertDrained();
  } finally { await h.close(); }
});
