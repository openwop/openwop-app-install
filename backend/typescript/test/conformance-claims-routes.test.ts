/**
 * ADR 0550 P4 — the ADVERT and the ROUTE cannot disagree.
 *
 * The container lane already caught this exact defect once, on a different
 * capability: the release image advertised
 * `workflowChainPacks.hostExpansionSeam` and then 404'd it, because the seam's
 * dependency was a devDependency stripped by `npm ci --omit=dev`. The
 * advertisement leg PASSED throughout — it gated on the flag and then asserted
 * the flag.
 *
 * The claims pointer is structurally the same risk, and worse in consequence: it
 * points a third party at evidence. So this boots a real host and probes BOTH
 * postures over HTTP.
 *
 *  - UNSTAMPED (a source checkout, and every image built without the certify
 *    step): no pointer, and both reads 404. Absence is legitimate per RFC 0089
 *    §D — "clients MUST tolerate its absence" — and an unstamped host must not
 *    invent a claim.
 *  - STAMPED: the pointer appears, resolves to the bundle it names, and the
 *    claims document served is byte-for-byte what was stamped.
 *
 * Both legs are needed. A test that only asserted the stamped case would pass
 * against a host that ALWAYS advertises, which is the dishonest posture; a test
 * that only asserted the unstamped case would pass against a host that NEVER
 * does, which is the inert one.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/index.js';
import { PUBLIC_PATH_PREFIXES } from '../src/middleware/auth.js';
import {
  CERTIFICATION_BUNDLE_PATH,
  CONFORMANCE_CLAIMS_PATH,
} from '../src/host/conformanceClaims.js';
import { assembleCertification, canonicalJson, sha256, writeCertification } from '../conformance/certify.js';
import { requirementIdForFile } from '@openwop/openwop-conformance/src/lib/scenario-disposition.js';
import { PROFILE_FLOOR_SCENARIOS } from '@openwop/openwop-conformance/src/lib/profiles.js';

let base: string;
let server: http.Server;
let stampDir: string;

/** A run in which core-standard's whole floor is a witnessed pass. */
function stampArtifacts(dir: string): ReturnType<typeof assembleCertification> {
  const floor = PROFILE_FLOOR_SCENARIOS['openwop-core-standard'];
  if (floor === undefined) throw new Error('the suite defines no openwop-core-standard floor');
  const files = [...floor.required, 'interrupt-basic.test.ts'];
  const assembled = assembleCertification({
    document: {
      protocolVersion: '1.0',
      supportedEnvelopes: ['clarification.request'],
      schemaVersions: { 'ai-envelope': '1.0' },
      limits: { clarificationRounds: 3, schemaRounds: 2, envelopesPerTurn: 4 },
      supportedTransports: ['rest'],
    },
    discoveryUrl: 'http://127.0.0.1:1/.well-known/openwop',
    states: new Map(files.map((f) => [f, 'passed' as const])),
    ledger: files.map((f) => ({ requirementId: requirementIdForFile(f), disposition: 'executed-pass' as const, assertionCount: 2 })),
    suiteVersion: '1.135.2',
    hostName: 'openwop-workflow-engine',
    hostVersion: '0.1.0',
    requireBehavior: true,
    optedOut: ['openwop-production'],
    now: '2026-08-17T00:00:00.000Z',
  });
  writeCertification(dir, assembled);
  return assembled;
}

