/**
 * ADR 0550 P4 — the exact-profile CLAIMS artifact, and the RFC 0148 §C bundle it
 * is derived from.
 *
 * WHAT THIS IS FOR. P0–P3 built evidence and kept it internal: a conformance
 * gate, a release-artifact matrix, and a deployment-attestation verifier. None
 * of them says anything in public. P4 is the step where this host states, on a
 * surface a third party can read, WHICH PROFILES IT CLAIMS — and the whole risk
 * of that step is that a claim outruns its evidence. Every prior phase of this
 * ADR found the same defect in a different costume: a CI job NAMED after a check
 * it never ran, a provenance check that compared a value to itself, an advert
 * leg that gated on the flag it then asserted. A hand-written profile list here
 * would be the next one, and the worst of them, because it would be the one
 * peers rely on.
 *
 * SO THE RULE, and everything below is mechanism for it:
 *
 *   > A profile is claimed ONLY when every requirement on its floor recorded
 *   > `executed-pass` in the RFC 0148 §A ledger of a real run, with at least one
 *   > assertion. `blocked`, `skipped`, `inapplicable`, `executed-fail`, a
 *   > missing row, and a pass that asserted nothing are all NOT-CLAIMED, and
 *   > each is reported with its reason.
 *
 * WHAT IS DELIBERATELY NOT REIMPLEMENTED HERE. The derivation itself is the
 * suite's (`lib/scenario-disposition.ts` `deriveRequirementDispositions`), the
 * shape audit is the suite's (`lib/certification-bundle-verify.ts`
 * `verifyBundleV2`), the floor sets are the suite's (`lib/profiles.ts`
 * `PROFILE_FLOOR_SCENARIOS`), and the alias rule is the suite's
 * (`DEPRECATED_PROFILE_ALIASES`). This file assembles and projects; it does not
 * decide what passes. A second opinion about a floor would be a second SSoT, and
 * this program has already paid for one of those.
 *
 * The two small helpers below (`scenarioStatesFromReport`, `claimedProfilesFor`)
 * ARE mirrored from the suite's `cli.ts`, because the package exports neither.
 * They are transcribed rather than reinterpreted, and
 * `test/conformance-claims.test.ts` pins the behaviour that matters (a file with
 * zero passing assertions is `skipped`, never `passed`). If the package ever
 * exports them, delete these.
 *
 * BUILD-TIME ONLY. `@openwop/openwop-conformance` is a devDependency and
 * `Dockerfile:85` runs `npm ci --omit=dev`, so nothing in this file can be
 * imported at runtime. That is not a limitation to work around, it is the
 * design: the claim is COMPUTED where the evidence is (the run), STAMPED into
 * the image (`build-meta/`), and merely SERVED at request time
 * (`src/host/conformanceClaims.ts`). A route that recomputed a claim would be
 * asserting something it cannot witness — the exact reason ADR 0550 P3 refused a
 * runtime signer.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readLedgerFile } from '@openwop/openwop-conformance/src/lib/requirement-ledger.js';
import {
  deriveRequirementDispositions,
  type Derivation,
} from '@openwop/openwop-conformance/src/lib/scenario-disposition.js';
import {
  verifyBundleV2,
  scrubEvidence,
  evidenceSecretsFromEnv,
} from '@openwop/openwop-conformance/src/lib/certification-bundle-verify.js';
import {
  deriveProfiles,
  isCoreStandard,
  agentPlatformStatus,
  DEPRECATED_PROFILE_ALIASES,
} from '@openwop/openwop-conformance/src/lib/profiles.js';

/** File names inside `build-meta/`. Read back by `src/host/conformanceClaims.ts`. */
export const BUNDLE_FILE = 'certification-bundle.json';
export const CLAIMS_FILE = 'conformance-claims.json';

/** The public path the discovery pointer resolves to (`routes/discovery.ts`). */
export const CERTIFICATION_BUNDLE_PATH = '/v1/host/openwop-app/conformance/certification-bundle';
export const CONFORMANCE_CLAIMS_PATH = '/v1/host/openwop-app/conformance/claims';

// ── the two transcribed helpers ────────────────────────────────────────────

/** The subset of vitest's JSON reporter output the derivation needs. */
export interface VitestJsonReport {
  readonly testResults?: ReadonlyArray<{
    readonly name?: string;
    readonly assertionResults?: ReadonlyArray<{ readonly status?: string }>;
  }>;
}

