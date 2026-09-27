#!/usr/bin/env node
/**
 * ADR 0550 P3 — the deployment-attestation SIGNER.
 *
 * Lives in the deploy pipeline, NOT in the backend, and the reason is the rule
 * the phase is built on:
 *
 *     A signer may only sign what it can verify.
 *
 * The attestation binds executed/pass/fail/skip counts and an evidence digest.
 * The backend cannot verify those — it has no way to know a pass count came from
 * a real suite run against itself rather than from whatever a caller posted. A
 * runtime signing endpoint would mint cryptographic assurance over numbers
 * received on trust, which is ADR 0550 P2's vacuous provenance check with a
 * signature attached: strictly worse, because the signature makes an unverified
 * number look corroborated.
 *
 * This process ran the suite, so it is the only party able to bind evidence to
 * execution. Correspondingly, it REFUSES to take counts as arguments — they are
 * parsed from the suite's own machine-readable output, and the evidence digest
 * is computed over the actual file on disk. A `--passed 2541` flag would
 * recreate the exact defect this script exists to avoid, so there isn't one.
 *
 * Usage:
 *   node scripts/sign-attestation.mjs \
 *     --evidence <path/to/evidence.json>  \
 *     --origin   http://127.0.0.1:18099   \
 *     --env-class local|staging|production \
 *     --key      <path/to/ed25519-private.pem> \
 *     --key-id   openwop-app-deploy-2026 \
 *     --out      <path/to/attestation.json>
 *
 * The public half is what `host/deploymentAttestation.ts` verifies. Verification
 * is the host's job; minting is not — the same split `host/packSignature.ts`
 * already uses.
 */
import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryModule } from './lib/entry-module.mjs';

const DEFAULT_TTL_DAYS = 30;

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Sorted-key JSON so re-serialization cannot read as tampering. Must stay
 *  byte-identical to `canonicalPayloadBytes` in host/deploymentAttestation.ts —
 *  a drift between the two would make every attestation unverifiable, which is
 *  why the parity is pinned by a test rather than left to comment discipline. */
export function canonicalPayloadBytes(payload) {
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, val]) => [k, sortDeep(val)]),
      );
    }
    return v;
  };
  return Buffer.from(JSON.stringify(sortDeep(payload)), 'utf8');
}

/**
 * Read counts from the suite's OWN output. Never from argv.
 *
 * Throws rather than defaulting: a zero-filled count block would produce an
 * attestation asserting a run that did not happen, and "0 failed" is the most
 * dangerous possible default in this file.
 */
