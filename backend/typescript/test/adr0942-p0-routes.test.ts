/**
 * ADR 0942 P0 — the autonomy policy routes over real HTTP: the campaign override
 * (`…/campaign-orchestration/campaigns/:id/autonomy`) and the client default
 * (`…/campaign-ops/clients/:orgId/autonomy-default`).
 *
 * Setup: a shared `ws:` agency workspace. AGENCY admin = `admin` on the root row.
 * EDITOR = `editor` on client A only. CLIENT ADMIN = `admin` on client A only (no
 * root role). D9: a tighten needs workspace:write; anything not provably at least
 * as strict as BOTH the policy in force and the client default needs
 * host:members:manage on the client org; the client default is agency-admin only.
 *
 * Sabotage notes (each run, 2026-10-20):
 *  - make `loosenNeedsOrgAdmin` return without checking → red (the editor loosens);
 *  - drop the client-default baseline from `loosenedAgainstBaselines` → red (the
 *    editor sets a campaign looser than its client default after tightening it);
 *  - drop `requireAgencyAdmin` from the client-default PUT → red;
 *  - drop the sub-toggle check on the campaign GET → red (served with the toggle off).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { finalizeFromBrief, deleteCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import type { CampaignBrief } from '../src/features/campaign-brief/types.js';
import { listChain } from '../src/host/auditChainService.js';
import { AUTONOMY_TOGGLE, getBinding, presetRules, presetPolicy, findRule } from '../src/host/autonomyPolicy/index.js';
import { eraseAutonomyActors, getPolicyVersion, savePolicy } from '../src/host/autonomyPolicy/store.js';
import type { Storage } from '../src/storage/storage.js';
import { ACTION_CLASSES, REVIEW_STAGES } from '../src/host/autonomyPolicy/types.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let agencyCookie: string;
let editorCookie: string;
let clientAdminCookie: string;
let orgA: string;
let orgB: string;
let campaignA: string;
let campaignB: string;
let storage: Storage;

function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}

interface Res<T> { status: number; body: T; raw: string }
async function call<T = Record<string, unknown>>(cookie: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}/host/openwop-app${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}

interface PolicyView {
  source: string; etag: string; policy: { policyId: string; version: number; hash: string }; clientDefault?: { policyId: string }; direction?: string; loosened?: string[];
  actionClasses?: string[]; presets?: Array<{ id: string }>;
  effective?: Array<{ actionClass: string; stage?: string; rule: { default: { outcome: string }; escalations?: unknown[] }; from: string }>;
}
const campaignPath = (id: string): string => `/campaign-orchestration/campaigns/${id}/autonomy`;
const clientPath = (orgId: string): string => `/campaign-ops/clients/${orgId}/autonomy-default`;

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

function brief(orgId: string, name: string): CampaignBrief {
  return {
    id: `brief-${randomBytes(6).toString('hex')}`, tenantId: TENANT, orgId, name, objective: 'Grow signups',
    personaIds: [], productName: 'P', productDescription: 'D', industryVertical: 'saas',
    channels: [], messaging: {}, status: 'confirmed', kernelStale: false,
  } as unknown as CampaignBrief;
}

async function autonomyAudits(): Promise<Array<Record<string, unknown>>> {
  return (await listChain(TENANT)).filter((e) => String(e.kind).startsWith('campaign.autonomy.')).map((e) => ({ kind: e.kind, ...(e.payload as Record<string, unknown>) }));
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-orchestration', 'campaign-ops']) await setToggle(id, true);
  const ws = await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:aut-owner' });
  TENANT = ws.tenantId;
  const agency = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:aut-agency', source: 'oidc' });
  const editor = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:aut-editor', source: 'oidc' });
  const clientAdmin = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:aut-client-admin', source: 'oidc' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: agency.userId, displayName: 'Agency', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: editor.userId, displayName: 'Editor', roles: ['viewer'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: clientAdmin.userId, displayName: 'Client admin', roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: editor.userId, displayName: 'Editor', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: clientAdmin.userId, displayName: 'Client admin', roles: ['admin'] });
  agencyCookie = cookieFor(agency.userId, 'ws:home-agency');
  editorCookie = cookieFor(editor.userId, 'ws:home-editor');
  clientAdminCookie = cookieFor(clientAdmin.userId, 'ws:home-client-admin');
  // Client A through the real create path (it binds the new client to Guarded).
  expect((await call(agencyCookie, 'POST', '/campaign-ops/clients', { name: 'Client A', orgId: orgA })).status).toBe(201);
  campaignA = (await finalizeFromBrief(TENANT, brief(orgA, 'Spring launch'), 'seed')).id;
  campaignB = (await finalizeFromBrief(TENANT, brief(orgB, 'Other client'), 'seed')).id;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0942 P0 — toggle and visibility', () => {
  it('the routes 404 while the autonomy sub-toggle is off', async () => {
    await setToggle(AUTONOMY_TOGGLE, false);
    expect((await call(editorCookie, 'GET', campaignPath(campaignA))).status).toBe(404);
    expect((await call(agencyCookie, 'GET', clientPath(orgA))).status).toBe(404);
    await setToggle(AUTONOMY_TOGGLE, true);
  });

  it('the client-default routes also AND-gate the sub-toggle\'s parent (ADR 0941 D5)', async () => {
    await setToggle('campaign-orchestration', false);
    expect((await call(agencyCookie, 'GET', clientPath(orgA))).status).toBe(404);
    await setToggle('campaign-orchestration', true);
    expect((await call(agencyCookie, 'GET', clientPath(orgA))).status).toBe(200);
  });

  it('a new client is bound to Guarded; a campaign with no override inherits it', async () => {
    const c = await call<PolicyView>(editorCookie, 'GET', clientPath(orgA));
    expect(c.status, c.raw).toBe(200);
    expect(c.body).toMatchObject({ source: 'client', policy: { policyId: 'preset:guarded', version: 1 } });
    const r = await call<PolicyView>(editorCookie, 'GET', campaignPath(campaignA));
    expect(r.status, r.raw).toBe(200);
    expect(r.body).toMatchObject({ source: 'client', etag: 'none', clientDefault: { policyId: 'preset:guarded' } });
  });

  it('ADR 0942 P5 — the read model carries the class vocabulary and each class\'s effective rule, so the SPA derives nothing', async () => {
    const r = await call<PolicyView>(editorCookie, 'GET', campaignPath(campaignA));
    expect(r.status, r.raw).toBe(200);
    expect(r.body.actionClasses).toEqual([...ACTION_CLASSES]);
    expect(r.body.presets?.map((p) => p.id)).toEqual(['review-everything@1', 'guarded@1', 'autopilot@1']);
    const eff = r.body.effective ?? [];
    // One row per class, and one per review stage for creative.review.
    expect(eff).toHaveLength(ACTION_CLASSES.length - 1 + REVIEW_STAGES.length);
    expect(eff.filter((e) => e.actionClass === 'creative.review').map((e) => e.stage)).toEqual([...REVIEW_STAGES]);
    // Each row is what the resolver itself would find for that class (Guarded's rules, from the preset).
    for (const e of eff) {
      const { rule } = findRule(presetPolicy('guarded@1'), e.actionClass as (typeof ACTION_CLASSES)[number], e.stage as (typeof REVIEW_STAGES)[number] | undefined);
      expect(e.rule.default, `${e.actionClass}:${e.stage ?? ''}`).toEqual(rule?.default);
    }
  });

  it('another client\'s campaign is a 404 to an editor of client A', async () => {
    expect((await call(editorCookie, 'GET', campaignPath(campaignB))).status).toBe(404);
    expect((await call(editorCookie, 'PUT', campaignPath(campaignB), { preset: 'review-everything@1' })).status).toBe(404);
  });
});

describe('ADR 0942 D9 — tighten vs loosen authority on a campaign', () => {
  it('an editor may tighten; it is audited as a tighten', async () => {
    const r = await call<PolicyView>(editorCookie, 'PUT', campaignPath(campaignA), { preset: 'review-everything@1' });
    expect(r.status, r.raw).toBe(200);
    expect(r.body).toMatchObject({ source: 'campaign', direction: 'tighten', loosened: [], policy: { policyId: 'preset:review-everything' } });
    const last = (await autonomyAudits()).at(-1);
    expect(last).toMatchObject({ kind: 'campaign.autonomy.policy-set', orgId: orgA, campaignId: campaignA, direction: 'tighten' });
  });

  it('an editor may not loosen, even back to the client default', async () => {
    const r = await call<{ details?: { reason?: string; loosened?: string[] } }>(editorCookie, 'PUT', campaignPath(campaignA), { preset: 'guarded@1' });
    expect(r.status, r.raw).toBe(403);
    expect(r.raw).toContain('loosen_requires_admin');
    expect(r.raw).toContain('ads.budget');
    const del = await call(editorCookie, 'DELETE', campaignPath(campaignA));
    expect(del.status, del.raw).toBe(403);
  });

  it('the client\'s own admin may loosen; it is audited and stays scoped to that campaign', async () => {
    const r = await call<PolicyView>(clientAdminCookie, 'PUT', campaignPath(campaignA), { preset: 'autopilot@1' });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.direction).toBe('loosen');
    expect(r.body.loosened?.length ?? 0).toBeGreaterThan(0);
    expect((await autonomyAudits()).at(-1)).toMatchObject({ direction: 'loosen', campaignId: campaignA });
    expect((await call<PolicyView>(editorCookie, 'GET', clientPath(orgA))).body.policy.policyId).toBe('preset:guarded');
  });

  it('a campaign may not be set looser than its client default by an editor, even when it tightens what is in force', async () => {
    // In force: autopilot. A custom policy that is stricter than autopilot but drops Guarded's
    // content.publish escalations is looser than the client default ⇒ admin only.
    const rules = presetRules('guarded@1').map((r) => (r.actionClass === 'content.publish' ? { actionClass: r.actionClass, default: r.default } : r));
    const r = await call(editorCookie, 'PUT', campaignPath(campaignA), { name: 'Almost guarded', rules });
    expect(r.status, r.raw).toBe(403);
    expect(r.raw).toContain('content.publish');
  });

  it('tightening an over-loose override is still refused while it stays looser than the client default', async () => {
    // In force: autopilot (set by the client admin above). This is STRICTER than
    // autopilot (plan.approve now approves) but still looser than Guarded, the
    // client default, on e.g. email.campaign-send. Only the client-default baseline catches it.
    const rules = presetRules('autopilot@1').map((r) => (r.actionClass === 'plan.approve'
      ? { actionClass: r.actionClass, default: { outcome: 'approve' as const, approver: { roleRefs: ['owner', 'admin'], requiredApprovals: 1 as const, delegation: 'allowed' as const } } }
      : r));
    const r = await call(editorCookie, 'PUT', campaignPath(campaignA), { name: 'Autopilot, plans reviewed', rules });
    expect(r.status, r.raw).toBe(403);
    expect(r.raw).toContain('email.campaign-send');
    expect(r.raw).not.toContain('plan.approve');
  });

  it('removing a looser override is a tighten an editor may make', async () => {
    const before = await call<PolicyView>(editorCookie, 'GET', campaignPath(campaignA));
    const r = await call<PolicyView & { removed: boolean }>(editorCookie, 'DELETE', `${campaignPath(campaignA)}?ifMatch=${encodeURIComponent(before.body.etag)}`);
    expect(r.status, r.raw).toBe(200);
    expect(r.body).toMatchObject({ removed: true, direction: 'tighten', source: 'client' });
  });

  it('custom rules are stored as an immutable version; a stale ifMatch is a 409', async () => {
    const rules = presetRules('review-everything@1');
    const a = await call<PolicyView>(editorCookie, 'PUT', campaignPath(campaignA), { name: 'Strict', rules, ifMatch: 'none' });
    expect(a.status, a.raw).toBe(200);
    expect(a.body.policy.policyId).toMatch(/^apol_/);
    expect(a.body.policy.version).toBe(1);
    const b = await call<PolicyView>(editorCookie, 'PUT', campaignPath(campaignA), { name: 'Strict v2', rules, ifMatch: a.body.etag });
    expect(b.status, b.raw).toBe(200);
    expect(b.body.policy.version).toBe(2);
    const stale = await call(editorCookie, 'PUT', campaignPath(campaignA), { name: 'Strict v3', rules, ifMatch: a.body.etag });
    expect(stale.status, stale.raw).toBe(409);
  });

  it('an invalid body is a typed 400, never a silent save', async () => {
    const bad = await call(editorCookie, 'PUT', campaignPath(campaignA), { name: 'Bad', rules: [{ actionClass: 'ads.budget', default: { outcome: 'approve', approver: { subjectRefs: ['u1'], requiredApprovals: 1, delegation: 'allowed' } } }] });
    expect(bad.status, bad.raw).toBe(400);
    expect(bad.raw).toContain('D10.1');
    expect((await call(editorCookie, 'PUT', campaignPath(campaignA), { preset: 'yolo@1' })).status).toBe(400);
    expect((await call(editorCookie, 'PUT', campaignPath(campaignA), { preset: 'guarded@1', surprise: true })).status).toBe(400);
  });
});

describe('ADR 0942 D9 — the client default', () => {
  it('only an agency admin sets it, in either direction', async () => {
    expect((await call(editorCookie, 'PUT', clientPath(orgA), { preset: 'review-everything@1' })).status).toBe(403);
    expect((await call(clientAdminCookie, 'PUT', clientPath(orgA), { preset: 'autopilot@1' })).status).toBe(403);
    const r = await call<PolicyView>(agencyCookie, 'PUT', clientPath(orgA), { preset: 'autopilot@1' });
    expect(r.status, r.raw).toBe(200);
    expect(r.body).toMatchObject({ source: 'client', direction: 'loosen', policy: { policyId: 'preset:autopilot' } });
    expect((await autonomyAudits()).at(-1)).toMatchObject({ kind: 'campaign.autonomy.policy-set', orgId: orgA, direction: 'loosen' });
    expect((await autonomyAudits()).at(-1)).not.toHaveProperty('campaignId');
  });
});

describe('ADR 0942 recovery — conditional override clearing', () => {
  it('an editor cannot clear an admin tightening that replaced the authorized override', async () => {
    expect((await call(agencyCookie, 'PUT', clientPath(orgA), { preset: 'autopilot@1' })).status).toBe(200);
    const id = (await finalizeFromBrief(TENANT, brief(orgA, 'Clear race'), 'seed')).id;
    expect((await call(clientAdminCookie, 'PUT', campaignPath(id), { preset: 'autopilot@1' })).status).toBe(200);
    const cas = storage.kvCompareAndSwap.bind(storage);
    let tightened = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (!tightened && args[0].startsWith('hostext:autonomy:binding:') && args[0].endsWith(`::${id}`)) {
        tightened = true;
        expect((await call(clientAdminCookie, 'PUT', campaignPath(id), { preset: 'review-everything@1' })).status).toBe(200);
      }
      return cas(...args);
    });
    try {
      const cleared = await call(editorCookie, 'DELETE', campaignPath(id));
      expect(cleared.status, cleared.raw).toBe(409);
      expect(cleared.raw).toContain('binding_changed');
    } finally { spy.mockRestore(); }
    expect(tightened).toBe(true);
    expect((await call<PolicyView>(editorCookie, 'GET', campaignPath(id))).body.policy.policyId).toBe('preset:review-everything');
    expect((await autonomyAudits()).filter((a) => a.campaignId === id && a.kind === 'campaign.autonomy.policy-cleared')).toHaveLength(0);
  });

  it('concurrent clears change policy once, inherit honestly, and permit a later override', async () => {
    expect((await call(agencyCookie, 'PUT', clientPath(orgA), { preset: 'autopilot@1' })).status).toBe(200);
    const id = (await finalizeFromBrief(TENANT, brief(orgA, 'Clear once'), 'seed')).id;
    expect((await call(clientAdminCookie, 'PUT', campaignPath(id), { preset: 'autopilot@1' })).status).toBe(200);
    const results = await Promise.all([
      call<{ removed: boolean }>(editorCookie, 'DELETE', campaignPath(id)),
      call<{ removed: boolean }>(editorCookie, 'DELETE', campaignPath(id)),
    ]);
    expect(results.filter((r) => r.status === 200 && r.body.removed)).toHaveLength(1);
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect((await autonomyAudits()).filter((a) => a.campaignId === id && a.kind === 'campaign.autonomy.policy-cleared')).toHaveLength(1);
    const again = await call<{ removed: boolean; source: string; etag: string; dangling: boolean }>(editorCookie, 'DELETE', campaignPath(id));
    expect(again.status, again.raw).toBe(200);
    expect(again.body).toMatchObject({ removed: false, source: 'client', etag: 'none', dangling: false });
    expect((await call(editorCookie, 'PUT', campaignPath(id), { preset: 'review-everything@1', ifMatch: 'none' })).status).toBe(200);
    expect((await call<PolicyView>(editorCookie, 'GET', campaignPath(id))).body.policy.policyId).toBe('preset:review-everything');
  });
});

describe('ADR 0942 — campaign delete cascade', () => {
  it('deleting the campaign removes its override binding', async () => {
    expect(await getBinding(TENANT, orgA, campaignA)).not.toBeNull();
    expect(await deleteCampaign(TENANT, campaignA, 'test')).toBe(true);
    expect(await getBinding(TENANT, orgA, campaignA)).toBeNull();
  });
});


describe('ADR 0942 recovery — erasure preserves concurrent policy edits', () => {
  it('re-reads a replaced binding and erases the actor without restoring the old policy', async () => {
    const actor = `erase-${randomBytes(6).toString('hex')}`;
    const campaignId = `erase-campaign-${randomBytes(6).toString('hex')}`;
    const saved = await savePolicy({ tenantId: TENANT, orgId: orgA, campaignId, input: { kind: 'preset', preset: 'autopilot@1' }, actor, expected: null });
    const cas = storage.kvCompareAndSwap.bind(storage);
    let replaced = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (!replaced && args[0].startsWith('hostext:autonomy:binding:') && args[0].endsWith(`::${campaignId}`)) {
        replaced = true;
        await savePolicy({ tenantId: TENANT, orgId: orgA, campaignId, input: { kind: 'preset', preset: 'review-everything@1' }, actor, expected: saved.binding });
      }
      return cas(...args);
    });
    try { expect(await eraseAutonomyActors(TENANT, new Set([actor]), 'erased')).toBe(1); }
    finally { spy.mockRestore(); }
    expect(replaced).toBe(true);
    expect(await getBinding(TENANT, orgA, campaignId)).toMatchObject({ policyId: 'preset:review-everything', updatedBy: 'erased' });
  });

  it.each(['binding', 'policy'] as const)('reports incomplete erasure when the %s row remains contended, then retries', async (kind) => {
    const actor = `erase-${randomBytes(6).toString('hex')}`;
    const campaignId = `erase-campaign-${randomBytes(6).toString('hex')}`;
    const saved = await savePolicy({ tenantId: TENANT, orgId: orgA, campaignId,
      input: { kind: 'custom', name: 'Keep this policy', basePreset: 'guarded@1', rules: presetRules('guarded@1') }, actor, expected: null });
    const target = kind === 'binding' ? `::${campaignId}` : `::${saved.policy.policyId}::${saved.policy.version}`;
    const cas = storage.kvCompareAndSwap.bind(storage);
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) =>
      args[0].startsWith(`hostext:autonomy:${kind}:`) && args[0].endsWith(target)
        ? { swapped: false, actual: args[1] } : cas(...args));
    try { await expect(eraseAutonomyActors(TENANT, new Set([actor]), 'erased')).rejects.toMatchObject({ details: { reason: 'subject_erasure_conflict' } }); }
    finally { spy.mockRestore(); }
    expect(kind === 'binding' ? (await getBinding(TENANT, orgA, campaignId))?.updatedBy
      : (await getPolicyVersion(TENANT, saved.policy.policyId, saved.policy.version))?.createdBy).toBe(actor);
    await eraseAutonomyActors(TENANT, new Set([actor]), 'erased');
    expect(await getBinding(TENANT, orgA, campaignId)).toMatchObject({ updatedBy: 'erased', policyId: saved.policy.policyId, version: saved.policy.version });
    expect(await getPolicyVersion(TENANT, saved.policy.policyId, saved.policy.version)).toMatchObject({ createdBy: 'erased', name: 'Keep this policy', hash: saved.policy.hash, rules: saved.policy.rules });
    expect(await eraseAutonomyActors('ws:other', new Set([actor]), 'erased')).toBe(0);
  });
});
