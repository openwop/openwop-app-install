/**
 * ADR 0130 Phase 2 / ADR 0610 D4 (MRC-2) / CHAT-FIRST-PORT A8 — ModelRouterConfig
 * validation + CRUD.
 *
 * Breaks if a malformed config (unknown rule kind, empty target, a half-set
 * fallback, non-array rules) is accepted or rejected for the wrong reason, if a
 * routing target may name a non-routable provider (the write-time exfil
 * allowlist) or a model the catalog does not list (ADR 1016 D5), if a config with
 * NO fallback is refused (ADR 1016 D5 made it optional), if a retired `intentIs`
 * rule crashes a stored config instead of being dropped, if a new config is stored
 * ENABLED, or if one workspace's config or enable flag is visible under another.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { OpenwopError } from '../src/types.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { validateRouterConfig, setRouterConfig, getRouterConfig, setRouterEnabled, eraseRouterConfigSubject } from '../src/features/model-router/configService.js';

const T = 'mr-tenant';
const OTHER = 'mr-other-tenant';
// Real catalog ids (providers.json) — ADR 1016 D5 refuses any other model.
const BIG = 'claude-opus-5-5';
const SMALL = 'claude-haiku-4-5';
const CHEAP = 'gpt-5.4-mini';
const valid = {
  rules: [
    { when: { kind: 'tokensOver', threshold: 8000 }, target: { provider: 'anthropic', model: BIG } },
    { when: { kind: 'always' }, target: { provider: 'openai', model: CHEAP } },
  ],
  fallback: { provider: 'anthropic', model: SMALL },
  cooldownMs: 60000,
};

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

/** The rejection `validateRouterConfig` raised — a typed OpenwopError, not any throw (a
 *  TypeError from a missing guard would satisfy a bare `toThrow()`). */
function rejection(input: unknown): OpenwopError {
  try { validateRouterConfig(input); } catch (e) {
    expect(e).toBeInstanceOf(OpenwopError);
    return e as OpenwopError;
  }
  throw new Error('validateRouterConfig accepted an invalid config');
}

