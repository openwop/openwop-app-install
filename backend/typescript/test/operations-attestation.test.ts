/**
 * ADR 0550 P3 — the attestation projection, ROUTE-level.
 *
 * Route-level by necessity, not preference: authorization, the superadmin gate
 * and namespace registration are observable ONLY through the HTTP boundary. A
 * service-level test of the verifier (`deployment-attestation.test.ts`) says
 * nothing about whether this surface is reachable by the wrong caller, or
 * whether the route hands the verifier the pinned keyring.
 *
 * The states asserted here are deliberately distinct:
 *   absent     — no attestation was configured
 *   unreadable — a path was configured and the file is not parseable
 *   invalid    — a real attestation that fails verification
 * Collapsing `absent` into `invalid`, or either into a 500, is how a MISSING
 * artifact starts reading like a failing one — or worse, how a failing one gets
 * mistaken for an infrastructure hiccup.
 *
 * Every case sets (or clears) `OPENWOP_ATTESTATION_PATH` itself, and an
 * `afterEach` clears it, so no case reads a file another case configured.
 *
 * Sabotage, each red (w74 round 1): dropping `requireSuperadmin` from the route
 * (THE GATE); answering `absent` / `unreadable` as another state; skipping the
 * keyring's `unknown_signer` check (falls to `bad_signature`); forcing
 * `state: 'valid'`; adding `evidence.artifactDigest` to the `attested`
 * projection.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { AttestationVerdict, SignedAttestation } from '../src/host/deploymentAttestation.js';

const SUPER_TENANT = 'org:test-attest-super';
const OPS = '/host/openwop-app/operations';

let BASE: string;
let server: http.Server;
let tmp: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SUPERADMIN_TENANTS = SUPER_TENANT;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_ATTESTATION_PATH;
  tmp = mkdtempSync(join(tmpdir(), 'owp-attest-route-'));
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);

afterEach(() => {
  delete process.env.OPENWOP_ATTESTATION_PATH;
});

afterAll(async () => {
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  delete process.env.OPENWOP_ATTESTATION_PATH;
  rmSync(tmp, { recursive: true, force: true });
  await new Promise<void>((res) => server.close(() => res()));
});

/** The route's response (`features/operations/routes.ts` attestation/summary). */
interface AttestationSummary {
  state: 'absent' | 'unreadable' | 'valid' | 'invalid';
  reason?: string;
  verdict?: AttestationVerdict;
  attested?: {
    commit: string | null;
    commitSource: string | null;
    environmentClass: string | null;
    deployRevision: string | null;
    issuedAt: string | null;
    expiresAt: string | null;
    profileCount: number | null;
  };
}
/** The flat S22 refusal envelope (`middleware/errorEnvelope.ts`). */
interface Refusal { error: string; message: string; state?: unknown }

interface Res<T> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

let n = 0;
async function login(tenantId: string) {
  const c = client();
  const r = await c.post<unknown>('/host/openwop-app/test/login', { email: `att-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return c;
}

/** A well-formed attestation whose signer the pinned keyring does not know.
 *  Written per case, so no case depends on a file another case left behind. */
function writeUnknownSigner(name: string): string {
  const signed: SignedAttestation = {
    payload: {
      kind: 'openwop-app.deployment-attestation.v1',
      build: { commit: 'a'.repeat(40), commitSource: 'image', containerDigest: null, deployRevision: 'local:test' },
      environmentClass: 'local',
      versions: { conformanceSuite: '1.73.0', protocol: null, corpusStamp: null },
      profiles: ['openwop-core'],
      discoveryDigest: 'f'.repeat(64),
      runtime: { storageAdapter: 'memory', queueAdapter: null },
      evidence: { collected: 1, passed: 1, failed: 0, skipped: 0, artifactDigest: 'b'.repeat(64) },
      telemetry: { attests: 'declaration', objectives: 1, objectiveIds: ['M1'], declarationDigest: 'c'.repeat(64) },
      issuedAt: '2026-08-13T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      signerKeyId: 'a-key-nobody-pinned',
    },
    signature: Buffer.from('not-a-real-signature').toString('base64'),
  };
  const file = join(tmp, name);
  writeFileSync(file, JSON.stringify(signed));
  return file;
}

describe('operations attestation projection (ADR 0550 P3)', () => {
  it('THE GATE — a plain tenant admin cannot read it', async () => {
    // A configured path, so an admitted caller WOULD get a full projection.
    process.env.OPENWOP_ATTESTATION_PATH = writeUnknownSigner('gate.json');
    const c = await login('org:some-other-tenant');
    const r = await c.get<Refusal>(`${OPS}/attestation/summary`);
    // `requireSuperadmin` throws 403 `forbidden` (`host/superadmin.ts`), NOT a
    // uniform 404: it deliberately does not hide the surface's existence. This
    // case used to accept [403, 404] — the drift recorded in the correction at
    // the top of `features/operations/routes.ts`.
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
    expect(r.body.state).toBeUndefined();
  });

  it('ABSENT is its own state — not an error, and not a pass', async () => {
    delete process.env.OPENWOP_ATTESTATION_PATH;
    const c = await login(SUPER_TENANT);
    const r = await c.get<AttestationSummary>(`${OPS}/attestation/summary`);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('absent');
    // Explicitly NOT 'valid' — the whole point is that an operator can tell
    // "nothing was produced" from "something was produced and verified".
    expect(r.body.state).not.toBe('valid');
  });

  it('UNREADABLE is distinguished from absent and from invalid', async () => {
    const bad = join(tmp, 'garbage.json');
    writeFileSync(bad, 'this is not json');
    process.env.OPENWOP_ATTESTATION_PATH = bad;
    const c = await login(SUPER_TENANT);
    const r = await c.get<AttestationSummary>(`${OPS}/attestation/summary`);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('unreadable');
  });

  it('a well-formed attestation signed by an UNKNOWN key is invalid, not valid', async () => {
    // The keyring is the pinned pack keyring; a signer id it does not know must
    // fail closed. This is the path that would otherwise let any file on disk
    // present itself as a verified deployment claim.
    process.env.OPENWOP_ATTESTATION_PATH = writeUnknownSigner('unknown-signer.json');

    const c = await login(SUPER_TENANT);
    const r = await c.get<AttestationSummary>(`${OPS}/attestation/summary`);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('invalid');
    expect(r.body.verdict).toEqual({ ok: false, reason: 'unknown_signer' });
    // The projection still reports WHAT was attested, so an operator can act —
    // but the state is unambiguous.
    expect(r.body.attested?.environmentClass).toBe('local');
  });

  it('the projection carries no evidence counts and no secret-bearing fields', async () => {
    // Its OWN attestation: the projection under test must be the full
    // `attested` shape, not the `absent` body (which could never carry these).
    process.env.OPENWOP_ATTESTATION_PATH = writeUnknownSigner('projection.json');
    const c = await login(SUPER_TENANT);
    const r = await c.get<AttestationSummary>(`${OPS}/attestation/summary`);
    expect(r.body.state).toBe('invalid');
    expect(r.body.attested?.environmentClass).toBe('local');
    const serialized = JSON.stringify(r.body);
    expect(serialized).not.toMatch(/artifactDigest/);
    expect(serialized).not.toMatch(/storageAdapter/);
    expect(serialized).not.toMatch(/sqlite:|postgres:|memory:\/\//);
  });
});
