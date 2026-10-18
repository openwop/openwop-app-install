/**
 * KEYS-REF-1 — the Keys page names a credential ref's provider by the BACKEND's
 * rule, not by "split at the first colon". The first-colon split read the BYOK
 * wizard's `byok:google` (ADR 0517 fix B) as provider `byok`, so the key counted
 * in the Total tile but was listed nowhere and could not be deleted.
 *
 * Parity: one fixture list runs through the SPA's `refNamedProvider` AND the
 * backend's (`backend/typescript/src/aiProviders/credentialRefLadder.ts`, a pure
 * module), so the two cannot drift. Break it by changing either rule.
 */
import { describe, expect, it } from 'vitest';
import { isCardOwnedRef, parseCredentialRef, refNamedProvider } from '../credentialRef.js';
import { refNamedProvider as backendRefNamedProvider } from '../../../../../../backend/typescript/src/aiProviders/credentialRefLadder.js';

const PROVIDERS = ['anthropic', 'openai', 'google'] as const;

/** [ref, the provider it names (or null)] — literal expectations, not computed. */
const FIXTURES: ReadonlyArray<readonly [string, string | null]> = [
  ['openai', 'openai'],
  ['byok:google', 'google'],
  ['byok:google:1760000000000', 'google'],
  ['google:prod', 'google'],
  ['google-work', 'google'],
  ['anthropic:team:a', 'anthropic'],
  ['byok:openai', 'openai'],
  ['byok', null],
  ['byok:minimax', null],
  ['my-key', null],
  ['web-search', null],
  ['subscription:github.copilot', null],
  ['managed:openwop-free', null],
  ['googlex', null],
];

describe('KEYS-REF-1 — which provider a credential ref names', () => {
  it.each(FIXTURES)('%s names %s (SPA rule)', (ref, expected) => {
    expect(refNamedProvider(ref, PROVIDERS)).toBe(expected);
  });

  it('the SPA and backend rules agree on every fixture', () => {
    const spa = FIXTURES.map(([ref]) => refNamedProvider(ref, PROVIDERS));
    const backend = FIXTURES.map(([ref]) => backendRefNamedProvider(ref, PROVIDERS));
    expect(spa).toEqual(backend);
    expect(spa).toEqual(FIXTURES.map(([, p]) => p));
  });

  it('parses the label after the provider, and none for the bare and wizard shapes', () => {
    expect(parseCredentialRef('byok:google', PROVIDERS)).toEqual({ ref: 'byok:google', providerId: 'google', label: null });
    expect(parseCredentialRef('google', PROVIDERS)).toEqual({ ref: 'google', providerId: 'google', label: null });
    expect(parseCredentialRef('google:prod', PROVIDERS)).toEqual({ ref: 'google:prod', providerId: 'google', label: 'prod' });
    expect(parseCredentialRef('byok:google:1760000000000', PROVIDERS)).toEqual({ ref: 'byok:google:1760000000000', providerId: 'google', label: '1760000000000' });
    expect(parseCredentialRef('google-work', PROVIDERS)).toEqual({ ref: 'google-work', providerId: 'google', label: 'work' });
    expect(parseCredentialRef('my-key', PROVIDERS)).toEqual({ ref: 'my-key', providerId: null, label: null });
  });

  it('only the web-search, subscription and managed refs are card-owned', () => {
    expect(['web-search', 'subscription:github.copilot', 'managed:openwop-free'].map(isCardOwnedRef)).toEqual([true, true, true]);
    expect(['my-key', 'byok:minimax', 'byok:google', 'web-search-2'].map(isCardOwnedRef)).toEqual([false, false, false, false]);
  });
});