describe('ModelRouterConfig', () => {
  it('validates a well-formed config', () => {
    const c = validateRouterConfig(valid);
    expect(c.rules).toHaveLength(2);
    expect(c.fallback).toEqual({ provider: 'anthropic', model: SMALL });
    expect(c.cooldownMs).toBe(60000);
  });

  it('TOLERATES a retired intentIs rule — drops it, never throws (CHAT-FIRST-PORT A8)', () => {
    // The `intentIs` kind was retired with its zero-caller intent classifier; a
    // config persisted before that is tolerated (the rule is skipped, inert) so a
    // tenant's saved config is never crashed. Even a malformed legacy rule is dropped.
    const c = validateRouterConfig({
      rules: [
        { when: { kind: 'intentIs', intent: 'code' }, target: { provider: 'anthropic', model: BIG } },
        { when: { kind: 'always' }, target: { provider: 'anthropic', model: BIG } },
      ],
      fallback: { provider: 'anthropic', model: BIG },
    });
    expect(c.rules).toHaveLength(1);
    expect(c.rules[0]!.when).toEqual({ kind: 'always' });
  });

  it('accepts + rejects a conversationKind rule (ADR 0130 Phase 6)', () => {
    const ok = validateRouterConfig({ rules: [{ when: { kind: 'conversationKind', value: 'group' }, target: { provider: 'anthropic', model: BIG } }], fallback: { provider: 'anthropic', model: BIG } });
    expect(ok.rules[0]!.when).toEqual({ kind: 'conversationKind', value: 'group' });
    expect(rejection({ rules: [{ when: { kind: 'conversationKind', value: 'dm' }, target: { provider: 'anthropic', model: BIG } }], fallback: { provider: 'anthropic', model: BIG } }))
      .toMatchObject({ code: 'validation_error', httpStatus: 400, details: { field: 'when.value' } });
  });

  it('rejects a bad rule kind / missing target / missing fallback', () => {
    // Each leg names the guard that must refuse it (field + message), so a leg
    // cannot pass on a DIFFERENT guard (the allowlist) or on a TypeError.
    expect(rejection({ rules: [{ when: { kind: 'nope' }, target: { provider: 'anthropic', model: BIG } }], fallback: { provider: 'anthropic', model: BIG } }))
      .toMatchObject({ code: 'validation_error', details: { field: 'when.kind' } });
    expect(rejection({ rules: [{ when: { kind: 'always' }, target: { provider: '', model: BIG } }], fallback: { provider: 'anthropic', model: BIG } }))
      .toMatchObject({ code: 'validation_error', details: { field: 'rules[0].target' }, message: expect.stringMatching(/MUST be \{ provider, model \}/) });
    expect(rejection({ rules: [], fallback: { provider: 'anthropic' } })) // a half-set fallback is still refused
      .toMatchObject({ code: 'validation_error', details: { field: 'fallback' }, message: expect.stringMatching(/MUST be \{ provider, model \}/) });
    expect(rejection({ fallback: { provider: 'anthropic', model: BIG } })) // missing rules
      .toMatchObject({ code: 'validation_error', details: { field: 'rules' }, message: expect.stringMatching(/`rules` MUST be an array/) });
  });

  it('stores + reads the workspace config; enable requires an existing config', async () => {
    // A second workspace with its OWN config, written first — so isolation is a
    // read of an existing row, not a 404-on-missing.
    await setRouterConfig(OTHER, 'u2', { rules: [], fallback: { provider: 'openai', model: CHEAP } });
    const stored = await setRouterConfig(T, 'u1', valid);
    expect(stored.enabled).toBe(false); // default off
    // ADR 1016 D1 — the row is the WORKSPACE's (orgId === tenantId), the key the
    // chat exchange reads.
    expect(stored).toMatchObject({ tenantId: T, orgId: T });
    expect((await getRouterConfig(T))!.config.rules).toHaveLength(2);
    const enabled = await setRouterEnabled(T, 'u1', true);
    expect(enabled.enabled).toBe(true);
    expect((await getRouterConfig(T))!.enabled).toBe(true);
    // Workspace isolation: the other workspace still reads its own config, un-enabled.
    const other = await getRouterConfig(OTHER);
    expect(other).toMatchObject({ tenantId: OTHER, enabled: false, config: { rules: [], fallback: { provider: 'openai', model: CHEAP } } });
  });

  it('enable on a missing config 404s', async () => {
    await expect(setRouterEnabled('mr-none', 'u1', true)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('ADR 1016 D5 — the fallback is OPTIONAL (no fallback ⇒ unmatched turns keep their own model)', () => {
    const c = validateRouterConfig({ rules: [{ when: { kind: 'always' }, target: { provider: 'anthropic', model: BIG } }] });
    expect(c.rules).toHaveLength(1);
    expect(c).not.toHaveProperty('fallback');
  });

  it('ADR 1016 D5 — REJECTS a model the catalog does not list for that provider (closed world)', () => {
    // A typo would otherwise fail every turn its rule matched.
    expect(rejection({ rules: [{ when: { kind: 'always' }, target: { provider: 'anthropic', model: 'claude-opus-5-55' } }] }))
      .toMatchObject({ code: 'validation_error', details: { field: 'rules[0].target.model' } });
    // A real model under the WRONG provider is not listed for that provider either.
    expect(rejection({ rules: [], fallback: { provider: 'openai', model: BIG } }))
      .toMatchObject({ code: 'validation_error', details: { field: 'fallback.model' } });
  });

  // ADR 0610 D4 / MRC-2 — a routing target may only name a KNOWN routable provider.
  // Without the allowlist a workspace:write editor could route org prompts to an
  // arbitrary external vendor on the run's existing credentialRef.
  it('REJECTS a routing target naming a non-routable provider (write-time allowlist)', () => {
    // Control: a real provider passes.
    const routable = { rules: [{ when: { kind: 'always' }, target: { provider: 'openai', model: CHEAP } }], fallback: { provider: 'anthropic', model: SMALL } };
    expect(validateRouterConfig(routable).rules).toHaveLength(1);
    // An arbitrary vendor in a RULE target → typed rejection.
    expect(() => validateRouterConfig({ rules: [{ when: { kind: 'always' }, target: { provider: 'evil-exfil-vendor', model: 'm' } }], fallback: { provider: 'anthropic', model: SMALL } })).toThrow(/not a routable provider/);
    // The `compat` custom-endpoint provider is deliberately NOT routable (the SSRF/arbitrary-URL egress hole).
    expect(() => validateRouterConfig({ rules: [], fallback: { provider: 'compat', model: 'm' } })).toThrow(/not a routable provider/);
  });

  it('DSAR (MR66CD-8): erasing the person who saved the config tombstones `updatedBy`, keeps the config', async () => {
    await setRouterConfig('mr-dsar', 'user-dsar-1', valid);
    expect(await eraseRouterConfigSubject('mr-dsar', 'someone-else')).toEqual({ rowsTouched: 0 }); // control
    expect(await eraseRouterConfigSubject('mr-dsar', 'user-dsar-1')).toEqual({ rowsTouched: 1 });
    const after = await getRouterConfig('mr-dsar');
    expect(after?.updatedBy).toBe('user:[erased]');
    expect(after?.config.rules).toHaveLength(2);
  });
});
