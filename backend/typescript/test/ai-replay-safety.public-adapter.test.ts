/**
 * Replay source lookup must finish before any real provider dispatch.
 * Each negative follows genuine live/recorded-hit controls and is followed by
 * another valid public call. These are adapter safety tests, not executor
 * source-node-outcome conformance tests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertAnswer, assertMissing, capture, createHarness, getInvocationLog, inLane,
  BYOK_REF, MODEL, MUST_BE_ABSENT, PATHS, ReplayEffectError, SYSTEM, TOOLS, type Harness, type Input, type Lane, type PublicPath,
} from './support/aiReplaySafety.js';
import { programMock, hasPendingMockProgram, receivedMaxTokens } from '../src/providers/dispatchMock.js';

let h: Harness;
// A developer shell with provider keys, a policy and a sabotage key exported. The
// harness must scrub them for its own run and restore them on close (#6206 follow-up).
const SHELL: Record<string, string> = {
  GOOGLE_API_KEY: 'shell-google-key-must-not-leak', OPENAI_API_KEY: 'shell-openai-key-must-not-leak',
  OPENWOP_AI_POLICY_GOOGLE: 'disabled', OPENWOP_SABOTAGE_LLM_KEY: 'shell-sabotage-must-not-leak',
};
const shellBefore = new Map(Object.keys(SHELL).map(name => [name, process.env[name]]));
beforeAll(async () => {
  Object.assign(process.env, SHELL);
  h = await createHarness();
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = 'false';
  if (h) h.assertDrained();
});
afterAll(async () => {
  if (h) await h.close();
  // close restores the shell exactly, then this file restores the real shell.
  for (const [name, value] of Object.entries(SHELL)) expect(process.env[name], name).toBe(value);
  for (const [name, value] of shellBefore) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

describe('a developer shell does not leak into the fixture run', () => {
  it('scrubs every MUST_BE_ABSENT key and still runs on the fixture credentials', async () => {
    for (const name of MUST_BE_ABSENT) {
      if (name === 'GOOGLE_API_KEY') expect(process.env[name], 'the managed key is the fixture own').not.toBe(SHELL.GOOGLE_API_KEY);
      else expect(process.env[name], name).toBeUndefined();
    }
    // A live call reaches the closed transport, which throws on any credential but the
    // fixture's; a leaked OPENWOP_AI_POLICY_GOOGLE=disabled would refuse it instead.
    for (const path of PATHS) await positive(await h.lane(path), { text: 'shell scrub ' + path }, 'SCRUBBED_' + path);
  });
});

async function positive(lane: Lane, input: Input, answer: string) {
  const before = h.requests.length;
  const response = h.plan(lane.path, input, answer);
  const result = await h.invoke(lane, input);
  assertAnswer(result, lane.path, answer);
  expect(response.consumed).toBe(true);
  expect(h.requests).toHaveLength(before + 1);
  expect(h.requests.at(-1)?.context).toEqual({
    runId: lane.runId, nodeId: lane.nodeId, replaying: false,
  });
  const key = h.key(lane), log = getInvocationLog();
  const payload: unknown = await log.get(key);
  expect(payload).toMatchObject({ content: answer });
  const llmKey = await log.llmCacheKey(key), usage = await h.usage(lane);
  expect(usage, 'the real successful dispatcher emitted usage').toHaveLength(1);
  return { lane, input, answer, result, key, payload: structuredClone(payload), llmKey, usage };
}
type Positive = Awaited<ReturnType<typeof positive>>;

async function matching(source: Positive) {
  const lane = await h.lane(source.lane.path, { source: source.lane });
  const before = h.requests.length;
  const result = await h.invoke(lane, source.input);
  assertAnswer(result, lane.path, source.answer);
  expect(result).toEqual(source.result);
  expect(h.requests).toHaveLength(before);
  const key = h.key(lane), log = getInvocationLog();
  expect(await log.get(key)).toEqual(source.payload);
  expect(await log.llmCacheKey(key)).toBe(source.llmKey);
  expect(await h.usage(lane)).toEqual(source.usage);
  return lane;
}

describe.each(PATHS)('%s public replay boundary', (path: PublicPath) => {
  it('serves a legacy source verbatim, refuses a changed request, and still executes an explicit branch', async () => {
    process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = 'false';
    const source = await positive(await h.lane(path), { text: 'legacy source evidence', maxTokens: 64 }, 'LEGACY_SOURCE_' + path);
    expect(source.llmKey).toBeNull();
    process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = 'true';
    await matching(source); // Turning the flag on must not rewrite a legacy source.
    const replay = await h.lane(path, { source: source.lane });
    const changed = { text: 'a different semantic request', maxTokens: 64 };
    const trap = h.plan(path, changed, 'UNSAFE_REPLAY_DISPATCH_' + path);
    const charge = vi.spyOn(h.storage, 'incrementManagedUsage'); // Call-through; no metering algorithm replacement.
    const requestsBefore = h.requests.length, chargesBefore = charge.mock.calls.length;
    const outcome = await capture(() => h.invoke(replay, changed));
    const key = h.key(replay);
    const requestsAfter = h.requests.length, chargesAfter = charge.mock.calls.length;
    const usageAfter = await h.usage(replay), recordAfter = await getInvocationLog().get(key);
    const trapWasConsumed = trap.consumed;
    h.retire(trap); // A negative can leave only its own planned trap unused.
    // This later positive prevents a disabled dispatcher/policy from faking safety.
    const branch = await h.lane(path, { source: source.lane, mode: 'branch' });
    await positive(branch, changed, 'BRANCH_IS_LIVE_' + path);
    assertMissing(outcome);
    expect(trapWasConsumed).toBe(false);
    expect(requestsAfter).toBe(requestsBefore);
    expect(chargesAfter).toBe(chargesBefore);
    expect(usageAfter).toEqual([]);
    expect(recordAfter).toBeNull();
    expect(await getInvocationLog().get(source.key)).toEqual(source.payload);
    expect(await getInvocationLog().llmCacheKey(source.key)).toBeNull();
  });

  it('copies a real recipe-2 key verbatim and refuses deliberately inconsistent stored recipe metadata', async () => {
    process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = 'true';
    const source = await positive(await h.lane(path), { text: 'recipe two evidence', maxTokens: 64 }, 'RECIPE_SOURCE_' + path);
    expect(source.llmKey).toMatch(/^openwop-llm-key-2:/);
    process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = 'false';
    await matching(source); // Stored recipe identity remains authoritative with the flag off.
    process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = 'true';
    const other = await positive(await h.lane(path), { ...source.input, maxTokens: 96 }, 'OTHER_REAL_REQUEST_' + path);
    expect(other.llmKey).toMatch(/^openwop-llm-key-2:/);
    expect(other.llmKey).not.toBe(source.llmKey);
    if (!other.llmKey || !source.llmKey) throw new Error('Genuine recipe-2 metadata was not admitted');
    const log = getInvocationLog();
    // Storage fault injection only: a DIFFERENT REAL request's key is attached
    // to this unchanged source payload. No identity/digest recipe is reimplemented.
    await log.put(source.key, source.payload, { llmCacheKey: other.llmKey });
    expect(await log.llmCacheKey(source.key)).toBe(other.llmKey);
    const replay = await h.lane(path, { source: source.lane });
    const trap = h.plan(path, source.input, 'UNSAFE_RECIPE_MISMATCH_' + path);
    const charge = vi.spyOn(h.storage, 'incrementManagedUsage');
    const requestsBefore = h.requests.length, chargesBefore = charge.mock.calls.length;
    const outcome = await capture(() => h.invoke(replay, source.input));
    const key = h.key(replay);
    const requestsAfter = h.requests.length, chargesAfter = charge.mock.calls.length;
    const usageAfter = await h.usage(replay), recordAfter = await log.get(key);
    const trapWasConsumed = trap.consumed;
    h.retire(trap);
    await log.put(source.key, source.payload, { llmCacheKey: source.llmKey });
    expect(await log.llmCacheKey(source.key)).toBe(source.llmKey);
    await matching(source); // The same payload works after repairing only its stored key.
    assertMissing(outcome);
    expect(trapWasConsumed).toBe(false);
    expect(requestsAfter).toBe(requestsBefore);
    expect(chargesAfter).toBe(chargesBefore);
    expect(usageAfter).toEqual([]);
    expect(recordAfter).toBeNull();
    expect(await log.get(source.key)).toEqual(source.payload);
  });

  it.each(['getInvocation', 'getInvocationLlmCacheKey'] as const)(
    'maps an actually reached %s storage rejection to a sanitized typed refusal',
    async (method) => {
      process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = 'true';
      const source = await positive(await h.lane(path), { text: 'storage read evidence', maxTokens: 64 }, 'READ_SOURCE_' + path);
      await matching(source);
      const replay = await h.lane(path, { source: source.lane });
      const trap = h.plan(path, source.input, 'UNSAFE_READ_ERROR_' + path);
      const charge = vi.spyOn(h.storage, 'incrementManagedUsage');
      const requestsBefore = h.requests.length, chargesBefore = charge.mock.calls.length;
      // The real log and adapter remain installed. Only one actual storage read rejects.
      const spy = method === 'getInvocation'
        ? vi.spyOn(h.storage, 'getInvocation').mockRejectedValueOnce(new Error('PRIVATE_STORAGE_READ_2918'))
        : vi.spyOn(h.storage, 'getInvocationLlmCacheKey').mockRejectedValueOnce(new Error('PRIVATE_STORAGE_READ_2918'));
      let outcome: Awaited<ReturnType<typeof capture>> | undefined;
      let failedKey: ReturnType<Harness['key']> | undefined;
      try {
        outcome = await capture(() => h.invoke(replay, source.input));
        failedKey = h.key(replay);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(method === 'getInvocation' ? failedKey : source.key);
      } finally { spy.mockRestore(); }
      const requestsAfter = h.requests.length, chargesAfter = charge.mock.calls.length;
      const usageAfter = await h.usage(replay);
      const trapWasConsumed = trap.consumed;
      h.retire(trap);
      await matching(source); // The storage recovered; a blanket failure cannot satisfy this case.
      if (!outcome || !failedKey) throw new Error('Actual public read-failure observation is missing');
      assertMissing(outcome);
      expect(trapWasConsumed).toBe(false);
      expect(requestsAfter).toBe(requestsBefore);
      expect(chargesAfter).toBe(chargesBefore);
      expect(usageAfter).toEqual([]);
      expect(await getInvocationLog().get(failedKey)).toBeNull();
      expect(await getInvocationLog().get(source.key)).toEqual(source.payload);
    },
  );
});


it('preserves explicit credential refusal before replay lookup and leaves the valid source reusable', async () => {
  const source = await positive(await h.lane('byok-plain'), { text: 'credential ordering evidence', maxTokens: 64 }, 'CREDENTIAL_SOURCE');
  const replay = await h.lane('byok-plain', { source: source.lane });
  const before = h.requests.length;
  const outcome = await capture(() => inLane(replay, () => replay.adapter.callAI({
    provider: 'google', model: MODEL, credentialRef: BYOK_REF + '-unresolved',
    systemPrompt: SYSTEM, messages: [{ role: 'user', content: source.input.text }], maxTokens: 64,
  })));
  const after = h.requests.length;
  await matching(source);
  expect(outcome.kind).toBe('thrown');
  if (outcome.kind !== 'thrown' || !(outcome.error instanceof Error) || !('code' in outcome.error)) {
    throw new Error('Expected the real credential-validation error');
  }
  expect(outcome.error).not.toBeInstanceOf(ReplayEffectError);
  expect(outcome.error.code).toBe('byok_required_but_unresolved');
  expect(after).toBe(before);
  expect(await h.usage(replay)).toEqual([]);
});

describe('explicit local mock divergence remains local', () => {
  it('serves a recorded mock result until an actual unscoped divergence program is staged', async () => {
    const source = await h.lane('byok-plain');
    const request = {
      provider: 'mock', model: 'mock-mini', credentialRef: 'mock',
      systemPrompt: SYSTEM, messages: [{ role: 'user' as const, content: 'local divergence evidence' }], maxTokens: 64,
    };
    const before = h.requests.length;
    programMock(source.nodeId, [{ content: 'LOCAL_SOURCE', inputTokens: 7, outputTokens: 3 }]);
    const live = await inLane(source, () => source.adapter.callAI(request));
    expect(live.content).toBe('LOCAL_SOURCE');
    expect(hasPendingMockProgram(source.nodeId)).toBe(false);
    expect(receivedMaxTokens(source.nodeId)).toEqual([64]);
    const sourceKey = h.key(source), original = await getInvocationLog().get(sourceKey);
    expect(original).toMatchObject({ content: 'LOCAL_SOURCE' });
    const replay = await h.lane('byok-plain', { source });
    const cached = await inLane(replay, () => replay.adapter.callAI(request));
    expect(cached).toEqual(live);
    expect(receivedMaxTokens(source.nodeId)).toEqual([64]); // No second mock dispatch on the hit.
    programMock(source.nodeId, [{ content: 'LOCAL_STAGED_DIVERGENCE', inputTokens: 7, outputTokens: 3 }]);
    const injected = await h.lane('byok-plain', { source });
    const result = await inLane(injected, () => injected.adapter.callAI(request));
    expect(result.content).toBe('LOCAL_STAGED_DIVERGENCE');
    expect(hasPendingMockProgram(source.nodeId)).toBe(false);
    expect(receivedMaxTokens(source.nodeId)).toEqual([64]);
    expect(h.requests).toHaveLength(before);
    expect(await getInvocationLog().get(sourceKey)).toEqual(original);
  });

  it('consumes a real scripted mock tools round even in an explicit replay context without HTTP', async () => {
    const source = await h.lane('byok-tools');
    const replay = await h.lane('byok-tools', { source });
    const before = h.requests.length;
    programMock(source.nodeId, [{
      content: 'LOCAL_TOOL_DIVERGENCE', inputTokens: 7, outputTokens: 3,
      toolCalls: [{ name: 'fixture_lookup', input: { topic: 'local only' } }],
    }]);
    const result = await inLane(replay, () => replay.adapter.callAIWithTools({
      provider: 'mock', model: 'mock-mini', credentialRef: 'mock', systemPrompt: SYSTEM,
      messages: [{ role: 'user', content: 'local tool evidence' }], maxTokens: 64, tools: TOOLS,
    }));
    expect(result.content).toBe('LOCAL_TOOL_DIVERGENCE');
    expect(result.toolCalls).toEqual([{ id: 'mock-call-0-0', name: 'fixture_lookup', input: { topic: 'local only' } }]);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(hasPendingMockProgram(source.nodeId)).toBe(false);
    expect(receivedMaxTokens(source.nodeId)).toEqual([64]);
    expect(h.requests).toHaveLength(before);
    // This direct mock-tools path is intentionally unrecorded; no cache-hit claim.
  });
});
