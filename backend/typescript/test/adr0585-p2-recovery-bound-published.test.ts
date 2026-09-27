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
 * These tests pin BOTH halves: that the bundle carries a recomputable
 * derivation, and that the discovery document does NOT carry it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OUTBOX_LEASE_MS,
  POLL_INTERVAL_MS,
  ORPHAN_SWEEP_EVERY_N_TICKS,
} from '../src/host/runDispatchSweeper.js';
import { RUN_DISPATCH_LEASE_MS } from '../src/executor/executor.js';
import { recoveryBoundTerms, declaredRecoveryBoundMs } from '../src/host/recoveryBound.js';
import { assembleCertification, type AssembleInput } from '../conformance/certify.js';

/** The shape `run.ts` emits, built from the live module exactly as it does. */
function liveRecoveryBound() {
  return {
    terms: { ...recoveryBoundTerms() },
    classes: {
      unleased: declaredRecoveryBoundMs('unleased'),
      leased: declaredRecoveryBoundMs('leased'),
    },
  };
}

function assemble(over: Partial<AssembleInput> = {}) {
  return assembleCertification({
    document: { capabilities: {} },
    discoveryUrl: 'http://127.0.0.1:9/.well-known/openwop',
    states: new Map(),
    ledger: [],
    suiteVersion: '0.0.0-test',
    hostName: 'openwop-workflow-engine',
    hostVersion: '0.1.0',
    requireBehavior: false,
    optedOut: [],
    now: '2026-01-01T00:00:00.000Z',
    recoveryBound: liveRecoveryBound(),
    ...over,
  });
}

describe('ADR 0585 P2 — the bound reaches the evidence bundle', () => {
  it('the bundle carries the recovery bound', () => {
    const { bundle } = assemble();
    expect(bundle.recoveryBound).toBeDefined();
  });

  // The load-bearing property. RFC 0158 asks for "the per-class arithmetic, not
  // a single total ... where a reader can RECOMPUTE it". A bundle carrying only
  // totals satisfies "published" and fails the actual requirement, so this
  // recomputes each class from the terms the bundle itself ships.
  it('a reader can RECOMPUTE each class from the terms in the bundle alone', () => {
    const { bundle } = assemble();
    const { terms, classes } = bundle.recoveryBound!;

    // unleased: the outbox lane owns it (#3461) — lease + one tick.
    expect(classes.unleased).toBe(OUTBOX_LEASE_MS + POLL_INTERVAL_MS);
    // leased: the dispatch lease must lapse, then a sweep of the ORPHAN lane,
    // whose cadence is the product and not POLL_INTERVAL_MS alone.
    expect(classes.leased).toBe(RUN_DISPATCH_LEASE_MS + terms.orphanSweepIntervalMs);
    // ...and the term the bundle ships for that cadence is itself the product.
    expect(terms.orphanSweepIntervalMs).toBe(POLL_INTERVAL_MS * ORPHAN_SWEEP_EVERY_N_TICKS);
  });

  it('the bundle agrees with the live module — no restated literal', () => {
    const { bundle } = assemble();
    expect(bundle.recoveryBound!.classes.unleased).toBe(declaredRecoveryBoundMs('unleased'));
    expect(bundle.recoveryBound!.classes.leased).toBe(declaredRecoveryBoundMs('leased'));
    expect(bundle.recoveryBound!.terms).toEqual({ ...recoveryBoundTerms() });
  });

  // NON-VACUITY FLOOR. Every assertion above is a relation, and relations all
  // hold trivially between zeroes/NaN — an import resolving to `undefined` would
  // make the recomputation `NaN === NaN`... which is false, but a zeroed constant
  // would pass silently. This is the H97 undefined-import floor.
  it('the published numbers are positive finite milliseconds', () => {
    const { classes, terms } = assemble().bundle.recoveryBound!;
    for (const [k, v] of [...Object.entries(classes), ...Object.entries(terms)]) {
      expect(Number.isFinite(v), `${k} must be finite`).toBe(true);
      expect(v, `${k} must be positive`).toBeGreaterThan(0);
    }
  });

  it('omitting it is possible — the field is optional, not fabricated when absent', () => {
    // A caller that cannot derive a bound must publish NOTHING rather than a
    // zero or a placeholder. RFC 0148 §A: absence is evidence of nothing; a
    // fabricated zero would be evidence of something false.
    const { bundle } = assemble({ recoveryBound: undefined });
    expect('recoveryBound' in bundle).toBe(false);
  });

  it('the bundle still passes the suite\'s own consumer verifier', () => {
    // The added field must not make the emitter produce a document its own
    // verifier rejects — that would be an emitter defect, not evidence.
    expect(assemble().selfAudit).toEqual([]);
  });
});

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