/**
 * Reduce a vitest JSON report to a per-scenario-file terminal state.
 *
 * The load-bearing clause is the LAST one: a file with zero passing assertions
 * is `skipped`, NEVER `passed`. That is RFC 0148's non-vacuity rule at the
 * report layer — vitest reports a file whose tests all early-returned as
 * passing, and taking it at its word is the original defect the whole RFC
 * exists to close.
 */
export function scenarioStatesFromReport(report: VitestJsonReport): Map<string, 'passed' | 'failed' | 'skipped'> {
  const states = new Map<string, 'passed' | 'failed' | 'skipped'>();
  for (const file of report.testResults ?? []) {
    const name = file.name;
    if (typeof name !== 'string') continue;
    const basename = name.split('/').pop() ?? name;
    let passes = 0;
    let failures = 0;
    for (const a of file.assertionResults ?? []) {
      if (a.status === 'passed') passes++;
      else if (a.status === 'failed') failures++;
      // `skipped` / `todo` / `pending` count toward neither.
    }
    states.set(basename, failures > 0 ? 'failed' : passes > 0 ? 'passed' : 'skipped');
  }
  return states;
}

/** Profiles DERIVABLE from a captured discovery document (RFC 0089 §B condition 1). */
export function claimedProfilesFor(document: Record<string, unknown>): string[] {
  // The suite's predicates take a loosely-typed discovery payload; the cast is
  // the same one `cli.ts` makes at this boundary.
  const doc = document as Parameters<typeof deriveProfiles>[0];
  const profiles: string[] = [...deriveProfiles(doc)];
  if (isCoreStandard(doc)) profiles.push('openwop-core-standard');
  if (agentPlatformStatus(doc) !== 'none') profiles.push('openwop-agent-platform');
  return profiles;
}

// ── RFC 0156 §E — the claims policy, as data ───────────────────────────────

/**
 * RFC 0156 §E's gated-claims table, transcribed. Each row names the evidence the
 * RFC requires and whether THIS HOST is in a position to witness it.
 *
 * The distinction `hostEvidenced` draws is the whole reason this is a table and
 * not a boolean. Exactly one of the seven claims is decidable from a
 * certification bundle: `OpenWOP conformant`, which §E binds to "RFC 0155
 * core-standard profile plus RFC 0148 bundle v2" — both of which a bundle
 * carries. The other six require evidence that lives outside any bundle this
 * host can produce (a real-peer interop result, partition/failover evidence, a
 * completed external audit, a Tier-3 host). Withholding those is not modesty and
 * not a TODO: a host cannot mint them, so a host asserting them would be
 * asserting something with no witness — which is the failure mode, not the
 * conservative alternative to it.
 *
 * `vendor-neutral industry standard` and `independently validated` are also
 * claims about the PROJECT rather than about this deployment. They could not
 * become permitted here even if the evidence existed.
 */
export interface ClaimPolicyRow {
  readonly claim: string;
  readonly requiredEvidence: string;
  /** Whether a certification bundle produced by this host can decide the claim. */
  readonly hostEvidenced: boolean;
  /** Why not, when `hostEvidenced` is false. */
  readonly why?: string;
}

export const RFC0156_CLAIMS: readonly ClaimPolicyRow[] = [
  {
    claim: 'OpenWOP conformant',
    requiredEvidence: 'RFC 0155 core-standard profile plus RFC 0148 bundle v2',
    hostEvidenced: true,
  },
  {
    claim: 'current A2A compatible',
    requiredEvidence: 'RFC 0152 A2A 1.0 real-peer result',
    hostEvidenced: false,
    why: 'a real-PEER result is evidence about an interoperating pair; the suite exercises this host against itself, so no bundle it produces can substantiate it',
  },
  {
    claim: 'current MCP compatible',
    requiredEvidence: 'RFC 0153 current-profile real-peer result',
    hostEvidenced: false,
    why: 'same as A2A — a real-peer result is not derivable from a self-directed suite run',
  },
  {
    claim: 'production multi-region',
    requiredEvidence: 'RFC 0150 fenced-effects partition/failover evidence',
    hostEvidenced: false,
    why: 'partition/failover evidence is produced by exercising a deployed multi-region topology, not by a conformance run',
  },
  {
    claim: 'independently validated',
    requiredEvidence: 'completed external audit and Tier-3 result',
    hostEvidenced: false,
    why: 'RFC 0156 §C/§D place both outside this host: the audit is an external firm\'s, and Tier-3 requires an organization unaffiliated with the steward. Self-issued evidence is what the claim excludes',
  },
  {
    claim: 'vendor-neutral industry standard',
    requiredEvidence: 'cross-org governance, completed audit, and Tier-3 result',
    hostEvidenced: false,
    why: 'a claim about the PROJECT, not about this deployment; RFC 0156 §A/§C/§D gate it on governance this host is not party to',
  },
  {
    claim: 'best-in-class durable orchestration',
    requiredEvidence: 'effect-safety plus RFC 0151 compensation production evidence',
    hostEvidenced: false,
    why: 'PRODUCTION evidence of compensation behaviour; a conformance run witnesses the surface, not its production record',
  },
] as const;

