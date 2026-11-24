/**
 * ADR 1002 follow-up (#6156): a replay fork of a run recorded BEFORE ADR 0549 P3
 * must serve the source's record from its v1 provider key, not refuse.
 *
 * Why: P3 moved the invocation-log identity to the RFC 0150 §B id, and
 * `spec/v1/replay.md` §E dual-reads the retired v1 key for this run. ADR 1002
 * made a replay fork REFUSE when no source record matches, but its source
 * lookup only tried the new id. So every fork of a pre-P3 run would refuse
 * ("no matching recorded AI invocation") although the record was there.
 *
 * Sabotage witness: delete the `legacySourceKey` read in
 * `aiProvidersHost.ts` (BYOK callAI source lookup) and this goes red with a
 * ReplayEffectError instead of the recorded answer.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  assertAnswer, createHarness, getInvocationLog, type Harness,
} from './support/aiReplaySafety.js';
import { __lastLegacyProviderKeyForTests } from '../src/aiProviders/aiProvidersHost.js';

let h: Harness;
beforeAll(async () => { process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = 'false'; h = await createHarness(); });
afterAll(async () => { if (h) await h.close(); });

it('a fork of a pre-P3 source run replays its v1-keyed record without a provider call', async () => {
  const input = { text: 'pre-P3 legacy source evidence', maxTokens: 64 };
  const answer = 'LEGACY_SOURCE_ANSWER';

  // A genuine live call supplies the real record and the real v1 key for this input.
  const donor = await h.lane('byok-plain');
  const live = h.plan('byok-plain', input, answer);
  assertAnswer(await h.invoke(donor, input), 'byok-plain', answer);
  expect(live.consumed).toBe(true);
  const donorKey = h.key(donor);
  const legacyKey = __lastLegacyProviderKeyForTests();
  expect(legacyKey, 'the v1 key was computed on the real call').toMatch(/^[0-9a-f]{64}$/);
  expect(legacyKey).not.toBe(donorKey.invocationId);
  const log = getInvocationLog();
  const record: unknown = await log.get(donorKey);
  expect(record).toMatchObject({ content: answer });

  // The source run holds that record ONLY under the v1 key, as a pre-P3 run does.
  const source = await h.lane('byok-plain');
  await log.put({ runId: source.runId, nodeId: source.nodeId, attempt: donorKey.attempt, invocationId: legacyKey as string }, record);

  const replay = await h.lane('byok-plain', { source });
  const before = h.requests.length;
  const result = await h.invoke(replay, input);
  assertAnswer(result, 'byok-plain', answer);
  expect(h.requests, 'served from the source record, never dispatched').toHaveLength(before);
  expect(await log.get(h.key(replay)), 'copied into the fork under its own key').toEqual(record);
  h.assertDrained();
});
