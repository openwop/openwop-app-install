/**
 * ADR 0550 P3 — the signer and the verifier must agree on canonical bytes.
 *
 * `canonicalPayloadBytes` exists TWICE by necessity: the signer is a pipeline
 * `.mjs` (it must run without a TypeScript build, at deploy time) and the
 * verifier is host `.ts`. That duplication is a real hazard — if the two ever
 * disagree by a single byte, EVERY attestation becomes unverifiable, and the
 * failure appears as `bad_signature`, i.e. indistinguishable from tampering.
 * A comment asking future maintainers to keep them in sync would be exactly the
 * kind of claim this program keeps finding to be false.
 *
 * So this test does a real ROUND TRIP: sign with the pipeline implementation,
 * verify with the host implementation. It is not two serializers compared to
 * each other in the abstract — it is the actual signing path checked by the
 * actual verifying path, which is the only thing that matters at deploy time.
 */
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SLO_CATALOG } from '../src/observability/sloProjection.js';
import {
  canonicalPayloadBytes as verifierCanonical,
  verifyAttestation,
  type DeploymentAttestationPayload,
} from '../src/host/deploymentAttestation.js';

const SIGNER = pathToFileURL(resolve(__dirname, '..', '..', '..', 'scripts', 'sign-attestation.mjs')).href;

type SignerModule = {
  canonicalPayloadBytes: (p: unknown) => Buffer;
  sha256Hex: (b: Buffer | string) => string;
  readEvidence: (path: string) => { counts: Record<string, number>; artifactDigest: string; suiteVersion: string | null };
  readSloDeclaration: (path: string) => { attests: string; objectives: number; objectiveIds: string[]; declarationDigest: string };
};

const KEY_ID = 'parity-key';

function payload(): DeploymentAttestationPayload {
  return {
    kind: 'openwop-app.deployment-attestation.v1',
    build: { commit: 'abc123def456abc123def456abc123def456abcd', commitSource: 'image', containerDigest: null, deployRevision: 'local:abc123def456' },
    environmentClass: 'local',
    versions: { conformanceSuite: '1.73.0', protocol: null, corpusStamp: null },
    profiles: ['openwop-core', 'openwop-runs'],
    telemetry: { attests: 'declaration', objectives: 31, objectiveIds: ['A1', 'A2', 'A3'], declarationDigest: 'f'.repeat(64) },
    discoveryDigest: 'f'.repeat(64),
    runtime: { storageAdapter: 'memory', queueAdapter: null },
    evidence: { collected: 418, passed: 2541, failed: 0, skipped: 87, artifactDigest: 'a'.repeat(64) },
    issuedAt: '2026-08-13T00:00:00.000Z',
    expiresAt: '2026-09-13T00:00:00.000Z',
    signerKeyId: KEY_ID,
  };
}

