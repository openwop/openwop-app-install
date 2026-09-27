/**
 * ADR 0550 P3 — deployment attestation: the record, and the verifier.
 *
 * WHAT THIS IS FOR. Lane 2 proves the release ARTIFACT conforms. It does not
 * prove that the thing serving production is that artifact, nor that the
 * evidence was produced against it. This binds the two together so a claim can
 * name what it is about — and, more importantly, so a claim about a DIFFERENT
 * build, an expired run, or a host whose capabilities have since changed is
 * detectably wrong rather than quietly plausible.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS MODULE EXISTS TO ENFORCE: **a signer may only sign what it can
 * verify.**
 *
 * The attestation binds executed/pass/fail/skip counts and an evidence digest.
 * The BACKEND cannot verify those — it has no way to know a given pass count
 * came from a real suite run against itself rather than from whatever a caller
 * posted. So there is deliberately **no runtime signing endpoint here**. The
 * attestation is produced by the deploy pipeline, which actually ran the suite
 * and is therefore the only party able to bind evidence to execution.
 *
 * That is not caution for its own sake. ADR 0550 P2 shipped a provenance check
 * that passed `OPENWOP_BUILD_COMMIT` into a container and then asserted the
 * commit came back — reading its own input and calling it provenance. An
 * unstamped image still exited 0. A runtime attestation API would be that same
 * defect with a signature attached, which is strictly worse: the signature makes
 * an unverified number look corroborated.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This module is the VERIFIER and the record shape. The signer lives in the
 * deploy pipeline (`scripts/`), mirroring how pack signing already works — the
 * host verifies, it does not mint. See `host/packSignature.ts`, which is
 * likewise verify-only.
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

/**
 * Where a deployment sits. **Part of the SIGNED payload, deliberately.**
 *
 * Without this field a local attestation is byte-indistinguishable from a
 * production one, and the lane that certifies a laptop looks exactly like the
 * lane that certifies production. That is a data-integrity failure, not a
 * labelling nicety: the whole point of the record is that a reader can tell
 * what it is about.
 */
export type EnvironmentClass = 'local' | 'staging' | 'production';

/** Counts as reported by the suite's own machine-readable output. NEVER
 *  assembled from arguments handed to the signer — see the module header. */
export interface EvidenceCounts {
  collected: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface DeploymentAttestationPayload {
  /** Schema marker. Internal — NOT the RFC 0148/0155/0156 claim vocabulary,
   *  which is still Draft. P4 renders public claims; this is an internal
   *  evidence record and must not be served publicly while that holds. */
  kind: 'openwop-app.deployment-attestation.v1';

  /** Artifact identity (ADR 0518). `commitSource` is carried because 'env' is a
   *  CLAIM and 'image' is corroboration — a distinction `host/buildInfo.ts`
   *  already models and which P2's lane learned to assert the hard way. */
  build: {
    commit: string;
    commitSource: 'image' | 'env' | 'none';
    containerDigest: string | null;
    deployRevision: string;
  };

  environmentClass: EnvironmentClass;

  /** Versions the evidence was produced against. */
  versions: {
    conformanceSuite: string;
    protocol: string | null;
    corpusStamp: string | null;
  };

  /** The exact profile list claimed, plus a digest of the discovery document
   *  those profiles were read from. Drift is detected by re-digesting the LIVE
   *  document and comparing — a read-time comparison, not a background job. */
  profiles: string[];
  discoveryDigest: string;

  /** Adapter kinds only. Never a DSN, never a credential — the record is
   *  intended to be readable by an operator without exposing configuration. */
  runtime: {
    storageAdapter: string;
    queueAdapter: string | null;
  };

  evidence: EvidenceCounts & { artifactDigest: string };

  /**
   * ADR 0556 P4 — the telemetry half of the evidence record.
   *
   * `attests` is a LITERAL, and it is the load-bearing field: this record binds
   * what the attested tree DECLARES (which objectives exist, and the digest of
   * the document declaring them), never whether they were MET. Attainment needs
   * a 28-day fleet-wide window from a production telemetry backend, which is
   * P4's external dependency and is not wired — `docs/SLO.md` says the same in
   * its own header ("measurable, not yet measured against a production
   * baseline").
   *
   * Spelled out in the payload rather than left to a doc because a signed list
   * of targets and a signed statement that the targets were met look identical
   * to a reader who has to go elsewhere to learn which one they are holding —
   * and they will guess the flattering one. A future phase that can verify
   * attainment adds a value to this union; it must not repurpose this one.
   */
  telemetry: {
    attests: 'declaration';
    objectives: number;
    objectiveIds: string[];
    declarationDigest: string;
  };

  issuedAt: string;
  expiresAt: string;
  signerKeyId: string;
}

export interface SignedAttestation {
  payload: DeploymentAttestationPayload;
  /** Detached Ed25519 signature over the CANONICAL payload bytes, base64. */
  signature: string;
}

/**
 * Canonical bytes for signing/verification.
 *
 * Key order must not affect the signature, or a re-serialization that is
 * semantically identical would verify as tampered. Sorted-key JSON gives one
 * byte sequence per value.
 */
export function canonicalPayloadBytes(payload: DeploymentAttestationPayload): Buffer {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, sortDeep(val)]),
      );
    }
    return v;
  };
  return Buffer.from(JSON.stringify(sortDeep(payload)), 'utf8');
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type AttestationVerdict =
  | { ok: true }
  | { ok: false; reason: 'bad_signature' }
  | { ok: false; reason: 'unknown_signer' }
  | { ok: false; reason: 'expired'; expiredAt: string }
  | { ok: false; reason: 'wrong_revision'; attested: string; live: string }
  | { ok: false; reason: 'discovery_drift'; attested: string; live: string }
  | { ok: false; reason: 'unverified_provenance'; commitSource: string };

