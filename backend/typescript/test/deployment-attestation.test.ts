/**
 * ADR 0550 P3 — the four gate tests: tamper, expiry, wrong-revision,
 * discovery-drift.
 *
 * These use a REAL Ed25519 keypair generated per-test and sign REAL canonical
 * bytes. They are deliberately not mocks around the verifier: a test that stubs
 * the crypto asserts my own serializer agrees with itself, which is the vacuity
 * this phase exists to avoid. P2 shipped exactly that defect — a provenance
 * check that read back the value it had injected — and only sabotage caught it.
 *
 * The positive case is asserted alongside every negative. A verifier that
 * rejects everything passes all four negatives and is useless; the pairing is
 * what makes each negative meaningful.
 */
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalPayloadBytes,
  sha256Hex,
  verifyAttestation,
  type DeploymentAttestationPayload,
  type SignedAttestation,
} from '../src/host/deploymentAttestation.js';

const KEY_ID = 'openwop-app-deploy-2026';
const DISCOVERY = '{"capabilities":{"runs":{"supported":true}}}';
const COMMIT = 'a222fe76a4ec0e0f1d2c3b4a5968778899aabbcc';

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function makePayload(over: Partial<DeploymentAttestationPayload> = {}): DeploymentAttestationPayload {
  return {
    kind: 'openwop-app.deployment-attestation.v1',
    build: {
      commit: COMMIT,
      commitSource: 'image',
      containerDigest: 'sha256:deadbeef',
      deployRevision: 'local:probe',
    },
    environmentClass: 'local',
    versions: { conformanceSuite: '1.73.0', protocol: null, corpusStamp: null },
    profiles: ['openwop-core'],
    discoveryDigest: sha256Hex(DISCOVERY),
    runtime: { storageAdapter: 'memory', queueAdapter: null },
    telemetry: { attests: 'declaration', objectives: 31, objectiveIds: ['A1', 'A2', 'A3'], declarationDigest: 'f'.repeat(64) },
    evidence: { collected: 418, passed: 2541, failed: 0, skipped: 87, artifactDigest: sha256Hex('evidence') },
    issuedAt: '2026-08-13T00:00:00.000Z',
    expiresAt: '2026-09-13T00:00:00.000Z',
    signerKeyId: KEY_ID,
    ...over,
  };
}

function signPayload(payload: DeploymentAttestationPayload, privateKey: ReturnType<typeof makeKeypair>['privateKey']): SignedAttestation {
  return {
    payload,
    signature: edSign(null, canonicalPayloadBytes(payload), privateKey).toString('base64'),
  };
}

const NOW = Date.parse('2026-08-14T00:00:00.000Z');
const live = { commit: COMMIT, discoveryDocument: DISCOVERY };

