/**
 * ADR 0942 P0 — the autonomy policy routes over real HTTP: the campaign override
 * (`…/campaign-orchestration/campaigns/:id/autonomy`) and the client default
 * (`…/campaign-ops/clients/:orgId/autonomy-default`).
 *
 * Setup: a shared `ws:` agency workspace. AGENCY admin = `admin` on the root row.
 * EDITOR = `viewer` on the root row and `editor` on each client the case makes.
 * CLIENT ADMIN = `viewer` on the root row and `admin` on each client the case
 * makes. D9: a tighten needs workspace:write; anything not provably at least as
 * strict as BOTH the policy in force and the client default needs
 * host:members:manage on the client org; the client default is agency-admin only.
 *
 * Every case that writes a policy makes its OWN client (`freshClient`, bound to
 * Guarded through the real create route) and campaign, and sets its own
 * precondition through the routes, so no case reads another's override or
 * client default and the file holds under any order. Toggles are restored in
 * `finally`. Client B's campaign is read-only (the cross-client case).
 *
 * Sabotage notes (each run, 2026-10-20; re-measured w74 grade-tests):
 *  - make `loosenNeedsOrgAdmin` return without checking → red (the editor loosens);
 *  - drop the client-default baseline from `loosenedAgainstBaselines` → red (the
 *    editor tightens an over-loose override that is still looser than the default);
 *  - drop `requireAgencyAdmin` from the client-default PUT → red;
 *  - drop the sub-toggle check on the campaign GET → red (served with the toggle off);
 *  - a blind clear instead of the CAS → red (the admin's tightening is lost);
 *  - a clear that ignores the inherited marker → red (a second clear "removes" again);
 *  - erasure that does not re-read a contended binding → red;
 *  - a campaign delete that leaves its binding → red.
 * The concurrent-clear case FORCES the race: both clears are held on their first
 * binding read until both have read it, so the loser reaches the CAS and must be
 * refused `binding_changed`.
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
let editorId: string;
let clientAdminId: string;
let orgB: string;
let campaignB: string;
let storage: Storage;

function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}

interface Res<T> { status: number; body: T; raw: string }
interface ErrBody { error?: string; message?: string; details?: { reason?: string; loosened?: string[]; requiredScope?: string } }
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
  const at = new Date().toISOString();
  return {
    id: `brief-${randomBytes(6).toString('hex')}`, tenantId: TENANT, orgId, name, objective: 'Grow signups',
    personaIds: [], productName: 'P', productDescription: 'D', industryVertical: 'saas',
    channels: [], messaging: { primaryValueProp: 'More signups', toneOverride: '', proofPoints: [], ctaStrategy: 'Start free' },
    status: 'confirmed', kernelStale: false, createdBy: 'seed', createdAt: at, updatedAt: at,
  };
}

/** A new client org (bound to Guarded by the real create route) with the editor
 *  and the client admin on it, and one campaign. Each writing case owns one. */
async function freshClient(label: string): Promise<{ orgId: string; campaignId: string }> {
  const orgId = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: `Client ${label}` })).orgId;
  await createMember({ tenantId: TENANT, orgId, subject: editorId, displayName: 'Editor', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId, subject: clientAdminId, displayName: 'Client admin', roles: ['admin'] });
  const made = await call(agencyCookie, 'POST', '/campaign-ops/clients', { name: `Client ${label}`, orgId });
  expect(made.status, made.raw).toBe(201);
  const campaignId = (await finalizeFromBrief(TENANT, brief(orgId, `Campaign ${label}`), 'seed')).id;
  return { orgId, campaignId };
}

/** The client admin loosens a campaign to Autopilot (the precondition several D9 cases need). */
async function adminLoosens(campaignId: string): Promise<void> {
  const r = await call(clientAdminCookie, 'PUT', campaignPath(campaignId), { preset: 'autopilot@1' });
  expect(r.status, r.raw).toBe(200);
}

