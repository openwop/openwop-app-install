/**
 * RFC 0121 §B.7/§B.8 — pure unit coverage for the scope-safety rail.
 *   - assertSubscriptionScopeAllowed: user ok; tenant/workspace throw
 *     credential_scope_forbidden (403).
 *   - subscriptionEnabledProviders: honest-off ([]) even when the operator
 *     opt-in env is set (no lawful acquisition mechanism → dark).
 *   - buildProviderAuthModes: apiKey for byok; §B.7 force-include of a
 *     subscription provider into byok (exercisable by forcing the helper input).
 */

import { describe, expect, it, afterEach } from 'vitest';
import { assertSubscriptionScopeAllowed } from '../src/byok/subscriptionCredentialScope.js';
import { subscriptionEnabledProviders, buildProviderAuthModes } from '../src/aiProviders/aiProvidersHost.js';
import { OpenwopError } from '../src/types.js';

describe('assertSubscriptionScopeAllowed (RFC 0121 §B.8)', () => {
  it('permits user scope', () => {
    expect(() => assertSubscriptionScopeAllowed('user')).not.toThrow();
  });

  for (const scope of ['tenant', 'workspace', 'project', '']) {
    it(`throws credential_scope_forbidden/403 for scope='${scope}'`, () => {
      try {
        assertSubscriptionScopeAllowed(scope);
        throw new Error('expected assertSubscriptionScopeAllowed to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(OpenwopError);
        expect((err as OpenwopError).code).toBe('credential_scope_forbidden');
        expect((err as OpenwopError).httpStatus).toBe(403);
      }
    });
  }
});

describe('subscriptionEnabledProviders (RFC 0121 §B.9 honest-off)', () => {
  afterEach(() => { delete process.env.OPENWOP_SUBSCRIPTION_PROVIDERS; });

  it('returns [] by default (env unset)', () => {
    delete process.env.OPENWOP_SUBSCRIPTION_PROVIDERS;
    expect(subscriptionEnabledProviders()).toEqual([]);
  });

  it('returns [] even when the operator opt-in env is set (no lawful mechanism → dark)', () => {
    process.env.OPENWOP_SUBSCRIPTION_PROVIDERS = 'anthropic,openai';
    expect(subscriptionEnabledProviders()).toEqual([]);
  });
});

describe('buildProviderAuthModes (RFC 0121 §B.7)', () => {
  it('advertises apiKey-only for byok providers with no subscription providers', () => {
    const { byok, authModes } = buildProviderAuthModes(['anthropic', 'openai', 'google'], []);
    expect(byok).toEqual(['anthropic', 'openai', 'google']);
    expect(authModes).toEqual({ anthropic: ['apiKey'], openai: ['apiKey'], google: ['apiKey'] });
  });

  it('§B.7 — a forced subscription provider advertises subscription AND is force-included in byok', () => {
    // Forces the invariant even though the live helper is always [] (honest-off).
    const { byok, authModes } = buildProviderAuthModes(['anthropic', 'openai'], ['minimax']);
    expect(byok).toContain('minimax'); // force-included
    expect(authModes.minimax).toEqual(['apiKey', 'subscription']);
    expect(authModes.anthropic).toEqual(['apiKey']);
  });

  it('§B.7 — a byok provider that is also subscription-enabled gets both modes and stays in byok', () => {
    const { byok, authModes } = buildProviderAuthModes(['anthropic', 'openai'], ['anthropic']);
    expect(byok).toContain('anthropic');
    expect(authModes.anthropic).toEqual(['apiKey', 'subscription']);
  });
});

describe('ADR 0756 — assertSubscriptionProviderPermitted (the prohibited-provider rail)', () => {
  it('refuses anthropic and google with 403 credential_forbidden', async () => {
    const { assertSubscriptionProviderPermitted } = await import('../src/byok/subscriptionCredentialScope.js');
    for (const p of ['anthropic', 'google']) {
      let err: unknown;
      try { assertSubscriptionProviderPermitted(p); } catch (e) { err = e; }
      expect(err).toMatchObject({ code: 'credential_forbidden', httpStatus: 403 });
    }
  });
  it('permits openai and the cleared github.copilot', async () => {
    const { assertSubscriptionProviderPermitted } = await import('../src/byok/subscriptionCredentialScope.js');
    expect(() => assertSubscriptionProviderPermitted('openai')).not.toThrow();
    expect(() => assertSubscriptionProviderPermitted('github.copilot')).not.toThrow();
  });
});
