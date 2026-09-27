/**
 * ADR 0550 P4 — can a claim outrun its evidence?
 *
 * Every assertion here is an attempt to make this host claim something it did
 * not prove. If any of them succeeds, the public claims surface is a liability
 * rather than an assurance, because a reader has no way to tell a derived claim
 * from an asserted one by looking at the document.
 *
 * The cases are staged from a SYNTHETIC ledger rather than a real suite run, on
 * purpose. A real run takes minutes, cannot be made to produce a `blocked` floor
 * row on demand, and — worse — would pass whether or not the derivation is
 * wired, because the interesting states never occur in a healthy run. Staging
 * the ledger is the only way to witness the not-claimed paths at all.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  assembleCertification,
  canonicalJson,
  claimsFromBundle,
  claimedProfilesFor,
  scenarioStatesFromReport,
  sha256,
  validateAgainstVendoredSchema,
  writeCertification,
  RFC0156_CLAIMS,
  type AssembleInput,
} from '../conformance/certify.js';
import { PROFILE_FLOOR_SCENARIOS } from '@openwop/openwop-conformance/src/lib/profiles.js';
// The requirement-id scheme is the SUITE's, not ours. Deriving the ids here with
// a local string transform is how a staged ledger silently stops matching the
// rows the derivation looks up — every negative case would then pass because
// NOTHING matched, which is indistinguishable from the guard working.
import { requirementIdForFile } from '@openwop/openwop-conformance/src/lib/scenario-disposition.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/**
 * A discovery document that derives `openwop-discovery-core` (plus its
 * deprecated alias `openwop-core`) and `openwop-core-standard`.
 *
 * Built by ASKING the suite's own predicates rather than by guessing: the fields
 * below were tuned until `claimedProfilesFor` returned core-standard, and the
 * first test asserts exactly that. A fixture that silently stopped deriving
 * core-standard would make every "not claimed" assertion below pass for the
 * wrong reason — the vacuity mode this whole ADR is about, one level down in a
 * test file.
 */
function discoveryFixture(): Record<string, unknown> {
  return {
    // `isCore`: an RFC 0149 §C `<major>.<minor>` version with major 1, a string
    // `supportedEnvelopes`, an object `schemaVersions`, and three non-negative
    // integer `limits`.
    protocolVersion: '1.0',
    supportedEnvelopes: ['clarification.request', 'clarification.response'],
    schemaVersions: { 'ai-envelope': '1.0' },
    limits: { clarificationRounds: 3, schemaRounds: 2, envelopesPerTurn: 4 },
    // `isStreamSse` / `isStreamPoll`: `rest` among the advertised transports.
    // `isCoreStandard` = isCore && isInterrupts && (sse || poll).
    supportedTransports: ['rest'],
    implementation: { name: 'openwop-workflow-engine', version: '0.1.0' },
  };
}

/** The floor requirement ids of `openwop-core-standard`, as the suite defines them. */
function coreStandardFloorFiles(): readonly string[] {
  const floor = PROFILE_FLOOR_SCENARIOS['openwop-core-standard'];
  if (floor === undefined) throw new Error('the suite defines no openwop-core-standard floor — the premise of this test moved');
  return floor.required;
}

type Ledger = AssembleInput['ledger'];

/** Build the inputs for a run in which every named file passed with real assertions. */
function inputsFor(
  files: readonly string[],
  overrides: { ledger?: Ledger; states?: Map<string, 'passed' | 'failed' | 'skipped'> } = {},
): AssembleInput {
  const states = overrides.states ?? new Map(files.map((f) => [f, 'passed' as const]));
  const ledger: Ledger =
    overrides.ledger ??
    files.map((f) => ({ requirementId: requirementIdForFile(f), disposition: 'executed-pass' as const, assertionCount: 3 }));
  return {
    document: discoveryFixture(),
    discoveryUrl: 'http://127.0.0.1:18080/.well-known/openwop',
    states,
    ledger,
    suiteVersion: '1.135.2',
    hostName: 'openwop-workflow-engine',
    hostVersion: '0.1.0',
    requireBehavior: true,
    optedOut: ['openwop-production'],
    now: '2026-08-17T00:00:00.000Z',
  };
}

/** Every scenario file the floors reference, so prefix requirements resolve too. */
function allFloorFiles(): string[] {
  const files = new Set<string>(coreStandardFloorFiles());
  // `requiredAnyPrefix: ['interrupt-']` is satisfied by ANY passing match.
  files.add('interrupt-basic.test.ts');
  return [...files];
}