/** The D9 refusal: 403, `loosen_requires_admin`, and the classes it names. */
function expectLoosenRefused(r: Res<ErrBody>, names: string[], notNames: string[] = []): void {
  expect(r.status, r.raw).toBe(403);
  expect(r.body.error).toBe('forbidden_scope');
  expect(r.body.details?.reason).toBe('loosen_requires_admin');
  const loosened = r.body.details?.loosened ?? [];
  for (const n of names) expect(loosened, n).toContain(n);
  for (const n of notNames) expect(loosened, n).not.toContain(n);
  // Each entry is an action class, or `creative.review:<stage>` for a per-stage review rule.
  const wellFormed = (c: string): boolean => ACTION_CLASSES.some((a) => a === c) || REVIEW_STAGES.some((s) => c === `creative.review:${s}`);
  expect(loosened.every(wellFormed), loosened.join(',')).toBe(true);
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
  // All three on up front: the autonomy sub-toggle is not on by default, and no case
  // may rely on another case's `finally` to switch it on.
  for (const id of ['campaign-orchestration', 'campaign-ops', AUTONOMY_TOGGLE]) await setToggle(id, true);
  const ws = await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:aut-owner' });
  TENANT = ws.tenantId;
  const agency = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:aut-agency', source: 'oidc' });
  const editor = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:aut-editor', source: 'oidc' });
  const clientAdmin = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:aut-client-admin', source: 'oidc' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: agency.userId, displayName: 'Agency', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: editor.userId, displayName: 'Editor', roles: ['viewer'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: clientAdmin.userId, displayName: 'Client admin', roles: ['viewer'] });
  editorId = editor.userId;
  clientAdminId = clientAdmin.userId;
  agencyCookie = cookieFor(agency.userId, 'ws:home-agency');
  editorCookie = cookieFor(editor.userId, 'ws:home-editor');
  clientAdminCookie = cookieFor(clientAdmin.userId, 'ws:home-client-admin');
  // Client B: no editor or client-admin membership; read-only for the cross-client case.
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  campaignB = (await finalizeFromBrief(TENANT, brief(orgB, 'Other client'), 'seed')).id;
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0942 P0 — toggle and visibility', () => {
  it('the routes 404 while the autonomy sub-toggle is off', async () => {
    const c = await freshClient('subtoggle');
    await setToggle(AUTONOMY_TOGGLE, false);
    try {
      for (const r of [await call<ErrBody>(editorCookie, 'GET', campaignPath(c.campaignId)), await call<ErrBody>(agencyCookie, 'GET', clientPath(c.orgId))]) {
        expect(r.status, r.raw).toBe(404);
        expect(r.body.error).toBe('not_found');
        expect(r.raw).toContain('Campaign autonomy policy is not enabled for this tenant.');
      }
    } finally { await setToggle(AUTONOMY_TOGGLE, true); }
    expect((await call(editorCookie, 'GET', campaignPath(c.campaignId))).status).toBe(200);
  });

  it('the client-default routes also AND-gate the sub-toggle\'s parent (ADR 0941 D5)', async () => {
    const c = await freshClient('parent');
    await setToggle('campaign-orchestration', false);
    try {
      const off = await call<ErrBody>(agencyCookie, 'GET', clientPath(c.orgId));
      expect(off.status, off.raw).toBe(404);
      expect(off.body.error).toBe('not_found');
      expect(off.raw).toContain('Campaign Studio is not enabled for this tenant.');
    } finally { await setToggle('campaign-orchestration', true); }
    expect((await call(agencyCookie, 'GET', clientPath(c.orgId))).status).toBe(200);
  });

  it('a new client is bound to Guarded; a campaign with no override inherits it', async () => {
    const { orgId, campaignId } = await freshClient('guarded');
    const c = await call<PolicyView>(editorCookie, 'GET', clientPath(orgId));
    expect(c.status, c.raw).toBe(200);
    expect(c.body).toMatchObject({ source: 'client', policy: { policyId: 'preset:guarded', version: 1 } });
    const r = await call<PolicyView>(editorCookie, 'GET', campaignPath(campaignId));
    expect(r.status, r.raw).toBe(200);
    expect(r.body).toMatchObject({ source: 'client', etag: 'none', clientDefault: { policyId: 'preset:guarded' } });
  });

  it('ADR 0942 P5 — the read model carries the class vocabulary and each class\'s effective rule, so the SPA derives nothing', async () => {
    const { campaignId } = await freshClient('read-model');
    const r = await call<PolicyView>(editorCookie, 'GET', campaignPath(campaignId));
    expect(r.status, r.raw).toBe(200);
    expect(r.body.actionClasses).toEqual([...ACTION_CLASSES]);
    expect(r.body.presets?.map((p) => p.id)).toEqual(['review-everything@1', 'guarded@1', 'autopilot@1']);
    const eff = r.body.effective ?? [];
    // One row per class, and one per review stage for creative.review.
    expect(eff).toHaveLength(ACTION_CLASSES.length - 1 + REVIEW_STAGES.length);
    expect(eff.filter((e) => e.actionClass === 'creative.review').map((e) => e.stage)).toEqual([...REVIEW_STAGES]);
    // Each row is what the resolver itself would find for that class (Guarded's rules, from the preset).
    for (const e of eff) {
      const cls = ACTION_CLASSES.find((c) => c === e.actionClass);
      if (!cls) throw new Error(`unknown action class ${e.actionClass}`);
      const stage = e.stage === undefined ? undefined : REVIEW_STAGES.find((st) => st === e.stage);
      if (e.stage !== undefined && !stage) throw new Error(`unknown review stage ${e.stage}`);
      const { rule } = findRule(presetPolicy('guarded@1'), cls, stage);
      expect(e.rule.default, `${e.actionClass}:${e.stage ?? ''}`).toEqual(rule?.default);
    }
  });

  it('another client\'s campaign is a 404 to an editor of client A', async () => {
    for (const r of [await call<ErrBody>(editorCookie, 'GET', campaignPath(campaignB)), await call<ErrBody>(editorCookie, 'PUT', campaignPath(campaignB), { preset: 'review-everything@1' })]) {
      expect(r.status, r.raw).toBe(404);
      expect(r.body.error).toBe('not_found');
      expect(r.body.message).toBe('Campaign not found.');
    }
  });
});

