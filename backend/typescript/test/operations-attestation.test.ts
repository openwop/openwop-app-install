/**
 * ADR 0550 P3 — the attestation projection, ROUTE-level.
 *
 * Route-level by necessity, not preference: authorization, the superadmin gate
 * and namespace registration are observable ONLY through the HTTP boundary. A
 * service-level test of the verifier (which exists, and is thorough) says
 * nothing about whether this surface is reachable by the wrong caller.
 *
 * The states asserted here are deliberately distinct:
 *   absent     — no attestation was configured
 *   unreadable — a path was configured and the file is not parseable
 *   invalid    — a real attestation that fails verification
 * Collapsing `absent` into `invalid`, or either into a 500, is how a MISSING
 * artifact starts reading like a failing one — or worse, how a failing one gets
 * mistaken for an infrastructure hiccup.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

const SUPER_TENANT = 'org:test-attest-super';
const OPS = '/v1/host/openwop-app/operations';

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
});

afterAll(async () => {
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  delete process.env.OPENWOP_ATTESTATION_PATH;
  rmSync(tmp, { recursive: true, force: true });
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

let n = 0;
async function login(tenantId: string) {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `att-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return c;
}

describe('operations attestation projection (ADR 0550 P3)', () => {
  it('THE GATE — a plain tenant admin cannot read it', async () => {
    const c = await login('org:some-other-tenant');
    const r = await c.get(`${OPS}/attestation/summary`);
    // requireSuperadmin answers with a uniform not-found rather than a 403, so
    // the surface's EXISTENCE is not disclosed to a non-operator.
    expect([403, 404]).toContain(r.status);
  });

  it('ABSENT is its own state — not an error, and not a pass', async () => {
    delete process.env.OPENWOP_ATTESTATION_PATH;
    const c = await login(SUPER_TENANT);
    const r = await c.get(`${OPS}/attestation/summary`);
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
    const r = await c.get(`${OPS}/attestation/summary`);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('unreadable');
  });

  it('a well-formed attestation signed by an UNKNOWN key is invalid, not valid', async () => {
    // The keyring is the pinned pack keyring; a signer id it does not know must
    // fail closed. This is the path that would otherwise let any file on disk
    // present itself as a verified deployment claim.
    const file = join(tmp, 'unknown-signer.json');
    writeFileSync(file, JSON.stringify({
      payload: {
        kind: 'openwop-app.deployment-attestation.v1',
        build: { commit: 'a'.repeat(40), commitSource: 'image', containerDigest: null, deployRevision: 'local:test' },
        environmentClass: 'local',
        versions: { conformanceSuite: '1.73.0', protocol: null, corpusStamp: null },
        profiles: ['openwop-core'],
        discoveryDigest: 'f'.repeat(64),
        runtime: { storageAdapter: 'memory', queueAdapter: null },
        evidence: { collected: 1, passed: 1, failed: 0, skipped: 0, artifactDigest: 'b'.repeat(64) },
        issuedAt: '2026-08-13T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        signerKeyId: 'a-key-nobody-pinned',
      },
      signature: Buffer.from('not-a-real-signature').toString('base64'),
    }));
    process.env.OPENWOP_ATTESTATION_PATH = file;

    const c = await login(SUPER_TENANT);
    const r = await c.get(`${OPS}/attestation/summary`);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('invalid');
    expect(r.body.verdict).toMatchObject({ ok: false, reason: 'unknown_signer' });
    // The projection still reports WHAT was attested, so an operator can act —
    // but the state is unambiguous.
    expect(r.body.attested.environmentClass).toBe('local');
  });

  it('the projection carries no evidence counts and no secret-bearing fields', async () => {
    const c = await login(SUPER_TENANT);
    const r = await c.get(`${OPS}/attestation/summary`);
    const serialized = JSON.stringify(r.body);
    expect(serialized).not.toMatch(/artifactDigest/);
    expect(serialized).not.toMatch(/storageAdapter/);
    expect(serialized).not.toMatch(/sqlite:|postgres:|memory:\/\//);
  });
});
