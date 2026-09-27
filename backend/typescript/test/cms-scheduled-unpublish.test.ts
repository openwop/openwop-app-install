/**
 * ADR 0204 C2b — scheduled UNPUBLISH (embargo end), route + sweep harness.
 * The invariants worth pinning:
 *   - set-time legality: published OR paired-with-pending-publish only; the
 *     pair must be strictly publish-then-unpublish
 *   - the approval gate does NOT apply (fail-safe direction — the asymmetry
 *     is deliberate; this test is the tripwire against a symmetry "fix")
 *   - the sweep unpublishes a due published page through transitionPage
 *   - the window-elapsed rule: a pair whose WHOLE window passed while the
 *     instance was down publishes NOTHING (no resurrect-then-yank, no
 *     content live past its embargo)
 *   - leaving published (archive) consumes a pending unpublish schedule
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { processScheduledPublishes, processScheduledUnpublishes } from '../src/features/cms/publishSweep.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u2 = getToggleDefault('users');
  if (u2) await saveConfig({ ...u2, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function setToggle(id: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  expect(d, `${id} toggle must be declared`).toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
}

interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  del: (p: string) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string }> {
  const tenantId = `org:su-${Date.now()}-${n++}`;
  const owner = client();
  expect((await owner.post('/v1/host/openwop-app/test/login', { email: `su-${Date.now()}-${n++}@acme.test`, tenantId })).status).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const u = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${suffix}`;

async function draftPage(owner: Client, orgId: string): Promise<string> {
  const created = await owner.post(u(orgId, '/pages'), { title: 'Doc', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.pageId as string;
}
async function publishedPage(owner: Client, orgId: string): Promise<string> {
  const pageId = await draftPage(owner, orgId);
  expect((await owner.post(u(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
  return pageId;
}
const future = (ms: number): string => new Date(Date.now() + ms).toISOString();

describe('set-time legality', () => {
  it('409s on a plain draft; 400s on bad/past dates; 200s on a published page', async () => {
    const { owner, orgId } = await ownerOrg();
    const draft = await draftPage(owner, orgId);
    expect((await owner.post(u(orgId, `/pages/${draft}/schedule-unpublish`), { at: future(60_000) })).status).toBe(409);

    const pub = await publishedPage(owner, orgId);
    expect((await owner.post(u(orgId, `/pages/${pub}/schedule-unpublish`), { at: 'nope' })).status).toBe(400);
    expect((await owner.post(u(orgId, `/pages/${pub}/schedule-unpublish`), { at: '2020-01-01T00:00:00Z' })).status).toBe(400);
    const at = future(60_000);
    const ok = await owner.post(u(orgId, `/pages/${pub}/schedule-unpublish`), { at });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.scheduledUnpublishAt).toBe(at);

    const cleared = await owner.del(u(orgId, `/pages/${pub}/schedule-unpublish`));
    expect(cleared.status).toBe(200);
    expect(cleared.body.scheduledUnpublishAt).toBeUndefined();
  });

  it('the embargo pair: unpublish must be strictly AFTER the pending publish', async () => {
    const { owner, orgId } = await ownerOrg();
    const pageId = await draftPage(owner, orgId);
    const pubAt = future(60_000);
    expect((await owner.post(u(orgId, `/pages/${pageId}/schedule`), { at: pubAt })).status).toBe(200);
    expect((await owner.post(u(orgId, `/pages/${pageId}/schedule-unpublish`), { at: future(30_000) })).status).toBe(400); // before publish
    const ok = await owner.post(u(orgId, `/pages/${pageId}/schedule-unpublish`), { at: future(120_000) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.scheduledPublishAt).toBe(pubAt); // the pair coexists
  });

  it('the approval gate does NOT block scheduling an unpublish (deliberate asymmetry)', async () => {
    const { owner, orgId } = await ownerOrg();
    const pub = await publishedPage(owner, orgId);
    await setToggle('cms-approval-gate', 'on');
    try {
      const ok = await owner.post(u(orgId, `/pages/${pub}/schedule-unpublish`), { at: future(60_000) });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200); // publish-direction gate; unpublish is fail-safe
    } finally {
      await setToggle('cms-approval-gate', 'off');
    }
  });
});

describe('the sweep unpublish lane', () => {
  it('unpublishes a due published page through transitionPage and consumes the schedule', async () => {
    const { owner, orgId } = await ownerOrg();
    const pub = await publishedPage(owner, orgId);
    expect((await owner.post(u(orgId, `/pages/${pub}/schedule-unpublish`), { at: future(5_000) })).status).toBe(200);

    await processScheduledUnpublishes(Date.now() + 10_000);

    const page = await owner.get(u(orgId, `/pages/${pub}`));
    expect(page.body.status).toBe('draft'); // unpublish → back to draft (the lifecycle's re-edit path)
    expect(page.body.scheduledUnpublishAt).toBeUndefined();
  });

  it('window-elapsed: a pair whose whole window passed publishes NOTHING', async () => {
    const { owner, orgId } = await ownerOrg();
    const pageId = await draftPage(owner, orgId);
    expect((await owner.post(u(orgId, `/pages/${pageId}/schedule`), { at: future(5_000) })).status).toBe(200);
    expect((await owner.post(u(orgId, `/pages/${pageId}/schedule-unpublish`), { at: future(6_000) })).status).toBe(200);

    // Both fire times pass before the next tick (the instance was "down").
    await processScheduledPublishes(Date.now() + 10_000);
    await processScheduledUnpublishes(Date.now() + 10_000);

    const page = await owner.get(u(orgId, `/pages/${pageId}`));
    expect(page.body.status).toBe('draft'); // never resurrected past its window
    expect(page.body.scheduledPublishAt).toBeUndefined();
    expect(page.body.scheduledUnpublishAt).toBeUndefined();
  });

  it('a pair whose unpublish is still future publishes normally and keeps the embargo end', async () => {
    const { owner, orgId } = await ownerOrg();
    const pageId = await draftPage(owner, orgId);
    expect((await owner.post(u(orgId, `/pages/${pageId}/schedule`), { at: future(5_000) })).status).toBe(200);
    expect((await owner.post(u(orgId, `/pages/${pageId}/schedule-unpublish`), { at: future(600_000) })).status).toBe(200);

    await processScheduledPublishes(Date.now() + 10_000);

    const page = await owner.get(u(orgId, `/pages/${pageId}`));
    expect(page.body.status).toBe('published');
    expect(page.body.scheduledPublishAt).toBeUndefined(); // consumed by publish
    expect(page.body.scheduledUnpublishAt).toBeTruthy(); // the embargo end SURVIVES publish
  });

  it('archiving consumes a pending unpublish schedule (leaving published)', async () => {
    const { owner, orgId } = await ownerOrg();
    const pub = await publishedPage(owner, orgId);
    expect((await owner.post(u(orgId, `/pages/${pub}/schedule-unpublish`), { at: future(60_000) })).status).toBe(200);
    expect((await owner.post(u(orgId, `/pages/${pub}/archive`))).status).toBe(200);
    const page = await owner.get(u(orgId, `/pages/${pub}`));
    expect(page.body.status).toBe('archived');
    expect(page.body.scheduledUnpublishAt).toBeUndefined();
  });
});
