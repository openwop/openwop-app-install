/**
 * ENG-2 — the load-bearing BYOK redaction guarantees (SR-1):
 *   - stripSecretsFromPersisted() replaces registered run secrets with
 *     labeled `<<redacted:ref>>` markers (Tier 1) and scrubs
 *     credential-SHAPED strings even when unregistered (Tier 2), walking
 *     nested objects + arrays — so secret material never reaches the DB
 *     or event log.
 *   - nonEnumerableSecretsView() allows by-name lookup but throws on any
 *     attempt to enumerate the keyring (Object.keys / entries /
 *     JSON.stringify / spread / for…in).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  setRunSecrets,
  clearRunSecrets,
  stripSecretsFromPersisted,
  nonEnumerableSecretsView,
} from '../src/byok/ephemeralRunSecrets.js';

afterEach(() => {
  clearRunSecrets('run-1');
  clearRunSecrets('run-2');
});

describe('stripSecretsFromPersisted (Tier 1: registered run secrets)', () => {
  it('replaces a registered secret value (exact field match) with a labeled marker', () => {
    setRunSecrets('run-1', { anthropic: 'super-secret-value-123' });
    const out = stripSecretsFromPersisted({ apiKey: 'super-secret-value-123' });
    expect(out.apiKey).toBe('<<redacted:anthropic>>');
  });

  it('redacts across nested objects and arrays', () => {
    setRunSecrets('run-1', { openai: 'OPENAI-LIVE-KEY' });
    const out = stripSecretsFromPersisted({
      a: { b: ['x', 'OPENAI-LIVE-KEY', { c: 'OPENAI-LIVE-KEY' }] },
    });
    expect(out).toEqual({ a: { b: ['x', '<<redacted:openai>>', { c: '<<redacted:openai>>' }] } });
  });

  it('redacts secrets from every active run, not just one', () => {
    setRunSecrets('run-1', { a: 'AAA-secret-aaa' });
    setRunSecrets('run-2', { b: 'BBB-secret-bbb' });
    const out = stripSecretsFromPersisted({ x: 'AAA-secret-aaa', y: 'BBB-secret-bbb' });
    expect(out).toEqual({ x: '<<redacted:a>>', y: '<<redacted:b>>' });
  });

  it('leaves non-secret strings, numbers, booleans, and null untouched', () => {
    setRunSecrets('run-1', { a: 'the-secret' });
    const input = { msg: 'hello world', n: 42, ok: true, nil: null };
    expect(stripSecretsFromPersisted(input)).toEqual(input);
  });
});

describe('stripSecretsFromPersisted (Tier 2: credential-shaped scrub)', () => {
  it('scrubs an unregistered OpenAI-shaped key', () => {
    const out = stripSecretsFromPersisted({ leak: 'sk-abcdefghijklmnopqrstuvwxyz0123' });
    expect(out.leak).toBe('<<redacted:credential-shape>>');
  });

  it('scrubs a GitHub token and a Bearer token', () => {
    const out = stripSecretsFromPersisted({
      gh: 'ghp_abcdefghijklmnopqrstuvwxyz0123',
      auth: 'Bearer abcdefghijklmnopqrstuvwxyz0123',
    });
    expect(out.gh).toBe('<<redacted:credential-shape>>');
    expect(out.auth).toContain('<<redacted:credential-shape>>');
  });
});

describe('nonEnumerableSecretsView', () => {
  it('allows by-name lookup of a known ref', () => {
    const view = nonEnumerableSecretsView({ anthropic: 'KEY' });
    expect(view['anthropic']).toBe('KEY');
    expect('anthropic' in view).toBe(true);
  });

  it('throws on Object.keys / Object.entries (enumeration)', () => {
    const view = nonEnumerableSecretsView({ anthropic: 'KEY', openai: 'KEY2' });
    expect(() => Object.keys(view)).toThrow(/not_enumerable/);
    expect(() => Object.entries(view)).toThrow(/not_enumerable/);
  });

  it('throws on JSON.stringify and spread (exfil attempts)', () => {
    const view = nonEnumerableSecretsView({ anthropic: 'KEY' });
    expect(() => JSON.stringify(view)).toThrow(/not_enumerable/);
    expect(() => ({ ...view })).toThrow(/not_enumerable/);
  });
});
