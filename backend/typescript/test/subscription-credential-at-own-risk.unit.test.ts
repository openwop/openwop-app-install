/**
 * RFC 0121 AT-OWN-RISK (ADR 0180) — pure unit coverage for the credential-ref
 * conventions + the two-gate provider helper.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { isSubscriptionCredentialRef, subscriptionCredentialRef, subscriptionDispatchEndpoint } from '../src/byok/subscriptionCredential.js';
import { subscriptionEnabledProviders } from '../src/aiProviders/aiProvidersHost.js';

afterEach(() => {
  delete process.env.OPENWOP_SUBSCRIPTION_AT_OWN_RISK;
  delete process.env.OPENWOP_SUBSCRIPTION_PROVIDERS;
  delete process.env.OPENWOP_SUBSCRIPTION_ENDPOINT;
});

describe('subscription credential-ref conventions', () => {
  it('builds a namespaced ref and recognizes it', () => {
    const ref = subscriptionCredentialRef('anthropic');
    expect(ref).toBe('subscription:anthropic');
    expect(isSubscriptionCredentialRef(ref)).toBe(true);
  });

  it('does not mistake a BYOK/managed ref for a subscription ref', () => {
    expect(isSubscriptionCredentialRef('anthropic:prod')).toBe(false);
    expect(isSubscriptionCredentialRef('managed:openwop-free')).toBe(false);
  });
});

describe('subscriptionDispatchEndpoint (operator-configured, off by default)', () => {
  it('is undefined (dark) by default', () => {
    expect(subscriptionDispatchEndpoint()).toBeUndefined();
  });
  it('returns the operator endpoint when set', () => {
    process.env.OPENWOP_SUBSCRIPTION_ENDPOINT = 'https://operator.example/v1';
    expect(subscriptionDispatchEndpoint()).toBe('https://operator.example/v1');
  });
});

describe('subscriptionEnabledProviders — two-gate (ADR 0180)', () => {
  it('[] by default (both gates off)', () => {
    expect(subscriptionEnabledProviders()).toEqual([]);
  });
  it('[] when only the provider list is set (no at-own-risk acceptance)', () => {
    process.env.OPENWOP_SUBSCRIPTION_PROVIDERS = 'anthropic,openai';
    expect(subscriptionEnabledProviders()).toEqual([]);
  });
  it('[] when only the at-own-risk flag is set (no provider list)', () => {
    process.env.OPENWOP_SUBSCRIPTION_AT_OWN_RISK = 'true';
    expect(subscriptionEnabledProviders()).toEqual([]);
  });
  it('returns the list when BOTH gates are on', () => {
    process.env.OPENWOP_SUBSCRIPTION_AT_OWN_RISK = 'true';
    process.env.OPENWOP_SUBSCRIPTION_PROVIDERS = 'openai, mistral';
    expect(subscriptionEnabledProviders()).toEqual(['openai', 'mistral']);
  });
  it('ADR 0756 — never returns anthropic or google, whatever the operator lists', () => {
    process.env.OPENWOP_SUBSCRIPTION_AT_OWN_RISK = 'true';
    process.env.OPENWOP_SUBSCRIPTION_PROVIDERS = 'anthropic, openai, google';
    expect(subscriptionEnabledProviders()).toEqual(['openai']);
  });
  it('ADR 0757 — a cleared provider (github.copilot) never rides the at-own-risk path', () => {
    process.env.OPENWOP_SUBSCRIPTION_AT_OWN_RISK = 'true';
    process.env.OPENWOP_SUBSCRIPTION_PROVIDERS = 'github.copilot,openai';
    expect(subscriptionEnabledProviders()).toEqual(['openai']);
  });
});