export interface LiveHostFacts {
  /** From `/api/readiness` → `build.commit` on the host being checked. */
  commit: string;
  /** The live discovery document, exactly as served. */
  discoveryDocument: string;
}

export interface VerifyOptions {
  /** Injected so expiry is testable without sleeping. */
  now?: number;
  /** keyId → PEM public key. Unknown ids fail closed. */
  keyring: Record<string, string>;
}

/**
 * Verify an attestation against the host it claims to describe.
 *
 * FAIL-CLOSED throughout, and ORDER MATTERS: signature first, because every
 * later field is only meaningful once the payload is known to be authentic.
 * Checking expiry or revision on an unverified payload would be reading
 * attacker-supplied data and reporting a specific-sounding reason for it.
 */
export function verifyAttestation(
  signed: SignedAttestation,
  live: LiveHostFacts,
  opts: VerifyOptions,
): AttestationVerdict {
  const pem = opts.keyring[signed.payload.signerKeyId];
  if (!pem) return { ok: false, reason: 'unknown_signer' };

  let signatureValid = false;
  try {
    signatureValid = edVerify(
      null,
      canonicalPayloadBytes(signed.payload),
      createPublicKey({ key: pem, format: 'pem' }),
      Buffer.from(signed.signature, 'base64'),
    );
  } catch {
    signatureValid = false; // any crypto error is a failure, never a pass
  }
  if (!signatureValid) return { ok: false, reason: 'bad_signature' };

  // An attestation whose own build provenance was a CLAIM ('env') rather than
  // corroboration ('image') cannot support a claim about the artifact. This is
  // the P2 lesson promoted into the record: assert the source, not the value.
  if (signed.payload.build.commitSource !== 'image') {
    return { ok: false, reason: 'unverified_provenance', commitSource: signed.payload.build.commitSource };
  }

  const now = opts.now ?? Date.now();
  if (Date.parse(signed.payload.expiresAt) <= now) {
    return { ok: false, reason: 'expired', expiredAt: signed.payload.expiresAt };
  }

  if (signed.payload.build.commit !== live.commit) {
    return { ok: false, reason: 'wrong_revision', attested: signed.payload.build.commit, live: live.commit };
  }

  const liveDiscovery = sha256Hex(live.discoveryDocument);
  if (liveDiscovery !== signed.payload.discoveryDigest) {
    return { ok: false, reason: 'discovery_drift', attested: signed.payload.discoveryDigest, live: liveDiscovery };
  }

  return { ok: true };
}
