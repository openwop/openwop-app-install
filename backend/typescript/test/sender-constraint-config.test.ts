/**
 * ADR 0556 §C — the host must not advertise a sender constraint it cannot verify.
 *
 * RFC 0154 §C makes sender constraint a SHOULD, and an empty `senderConstraint`
 * array is the conformant bearer-fallback advertisement. What is NOT conformant
 * is naming `dpop` or `mtls` on the wire without a verifier behind it, and that
 * is what an operator got by setting one environment variable:
 *
 *   - the advert derives from the configured set (`routes/discovery.ts`), so the
 *     wire would claim the scheme;
 *   - `verifyWorkloadCredential` never populates `identity.keyBinding` — the
 *     only writer is the §20 test seam, which takes it from the request body;
 *   - so §C's check refuses EVERY verified credential with
 *     `sender_constraint_missing`.
 *
 * A wire claim the host cannot meet, plus a self-inflicted outage, from a
 * variable that looked like a hardening knob. It now throws at config-read time.
 *
 * These tests are the pair that keeps that honest: the refusal fires, and the
 * default stays the conformant empty set.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  UnverifiableSenderConstraintError,
  readWorkloadIdentityConfigFromEnv,
} from '../src/host/workloadIdentity.js';

const ENV_KEYS = [
  'OPENWOP_WORKLOAD_IDENTITY_AUDIENCE',
  'OPENWOP_WORKLOAD_IDENTITY_SENDER_CONSTRAINTS',
  'OPENWOP_TEST_SEAM_ENABLED',
] as const;

const saved = new Map<string, string | undefined>();
for (const k of ENV_KEYS) saved.set(k, process.env[k]);

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('ADR 0556 §C — sender-constraint configuration is fail-closed', () => {
  it('refuses to read a config that requests DPoP, because nothing verifies it', () => {
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE = 'urn:openwop:test-audience';
    process.env.OPENWOP_WORKLOAD_IDENTITY_SENDER_CONSTRAINTS = 'dpop';

    expect(() => readWorkloadIdentityConfigFromEnv()).toThrow(UnverifiableSenderConstraintError);
    // The message has to name the consequence, not just the rule: whoever set
    // this variable is about to lose every authenticated workload request.
    expect(() => readWorkloadIdentityConfigFromEnv()).toThrow(/sender_constraint_missing/);
  });

  it('refuses mTLS for the same reason', () => {
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE = 'urn:openwop:test-audience';
    process.env.OPENWOP_WORKLOAD_IDENTITY_SENDER_CONSTRAINTS = 'mtls';
    expect(() => readWorkloadIdentityConfigFromEnv()).toThrow(UnverifiableSenderConstraintError);
  });

  it('the DEFAULT is the conformant bearer-fallback advert, not a refusal', () => {
    // The failure mode in the other direction: if this threw on the empty set,
    // the profile would be unusable and someone would delete the guard.
    process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE = 'urn:openwop:test-audience';
    delete process.env.OPENWOP_WORKLOAD_IDENTITY_SENDER_CONSTRAINTS;

    const cfg = readWorkloadIdentityConfigFromEnv();
    expect(cfg).not.toBeNull();
    expect(cfg?.senderConstraints).toEqual([]);
  });

  it('the §20 seam CAN present a keyBinding, so with the seam on it is configurable', () => {
    // Not a loophole — the point. §C's enforcement path is exercised through the
    // seam (workload-identity-resolver.test.ts), and a blanket refusal would
    // have deleted a tested code path to fix an advert. The seam is never on in
    // production, which is the case this guard is actually about.
    process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
    process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE = 'urn:openwop:test-audience';
    process.env.OPENWOP_WORKLOAD_IDENTITY_SENDER_CONSTRAINTS = 'mtls';
    expect(readWorkloadIdentityConfigFromEnv()?.senderConstraints).toEqual(['mtls']);
  });

  it('an unconfigured profile is still null — this guard does not change that', () => {
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    delete process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE;
    process.env.OPENWOP_WORKLOAD_IDENTITY_SENDER_CONSTRAINTS = 'dpop';
    // No audience means the profile claims nothing at all, so there is no advert
    // to be dishonest about and nothing to refuse.
    expect(readWorkloadIdentityConfigFromEnv()).toBeNull();
  });
});
