/**
 * a2ui-surface delta transport — RFC 0114 host witness (the graduation evidence).
 *
 * Drives the REAL functions the SSE stream serves (`routes/streams.ts` →
 * `projectA2uiDelivery` per subscriber) + the REAL closed-catalog gate
 * (`acceptEnvelope`) in-process, proving the three falsifiable legs the steward
 * verifies to flip 0114 Active→Accepted:
 *
 *   1. delta delivered — a `?a2uiDelta=1` subscriber receives an RFC 6902 JSON-Patch
 *      delta frame (op enum add/remove/replace — never `test`) on a surface mutation;
 *      applying it to the baseline reconstructs the exact updated surface.
 *   2. recorded/served-full stays FULL (the replay-pinned core) — a NON-negotiating
 *      subscriber ALWAYS gets the full `ui.a2ui-surface`, never a delta; the recorded
 *      envelope (what acceptEnvelope validates + the event log persists) is the full
 *      surface. The delta is a per-subscriber transport projection only → `:fork`/replay
 *      read the full recorded surface and are unaffected.
 *   3. post-patch re-validation fail-closed — a delta whose patch reaches an
 *      out-of-catalog component yields a post-patch surface that FAILS closed-catalog
 *      validation (the `a2ui-surface-no-code-exec` boundary holds post-patch); and the
 *      emit-side gate rejects an off-catalog full surface outright.
 *
 * Mirrors the pinned conformance scenario `a2ui-surface-delta-transport` (surfaces +
 * assertions), but exercises THIS host's code (no HTTP/SSE plumbing) so the delta
 * server + catalog gate are covered as a unit — the applied-control witness, the same
 * tier the RFC 0117 FE unit tests provided for the plugin loader.
 *
 * @see docs/adr/0300-frontend-plugin-loader-rfc-0117-0119.md (pack-track witness pattern)
 * @see host/a2uiSurfaceDelta.ts (projectA2uiDelivery — the delta server)
 * @see RFCS/0114-a2ui-surface-deltas.md
 */
import { describe, it, expect } from 'vitest';
import { projectA2uiDelivery, applyPatch, type A2uiDeltaState } from '../a2uiSurfaceDelta.js';
import { acceptEnvelope } from '../envelopeAcceptor.js';

const CATALOG_VERSION = '0.9.1';

/** The baseline full surface (all components in the closed A2UI catalog). */
function fullSurfaceV0(): { catalogVersion: string; surface: unknown } {
  return {
    catalogVersion: CATALOG_VERSION,
    surface: {
      title: 'Schedule the kickoff',
      components: [
        { component: 'heading', text: 'Kickoff', level: 2 },
        { component: 'text', text: 'Pick a date and confirm.' },
        { component: 'field.text', id: 'name', label: 'Your name', required: true },
        { component: 'action.button', id: 'go', label: 'Confirm', action: { target: 'resume' } },
      ],
    },
  };
}
/** The mutated full surface (leaf replace + an in-catalog append). */
function fullSurfaceUpdated(): { catalogVersion: string; surface: unknown } {
  return {
    catalogVersion: CATALOG_VERSION,
    surface: {
      title: 'Schedule the kickoff',
      components: [
        { component: 'heading', text: 'Kickoff', level: 2 },
        { component: 'text', text: 'Confirmed — see you then.' },
        { component: 'field.text', id: 'name', label: 'Your name', required: true },
        { component: 'action.button', id: 'go', label: 'Confirm', action: { target: 'resume' } },
        { component: 'text', text: 'A calendar invite is on its way.' },
      ],
    },
  };
}

/** Wrap a {catalogVersion, surface} in the recorded ui.a2ui-surface envelope shape
 *  (mirrors the emit-surface seam) so acceptEnvelope validates the same bytes the
 *  event log persists / a non-delta subscriber materializes. */
