/**
 * Account hard-delete tests (P3.6.5).
 *
 * Verifies DELETE /v1/host/openwop-app/account:
 *   - Removes runs, events, interrupts, workflows for the caller
 *   - Removes KMS-encrypted BYOK secrets
 *   - Leaves other tenants' data untouched
 *   - Refuses anon and unauthenticated callers
 *   - Writes an audit_log entry
 *   - KB-2 R2 (review F9): reports the VECTOR-MIRROR purge outcome per backend in
 *     BOTH the response and the ADR 0284 audit payload, and does so in a way that
 *     distinguishes "a backend failed" from "no vector backend is configured"
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import { createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authMiddleware, _resetOidcVerifier } from '../src/middleware/auth.js';
import { registerPersonalTenantSessionAuthority, registerSessionAuthority } from '../src/host/sessionAuthority.js';
import { usersPersonalTenantSessionAuthority, usersSessionAuthority } from '../src/features/users/feature.js';
import { registerAccountRoutes } from '../src/routes/account.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createWorkspace,
  createMember,
  listMembers,
  ensurePersonalWorkspace,
  rekeyMemberSubject,
  isWorkspaceMember,
  createGroup,
  listGroups,
} from '../src/host/accessControlService.js';
import {
  configureSecretResolver,
  setSecret,
  listSecretRefs,
  clearCache,
} from '../src/byok/secretResolver.js';
import {
  configureKmsClient,
  createLocalAesKmsClient,
  _resetKmsForTesting,
} from '../src/byok/kmsEncryption.js';
import {
  registerVectorTenantPurger,
  registeredVectorPurgeBackends,
  _resetVectorTenantPurgersForTest,
} from '../src/host/vector/vectorTenantPurge.js';
import type { Storage } from '../src/storage/storage.js';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let appServer: http.Server;
let appPort: number;
let issuerServer: http.Server;
let issuer: string;
let privateKey: KeyObject;
let storage: Storage;

beforeAll(async () => {
  // Synthetic OIDC issuer
  const { publicKey, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = priv;
  const kid = 'test-kid-1';
  const pubJwk = publicKey.export({ format: 'jwk' });
  const jwks = { keys: [{ ...pubJwk, kid, alg: 'RS256', use: 'sig' }] };
  const issuerApp = express();
  issuerApp.get('/.well-known/jwks.json', (_req, res) => res.json(jwks));
  issuerServer = await new Promise<http.Server>((r) => { const s = issuerApp.listen(0, '127.0.0.1', () => r(s)); });
  const issuerPort = (issuerServer.address() as { port: number }).port;
  issuer = `http://127.0.0.1:${issuerPort}`;

  process.env.OPENWOP_OIDC_ISSUER = issuer;
  process.env.OPENWOP_OIDC_AUDIENCE = 'openwop-test-aud';
  process.env.OPENWOP_OIDC_JWKS_URL = `${issuer}/.well-known/jwks.json`;
  // ADR 0621 rev. 2 — the unbound OIDC lane now consults the session authority
  // (no permissive default on the seam); this harness has host-ext persistence,
  // so register the users feature's real reads.
  registerSessionAuthority(usersSessionAuthority);
  registerPersonalTenantSessionAuthority(usersPersonalTenantSessionAuthority);
  _resetOidcVerifier();

  storage = await openStorage('memory://');
  initHostExtPersistence(storage); // accessControl store (workspace/member cascade)
  const dataDir = mkdtempSync(join(tmpdir(), 'openwop-acct-'));
  configureSecretResolver({ storage, dataDir });
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));

  const app: Express = express();
  app.use(express.json());
  app.use(authMiddleware());
  registerAccountRoutes(app, { storage });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    type ErrLike = { code?: string; httpStatus?: number; message?: string; details?: Record<string, unknown> };
    const e = err as ErrLike;
    res.status(e.httpStatus ?? 500).json({
      error: e.code ?? 'internal_error',
      message: e.message,
      ...(e.details ? { details: e.details } : {}),
    });
  });
  appServer = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  appPort = (appServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => appServer.close(() => r()));
  await new Promise<void>((r) => issuerServer.close(() => r()));
  await storage.close();
  __resetHostExtPersistence();
  _resetOidcVerifier();
  _resetKmsForTesting();
  clearCache();
  delete process.env.OPENWOP_OIDC_ISSUER;
  delete process.env.OPENWOP_OIDC_AUDIENCE;
  delete process.env.OPENWOP_OIDC_JWKS_URL;
});

/** Reproduce `tenantIdFromOidc` for a given sub against the synthetic issuer. */
async function personalTenantOfSub(sub: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256').update(`${issuer}:${sub}`).digest('hex').slice(0, 32);
  return `user:${h}`;
}