describe('attestation signer/verifier parity (ADR 0550 P3)', () => {
  it('ROUND TRIP — a payload signed by the PIPELINE verifies in the HOST', async () => {
    const signer = (await import(SIGNER)) as SignerModule;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');

    // Sign using the PIPELINE's canonicalization — the bytes a real deploy signs.
    const signature = edSign(null, signer.canonicalPayloadBytes(payload()), privateKey).toString('base64');

    const verdict = verifyAttestation(
      { payload: payload(), signature },
      { commit: payload().build.commit, discoveryDocument: 'ignored' },
      {
        now: Date.parse('2026-08-14T00:00:00.000Z'),
        keyring: { [KEY_ID]: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      },
    );

    // discoveryDigest is deliberately unmatched here so the verdict proves the
    // SIGNATURE cleared: reaching discovery_drift means canonicalization agreed.
    expect(verdict).toMatchObject({ ok: false, reason: 'discovery_drift' });
    expect(verdict).not.toMatchObject({ reason: 'bad_signature' });
  });

  it('the two canonicalizations produce IDENTICAL bytes, key order notwithstanding', async () => {
    const signer = (await import(SIGNER)) as SignerModule;
    const p = payload();
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as unknown as DeploymentAttestationPayload;

    expect(signer.canonicalPayloadBytes(p).toString('hex')).toBe(verifierCanonical(p).toString('hex'));
    // and the reorder must not change either
    expect(signer.canonicalPayloadBytes(reordered).toString('hex')).toBe(verifierCanonical(p).toString('hex'));
  });

  it('readEvidence REFUSES a file with unreadable counts — "0 failed" is the worst possible default', async () => {
    const signer = (await import(SIGNER)) as SignerModule;
    const dir = mkdtempSync(join(tmpdir(), 'owp-attest-'));
    try {
      const bad = join(dir, 'evidence.json');
      writeFileSync(bad, JSON.stringify({ counts: { collected: 1, passed: 1 } })); // failed/skipped absent
      expect(() => signer.readEvidence(bad)).toThrow(/counts\.failed/);

      const good = join(dir, 'good.json');
      const body = JSON.stringify({ counts: { collected: 418, passed: 2541, failed: 0, skipped: 87 }, suiteVersion: '1.73.0' });
      writeFileSync(good, body);
      const read = signer.readEvidence(good);
      expect(read.counts.passed).toBe(2541);
      // digest is over the ACTUAL file bytes, not a re-serialization of the parse
      expect(read.artifactDigest).toBe(signer.sha256Hex(Buffer.from(body)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * ADR 0556 P4 — the telemetry block binds a DECLARATION, and says so.
 *
 * The risk this covers is not a wrong number. It is a signed artifact that a
 * reader mistakes for a signed statement that the SLOs were MET. Attainment
 * needs a 28-day fleet-wide production window that this host does not have, so
 * `attests` is pinned to the literal it must keep until one exists.
 */
describe('ADR 0556 P4 — the attested telemetry record', () => {
  const SLO_DOC = resolve(__dirname, '..', '..', '..', 'docs', 'SLO.md');

  it('parses the REAL docs/SLO.md, and agrees with the doc-parity test that holds it to SLO_CATALOG', async () => {
    const signer = (await import(SIGNER)) as SignerModule;
    const d = signer.readSloDeclaration(SLO_DOC);

    // Not a hardcoded 31: the ids are read back and checked for shape, so a
    // parser that started matching the alert table would be caught by the SHAPE
    // of what it ingested rather than only by a count that could coincide.
    expect(d.objectives).toBe(d.objectiveIds.length);
    expect(d.objectives).toBeGreaterThan(0);
    for (const id of d.objectiveIds) expect(id).toMatch(/^[A-Z]\d+$/);
    // Tied to the CODE, not to a literal. ADR 0556's own correction is why: its
    // phase table said 26 while the document had 31, and a second hardcoded
    // number here would be a third place to drift — it would also go red on
    // every legitimate new objective, which trains people to bump it without
    // looking. `slo-projection-doc-parity.test.ts` holds the doc in bijection
    // with SLO_CATALOG; this asserts the SIGNER sees that same population.
    expect(d.objectives).toBe(SLO_CATALOG.length);
  });

  it('pins `attests: declaration` — a future attainment phase adds a value, it does not repurpose this one', async () => {
    const signer = (await import(SIGNER)) as SignerModule;
    expect(signer.readSloDeclaration(SLO_DOC).attests).toBe('declaration');
  });

  it('REFUSES to sign a telemetry record whose parse found nothing', async () => {
    // The vacuity floor. Without it a moved table header produces
    // `objectives: 0`, which reads as the tidy claim "no SLOs declared" rather
    // than as a broken parser — the exact shape of a gate that cannot fail.
    const signer = (await import(SIGNER)) as SignerModule;
    const dir = mkdtempSync(join(tmpdir(), 'slo-'));
    try {
      const empty = join(dir, 'SLO.md');
      writeFileSync(empty, '# No objective table here\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
      expect(() => signer.readSloDeclaration(empty)).toThrow(/ZERO objectives/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