describe('ADR 0550 P4 — the fixture derives what the tests assume', () => {
  it('the discovery fixture derives openwop-core-standard and the deprecated alias', () => {
    const derivable = claimedProfilesFor(discoveryFixture());
    expect(derivable).toContain('openwop-core-standard');
    expect(derivable).toContain('openwop-discovery-core');
    // RFC 0155 §A: the alias derives exactly when the canonical name does.
    expect(derivable).toContain('openwop-core');
  });
});

describe('ADR 0550 P4 — a claim is derived from executed-pass rows, never asserted', () => {
  it('claims core-standard when every floor requirement is a witnessed executed-pass', () => {
    const { claims, bundle } = assembleCertification(inputsFor(allFloorFiles()));
    expect(claims.claimedProfiles).toContain('openwop-core-standard');
    expect(bundle.claimedProfiles).toContain('openwop-core-standard');
    // RFC 0155 §E: canonical ids only in claimedProfiles; the alias is separate.
    expect(claims.claimedProfiles).not.toContain('openwop-core');
    expect(claims.aliases).toContain('openwop-core');
  });

  it('a BLOCKED floor row drops the profile — and says which requirement blocked it', () => {
    const files = allFloorFiles();
    const victim = coreStandardFloorFiles()[0]!;
    const base = inputsFor(files);
    const ledger: Ledger = base.ledger.map((e) =>
      e.requirementId === requirementIdForFile(victim)
        ? { requirementId: e.requirementId, disposition: 'blocked' as const, detail: 'the seam was unavailable' }
        : e,
    );
    const { claims } = assembleCertification({ ...base, ledger });

    expect(claims.claimedProfiles).not.toContain('openwop-core-standard');
    const row = claims.notClaimed.find((n) => n.profile === 'openwop-core-standard');
    expect(row).toBeDefined();
    expect(row!.blocking).toContain(requirementIdForFile(victim));
    // RFC 0156 §E: with core-standard unproven, the one host-evidenced claim is
    // withheld rather than merely absent — a reader must see the reason.
    expect(claims.permittedClaims).toEqual([]);
    expect(claims.withheldClaims.map((w) => w.claim)).toContain('OpenWOP conformant');
  });

  it('an executed-pass that asserted NOTHING is unclassified, not a pass', () => {
    const files = allFloorFiles();
    const victim = coreStandardFloorFiles()[1]!;
    const base = inputsFor(files);
    const ledger: Ledger = base.ledger.map((e) =>
      e.requirementId === requirementIdForFile(victim)
        ? { requirementId: e.requirementId, disposition: 'executed-pass' as const, assertionCount: 0 }
        : e,
    );
    const { claims } = assembleCertification({ ...base, ledger });
    expect(claims.claimedProfiles).not.toContain('openwop-core-standard');
    const row = claims.notClaimed.find((n) => n.profile === 'openwop-core-standard');
    expect(row!.unclassified.length).toBeGreaterThan(0);
  });

  it('a floor requirement with NO ledger row at all cannot become a claim', () => {
    const files = allFloorFiles();
    const victim = coreStandardFloorFiles()[2]!;
    const base = inputsFor(files);
    // Drop the row entirely — silence. RFC 0148 §A: absence resolves to blocked.
    const ledger: Ledger = base.ledger.filter((e) => e.requirementId !== requirementIdForFile(victim));
    const { claims } = assembleCertification({ ...base, ledger });
    expect(claims.claimedProfiles).not.toContain('openwop-core-standard');
  });

  it('a run with NO ledger at all claims nothing — silence is never evidence', () => {
    const base = inputsFor(allFloorFiles());
    const { claims } = assembleCertification({ ...base, ledger: [] });
    expect(claims.claimedProfiles).not.toContain('openwop-core-standard');
    expect(claims.permittedClaims).toEqual([]);
  });
});

describe('ADR 0550 P4 — the report layer cannot smuggle a vacuous pass through', () => {
  it('a file whose assertions all skipped is `skipped`, never `passed`', () => {
    const states = scenarioStatesFromReport({
      testResults: [
        { name: '/x/src/scenarios/runs-lifecycle.test.ts', assertionResults: [{ status: 'skipped' }, { status: 'pending' }] },
        { name: '/x/src/scenarios/discovery.test.ts', assertionResults: [{ status: 'passed' }] },
        { name: '/x/src/scenarios/auth.test.ts', assertionResults: [{ status: 'passed' }, { status: 'failed' }] },
      ],
    });
    expect(states.get('runs-lifecycle.test.ts')).toBe('skipped');
    expect(states.get('discovery.test.ts')).toBe('passed');
    expect(states.get('auth.test.ts')).toBe('failed');
  });
});

