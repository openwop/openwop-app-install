/**
 * ADR 0204 — CMS Phase C, ROUTE-level harness:
 *   C1 lifecycle events (`host.cms.page.*`) fan out through the ONE webhook
 *      delivery pipeline, tenant-scoped (a foreign tenant's subscription never
 *      matches);
 *   C2 scheduled publishing — set/cancel routes (approval-gate 409, validation)
 *      and the sweep (publishes via transitionPage; gate-on-at-fire clears the
 *      schedule fail-closed);
 *   C4 shared sections — CRUD, delivery-time ref resolution, impact listing,
 *      referenced-delete 409;
 *   C5 audit rows (`cms.*`) with `payload.tenantId` stamped;
 *   C6 governed surface verbs — getDraftPage/updateSectionDraft (draft-only)
 *      /submitPage (queues the approval when the gate is ON; no publish verb).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { processScheduledPublishes } from '../src/features/cms/publishSweep.js';
import { buildCmsSurface } from '../src/features/cms/surface.js';
import { hasPendingApprovalForPage } from '../src/host/approvalService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function setToggle(id: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  expect(d, `${id} toggle must be declared`).toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
}

interface Res<T = any> { status: number; headers: Headers; body: T }
interface Client {
  get: (p: string, headers?: Record<string, string>) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
  del: (p: string) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, headers: res.headers, body: out };
  };
  return {
    get: (p, headers) => call('GET', p, undefined, headers),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
  };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:pc-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `pc-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
const u = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${suffix}`;

async function draftPage(owner: Client, orgId: string, title = 'Doc'): Promise<{ pageId: string; slug: string }> {
  const created = await owner.post(u(orgId, '/pages'), { title, sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { pageId: created.body.pageId, slug: created.body.slug };
}

const storage = () => {
  const s = __hostExtStorage();
  expect(s, 'host-ext storage must be wired').toBeTruthy();
  return s!;
};

describe('C1 — lifecycle events → webhook pipeline', () => {
  it('publish fans out to a matching tenant-scoped subscription; a foreign tenant never matches', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const sub = await owner.post('/v1/webhooks', { url: 'https://hooks.example.test/cms', events: ['host.cms.page.published'], tenantId });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);

    const { pageId } = await draftPage(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/publish`));

    const due = await storage().claimDueWebhookDeliveries(`t-${Date.now()}`, Date.now() + 1, 60_000, 50);
    const mine = due.filter((d) => d.eventType === 'host.cms.page.published' && d.payload.includes(pageId));
    expect(mine).toHaveLength(1);
    const payload = JSON.parse(mine[0]!.payload) as { type: string; payload: Record<string, unknown> };
    expect(payload.type).toBe('host.cms.page.published');
    expect(payload.payload.tenantId).toBe(tenantId);
    expect(payload.payload.pageId).toBe(pageId);

    // A DIFFERENT tenant publishing does not hit this subscription.
    const other = await ownerOrg();
    const p2 = await draftPage(other.owner, other.orgId);
    await other.owner.post(u(other.orgId, `/pages/${p2.pageId}/publish`));
    const due2 = await storage().claimDueWebhookDeliveries(`t2-${Date.now()}`, Date.now() + 1, 60_000, 50);
    expect(due2.filter((d) => d.payload.includes(p2.pageId))).toHaveLength(0);
  });
});

describe('C5 — audit rows', () => {
  it('stamps cms.* audit rows with payload.tenantId', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const { pageId } = await draftPage(owner, orgId);
    await owner.post(u(orgId, `/pages/${pageId}/publish`));
    const rows = await storage().listAudit({ actionPrefix: 'cms.', limit: 50 });
    const mine = rows.filter((r) => (r.payload as { pageId?: string })?.pageId === pageId);
    expect(mine.length).toBeGreaterThan(0);
    for (const row of mine) expect((row.payload as { tenantId?: string }).tenantId).toBe(tenantId);
  });
});

describe('C2 — scheduled publishing', () => {
  it('validates and gates the schedule routes', async () => {
    const { owner, orgId } = await ownerOrg();
    const { pageId } = await draftPage(owner, orgId);

    expect((await owner.post(u(orgId, `/pages/${pageId}/schedule`), { at: 'not-a-date' })).status).toBe(400);
    expect((await owner.post(u(orgId, `/pages/${pageId}/schedule`), { at: '2020-01-01T00:00:00Z' })).status).toBe(400);

    await setToggle('cms-approval-gate', 'on');
    try {
      expect((await owner.post(u(orgId, `/pages/${pageId}/schedule`), { at: new Date(Date.now() + 60_000).toISOString() })).status).toBe(409);
    } finally {
      await setToggle('cms-approval-gate', 'off');
    }

    const at = new Date(Date.now() + 60_000).toISOString();
    const ok = await owner.post(u(orgId, `/pages/${pageId}/schedule`), { at });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.scheduledPublishAt).toBe(at);

    const cleared = await owner.del(u(orgId, `/pages/${pageId}/schedule`));
    expect(cleared.status).toBe(200);
    expect(cleared.body.scheduledPublishAt).toBeUndefined();
  });

  it('the sweep publishes a due page through transitionPage (snapshot + clear)', async () => {
    const { owner, orgId } = await ownerOrg();
    const { pageId } = await draftPage(owner, orgId);
    const at = new Date(Date.now() + 5_000).toISOString();
    expect((await owner.post(u(orgId, `/pages/${pageId}/schedule`), { at })).status).toBe(200);

    await processScheduledPublishes(Date.now() + 10_000);

    const page = await owner.get(u(orgId, `/pages/${pageId}`));
    expect(page.body.status).toBe('published');
    expect(page.body.scheduledPublishAt).toBeUndefined();
    const versions = await owner.get(u(orgId, `/pages/${pageId}/versions`));
    expect(versions.body.versions.length).toBeGreaterThan(0); // snapshot captured
  });

  it('fail-closed: the gate turning ON after scheduling skips the publish and clears the schedule', async () => {
    const { owner, orgId } = await ownerOrg();
    const { pageId } = await draftPage(owner, orgId);
    const at = new Date(Date.now() + 5_000).toISOString();
    expect((await owner.post(u(orgId, `/pages/${pageId}/schedule`), { at })).status).toBe(200);

    await setToggle('cms-approval-gate', 'on');
    try {
      await processScheduledPublishes(Date.now() + 10_000);
      const page = await owner.get(u(orgId, `/pages/${pageId}`));
      expect(page.body.status).toBe('draft'); // NOT published around the inbox
      expect(page.body.scheduledPublishAt).toBeUndefined(); // schedule cleared
    } finally {
      await setToggle('cms-approval-gate', 'off');
    }
  });
});

describe('C4 — shared sections', () => {
  it('CRUD + delivery-time ref resolution + impact list + referenced-delete 409', async () => {
    const { owner, orgId } = await ownerOrg();
    const created = await owner.post(u(orgId, '/shared-sections'), { name: 'Footer CTA', type: 'cta', data: { label: 'Try it', url: '/signup', heading: 'Ready?' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sharedSectionId = created.body.sharedSectionId as string;
    expect(sharedSectionId.startsWith('shsec:')).toBe(true);

    // A page inherits it by ref (no own content).
    const page = await owner.post(u(orgId, '/pages'), {
      title: 'Landing',
      sections: [
        { type: 'hero', data: { heading: 'Welcome' } },
        { type: 'cta', data: {}, ref: { sharedSectionId } },
      ],
    });
    expect(page.status, JSON.stringify(page.body)).toBe(201);
    const pageId = page.body.pageId as string;
    const slug = page.body.slug as string;
    expect(page.body.sections[1].ref.sharedSectionId).toBe(sharedSectionId);

    // Impact list names the referencing page.
    const impact = await owner.get(u(orgId, `/shared-sections/${sharedSectionId}/pages`));
    expect(impact.body.pages.map((p: any) => p.pageId)).toEqual([pageId]);

    // Delivery resolves the ref to the SHARED content.
    await owner.post(u(orgId, `/pages/${pageId}/publish`));
    const read = await owner.get(u(orgId, `/pages/by-slug/${slug}`));
    expect(read.status).toBe(200);
    expect(read.body.page.sections[1].data.label).toBe('Try it');

    // Editing the shared section changes what delivery serves (site-wide edit).
    const upd = await owner.patch(u(orgId, `/shared-sections/${sharedSectionId}`), { data: { label: 'Start now', url: '/signup', heading: 'Ready?' } });
    expect(upd.status).toBe(200);
    expect(upd.body.version).toBe(2);
    const read2 = await owner.get(u(orgId, `/pages/by-slug/${slug}`));
    expect(read2.body.page.sections[1].data.label).toBe('Start now');

    // Deleting while referenced 409s.
    expect((await owner.del(u(orgId, `/shared-sections/${sharedSectionId}`))).status).toBe(409);

    // Detach (remove the ref) then delete succeeds. Non-draft edits need the
    // admin tier — the owner has it; unpublish first to follow the edit gate.
    await owner.post(u(orgId, `/pages/${pageId}/unpublish`));
    const detached = await owner.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ type: 'hero', data: { heading: 'Welcome' } }],
    });
    expect(detached.status, JSON.stringify(detached.body)).toBe(200);
    expect((await owner.del(u(orgId, `/shared-sections/${sharedSectionId}`))).status).toBe(204);
  });
});

describe('C6 — governed surface verbs', () => {
  it('getDraftPage reads raw; updateSectionDraft is draft-only; submitPage queues the approval when gated; NO publish verb exists', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const { pageId } = await draftPage(owner, orgId, 'Draftable');
    const surface = buildCmsSurface({ tenantId, runId: 'run:test' }) as Record<string, (args: Record<string, unknown>) => Promise<any>>;

    expect(surface.publishPage).toBeUndefined(); // the rejected verb must not exist
    expect(typeof surface.submitPage).toBe('function');

    const draft = await surface.getDraftPage!({ orgId, pageId });
    expect(draft.page.status).toBe('draft');
    const sectionId = draft.page.sections[0].sectionId as string;
    expect(draft.page.sections[0].data.heading).toBe('Hi');

    // Overlay a locale onto the draft (sanitized like an editor save).
    const upd = await surface.updateSectionDraft!({ orgId, pageId, sectionId, locale: 'pt-BR', data: { heading: 'Oi', url: 'javascript:alert(1)' } });
    expect(upd.updated).toBe(true);
    const viaRoute = await owner.get(u(orgId, `/pages/${pageId}`));
    expect(viaRoute.body.sections[0].localizations['pt-BR'].heading).toBe('Oi');
    expect(viaRoute.body.sections[0].localizations['pt-BR'].url ?? '').toBe(''); // sanitized

    // Submit with the gate ON queues the SAME approval as the editor submit.
    await setToggle('cms-approval-gate', 'on');
    try {
      const sub = await surface.submitPage!({ orgId, pageId });
      expect(sub.submitted).toBe(true);
      expect(sub.status).toBe('in_review');
      expect(await hasPendingApprovalForPage(tenantId, pageId)).toBe(true);
    } finally {
      await setToggle('cms-approval-gate', 'off');
    }

    // Draft-only: the now-in_review page rejects node edits.
    await expect(surface.updateSectionDraft!({ orgId, pageId, sectionId, data: { heading: 'Nope' } })).rejects.toMatchObject({ httpStatus: 409 });
  });
});
