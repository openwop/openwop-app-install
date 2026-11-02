/**
 * Pins the `nonEnumerableSecretsView` trust boundary (deferred-work review,
 * 2026-07-03): every enumeration/serialization route into the secrets map is
 * BLOCKED — including the bypasses the old comment hypothesized would work
 * (`Reflect.ownKeys`, `JSON.stringify`). Known-ref lookup stays open by
 * design (packs authenticate by looking up a named ref). A regression here
 * means an accidental-leak channel reopened.
 *
 * TST-DAD-3. Double guard (recorded): Object.keys/entries/values, JSON.stringify
 * and spread call [[OwnPropertyKeys]] AND then [[GetOwnProperty]] per key, so
 * they stay blocked while EITHER trap throws; Reflect.ownKeys and
 * getOwnPropertyNames reach only the `ownKeys` trap, and a direct
 * getOwnPropertyDescriptor reaches only the descriptor trap. Both traps removed
 * together reds the enumeration legs.
 *
 * Red when (sabotage-witnessed, wave 70): the `ownKeys` trap enumerates; the
 * `getOwnPropertyDescriptor` trap describes; the `get` trap serves a symbol key;
 * the `has` trap stops answering a known ref.
 */

import { describe, expect, it } from 'vitest';
import { nonEnumerableSecretsView } from '../src/byok/ephemeralRunSecrets.js';

const LEAK = Symbol.for('owp-test-secret-symbol');

describe('nonEnumerableSecretsView — enumeration is blocked on every route', () => {
  // A secrets map that ALSO carries a symbol-keyed value (as a hostile or buggy
  // producer could attach): the view must never serve it.
  const secrets: Record<string, string> = { anthropic: 'sk-REAL', openai: 'sk-REAL2' };
  Object.defineProperty(secrets, LEAK, { value: 'sk-SYMBOL-LEAK', enumerable: false, configurable: true });
  const view = nonEnumerableSecretsView(secrets);

  it('allows known-ref lookup (the designed use)', () => {
    expect(view['anthropic']).toBe('sk-REAL');
    expect('openai' in view).toBe(true);
  });

  it('blocks Object.keys / Object.entries / Object.values', () => {
    expect(() => Object.keys(view)).toThrow(/not-enumerable|not_enumerable/i);
    expect(() => Object.entries(view)).toThrow(/not-enumerable|not_enumerable/i);
    expect(() => Object.values(view)).toThrow(/not-enumerable|not_enumerable/i);
  });

  it('blocks Reflect.ownKeys (the bypass the old comment thought worked)', () => {
    expect(() => Reflect.ownKeys(view)).toThrow(/not-enumerable|not_enumerable/i);
  });

  it('blocks JSON.stringify and object spread', () => {
    expect(() => JSON.stringify(view)).toThrow(/not-enumerable|not_enumerable/i);
    expect(() => ({ ...view })).toThrow(/not-enumerable|not_enumerable/i);
  });

  it('blocks for…in and getOwnPropertyNames/Descriptors', () => {
    expect(() => { const out: string[] = []; for (const k in view) out.push(k); return out; }).toThrow(/not-enumerable|not_enumerable/i);
    expect(() => Object.getOwnPropertyNames(view)).toThrow(/not-enumerable|not_enumerable/i);
    expect(() => Object.getOwnPropertyDescriptors(view)).toThrow(/not-enumerable|not_enumerable/i);
    // A direct descriptor read of a KNOWN ref is blocked too (reaches only that trap).
    expect(() => Object.getOwnPropertyDescriptor(view, 'anthropic')).toThrow(/not-enumerable|not_enumerable/i);
  });

  it('symbol lookups return undefined (no prototype escape via Symbol keys)', () => {
    // Positive control: the underlying map really holds the symbol-keyed value.
    expect((secrets as Record<symbol, unknown>)[LEAK]).toBe('sk-SYMBOL-LEAK');
    expect((view as Record<symbol, unknown>)[LEAK]).toBeUndefined();
    expect((view as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
    expect((view as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined();
  });
});