describe('ADR 0550 P4 — RFC 0156 §E claims policy', () => {
  it('withholds every claim whose evidence a host cannot mint, with a reason', () => {
    const { claims } = assembleCertification(inputsFor(allFloorFiles()));
    // Core-standard IS proven in this fixture, so the one host-evidenced claim
    // is permitted — which is what makes the withholding of the rest meaningful
    // rather than a blanket refusal that would pass trivially.
    expect(claims.permittedClaims).toEqual(['OpenWOP conformant']);
    const externally = RFC0156_CLAIMS.filter((c) => !c.hostEvidenced).map((c) => c.claim);
    expect(externally.length).toBe(6);
    for (const claim of externally) {
      const row = claims.withheldClaims.find((w) => w.claim === claim);
      expect(row, `${claim} must be reported as withheld`).toBeDefined();
      expect(row!.why.length, `${claim} must say WHY`).toBeGreaterThan(20);
      expect(row!.requiredEvidence.length).toBeGreaterThan(0);
    }
    // Every §E row is accounted for exactly once, so a new gated claim cannot be
    // added upstream and silently go unmentioned here.
    expect([...claims.permittedClaims, ...claims.withheldClaims.map((w) => w.claim)].sort()).toEqual(
      RFC0156_CLAIMS.map((c) => c.claim).sort(),
    );
  });
});

describe('ADR 0550 P4 — the emitted bundle validates against the VENDORED schema', () => {
  it('passes ajv against schemas/certification-bundle-v2.schema.json', async () => {
    const { bundle, selfAudit } = assembleCertification(inputsFor(allFloorFiles()));
    // The suite's own consumer verifier first: a bundle-wide rejection is an
    // emitter defect and the runner refuses to write.
    expect(selfAudit).toEqual([]);
    const result = await validateAgainstVendoredSchema(bundle, REPO_ROOT);
    expect(result.ok, result.ok ? '' : (result as { errors: string }).errors).toBe(true);
  });

  it('REJECTS a bundle whose claimedProfiles were hand-edited to an unknown shape', async () => {
    const { bundle } = assembleCertification(inputsFor(allFloorFiles()));
    // The schema pins `^openwop-[a-z0-9-]+$` on every claimed id. A marketing
    // string smuggled into the list is refused by the artifact contract itself,
    // before any host-side logic gets a say.
    const tampered = { ...bundle, claimedProfiles: ['Fully OpenWOP Certified'] };
    const result = await validateAgainstVendoredSchema(tampered, REPO_ROOT);
    expect(result.ok).toBe(false);
  });
});

