/**
 * ADR 0585 P2 — the recovery bound is PUBLISHED, into the RFC 0148 evidence
 * bundle rather than onto the wire.
 *
 * P2 was written as "declare the recovery bound ON THE WIRE ... advert derived
 * from the constant". Implementing that literally would have been wrong, and the
 * correction is the interesting half of this phase:
 *
 *   - P2 cites RFC 0151's amended criterion ("recovery within a host-declared
 *     bound, and the bound is advertised"). But `RFCS/0151:146` says that
 *     requirement "belongs in RFC 0158 ... and moves there when 0158 is
 *     authored. It stays in this box until 0158 exists so nothing is dropped in
 *     transit." **0158 now exists**, so the criterion moved.
 *   - RFC 0158 §E.10 **mints no capability field** and chose bundle-first
 *     publication. §"`bound-is-derived` evidence": the derivation "is emitted
 *     into the host's RFC 0148 evidence bundle, where a reader can recompute it.
 *     It is **not** advertised as a discovery field."
 *
 * So a discovery field would have been host-invented wire surface — advertising
 * something the governing RFC declined to mint.
 *
 * These tests pinned BOTH halves: that the bundle carries a recomputable
 * derivation, and that the discovery document does NOT carry it.
 *
 * CORRECTED 2026-10-16 (ADR 0812 P4 slice 3) — the BUNDLE half is deleted with
 * the in-process emitter (`conformance/certify.ts`) it exercised. That emitter's
 * bundle v2 has not been built since ADR 0869 and was served by nothing, so its
 * `recoveryBound` reached no reader. The published derivation now rides the
 * suite CLI's signed v3 cut: the `0158.bound-is-derived` row's
 * `evidence.recoveryBounds`, which the host supplies through the durability seam
 * (`routes/durabilitySeam.ts`, pinned by `rfc0158-durability-seam.test.ts`).
 * The discovery half below is unchanged and still binding.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ADR 0585 P2 — the bound must NOT become a discovery field', () => {
  const DISCOVERY = resolve(import.meta.dirname, '..', 'src', 'routes', 'discovery.ts');

  // RFC 0158 §E.10 mints no capability field for this. The failure mode is a
  // later well-meaning change that "finishes" P2 as originally written, so this
  // pins the RFC's decision at the one place it would be violated.
  it('discovery.ts does not import the recovery-bound module', () => {
    const src = readFileSync(DISCOVERY, 'utf8');
    expect(
      src.includes('recoveryBound'),
      'RFC 0158 §E.10 mints NO capability field for the recovery bound — it is bundle-published. ' +
        'Advertising it in discovery would be wire surface the governing RFC declined to mint.',
    ).toBe(false);
  });

  // Guards the guard: if the file moved, the assertion above would pass by
  // reading nothing. (`readFileSync` throws on a missing path, so this asserts
  // we are reading the real discovery document.)
  it('...and the file it checks is really the discovery document', () => {
    const src = readFileSync(DISCOVERY, 'utf8');
    expect(src).toContain('.well-known/openwop');
  });
});