function recordedEnvelope(payload: { catalogVersion: string; surface: unknown }) {
  return {
    type: 'ui.a2ui-surface',
    schemaVersion: 1,
    envelopeId: '11111111-1111-4111-8111-111111111111',
    correlationId: '22222222-2222-4222-8222-222222222222',
    payload,
    meta: { source: 'ai-generation' as const, ts: '2026-07-06T00:00:00.000Z' },
  };
}

describe('RFC 0114 a2ui-surface delta transport — host witness', () => {
  it('leg 2 (emit/recorded): the full ui.a2ui-surface passes the closed-catalog gate (the persisted, replay-pinned shape)', () => {
    const outcome = acceptEnvelope(recordedEnvelope(fullSurfaceV0()));
    expect(outcome.status).toBe('accepted');
  });

  it('leg 1 (delta delivered): a ?a2uiDelta=1 subscriber gets an RFC 6902 delta (no `test` op) that reconstructs the updated surface', () => {
    const state: A2uiDeltaState = {};
    // First surface → baseline full (delta needs a prior).
    const first = projectA2uiDelivery(state, 'evt_1', fullSurfaceV0(), true);
    expect(first.kind).toBe('full');
    // Mutation → a delta frame.
    const second = projectA2uiDelivery(state, 'evt_2', fullSurfaceUpdated(), true);
    expect(second.kind).toBe('delta');
    if (second.kind !== 'delta') return;
    expect(second.frame.patch.length).toBeGreaterThan(0);
    expect(second.frame.catalogVersion).toBe(CATALOG_VERSION);
    // RFC 0114: the delta op enum EXCLUDES `test` (no assertion smuggling).
    for (const op of second.frame.patch) expect(op.op).not.toBe('test');
    // Reconstruct: the host diffs the inner `surface` subtree, so the patch is
    // surface-relative (`/components/...`). Applying it to the baseline surface
    // yields the exact updated surface (round-trip correctness of the transport).
    const reconstructed = applyPatch(fullSurfaceV0().surface, second.frame.patch);
    expect(reconstructed).toEqual(fullSurfaceUpdated().surface);
    // …and the reconstruction re-validates against the closed catalog before render.
    expect(acceptEnvelope(recordedEnvelope({ catalogVersion: CATALOG_VERSION, surface: reconstructed })).status).toBe('accepted');
  });

  it('leg 2 (non-negotiating floor): a subscriber WITHOUT ?a2uiDelta=1 ALWAYS gets full, never a delta', () => {
    const state: A2uiDeltaState = {};
    expect(projectA2uiDelivery(state, 'evt_1', fullSurfaceV0(), false).kind).toBe('full');
    // Same mutation that produced a delta above → still full for a non-negotiating subscriber.
    expect(projectA2uiDelivery(state, 'evt_2', fullSurfaceUpdated(), false).kind).toBe('full');
  });

  it('leg 3 (fail-closed): a delta reaching an out-of-catalog component fails closed-catalog validation post-patch', () => {
    // Surface-relative path (`/components/...`), matching the host's delta output.
    const offCatalogPatch = [
      { op: 'add' as const, path: '/components/-', value: { component: 'iframe', src: 'https://evil.example/x' } },
    ];
    const postPatchSurface = applyPatch(fullSurfaceV0().surface, offCatalogPatch);
    // The consumer re-validates the patched surface → REJECTED (a2ui-surface-no-code-exec holds post-patch).
    expect(acceptEnvelope(recordedEnvelope({ catalogVersion: CATALOG_VERSION, surface: postPatchSurface })).status).not.toBe('accepted');
  });

  it('leg 3 (emit-side gate): an off-catalog FULL surface is rejected at the gate (the emit-surface 422)', () => {
    const bad = { catalogVersion: CATALOG_VERSION, surface: { title: 'x', components: [{ component: 'iframe', src: 'https://evil.example/x' }] } };
    expect(acceptEnvelope(recordedEnvelope(bad)).status).not.toBe('accepted');
  });
});
