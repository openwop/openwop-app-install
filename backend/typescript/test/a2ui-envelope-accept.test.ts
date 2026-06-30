/**
 * A2UI surface envelope acceptance (RFC 0102, ADR 0051 Phase 2 increment 2).
 *
 * Proves the host accept-seam for the advertised `ui.a2ui-surface` kind by
 * exercising `acceptEnvelope` against the byte-identical vendored schema
 * (`schemas/envelopes/ui.a2ui-surface.schema.json`, sha256 68f977c1…). This is
 * the host-side half of the dual-witness graduation: the renderer (frontend)
 * owns the render-side `no-code-exec`/`no-network-egress` probes; the acceptor
 * owns the wire-side accepted/gated/invalid/untrusted-blocks-approval matrix.
 *
 * Status vocabulary (the acceptor's `EnvelopeOutcome`; the conformance seam
 * translates `invalid+unknown_schema_version`→refused and
 * `invalid+untrusted_content_blocks_approval`→blocked):
 *   advertised + valid + catalogVersion 0.9.1         → accepted
 *   kind ∉ supportedEnvelopes                          → gated   (degrade, N6)
 *   schema-invalid (missing surface / out-of-catalog)  → invalid
 *   catalogVersion ∉ enum                              → invalid (unknown_schema_version)
 *   untrusted + approval-gate                          → invalid (untrusted_content_blocks_approval)
 */

import { describe, it, expect } from 'vitest';
import { acceptEnvelope } from '../src/host/envelopeAcceptor.js';

const ADVERTISED = ['ui.a2ui-surface'] as const;

function envelope(payload: unknown, over: Record<string, unknown> = {}): unknown {
  return {
    type: 'ui.a2ui-surface',
    schemaVersion: 1,
    envelopeId: 'env-a2ui-1',
    correlationId: 'run-1:node-2:turn-0:abc123',
    payload,
    meta: { source: 'ai-generation', ts: '2026-06-15T10:00:00Z' },
    ...over,
  };
}

const validPayload = {
  catalogVersion: '0.9.1',
  surface: {
    title: 'Schedule the kickoff',
    components: [
      { component: 'text', text: 'Pick a time.' },
      { component: 'field.date', id: 'when', label: 'Date', required: true },
      { component: 'action.button', id: 'confirm', label: 'Confirm', action: { target: 'resume' } },
    ],
  },
};

describe('ui.a2ui-surface — host accept-seam (RFC 0102)', () => {
  it('accepts an advertised, schema-valid surface at catalog 0.9.1', () => {
    const r = acceptEnvelope(envelope(validPayload), { hostSupportedEnvelopes: ADVERTISED });
    expect(r.status).toBe('accepted');
  });

  it('gates (degrades) when the host does not advertise the kind (N6 — run survives)', () => {
    const r = acceptEnvelope(envelope(validPayload), { hostSupportedEnvelopes: ['clarification.request'] });
    expect(r.status).toBe('gated');
  });

  it('rejects a schema-invalid surface (missing `surface`) as invalid', () => {
    const r = acceptEnvelope(envelope({ catalogVersion: '0.9.1' }), { hostSupportedEnvelopes: ADVERTISED });
    expect(r.status).toBe('invalid');
  });

  it('rejects an out-of-catalog component as invalid (a2ui-surface-no-code-exec, wire half)', () => {
    const r = acceptEnvelope(
      envelope({ catalogVersion: '0.9.1', surface: { components: [{ component: 'iframe', src: 'x' }] } }),
      { hostSupportedEnvelopes: ADVERTISED },
    );
    expect(r.status).toBe('invalid');
  });

  it('rejects an unknown catalogVersion (enum violation) as invalid', () => {
    const r = acceptEnvelope(
      envelope({ ...validPayload, catalogVersion: '9.9.9' }),
      { hostSupportedEnvelopes: ADVERTISED },
    );
    expect(r.status).toBe('invalid');
  });

  it('blocks an untrusted surface from advancing an approval gate', () => {
    const r = acceptEnvelope(
      envelope(validPayload, { meta: { source: 'ai-generation', ts: '2026-06-15T10:00:00Z', contentTrust: 'untrusted' } }),
      { hostSupportedEnvelopes: ADVERTISED, approvalGateContext: true },
    );
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') expect(r.reason).toBe('untrusted_content_blocks_approval');
  });
});