describe('ADR 0550 P4 — SABOTAGE: a hand-added profile does not survive', () => {
  it('re-deriving the claims from the bundle contradicts an edited claims file', () => {
    const assembled = assembleCertification(inputsFor(allFloorFiles()));
    const dir = mkdtempSync(join(tmpdir(), 'owp-claims-'));
    try {
      writeCertification(dir, assembled);
      const claimsPath = join(dir, 'conformance-claims.json');

      // The sabotage: an operator edits the published claims to add a profile
      // the run never proved. This is the single most likely way a false claim
      // ships, because the file is JSON sitting in a build directory.
      const doctored = JSON.parse(readFileSync(claimsPath, 'utf8')) as { claimedProfiles: string[] };
      doctored.claimedProfiles = [...doctored.claimedProfiles, 'openwop-replay-fork'];
      writeFileSync(claimsPath, canonicalJson(doctored));

      const bundle = JSON.parse(readFileSync(join(dir, 'certification-bundle.json'), 'utf8')) as typeof assembled.bundle;
      const rederived = claimsFromBundle(bundle, doctored as never);

      // The parity oracle: the claim must equal what the evidence carries.
      expect(rederived.claimedProfiles).not.toEqual(doctored.claimedProfiles);
      expect(rederived.claimedProfiles).not.toContain('openwop-replay-fork');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the written artifacts round-trip: the claims bind the bundle by digest', () => {
    const assembled = assembleCertification(inputsFor(allFloorFiles()));
    const dir = mkdtempSync(join(tmpdir(), 'owp-claims-'));
    try {
      writeCertification(dir, assembled);
      const bundle = JSON.parse(readFileSync(join(dir, 'certification-bundle.json'), 'utf8')) as unknown;
      const claims = JSON.parse(readFileSync(join(dir, 'conformance-claims.json'), 'utf8')) as {
        evidence: { bundleSha256: string };
      };
      expect(claims.evidence.bundleSha256).toBe(sha256(canonicalJson(bundle)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ADR 0550 P4 — certify mode keeps its three refusals', () => {
  /**
   * A source-shape guard, in the `test/ci-gate-coverage.test.ts` idiom, and for
   * the same reason: these three are RUNTIME behaviours of a ~15-minute run, so
   * nothing else in the suite can witness them. Losing any one of them produces
   * a certification that still looks fine — a manifest digest describing a suite
   * that did not run, a permissive run's soft-skips read as evidence, or the
   * ledger's verdict replaced by a test-runner exit code. Each is silent.
   *
   * This guards the SHAPE, not the behaviour; the run record in ADR 0550 P4 is
   * the behavioural witness. Stating that limit is the point — a shape guard
   * sold as a behaviour guard is its own vacuity.
   */
  const runSrc = readFileSync(join(import.meta.dirname, '..', 'conformance', 'run.ts'), 'utf8');

  it('forces the quarantine OFF (a manifest digest must describe the suite that ran)', () => {
    expect(runSrc).toMatch(/certifyOutDir !== undefined && process\.env\.OPENWOP_CONFORMANCE_NO_QUARANTINE !== '1'/);
    expect(runSrc).toMatch(/OPENWOP_CONFORMANCE_NO_QUARANTINE = '1'/);
  });

  it('sets OPENWOP_REQUIRE_BEHAVIOR=true (RFC 0148 §B strict mode)', () => {
    expect(runSrc).toMatch(/OPENWOP_REQUIRE_BEHAVIOR: 'true'/);
  });

  it('sinks the RFC 0148 §A ledger and a JSON report, or it derives from nothing', () => {
    expect(runSrc).toMatch(/OPENWOP_LEDGER_PATH: certifyLedger/);
    expect(runSrc).toMatch(/--reporter=json/);
  });
});

describe('ADR 0550 P4 — the runtime reader publishes only what was stamped', () => {
  it('omits everything when no stamp exists, and serves the stamp when it does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-buildmeta-'));
    const prior = process.env.OPENWOP_BUILD_META_DIR;
    try {
      process.env.OPENWOP_BUILD_META_DIR = dir;
      const mod = await import('../src/host/conformanceClaims.js');

      expect(mod.conformanceClaims()).toBeUndefined();
      expect(mod.servedBundle(1)).toBeUndefined();
      // The pointer is gated on the BUNDLE, so an unstamped image advertises none.
      expect(mod.certificationBundleUrl('https://example.test')).toBeUndefined();

      const assembled = assembleCertification(inputsFor(allFloorFiles()));
      mkdirSync(dir, { recursive: true });
      writeCertification(dir, assembled);

      expect(mod.conformanceClaims()?.claimedProfiles).toEqual(assembled.claims.claimedProfiles);
      // WHD-18: `certificationBundle()` became the unexported image reader behind
      // `servedBundle(1)`, the one mode-aware predicate every surface goes through.
      const served = mod.servedBundle(1);
      expect(served?.source === 'image' ? served.doc['bundleVersion'] : undefined).toBe('2');
      expect(mod.certificationBundleUrl('https://example.test/')).toBe(
        'https://example.test/v1/host/openwop-app/conformance/certification-bundle',
      );

      // A v1 bundle cannot express dispositions, so serving it through a pointer
      // that promises v2 evidence would be a claim the artifact cannot support.
      writeFileSync(join(dir, 'certification-bundle.json'), JSON.stringify({ bundleVersion: '1' }));
      expect(mod.servedBundle(1)).toBeUndefined();
      expect(mod.certificationBundleUrl('https://example.test')).toBeUndefined();

      // A claims document missing its structural fields is not "claims nothing";
      // it is not a claims document, and must not be served as one.
      writeFileSync(join(dir, 'conformance-claims.json'), JSON.stringify({ hello: 'world' }));
      expect(mod.conformanceClaims()).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.OPENWOP_BUILD_META_DIR;
      else process.env.OPENWOP_BUILD_META_DIR = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