describe('deployment attestation verifier (ADR 0550 P3)', () => {
  it('THE POSITIVE — an honest attestation verifies (without this, all four negatives are vacuous)', () => {
    const { privateKey, pem } = makeKeypair();
    const verdict = verifyAttestation(signPayload(makePayload(), privateKey), live, {
      now: NOW,
      keyring: { [KEY_ID]: pem },
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('TAMPER — mutating any signed field invalidates the signature', () => {
    const { privateKey, pem } = makeKeypair();
    const signed = signPayload(makePayload(), privateKey);
    // Flip the evidence AFTER signing — the exact attack the record exists to
    // stop: a real signature over different numbers.
    signed.payload.evidence.failed = 0;
    signed.payload.evidence.passed = 99999;
    expect(verifyAttestation(signed, live, { now: NOW, keyring: { [KEY_ID]: pem } })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('TAMPER — re-serializing with different key order still verifies (canonicalization is not accidental)', () => {
    // The complement of the tamper test. If key order changed the signature, a
    // benign round-trip would read as tampering and the verifier would cry wolf.
    const { privateKey, pem } = makeKeypair();
    const payload = makePayload();
    const signed = signPayload(payload, privateKey);
    // Rebuild with the top-level keys in REVERSE insertion order. A spread
    // would preserve order (and duplicate a key), so it would not exercise
    // canonicalization at all.
    const reordered = Object.fromEntries(
      Object.entries(payload).reverse(),
    ) as unknown as DeploymentAttestationPayload;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(payload)); // the reorder is real
    expect(verifyAttestation({ payload: reordered, signature: signed.signature }, live, {
      now: NOW,
      keyring: { [KEY_ID]: pem },
    })).toEqual({ ok: true });
  });

  it('EXPIRY — a lapsed attestation is rejected (clock injected, no sleeping)', () => {
    const { privateKey, pem } = makeKeypair();
    const signed = signPayload(makePayload({ expiresAt: '2026-08-13T12:00:00.000Z' }), privateKey);
    expect(verifyAttestation(signed, live, { now: NOW, keyring: { [KEY_ID]: pem } })).toEqual({
      ok: false,
      reason: 'expired',
      expiredAt: '2026-08-13T12:00:00.000Z',
    });
  });

  it('WRONG-REVISION — an attestation for build A is rejected against a host running B', () => {
    // No second deploy needed: "revision" is an identity bound into the payload
    // and compared to a live origin, so two builds are enough.
    const { privateKey, pem } = makeKeypair();
    const signed = signPayload(makePayload(), privateKey);
    const otherHost = { ...live, commit: 'ffffffffffffffffffffffffffffffffffffffff' };
    expect(verifyAttestation(signed, otherHost, { now: NOW, keyring: { [KEY_ID]: pem } })).toEqual({
      ok: false,
      reason: 'wrong_revision',
      attested: COMMIT,
      live: 'ffffffffffffffffffffffffffffffffffffffff',
    });
  });

  it('DISCOVERY-DRIFT — the host still runs the attested build but now advertises differently', () => {
    const { privateKey, pem } = makeKeypair();
    const signed = signPayload(makePayload(), privateKey);
    const drifted = { ...live, discoveryDocument: '{"capabilities":{"runs":{"supported":true},"voice":{"supported":true}}}' };
    const verdict = verifyAttestation(signed, drifted, { now: NOW, keyring: { [KEY_ID]: pem } });
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: 'discovery_drift', attested: sha256Hex(DISCOVERY) });
  });

  it('UNKNOWN SIGNER — an unpinned key id fails closed, and is NOT reported as a bad signature', () => {
    const { privateKey } = makeKeypair();
    const signed = signPayload(makePayload(), privateKey);
    expect(verifyAttestation(signed, live, { now: NOW, keyring: {} })).toEqual({
      ok: false,
      reason: 'unknown_signer',
    });
  });

  it("PROVENANCE — commitSource 'env' is refused: a claim cannot support a claim", () => {
    // The P2 lesson promoted into the record. An image whose commit came from an
    // env var is self-reported; ADR 0518 treats that as uncorroborated, and an
    // attestation over it would launder the claim into an assertion.
    const { privateKey, pem } = makeKeypair();
    const signed = signPayload(makePayload({
      build: { commit: COMMIT, commitSource: 'env', containerDigest: null, deployRevision: 'local:probe' },
    }), privateKey);
    expect(verifyAttestation(signed, live, { now: NOW, keyring: { [KEY_ID]: pem } })).toEqual({
      ok: false,
      reason: 'unverified_provenance',
      commitSource: 'env',
    });
  });

  it('ORDER — an expired attestation with a BROKEN signature reports bad_signature, not expiry', () => {
    // Order is load-bearing: reporting a specific reason derived from an
    // unverified payload means reporting attacker-supplied data as a finding.
    const { privateKey, pem } = makeKeypair();
    const signed = signPayload(makePayload({ expiresAt: '2026-08-13T12:00:00.000Z' }), privateKey);
    signed.payload.environmentClass = 'production'; // tamper
    expect(verifyAttestation(signed, live, { now: NOW, keyring: { [KEY_ID]: pem } })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('environmentClass is inside the signed payload — a local attestation cannot be relabelled production', () => {
    const { privateKey, pem } = makeKeypair();
    const signed = signPayload(makePayload({ environmentClass: 'local' }), privateKey);
    signed.payload.environmentClass = 'production';
    expect(verifyAttestation(signed, live, { now: NOW, keyring: { [KEY_ID]: pem } })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});
