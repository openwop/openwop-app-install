/**
 * CMSGAP-1 — the translator-grant narrowing (ADR 0205 D1) binds the WORKFLOW
 * path: the `ctx.features.cms` surface a `cms.localize-and-submit` run calls,
 * bound to a granted translator (`scope.actingUserId`), allows the granted
 * locale overlay and 403s a foreign locale, a base-data write, submit and page
 * create — exactly like the HTTP editor path. A SYSTEM run (no acting user) is
 * unchanged.
 *
 * Sabotage-witnessed (w16): disabling the overlay-locale check
 * (`w16g2-chain-grant-overlay`), the submit check (`-submit`) or the create check
 * (`-create`) in `features/cms/surface.ts` turns this case red.
 *
 * CORRECTION (w16, grade-tests): this file used to open with a CMSGAP-5 case that
 * drove `cms.localize-and-submit` through a hand-rolled MINI-SCHEDULER (the edge
 * walk + `{{inputs.*}}` resolution other `*-chain-execution` tests cite as their
 * precedent). That case was cut as a superseded witness: `cms-chain-real-executor.test.ts`
 * runs the same chain through the REAL executor and asserts every one of its claims
 * (read→translate wiring, overlay persisted, `in_review`, ONE pending row). Both
 * paired probes red both files (`w16g2-chain-store-locale-{mini,real}`,
 * `w16g2-chain-surface-queue-{mini,real}`). The pattern itself lives on in the files
 * that copied it.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { getPage, putLocaleGrant } from '../src/features/cms/cmsService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const loc = getToggleDefault('cms-localization');
  if (loc) await saveConfig({ ...loc, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface Client {
  post: <T>(p: string, b?: unknown) => Promise<Res<T>>;
  put: (p: string, b?: unknown) => Promise<Res<unknown>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return { post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:chx-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/host/openwop-app/test/login', { email: `chx-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status).toBe(201);
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
/** A surface verb's `{ updated }` result, read without a cast. */
const wasUpdated = (out: unknown): boolean =>
  typeof out === 'object' && out !== null && 'updated' in out && out.updated === true;
const u = (orgId: string, s = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

describe('cms.localize-and-submit — end-to-end execution', () => {
  it('CMSGAP-1: a granted translator driving the chain is narrowed exactly like the editor path', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR', 'es'] });
    const created = await owner.post<{ pageId: string; sections: Array<{ sectionId: string }> }>(u(orgId, '/pages'), { title: 'Granted', sections: [{ type: 'hero', data: { heading: 'Welcome' } }] });
    expect(created.status).toBe(201);
    const pageId = created.body.pageId;
    const sectionId = created.body.sections[0]!.sectionId;
    await putLocaleGrant(tenantId, orgId, 'user:translator-1', ['pt-BR'], 'test');
    // A grant NARROWS a member (ADR 0205 D1); the translator is in the org, as the
    // HTTP editor path requires and the seam's org floor now does too (ADR 0832).
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'T', subject: 'user:translator-1', roles: ['editor'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);

    // The run carries the translator's durable principal (scope.actingUserId).
    const features = buildFeatureSurfaces({ tenantId, runId: 'run:granted', actingUserId: 'user:translator-1' });
    const cms = features.cms!;

    // Granted locale: the overlay write is allowed…
    const ok = await cms.updateSectionDraft!({ orgId, pageId, sectionId, locale: 'pt-BR', data: { heading: 'Oi' } });
    expect(wasUpdated(ok)).toBe(true);
    expect((await getPage(tenantId, orgId, pageId))?.sections[0]?.localizations?.['pt-BR']).toEqual({ heading: 'Oi' });
    // …a foreign locale is 403, base-data (no locale) is 403, and submit is 403.
    await expect(cms.updateSectionDraft!({ orgId, pageId, sectionId, locale: 'es', data: { heading: 'Hola' } })).rejects.toMatchObject({ httpStatus: 403 });
    await expect(cms.updateSectionDraft!({ orgId, pageId, sectionId, data: { heading: 'HACK' } })).rejects.toMatchObject({ httpStatus: 403 });
    await expect(cms.submitPage!({ orgId, pageId })).rejects.toMatchObject({ httpStatus: 403 });
    await expect(cms.createDraftPage!({ orgId, title: 'Rogue' })).rejects.toMatchObject({ httpStatus: 403 });
    // None of the refused writes landed.
    const afterRefusals = await getPage(tenantId, orgId, pageId);
    expect(afterRefusals?.sections[0]?.localizations?.es).toBeUndefined();
    expect(afterRefusals?.sections[0]?.data.heading).toBe('Welcome');
    expect(afterRefusals?.status).toBe('draft');

    // A SYSTEM run (no actingUserId) is unchanged — no member, no grant.
    const system = buildFeatureSurfaces({ tenantId, runId: 'run:system' }).cms!;
    const sys = await system.updateSectionDraft!({ orgId, pageId, sectionId, locale: 'es', data: { heading: 'Hola' } });
    expect(wasUpdated(sys)).toBe(true);
  });
});