// ── the claims document ────────────────────────────────────────────────────

export interface NotClaimed {
  readonly profile: string;
  readonly reason: string;
  /** Floor requirement ids whose disposition is not a witnessed pass. */
  readonly blocking: readonly string[];
  /** Floor requirement ids with no ledger row at all (unclassified returns). */
  readonly unclassified: readonly string[];
}

export interface ConformanceClaims {
  readonly claimsVersion: '1';
  readonly generatedAt: string;
  readonly host: { readonly name: string; readonly version: string; readonly commit?: string };
  readonly suite: { readonly package: string; readonly version: string };
  readonly evidence: {
    readonly bundleVersion: '2';
    readonly bundlePath: string;
    readonly bundleSha256: string;
    readonly discoverySha256: string;
    readonly scenarioManifestSha256: string;
    readonly targetConfigurationSha256: string;
    readonly requireBehavior: boolean;
    readonly totals: Derivation['totals'];
  };
  /** RFC 0155 §A canonical ids ONLY. Every one is floor-proven from `executed-pass`. */
  readonly claimedProfiles: readonly string[];
  /** Deprecated aliases that also derive (`openwop-core`). Never a claim. */
  readonly aliases: readonly string[];
  /** Derivable from discovery but NOT floor-proven — with the reason. */
  readonly notClaimed: readonly NotClaimed[];
  /** Profiles this host does not advertise at all (`OPENWOP_OPTED_OUT_PROFILES`). */
  readonly optedOut: readonly string[];
  /** RFC 0156 §E claims this evidence permits. */
  readonly permittedClaims: readonly string[];
  /** RFC 0156 §E claims withheld, each with the reason. */
  readonly withheldClaims: readonly { readonly claim: string; readonly requiredEvidence: string; readonly why: string }[];
}

export interface BundleV2 {
  readonly bundleVersion: '2';
  readonly generatedAt: string;
  readonly generator: { name: string; version: string };
  readonly suite: { package: string; version: string };
  readonly host: { name: string; version: string; vendor?: string };
  readonly discovery: { url: string; sha256: string; document: Record<string, unknown> };
  readonly claimedProfiles: readonly string[];
  readonly aliases?: readonly string[];
  readonly results: { totals: Derivation['totals']; requirements: readonly Record<string, unknown>[] };
  readonly scenarioManifestSha256: string;
  readonly targetConfigurationSha256: string;
  /**
   * RFC 0158 §B — the host's recovery bound, published as the PER-CLASS
   * ARITHMETIC rather than a single total, so a reader can RECOMPUTE it rather
   * than take the number on trust (§"`bound-is-derived` evidence": "the
   * derivation ... not a single total ... is emitted into the host's RFC 0148
   * evidence bundle, where a reader can recompute it").
   *
   * Deliberately NOT a discovery field. §E.10 mints no capability for this and
   * chose bundle-first publication; ADR 0585 P2 originally said "declare the
   * bound on the wire", which would have minted wire surface the RFC declined.
   *
   * `terms` carries the inputs; `classes` the sums they produce. Both are
   * present because either alone defeats the purpose — the sums without the
   * inputs cannot be recomputed, and the inputs without the sums make every
   * reader redo arithmetic this host has already decided.
   */
  readonly recoveryBound?: {
    readonly terms: Record<string, number>;
    readonly classes: Record<string, number>;
  };
}

