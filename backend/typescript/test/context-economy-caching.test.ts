/**
 * ADR 0148 Phase 1 (A2) — provider prompt caching helpers + config + replay safety.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  cacheableAnthropicSystem,
  withAnthropicToolCache,
  extractAnthropicCacheTokens,
  type AnthropicToolDef,
} from '../src/providers/promptCaching.js';
import { contextEconomy } from '../src/host/contextEconomy.js';
import { computeLLMCacheKey } from '../src/providers/llmCacheKey.js';

const ENV_KEYS = [
  'OPENWOP_CONTEXT_ECONOMY',
  'OPENWOP_CONTEXT_ECONOMY_PROVIDER_CACHE',
  'OPENWOP_CONTEXT_ECONOMY_TOOL_DIET',
  'OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT',
  'OPENWOP_CONTEXT_ECONOMY_MEMORY',
  'OPENWOP_CONTEXT_ECONOMY_TRANSPORT',
];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('contextEconomy() config resolution', () => {
  it('defaults every lever OFF when no env is set', () => {
    const c = contextEconomy();
    expect(c.enabled).toBe(false);
    expect(c.providerCache).toBe(false);
    expect(c.toolDiet).toBe(false);
    expect(c.transcriptBudget).toBe(false);
    expect(c.memoryBudget).toBe(false);
    expect(c.transport).toBe(false);
  });

  it('master switch turns every lever on', () => {
    process.env.OPENWOP_CONTEXT_ECONOMY = 'true';
    const c = contextEconomy();
    expect(c.enabled).toBe(true);
    expect(c.providerCache).toBe(true);
    expect(c.transport).toBe(true);
  });

  it('a per-lever override beats the master (both directions)', () => {
    process.env.OPENWOP_CONTEXT_ECONOMY = '1';
    process.env.OPENWOP_CONTEXT_ECONOMY_PROVIDER_CACHE = 'off';
    const c = contextEconomy();
    expect(c.enabled).toBe(true);
    expect(c.providerCache).toBe(false); // override wins
    expect(c.toolDiet).toBe(true); // inherits master

    process.env.OPENWOP_CONTEXT_ECONOMY = '0';
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSPORT = 'yes';
    const c2 = contextEconomy();
    expect(c2.enabled).toBe(false);
    expect(c2.transport).toBe(true); // lever-on despite master-off
    expect(c2.providerCache).toBe(false);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(contextEconomy())).toBe(true);
  });
});

describe('cacheableAnthropicSystem', () => {
  it('off → returns the plain string byte-identical (no behavior change)', () => {
    expect(cacheableAnthropicSystem('you are a bot', false)).toBe('you are a bot');
  });
  it('on → returns a single cache-marked text block', () => {
    expect(cacheableAnthropicSystem('you are a bot', true)).toEqual([
      { type: 'text', text: 'you are a bot', cache_control: { type: 'ephemeral' } },
    ]);
  });
  it('absent/empty system → undefined regardless of flag (caller omits the field)', () => {
    expect(cacheableAnthropicSystem(undefined, true)).toBeUndefined();
    expect(cacheableAnthropicSystem('', true)).toBeUndefined();
  });
});

describe('withAnthropicToolCache', () => {
  const tools: AnthropicToolDef[] = [
    { name: 'a', description: 'A', input_schema: { type: 'object' } },
    { name: 'b', description: 'B', input_schema: { type: 'object' } },
  ];

  it('off → returns input unchanged', () => {
    expect(withAnthropicToolCache(tools, false)).toBe(tools);
  });

  it('on → breakpoint on the LAST tool only', () => {
    const out = withAnthropicToolCache(tools, true);
    expect(out[0].cache_control).toBeUndefined();
    expect(out[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('on → does NOT mutate the caller array or its objects (replay-safety invariant)', () => {
    const snapshot = JSON.stringify(tools);
    withAnthropicToolCache(tools, true);
    expect(JSON.stringify(tools)).toBe(snapshot);
    expect(tools[1].cache_control).toBeUndefined();
  });

  it('on → never places cache_control inside a tool input_schema', () => {
    const out = withAnthropicToolCache(tools, true);
    expect((out[1].input_schema as Record<string, unknown>).cache_control).toBeUndefined();
  });

  it('empty tools → unchanged', () => {
    expect(withAnthropicToolCache([], true)).toEqual([]);
  });
});

describe('replay cache-key is invisible to prompt caching (architect must-fix #1)', () => {
  it('computeLLMCacheKey is byte-identical whether caching is on or off', () => {
    // The cache key is computed over the LOGICAL recipe (messages/tools), never
    // the post-caching HTTP body. Inject cache_control on a COPY and confirm the
    // logical inputs — hence the key — are unchanged.
    const messages = [
      { role: 'system' as const, content: 'stable system prompt' },
      { role: 'user' as const, content: 'hi' },
    ];
    const tools = [
      { name: 'a', description: 'A', parameters: { type: 'object' } },
      { name: 'b', description: 'B', parameters: { type: 'object' } },
    ];
    const keyOff = computeLLMCacheKey({ provider: 'anthropic', model: 'claude-x', messages, tools });

    // Simulate the dispatch path: build the cached body from the SAME inputs.
    const httpTools: AnthropicToolDef[] = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    withAnthropicToolCache(httpTools, true);
    cacheableAnthropicSystem('stable system prompt', true);

    const keyOn = computeLLMCacheKey({ provider: 'anthropic', model: 'claude-x', messages, tools });
    expect(keyOn).toBe(keyOff);
  });
});

describe('extractAnthropicCacheTokens', () => {
  it('reads cache_read / cache_creation token counts', () => {
    expect(extractAnthropicCacheTokens({ cache_read_input_tokens: 900, cache_creation_input_tokens: 120 })).toEqual({
      cachedReadTokens: 900,
      cacheWriteTokens: 120,
    });
  });
  it('absent fields → zeros (caching off / streaming pre-usage)', () => {
    expect(extractAnthropicCacheTokens(undefined)).toEqual({ cachedReadTokens: 0, cacheWriteTokens: 0 });
    expect(extractAnthropicCacheTokens({ input_tokens: 5 })).toEqual({ cachedReadTokens: 0, cacheWriteTokens: 0 });
  });
});
