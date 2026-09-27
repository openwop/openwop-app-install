/**
 * ADR 0657 D4 / D6 / D7 at the HTTP boundary (createApp + crafted cookies):
 *  - DSAR delete + readmit require `host:members:manage` (an editor gets 403 — before this
 *    ADR any `workspace:write` holder could erase anyone in the workspace);
 *  - readmit validates the attestation (400), reports `not_erased` informationally, and
 *    clears the tombstone so the next public opt-in lands;
 *  - the public capture never mints a token on an empty body (400) and answers 429 once
 *    the per-org budget is spent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { recordConsent, isErasureTombstoned, getConsent } from '../src/features/consent/consentService.js';
import { __resetOrgCaptureBudgetForTests } from '../src/features/consent/routes.js';

let BASE = '';
let server: http.Server;
let ws = '';
let editorCookie = '';
let adminCookie = '';

const craftCookie = (userId: string, activeTenant: string, personalTenant: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: activeTenant, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
const seat = async (principalId: string, roles: string[]): Promise<string> => {
  const user = await upsertFromPrincipal({ tenantId: ws, principalId, source: 'oidc' });
  await createMember({ tenantId: ws, orgId: ws, subject: user.userId, displayName: principalId, roles });
  return craftCookie(user.userId, ws, `ws:home-${principalId}`);
};
const call = async (method: string, path: string, cookie: string | null, body?: unknown): Promise<{ status: number; body: any; headers: Headers }> => {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
};
const ORG = () => `/v1/host/openwop-app/consent/orgs/${ws}`;
const PUB = () => `/v1/host/openwop-app/public-consent/${ws}`;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'consent']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  ws = (await createWorkspace({ name: 'Consent Readmit', ownerSubject: 'oidc:cr-owner' })).tenantId;
  editorCookie = await seat('oidc:cr-editor', ['editor']);
  adminCookie = await seat('oidc:cr-admin', ['admin']);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('D6 — ONE authority for both erase doors', () => {
  it('an EDITOR (workspace:write, no host:members:manage) gets 403 on DELETE and on readmit; nothing changes', async () => {
    await recordConsent({ tenantId: ws, subjectKey: 'victim', categories: { marketing: true }, source: 'test' });
    const del = await call('DELETE', `${ORG()}/subjects/victim`, editorCookie);
    expect(del.status).toBe(403);
    expect(del.body.error).toBe('forbidden_scope');
    expect(await getConsent(ws, 'victim'), 'the editor erased nothing').not.toBeNull();
    expect(await isErasureTombstoned(ws, 'victim')).toBe(false);
    const re = await call('POST', `${ORG()}/subjects/victim/readmit`, editorCookie, { attestation: 'The subject asked to return, honestly.' });
    expect(re.status).toBe(403);
    expect(re.body.error).toBe('forbidden_scope');
  });
  it('an ADMIN erases (200) and the receipt is honest; a second erase is a repeat, not a flip', async () => {
    const del = await call('DELETE', `${ORG()}/subjects/victim`, adminCookie);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    expect(del.body.consentRecord).toBe(true);
    expect(await isErasureTombstoned(ws, 'victim')).toBe(true);
    const again = await call('DELETE', `${ORG()}/subjects/victim`, adminCookie);
    expect(again.status).toBe(200);
    expect(again.body.consentRecord).toBe(false);
  });
});

describe('D7 — the readmit door', () => {
  it('short attestation ⇒ 400; not erased ⇒ 200 informational; erased ⇒ cleared, and the next public opt-in LANDS', async () => {
    const short = await call('POST', `${ORG()}/subjects/victim/readmit`, adminCookie, { attestation: 'too short' });
    expect(short.status).toBe(400);
    expect(short.body.error).toBe('validation_error');
    expect(await isErasureTombstoned(ws, 'victim'), 'a refused readmit clears nothing').toBe(true);

    const none = await call('POST', `${ORG()}/subjects/never-erased/readmit`, adminCookie, { attestation: 'This person was never erased; probing the door.' });
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ ok: true, readmitted: false, tombstonesCleared: 0, reason: 'not_erased' });

    const ok = await call('POST', `${ORG()}/subjects/victim/readmit`, adminCookie, { attestation: 'The subject emailed support asking to hear from us again.' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, readmitted: true, tombstonesCleared: 1, subjectKey: 'victim' });
    expect(await isErasureTombstoned(ws, 'victim')).toBe(false);
    expect(await getConsent(ws, 'victim'), 'readmit granted nothing').toBeNull();
  });
});

describe('D4 — the public capture', () => {
  it('an empty body mints NO token (400 validation_error); a real body mints one (201)', async () => {
    const empty = await call('POST', PUB(), null, {});
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('validation_error');
    expect(empty.body.subjectToken).toBeUndefined();
    const noBools = await call('POST', PUB(), null, { categories: { marketing: 'yes' } });
    expect(noBools.status).toBe(400);
    const real = await call('POST', PUB(), null, { categories: { marketing: true } });
    expect(real.status).toBe(201);
    expect(typeof real.body.subjectToken).toBe('string');
  });
  it('the per-org budget answers 429 + Retry-After after the org resolved; unknown orgs stay a uniform 404', async () => {
    process.env.OPENWOP_CONSENT_CAPTURE_ORG_REQS_PER_MIN = '2';
    __resetOrgCaptureBudgetForTests();
    try {
      expect((await call('POST', PUB(), null, { categories: { marketing: true } })).status).toBe(201);
      expect((await call('POST', PUB(), null, { categories: { marketing: true } })).status).toBe(201);
      const third = await call('POST', PUB(), null, { categories: { marketing: true } });
      expect(third.status).toBe(429);
      expect(third.headers.get('retry-after')).toBe('60');
      expect((await call('POST', `/v1/host/openwop-app/public-consent/ws:does-not-exist`, null, { categories: { marketing: true } })).status).toBe(404);
    } finally {
      delete process.env.OPENWOP_CONSENT_CAPTURE_ORG_REQS_PER_MIN;
      __resetOrgCaptureBudgetForTests();
    }
  });
});
