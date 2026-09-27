/**
 * H27 / S22 — the ONE error-envelope reader.
 *
 * Three properties, and each of them is a bug this codebase actually shipped:
 *
 *   FLAT is the canonical shape and must win. `voiceClient` read `body.error.code`
 *   off a string, so every backend code became `undefined` and `useVoiceMode`'s
 *   `transcription_unsupported` branch could never fire. `biClient` read
 *   `body.error.message` off a string, so every typed 422 reached the user as
 *   "createBiMetric returned 422". Neither threw — a wrong read here is silent.
 *
 *   NESTED must still be tolerated, through the window ending with the first
 *   conformance minor after 2026-11-10: a peer host, or a tab left open across a
 *   deploy, can still hand us the legacy shape, and refusing it would turn a
 *   readable error into a bare status.
 *
 *   MALFORMED must never throw. These readers run inside `catch` blocks on error
 *   paths; a throw there replaces the server's diagnosis with a parse error.
 */

import { describe, expect, it } from 'vitest';
import {
  isCanonicalErrorEnvelope,
  isLegacyNestedEnvelope,
  readErrorCode,
  readErrorDetail,
  readErrorMessage,
  readRetriable,
} from '../errorEnvelope.js';

const FLAT = {
  error: 'runner_unavailable',
  message: 'No runner is registered for this subject.',
  details: { retriable: true, protocol: 'a2a' },
};
const NESTED = {
  error: { code: 'runner_unavailable', message: 'No runner is registered.', retriable: true },
};

describe('readErrorCode', () => {
  it('reads the canonical flat `error` string', () => {
    expect(readErrorCode(FLAT)).toBe('runner_unavailable');
  });

  it('tolerates the legacy nested `error.code` during the deprecation window', () => {
    expect(readErrorCode(NESTED)).toBe('runner_unavailable');
  });

  it('prefers FLAT when a body somehow carries both', () => {
    // A shape no conforming host emits, but the precedence must be stated: the
    // schema's field is the one that wins, never whichever branch runs first.
    expect(readErrorCode({ error: 'flat_wins', details: { code: 'nested_loses' } })).toBe('flat_wins');
  });

  it('returns undefined — never throws — on malformed bodies', () => {
    for (const bad of [null, undefined, 42, 'a string', [], { error: 7 }, { error: null }, { error: '' }, { error: {} }]) {
      expect(readErrorCode(bad)).toBeUndefined();
    }
  });
});

describe('readErrorMessage', () => {
  it('reads the canonical top-level `message`', () => {
    expect(readErrorMessage(FLAT)).toBe('No runner is registered for this subject.');
  });

  it('tolerates the legacy nested `error.message`', () => {
    expect(readErrorMessage(NESTED)).toBe('No runner is registered.');
  });

  it('treats an empty message as absent, so the caller’s fallback runs', () => {
    // `''` would render as a blank error notice — strictly worse than the
    // client's own "Request failed (403)".
    expect(readErrorMessage({ error: 'x', message: '' })).toBeUndefined();
  });

  it('returns undefined on malformed bodies', () => {
    for (const bad of [null, undefined, 'x', [], { message: 9 }]) expect(readErrorMessage(bad)).toBeUndefined();
  });
});

describe('readRetriable', () => {
  it('reads `details.retriable` — the ONLY canonical location', () => {
    expect(readRetriable(FLAT)).toBe(true);
    expect(readRetriable({ error: 'x', message: 'y', details: { retriable: false } })).toBe(false);
  });

  it('tolerates the legacy nested `error.retriable`', () => {
    expect(readRetriable(NESTED)).toBe(true);
  });

  it('is undefined when absent — a client MUST NOT infer retriability from the status', () => {
    expect(readRetriable({ error: 'internal_error', message: 'boom' })).toBeUndefined();
    expect(readRetriable({ error: 'x', message: 'y', details: { retriable: 'true' } })).toBeUndefined();
  });
});

describe('readErrorDetail', () => {
  it('reads a details field off either shape', () => {
    expect(readErrorDetail(FLAT, 'protocol')).toBe('a2a');
    expect(readErrorDetail({ error: { code: 'x', details: { field: 'amount' } } }, 'field')).toBe('amount');
  });

  it('returns undefined for a missing key or a malformed body', () => {
    expect(readErrorDetail(FLAT, 'nope')).toBeUndefined();
    expect(readErrorDetail(null, 'field')).toBeUndefined();
  });
});

describe('shape predicates', () => {
  it('isCanonicalErrorEnvelope accepts the flat shape and nothing else', () => {
    expect(isCanonicalErrorEnvelope(FLAT)).toBe(true);
    expect(isCanonicalErrorEnvelope({ error: 'x', message: 'y' })).toBe(true);
    expect(isCanonicalErrorEnvelope(NESTED)).toBe(false);
    // `additionalProperties: false` — a new top-level key is not the envelope.
    expect(isCanonicalErrorEnvelope({ error: 'x', message: 'y', retriable: true })).toBe(false);
    // `message` is REQUIRED.
    expect(isCanonicalErrorEnvelope({ error: 'x' })).toBe(false);
    expect(isCanonicalErrorEnvelope([])).toBe(false);
  });

  it('isLegacyNestedEnvelope reports the legacy shape (for telemetry, never a pass)', () => {
    expect(isLegacyNestedEnvelope(NESTED)).toBe(true);
    expect(isLegacyNestedEnvelope(FLAT)).toBe(false);
    expect(isLegacyNestedEnvelope(null)).toBe(false);
  });
});
