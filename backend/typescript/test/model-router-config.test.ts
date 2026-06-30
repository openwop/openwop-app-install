/**
 * ADR 0130 Phase 2 — ModelRouterConfig validation + CRUD.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { validateRouterConfig, setRouterConfig, getRouterConfig, setRouterEnabled } from '../src/features/model-router/configService.js';

const T = 'mr-tenant';
const ORG = 'org-mr';
const valid = {
  rules: [
    { when: { kind: 'tokensOver', threshold: 8000 }, target: { provider: 'anthropic', model: 'big' } },
    { when: { kind: 'always' }, target: { provider: 'openai', model: 'cheap' } },
  ],
  fallback: { provider: 'anthropic', model: 'default' },
  cooldownMs: 60000,
};

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('ModelRouterConfig', () => {
  it('validates a well-formed config', () => {
    const c = validateRouterConfig(valid);
    expect(c.rules).toHaveLength(2);
    expect(c.fallback).toEqual({ provider: 'anthropic', model: 'default' });
    expect(c.cooldownMs).toBe(60000);
  });

  it('accepts + rejects an intentIs rule (ADR 0130 Phase 4)', () => {
    const ok = validateRouterConfig({ rules: [{ when: { kind: 'intentIs', intent: 'code' }, target: { provider: 'a', model: 'b' } }], fallback: { provider: 'a', model: 'b' } });
    expect(ok.rules[0]!.when).toEqual({ kind: 'intentIs', intent: 'code' });
    expect(() => validateRouterConfig({ rules: [{ when: { kind: 'intentIs', intent: '  ' }, target: { provider: 'a', model: 'b' } }], fallback: { provider: 'a', model: 'b' } })).toThrow();
  });

  it('rejects a bad rule kind / missing target / missing fallback', () => {
    expect(() => validateRouterConfig({ rules: [{ when: { kind: 'nope' }, target: { provider: 'a', model: 'b' } }], fallback: { provider: 'a', model: 'b' } })).toThrow();
    expect(() => validateRouterConfig({ rules: [{ when: { kind: 'always' }, target: { provider: '', model: 'b' } }], fallback: { provider: 'a', model: 'b' } })).toThrow();
    expect(() => validateRouterConfig({ rules: [], fallback: { provider: 'a' } })).toThrow();
    expect(() => validateRouterConfig({ fallback: { provider: 'a', model: 'b' } })).toThrow(); // missing rules
  });

  it('stores + reads the config; enable requires an existing config', async () => {
    const stored = await setRouterConfig(T, ORG, 'u1', valid);
    expect(stored.enabled).toBe(false); // default off
    expect((await getRouterConfig(T, ORG))!.config.rules).toHaveLength(2);
    const enabled = await setRouterEnabled(T, ORG, 'u1', true);
    expect(enabled.enabled).toBe(true);
    expect(await getRouterConfig('other', ORG)).toBeNull(); // tenant isolation
  });

  it('enable on a missing config 404s', async () => {
    await expect(setRouterEnabled(T, 'org-none', 'u1', true)).rejects.toMatchObject({ code: 'not_found' });
  });
});
