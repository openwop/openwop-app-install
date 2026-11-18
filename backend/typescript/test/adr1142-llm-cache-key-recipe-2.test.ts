/**
 * ADR 1142 — RFC 0260 recipe 2 (`openwop-llm-key-2`).
 *
 * The known-answer vectors are RFC 0260 §B's own: the fixture's call with
 * `{maxTokens: 16, temperature: 0}` and with `maxTokens: 32`. The suite pins the
 * same two digests, so a drift here is a drift from the suite.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFORMANCE_MOCK_MODEL, CONFORMANCE_MOCK_PROVIDER, RECIPE_2, cacheKey2, keyPreimage, llmCacheKeyRecipe2Enabled,
  llmKeySabotage, projectLlmCacheKey, recipe2Matches, sentSampling, storedLlmCacheKey, type KeyInputs,
} from '../src/providers/llmCacheKey2.js';

const fixture = (sent: KeyInputs['sent']): KeyInputs => ({
  provider: CONFORMANCE_MOCK_PROVIDER,
  model: CONFORMANCE_MOCK_MODEL,
  messages: [{ role: 'user', content: 'Say ok.' }],
  sent,
});

const ENV = ['OPENWOP_LLM_CACHE_KEY_RECIPE_2', 'OPENWOP_TEST_SEAM_ENABLED', 'OPENWOP_SABOTAGE_LLM_KEY'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('ADR 1142 — recipe 2 known answers (RFC 0260 §B)', () => {
  it('hashes the fixture call with maxTokens 16 to the RFC vector', () => {
    expect(cacheKey2(fixture({ maxTokens: 16, temperature: 0 }))).toBe('f1714d7aa2abf5994dd375f66aac14514b1c2439f203a6171dc6053c59f54402');
  });

  it('hashes maxTokens 32 to a different key, the second RFC vector', () => {
    expect(cacheKey2(fixture({ maxTokens: 32, temperature: 0 }))).toBe('07e50afae3ca35d1bc0f52cab7c4bb55b46f8b82333d0a870d2b8dec3b85380b');
  });

  it('names every parameter, null when unsent, and sorts and de-duplicates stop', () => {
    const p = keyPreimage(fixture({ stopSequences: ['b', 'a', 'b'] }))['params'] as Record<string, unknown>;
    expect(p).toEqual({ temperature: null, maxTokens: null, stop: ['a', 'b'], seed: null, topP: null, topK: null, frequencyPenalty: null, presencePenalty: null });
  });
});

describe('ADR 1142 D3 — the key hashes what the adapter receives', () => {
  it('a real provider forwards maxTokens only, so temperature and stop never enter its key', () => {
    expect(sentSampling('anthropic', { maxTokens: 64, temperature: 0.2, stopSequences: ['x'] })).toEqual({ maxTokens: 64 });
    expect(sentSampling('openai', { temperature: 0.2 })).toEqual({});
  });

  it('the conformance mock forwards maxTokens, temperature and stop', () => {
    expect(sentSampling('mock', { maxTokens: 16, temperature: 0, stopSequences: ['x'] })).toEqual({ maxTokens: 16, temperature: 0, stopSequences: ['x'] });
    expect(sentSampling(CONFORMANCE_MOCK_PROVIDER, { maxTokens: 16 })).toEqual({ maxTokens: 16 });
  });
});

describe('ADR 1142 D1/D7 — flag and stored form', () => {
  it('is off unless the flag says true or 1', () => {
    delete process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2;
    expect(llmCacheKeyRecipe2Enabled()).toBe(false);
    expect(storedLlmCacheKey(fixture({ maxTokens: 16 }))).toBeUndefined();
    process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = '1';
    expect(llmCacheKeyRecipe2Enabled()).toBe(true);
  });

  it('stores "<recipe>:<digest>" and projects it back as {recipe, digest}', () => {
    process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = 'true';
    const stored = storedLlmCacheKey(fixture({ maxTokens: 16, temperature: 0 }));
    expect(stored).toBe(`${RECIPE_2}:f1714d7aa2abf5994dd375f66aac14514b1c2439f203a6171dc6053c59f54402`);
    expect(projectLlmCacheKey(stored)).toEqual({ recipe: RECIPE_2, digest: 'f1714d7aa2abf5994dd375f66aac14514b1c2439f203a6171dc6053c59f54402' });
  });

  it('projects nothing for a missing or malformed stored value', () => {
    expect(projectLlmCacheKey(null)).toBeUndefined();
    expect(projectLlmCacheKey('openwop-llm-key-2:not-hex')).toBeUndefined();
    expect(projectLlmCacheKey(`spec-rfc-0041:${'a'.repeat(64)}`)).toBeUndefined();
  });
});

describe('ADR 1142 D8 — replay matches by the recipe the source record names (§C.3)', () => {
  const inputs = fixture({ maxTokens: 16, temperature: 0 });
  it('a record with no recipe-2 key keeps RFC 0041 matching', () => {
    expect(recipe2Matches(null, inputs)).toBe(true);
  });
  it('a recipe-2 record is served only to an invocation with the same key, flag on or off', () => {
    delete process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2;
    expect(recipe2Matches(`${RECIPE_2}:${cacheKey2(inputs)}`, inputs)).toBe(true);
    expect(recipe2Matches(`${RECIPE_2}:${cacheKey2(fixture({ maxTokens: 32, temperature: 0 }))}`, inputs)).toBe(false);
  });
});

describe('ADR 1142 D9 — sabotage switches, each breaking one RFC 0260 leg', () => {
  it('are inert without the test seam', () => {
    process.env.OPENWOP_SABOTAGE_LLM_KEY = 'omit';
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    expect(llmKeySabotage()).toBeNull();
  });

  it('omit records no key (key-recorded)', () => {
    process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = 'true';
    process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
    process.env.OPENWOP_SABOTAGE_LLM_KEY = 'omit';
    expect(storedLlmCacheKey(fixture({ maxTokens: 16 }))).toBeUndefined();
  });

  it('drop-max-tokens makes 16 and 32 collide (params-in-key)', () => {
    expect(cacheKey2(fixture({ maxTokens: 16, temperature: 0 }), 'drop-max-tokens')).toBe(cacheKey2(fixture({ maxTokens: 32, temperature: 0 }), 'drop-max-tokens'));
  });

  it('nonce makes identical calls differ (key-stable)', () => {
    expect(cacheKey2(fixture({ maxTokens: 16 }), 'nonce')).not.toBe(cacheKey2(fixture({ maxTokens: 16 }), 'nonce'));
  });

  it('model moves the key off the suite recomputation (key-portable)', () => {
    expect(cacheKey2(fixture({ maxTokens: 16, temperature: 0 }), 'model')).not.toBe('f1714d7aa2abf5994dd375f66aac14514b1c2439f203a6171dc6053c59f54402');
  });
});
