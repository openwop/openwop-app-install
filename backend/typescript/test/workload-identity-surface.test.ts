/**
 * ADR 0556 P3 / RFC 0154 — the SURFACES the resolver reaches: the advertisement,
 * the §20 seam, the request binding, and replay.
 *
 * `workload-identity-resolver.test.ts` proves the decisions. This file proves
 * they are actually wired — which is the half that rots, because a resolver with
 * no caller passes every unit test it has.
 *
 * The replay section is P3's fourth gate ("audience, expiry, confused-deputy and
 * replay tests"). It sits here rather than beside the resolver because what it
 * constrains is the FORK ROUTE's metadata construction, not a decision: the
 * scopes a replay runs under are decided by which set operation the route
 * applies, and the sabotage that proves it is swapping an intersection for a
 * union.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { createApp } from '../src/index.js';
import { assertFlatErrorEnvelope, errorCodeOf, retriableOf } from './helpers/errorEnvelope.js';
import type { Storage } from '../src/storage/storage.js';
import { workloadIdentityMiddleware } from '../src/middleware/workloadIdentity.js';
import { mintWorkloadCredential } from '../src/host/workloadIdentity.js';
import {
  authorityForReplay,
  authorityRunStartContributor,
  currentAuthority,
  forkAuthorityMetadata,
  readRecordedAuthority,
  runWithAuthority,
  RUN_AUTHORITY_METADATA_KEY,
  type AuthorityFacts,
} from '../src/host/authorityContext.js';

const HOST_AUDIENCE = 'openwop-host';
const HOST_ISSUER = 'urn:openwop:surface-host';
const PEER_ISSUER = 'spiffe://example';
const SEAM = '/v1/host/sample/test/workload-identity/resolve';

const IDENTITY = { scheme: 'spiffe', subject: 'spiffe://example/dispatcher', issuer: PEER_ISSUER };

let server: http.Server;
let BASE: string;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'workload-identity-surface-secret';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE = HOST_AUDIENCE;
  process.env.OPENWOP_WORKLOAD_IDENTITY_ISSUER = HOST_ISSUER;
  process.env.OPENWOP_WORKLOAD_IDENTITY_TRUST = JSON.stringify([
    { issuer: PEER_ISSUER, scheme: 'spiffe', issuerClass: 'spiffe', tenantId: 'tenant-a', scopes: ['runs:read'] },
  ]);
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
});

afterAll(async () => {
  for (const key of [
    'OPENWOP_TEST_SEAM_ENABLED',
    'OPENWOP_WORKLOAD_IDENTITY_AUDIENCE',
    'OPENWOP_WORKLOAD_IDENTITY_ISSUER',
    'OPENWOP_WORKLOAD_IDENTITY_TRUST',
  ]) delete process.env[key];
  await new Promise<void>((res) => server.close(() => res()));
});

async function seam(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${SEAM}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// H27 / S22 — INVERTED. §20's contract read `{ error: { code, retriable } }`
// until 2026-08-16; the schema always said `error` is a code STRING with
// `retriable` under `details`, and the catalog was corrected to the schema.
// `errorCodeOf` is strict on purpose: a nested body fails this file.
const reasonOf = errorCodeOf;

describe('RFC 0154 §A — the advertisement is derived and honest', () => {
  it('advertises `auth.workloadIdentity` with derived schemes, an explicit bearer fallback, and the enforced depth', async () => {
    const res = await fetch(`${BASE}/.well-known/openwop`);
    const doc = (await res.json()) as { capabilities?: { auth?: Record<string, unknown> } };
    const wid = doc.capabilities?.auth?.workloadIdentity as {
      supported: boolean;
      schemes: string[];
      senderConstraint: string[];
      delegation: { supported: boolean; maxChainDepth: number };
    };
    expect(wid.supported).toBe(true);
    // `spiffe` because a root issues it; `oauth-client` because the host's own
    // issuer does. `mtls-san` / `cloud-subject` are NOT claimed — this host
    // terminates no client certificates and performs no cloud attestation, and
    // a scheme cannot be advertised without a root behind it.
    expect(wid.schemes).toEqual(['spiffe', 'oauth-client']);
    expect(wid.schemes).not.toContain('mtls-san');
    // §C: the empty array IS the explicit bearer-fallback advertisement.
    expect(wid.senderConstraint).toEqual([]);
    expect(wid.delegation).toEqual({ supported: true, maxChainDepth: 4 });
  });
});

describe('RFC 0154 §20 — the resolution seam drives the real resolver', () => {
  it('a verified identity resolves to a principal', async () => {
    const r = await seam({ identity: { ...IDENTITY, audience: HOST_AUDIENCE } });
    expect(r.status).toBe(200);
    expect(r.json.resolved).toBe(true);
    expect(String(r.json.principalId)).toMatch(/^workload:spiffe:/);
  });

  it('an identity for another audience is rejected with the closed reason', async () => {
    const r = await seam({ identity: { ...IDENTITY, audience: 'some-other-host' }, expectedAudience: HOST_AUDIENCE });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(reasonOf(r.json)).toBe('audience_mismatch');
  });

  it('an expired delegation is rejected', async () => {
    const r = await seam({
      identity: {
        ...IDENTITY,
        audience: HOST_AUDIENCE,
        delegation: {
          chain: [{ subject: 'spiffe://example/dispatcher' }],
          audience: HOST_AUDIENCE,
          expiresAt: '2020-01-01T00:00:00Z',
        },
      },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(reasonOf(r.json)).toBe('delegation_expired');
  });

  it('a failure is NON-RETRIABLE and uses the closed reason vocabulary', async () => {
    const r = await seam({ identity: { scheme: 'spiffe', subject: 'spiffe://example/unknown' } });
    assertFlatErrorEnvelope(r.json, 'workload-identity refusal');
    expect(retriableOf(r.json)).toBe(false);
    expect([
      'identity_unverified',
      'identity_unresolvable',
      'audience_mismatch',
      'delegation_expired',
      'sender_constraint_missing',
    ]).toContain(reasonOf(r.json));
  });

  it('the response carries no credential material and does not echo the subject', async () => {
    const r = await seam({ identity: { ...IDENTITY, audience: HOST_AUDIENCE } });
    const serialized = JSON.stringify(r.json);
    for (const forbidden of ['-----BEGIN', 'Bearer ', 'eyJ']) expect(serialized).not.toContain(forbidden);
    // Echoing the subject would hand a prober the mapping the salted hash exists
    // to withhold — a leak the suite's canary list would not catch.
    expect(serialized).not.toContain(IDENTITY.subject);
  });

  it('the seam refuses an identity object carrying credential material', async () => {
    const r = await seam({ identity: { ...IDENTITY, audience: HOST_AUDIENCE, token: 'eyJhbGciOiJIUzI1NiJ9.x.y' } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(reasonOf(r.json)).toBe('identity_unverified');
  });
});

describe('RFC 0154 §A — request binding fails closed', () => {
  it('a request presenting an unverifiable credential is refused, not downgraded', async () => {
    const res = await fetch(`${BASE}/.well-known/openwop`, {
      headers: { 'x-openwop-workload-identity': 'not.a.credential' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string; details?: { retriable?: boolean } };
    expect(body.error).toBe('identity_unverified');
    expect(body.details?.retriable).toBe(false);
  });

  it('a request presenting NO credential is untouched — the profile is additive', async () => {
    expect((await fetch(`${BASE}/.well-known/openwop`)).status).toBe(200);
  });

  it('a request presenting a valid host-minted credential passes, and the route sees the principal', async () => {
    const token = await mintWorkloadCredential({ subject: 'worker/surface', tenantId: 'tenant-w', scopes: ['runs:read'] });
    expect((await fetch(`${BASE}/.well-known/openwop`, { headers: { 'x-openwop-workload-identity': token } })).status).toBe(200);

    // …and the binding itself, asserted directly rather than inferred from a
    // 200: a middleware that verified and then dropped the result would pass the
    // request above and record nothing.
    const seen: { principal?: string; ambient?: AuthorityFacts } = {};
    const req = { get: (h: string) => (h === 'x-openwop-workload-identity' ? token : undefined) } as unknown as Request;
    const res = { status: () => res, json: () => res } as unknown as Response;
    await new Promise<void>((resolve) => {
      const next: NextFunction = () => {
        seen.principal = (req as Request).workloadPrincipal?.principalId;
        seen.ambient = currentAuthority();
        resolve();
      };
      workloadIdentityMiddleware()(req, res, next);
    });
    expect(seen.principal).toMatch(/^workload:oauth-client:/);
    // The ambient authority is what every downstream seam records from; without
    // it the effect/A2A/MCP/sandbox/compensation records would be empty.
    expect(seen.ambient?.workload).toBe(seen.principal);
    expect(seen.ambient?.actorKind).toBe('workload');
    expect(seen.ambient?.recorded).toBe(false);
  });
});

describe('ADR 0556 P3 — replay uses RECORDED authority and does not remint broader', () => {
  const recorded: AuthorityFacts = {
    actor: 'workload:spiffe:abc',
    actorKind: 'workload',
    workload: 'workload:spiffe:abc',
    scheme: 'spiffe',
    issuerClass: 'spiffe',
    senderConstraint: 'none',
    delegationDepth: 2,
    scopes: ['runs:read', 'artifacts:read'],
    recorded: false,
    correlationId: 'corr-original',
  };

  it('the replay authority is the INTERSECTION — a wider caller does not widen the replay', async () => {
    const wider: AuthorityFacts = { ...recorded, scopes: ['runs:read', 'artifacts:read', 'runs:create'], correlationId: 'corr-now' };
    const replay = authorityForReplay(recorded, wider);
    // A union here would hand the replay `runs:create` the original never had —
    // authority laundering through the fork endpoint, invisible because the
    // replay simply succeeds.
    expect(replay.scopes).toEqual(['runs:read', 'artifacts:read']);
    expect(replay.scopes).not.toContain('runs:create');
  });

  it('a caller who has LOST a scope cannot re-exercise it by replaying', () => {
    const narrower: AuthorityFacts = { ...recorded, scopes: ['runs:read'] };
    expect(authorityForReplay(recorded, narrower).scopes).toEqual(['runs:read']);
  });

  it('the identity facts come from the RECORD, and the result is marked as recorded', () => {
    const replay = authorityForReplay(recorded, { ...recorded, delegationDepth: 0, scheme: undefined });
    // The depth describes a chain verified once, in the past. Re-deriving it
    // from the replaying request would describe a different chain.
    expect(replay.delegationDepth).toBe(2);
    expect(replay.scheme).toBe('spiffe');
    expect(replay.recorded).toBe(true);
  });

  it('the run-start contributor stamps the ambient authority, and stamps nothing without one', async () => {
    expect(await authorityRunStartContributor()).toEqual({});
    const stamped = await runWithAuthority(recorded, () => authorityRunStartContributor());
    const stored = stamped[RUN_AUTHORITY_METADATA_KEY] as Record<string, unknown>;
    expect(stored.workload).toBe('workload:spiffe:abc');
    expect(stored.delegationDepth).toBe(2);
    // Content-free: no subject, no issuer URL, no chain.
    expect(JSON.stringify(stored)).not.toContain('spiffe://');
    expect(stored.chain).toBeUndefined();
  });

  it('the fork metadata narrows the recorded authority through the same function', () => {
    const metadata: Record<string, unknown> = { [RUN_AUTHORITY_METADATA_KEY]: { ...recorded, scopes: [...recorded.scopes] } };
    const read = readRecordedAuthority(metadata);
    expect(read?.recorded).toBe(true);
    const forked = forkAuthorityMetadata(read!, { ...recorded, scopes: ['runs:read'] });
    expect(forked.scopes).toEqual(['runs:read']);
    // Round-trips: what the fork writes is what a later read produces.
    expect(readRecordedAuthority({ [RUN_AUTHORITY_METADATA_KEY]: forked })?.scopes).toEqual(['runs:read']);
  });

  it('a run with no recorded authority reads back as absent, not as an empty grant', () => {
    expect(readRecordedAuthority(undefined)).toBeUndefined();
    expect(readRecordedAuthority({})).toBeUndefined();
    // A malformed record is absent too — a partially-decoded authority would be
    // a grant nobody wrote.
    expect(readRecordedAuthority({ [RUN_AUTHORITY_METADATA_KEY]: { scopes: ['runs:create'] } })).toBeUndefined();
  });
});

describe('ADR 0556 P3 — the fork ROUTE narrows, end to end', () => {
  /**
   * The unit tests above prove `authorityForReplay` intersects. This proves the
   * fork route CALLS it — the distinction that matters, because a narrowing
   * function nobody invokes passes every test it has (the "derive a ratchet from
   * the CALL, not the IMPORT" lesson).
   *
   * Non-vacuous by construction: the source run is created under a WIDE workload
   * credential and forked under a NARROW one, so a route that copied the
   * recorded scopes verbatim — the pre-P3 behaviour — produces a fork holding
   * `artifacts:read` the forking caller does not have.
   */
  async function post(path: string, body: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer dev-token',
        ...(token ? { 'x-openwop-workload-identity': token } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (res.status === 204 ? {} : await res.json()) as Record<string, unknown> };
  }

  it('a fork under a narrower workload credential does not inherit the wider recorded scopes', async () => {
    const disco = (await (await fetch(`${BASE}/.well-known/openwop`)).json()) as { fixtures?: string[] };
    const workflowId = disco.fixtures?.[0] ?? 'openwop-app.uppercase';

    const wide = await mintWorkloadCredential({
      subject: 'worker/wide',
      tenantId: 'tenant-w',
      scopes: ['manifest:read', 'runs:read', 'artifacts:read'],
    });
    const narrow = await mintWorkloadCredential({ subject: 'worker/narrow', tenantId: 'tenant-w', scopes: ['runs:read'] });

    const created = await post('/v1/runs', { workflowId, inputs: {} }, wide);
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const sourceRunId = String(created.json.runId);

    const source = await storage.getRun(sourceRunId);
    // Vacuity guard: the source must actually have been stamped, or the
    // comparison below is between two absent things.
    const recordedScopes = readRecordedAuthority(source?.metadata)?.scopes;
    expect(recordedScopes, 'the source run carries no recorded authority — this test would pass vacuously').toEqual([
      'manifest:read',
      'runs:read',
      'artifacts:read',
    ]);

    const fork = await post(`/v1/runs/${sourceRunId}:fork`, { fromSeq: 0, mode: 'replay' }, narrow);
    expect(fork.status, JSON.stringify(fork.json)).toBe(201);
    const forked = await storage.getRun(String(fork.json.runId));
    expect(readRecordedAuthority(forked?.metadata)?.scopes).toEqual(['runs:read']);
  });
});

