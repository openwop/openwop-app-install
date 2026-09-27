/**
 * ADR 0706 §3.1 item 4 — the ONE credential-ref ladder, shared by the AI
 * adapter's `resolveCredential` (over the run's secret set) and the Challenge
 * Factory's ignition pre-flight (over the tenant's vault refs).
 *
 * The rungs and their ORDER are the contract: an explicit ref is used iff
 * present (an absent explicit ref is a distinct failure, never a fall-through to
 * a guessed key); else the exact provider name; else the FIRST prefixed ref in
 * list order. First-match is what the dispatcher has always done — the factory
 * pins the ref it picks explicitly precisely because two lists can order
 * prefixed refs differently.
 */
import { describe, expect, it } from 'vitest';
import { isManagedRef, pickCredentialRef } from '../src/aiProviders/credentialRefLadder.js';

describe('pickCredentialRef — rungs in order', () => {
  it('an explicit ref that is present wins over exact and prefix matches', () => {
    expect(pickCredentialRef('google', 'google:two', ['google', 'google:one', 'google:two']))
      .toEqual({ ref: 'google:two', rung: 'explicit' });
  });

  it('an explicit ref that is ABSENT is a distinct failure — never a fall-through to a guessed key', () => {
    expect(pickCredentialRef('google', 'google:gone', ['google', 'google:one']))
      .toEqual({ ref: null, reason: 'explicit_ref_unresolved' });
  });

  it('no explicit ref ⇒ the exact provider name', () => {
    expect(pickCredentialRef('anthropic', undefined, ['google:one', 'anthropic', 'anthropic-prod']))
      .toEqual({ ref: 'anthropic', rung: 'exact' });
  });

  it('no exact ⇒ the FIRST prefixed ref in list order (both `-` and `:` separators)', () => {
    expect(pickCredentialRef('google', undefined, ['openai', 'google:one', 'google-two']))
      .toEqual({ ref: 'google:one', rung: 'prefix' });
    expect(pickCredentialRef('google', undefined, ['google-two', 'google:one']))
      .toEqual({ ref: 'google-two', rung: 'prefix' });
  });

  it('a ref that merely CONTAINS the provider name is not a match', () => {
    expect(pickCredentialRef('google', undefined, ['my-google-key', 'googleplex']))
      .toEqual({ ref: null, reason: 'no_default_credential' });
  });

  it('nothing available ⇒ no_default_credential', () => {
    expect(pickCredentialRef('google', undefined, [])).toEqual({ ref: null, reason: 'no_default_credential' });
  });

  it('the empty string is "no explicit ref", not an explicit ref named ""', () => {
    expect(pickCredentialRef('google', '', ['google'])).toEqual({ ref: 'google', rung: 'exact' });
  });
});

describe('isManagedRef', () => {
  it('recognises the managed-tier sentinel prefix only', () => {
    expect(isManagedRef('managed:openwop-free')).toBe(true);
    expect(isManagedRef('google:one')).toBe(false);
    expect(isManagedRef(undefined)).toBe(false);
    expect(isManagedRef(null)).toBe(false);
  });
});
