/**
 * ADR 1141 (#6034) — a share link bound to one recipient opens only for a browser
 * session that entered the code emailed to that recipient.
 *
 * Over HTTP, with the real gate (`resolveActiveLink`), the real code store and the
 * real limiters. The mail lane is replaced by an in-memory outbox
 * (`__setShareCodeMailForTest`), so the test can read the code a recipient would.
 * Each case uses its own tenant, link and IP so the shared limiters never couple
 * cases.
 *
 * Red when: the gate in `resolveActiveLink` is removed (the forwarded-link case);
 * `checkCode` stops consuming a code (single-use); `issueCode` stops replacing the
 * pending code (resend); the lock stops at five (lock); the send cap is removed;
 * an unknown or unbound token answers the code routes differently (uniform);
 * revocation stops clearing verified sessions (revoke).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createPage } from '../src/features/cms/cmsService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { createLink, eraseSharingRecipient, listLinks, revokeLink, unlockLinkVerification } from '../src/features/sharing/sharingService.js';
import { __setShareCodeMailForTest } from '../src/features/sharing/shareCodeMail.js';
import { __lastShareCodeDeliveryForTest } from '../src/features/sharing/recipientVerification.js';
import { __resetVerificationStoreForTest } from '../src/features/sharing/verificationStore.js';

let BASE = '';
let server: http.Server;
let storage: Storage;
let n = 0;
const outbox: Array<{ tenantId: string; to: string; code: string }> = [];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['crm', 'cms']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
beforeEach(async () => { outbox.length = 0; __setShareCodeMailForTest({ ready: true, sent: outbox }); await __resetVerificationStoreForTest(); });
afterEach(() => { vi.useRealTimers(); __setShareCodeMailForTest(undefined); });
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** A browser: keeps its own `__session` cookie and its own client IP. */
function browser(ip = `10.0.${n % 250}.${(n++ % 250) + 1}`) {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m?.[1]) cookie = m[1]; }
    const text = res.status === 204 ? '' : await res.text();
    let out: unknown = {};
    try { out = text ? JSON.parse(text) : {}; } catch { out = { text }; }
    return { status: res.status, body: out as Record<string, unknown> };
  };
  return {
    open: (token: string) => call('GET', `/host/openwop-app/shared/${token}`),
    request: async (token: string) => { const r = await call('POST', `/host/openwop-app/shared/${token}/verification`); await __lastShareCodeDeliveryForTest(); return r; },
    verify: (token: string, code: string) => call('POST', `/host/openwop-app/shared/${token}/verification/verify`, { code }),
  };
}

/** A tenant with a page, a contact, and a link of that page bound to the contact. */
async function fixture(opts: { verify?: boolean } = { verify: true }) {
  const T = `org:adr1141-${Date.now()}-${n++}`;
  const org = await createOrg({ tenantId: T, createdBy: 'owner-1', name: 'Casa Studio' });
  const MINTER = 'system:casavoga-portal'; // a visitor-lane mint is the host's own
  const page = await createPage({ tenantId: T, orgId: org.orgId, title: 'Your project portal', createdBy: 'owner-1', sections: [{ type: 'richText', data: { text: 'Budget: 42,000' } }] });
  const contact = await createContact({ tenantId: T, name: 'Ana Client', email: 'ana@client.test' });
  const link = await createLink(T, org.orgId, MINTER, {
    resourceType: 'cms_page', resourceId: page.pageId, label: 'Ana portal',
    ...(opts.verify ? { recipient: { contactId: contact.contactId }, verify: {} } : {}),
  }, { lane: 'visitor', why: 'a client portal (CasaVoga CV-0222 D4)' });
  return { T, orgId: org.orgId, token: link.token, tokenHash: link.tokenHash };
}

const lastCode = (): string => outbox[outbox.length - 1]!.code;