/**
 * Canonical JSON — sorted keys, no incidental whitespace. Used for the digests
 * the claims document binds the bundle with. A digest over
 * `JSON.stringify(obj)` would change with key insertion order, so a benign
 * re-serialization would read as tampering (the cry-wolf failure ADR 0550 P3's
 * canonicalization test exists to prevent).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Harness CONFIG whose name trips the suite's secret sweep but whose value is
 * not a credential. `evidenceSecretsFromEnv` treats every `OPENWOP_*` name
 * containing KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL as a secret and scrubs its
 * VALUE everywhere in the bundle, and a short numeric value is a substring of
 * almost any hex digest. MEASURED 2026-09-26: #4128 set
 * `OPENWOP_WEBHOOK_SECRET_ROTATION_OVERLAP_S=60`, the scrub rewrote the "60" inside
 * `discovery.sha256`, and every deploy's certify lane failed the vendored schema
 * (`^[0-9a-f]{64}$`), refusing to ship. List a name here only when its value
 * can never be a credential; the `certify scrub` test pins each one.
 */
export const NON_SECRET_CONFIG_ENV: readonly string[] = ['OPENWOP_WEBHOOK_SECRET_ROTATION_OVERLAP_S'];

/** The secrets the bundle is scrubbed of: the suite's env sweep, minus the
 *  values of `NON_SECRET_CONFIG_ENV`. */
