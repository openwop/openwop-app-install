/**
 * ADR 0755 — the RFC 0103 §D content admin ops, graded on REAL members.
 *
 * `adr0748-protocol-content.test.ts` drives every positive path as the wildcard
 * operator, which returns before any scope check runs — so deleting a gate there
 * left the suite green (WIT-CNT-5). Every leg below authenticates as a principal
 * whose authority comes from membership rows, and each one fails if the gate it
 * names is removed:
 *
 *   - WIT-CNT-1: a create whose `pageId` a SIBLING org already holds is a 409, and
 *     the sibling's page is untouched (the kernel key has no org in it, so the old
 *     org-filtered existence check let `pages.put` overwrite it).
 *   - WIT-CNT-2: a credential-less request in the COOKIE posture (an anonymous
 *     session is minted) is refused 401, not treated as a personal-workspace owner.
 *   - WIT-CNT-3: authority is read IN THE ROOT ORG the op writes to — an admin of
 *     a sub-org who is only a viewer at the root cannot author or publish there.
 *   - WIT-CNT-4: an `owk_` key that declared other scopes is refused `content:*`
 *     with the RFC 0200 challenge, before the membership check.
 *   - WIT-CNT-7 / -13: `sec:`-prefixed section ids and the bounded 400 echo.
 *   - ADR 0748 correction: a tenant-pinned env key (the production certify
 *     binding) is its tenant's own principal (ADR 0601 C4); member principals are
 *     `owk_` keys whose authority is their issuer's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createMember, createOrg, deleteMember, updateMember } from '../src/host/accessControlService.js';
import { createPage, getPage } from '../src/features/cms/cmsService.js';
import { issueApiKey, revokeApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const TENANT = 'tenant-0755';
const SUB_ORG = 'org-0755-sub';
const OP = 'k-op-0755-operator';
// The member principals are `owk_` keys ISSUED BY member subjects: a key's
// authority is its issuer's (ADR 0601 C4). These used to be tenant-pinned env
// keys with member rows keyed on `bearer:<8 chars>` — the fixture ADR 0601 C3
// warns against, and one that hid the production 403 (ADR 0748 correction): a
// real env key has NO member row, and is its tenant's own principal.
const EDITOR_SUBJECT = 'user:editor-0755';
const SUBADMIN_SUBJECT = 'user:subadmin-0755';
let EDITOR = '';
let SUBADMIN = '';
// A tenant-pinned env key, exactly as the production conformance binding is.
const TENANT_ENV_KEY = 'tenv0755-tenant-operator-key';
const OTHER_TENANT = 'tenant-0755-b';
const OTHER_ENV_KEY = 'oenv0755-other-tenant-key';
const saved: Record<string, string | undefined> = {};
let BASE = '';
let server: http.Server;

async function call(method: string, path: string, opts: { key?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? OP}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

const draft = (pageId: string) => ({ pageId, slug: pageId, name: pageId, sectionOrder: ['hero'] });

beforeAll(async () => {
  for (const k of ['OPENWOP_API_KEYS', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_DEPLOY_POSTURE']) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_API_KEYS = `${OP}:*,${TENANT_ENV_KEY}:${TENANT},${OTHER_ENV_KEY}:${OTHER_TENANT}`;
  process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
  process.env.OPENWOP_DEPLOY_POSTURE = 'bearer-shared';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });

  // The workspace root (orgId === tenantId) the protocol lane writes to, and a sub-org.
  await createOrg({ tenantId: TENANT, orgId: TENANT, name: 'Root', createdBy: 'test' });
  await createOrg({ tenantId: TENANT, orgId: SUB_ORG, name: 'Sub', createdBy: 'test' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: EDITOR_SUBJECT, displayName: 'Editor', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: SUBADMIN_SUBJECT, displayName: 'Sub admin', roles: ['viewer'] });
  await createMember({ tenantId: TENANT, orgId: SUB_ORG, subject: SUBADMIN_SUBJECT, displayName: 'Sub admin', roles: ['admin'] });
  EDITOR = (await issueApiKey({ tenantId: TENANT, name: 'editor', createdBy: EDITOR_SUBJECT })).token;
  SUBADMIN = (await issueApiKey({ tenantId: TENANT, name: 'subadmin', createdBy: SUBADMIN_SUBJECT })).token;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0755 — content admin authority on real members', () => {
  it('CONTROL: a root-org editor authors a draft', async () => {
    const r = await call('POST', '/v1/content/pages', { key: EDITOR, body: draft('ed-draft') });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  });

  it('WIT-CNT-5: an editor cannot publish (admin tier) — red if the publish gate is removed', async () => {
    const r = await call('POST', '/v1/content/pages', { key: EDITOR, body: { ...draft('ed-pub'), status: 'published' } });
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(r.json.details?.requiredScope).toBe('host:members:manage');
  });

  it('WIT-CNT-3: a sub-org admin who is a root viewer can neither author nor publish at the root', async () => {
    const d = await call('POST', '/v1/content/pages', { key: SUBADMIN, body: draft('sa-draft') });
    expect(d.status, JSON.stringify(d.json)).toBe(403);
    expect(d.json.details?.requiredScope).toBe('workspace:write');
    const p = await call('POST', '/v1/content/pages', { key: SUBADMIN, body: { ...draft('sa-pub'), status: 'published' } });
    expect(p.status).toBe(403);
    // …but reads, which the root viewer role does grant.
    expect((await call('GET', '/v1/content/pages', { key: SUBADMIN })).status).toBe(200);
  });

  it('WIT-CNT-1: a pageId held by a sibling org is a 409, and the sibling page is untouched', async () => {
    const theirs = await createPage({ tenantId: TENANT, orgId: SUB_ORG, pageId: 'shared-id', title: 'Sibling page', createdBy: 'test' });
    const r = await call('POST', '/v1/content/pages', { key: EDITOR, body: { ...draft('shared-id'), slug: 'fresh-slug' } });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    const after = await getPage(TENANT, SUB_ORG, 'shared-id');
    expect(after, 'the sibling page must still be in its own org').not.toBeNull();
    expect(after!.title).toBe(theirs.title);
    expect(after!.version).toBe(theirs.version);
  });

  it('WIT-CNT-4: an owk_ key declaring other scopes is refused content:* with the challenge, before membership', async () => {
    const { token } = await issueApiKey({ tenantId: TENANT, name: 'adr0755', createdBy: EDITOR_SUBJECT, scopes: ['runs:read'] });
    const r = await call('GET', '/v1/content/pages', { key: token });
    expect(r.status).toBe(403);
    expect(r.json.details?.requiredScope).toBe('content:read');
    expect(r.headers.get('www-authenticate') ?? '').toMatch(/error="insufficient_scope"/);
    // CONTROL: declaring content:read clears the KEY lane, and the issuer's own
    // membership (a root editor) then grants the read.
    const { token: ok } = await issueApiKey({ tenantId: TENANT, name: 'adr0755b', createdBy: EDITOR_SUBJECT, scopes: ['content:read'] });
    const r2 = await call('GET', '/v1/content/pages', { key: ok });
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
  });

  it('ADR 0748 correction: a tenant-pinned env key is its tenant\'s own principal — it publishes, with no member row', async () => {
    // The production conformance binding's shape. Red before the fix: its
    // `bearer:<8>` id matched no member row, so every §D write answered 403.
    const r = await call('POST', '/v1/content/pages', { key: TENANT_ENV_KEY, body: { ...draft('env-pub'), status: 'published' } });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.status).toBe('published');
    expect((await call('PUT', '/v1/content/pages/env-pub/sections/hero', { key: TENANT_ENV_KEY, body: { locale: 'es-419', data: { heading: 'hola' } } })).status).toBe(200);
    expect((await call('GET', '/v1/content/pages/env-pub', { key: TENANT_ENV_KEY })).status).toBe(200);
  });

  it('ADR 0748 correction: an env key pinned to ANOTHER tenant reaches none of this tenant\'s content', async () => {
    // Its authority is its OWN tenant's: the page above does not exist there (§F 404),
    // and what it writes lands in its tenant, never this one.
    expect((await call('GET', '/v1/content/pages/env-pub', { key: OTHER_ENV_KEY })).status).toBe(404);
    const w = await call('PUT', '/v1/content/pages/env-pub/sections/hero', { key: OTHER_ENV_KEY, body: { locale: 'en', data: { heading: 'x' } } });
    expect(w.status).toBe(404);
    expect((await getPage(TENANT, TENANT, 'env-pub'))!.sections[0]!.data).not.toEqual({ heading: 'x' });
  });

  it('an owk_ key holds its issuer\'s CURRENT authority: downgraded, then removed, the issuer takes the key down with them', async () => {
    // Resolved per request (ADR 0601 C4), never captured at mint — the widening
    // "a key acts as its issuer" is only safe if it narrows the moment the issuer does.
    const subject = 'user:leaver-0755';
    const m = await createMember({ tenantId: TENANT, orgId: TENANT, subject, displayName: 'Leaver', roles: ['editor'] });
    const { token } = await issueApiKey({ tenantId: TENANT, name: 'leaver', createdBy: subject });
    expect((await call('POST', '/v1/content/pages', { key: token, body: draft('leaver-1') })).status).toBe(201);
    await updateMember(m.memberId, { roles: ['viewer'] });
    const down = await call('POST', '/v1/content/pages', { key: token, body: draft('leaver-2') });
    expect(down.status).toBe(403);
    expect(down.json.details?.requiredScope).toBe('workspace:write');
    expect((await call('GET', '/v1/content/pages', { key: token })).status).toBe(200); // a viewer still reads
    await deleteMember(m.memberId);
    expect((await call('GET', '/v1/content/pages', { key: token })).status).toBe(403); // removed: fail-closed
  });

  it('a revoked owk_ key is refused at the auth boundary (401), before any content authority', async () => {
    const { token, key } = await issueApiKey({ tenantId: TENANT, name: 'revoked', createdBy: EDITOR_SUBJECT });
    expect(await revokeApiKey(TENANT, key.keyId, { callerSubject: EDITOR_SUBJECT, isAdmin: false })).toBe(true);
    expect((await call('POST', '/v1/content/pages', { key: token, body: draft('revoked-1') })).status).toBe(401);
  });

  it('the approval gate binds a tenant-pinned env key too: a published create is 409, a draft still lands', async () => {
    const d = getToggleDefault('cms-approval-gate');
    expect(d, 'cms-approval-gate must be declared').toBeTruthy();
    await saveConfig({ ...d!, status: 'on' }, 'test');
    try {
      expect((await call('POST', '/v1/content/pages', { key: TENANT_ENV_KEY, body: { ...draft('env-gated'), status: 'published' } })).status).toBe(409);
      expect((await call('POST', '/v1/content/pages', { key: TENANT_ENV_KEY, body: draft('env-gated-draft') })).status).toBe(201);
    } finally {
      await saveConfig({ ...d!, status: 'off' }, 'test');
    }
  });

  // ── deleteContentPage (openwop#1634; ADR 0748 correction 2026-09-27) ──────────
  it('DELETE: the tenant\'s env key removes a published page (204), and it is gone for delivery and for a second DELETE', async () => {
    expect((await call('POST', '/v1/content/pages', { key: TENANT_ENV_KEY, body: { ...draft('del-pub'), status: 'published' } })).status).toBe(201);
    const r = await call('DELETE', '/v1/content/pages/del-pub', { key: TENANT_ENV_KEY });
    expect(r.status, JSON.stringify(r.json)).toBe(204);
    expect(r.json).toBe('');
    expect(await getPage(TENANT, TENANT, 'del-pub')).toBeNull();
    expect((await call('GET', '/v1/content/pages/del-pub', { key: TENANT_ENV_KEY })).status).toBe(404);
    expect((await call('DELETE', '/v1/content/pages/del-pub', { key: TENANT_ENV_KEY })).status).toBe(404);
  });

  it('DELETE: the segment is a pageId, not a slug — and major 2 reaches the same handler', async () => {
    expect((await call('POST', '/v1/content/pages', { key: TENANT_ENV_KEY, body: { pageId: 'del-id', slug: 'del-slug', name: 'x', sectionOrder: [] } })).status).toBe(201);
    expect((await call('DELETE', '/v1/content/pages/del-slug', { key: TENANT_ENV_KEY })).status).toBe(404);
    expect((await call('DELETE', '/content/pages/del-id', { key: TENANT_ENV_KEY, headers: { 'openwop-version': '2' } })).status).toBe(204);
  });

  it('DELETE: an editor removes a draft but not a live page (admin tier, like unpublish)', async () => {
    expect((await call('POST', '/v1/content/pages', { key: EDITOR, body: draft('del-ed-draft') })).status).toBe(201);
    expect((await call('DELETE', '/v1/content/pages/del-ed-draft', { key: EDITOR })).status).toBe(204);
    expect((await call('POST', '/v1/content/pages', { key: TENANT_ENV_KEY, body: { ...draft('del-ed-live'), status: 'published' } })).status).toBe(201);
    const r = await call('DELETE', '/v1/content/pages/del-ed-live', { key: EDITOR });
    expect(r.status).toBe(403);
    expect(r.json.details?.requiredScope).toBe('host:members:manage');
    expect(await getPage(TENANT, TENANT, 'del-ed-live')).not.toBeNull();
  });

  it('DELETE: §F — another tenant\'s key and a sibling org\'s page are the same 404, and nothing is removed', async () => {
    expect((await call('POST', '/v1/content/pages', { key: TENANT_ENV_KEY, body: draft('del-foreign') })).status).toBe(201);
    expect((await call('DELETE', '/v1/content/pages/del-foreign', { key: OTHER_ENV_KEY })).status).toBe(404);
    expect(await getPage(TENANT, TENANT, 'del-foreign')).not.toBeNull();
    await createPage({ tenantId: TENANT, orgId: SUB_ORG, pageId: 'del-sibling', title: 'Sibling', createdBy: 'test' });
    expect((await call('DELETE', '/v1/content/pages/del-sibling', { key: TENANT_ENV_KEY })).status).toBe(404);
    expect(await getPage(TENANT, SUB_ORG, 'del-sibling')).not.toBeNull();
    expect((await call('DELETE', '/v1/content/pages/..%2Fetc', { key: TENANT_ENV_KEY })).status).toBe(404);
  });

  it('DELETE: an owk_ key that did not declare content:write is refused before anything else', async () => {
    const { token } = await issueApiKey({ tenantId: TENANT, name: 'del-narrow', createdBy: EDITOR_SUBJECT, scopes: ['content:read'] });
    const r = await call('DELETE', '/v1/content/pages/del-foreign', { key: token });
    expect(r.status).toBe(403);
    expect(r.json.details?.requiredScope).toBe('content:write');
    expect(await getPage(TENANT, TENANT, 'del-foreign')).not.toBeNull();
  });

  it('DELETE: the approval gate does not block removal (the fail-safe direction, like unpublish)', async () => {
    expect((await call('POST', '/v1/content/pages', { key: TENANT_ENV_KEY, body: { ...draft('del-gated'), status: 'published' } })).status).toBe(201);
    const d = getToggleDefault('cms-approval-gate');
    await saveConfig({ ...d!, status: 'on' }, 'test');
    try {
      expect((await call('DELETE', '/v1/content/pages/del-gated', { key: TENANT_ENV_KEY })).status).toBe(204);
    } finally {
      await saveConfig({ ...d!, status: 'off' }, 'test');
    }
  });

  it('WIT-CNT-7: a `sec:`-prefixed section id is refused on create and on upsert', async () => {
    const c = await call('POST', '/v1/content/pages', { body: { pageId: 'sec-dupe', slug: 'sec-dupe', name: 'x', sectionOrder: ['hero', 'sec:hero'] } });
    expect(c.status).toBe(400);
    expect((await call('POST', '/v1/content/pages', { body: draft('sec-ok') })).status).toBe(201);
    const u = await call('PUT', '/v1/content/pages/sec-ok/sections/sec:hero', { body: { locale: 'en', data: {} } });
    expect(u.status).toBe(400);
  });

  it('WIT-CNT-13: the unknown-field echo is bounded', async () => {
    const body: Record<string, unknown> = { locale: 'en', data: {} };
    for (let i = 0; i < 50; i += 1) body[`k${i}`.padEnd(200, 'x')] = 1;
    const r = await call('PUT', '/v1/content/pages/sec-ok/sections/hero', { body });
    expect(r.status).toBe(400);
    expect(r.json.details.fields).toHaveLength(8);
    expect(r.json.details.omitted).toBe(42);
    expect(JSON.stringify(r.json).length).toBeLessThan(2000);
  });

  it('WIT-CNT-9: the public delivery varies on the credential and appends rather than replaces', async () => {
    const r = await call('GET', '/v1/content/pages/home', { key: null });
    expect(r.status).toBe(200);
    const vary = (r.headers.get('vary') ?? '').toLowerCase();
    for (const h of ['accept-language', 'accept-encoding', 'authorization', 'cookie']) expect(vary).toContain(h);
  });

  // Last: it boots a second app, which re-initialises the shared in-memory storage.
  it('WIT-CNT-2: in the cookie posture a credential-less write is 401, never an anonymous owner', async () => {
    // `OPENWOP_AUTH_ENFORCE_BEARER` is read when the auth middleware is built, so
    // the cookie posture needs its own app: there a header-less request is given
    // a freshly minted anonymous session — whose `anon:` tenant the old tenant
    // gate treated as the caller's own personal workspace, i.e. full authority.
    const prior = process.env.OPENWOP_AUTH_ENFORCE_BEARER;
    delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
    let cookieServer: http.Server | undefined;
    try {
      const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
      const base = await new Promise<string>((res) => { cookieServer = app.listen(0, '127.0.0.1', () => res(`http://127.0.0.1:${(cookieServer!.address() as AddressInfo).port}`)); });
      const r = await fetch(`${base}/v1/content/pages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft('anon-draft')) });
      const body = (await r.json()) as { details?: { reason?: string } };
      expect(r.status, JSON.stringify(body)).toBe(401);
      expect(body.details?.reason, 'refused by the content gate, not by the auth middleware').toBe('anonymous_principal_refused');
    } finally {
      if (prior === undefined) delete process.env.OPENWOP_AUTH_ENFORCE_BEARER; else process.env.OPENWOP_AUTH_ENFORCE_BEARER = prior;
      if (cookieServer) await new Promise<void>((res) => cookieServer!.close(() => res()));
    }
  });
});