describe('ADR 0942 D9 — tighten vs loosen authority on a campaign', () => {
  it('an editor may tighten; it is audited as a tighten', async () => {
    const { orgId, campaignId } = await freshClient('tighten');
    const r = await call<PolicyView>(editorCookie, 'PUT', campaignPath(campaignId), { preset: 'review-everything@1' });
    expect(r.status, r.raw).toBe(200);
    expect(r.body).toMatchObject({ source: 'campaign', direction: 'tighten', loosened: [], policy: { policyId: 'preset:review-everything' } });
    const last = (await autonomyAudits()).filter((a) => a.campaignId === campaignId).at(-1);
    expect(last).toMatchObject({ kind: 'campaign.autonomy.policy-set', orgId, campaignId, direction: 'tighten' });
  });

  it('an editor may not loosen, even back to the client default', async () => {
    const { campaignId } = await freshClient('no-loosen');
    // Precondition: the editor's own tighten (Review everything is in force).
    expect((await call(editorCookie, 'PUT', campaignPath(campaignId), { preset: 'review-everything@1' })).status).toBe(200);
    expectLoosenRefused(await call<ErrBody>(editorCookie, 'PUT', campaignPath(campaignId), { preset: 'guarded@1' }), ['ads.budget']);
    expectLoosenRefused(await call<ErrBody>(editorCookie, 'DELETE', campaignPath(campaignId)), ['ads.budget']);
    expect((await call<PolicyView>(editorCookie, 'GET', campaignPath(campaignId))).body.policy.policyId).toBe('preset:review-everything');
  });

  it('the client\'s own admin may loosen; it is audited and stays scoped to that campaign', async () => {
    const { orgId, campaignId } = await freshClient('admin-loosen');
    const r = await call<PolicyView>(clientAdminCookie, 'PUT', campaignPath(campaignId), { preset: 'autopilot@1' });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.direction).toBe('loosen');
    expect(r.body.loosened?.length ?? 0).toBeGreaterThan(0);
    expect((await autonomyAudits()).filter((a) => a.campaignId === campaignId).at(-1)).toMatchObject({ kind: 'campaign.autonomy.policy-set', direction: 'loosen', campaignId });
    expect((await call<PolicyView>(editorCookie, 'GET', clientPath(orgId))).body.policy.policyId).toBe('preset:guarded');
  });

  it('a campaign may not be set looser than its client default by an editor, even when it tightens what is in force', async () => {
    const { campaignId } = await freshClient('below-default');
    await adminLoosens(campaignId);
    // In force: autopilot. A custom policy that is stricter than autopilot but drops Guarded's
    // content.publish escalations is looser than the client default ⇒ admin only.
    const rules = presetRules('guarded@1').map((r) => (r.actionClass === 'content.publish' ? { actionClass: r.actionClass, default: r.default } : r));
    expectLoosenRefused(await call<ErrBody>(editorCookie, 'PUT', campaignPath(campaignId), { name: 'Almost guarded', rules }), ['content.publish']);
  });

  it('tightening an over-loose override is still refused while it stays looser than the client default', async () => {
    const { campaignId } = await freshClient('over-loose');
    await adminLoosens(campaignId);
    // In force: autopilot (set by the client admin just above). This is STRICTER than
    // autopilot (plan.approve now approves) but still looser than Guarded, the
    // client default, on e.g. email.campaign-send. Only the client-default baseline catches it.
    const rules = presetRules('autopilot@1').map((r) => (r.actionClass === 'plan.approve'
      ? { actionClass: r.actionClass, default: { outcome: 'approve' as const, approver: { roleRefs: ['owner', 'admin'], requiredApprovals: 1 as const, delegation: 'allowed' as const } } }
      : r));
    expectLoosenRefused(await call<ErrBody>(editorCookie, 'PUT', campaignPath(campaignId), { name: 'Autopilot, plans reviewed', rules }), ['email.campaign-send'], ['plan.approve']);
  });

  it('removing a looser override is a tighten an editor may make', async () => {
    const { campaignId } = await freshClient('remove-loose');
    await adminLoosens(campaignId);
    const before = await call<PolicyView>(editorCookie, 'GET', campaignPath(campaignId));
    expect(before.body.policy.policyId).toBe('preset:autopilot');
    const r = await call<PolicyView & { removed: boolean }>(editorCookie, 'DELETE', `${campaignPath(campaignId)}?ifMatch=${encodeURIComponent(before.body.etag)}`);
    expect(r.status, r.raw).toBe(200);
    expect(r.body).toMatchObject({ removed: true, direction: 'tighten', source: 'client' });
    expect((await call<PolicyView>(editorCookie, 'GET', campaignPath(campaignId))).body.policy.policyId).toBe('preset:guarded');
  });

  it('custom rules are stored as an immutable version; a stale ifMatch is a 409', async () => {
    const { campaignId } = await freshClient('versions');
    const rules = presetRules('review-everything@1');
    const a = await call<PolicyView>(editorCookie, 'PUT', campaignPath(campaignId), { name: 'Strict', rules, ifMatch: 'none' });
    expect(a.status, a.raw).toBe(200);
    expect(a.body.policy.policyId).toMatch(/^apol_/);
    expect(a.body.policy.version).toBe(1);
    const b = await call<PolicyView>(editorCookie, 'PUT', campaignPath(campaignId), { name: 'Strict v2', rules, ifMatch: a.body.etag });
    expect(b.status, b.raw).toBe(200);
    expect(b.body.policy.version).toBe(2);
    const stale = await call<ErrBody>(editorCookie, 'PUT', campaignPath(campaignId), { name: 'Strict v3', rules, ifMatch: a.body.etag });
    expect(stale.status, stale.raw).toBe(409);
    expect(stale.body.details?.reason).toBe('binding_changed');
    expect((await call<PolicyView>(editorCookie, 'GET', campaignPath(campaignId))).body.policy.version).toBe(2);
  });

  it('an invalid body is a typed 400, never a silent save', async () => {
    const { campaignId } = await freshClient('invalid');
    const bad = await call<ErrBody>(editorCookie, 'PUT', campaignPath(campaignId), { name: 'Bad', rules: [{ actionClass: 'ads.budget', default: { outcome: 'approve', approver: { subjectRefs: ['u1'], requiredApprovals: 1, delegation: 'allowed' } } }] });
    expect(bad.status, bad.raw).toBe(400);
    expect(bad.raw).toContain('D10.1');
    for (const body of [{ preset: 'yolo@1' }, { preset: 'guarded@1', surprise: true }]) {
      const r = await call<ErrBody>(editorCookie, 'PUT', campaignPath(campaignId), body);
      expect(r.status, r.raw).toBe(400);
      expect(r.body.error).toBe('validation_error');
    }
    expect((await call<PolicyView>(editorCookie, 'GET', campaignPath(campaignId))).body).toMatchObject({ source: 'client', etag: 'none' });
  });
});

