/**
 * Localized error envelopes (ADR 0143) — unit tests for the pure projector
 * `localizeErrorEnvelope`. The route-level wiring (Accept-Language → middleware
 * → Content-Language) is covered separately in i18n-error-envelope.test.ts.
 */

import { describe, it, expect } from 'vitest';
import type { ErrorEnvelope } from '@openwop/openwop';
import { localizeErrorEnvelope } from '../src/host/i18n/errorMessages.js';

const env = (over: Partial<ErrorEnvelope> = {}): ErrorEnvelope => ({
  error: 'forbidden',
  message: 'You do not have permission to perform this action.',
  ...over,
});

describe('localizeErrorEnvelope (ADR 0143 / i18n.md)', () => {
  it('translates message + stamps details.locale for a covered (code, locale)', () => {
    const { envelope, localized } = localizeErrorEnvelope(env(), 'pt-BR');
    expect(localized).toBe(true);
    expect(envelope.message).toBe('Você não tem permissão para realizar esta ação.');
    expect(envelope.details?.locale).toBe('pt-BR');
    // machine-readable code is NEVER localized
    expect(envelope.error).toBe('forbidden');
  });

  it('merges details.locale without dropping existing details', () => {
    const { envelope } = localizeErrorEnvelope(
      env({ error: 'validation_error', details: { field: 'name' } }),
      'pt-BR',
    );
    expect(envelope.details).toEqual({ field: 'name', locale: 'pt-BR' });
  });

  it('is a no-op for the host default locale (no catalog entries → no markers)', () => {
    const input = env();
    const { envelope, localized } = localizeErrorEnvelope(input, 'en');
    expect(localized).toBe(false);
    expect(envelope).toBe(input); // same reference, untouched
    expect(envelope.details?.locale).toBeUndefined();
  });

  it('is a no-op for a code with no catalog entry (English retained)', () => {
    const input = env({ error: 'tarball_too_large', message: 'Tarball too large.' });
    const { envelope, localized } = localizeErrorEnvelope(input, 'pt-BR');
    expect(localized).toBe(false);
    expect(envelope.message).toBe('Tarball too large.');
    expect(envelope.details?.locale).toBeUndefined();
  });

  it('is a no-op for an unknown/unsupported requested locale', () => {
    const { localized } = localizeErrorEnvelope(env(), 'de-DE');
    expect(localized).toBe(false);
  });

  it('never mutates the input envelope', () => {
    const input = env({ details: { field: 'x' } });
    const snapshot = JSON.stringify(input);
    localizeErrorEnvelope(input, 'pt-BR');
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