export function readEvidence(evidencePath) {
  const raw = readFileSync(evidencePath);
  const parsed = JSON.parse(raw.toString('utf8'));
  const counts = parsed?.counts;
  for (const k of ['collected', 'passed', 'failed', 'skipped']) {
    if (typeof counts?.[k] !== 'number') {
      throw new Error(`evidence file is missing counts.${k} — refusing to sign an attestation whose evidence cannot be read`);
    }
  }
  return {
    counts,
    artifactDigest: sha256Hex(raw), // over the ACTUAL bytes, not a re-serialization
    suiteVersion: parsed?.suiteVersion ?? null,
  };
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

/**
 * ADR 0556 P4 — the TELEMETRY half of the evidence record.
 *
 * What this may honestly bind is decided by the rule at the top of this file:
 * a signer may only sign what it can verify. It can verify what the ATTESTED
 * TREE DECLARES — the objectives and the metrics they are computed from. It
 * cannot verify ATTAINMENT: that would need a 28-day fleet-wide window from a
 * production telemetry backend, which is ADR 0556 P4's external dependency and
 * is not wired. `docs/SLO.md` says the same thing in its own header — the
 * honest state is "measurable, not yet measured against a production baseline".
 *
 * So the payload carries `attests: 'declaration'` as a LITERAL, not a comment.
 * Someone reading a signed attestation must not be able to mistake a signed
 * list of targets for a signed statement that the targets were met, and a field
 * they have to read a doc to interpret is one they will interpret optimistically.
 *
 * The parse rule is COPIED FROM `slo-projection-doc-parity.test.ts` on purpose:
 * that test holds `docs/SLO.md` in bijection with `SLO_CATALOG` in code, so this
 * count is tied to the code by an existing gate rather than by a second parser
 * that could drift from both. Keyed on the exact `| # | SLI | Objective |
 * Metric |` header because the document also carries an alert table and a
 * not-projectable table — a looser parser would ingest those and overcount.
 *
 * ADR 0556's own record is why the count is bound at all: its phase table
 * claimed 26 objectives when the document had 31, and the miscount surfaced
 * only because P2 parsed the file instead of trusting the summary. A miscount
 * is harmless; a miscount nobody can detect is not.
 */
export function readSloDeclaration(sloPath) {
  const raw = readFileSync(sloPath);
  const text = raw.toString('utf8');
  const ids = [];
  let inTable = false;
  for (const line of text.split('\n')) {
    const cells = line.trim().startsWith('|')
      ? line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
      : null;
    if (!cells) { inTable = false; continue; }
    if (cells.length === 4 && cells[0] === '#' && cells[1] === 'SLI') { inTable = true; continue; }
    if (!inTable) continue;
    if (/^-+$/.test((cells[0] ?? '').replace(/[:\s]/g, '') || '-')) continue;
    if (cells.length !== 4) { inTable = false; continue; }
    if (!/^[A-Z]\d+$/.test(cells[0])) { inTable = false; continue; }
    ids.push(cells[0]);
  }
  // Vacuity floor, the same one the parity test keeps: a parser that silently
  // matches nothing would otherwise sign `objectives: 0` and read as a tidy
  // "no SLOs declared" rather than as a broken parse.
  if (ids.length === 0) {
    throw new Error(
      `parsed ZERO objectives out of ${sloPath} — refusing to sign a telemetry record whose parse found nothing `
        + '(the objective table header is `| # | SLI | Objective | Metric |`; if it moved, fix this parser and '
        + 'slo-projection-doc-parity.test.ts together)',
    );
  }
  return {
    attests: 'declaration',
    objectives: ids.length,
    objectiveIds: ids,
    declarationDigest: sha256Hex(raw),
  };
}

export async function buildPayload({ origin, evidence, envClass, keyId, now, ttlDays = DEFAULT_TTL_DAYS, slo }) {
  const readiness = await fetchJson(new URL('/api/readiness', origin).toString());
  const discovery = await fetchJson(new URL('/.well-known/openwop', origin).toString());

  const build = readiness.json?.build ?? {};
  // Refused HERE as well as in the verifier. Signing an 'env'-sourced commit
  // and letting the verifier reject it later would waste a deploy and, worse,
  // produce a signed artifact that looks authoritative in a log.
  if (build.commitSource !== 'image') {
    throw new Error(
      `the origin reports build.commitSource=${build.commitSource ?? '<absent>'}, not 'image' — `
        + 'the commit is self-reported rather than baked into the artifact, so an attestation over it '
        + 'would launder a claim into an assertion (ADR 0518)',
    );
  }

  return {
    kind: 'openwop-app.deployment-attestation.v1',
    build: {
      commit: build.commit,
      commitSource: build.commitSource,
      containerDigest: process.env.OPENWOP_ATTEST_CONTAINER_DIGEST ?? null,
      deployRevision: process.env.OPENWOP_ATTEST_DEPLOY_REVISION ?? `local:${build.commit?.slice(0, 12) ?? 'unknown'}`,
    },
    // Inside the signed payload deliberately: without it a local attestation is
    // byte-indistinguishable from a production one.
    environmentClass: envClass,
    versions: {
      conformanceSuite: evidence.suiteVersion,
      protocol: discovery.json?.protocolVersion ?? null,
      corpusStamp: discovery.json?.contractProvenance?.corpusStamp ?? null,
    },
    profiles: Object.keys(discovery.json?.capabilities ?? {}).sort(),
    discoveryDigest: sha256Hex(discovery.text),
    runtime: {
      storageAdapter: readiness.json?.storage?.adapter ?? 'unknown',
      queueAdapter: readiness.json?.queue?.adapter ?? null,
    },
    evidence: { ...evidence.counts, artifactDigest: evidence.artifactDigest },
    telemetry: slo,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlDays * 86_400_000).toISOString(),
    signerKeyId: keyId,
  };
}

async function main() {
  const envClass = arg('env-class');
  if (!['local', 'staging', 'production'].includes(envClass)) {
    throw new Error(`--env-class must be local|staging|production, got ${envClass}`);
  }
  const evidence = readEvidence(arg('evidence'));
  // Derived from THIS checkout, not from a flag: the signer is running in the
  // tree being deployed, and a `--slo-objectives 31` argument would recreate
  // exactly the defect the `--passed` refusal above exists to prevent.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const slo = readSloDeclaration(arg('slo', join(repoRoot, 'docs', 'SLO.md')));
  const payload = await buildPayload({
    origin: arg('origin'),
    evidence,
    envClass,
    keyId: arg('key-id'),
    now: Date.now(),
    slo,
  });

  const privateKey = createPrivateKey({ key: readFileSync(arg('key')), format: 'pem' });
  const signature = edSign(null, canonicalPayloadBytes(payload), privateKey).toString('base64');

  const out = arg('out');
  writeFileSync(out, `${JSON.stringify({ payload, signature }, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.log(
    `✓ attestation signed → ${out}\n`
      + `  commit ${payload.build.commit?.slice(0, 12)} (${payload.build.commitSource})`
      + ` · ${envClass} · ${payload.evidence.passed} passed / ${payload.evidence.failed} failed`
      + ` · ${payload.telemetry.objectives} SLOs DECLARED (not attained)`
      + ` · expires ${payload.expiresAt}`,
  );
}

if (isEntryModule(import.meta.url)) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`✗ sign-attestation: ${err.message}`);
    process.exit(1);
  });
}