export function certificationScrubSecrets(env: NodeJS.ProcessEnv, extra: readonly (string | undefined)[]): string[] {
  const except = NON_SECRET_CONFIG_ENV.map((k) => env[k]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return evidenceSecretsFromEnv(env, [...extra].filter((v): v is string => v !== undefined), except);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface AssembleInput {
  readonly document: Record<string, unknown>;
  readonly discoveryUrl: string;
  readonly states: ReadonlyMap<string, 'passed' | 'failed' | 'skipped'>;
  readonly ledger: Parameters<typeof deriveRequirementDispositions>[1];
  readonly suiteVersion: string;
  readonly hostName: string;
  readonly hostVersion: string;
  readonly requireBehavior: boolean;
  readonly optedOut: readonly string[];
  readonly commit?: string;
  readonly now?: string;
  /** Extra secrets to scrub beyond the environment sweep (the run's api key). */
  readonly secrets?: readonly string[];
  /**
   * RFC 0158 §B recovery bound, derived by `host/recoveryBound.ts`. Passed IN
   * rather than imported here so this module stays free of host internals — it
   * is the suite's assembler, and the caller (`conformance/run.ts`) is what
   * knows the host.
   */
  readonly recoveryBound?: BundleV2['recoveryBound'];
}

export interface Assembled {
  readonly bundle: BundleV2;
  readonly claims: ConformanceClaims;
  readonly derivation: Derivation;
  /** Bundle-wide shape rejections from the suite's own verifier. Non-empty ⇒ emitter defect. */
  readonly selfAudit: readonly { kind: string; detail: string }[];
  /**
   * JSON paths the RFC 0148 §E scrub rewrote.
   *
   * Surfaced rather than swallowed. Redaction is correct behaviour, but SILENT
   * redaction means a field vanished from published evidence with nobody
   * told — and the most likely cause is a secret leaking into a place it should
   * never have reached (a scenario `detail`, the captured discovery document),
   * which is a finding, not a routine event. The runner prints these.
   */
  readonly redactedAt: readonly string[];
}

/**
 * Assemble the v2 bundle AND its claims projection from one derivation.
 *
 * Pure apart from `evidenceSecretsFromEnv`'s environment sweep, so a test can
 * hand it a synthetic ledger and assert the claim set — which is the ONLY way to
 * prove the derivation is real. A test that runs the real suite would take
 * minutes and could never stage a `blocked` floor row on demand.
 */
export function assembleCertification(input: AssembleInput): Assembled {
  const discoverySha = sha256(canonicalJson(input.document));
  const derivable = claimedProfilesFor(input.document);
  const derivation = deriveRequirementDispositions(input.states, input.ledger, derivable, input.document);

  // RFC 0155 §E: canonical ids only in `claimedProfiles`; a deprecated alias
  // that also derives is reported in `aliases`, never as a claim.
  const aliases = derivable.filter((p) => p in DEPRECATED_PROFILE_ALIASES);
  const canonical = derivable.filter((p) => !(p in DEPRECATED_PROFILE_ALIASES));

  const verdictOf = new Map(derivation.verdicts.map((v) => [v.profile, v] as const));
  const claimed: string[] = [];
  const notClaimed: NotClaimed[] = [];
  for (const profile of canonical) {
    const v = verdictOf.get(profile);
    if (v === undefined) {
      // Should not happen (a verdict is produced per claimed profile), but an
      // absent verdict must never resolve to a claim — absence is evidence of
      // nothing, which is RFC 0148 §A's whole posture.
      notClaimed.push({ profile, reason: 'no verdict was derived for this profile', blocking: [], unclassified: [] });
      continue;
    }
    // `runtimeDerived` profiles (today `openwop-node-packs`) are HELD or not;
    // an unheld one is simply not this host's profile, not a failed claim.
    const proven = v.runtimeDerived ? v.held : v.certifiable && v.unclassified.length === 0;
    if (proven) {
      claimed.push(profile);
      continue;
    }
    notClaimed.push({
      profile,
      reason: v.runtimeDerived
        ? 'runtime-derived profile: not every floor requirement is a witnessed executed-pass, so this host does not hold it'
        : v.unclassified.length > 0
          ? 'a floor requirement returned unclassified (no ledger row, or a pass that asserted nothing) — RFC 0148 §A resolves that to blocked, never to a pass'
          : 'a floor requirement is not a witnessed executed-pass (blocked, skipped, inapplicable, or failed)',
      blocking: v.blocking,
      unclassified: v.unclassified,
    });
  }
  claimed.sort();
  notClaimed.sort((a, b) => (a.profile < b.profile ? -1 : 1));

  const scenarioIds = [...input.states.keys()].sort();
  const now = input.now ?? new Date().toISOString();
  const suiteVersion = input.suiteVersion;

  const requirements = derivation.requirements.map((r) => ({
    requirementId: r.requirementId,
    scenarioId: r.scenarioId,
    disposition: r.disposition,
    ...(r.detail === undefined ? {} : { detail: r.detail }),
    ...(r.assertionCount === undefined ? {} : { assertionCount: r.assertionCount }),
  }));

  const draft: BundleV2 = {
    bundleVersion: '2',
    generatedAt: now,
    generator: { name: 'openwop-app conformance/run.ts --certify', version: suiteVersion },
    suite: { package: '@openwop/openwop-conformance', version: suiteVersion },
    host: { name: input.hostName, version: input.hostVersion },
    discovery: { url: input.discoveryUrl, sha256: discoverySha, document: input.document },
    claimedProfiles: claimed,
    ...(aliases.length > 0 ? { aliases } : {}),
    results: { totals: derivation.totals, requirements },
    scenarioManifestSha256: sha256(scenarioIds.join('\n')),
    // RFC 0147 §A.4 configuration identity: WHAT was measured and under which
    // strictness. Two runs of one suite against differently-configured hosts are
    // different evidence, and without this a bundle cannot say so.
    targetConfigurationSha256: sha256(
      `${input.discoveryUrl}\n${discoverySha}\n${input.requireBehavior ? 'true' : ''}\n${[...input.optedOut].sort().join(',')}`,
    ),
    // RFC 0158 §B / ADR 0585 P2. Taken from the live module, never restated: a
    // second literal here would be the H97 defect (two numbers that agree by
    // luck while comments assert they must agree).
    ...(input.recoveryBound === undefined ? {} : { recoveryBound: input.recoveryBound }),
  };

  // RFC 0148 §E: bundles MUST NOT contain credentials. The captured discovery
  // document and every `detail` string pass through here, and this is the last
  // place that can guarantee it.
  const scrubbed = scrubEvidence(draft, certificationScrubSecrets(process.env, [...(input.secrets ?? [])]));
  const bundle = scrubbed.value as BundleV2;

  // Self-audit with the CONSUMER verifier. A bundle-wide rejection (duplicate
  // rows, totals disagreeing with rows, an unknown disposition, a canary) is an
  // emitter defect, not an evidence state, and the caller must refuse to write.
  const selfAudit = verifyBundleV2(bundle as never).rejections.map((r) => ({ kind: String(r.kind), detail: r.detail }));

  // RFC 0156 §E. The one host-evidenced claim is decided by the evidence; the
  // rest are withheld with the reason the RFC gives.
  const coreStandardProven = claimed.includes('openwop-core-standard');
  const permittedClaims: string[] = [];
  const withheldClaims: { claim: string; requiredEvidence: string; why: string }[] = [];
  for (const row of RFC0156_CLAIMS) {
    if (!row.hostEvidenced) {
      withheldClaims.push({ claim: row.claim, requiredEvidence: row.requiredEvidence, why: row.why ?? '' });
      continue;
    }
    if (coreStandardProven) permittedClaims.push(row.claim);
    else
      withheldClaims.push({
        claim: row.claim,
        requiredEvidence: row.requiredEvidence,
        why: 'openwop-core-standard is not floor-proven in this evidence — RFC 0155 §A reserves an unqualified "OpenWOP conformant" statement for that profile',
      });
  }

  const claims: ConformanceClaims = {
    claimsVersion: '1',
    generatedAt: now,
    host: { name: input.hostName, version: input.hostVersion, ...(input.commit ? { commit: input.commit } : {}) },
    suite: { package: '@openwop/openwop-conformance', version: suiteVersion },
    evidence: {
      bundleVersion: '2',
      bundlePath: CERTIFICATION_BUNDLE_PATH,
      bundleSha256: sha256(canonicalJson(bundle)),
      discoverySha256: bundle.discovery.sha256,
      scenarioManifestSha256: bundle.scenarioManifestSha256,
      targetConfigurationSha256: bundle.targetConfigurationSha256,
      requireBehavior: input.requireBehavior,
      totals: derivation.totals,
    },
    claimedProfiles: claimed,
    aliases,
    notClaimed,
    optedOut: [...input.optedOut].sort(),
    permittedClaims,
    withheldClaims,
  };

  return { bundle, claims, derivation, selfAudit, redactedAt: scrubbed.redactedAt };
}

/**
 * Re-derive the claims document from a bundle ALONE.
 *
 * This is the parity oracle, and it is why hand-editing the claims file cannot
 * survive. `test/conformance-claims.test.ts` re-runs it against the shipped
 * bundle and compares: a profile added to `conformance-claims.json` by hand is
 * not in the bundle's `claimedProfiles`, so the comparison goes red. The claim
 * can therefore never be more than the evidence, no matter who edits the file.
 *
 * `scripts/check-wire-claims.mjs` enforces the SAME invariant one hop further
 * out but does NOT call this — it is plain ESM and cannot import a TS module
 * from a devDependency-typed graph. It compares the DEPLOYED claims document
 * against the stamped artifact instead, which catches the staleness this
 * function cannot see (a host serving yesterday's evidence). Two checks, two
 * vantage points; neither substitutes for the other, and saying so here matters
 * because an earlier draft of this comment claimed the checker called this
 * function, which it never did.
 */
export function claimsFromBundle(bundle: BundleV2, prior: ConformanceClaims): ConformanceClaims {
  return {
    ...prior,
    claimedProfiles: [...bundle.claimedProfiles].sort(),
    aliases: [...(bundle.aliases ?? [])].sort(),
    evidence: {
      ...prior.evidence,
      bundleSha256: sha256(canonicalJson(bundle)),
      discoverySha256: bundle.discovery.sha256,
      scenarioManifestSha256: bundle.scenarioManifestSha256,
      targetConfigurationSha256: bundle.targetConfigurationSha256,
      totals: bundle.results.totals,
    },
  };
}

/** Validate a bundle against the VENDORED v2 schema (repo `schemas/`). */
export async function validateAgainstVendoredSchema(
  bundle: unknown,
  repoRoot: string,
): Promise<{ ok: true } | { ok: false; errors: string }> {
  const schemaPath = join(repoRoot, 'schemas', 'certification-bundle-v2.schema.json');
  if (!existsSync(schemaPath)) {
    return { ok: false, errors: `vendored schema missing at ${schemaPath} — vendor it from the corpus before certifying` };
  }
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const { default: addFormats } = await import('ajv-formats');
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>);
  if (validate(bundle)) return { ok: true };
  return { ok: false, errors: JSON.stringify(validate.errors, null, 2) };
}

/** Write both artifacts into `build-meta/`, canonical-JSON ordered. */
export function writeCertification(outDir: string, assembled: Assembled): { bundlePath: string; claimsPath: string } {
  mkdirSync(outDir, { recursive: true });
  const bundlePath = join(outDir, BUNDLE_FILE);
  const claimsPath = join(outDir, CLAIMS_FILE);
  // Canonical bytes, because `evidence.bundleSha256` is computed over exactly
  // this serialization. Writing pretty-printed JSON and digesting a canonical
  // form would give a consumer two documents that hash differently and no way to
  // tell which one the claim binds.
  writeFileSync(bundlePath, `${canonicalJson(assembled.bundle)}\n`, 'utf8');
  writeFileSync(claimsPath, `${canonicalJson(assembled.claims)}\n`, 'utf8');
  return { bundlePath, claimsPath };
}

export { readLedgerFile };
