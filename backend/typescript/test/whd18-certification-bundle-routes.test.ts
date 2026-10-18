/**
 * WHD-18 / ADR 0735 decision 2 — the HTTP boundary.
 *
 * A real host (`createApp` + `app.listen`), a fake metadata server + GCS behind
 * the reader's injected fetch, and every surface that names the evidence probed
 * over HTTP: the major-2 root's pointer and the major-2 bundle route. The WHD-6
 * invariant is the thing under test — route and pointer hang off ONE predicate.
 *
 * ADR 0812 P4 slice 3 — the major-1 bundle route and `/claims` are DELETED with
 * the in-process emitter whose image stamp they served. They are still probed,
 * as 404s, so neither can come back unnoticed.
 *
 * The postures, each needed for a different reason:
 *   - UNSET: every white-label adopter. Nothing is served, and a STALE image
 *     stamp left in `build-meta/` (what the retired `--certify` used to write)
 *     is served by nothing either.
 *   - SET, nothing published: the stale stamp is NOT the fallback. That is the
 *     ADR 0735 point; a fallback here is the defect with a longer fuse.
 *   - SET + a verified bundle per major: pointer at the right root only,
 *     following the ADVERTISED url returns the exact uploaded bytes.
 *   - SET + tampered / wrong-commit / misconfigured: all three surfaces absent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/index.js';
import {
  CERTIFICATION_BUNDLE_MAJOR2_VENDOR_PATH,
  __resetCertificationEvidenceForTests,
} from '../src/host/conformanceClaims.js';
import { METADATA_TOKEN_URL, type FetchLike } from '../src/host/certificationEvidence.js';
import { signBundleV3, witnessDigest, type BundleV3 } from '@openwop/openwop-conformance/src/lib/certification-bundle-v3.js';

const FIXTURE_TEXT = readFileSync(join(__dirname, 'fixtures', 'certification-bundle-v3-27315b41c-major2.json'), 'utf8');
const COMMIT = '27315b41c8f43e76e99f2e0f413acff14ba026fb';
const OTHER_COMMIT = '1111111111111111111111111111111111111111';
const BUCKET = 'openwop-dev-certification-bundles';
const PREFIX = 'evidence';
const ORIGIN_ENV = `gs://${BUCKET}/${PREFIX}`;
/** The two routes ADR 0812 P4 slice 3 deleted — probed so they stay deleted. */
const RETIRED_BUNDLE_PATH = '/host/openwop-app/conformance/certification-bundle';
const RETIRED_CLAIMS_PATH = '/host/openwop-app/conformance/claims';
const FIXTURE_KEY = { keyId: 'openwop-app-bundle-2', alg: 'ed25519', publicKey: 'WVhUJ8jHoQf9g9b8VPsfMS6kiOjUSbGdjbIAiemOVq4' };

/**
 * A MAJOR-1 bundle, produced by the SUITE's own `signBundleV3` + `witnessDigest`
 * (not this host's mirror), so the major-1 leg is still an independent producer
 * checked by our verifier. Only the real fixture is major 2.
 */
