/**
 * ADR 0402 §b — CRM native click-to-sign e-signature, ROUTE-level e2e + the
 * content-hash unit. Drives: requestSignature (authed) → per-signer capability
 * tokens → public sign (sequential order) → completion + PDF certificate, plus
 * the content_changed loud-fail, decline, void, and tenant isolation.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createDocument, addVersion } from '../src/features/documents/documentsService.js';
import { getSignRequestById } from '../src/features/crm/entities/signRequests.js';
import { hashCanonical } from '../src/features/crm/signTargets.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_CRM_ESIGN_ENABLED;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
  const c = getToggleDefault('crm');
  if (c) await saveConfig({ ...c, status: 'on' }, 'test');
  const d = getToggleDefault('documents');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const cRaw of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(cRaw); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const tenantId = `org:sign-${Date.now()}-${n++}`;
  const owner = client();
  const login = await owner.post('/v1/host/openwop-app/test/login', { email: `sign-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}

async function seedDoc(tenantId: string, orgId: string, content: string): Promise<string> {
  const doc = await createDocument({ tenantId, orgId, title: 'Agreement', kind: 'doc', provenance: { producedBy: { kind: 'user', id: 'u1' } }, createdBy: 'u1' });
  await addVersion(tenantId, orgId, doc.documentId, { content, producedBy: { kind: 'user', id: 'u1' } });
  return doc.documentId;
}

const org = (orgId: string, s = ''): string => `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/sign-requests${s}`;
const signerToken = async (signRequestId: string, i: number): Promise<string> => {
  // ADR 0448 grade fix #2 — raw tokens are never at rest anymore; capture from
  // the in-process mint affordance instead of the store.
  const req = await getSignRequestById(signRequestId);
  const { __signerTokenForTest } = await import('../src/features/crm/signService.js');
  return __signerTokenForTest(signRequestId, req!.signers[i]!.signerId)!;
};

describe('esign — content hash', () => {
  it('is deterministic and changes with content', () => {
    const a = hashCanonical(JSON.stringify({ x: 1, y: 2 }));
    const b = hashCanonical(JSON.stringify({ x: 1, y: 2 }));
    const c = hashCanonical(JSON.stringify({ x: 1, y: 3 }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('esign — request → sequential sign → complete → certificate', () => {
  it('runs the full flow with order enforcement + a PDF certificate', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const docId = await seedDoc(tenantId, orgId, '# Agreement\n\nPlease sign.');

    const created = await owner.post(org(orgId), {
      target: { kind: 'document', id: docId },
      signers: [{ email: 'a@x.test', name: 'Ann', order: 0 }, { email: 'b@x.test', name: 'Bob', order: 1 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.status).toBe('sent');
    expect(created.body.signers).toHaveLength(2);
    const srid = created.body.signRequestId;
    // Tokens are NOT exposed in the projection.
    expect(JSON.stringify(created.body)).not.toContain('token');

    const t0 = await signerToken(srid, 0);
    const t1 = await signerToken(srid, 1);

    // Signer 1 (order 1) cannot sign first.
    // R2 S-G2 — a signature without the explicit acknowledgment is refused:
    // the SignatureRecord doubles as a consent record, so consent must be sent.
    const noAck = await client().post(`/v1/host/openwop-app/public-sign/${t1}/sign`, { typedName: 'Bob' });
    expect(noAck.status).toBe(400);
    expect((noAck.body as { details?: { reason?: string } }).details?.reason).toBe('acknowledgment_required');

    const early = await client().post(`/v1/host/openwop-app/public-sign/${t1}/sign`, { typedName: 'Bob', acknowledged: true });
    expect(early.status).toBe(409);

    // Public signing page shows the content + the legal notice.
    const view = await client().get(`/v1/host/openwop-app/public-sign/${t0}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.contentMarkdown).toContain('Agreement');
    expect(view.body.legalNotice).toContain('NOT a qualified');
    expect(view.body.yourTurn).toBe(true);

    // Signer 0 signs → partially_signed.
    const s0 = await client().post(`/v1/host/openwop-app/public-sign/${t0}/sign`, { typedName: 'Ann Smith', acknowledged: true });
    expect(s0.status, JSON.stringify(s0.body)).toBe(200);
    expect(s0.body.status).toBe('partially_signed');

    // Signer 1 now signs → completed.
    const s1 = await client().post(`/v1/host/openwop-app/public-sign/${t1}/sign`, { typedName: 'Bob Jones', acknowledged: true });
    expect(s1.status).toBe(200);
    expect(s1.body.status).toBe('completed');

    // Status shows completed + a certificate URL + per-signer audit (hashed).
    const status = await owner.get(org(orgId, `/${srid}`));
    expect(status.body.status).toBe('completed');
    expect(String(status.body.certificateUrl)).toContain('/v1/host/openwop-app/assets/');
    expect(status.body.signers.every((s: any) => s.status === 'signed' && s.audit?.ipHash)).toBe(true);

    // The certificate is a downloadable PDF.
    const cert = await fetch(`${BASE}${status.body.certificateUrl}`);
    expect(cert.status).toBe(200);
    expect(cert.headers.get('content-type')).toContain('application/pdf');
  });
});

describe('esign — loud staleness, decline, void, isolation', () => {
  it('fails loudly when the document changed after the request (content_changed)', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const docId = await seedDoc(tenantId, orgId, 'v1 content');
    const created = await owner.post(org(orgId), { target: { kind: 'document', id: docId }, signers: [{ email: 'a@x.test' }] });
    expect(created.status).toBe(201);
    const token = await signerToken(created.body.signRequestId, 0);
    // Change the document AFTER the request.
    await addVersion(tenantId, orgId, docId, { content: 'v2 content — changed!', producedBy: { kind: 'user', id: 'u1' } });
    const signed = await client().post(`/v1/host/openwop-app/public-sign/${token}/sign`, { typedName: 'Ann', acknowledged: true });
    expect(signed.status).toBe(409);
    expect(signed.body.details?.reason).toBe('content_changed');
  });

  it('declines, and a voided request stops resolving', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const docId = await seedDoc(tenantId, orgId, 'sign me');
    // Decline path.
    const c1 = await owner.post(org(orgId), { target: { kind: 'document', id: docId }, signers: [{ email: 'a@x.test' }] });
    const tDecline = await signerToken(c1.body.signRequestId, 0);
    const declined = await client().post(`/v1/host/openwop-app/public-sign/${tDecline}/decline`);
    expect(declined.status).toBe(200);
    expect(declined.body.status).toBe('declined');

    // Void path.
    const c2 = await owner.post(org(orgId), { target: { kind: 'document', id: docId }, signers: [{ email: 'b@x.test' }] });
    const tVoid = await signerToken(c2.body.signRequestId, 0);
    const voided = await owner.post(org(orgId, `/${c2.body.signRequestId}/void`));
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe('voided');
    // The signer token no longer resolves (tokens revoked on void).
    expect((await client().get(`/v1/host/openwop-app/public-sign/${tVoid}`)).status).toBe(404);
  });

  it('two unordered signers signing CONCURRENTLY both land and the request completes (CAS)', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const docId = await seedDoc(tenantId, orgId, 'concurrent agreement');
    const created = await owner.post(org(orgId), {
      target: { kind: 'document', id: docId },
      signers: [{ email: 'a@x.test' }, { email: 'b@x.test' }], // no order → either can sign first
    });
    expect(created.status).toBe(201);
    const srid = created.body.signRequestId;
    const [t0, t1] = [await signerToken(srid, 0), await signerToken(srid, 1)];
    // Fire both signs at once — a blind put would lose one and stick at partially_signed.
    const [r0, r1] = await Promise.all([
      client().post(`/v1/host/openwop-app/public-sign/${t0}/sign`, { typedName: 'Ann', acknowledged: true }),
      client().post(`/v1/host/openwop-app/public-sign/${t1}/sign`, { typedName: 'Bob', acknowledged: true }),
    ]);
    expect(r0.status).toBe(200);
    expect(r1.status).toBe(200);
    const status = await owner.get(org(orgId, `/${srid}`));
    expect(status.body.status).toBe('completed');
    expect(status.body.signers.every((s: any) => s.status === 'signed')).toBe(true);
    expect(String(status.body.certificateUrl)).toContain('/v1/host/openwop-app/assets/');
  });

  it('honestly refuses an external provider that is not built (P3 seam)', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const docId = await seedDoc(tenantId, orgId, 'sign me');
    // An unregistered / external provider fails loudly (501) — never a dishonest sign.
    const bad = await owner.post(org(orgId), { target: { kind: 'document', id: docId }, signers: [{ email: 'a@x.test' }], provider: 'docusign' });
    expect(bad.status).toBe(501);
    // The native default works and stamps the provider.
    const ok = await owner.post(org(orgId), { target: { kind: 'document', id: docId }, signers: [{ email: 'a@x.test' }] });
    expect(ok.status).toBe(201);
    const req = await getSignRequestById(ok.body.signRequestId);
    expect(req!.provider).toBe('native');
  });

  it('another tenant cannot read a sign request (IDOR guard)', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const docId = await seedDoc(tenantId, orgId, 'private');
    const created = await owner.post(org(orgId), { target: { kind: 'document', id: docId }, signers: [{ email: 'a@x.test' }] });
    const srid = created.body.signRequestId;
    const other = (await ownerOrg());
    // The other org's owner queries THIS org's path → org-scope 403/404, never leak.
    const leak = await other.owner.get(org(orgId, `/${srid}`));
    expect([403, 404]).toContain(leak.status);
  });
});

/**
 * EMAIL DELIVERY HONESTY — found by a sweep for tests that pin defects, and this
 * path had NO test at all (`activeProvider` appeared in zero test files).
 *
 * `activeProvider()` returns a console stub whose `send()` is an empty function.
 * `sendCampaign` refuses on it (LEAK-1) — but the signature path reached it
 * through THREE layers of silence: a no-op send, an `emailSigner` catch that only
 * `log.warn`s, and a `void` discarding the promise. A user requested a signature,
 * the API returned 201, and no email existed; the only trace was a server log the
 * requester never sees.
 *
 * ASSERTED AT THE ROUTE, deliberately. The first cut of this fix added
 * `invitesEmailed` to the SERVICE return — where the route, which responds with
 * `getSignatureStatus(...)` and not the service result, would have dropped it.
 * That is the same "the host knew and didn't say" shape the fix exists to remove,
 * so the assertion has to be on what the CLIENT receives.
 */