beforeAll(async () => {
  stampDir = mkdtempSync(join(tmpdir(), 'owp-p4-routes-'));
  // Start UNSTAMPED: the directory exists but holds nothing, which is exactly
  // what `build-meta/` looks like in a checkout that never certified.
  process.env.OPENWOP_BUILD_META_DIR = stampDir;
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<http.Server>((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_BUILD_META_DIR;
  rmSync(stampDir, { recursive: true, force: true });
});

const discovery = async (): Promise<Record<string, never>> =>
  (await (await fetch(`${base}/.well-known/openwop`)).json()) as Record<string, never>;

const pointer = (doc: Record<string, never>): unknown =>
  ((doc as { capabilities?: { conformance?: { certificationBundleUrl?: unknown } } }).capabilities ?? doc as never)
    .conformance?.certificationBundleUrl;

describe('ADR 0550 P4 — an UNSTAMPED build claims nothing, and says so with a 404', () => {
  it('omits capabilities.conformance.certificationBundleUrl', async () => {
    expect(pointer(await discovery())).toBeUndefined();
  });

  it('404s both public reads', async () => {
    expect((await fetch(`${base}${CERTIFICATION_BUNDLE_PATH}`)).status).toBe(404);
    expect((await fetch(`${base}${CONFORMANCE_CLAIMS_PATH}`)).status).toBe(404);
  });
});

describe('ADR 0550 P4 — a STAMPED build advertises and serves exactly what it stamped', () => {
  it('advertises a pointer that resolves to the stamped bundle', async () => {
    const assembled = stampArtifacts(stampDir);

    const url = pointer(await discovery());
    expect(typeof url).toBe('string');
    expect(String(url).endsWith(CERTIFICATION_BUNDLE_PATH)).toBe(true);

    // Follow the ADVERTISED url, not a hand-built one: that is the difference
    // between "the pointer field is populated" and "the pointer resolves".
    const res = await fetch(String(url).replace(/^https?:\/\/[^/]+/, base));
    expect(res.status).toBe(200);
    const served = (await res.json()) as { bundleVersion: string; claimedProfiles: string[] };
    expect(served.bundleVersion).toBe('2');
    expect(served.claimedProfiles).toEqual(assembled.bundle.claimedProfiles);
    expect(served.claimedProfiles).toContain('openwop-core-standard');

    // WHD-6 — "200 with THAT bundle", not "200 with a bundle-shaped object". The
    // three field checks above pass against any v2 document that happens to
    // claim core-standard. The claims document binds the evidence by digest
    // (`evidence.bundleSha256`, over the canonical serialization), so the served
    // body must hash to it: that is the check a third party actually runs.
    expect(sha256(canonicalJson(served))).toBe(assembled.claims.evidence.bundleSha256);
    expect(served).toEqual(JSON.parse(canonicalJson(assembled.bundle)));
  });

  it('serves the claims document unchanged from the stamp', async () => {
    const stamped = JSON.parse(readFileSync(join(stampDir, 'conformance-claims.json'), 'utf8')) as Record<string, unknown>;
    const res = await fetch(`${base}${CONFORMANCE_CLAIMS_PATH}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(stamped);
  });

  it('both reads are PUBLIC — a claim behind a credential is not a public claim', async () => {
    // The prefix, not the two full paths: `isPublicPath` matches on prefix, and
    // asserting the prefix is what keeps a later sibling route from silently
    // inheriting or losing the bypass.
    expect(PUBLIC_PATH_PREFIXES).toContain('/v1/host/openwop-app/conformance');
    // Probed with NO Authorization header at all — the assertions above already
    // did this, but stating it as its own case means a regression that re-walls
    // the routes names itself rather than surfacing as an unrelated 401.
    for (const p of [CERTIFICATION_BUNDLE_PATH, CONFORMANCE_CLAIMS_PATH]) {
      expect((await fetch(`${base}${p}`)).status, p).not.toBe(401);
    }
  });
});

/**
 * WHD-6 — every surface that NAMES the bundle URL is gated on the URL SERVING.
 *
 * The bundle URL is advertised from two places, not one: discovery's
 * `conformance.certificationBundleUrl`, and the claims document's
 * `evidence.bundlePath` (+ `bundleSha256`). Before WHD-6 only the first was
 * gated on `certificationBundle()`; `/claims` looked at its own file alone, so an
 * image carrying a claims stamp beside a missing or unservable bundle published
 * "the proof is at that URL" over a URL that 404'd.
 *
 * The unservable case is staged with a `bundleVersion: '3'` document on purpose.
 * That is not an exotic fixture — it is the suite CLI's own output, i.e. exactly
 * what ADR 0735 tells an operator to cut and what a hand-rolled "ship the
 * post-deploy bundle in the next image" would drop into `build-meta/`. This
 * reader serves v2 only, so the file EXISTS and the route still 404s: a test
 * that staged only "file absent" would pass against a gate written as
 * `existsSync(bundlePath)`, which is the wrong predicate.
 *
 * Runs LAST and restores the stamp, because the legs above share `stampDir`.
 */
describe('WHD-6 — nothing names the bundle URL unless the URL serves a bundle', () => {
  const bundleFile = (): string => join(stampDir, 'certification-bundle.json');

  async function expectNothingNamesTheUrl(posture: string): Promise<void> {
    expect((await fetch(`${base}${CERTIFICATION_BUNDLE_PATH}`)).status, `${posture}: the route itself`).toBe(404);
    expect(pointer(await discovery()), `${posture}: discovery still advertises a URL that 404s`).toBeUndefined();
    const claims = await fetch(`${base}${CONFORMANCE_CLAIMS_PATH}`);
    expect(claims.status, `${posture}: /claims still publishes evidence.bundlePath over a 404`).toBe(404);
  }

  it('PRECONDITION: the stamp from the legs above is live, so the postures below are a CHANGE', async () => {
    // Without this the three 404s below would also be satisfied by a test file
    // reordered so that nothing was ever stamped — green for the wrong reason.
    expect(typeof pointer(await discovery())).toBe('string');
    expect((await fetch(`${base}${CERTIFICATION_BUNDLE_PATH}`)).status).toBe(200);
    expect((await fetch(`${base}${CONFORMANCE_CLAIMS_PATH}`)).status).toBe(200);
  });

  it('a bundle the reader will not serve (the CLI\'s bundleVersion 3) withdraws the pointer AND the claims', async () => {
    const original = readFileSync(bundleFile(), 'utf8');
    try {
      writeFileSync(bundleFile(), JSON.stringify({ ...(JSON.parse(original) as Record<string, unknown>), bundleVersion: '3' }));
      await expectNothingNamesTheUrl('bundleVersion 3 on disk');
    } finally {
      writeFileSync(bundleFile(), original);
    }
  });

  it('a claims stamp with NO bundle beside it is withheld, not served unsubstantiated', async () => {
    const original = readFileSync(bundleFile(), 'utf8');
    try {
      rmSync(bundleFile());
      // The claims file is untouched and perfectly valid — that is the point.
      expect(JSON.parse(readFileSync(join(stampDir, 'conformance-claims.json'), 'utf8'))).toHaveProperty('claimsVersion');
      await expectNothingNamesTheUrl('claims stamp present, bundle absent');
    } finally {
      writeFileSync(bundleFile(), original);
    }
  });

  it('restoring the bundle restores all three — the gate is the bundle, not a latch', async () => {
    expect(typeof pointer(await discovery())).toBe('string');
    expect((await fetch(`${base}${CERTIFICATION_BUNDLE_PATH}`)).status).toBe(200);
    expect((await fetch(`${base}${CONFORMANCE_CLAIMS_PATH}`)).status).toBe(200);
  });

  it('the MAJOR-2 root never carries the pointer while the only servable bundle is v2-shaped', async () => {
    // `schemas/v2/capabilities.schema.json` has the `certificationBundleUrl`
    // slot, so this omission is a decision, not a missing field: at major 2 the
    // slot addresses `schemas/v2/certification-bundle.schema.json`, which pins
    // `bundleVersion: "3"`, and this reader serves `'2'` only. Pointing the v2
    // root at the in-process v2 document would advertise evidence that does not
    // validate as what the pointer promises (ADR 0735: the major-2 bundle is cut
    // post-deploy by the suite CLI). Absent is conformant; wrong-shaped is not.
    const v2 = (await (await fetch(`${base}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } })).json()) as Record<string, unknown>;
    expect(v2['capabilities'], 'this leg must be reading the major-2 projection, which has no `capabilities` wrapper').toBeUndefined();
    expect((v2['conformance'] as { certificationBundleUrl?: unknown } | undefined)?.certificationBundleUrl).toBeUndefined();
  });
});