describe('ADR 1141 — a recipient-bound link opens only after the emailed code', () => {
  it('an unbound link is unchanged', async () => {
    const f = await fixture({ verify: false });
    expect((await browser().open(f.token)).status).toBe(200);
  });

  it('before the code: a neutral 401 with the firm and the masked address, nothing from the page', async () => {
    const f = await fixture();
    const r = await browser().open(f.token);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('share_verification_required');
    expect(r.body.details).toEqual({ orgDisplayName: 'Casa Studio', maskedEmail: 'a•••@client.test' });
    const raw = JSON.stringify(r.body);
    for (const leak of ['Ana portal', 'Your project portal', 'Budget', 'cms_page']) expect(raw, leak).not.toContain(leak);
  });

  it('the recipient opens it with the code; a forwarded copy in another browser does not', async () => {
    const f = await fixture();
    const ana = browser();
    expect((await ana.open(f.token)).status).toBe(401);
    expect((await ana.request(f.token)).status).toBe(202);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe('ana@client.test');
    expect((await ana.verify(f.token, lastCode())).status).toBe(204);
    expect((await ana.open(f.token)).status).toBe(200);
    expect((await browser().open(f.token)).status, 'a forwarded link').toBe(401);
  });

  it('a code works once', async () => {
    const f = await fixture();
    const ana = browser();
    await ana.request(f.token);
    const code = lastCode();
    expect((await ana.verify(f.token, code)).status).toBe(204);
    const other = browser();
    await other.open(f.token);
    expect((await other.verify(f.token, code)).status).toBe(400);
  });

  it('a new code voids the previous one', async () => {
    const f = await fixture();
    const ana = browser();
    await ana.request(f.token);
    const first = lastCode();
    await ana.request(f.token);
    const second = lastCode();
    expect(second).not.toBe(first);
    if (first !== second) expect((await ana.verify(f.token, first)).status).toBe(400);
    expect((await ana.verify(f.token, second)).status).toBe(204);
  });

  it('a code expires after 10 minutes', async () => {
    const f = await fixture();
    const ana = browser();
    await ana.request(f.token);
    const code = lastCode();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1_000);
    expect((await ana.verify(f.token, code)).status).toBe(400);
  });

  it('the fifth wrong code locks the link and tells the creator only; the owner can unlock it', async () => {
    const f = await fixture();
    const ana = browser();
    await ana.request(f.token);
    const right = lastCode();
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await ana.verify(f.token, wrong)).status).toBe(400);
    const locked = await ana.open(f.token);
    expect(locked.status).toBe(423);
    expect(locked.body.error).toBe('share_verification_locked');
    expect((await ana.verify(f.token, right)).status, 'the lock also spent the code').toBe(400);
    const notes = await storage.listNotifications({ tenantId: f.T, limit: 50 });
    const lockNotes = notes.filter((x) => x.type === 'openwop-app.sharing.link-locked');
    // A host-minted (system:) link has no person as creator: the admins are told.
    expect(lockNotes.length).toBeGreaterThan(0);
    expect(lockNotes.every((x) => x.recipientUserId !== 'ana@client.test')).toBe(true);
    expect(outbox, 'the recipient is not emailed about a lock').toHaveLength(1);
    expect((await ana.request(f.token)).status, 'a locked link sends nothing').toBe(202);
    expect(outbox).toHaveLength(1);
    await unlockLinkVerification(f.T, f.orgId, f.tokenHash);
    expect((await ana.open(f.token)).status).toBe(401);
  });

  it('code requests are capped per link, apart from the lock (no email bombing)', async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) expect((await browser().request(f.token)).status).toBe(202);
    const fourth = await browser().request(f.token);
    expect(fourth.status).toBe(429);
    expect(outbox).toHaveLength(3);
  });

  it('unknown, revoked, unbound and bound tokens answer the code routes the same way', async () => {
    const bound = await fixture();
    const unbound = await fixture({ verify: false });
    const revoked = await fixture();
    await revokeLink(revoked.T, revoked.orgId, revoked.token);
    const unknown = 'shr_definitelynotarealtoken0000000000000000';
    const answers = [];
    for (const token of [bound.token, unbound.token, revoked.token, unknown]) {
      const b = browser();
      const req = await b.request(token);
      const ver = await b.verify(token, '123456');
      answers.push({ req: [req.status, req.body], ver: [ver.status, ver.body.error, ver.body.message] });
    }
    for (const a of answers.slice(1)) expect(a).toEqual(answers[0]);
  });

  it('revoking the link deletes its pending code and every verified session', async () => {
    const f = await fixture();
    const ana = browser();
    await ana.request(f.token);
    await ana.verify(f.token, lastCode());
    await ana.request(f.token); // a fresh pending code too
    const rows = async (): Promise<number> =>
      (await storage.kvList('hostext:sharing:verified:')).filter((r) => r.key.includes(f.tokenHash)).length
      + (await storage.kvList('hostext:sharing:verify-code:')).filter((r) => r.key.includes(f.tokenHash)).length;
    expect(await rows()).toBe(2);
    await revokeLink(f.T, f.orgId, f.token);
    expect(await rows()).toBe(0);
    expect((await ana.open(f.token)).status).toBe(404);
  });

  it('mint refuses verification without a recipient, or when no mail lane is set up', async () => {
    const T = `org:adr1141-mint-${Date.now()}`;
    const org = await createOrg({ tenantId: T, createdBy: 'owner-1', name: 'Casa' });
    const page = await createPage({ tenantId: T, orgId: org.orgId, title: 'P', createdBy: 'owner-1' });
    await expect(createLink(T, org.orgId, 'owner-1', { resourceType: 'cms_page', resourceId: page.pageId, verify: {} })).rejects.toMatchObject({ httpStatus: 400 });
    __setShareCodeMailForTest({ ready: false, sent: outbox });
    await expect(createLink(T, org.orgId, 'owner-1', { resourceType: 'cms_page', resourceId: page.pageId, recipient: { email: 'x@y.test' }, verify: {} }))
      .rejects.toMatchObject({ code: 'share_verification_unavailable', httpStatus: 422 });
  });

  it('erasing the recipient (by address or by contactId) revokes the link, ends its sessions, then drops the address', async () => {
    for (const key of ['ANA@client.test', 'contact']) {
      const f = await fixture();
      const ana = browser();
      await ana.request(f.token);
      await ana.verify(f.token, lastCode());
      expect((await ana.open(f.token)).status).toBe(200);
      const raw = await storage.kvGet(`hostext:sharing:link:${f.tokenHash}`);
      const contactId = raw ? (JSON.parse(raw) as { recipient?: { contactId?: string } }).recipient?.contactId : undefined;
      const subject = key === 'contact' ? String(contactId) : key;
      const out = await eraseSharingRecipient(f.T, subject);
      expect(out, subject).toEqual({ revoked: 1, scrubbed: 1 });
      expect((await ana.open(f.token)).status).toBe(404);
      const after = await storage.kvGet(`hostext:sharing:link:${f.tokenHash}`);
      expect(after ?? '').not.toContain('ana@client.test');
      expect(after ?? '').not.toContain('recipient');
      expect((await storage.kvList('hostext:sharing:verified:')).filter((r) => r.key.includes(f.tokenHash))).toHaveLength(0);
    }
  });

  it('the management list masks an email recipient and never lists the address hash', async () => {
    const T = `org:adr1141-list-${Date.now()}`;
    const org = await createOrg({ tenantId: T, createdBy: 'owner-1', name: 'Casa' });
    const page = await createPage({ tenantId: T, orgId: org.orgId, title: 'P', createdBy: 'owner-1' });
    await createLink(T, org.orgId, 'system:portal', { resourceType: 'cms_page', resourceId: page.pageId, recipient: { email: 'bea@client.test' }, verify: {} }, { lane: 'visitor', why: 'test' });
    const rows = JSON.stringify(await listLinks(T, org.orgId, 'owner-1'));
    expect(rows).toContain('b•••@client.test');
    expect(rows).not.toContain('bea@client.test');
    expect(rows).not.toContain('recipientEmailHash');
  });

  it('a refused verify hands a cookie-less caller no session; a successful one does', async () => {
    const f = await fixture();
    await browser().request(f.token);
    const code = lastCode();
    const post = (c: string) => fetch(`${BASE}/host/openwop-app/shared/${f.token}/verification/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' }, body: JSON.stringify({ code: c }),
    });
    const wrong = await post(code === '000000' ? '111111' : '000000');
    expect(wrong.status).toBe(400);
    expect(getSetCookies(wrong.headers).some((c) => c.startsWith('__session='))).toBe(false);
    const right = await post(code);
    expect(right.status).toBe(204);
    expect(getSetCookies(right.headers).some((c) => c.startsWith('__session='))).toBe(true);
  });

  it('every read of a bound link is private, no-store: verified or not, the CDN keeps nothing', async () => {
    const f = await fixture();
    let cookie = '';
    const get = async (): Promise<Response> => fetch(`${BASE}/host/openwop-app/shared/${f.token}`, { headers: cookie ? { cookie } : {} });
    const before = await get();
    expect(before.status).toBe(401);
    expect(before.headers.get('cache-control')).toBe('private, no-store');
    await browser().request(f.token);
    const v = await fetch(`${BASE}/host/openwop-app/shared/${f.token}/verification/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: lastCode() }) });
    expect(v.status).toBe(204);
    expect(v.headers.get('cache-control')).toBe('private, no-store');
    for (const c of getSetCookies(v.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m?.[1]) cookie = m[1]; }
    const after = await get();
    expect(after.status).toBe(200);
    expect(after.headers.get('cache-control'), 'a verified view must never be cached for the next visitor').toBe('private, no-store');
  });
});