function signedMajor1(commit: string): { text: string; publicKey: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = der.subarray(der.length - 32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const requirements = [
    { id: 'openwop.scenario.discovery', scenario: 'discovery.test.ts', result: 'executed-pass' as const, assertions: 4 },
    { id: 'openwop.scenario.runs-basic', scenario: 'runs-basic.test.ts', result: 'executed-fail' as const, assertions: 1, detail: 'a failing row, so the bundle is not all-green' },
  ];
  const unsigned: Omit<BundleV3, 'signature'> = {
    bundleVersion: '3',
    generatedAt: '2026-09-21T15:00:00.000Z',
    suite: { name: '@openwop/openwop-conformance', version: '2.34.0', targetMajor: 1, specArtifactsVersion: '2.34.0' },
    host: { name: 'openwop-workflow-engine', version: '0.1.0', build: { kind: 'commit', id: commit }, signingKeyId: 'test-major1' },
    discovery: { url: 'https://example.invalid/.well-known/openwop', sha256: 'a'.repeat(64), protocolVersions: ['1.1', '2.0'], preferredVersion: '1.1' },
    claimedProfiles: [{ id: 'openwop-discovery-core', evidenceTier: 'self', witnessCount: 1, certified: true }],
    results: { totals: { executedPass: 1, executedFail: 1, skipped: 0, inapplicable: 0, blocked: 0 }, requirements },
    witnessSha256: witnessDigest(requirements),
    assertionCount: 5,
    detail: { nonPass: [{ id: 'openwop.scenario.runs-basic', result: 'executed-fail', reason: 'a failing row' }] },
  };
  const signature = signBundleV3(unsigned, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'test-major1');
  return { text: `${JSON.stringify({ ...unsigned, signature }, null, 2)}\n`, publicKey: raw, keyId: 'test-major1' };
}

const MAJOR1 = signedMajor1(COMMIT);

/** The fake bucket. Keys are object NAMES, exactly as publish-evidence.sh writes them. */
const objects = new Map<string, string>();
const objectReads: string[] = [];

const fakeFetch: FetchLike = async (url) => {
  if (url === METADATA_TOKEN_URL) return new Response(JSON.stringify({ access_token: 't', expires_in: 3599 }), { status: 200 });
  const m = /^https:\/\/storage\.googleapis\.com\/storage\/v1\/b\/([^/]+)\/o\/([^?]+)\?alt=media$/.exec(url);
  if (m === null || m[1] !== BUCKET) return new Response('bad url', { status: 400 });
  const name = decodeURIComponent(m[2] ?? '');
  objectReads.push(name);
  const body = objects.get(name);
  return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
};

let base: string;
let server: http.Server;
let metaDir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['OPENWOP_BUILD_META_DIR', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_BUNDLE_SIGNING_KEYS', 'OPENWOP_CERT_BUNDLE_ORIGIN', 'OPENWOP_BUILD_COMMIT'];

function stampImage(dir: string): void {
  // A STALE image pair, as the retired in-process `--certify` left it in
  // `build-meta/`. Hand-written: the emitter is gone, and what matters is only
  // that the files are present, so the "served by nothing" legs below are a
  // real statement rather than "nothing was there".
  writeFileSync(join(dir, 'certification-bundle.json'), JSON.stringify({ bundleVersion: '2', claimedProfiles: ['openwop-core-standard'] }));
  writeFileSync(join(dir, 'conformance-claims.json'), JSON.stringify({ claimsVersion: '1', claimedProfiles: ['openwop-core-standard'] }));
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  metaDir = mkdtempSync(join(tmpdir(), 'owp-whd18-'));
  writeFileSync(join(metaDir, 'commit.txt'), `${COMMIT}\n`);
  stampImage(metaDir);
  process.env.OPENWOP_BUILD_META_DIR = metaDir;
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_BUILD_COMMIT;
  process.env.OPENWOP_BUNDLE_SIGNING_KEYS = JSON.stringify([
    FIXTURE_KEY,
    { keyId: MAJOR1.keyId, alg: 'ed25519', publicKey: MAJOR1.publicKey },
  ]);
  delete process.env.OPENWOP_CERT_BUNDLE_ORIGIN;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<http.Server>((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(metaDir, { recursive: true, force: true });
  __resetCertificationEvidenceForTests();
});

beforeEach(() => {
  // A fresh reader per case: the negative cache is 60 s, and a case must not
  // inherit the previous case's "not published" answer.
  __resetCertificationEvidenceForTests({ fetchImpl: fakeFetch });
  objects.clear();
  objectReads.length = 0;
  writeFileSync(join(metaDir, 'commit.txt'), `${COMMIT}\n`);
});

const keyFor = (commit: string, major: 1 | 2): string => `${PREFIX}/${commit}/major-${major}.json`;

// ADR 0812 P3c-0 — the major-1 document (and with it the major-1 root's
// pointer) is gone with major 1; only the major-2 root is probed.
async function v2Doc(): Promise<Record<string, unknown>> {
  return (await (await fetch(`${base}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } })).json()) as Record<string, unknown>;
}
const v2Pointer = (doc: Record<string, unknown>): unknown =>
  (doc['conformance'] as { certificationBundleUrl?: unknown } | undefined)?.certificationBundleUrl;
const status = async (path: string): Promise<number> => (await fetch(`${base}${path}`)).status;

async function expectNothingServed(posture: string): Promise<void> {
  expect(v2Pointer(await v2Doc()), `${posture}: major-2 pointer`).toBeUndefined();
  expect(await status(RETIRED_BUNDLE_PATH), `${posture}: retired major-1 route`).toBe(404);
  expect(await status(CERTIFICATION_BUNDLE_MAJOR2_VENDOR_PATH), `${posture}: major-2 route`).toBe(404);
  expect(await status(RETIRED_CLAIMS_PATH), `${posture}: retired /claims`).toBe(404);
}

describe('WHD-18 — OPENWOP_CERT_BUNDLE_ORIGIN UNSET serves no evidence (ADR 0812 P4 slice 3)', () => {
  it('a stale image stamp is served by NOTHING: no pointer, no route, retired routes 404, origin untouched', async () => {
    delete process.env.OPENWOP_CERT_BUNDLE_ORIGIN;
    // Precondition: the stale pair is really there.
    expect(readdirSync(metaDir)).toEqual(expect.arrayContaining(['certification-bundle.json', 'conformance-claims.json']));
    await expectNothingServed('origin unset, stale image stamp present');
    expect(objectReads, 'image mode must never touch the origin').toEqual([]);
  });
});

describe('WHD-18 — origin SET', () => {
  beforeEach(() => { process.env.OPENWOP_CERT_BUNDLE_ORIGIN = ORIGIN_ENV; });
  afterAll(() => { delete process.env.OPENWOP_CERT_BUNDLE_ORIGIN; });

  it('nothing published → nothing served, and the IMAGE stamp in build-meta/ is NOT the fallback', async () => {
    // Precondition: the stale image pair is really there.
    expect(readdirSync(metaDir)).toEqual(expect.arrayContaining(['certification-bundle.json', 'conformance-claims.json']));
    await expectNothingServed('origin set, bucket empty');
    // It DID look — at this build's own major-2 key — so the absence is an
    // answer. Nothing reads the major-1 key any more: its route is gone.
    expect(objectReads).toEqual(expect.arrayContaining([keyFor(COMMIT, 2)]));
    expect(objectReads).not.toContain(keyFor(COMMIT, 1));
  });

  it('a verified MAJOR-2 bundle → pointer at the major-2 root ONLY, resolving to the exact uploaded bytes', async () => {
    objects.set(keyFor(COMMIT, 2), FIXTURE_TEXT);

    const url = v2Pointer(await v2Doc());
    expect(url).toBe(`${base}${CERTIFICATION_BUNDLE_MAJOR2_VENDOR_PATH}`);
    // Follow the ADVERTISED url (the version-agnostic vendor path, rewritten
    // onto the /v1 twin before auth) with NO credentials: a public claim.
    const res = await fetch(String(url));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.text(), 'the served body must be the uploaded bytes, not a re-serialisation').toBe(FIXTURE_TEXT);
    // The /v1 twin serves the same document.
    expect(await (await fetch(`${base}${CERTIFICATION_BUNDLE_MAJOR2_VENDOR_PATH}`)).text()).toBe(FIXTURE_TEXT);

    // The retired major-1 route and /claims stay gone — the major-2 bundle is
    // never offered through either.
    expect(await status(RETIRED_BUNDLE_PATH)).toBe(404);
    expect(await status(RETIRED_CLAIMS_PATH), '/claims is deleted (ADR 0812 P4 slice 3)').toBe(404);
  });

  // ADR 0812 P3c-0 — the "verified MAJOR-1 bundle → pointer at the major-1 root" leg was deleted with the major-1 root.

  it('the major-2 bundle uploaded to the MAJOR-1 key is refused (target-major) — no cross-major leak', async () => {
    objects.set(keyFor(COMMIT, 1), FIXTURE_TEXT);
    await expectNothingServed('major-2 bundle at the major-1 key');
  });

  it('a TAMPERED bundle → all surfaces absent', async () => {
    const doc = JSON.parse(FIXTURE_TEXT) as { results: { requirements: Array<Record<string, unknown>> } };
    const row = doc.results.requirements.find((r) => typeof r['detail'] === 'string');
    if (row === undefined) throw new Error('fixture has no detail row');
    row['detail'] = `${String(row['detail'])}!`;
    objects.set(keyFor(COMMIT, 2), JSON.stringify(doc));
    await expectNothingServed('tampered row');
  });

  it('a bundle for ANOTHER build is structurally unservable: this host reads only its own commit\'s key', async () => {
    // The real bundle sits at the real commit's key, but this host now runs
    // OTHER_COMMIT. It never reads the fixture's key at all…
    objects.set(keyFor(COMMIT, 2), FIXTURE_TEXT);
    writeFileSync(join(metaDir, 'commit.txt'), `${OTHER_COMMIT}\n`);
    await expectNothingServed('host is a different build');
    expect(objectReads.every((k) => k.includes(OTHER_COMMIT))).toBe(true);
    // …and copying it to this host's key is refused by the build binding.
    __resetCertificationEvidenceForTests({ fetchImpl: fakeFetch });
    objects.set(keyFor(OTHER_COMMIT, 2), FIXTURE_TEXT);
    await expectNothingServed('bundle copied to another commit\'s key');
  });

  it('the signing key withdrawn from discovery → the bundle is withheld (a keyId nobody can resolve)', async () => {
    objects.set(keyFor(COMMIT, 2), FIXTURE_TEXT);
    const keys = process.env.OPENWOP_BUNDLE_SIGNING_KEYS;
    process.env.OPENWOP_BUNDLE_SIGNING_KEYS = JSON.stringify([{ keyId: MAJOR1.keyId, alg: 'ed25519', publicKey: MAJOR1.publicKey }]);
    try {
      await expectNothingServed('signing key not published');
    } finally {
      process.env.OPENWOP_BUNDLE_SIGNING_KEYS = keys;
    }
  });

  it('a MISCONFIGURED origin withholds everything, and never falls back to the image', async () => {
    process.env.OPENWOP_CERT_BUNDLE_ORIGIN = 'https://not-a-bucket.example/x';
    objects.set(keyFor(COMMIT, 2), FIXTURE_TEXT);
    await expectNothingServed('misconfigured origin');
    expect(objectReads).toEqual([]);
  });
});

describe('WHD-18 — the advertised document still validates against the vendored v2 schema', () => {
  const ROOT = join(__dirname, '..', '..', '..');

  async function compile(dir: string, rootFile: string) {
    // A dynamic import, which types
    // `ajv-formats`' default export without a cast.
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { default: addFormats } = await import('ajv-formats');
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && x !== rootFile)) {
      try { ajv.addSchema(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>, f); } catch { /* duplicate $id / not a schema */ }
    }
    const schema = JSON.parse(readFileSync(join(dir, rootFile), 'utf8')) as Record<string, unknown>;
    return { ajv, schema };
  }

  it('major 2: the WHOLE v2 document with the pointer set validates against the closed v2 schema', async () => {
    process.env.OPENWOP_CERT_BUNDLE_ORIGIN = ORIGIN_ENV;
    objects.set(keyFor(COMMIT, 2), FIXTURE_TEXT);
    try {
      const doc = await v2Doc();
      expect(typeof v2Pointer(doc), 'non-vacuity: the pointer must be present for this to test it').toBe('string');
      const { ajv, schema } = await compile(join(ROOT, 'schemas', 'v2'), 'capabilities.schema.json');
      const validate = ajv.compile(schema);
      const ok = validate(doc);
      expect((validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`), 'v2 advert errors').toEqual([]);
      expect(ok).toBe(true);
    } finally {
      delete process.env.OPENWOP_CERT_BUNDLE_ORIGIN;
    }
  });

  // ADR 0812 P3c-0 — the major-1 `conformance` record schema leg was deleted with the major-1 document.
});
