/**
 * ADR 0959 P4 — playbook content (a CMS page, an email template, a brand preset) installed into
 * the client org through the OWNERS' adapters, through the HTTP boundary.
 *
 * Exit criteria (ADR 0959 phase table, P4): each adapter's plan/diff is pure; apply is idempotent
 * per (rollout, orgId, slot).
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - the mapping's applied-hash short-circuit removed (a repeat apply updates again)   → "idempotent"
 *  - the create claim skipped (`put` in place of `putIfAbsent`)                         → "two concurrent applies"
 *  - the edited-content check removed                                                   → "an edited template"
 *  - the CMS adapter not reporting a live page as locked                                → "a live page"
 *  - planContent writing the mapping (an impure plan)                                   → "zero writes"
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { getPage, transitionPage } from '../src/features/cms/cmsService.js';
import { getTemplate, updateTemplate } from '../src/features/email/emailService.js';
import { listBrands, getBrand, updateBrand } from '../src/features/brand/brandService.js';
import { applyContent } from '../src/features/campaign-playbooks/contentService.js';
import { getInstallation } from '../src/features/campaign-playbooks/installService.js';
import { getVersion } from '../src/features/campaign-playbooks/playbookStore.js';

let BASE = '';
let server: http.Server;
let storage: Storage;
let TENANT = '';
const orgs: string[] = [];
const cookies = { admin1: '', admin2: '' };
let installed: Res;

interface Res { status: number; body: Record<string, unknown> }
async function call(who: keyof typeof cookies, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${BASE}/host/openwop-app${path}`, { method, headers: { cookie: cookies[who], 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

const chain = (version: string) => ({
  chainId: 'acme.content', version, label: 'Content', description: 'Synthetic.',
  parameters: { type: 'object', properties: {} },
  dag: { nodes: [{ id: 'start', typeId: 'core.flow.noop@1.0.0', config: {}, inputs: { step: version } }], edges: [] },
});
const v1Content = [
  { slot: 'landing', kind: 'cms.page', payload: { title: 'Spring offer', sections: [] } },
  { slot: 'welcome-email', kind: 'email.template', payload: { name: 'Welcome', subject: 'Hello', body: 'Thanks for joining.' } },
  { slot: 'preset', kind: 'brand.preset', payload: { name: 'Local service voice', description: 'Warm and direct.' } },
];
async function publish(version: string, content: unknown[]): Promise<Res> {
  const d = await call('admin1', 'PUT', '/campaign-playbooks/playbooks/content/draft', { title: 'Content', chains: [chain(version)], entryChainId: 'acme.content', overridable: { params: [], slots: [] }, content });
  if (d.status !== 200) return d;
  return call('admin1', 'POST', '/campaign-playbooks/playbooks/content/versions', { version });
}
async function countWrites<T>(fn: () => Promise<T>): Promise<{ out: T; writes: string[] }> {
  const writes: string[] = [];
  const originals = { kvSet: storage.kvSet.bind(storage), kvDelete: storage.kvDelete.bind(storage), kvCompareAndSwap: storage.kvCompareAndSwap.bind(storage) };
  const wrapped = (['kvSet', 'kvDelete', 'kvCompareAndSwap'] as const).map((m) => vi.spyOn(storage, m).mockImplementation(((...args: unknown[]) => {
    const key = String(args[0]);
    if (/campaign-playbooks|cms|email|brand|page|template/.test(key)) writes.push(`${m}:${key}`);
    return (originals[m] as (...a: unknown[]) => unknown)(...args);
  }) as never));
  try { return { out: await fn(), writes }; } finally { for (const w of wrapped) w.mockRestore(); }
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  for (const id of ['campaign-ops', 'campaign-playbooks', 'cms', 'email', 'brand']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  const tag = randomBytes(3).toString('hex');
  TENANT = (await createWorkspace({ name: 'Agency', ownerSubject: `oidc:pb4-owner-${tag}` })).tenantId;
  const now = Math.floor(Date.now() / 1000);
  for (const k of ['admin1', 'admin2'] as const) {
    const u = await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:pb4-${k}-${tag}`, source: 'oidc' });
    await createMember({ tenantId: TENANT, orgId: TENANT, subject: u.userId, displayName: k, roles: ['admin'] });
    cookies[k] = `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId: u.userId, personalTenant: `ws:home-${u.userId}`, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
  }
  for (let i = 0; i < 3; i++) {
    const orgId = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: `Client ${i} (synthetic)` })).orgId;
    await createClient({ tenantId: TENANT, orgId, name: `Client ${i} (synthetic)`, createdBy: 'seed' });
    orgs.push(orgId);
  }
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const contentOf = (r: Res) => r.body.installation as { content: { applied: Array<{ slot: string; resourceId: string; action: string }>; unchanged: string[]; failed: unknown[] } };
const resourceOf = (r: Res, slot: string) => contentOf(r).content.applied.find((a) => a.slot === slot)!.resourceId;

describe('ADR 0959 D5 — content items', () => {
  it('an unknown kind or a bad payload is refused at the draft', async () => {
    const unknown = await publish('1.0.0', [{ slot: 'xx', kind: 'no.such.kind', payload: {} }]);
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(unknown.body)).toContain('content_kind_unknown');
    const bad = await publish('1.0.0', [{ slot: 'xx', kind: 'email.template', payload: { name: '' } }]);
    expect(bad.status).toBe(400);
    expect((await publish('1.0.0', v1Content)).status).toBe(201);
  });

  it('install writes each item into the CLIENT org through its owner', async () => {
    installed = await call('admin1', 'POST', `/campaign-playbooks/clients/${orgs[0]}/installs`, { playbookId: 'content', version: '1.0.0' });
    expect(installed.status, JSON.stringify(installed.body)).toBe(201);
    expect(contentOf(installed).content.applied.map((a) => a.slot).sort()).toEqual(['landing', 'preset', 'welcome-email']);
    const page = await getPage(TENANT, orgs[0]!, resourceOf(installed, 'landing'));
    expect(page).toMatchObject({ title: 'Spring offer', status: 'draft', orgId: orgs[0] });
    expect(await getTemplate(TENANT, orgs[0]!, resourceOf(installed, 'welcome-email'))).toMatchObject({ name: 'Welcome', orgId: orgs[0] });
    expect((await listBrands(TENANT, orgs[0]!)).map((b) => b.name)).toEqual(['Local service voice']);
  });

  it('a repeat apply is idempotent: nothing is written again, nothing is duplicated', async () => {
    const r = await countWrites(() => call('admin1', 'POST', `/campaign-playbooks/clients/${orgs[0]}/installs/content/content`, {}));
    expect(r.out.status, JSON.stringify(r.out.body)).toBe(200);
    expect(r.out.body.content).toMatchObject({ applied: [], unchanged: ['landing', 'welcome-email', 'preset'] });
    expect(r.writes.filter((w) => !w.includes('rate')), 'a repeat apply wrote').toEqual([]);
    expect(await listBrands(TENANT, orgs[0]!)).toHaveLength(1);
  });

  it('two concurrent applies create each item once', async () => {
    const pub = async (version: string, content: unknown[]) => {
      expect((await call('admin1', 'PUT', '/campaign-playbooks/playbooks/race/draft', { title: 'Race', chains: [chain(version)], entryChainId: 'acme.content', overridable: { params: [], slots: [] }, content })).status).toBe(200);
      expect((await call('admin1', 'POST', '/campaign-playbooks/playbooks/race/versions', { version })).status).toBe(201);
    };
    await pub('1.0.0', []);
    expect((await call('admin1', 'POST', `/campaign-playbooks/clients/${orgs[2]}/installs`, { playbookId: 'race', version: '1.0.0' })).status).toBe(201);
    await pub('2.0.0', [{ slot: 'raced', kind: 'brand.preset', payload: { name: 'Raced preset' } }]);
    const row = (await getInstallation(TENANT, orgs[2]!, 'race'))!;
    const version = (await getVersion(TENANT, 'race', '2.0.0'))!;
    // In-process, so the two interleave at every storage await: without the create claim both
    // would find no mapping and both would create a brand.
    const results = await Promise.all([applyContent(row, version, 'u'), applyContent(row, version, 'u')]);
    expect(results.flatMap((r) => r.applied).filter((a) => a.slot === 'raced'), JSON.stringify(results)).toHaveLength(1);
    expect((await listBrands(TENANT, orgs[2]!)).filter((b) => b.name === 'Raced preset')).toHaveLength(1);
  });
});

describe('ADR 0959 D5 + D6 — content in a rollout', () => {
  let rolloutId = '';
  let approvalId = '';
  it('the plan shows each item\'s action and makes zero writes', async () => {
    expect((await publish('2.0.0', [
      { slot: 'landing', kind: 'cms.page', payload: { title: 'Summer offer', sections: [] } },
      v1Content[1]!,
    ])).status).toBe(201);
    const { out, writes } = await countWrites(() => call('admin1', 'POST', '/campaign-playbooks/playbooks/content/rollouts/plan', { toVersion: '2.0.0', orgIds: [orgs[0]!] }));
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(writes, 'the plan wrote').toEqual([]);
    const target = (out.body.plan as Array<{ class: string; contentDiff: Array<{ slot: string; action: string; fields: string[] }> }>)[0]!;
    expect(target.class).toBe('clean');
    expect(target.contentDiff).toEqual(expect.arrayContaining([
      expect.objectContaining({ slot: 'landing', action: 'update', fields: ['title'] }),
      expect.objectContaining({ slot: 'welcome-email', action: 'unchanged' }),
      expect.objectContaining({ slot: 'preset', action: 'removed' }),
    ]));
  });

  it('an edited template makes the client detached; overwrite replaces it', async () => {
    const templateId = resourceOf(installed, 'welcome-email');
    await updateTemplate(TENANT, orgs[0]!, templateId, { body: 'Edited by the client.' }, { actor: 'client' });
    // The 2.0.0 template is unchanged, so publish 3.0.0 with a new body to make an update.
    expect((await publish('3.0.0', [{ slot: 'welcome-email', kind: 'email.template', payload: { name: 'Welcome', subject: 'Hello', body: 'New welcome.' } }])).status).toBe(201);
    const plan = await call('admin1', 'POST', '/campaign-playbooks/playbooks/content/rollouts/plan', { toVersion: '3.0.0', orgIds: [orgs[0]!] });
    const t = (plan.body.plan as Array<{ class: string; contentDiff: Array<{ slot: string; edited: boolean }> }>)[0]!;
    expect(t.class).toBe('detached');
    expect(t.contentDiff.find((c) => c.slot === 'welcome-email')!.edited).toBe(true);
    const created = await call('admin1', 'POST', '/campaign-playbooks/playbooks/content/rollouts', { toVersion: '3.0.0', orgIds: [orgs[0]!] });
    rolloutId = (created.body.rollout as { rolloutId: string }).rolloutId;
    approvalId = (created.body.approval as { approvalId: string }).approvalId;
    expect((await call('admin2', 'POST', `/approvals/${approvalId}/claim`, {})).status).toBe(200);
    const refused = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rolloutId}/targets/${orgs[0]}/apply`, {});
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('detached_needs_overwrite');
    const ok = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rolloutId}/targets/${orgs[0]}/apply`, { overwrite: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await getTemplate(TENANT, orgs[0]!, templateId))!.body).toBe('New welcome.');
  });

  it('a live page is never changed by a playbook', async () => {
    const r = await call('admin1', 'POST', `/campaign-playbooks/clients/${orgs[1]}/installs`, { playbookId: 'content', version: '1.0.0' });
    expect(r.status).toBe(201);
    const pageId = resourceOf(r, 'landing');
    await transitionPage(TENANT, orgs[1]!, pageId, 'publish', 'client');
    const plan = await call('admin1', 'POST', '/campaign-playbooks/playbooks/content/rollouts/plan', { toVersion: '2.0.0', orgIds: [orgs[1]!] });
    const t = (plan.body.plan as Array<{ class: string; contentDiff: Array<{ slot: string; locked?: string }> }>)[0]!;
    expect(t.class).toBe('detached');
    expect(t.contentDiff.find((c) => c.slot === 'landing')!.locked).toBeTruthy();
    const created = await call('admin1', 'POST', '/campaign-playbooks/playbooks/content/rollouts', { toVersion: '2.0.0', orgIds: [orgs[1]!] });
    const rid = (created.body.rollout as { rolloutId: string }).rolloutId;
    expect((await call('admin2', 'POST', `/approvals/${(created.body.approval as { approvalId: string }).approvalId}/claim`, {})).status).toBe(200);
    const applied = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/targets/${orgs[1]}/apply`, { overwrite: true });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(JSON.stringify(applied.body.content)).toContain('content_locked');
    expect((await getPage(TENANT, orgs[1]!, pageId))!.title).toBe('Spring offer');
  });
});

describe('ADR 0959 recovery — owner CAS and unknown content outcomes', () => {
  async function fixture(initial: boolean) {
    const id = `recovery-${randomBytes(4).toString('hex')}`;
    const orgId = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Content recovery client' })).orgId;
    await createClient({ tenantId: TENANT, orgId, name: 'Content recovery client', createdBy: 'seed' });
    const pub = async (version: string, name?: string) => {
      expect((await call('admin1', 'PUT', `/campaign-playbooks/playbooks/${id}/draft`, { title: 'Recovery', chains: [chain(version)], entryChainId: 'acme.content', overridable: { params: [], slots: [] }, content: name ? [{ slot: 'brand', kind: 'brand.preset', payload: { name } }] : [] })).status).toBe(200);
      expect((await call('admin1', 'POST', `/campaign-playbooks/playbooks/${id}/versions`, { version })).status).toBe(201);
    };
    await pub('1.0.0', initial ? 'Initial voice' : undefined);
    const installed = await call('admin1', 'POST', `/campaign-playbooks/clients/${orgId}/installs`, { playbookId: id, version: '1.0.0' });
    expect(installed.status, JSON.stringify(installed.body)).toBe(201);
    await pub('2.0.0', 'Updated voice');
    return { orgId, install: (await getInstallation(TENANT, orgId, id))!, version: (await getVersion(TENANT, id, '2.0.0'))! };
  }

  it('a lost brand-create acknowledgement cannot mint another preset on retry', async () => {
    const t = await fixture(false);
    const original = storage.kvCompareAndSwap.bind(storage);
    let injected = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const out = await original(key, expected, next);
      if (!injected && key.startsWith('hostext:brand:brand:') && JSON.parse(next).orgId === t.orgId && out.swapped) { injected = true; throw new Error('lost brand create acknowledgement'); }
      return out;
    });
    try { expect((await applyContent(t.install, t.version, 'operator')).failed).toHaveLength(1); } finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    expect(await listBrands(TENANT, t.orgId)).toHaveLength(1);
    const claim = (await storage.kvList(`hostext:campaign-playbooks:content:${TENANT}::${t.orgId}::`))[0]!;
    await storage.kvSet(claim.key, JSON.stringify({ ...JSON.parse(claim.value), claimedAt: '2000-01-01T00:00:00.000Z' }));
    const retry = await applyContent(t.install, t.version, 'operator');
    expect(retry.failed).toEqual([expect.objectContaining({ reason: 'content_outcome_unconfirmed' })]);
    expect(await listBrands(TENANT, t.orgId)).toHaveLength(1);
  });

  it('a brand edit between the plan read and write survives; replacement needs a fresh explicit overwrite', async () => {
    const t = await fixture(true);
    const brand = (await listBrands(TENANT, t.orgId))[0]!;
    const original = storage.kvCompareAndSwap.bind(storage);
    let injected = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!injected && key === `hostext:brand:brand:${TENANT}::${brand.id}` && JSON.parse(next).name === 'Updated voice') {
        injected = true; await updateBrand(TENANT, brand.id, { name: 'Human voice' }, 'human');
      }
      return original(key, expected, next);
    });
    try { expect((await applyContent(t.install, t.version, 'operator')).failed).toHaveLength(1); } finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    expect((await getBrand(TENANT, brand.id))?.name).toBe('Human voice');
    expect((await applyContent(t.install, t.version, 'operator')).failed).toEqual([expect.objectContaining({ reason: 'content_outcome_unconfirmed' })]);
    expect((await getBrand(TENANT, brand.id))?.name).toBe('Human voice');
    expect((await applyContent(t.install, t.version, 'operator', { overwrite: true })).applied).toHaveLength(1);
    expect((await getBrand(TENANT, brand.id))?.name).toBe('Updated voice');
  });
});