describe('RFC 0154 §20 — the seam is gated, in both directions', () => {
  let disabled: http.Server;
  let disabledBase: string;

  beforeEach(async () => {
    // A boot with the test seam ON but the PROFILE unconfigured: §20's capability
    // gate. The suite must get a 404 (→ `blocked`), never a resolution.
    delete process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE;
    const app = await createApp({
      port: 0,
      storageDsn: 'memory://',
      serviceName: 'test',
      serviceVersion: '0.0.1',
      enableConsoleTracer: false,
    });
    await new Promise<void>((res) => {
      disabled = app.listen(0, '127.0.0.1', () => {
        disabledBase = `http://127.0.0.1:${(disabled.address() as AddressInfo).port}`;
        res();
      });
    });
  });

  afterEach(async () => {
    process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE = HOST_AUDIENCE;
    await new Promise<void>((res) => disabled.close(() => res()));
  });

  it('an unconfigured profile 404s the seam and advertises nothing', async () => {
    const res = await fetch(`${disabledBase}${SEAM}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity: { ...IDENTITY, audience: HOST_AUDIENCE } }),
    });
    expect(res.status).toBe(404);
    const doc = (await (await fetch(`${disabledBase}/.well-known/openwop`)).json()) as {
      capabilities?: { auth?: Record<string, unknown> };
    };
    expect(doc.capabilities?.auth?.workloadIdentity).toBeUndefined();
  });
});
