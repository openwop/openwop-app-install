/**
 * ADR 0795 D1 — a key's authority is its ISSUER's, filtered by what the key
 * DECLARED, in every resolver. Before this, the three resolvers were handed
 * `apikey:<keyId>` and answered as for an unknown stranger: nothing — or, in
 * demo mode on a single-principal tenant, OWNER (and `resolveTenantLevelScopes`
 * answered owner for a single-principal tenant in ANY mode).
 *
 * Service-level on purpose: these three functions are what the 100+ vendor
 * route checks call. The route-level witness is `adr0795-key-policy.test.ts`.
 */
import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import {
  createMember,
  createOrg,
  deleteMember,
  resolveEffectiveAccess,
  resolveSubjectScopesUnion,
  resolveTenantLevelScopes,
} from '../src/host/accessControlService.js';
import { issueApiKey, revokeApiKey } from '../src/features/developer-keys/apiKeyService.js';

const PERSONAL = 'user:adr0795personal';
const SHARED = 'ws:adr0795-shared';
const ADMIN = { callerSubject: 'x', isAdmin: true } as const;
let server: http.Server;
const saved: Record<string, string | undefined> = {};
const ENV = ['OPENWOP_DEMO_MODE', 'OPENWOP_KEY_AUTHORITY', 'OPENWOP_API_KEYS'] as const;

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0795', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
}, 120_000);
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function mint(tenantId: string, createdBy: string, scopes?: string[], expiresAt?: string): Promise<{ subject: string; keyId: string }> {
  const { key } = await issueApiKey({ tenantId, name: 'k', createdBy, ...(scopes ? { scopes } : {}), ...(expiresAt ? { expiresAt } : {}) });
  return { subject: `apikey:${key.keyId}`, keyId: key.keyId };
}

describe('ADR 0795 D1 — demo mode, a personal workspace (the production posture)', () => {
  it('a key that declares workspace:read holds exactly that — not OWNER', async () => {
    process.env.OPENWOP_DEMO_MODE = 'true';
    const k = await mint(PERSONAL, 'user:owner', ['workspace:read']);
    const access = await resolveEffectiveAccess(PERSONAL, { subject: k.subject });
    expect(access.scopes).toEqual(['workspace:read']);
    expect(access.roles, 'a delegation holds scopes, not roles').toEqual([]);
    expect((await resolveTenantLevelScopes(PERSONAL, k.subject)).scopes).toEqual(['workspace:read']);
    expect((await resolveSubjectScopesUnion(PERSONAL, k.subject)).scopes).toEqual(['workspace:read']);
  });

  it('a key that declares only protocol scopes holds no workspace scope at all', async () => {
    process.env.OPENWOP_DEMO_MODE = 'true';
    const k = await mint(PERSONAL, 'user:owner', ['runs:create', 'runs:read']);
    const access = await resolveEffectiveAccess(PERSONAL, { subject: k.subject });
    expect(access.scopes).not.toContain('workspace:read');
    expect(access.scopes).not.toContain('workspace:write');
    expect(access.scopes).not.toContain('host:members:manage');
  });

  it('an undeclared key holds what its issuer holds (the owner of a personal workspace)', async () => {
    const k = await mint(PERSONAL, 'user:owner');
    const access = await resolveEffectiveAccess(PERSONAL, { subject: k.subject });
    expect(access.scopes).toContain('workspace:write');
    expect(access.roles).toEqual(['owner']);
  });

  it.each([
    ['revoked', async () => { const k = await mint(PERSONAL, 'user:owner'); await revokeApiKey(PERSONAL, k.keyId, ADMIN); return k.subject; }],
    ['expired', async () => (await mint(PERSONAL, 'user:owner', undefined, '2020-01-01T00:00:00Z')).subject],
    ['with an unparseable expiry', async () => (await mint(PERSONAL, 'user:owner', undefined, 'tomorrow')).subject],
    ['unknown', async () => 'apikey:dk:does-not-exist'],
    ['issued by another key', async () => (await mint(PERSONAL, 'apikey:dk:parent')).subject],
  ])('a key that is %s holds nothing, in every resolver, even in demo mode', async (_l, make) => {
    process.env.OPENWOP_DEMO_MODE = 'true';
    const subject = await make();
    expect((await resolveEffectiveAccess(PERSONAL, { subject })).scopes).toEqual([]);
    expect((await resolveTenantLevelScopes(PERSONAL, subject)).scopes).toEqual([]);
    expect((await resolveSubjectScopesUnion(PERSONAL, subject)).scopes).toEqual([]);
  });

  it('a key is worth nothing in a tenant other than its own', async () => {
    process.env.OPENWOP_DEMO_MODE = 'true';
    const k = await mint(PERSONAL, 'user:owner');
    expect((await resolveEffectiveAccess('user:someone-else', { subject: k.subject })).scopes).toEqual([]);
    expect((await resolveTenantLevelScopes('default', k.subject)).scopes).toEqual([]);
  });
});

