/**
 * RFC 0121 §B.7/§B.8 — pure unit coverage for the scope-safety rail.
 *   - assertSubscriptionScopeAllowed: user ok; tenant/workspace throw
 *     credential_scope_forbidden (403).
 *   - subscriptionEnabledProviders: honest-off ([]) when only the provider
 *     opt-in env is set. CORRECTED (wave 61): since ADR 0180 the reason is the
 *     SECOND gate (`OPENWOP_SUBSCRIPTION_AT_OWN_RISK` unset, which
 *     `subscriptionAcquisitionConfigured()` reads), not that no lawful mechanism
 *     exists. The two cases are TWINS of subscription-credential-at-own-risk's
 *     "[] by default" and "[] when only the provider list is set" (one sabotage
 *     reds both files: 8fw3g2-aor-gate / -aor-gate-cover); kept on purpose
 *     (protected wire-honesty dedupe, grade-tests wave 61 ruling).
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
      let err: unknown;
      try { assertSubscriptionScopeAllowed(scope); } catch (e) { err = e; }
      expect(err, 'assertSubscriptionScopeAllowed must throw').toBeInstanceOf(OpenwopError);
      expect(err).toMatchObject({ code: 'credential_scope_forbidden', httpStatus: 403 });
    });
  }
});

describe('subscriptionEnabledProviders (RFC 0121 §B.9 honest-off)', () => {
  // Twins of the at-own-risk file's two-gate cases (see header). The second
  // gate is cleared explicitly so the outcome never rides on leaked env.
  afterEach(() => { delete process.env.OPENWOP_SUBSCRIPTION_PROVIDERS; });

  it('returns [] by default (env unset)', () => {
    delete process.env.OPENWOP_SUBSCRIPTION_PROVIDERS;
    expect(subscriptionEnabledProviders()).toEqual([]);
  });

  it('returns [] even when the operator opt-in env is set (no lawful mechanism → dark)', () => {
    delete process.env.OPENWOP_SUBSCRIPTION_AT_OWN_RISK;
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