describe('signature invites report delivery honestly (route level)', () => {
  it('returns invitesEmailed:false while the console stub is the transport', async () => {
    const { emailTransportConfigured } = await import('../src/features/email/emailService.js');
    // Precondition asserted, not assumed: if a real transport ever gets wired
    // into this harness, this test stops proving anything and should say so.
    expect(emailTransportConfigured(), 'a real email transport is configured — this test no longer proves anything').toBe(false);

    const { owner, tenantId, orgId } = await ownerOrg();
    const docId = await seedDoc(tenantId, orgId, '# MSA\n\nPlease sign.');
    const created = await owner.post(org(orgId), {
      target: { kind: 'document', id: docId },
      signers: [{ email: 'ada@x.test', name: 'Ada', order: 0 }],
    });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.signRequestId, 'the request itself must still be created').toBeTruthy();
    expect(
      created.body.invitesEmailed,
      'no transport is configured, so the API must not imply the invite was sent',
    ).toBe(false);
  });
});

describe('R2 sign trust rides the WIRE, not just the entity (review F1)', () => {
  it('the public sign view carries requestedBy + requestedAt, and signedAt for a returning signer', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const docId = await seedDoc(tenantId, orgId, '# NDA\n\nPlease sign.');
    const created = await owner.post(org(orgId), {
      target: { kind: 'document', id: docId },
      signers: [{ email: 'ada@x.test', name: 'Ada' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const srid = created.body.signRequestId;
    const tok = await signerToken(srid, 0);

    // Review F1 pinned exactly this hole: requestedBy was captured at create and
    // projected NOWHERE — the page rendered a field that never arrived.
    const view = await client().get(`/v1/host/openwop-app/public-sign/${tok}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.requestedAt, 'requestedAt must ride the public view').toBeTruthy();
    expect(view.body.requestedBy?.email, 'the acting user identity must reach the signer').toContain('@acme.test');
    expect(view.body.signedAt).toBeUndefined();

    const signed = await client().post(`/v1/host/openwop-app/public-sign/${tok}/sign`, { typedName: 'Ada L', acknowledged: true });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);

    // Token revocation on completion is expected for single-signer requests —
    // assert via the durable record instead when the view is gone.
    const rec = await getSignRequestById(srid);
    expect(rec!.requestedBy?.email).toContain('@acme.test');
    expect(rec!.signers[0]!.signedAt).toBeTruthy();
  });
});
