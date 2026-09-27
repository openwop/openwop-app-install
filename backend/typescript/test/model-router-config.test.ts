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

  it('TOLERATES a retired intentIs rule — drops it, never throws (CHAT-FIRST-PORT A8)', () => {
    // The `intentIs` kind was retired with its zero-caller intent classifier; a
    // config persisted before that is tolerated (the rule is skipped, inert) so a
    // tenant's saved config is never crashed. Even a malformed legacy rule is dropped.
    const c = validateRouterConfig({
      rules: [
        { when: { kind: 'intentIs', intent: 'code' }, target: { provider: 'anthropic', model: 'b' } },
        { when: { kind: 'always' }, target: { provider: 'anthropic', model: 'b' } },
      ],
      fallback: { provider: 'anthropic', model: 'b' },
    });
    expect(c.rules).toHaveLength(1);
    expect(c.rules[0]!.when).toEqual({ kind: 'always' });
  });

  it('accepts + rejects a conversationKind rule (ADR 0130 Phase 6)', () => {
    const ok = validateRouterConfig({ rules: [{ when: { kind: 'conversationKind', value: 'group' }, target: { provider: 'anthropic', model: 'b' } }], fallback: { provider: 'anthropic', model: 'b' } });
    expect(ok.rules[0]!.when).toEqual({ kind: 'conversationKind', value: 'group' });
    expect(() => validateRouterConfig({ rules: [{ when: { kind: 'conversationKind', value: 'dm' }, target: { provider: 'anthropic', model: 'b' } }], fallback: { provider: 'anthropic', model: 'b' } })).toThrow();
  });

  it('rejects a bad rule kind / missing target / missing fallback', () => {
    expect(() => validateRouterConfig({ rules: [{ when: { kind: 'nope' }, target: { provider: 'anthropic', model: 'b' } }], fallback: { provider: 'anthropic', model: 'b' } })).toThrow();
    expect(() => validateRouterConfig({ rules: [{ when: { kind: 'always' }, target: { provider: '', model: 'b' } }], fallback: { provider: 'anthropic', model: 'b' } })).toThrow();
    expect(() => validateRouterConfig({ rules: [], fallback: { provider: 'anthropic' } })).toThrow();
    expect(() => validateRouterConfig({ fallback: { provider: 'anthropic', model: 'b' } })).toThrow(); // missing rules
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

  // ADR 0610 D4 / MRC-2 — a routing target may only name a KNOWN routable provider.
  // Without the allowlist a workspace:write editor could route org prompts to an
  // arbitrary external vendor on the run's existing credentialRef.
  it('REJECTS a routing target naming a non-routable provider (write-time allowlist)', () => {
    // Control: a real provider passes.
    const routable = { rules: [{ when: { kind: 'always' }, target: { provider: 'openai', model: 'm' } }], fallback: { provider: 'anthropic', model: 'm' } };
    expect(validateRouterConfig(routable).rules).toHaveLength(1);
    // An arbitrary vendor in a RULE target → typed rejection.
    expect(() => validateRouterConfig({ rules: [{ when: { kind: 'always' }, target: { provider: 'evil-exfil-vendor', model: 'm' } }], fallback: { provider: 'anthropic', model: 'm' } })).toThrow(/not a routable provider/);
    // The `compat` custom-endpoint provider is deliberately NOT routable (the SSRF/arbitrary-URL egress hole).
    expect(() => validateRouterConfig({ rules: [], fallback: { provider: 'compat', model: 'm' } })).toThrow(/not a routable provider/);
  });
});