describe('ADR 0942 D9 — the client default', () => {
  it('only an agency admin sets it, in either direction', async () => {
    const { orgId } = await freshClient('client-default');
    for (const r of [
      await call<ErrBody>(editorCookie, 'PUT', clientPath(orgId), { preset: 'review-everything@1' }),
      await call<ErrBody>(clientAdminCookie, 'PUT', clientPath(orgId), { preset: 'autopilot@1' }),
    ]) {
      expect(r.status, r.raw).toBe(403);
      expect(r.body.error).toBe('forbidden_scope');
      expect(r.body.message).toBe('Only an agency admin can do this.');
    }
    expect((await call<PolicyView>(agencyCookie, 'GET', clientPath(orgId))).body.policy.policyId).toBe('preset:guarded');
    const r = await call<PolicyView>(agencyCookie, 'PUT', clientPath(orgId), { preset: 'autopilot@1' });
    expect(r.status, r.raw).toBe(200);
    expect(r.body).toMatchObject({ source: 'client', direction: 'loosen', policy: { policyId: 'preset:autopilot' } });
    const last = (await autonomyAudits()).filter((a) => a.orgId === orgId).at(-1);
    expect(last).toMatchObject({ kind: 'campaign.autonomy.policy-set', orgId, direction: 'loosen' });
    expect(last).not.toHaveProperty('campaignId');
  });
});