function mintToken(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' };
  const payload = { iss: issuer, aud: 'openwop-test-aud', sub, iat: now, exp: now + 300 };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createSign('sha256').update(signingInput).sign(privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

async function callDelete(token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${appPort}/v1/host/openwop-app/account`, {
    method: 'DELETE',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe('P3.6.5 account hard-delete', () => {
  it('refuses unauthenticated callers', async () => {
    const res = await callDelete();
    expect(res.status).toBe(401);
  });

  it('hard-deletes the caller\'s data', async () => {
    const token = mintToken('firebase-uid-alice');
    // Probe the tenant id by calling once and reading the principal —
    // we need it to seed data. Just decode the JWT.
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64').toString('utf8'));
    // Reproduce the tenantIdFromOidc derivation
    const { createHash } = await import('node:crypto');
    const h = createHash('sha256').update(`${payload.iss}:${payload.sub}`).digest('hex').slice(0, 32);
    const tenantId = `user:${h}`;
    const otherTenant = 'user:00000000000000000000000000000000';
    const now = new Date().toISOString();

    // Seed: 2 runs + 1 secret for the caller, 1 run for another tenant
    await storage.insertRun({
      runId: 'r-alice-1', workflowId: 'wf', tenantId,
      status: 'completed', inputs: null, metadata: {}, configurable: {},
      createdAt: now, updatedAt: now,
    });
    await storage.insertRun({
      runId: 'r-alice-2', workflowId: 'wf', tenantId,
      status: 'failed', inputs: null, metadata: {}, configurable: {},
      createdAt: now, updatedAt: now,
    });
    await storage.insertRun({
      runId: 'r-other', workflowId: 'wf', tenantId: otherTenant,
      status: 'completed', inputs: null, metadata: {}, configurable: {},
      createdAt: now, updatedAt: now,
    });
    await setSecret('OPENAI_API_KEY', 'sk-alice', { tenantId });
    expect(await listSecretRefs({ tenantId })).toEqual(['OPENAI_API_KEY']);

    const res = await callDelete(token);
    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: boolean; runs: number; secrets: number };
    expect(body.deleted).toBe(true);
    expect(body.runs).toBe(2);
    expect(body.secrets).toBe(1);

    // Caller's data is gone
    expect(await storage.getRun('r-alice-1')).toBeNull();
    expect(await storage.getRun('r-alice-2')).toBeNull();
    expect(await listSecretRefs({ tenantId })).toEqual([]);
    // Other tenant untouched
    const otherRun = await storage.getRun('r-other');
    expect(otherRun).not.toBeNull();
    expect(otherRun!.tenantId).toBe(otherTenant);
  });

  // ADR 0015 cascade: deleting an account removes the caller from every SHARED
  // workspace they belong to (their personal tenant is wiped directly).
  it('cascades the caller out of shared workspaces they are a member of', async () => {
    const sub = 'firebase-uid-carol';
    const subject = `oidc:${sub}`;
    // A shared workspace owned by SOMEONE ELSE; Carol is an editor member.
    const ws = await createWorkspace({ name: 'CarolCo', ownerSubject: 'oidc:owner-x' });
    await createMember({
      tenantId: ws.tenantId, orgId: ws.orgId, subject, displayName: 'Carol', roles: ['editor'],
    });
    expect((await listMembers(ws.tenantId, ws.orgId)).some((m) => m.subject === subject)).toBe(true);

    const res = await callDelete(mintToken(sub));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as { membershipsRemoved: number };
    expect(body.membershipsRemoved).toBe(1);

    // Carol's membership is gone; the workspace + its other owner survive.
    const after = await listMembers(ws.tenantId, ws.orgId);
    expect(after.some((m) => m.subject === subject)).toBe(false);
    expect(after.some((m) => m.subject === 'oidc:owner-x')).toBe(true);
  });

  // ≥1-owner invariant: account deletion is refused (409) while the caller is the
  // SOLE owner of a shared workspace — and refused BEFORE anything is wiped.
  it('refuses to delete a sole owner of a shared workspace (409) and wipes nothing', async () => {
    const sub = 'firebase-uid-dave';
    const subject = `oidc:${sub}`;
    const tenantId = await personalTenantOfSub(sub);
    const ws = await createWorkspace({ name: 'DaveCo', ownerSubject: subject }); // Dave sole owner
    const now = new Date().toISOString();
    await storage.insertRun({
      runId: 'r-dave-1', workflowId: 'wf', tenantId,
      status: 'completed', inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    });

    const res = await callDelete(mintToken(sub));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; details?: { workspaces?: Array<{ workspaceId: string; name: string }> } };
    expect(body.error).toBe('conflict');
    // The 409 carries an actionable {workspaceId, name} list (not bare ids).
    const blocked = body.details?.workspaces ?? [];
    expect(blocked.some((w) => w.workspaceId === ws.tenantId && w.name === 'DaveCo')).toBe(true);

    // Nothing wiped: the personal-tenant run + Dave's ownership both survive.
    expect(await storage.getRun('r-dave-1')).not.toBeNull();
    expect((await listMembers(ws.tenantId, ws.orgId)).some((m) => m.subject === subject)).toBe(true);
  });

  /**
   * CONS-4 / review F2 — the LEGAL HOLD gate on the WHOLE-TENANT lane.
   *
   * ADR 0586 D2 was titled "gates every destructive lane" and this route
   * contained ZERO hold references, while being strictly more destructive than
   * the per-subject consent lane that PR did gate.
   *
   * And it is not merely a missed lane, it is a SPOLIATION lane: `retention-
   * hold` is a `DurableCollection` with a `tenantOf`, so `purgeTenantHostExt`
   * deletes the hold's own row in the same pass. Ungated, the destruction
   * removed its own evidence — self-service, no trace. That is what the second
   * half of this test pins: the hold row must still be there afterwards.
   */
  it('refuses to delete an account under LEGAL HOLD (409) — and does not destroy the hold row itself', async () => {
    const { setRetentionHold, clearRetentionHold, getRetentionHold } = await import('../src/host/retentionHold.js');
    const sub = 'firebase-uid-held';
    const tenantId = await personalTenantOfSub(sub);
    const now = new Date().toISOString();
    await storage.insertRun({
      runId: 'r-held-1', workflowId: 'wf', tenantId,
      status: 'completed', inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    });
    await setRetentionHold(tenantId, 'litigation: Acme v. Foo');

    const res = await callDelete(mintToken(sub));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string; details?: { held?: boolean; reason?: string; since?: string } };
    expect(body.error).toBe('legal_hold');
    // The refusal names the cause AND the exit — a hold the operator cannot
    // see a way past is its own defect.
    expect(body.details?.held).toBe(true);
    expect(body.details?.reason).toBe('litigation: Acme v. Foo');
    expect(typeof body.details?.since).toBe('string');
    expect(body.message).toMatch(/lifted/i);

    // NOTHING was wiped — asserted before the mutation, so the account is intact.
    expect(await storage.getRun('r-held-1')).not.toBeNull();
    // THE SPOLIATION ASSERTION: the hold row survives. `purgeTenantHostExt`
    // would have deleted it in the same pass that deleted everything else, so
    // an ungated delete destroyed the only evidence the hold ever existed.
    expect(await getRetentionHold(tenantId)).not.toBeNull();

    // BOTH HALVES: lifting the hold restores the lane. A gate with no exit
    // would be a different defect wearing this one's fix.
    await clearRetentionHold(tenantId);
    const after = await callDelete(mintToken(sub));
    expect(after.status).toBe(200);
    expect(await storage.getRun('r-held-1')).toBeNull();
  });

  // Atomic ≥1-owner guard: concurrent removal of a workspace's last two owners
  // can never leave it ownerless (post-write re-check + compensating restore —
  // the race a pre-write count→delete would lose). Exercised at the service
  // layer where the race is observable without HTTP/session noise.
  it('deleteMember is atomic: concurrent last-two-owner removals keep ≥1 owner', async () => {
    const { createWorkspace, createMember, deleteMember, countOwners, listMembers } =
      await import('../src/host/accessControlService.js');
    const ws = await createWorkspace({ name: 'RaceCo', ownerSubject: 'oidc:race-a' });
    const ownerA = (await listMembers(ws.tenantId, ws.orgId)).find((m) => m.subject === 'oidc:race-a')!;
    const ownerB = await createMember({
      tenantId: ws.tenantId, orgId: ws.orgId, subject: 'oidc:race-b', displayName: 'B', roles: ['owner'],
    });
    expect(await countOwners(ws.tenantId, ws.orgId)).toBe(2);

    const results = await Promise.allSettled([deleteMember(ownerA.memberId), deleteMember(ownerB.memberId)]);
    const removed = results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
    // At most one removal can win; the loser is rejected (conflict) + restored.
    expect(removed).toBeLessThanOrEqual(1);
    // The invariant held under concurrency: the workspace still has an owner.
    expect(await countOwners(ws.tenantId, ws.orgId)).toBeGreaterThanOrEqual(1);
  });

  // ADR 0003 Phase 4 subject re-key: rekeyMemberSubject moves every membership
  // from a legacy oidc:<sub> to the canonical user:<userId> — INCLUDING the
  // personal-owner member whose id deterministically encodes the subject
  // (architect Finding 3: a plain UPDATE would orphan it under the old id).
  it('rekeyMemberSubject re-keys members incl. the deterministic personal-owner id', async () => {
    const fromSubject = 'oidc:rekey-sub';
    const toSubject = 'user:rekey-uid';
    const personalTenant = 'user:rekey-personal-tenant';

    // Personal workspace → seeds the DETERMINISTIC personal-owner member.
    await ensurePersonalWorkspace({ tenantId: personalTenant, ownerSubject: fromSubject });
    const ownerBefore = (await listMembers(personalTenant, personalTenant))[0]!;
    // A group in the personal workspace that references the owner member by id —
    // exercises the group-repoint path when the deterministic id is re-derived.
    await createGroup({ tenantId: personalTenant, orgId: personalTenant, name: 'g', memberIds: [ownerBefore.memberId] });
    // A shared workspace this subject is also a member of (random member id).
    const shared = await createWorkspace({ name: 'RekeyCo', ownerSubject: 'oidc:other-owner' });
    await createMember({
      tenantId: shared.tenantId, orgId: shared.orgId, subject: fromSubject, displayName: 'R', roles: ['editor'],
    });

    // Pre: the OLD subject resolves in both workspaces.
    expect(await isWorkspaceMember(fromSubject, personalTenant)).toBe(true);
    expect(await isWorkspaceMember(fromSubject, shared.tenantId)).toBe(true);

    expect(await rekeyMemberSubject(fromSubject, toSubject)).toBe(2);

    // Post: the NEW subject resolves everywhere; the OLD subject nowhere.
    expect(await isWorkspaceMember(toSubject, personalTenant)).toBe(true);
    expect(await isWorkspaceMember(toSubject, shared.tenantId)).toBe(true);
    expect(await isWorkspaceMember(fromSubject, personalTenant)).toBe(false);
    expect(await isWorkspaceMember(fromSubject, shared.tenantId)).toBe(false);

    // The personal-owner member is single (the deterministic id was re-derived,
    // not left as an orphan under the old id → no duplicate owner).
    const personalMembers = await listMembers(personalTenant, personalTenant);
    expect(personalMembers.length).toBe(1);
    expect(personalMembers[0]!.roles.includes('owner')).toBe(true);
    expect(personalMembers[0]!.subject).toBe(toSubject);

    // The group now references the NEW owner member id (re-pointed, not dangling).
    const newOwnerId = personalMembers[0]!.memberId;
    expect(newOwnerId).not.toBe(ownerBefore.memberId); // id was re-derived
    const grp = (await listGroups(personalTenant, personalTenant))[0]!;
    expect(grp.memberIds).toContain(newOwnerId);
    expect(grp.memberIds).not.toContain(ownerBefore.memberId);
  });
});

/**
 * KB-2 R2 (review F9) — the VECTOR-MIRROR outcome at the API BOUNDARY.
 *
 * THE DEFECT THIS PINS. `purgeTenantVectors` has always named a failing backend in
 * its return value, and the route has always logged it — but the route then replied
 * `{deleted:true, …counts}` with no vector fields at all, and the ADR 0284 audit row
 * carried none either. So the PR's claim ("a backend that FAILS is named in the
 * result and logged rather than folded into the success count") was true inside the
 * process and FALSE everywhere an operator can see: the caller was told the same
 * thing whether the mirror was reclaimed or not, and the durable audit record — the
 * artifact a GDPR erasure claim actually rests on — could not tell the two apart.
 *
 * `purgeTenantVectors` is covered on its own in `kb-vector-tenant-teardown.test.ts`;
 * what is asserted HERE is the propagation, in both directions, plus the property
 * that makes the report usable at all: a FAILURE must be distinguishable from
 * NO BACKEND CONFIGURED. Both are "zero rows purged"; only one is an incomplete
 * erasure. (F3 made this signal meaningful by registering the pgvector purger only
 * when that backend is selected/configured — before it, every default deployment
 * reported a failure on every delete.)
 */
describe('KB-2 R2 — the account-delete response + audit report the vector mirror', () => {
  interface VectorReport {
    deleted: boolean;
    vectorRows: number;
    vectorBackends: string[];
    vectorBackendsFailed: string[];
  }

  async function deleteAndRead(sub: string): Promise<{ body: VectorReport; audit: Record<string, unknown> }> {
    const res = await callDelete(mintToken(sub));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as VectorReport;
    const tenantId = await personalTenantOfSub(sub);
    const rows = await storage.listAudit({ actionPrefix: 'account.delete' });
    const row = rows.find((r) => r.resource === tenantId);
    expect(row, 'the ADR 0284 audit row for this tenant').toBeTruthy();
    return { body, audit: row!.payload as Record<string, unknown> };
  }

  let noneConfigured: VectorReport;

  afterAll(() => { _resetVectorTenantPurgersForTest(); });

  it('NO vector backend configured — an empty backend list, zero rows, no failures', async () => {
    _resetVectorTenantPurgersForTest();
    expect(registeredVectorPurgeBackends(), 'the precondition being modelled').toEqual([]);

    const { body, audit } = await deleteAndRead('firebase-uid-vec-none');
    noneConfigured = body;
    expect(body.deleted).toBe(true);
    expect(body.vectorBackends).toEqual([]);
    expect(body.vectorBackendsFailed).toEqual([]);
    expect(body.vectorRows).toBe(0);
    expect(audit.vectorBackends).toEqual([]);
    expect(audit.vectorBackendsFailed).toEqual([]);
    expect(audit.vectorRows).toBe(0);
  });

  it('a backend that PURGES is counted in both the response and the audit payload', async () => {
    _resetVectorTenantPurgersForTest();
    registerVectorTenantPurger('probe-ok', async () => 7);

    const { body, audit } = await deleteAndRead('firebase-uid-vec-ok');
    expect(body.vectorBackends).toEqual(['probe-ok']);
    expect(body.vectorBackendsFailed).toEqual([]);
    expect(body.vectorRows).toBe(7);
    expect(audit.vectorBackends).toEqual(['probe-ok']);
    expect(audit.vectorBackendsFailed).toEqual([]);
    expect(audit.vectorRows).toBe(7);
  });

  it('a FAILING backend is named in the response AND the audit — and is distinguishable from "none configured"', async () => {
    _resetVectorTenantPurgersForTest();
    registerVectorTenantPurger('probe-pg', async () => { throw new Error('pgvector unreachable'); });
    registerVectorTenantPurger('probe-ok', async () => 2);

    const { body, audit } = await deleteAndRead('firebase-uid-vec-fail');

    // Named, not swallowed — in the reply the operator/SPA actually sees…
    expect(body.vectorBackendsFailed).toEqual(['probe-pg']);
    expect(body.vectorBackends, 'a failing backend is not also counted as having run').toEqual(['probe-ok']);
    expect(body.vectorRows, 'the healthy backend still reports its rows').toBe(2);
    // …and in the DURABLE audit record.
    expect(audit.vectorBackendsFailed).toEqual(['probe-pg']);
    expect(audit.vectorBackends).toEqual(['probe-ok']);

    // THE DISCRIMINATOR. Both this case and "no backend configured" are a 200 with
    // `deleted:true`; row counts alone cannot separate them (a healthy host with an
    // empty mirror also purges 0 rows). `vectorBackendsFailed` is what does.
    expect(noneConfigured.deleted).toBe(body.deleted);
    expect(noneConfigured.vectorBackendsFailed, 'the two outcomes MUST NOT read alike')
      .not.toEqual(body.vectorBackendsFailed);
  });

  it('the failure is reported WITHOUT aborting the rest of the teardown', async () => {
    // A vector backend being down must not strand the tenant's own rows — the
    // reason `deleted` stays true. Seed a run, fail the mirror, assert the run is
    // still gone and the failure is still reported.
    _resetVectorTenantPurgersForTest();
    registerVectorTenantPurger('probe-pg', async () => { throw new Error('pgvector unreachable'); });
    const sub = 'firebase-uid-vec-partial';
    const tenantId = await personalTenantOfSub(sub);
    const now = new Date().toISOString();
    await storage.insertRun({
      runId: 'r-vec-partial', workflowId: 'wf', tenantId,
      status: 'completed', inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    });

    const { body } = await deleteAndRead(sub);
    expect(body.deleted).toBe(true);
    expect(body.vectorBackendsFailed).toEqual(['probe-pg']);
    expect(await storage.getRun('r-vec-partial'), 'the tenant\'s own rows ARE reclaimed').toBeNull();
  });
});
