/**
 * TODO-6 — cap.breached carries EXPLICIT numeric fields, not a regex-parsed reason.
 *
 * When an engine-limit cap is breached, `acceptEnvelope` now threads the real
 * `limit` (the cap) + `observed` (the current count) onto the breached outcome,
 * straight from the counter — instead of the projection later regex-extracting
 * them from the human `reason` string. This asserts each cap kind surfaces the
 * true numbers (RFC 0021 §"cap.breached").
 */

import { describe, expect, it } from 'vitest';
import { acceptEnvelope } from '../src/host/envelopeAcceptor.js';

function env(type: string, payload: unknown = {}): unknown {
  return {
    type,
    schemaVersion: 1,
    envelopeId: `env-${type}-${Math.floor(1000 + 7000 * 0.5)}`,
    correlationId: `run-1:node-2:turn-0:${type}`,
    payload,
    meta: { source: 'ai-generation', ts: '2026-06-15T10:00:00Z' },
  };
}

describe('cap.breached — explicit numeric limit/observed (TODO-6)', () => {
  it('envelopesPerTurn breach carries the real cap + current, not a parsed string', () => {
    const r = acceptEnvelope(env('error', { code: 'x', message: 'y' }), {
      counters: { envelopesPerTurn: { current: 5, cap: 3 } },
    });
    expect(r.status).toBe('breached');
    if (r.status !== 'breached') return;
    expect(r.capKind).toBe('envelopes');
    expect(r.limit).toBe(3);
    expect(r.observed).toBe(5);
  });

  it('clarificationRounds breach carries the real cap + current', () => {
    const r = acceptEnvelope(env('clarification.request', { questions: [{ id: 'q1', question: 'which one?' }] }), {
      counters: { clarificationRounds: { current: 4, cap: 2 } },
    });
    expect(r.status).toBe('breached');
    if (r.status !== 'breached') return;
    expect(r.capKind).toBe('clarification');
    expect(r.limit).toBe(2);
    expect(r.observed).toBe(4);
  });

  it('schemaRounds breach carries the real cap + current', () => {
    const r = acceptEnvelope(env('schema.request', { envelopeType: 'ui.a2ui-surface' }), {
      counters: { schemaRounds: { current: 9, cap: 8 } },
    });
    expect(r.status).toBe('breached');
    if (r.status !== 'breached') return;
    expect(r.capKind).toBe('schema');
    expect(r.limit).toBe(8);
    expect(r.observed).toBe(9);
  });
});