// ADR 0815 D1b — a `ws:` workspace's tenant-wide authority is its ROOT membership,
// so these orgs are the workspace roots (`orgId === tenantId`), the shape
// `createWorkspace` makes; a root-less `ws:` tenant has no one in it.
describe('ADR 0795 D1 / D6 — a shared workspace: the key follows its issuer', () => {
  it('holds the issuer’s member scopes, narrowed; and loses them when the issuer is removed', async () => {
    const org = await createOrg({ tenantId: SHARED, orgId: SHARED, createdBy: 'user:founder', name: 'Shared' });
    const m = await createMember({ orgId: org.orgId, tenantId: SHARED, displayName: 'Ed', subject: 'user:ed', roles: ['editor'] });
    const wide = await mint(SHARED, 'user:ed');
    const narrow = await mint(SHARED, 'user:ed', ['workspace:read']);

    const edsOwn = (await resolveEffectiveAccess(SHARED, { subject: 'user:ed' })).scopes;
    expect(edsOwn).toContain('workspace:write');
    expect((await resolveEffectiveAccess(SHARED, { subject: wide.subject })).scopes.sort()).toEqual([...edsOwn].sort());
    expect((await resolveEffectiveAccess(SHARED, { subject: narrow.subject })).scopes).toEqual(['workspace:read']);
    expect((await resolveSubjectScopesUnion(SHARED, narrow.subject)).scopes).toEqual(['workspace:read']);

    await deleteMember(m.memberId);
    expect((await resolveEffectiveAccess(SHARED, { subject: wide.subject })).scopes).toEqual([]);
    expect((await resolveSubjectScopesUnion(SHARED, wide.subject)).scopes).toEqual([]);
    expect((await resolveTenantLevelScopes(SHARED, wide.subject)).scopes).toEqual([]);
  });

  it('a key cannot hold a scope its issuer does not, whatever it declares', async () => {
    const org = await createOrg({ tenantId: 'ws:adr0795-viewer', orgId: 'ws:adr0795-viewer', createdBy: 'user:founder', name: 'V' });
    await createMember({ orgId: org.orgId, tenantId: 'ws:adr0795-viewer', displayName: 'Vi', subject: 'user:vi', roles: ['viewer'] });
    const k = await mint('ws:adr0795-viewer', 'user:vi', ['workspace:read', 'workspace:write', 'host:members:manage']);
    const scopes = (await resolveEffectiveAccess('ws:adr0795-viewer', { subject: k.subject })).scopes;
    expect(scopes).toContain('workspace:read');
    expect(scopes).not.toContain('workspace:write');
    expect(scopes).not.toContain('host:members:manage');
  });

  it('an operator-issued key resolves as the tenant’s own principal, narrowed — while that env key is still configured', async () => {
    const k = await mint('ws:adr0795-op', 'bearer:abcd1234', ['workspace:read']);
    process.env.OPENWOP_API_KEYS = 'abcd1234-rest-of-the-operator-key:ws:adr0795-op';
    expect((await resolveEffectiveAccess('ws:adr0795-op', { subject: k.subject })).scopes).toEqual(['workspace:read']);
    // Rotated out: what it minted must not stay the tenant's own principal.
    process.env.OPENWOP_API_KEYS = 'some-other-key:ws:adr0795-op';
    expect((await resolveEffectiveAccess('ws:adr0795-op', { subject: k.subject })).scopes).toEqual([]);
  });

  it('in a SHARED workspace the issuer is actually resolved: a non-member’s key holds nothing', async () => {
    // The personal-workspace cases above pass through the single-principal
    // shortcut and never read the issuer. This one has no shortcut to hide in.
    const org = await createOrg({ tenantId: 'ws:adr0795-resolve', orgId: 'ws:adr0795-resolve', createdBy: 'user:founder', name: 'R' });
    await createMember({ orgId: org.orgId, tenantId: 'ws:adr0795-resolve', displayName: 'In', subject: 'user:in', roles: ['viewer'] });
    const stranger = await mint('ws:adr0795-resolve', 'user:not-in');
    const member = await mint('ws:adr0795-resolve', 'user:in');
    expect((await resolveEffectiveAccess('ws:adr0795-resolve', { subject: stranger.subject })).scopes).toEqual([]);
    expect((await resolveEffectiveAccess('ws:adr0795-resolve', { subject: member.subject })).scopes).toContain('workspace:read');
  });
});

describe('ADR 0795 — the switch', () => {
  it('report returns the pre-ADR answer (and changes nothing); off does too', async () => {
    const k = await mint(PERSONAL, 'user:owner', ['workspace:read']);
    process.env.OPENWOP_DEMO_MODE = 'true';
    for (const mode of ['report', 'off']) {
      process.env.OPENWOP_KEY_AUTHORITY = mode;
      const access = await resolveEffectiveAccess(PERSONAL, { subject: k.subject });
      expect(access.roles, mode).toEqual(['owner']); // the hole, as it was
    }
    process.env.OPENWOP_KEY_AUTHORITY = 'enforce';
    expect((await resolveEffectiveAccess(PERSONAL, { subject: k.subject })).roles).toEqual([]);
  });

  it('a person is resolved exactly as before (CONTROL)', async () => {
    process.env.OPENWOP_DEMO_MODE = 'true';
    expect((await resolveEffectiveAccess(PERSONAL, { subject: 'user:anyone' })).roles).toEqual(['owner']);
    delete process.env.OPENWOP_DEMO_MODE;
    expect((await resolveEffectiveAccess(SHARED, { subject: 'user:stranger' })).scopes).toEqual([]);
  });
});