describe('ADR 0942 recovery — conditional override clearing', () => {
  it('an editor cannot clear an admin tightening that replaced the authorized override', async () => {
    const { orgId, campaignId: id } = await freshClient('clear-race');
    expect((await call(agencyCookie, 'PUT', clientPath(orgId), { preset: 'autopilot@1' })).status).toBe(200);
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
      const cleared = await call<ErrBody>(editorCookie, 'DELETE', campaignPath(id));
      expect(cleared.status, cleared.raw).toBe(409);
      expect(cleared.body.details?.reason).toBe('binding_changed');
    } finally { spy.mockRestore(); }
    expect(tightened).toBe(true);
    expect((await call<PolicyView>(editorCookie, 'GET', campaignPath(id))).body.policy.policyId).toBe('preset:review-everything');
    expect((await autonomyAudits()).filter((a) => a.campaignId === id && a.kind === 'campaign.autonomy.policy-cleared')).toHaveLength(0);
  });

  it('concurrent clears change policy once, inherit honestly, and permit a later override', async () => {
    const { orgId, campaignId: id } = await freshClient('clear-once');
    expect((await call(agencyCookie, 'PUT', clientPath(orgId), { preset: 'autopilot@1' })).status).toBe(200);
    expect((await call(clientAdminCookie, 'PUT', campaignPath(id), { preset: 'autopilot@1' })).status).toBe(200);
    // Force the race: the first clear waits on its first read of this binding until
    // the second clear has read it too, so both see the override and both reach the CAS.
    const get = storage.kvGet.bind(storage);
    let arrivals = 0;
    let release: () => void = () => undefined;
    const bothRead = new Promise<void>((r) => { release = r; });
    const fallback = setTimeout(() => release(), 2_000);
    const spy = vi.spyOn(storage, 'kvGet').mockImplementation(async (key: string) => {
      const value = await get(key);
      if (arrivals < 2 && key.startsWith('hostext:autonomy:binding:') && key.endsWith(`::${id}`)) {
        arrivals += 1;
        // The value is read BEFORE waiting, so the first clear holds the override it saw.
        if (arrivals === 1) await bothRead;
        else release();
      }
      return value;
    });
    let results: Array<Res<{ removed?: boolean } & ErrBody>> = [];
    try {
      results = await Promise.all([
        call<{ removed?: boolean } & ErrBody>(editorCookie, 'DELETE', campaignPath(id)),
        call<{ removed?: boolean } & ErrBody>(editorCookie, 'DELETE', campaignPath(id)),
      ]);
    } finally { spy.mockRestore(); clearTimeout(fallback); }
    expect(arrivals).toBe(2);
    expect(results.filter((r) => r.status === 200 && r.body.removed === true)).toHaveLength(1);
    const losers = results.filter((r) => r.status !== 200);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.status, losers[0]?.raw).toBe(409);
    expect(losers[0]?.body.details?.reason).toBe('binding_changed');
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
    const { orgId, campaignId } = await freshClient('cascade');
    expect((await call(editorCookie, 'PUT', campaignPath(campaignId), { preset: 'review-everything@1' })).status).toBe(200);
    expect(await getBinding(TENANT, orgId, campaignId)).not.toBeNull();
    expect(await deleteCampaign(TENANT, campaignId, 'test')).toBe(true);
    expect(await getBinding(TENANT, orgId, campaignId)).toBeNull();
  });
});


describe('ADR 0942 recovery — erasure preserves concurrent policy edits', () => {
  it('re-reads a replaced binding and erases the actor without restoring the old policy', async () => {
    const actor = `erase-${randomBytes(6).toString('hex')}`;
    const campaignId = `erase-campaign-${randomBytes(6).toString('hex')}`;
    const orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Erasure client' })).orgId;
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
    const orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Erasure client' })).orgId;
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
