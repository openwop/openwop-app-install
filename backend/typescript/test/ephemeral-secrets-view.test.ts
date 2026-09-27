/**
 * Pins the `nonEnumerableSecretsView` trust boundary (deferred-work review,
 * 2026-07-03): every enumeration/serialization route into the secrets map is
 * BLOCKED — including the bypasses the old comment hypothesized would work
 * (`Reflect.ownKeys`, `JSON.stringify`). Known-ref lookup stays open by
 * design (packs authenticate by looking up a named ref). A regression here
 * means an accidental-leak channel reopened.
 */

import { describe, expect, it } from 'vitest';
import { nonEnumerableSecretsView } from '../src/byok/ephemeralRunSecrets.js';

describe('nonEnumerableSecretsView — enumeration is blocked on every route', () => {
  const view = nonEnumerableSecretsView({ anthropic: 'sk-REAL', openai: 'sk-REAL2' });

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
  });

  it('symbol lookups return undefined (no prototype escape via Symbol keys)', () => {
    expect((view as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
    expect((view as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined();
  });
});
