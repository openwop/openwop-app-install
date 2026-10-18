/**
 * Feature loop round 2, row 27 — the strategy activation approval gate binds to
 * the VERSION approved, and the strategy run lane is held to its starter's access.
 *
 *   STR3WF-1  The workflow surface answered every human-started run as the tenant
 *             for STRATEGY ROWS (only the link projection was narrowed, ADR 0597
 *             §Correction 1). An org-A editor's run listed and read org-B's
 *             objectives and wrote check-ins into org-B strategies — the route and
 *             the agent tool both refuse that person. The ADR 0842 PMX4WF-1 class.
 *   STR3WF-2  `POST /:id/import-objectives` rewrites the protected `objectives`
 *             field through neither half of the gate: a pending review was not
 *             withdrawn (the approver activated objectives nobody showed them), and
 *             an ACTIVE strategy stayed active (no re-approval).
 *   STR3WF-3  `POST /:id/versions/:n/restore` on an ACTIVE strategy put back a
 *             revision's objectives and stayed active — a never-approved draft-era
 *             revision went live without review.
 *   STR3WF-4  The approval carried no proposer, so the submitter cleared their own
 *             gate even when another approver existed.
 *
 * The later describes are ADR 0845 D1–D8 (the run lane, the decide-exit binding, the
 * writer ratchet, CAS, separation of duties) plus STR3WF-8, STR3CD-3 and STR3CD-6.
 *
 * Every refusal carries a matched positive control. /grade-tests wave 19 witnessed each
 * leg by sabotage: e.g. reducing the run surface's `canRead` to `isShared` reds STR3WF-1
 * and the D1 sweep; returning `null` from `canonicalDecider` reds the via-key leg (its
 * issuer assertion), not just the unit case; dropping the stale-card reject in
 * `queueStrategyActivationIfGated` reds the re-submit leg.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStrategySurface, SURFACE_VERB_ACCESS } from '../src/features/strategy/surface.js';
import { getStrategy, updateStrategy } from '../src/features/strategy/strategyService.js';
import { canonicalDecider } from '../src/features/strategy/activationApproval.js';
import { createMember, createOrg, hasDistinctScopeHolder } from '../src/host/accessControlService.js';
import { createStrategyActivationApproval, getApproval } from '../src/host/approvalService.js';
import { nodes as strategyNodes } from '../../../packs/feature.strategy.nodes/index.mjs';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';

type ActivationCard = {
  approvalId: string; tenantId: string; kind: string; strategyId: string;
  strategySnapshot?: { objectives: Array<{ title: string }> }; strategyContentDigest?: string;
};
type Ref = { id: string };
type CheckInOut = { checkIn: { status?: string } | null; reason?: string };
type NodeOut = { status: string; error?: { code: string } };

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  // The de-facto-owner bypass would make every refusal pass vacuously (as an owner).
  delete process.env.OPENWOP_DEMO_MODE;
  await enableToggle('strategy', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);
const S = '/host/openwop-app/strategy';
const APPROVALS = '/host/openwop-app/approvals';

async function signup(c: Client, tenantId: string): Promise<{ userId: string }> {
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('bind'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const addMember = (owner: Client, orgId: string, subject: string, roles: string[]) =>
  owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject, roles });

async function ownerWithOrg(): Promise<{ owner: Client; ownerId: string; orgId: string; tenantId: string }> {
  const tenantId = `org:bind-${Date.now()}-${n++}`;
  const owner = client();
  const u = await signup(owner, tenantId);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, ownerId: u.userId, orgId: org.body.orgId, tenantId };
}

async function pendingActivation(c: Client, strategyId: string): Promise<ActivationCard | undefined> {
  const inbox = await c.get(`${APPROVALS}?status=pending`);
  expect(inbox.status).toBe(200);
  return (inbox.body.items as ActivationCard[]).find((a) => a.kind === 'strategy-activation' && a.strategyId === strategyId);
}

async function withGate<T>(fn: () => Promise<T>): Promise<T> {
  await enableToggle('strategy-approval-gate', 'on');
  try { return await fn(); } finally { await enableToggle('strategy-approval-gate', 'off'); }
}

/** Activate with the gate OFF, so the fixture starts from an approved, live strategy. */
async function liveStrategy(owner: Client, orgId: string, objectiveTitle: string): Promise<{ id: string }> {
  await enableToggle('strategy-approval-gate', 'off');
  const s = (await owner.post(S, { orgId, title: 'Live', objectives: [{ title: objectiveTitle, keyResults: [] }] })).body;
  const r = await owner.patch(`${S}/${s.id}`, { status: 'active' });
  expect(r.body.status).toBe('active');
  return s;
}

describe('STR3WF-2 — CSV import is a protected-field write', () => {
  it('withdraws a pending activation review, so the approver cannot activate unseen objectives', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await withGate(async () => {
      const s = (await owner.post(S, { orgId, title: 'Draft plan', objectives: [{ title: 'Shown', keyResults: [] }] })).body;
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      expect(await pendingActivation(owner, s.id), 'positive control: the submission queued').toBeTruthy();

      const imp = await owner.post(`${S}/${s.id}/import-objectives`, { csv: 'objective,keyResult,target,unit\nNever shown,,,' });
      expect(imp.status, JSON.stringify(imp.body)).toBe(200);
      expect(imp.body.activationReviewClosed, 'the import did not say it withdrew the review').toBe(true);
      expect(await pendingActivation(owner, s.id), 'a review over replaced content is still pending').toBeUndefined();
    });
  });

  it('re-opens review on an ACTIVE strategy, exactly like a PATCH of objectives', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const s = await liveStrategy(owner, orgId, 'Approved');
    await withGate(async () => {
      const imp = await owner.post(`${S}/${s.id}/import-objectives`, { csv: 'objective,keyResult,target,unit\nUnapproved,,,' });
      expect(imp.status, JSON.stringify(imp.body)).toBe(200);
      expect(imp.body.strategy.status, 'imported objectives went live without re-approval').toBe('draft');
      expect(imp.body.autoRevertedToDraft).toBe(true);
    });
  });

  it('MATCHED CONTROL — gate OFF, the import leaves an active strategy active', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const s = await liveStrategy(owner, orgId, 'Approved');
    const imp = await owner.post(`${S}/${s.id}/import-objectives`, { csv: 'objective,keyResult,target,unit\nMore,,,' });
    expect(imp.status, JSON.stringify(imp.body)).toBe(200);
    expect(imp.body.strategy.status).toBe('active');
  });
});

describe('STR3WF-3 — restore on an approved strategy re-opens review', () => {
  it('restoring a draft-era revision onto an ACTIVE strategy reverts it to draft', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await enableToggle('strategy-approval-gate', 'off');
    const s = (await owner.post(S, { orgId, title: 'Plan', objectives: [{ title: 'Never approved', keyResults: [] }] })).body;
    await owner.patch(`${S}/${s.id}`, { objectives: [{ title: 'Approved', keyResults: [] }] });
    await owner.patch(`${S}/${s.id}`, { status: 'active' });
    const revs = (await owner.get(`${S}/${s.id}/versions`)).body.versions as Array<{ n: number }>;
    const first = revs.sort((x, y) => x.n - y.n)[0]!;
    expect((await owner.get(`${S}/${s.id}/versions/${first.n}`)).body.snapshot.objectives[0].title).toBe('Never approved');
    await withGate(async () => {
      const r = await owner.post(`${S}/${s.id}/versions/${first.n}/restore`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.objectives[0].title).toBe('Never approved');
      expect(r.body.status, 'a never-approved revision went live through restore').toBe('draft');
      expect(r.body.autoRevertedToDraft).toBe(true);
    });
  });
});

describe('STR3WF-4 — the submitter cannot clear their own gate when another approver exists', () => {
  it('refuses self-approval with a second admin in the org; the second admin can approve', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    const admin = client(); const adminUser = await signup(admin, tenantId);
    expect((await addMember(owner, orgId, adminUser.userId, ['admin'])).status).toBeLessThan(300);
    await withGate(async () => {
      const s = (await owner.post(S, { orgId, title: 'Mine' })).body;
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      const appr = (await pendingActivation(owner, s.id))!;
      expect(appr).toBeTruthy();
      const self = await owner.post(`${APPROVALS}/${appr.approvalId}/claim`);
      expect(self.status, `self-approval cleared the gate: ${JSON.stringify(self.body)}`).toBe(403);
      expect((await owner.get(`${S}/${s.id}`)).body.status).toBe('draft');
      // Positive control: a DIFFERENT approver clears it.
      const other = await admin.post(`${APPROVALS}/${appr.approvalId}/claim`);
      expect(other.status, JSON.stringify(other.body)).toBe(200);
      expect((await owner.get(`${S}/${s.id}`)).body.status).toBe('active');
    });
  });

  it('a SOLE approver is not locked out of their own submission', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await withGate(async () => {
      const s = (await owner.post(S, { orgId, title: 'Solo' })).body;
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      const appr = (await pendingActivation(owner, s.id))!;
      expect((await owner.post(`${APPROVALS}/${appr.approvalId}/claim`)).status).toBe(200);
      expect((await owner.get(`${S}/${s.id}`)).body.status).toBe('active');
    });
  });
});

describe('STR3WF-1 — a human-started run is held to its starter\'s access', () => {
  async function twoOrgs() {
    const { owner, orgId: orgA, tenantId } = await ownerWithOrg();
    const orgB = (await owner.post('/host/openwop-app/orgs', { name: 'Bravo' })).body.orgId;
    const member = client(); const memberUser = await signup(member, tenantId);
    await addMember(owner, orgA, memberUser.userId, ['editor']);
    await enableToggle('strategy-approval-gate', 'off');
    const kr = { title: 'KR', target: '10' };
    const a = (await owner.post(S, { orgId: orgA, title: 'A plan', scope: 'org', objectives: [{ title: 'A obj', keyResults: [kr] }] })).body;
    const b = (await owner.post(S, { orgId: orgB, title: 'B secret plan', scope: 'org', objectives: [{ title: 'B secret obj', keyResults: [kr] }] })).body;
    return { tenantId, memberId: memberUser.userId, a, b };
  }

  it('lists and reads only the starter\'s readable strategies', async () => {
    const { tenantId, memberId, a, b } = await twoOrgs();
    const surface = buildStrategySurface({ tenantId, actingUserId: memberId });
    const ids = ((await surface.listStrategies({})) as { strategies: Ref[] }).strategies.map((s) => s.id);
    expect(ids, 'positive control: org-A strategy').toContain(a.id);
    expect(ids, 'org-B strategy listed to an org-A-only run').not.toContain(b.id);
    expect(((await surface.getStrategy({ id: a.id })) as { strategy: { title: string } | null }).strategy?.title).toBe('A plan');
    expect(((await surface.getStrategy({ id: b.id })) as { strategy: unknown }).strategy, 'org-B objectives read by an org-A-only run').toBeNull();
    const health = ((await surface.getHealth({})) as { strategies: Ref[] }).strategies.map((s) => s.id);
    expect(health, 'positive control: org-A strategy in the health rollup').toContain(a.id);
    expect(health).not.toContain(b.id);
  });

  it('cannot write a check-in into a strategy the starter cannot write', async () => {
    const { tenantId, memberId, a, b } = await twoOrgs();
    const surface = buildStrategySurface({ tenantId, actingUserId: memberId });
    const ok = (await surface.checkIn({ strategyId: a.id, krId: a.objectives[0].keyResults[0].id, value: 3 })) as CheckInOut;
    expect(ok.checkIn, 'positive control: org-A check-in').toBeTruthy();
    const denied = (await surface.checkIn({ strategyId: b.id, krId: b.objectives[0].keyResults[0].id, value: 3 })) as CheckInOut;
    expect(denied.checkIn, 'org-A-only run wrote a check-in into org B').toBeNull();
  });

  it('MATCHED CONTROL — an actorless (scheduled) run keeps the tenant-trusted shared view', async () => {
    const { tenantId, a, b } = await twoOrgs();
    const surface = buildStrategySurface({ tenantId });
    const ids = ((await surface.listStrategies({})) as { strategies: Ref[] }).strategies.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
  });
});

describe('STR3WF-8 — creating straight into active is an activation', () => {
  it('gate ON: POST {status:active} creates a draft and submits it for approval', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await withGate(async () => {
      const r = await owner.post(S, { orgId, title: 'Born live', status: 'active', objectives: [{ title: 'O', keyResults: [] }] });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.status, 'a strategy was created live with no approval').toBe('draft');
      expect(r.body.activationPending).toBe(true);
      expect(await pendingActivation(owner, r.body.id)).toBeTruthy();
    });
  });

  it('MATCHED CONTROL — gate OFF: POST {status:active} is live', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await enableToggle('strategy-approval-gate', 'off');
    const r = await owner.post(S, { orgId, title: 'Live', status: 'active' });
    expect(r.body.status).toBe('active');
  });
});

describe('ADR 0845 D2 — the approval binds to the content shown, at the decide exit', () => {
  it('a writer that never withdraws the review still cannot get unseen content activated', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await withGate(async () => {
      const s = (await owner.post(S, { orgId, title: 'Bound', objectives: [{ title: 'Shown', keyResults: [] }] })).body;
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      const appr = (await pendingActivation(owner, s.id))!;
      expect(appr.strategySnapshot!.objectives[0]!.title, 'the card carries what is approved').toBe('Shown');
      expect(appr.strategyContentDigest).toMatch(/^[0-9a-f]{64}$/);
      // A direct service write — the shape of the NEXT writer that forgets the withdraw.
      await updateStrategy(appr.tenantId, s.id, { objectives: [{ title: 'Swapped in', keyResults: [] }] }, 'test');
      const claim = await owner.post(`${APPROVALS}/${appr.approvalId}/claim`);
      expect(claim.status, JSON.stringify(claim.body)).toBe(409);
      expect((await owner.get(`${S}/${s.id}`)).body.status, 'unseen objectives went live').toBe('draft');
      expect(await pendingActivation(owner, s.id), 'the stale card stays open').toBeUndefined();
    });
  });

  it('MATCHED CONTROL — an unprotected change (summary) does not unbind the approval', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await withGate(async () => {
      const s = (await owner.post(S, { orgId, title: 'Bound', objectives: [{ title: 'Shown', keyResults: [] }] })).body;
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      const appr = (await pendingActivation(owner, s.id))!;
      await updateStrategy(appr.tenantId, s.id, { summary: 'a note' }, 'test');
      expect((await owner.post(`${APPROVALS}/${appr.approvalId}/claim`)).status).toBe(200);
      expect((await owner.get(`${S}/${s.id}`)).body.status).toBe('active');
    });
  });

  it('re-submitting over a stale card replaces it; an identical re-submit keeps it', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await withGate(async () => {
      const s = (await owner.post(S, { orgId, title: 'Resubmit', objectives: [{ title: 'v1', keyResults: [] }] })).body;
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      const first = (await pendingActivation(owner, s.id))!;
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      expect((await pendingActivation(owner, s.id))?.approvalId, 'identical re-submit minted a new card').toBe(first.approvalId);
      await updateStrategy(first.tenantId, s.id, { objectives: [{ title: 'v2', keyResults: [] }] }, 'test');
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      const second = (await pendingActivation(owner, s.id))!;
      expect(second.approvalId).not.toBe(first.approvalId);
      expect(second.strategySnapshot!.objectives[0]!.title).toBe('v2');
      // "Replaces" — the stale card is CLOSED, not left pending beside the new one.
      expect((await getApproval(first.approvalId))?.status, 'the stale card is still pending beside its replacement').toBe('rejected');
    });
  });
});

describe('ADR 0845 D4 — a strategy write is a compare-and-swap against what the caller read', () => {
  it('a write based on a stale read loses with 409 instead of erasing the newer write', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await enableToggle('strategy-approval-gate', 'off');
    const created = (await owner.post(S, { orgId, title: 'CAS' })).body;
    const stale = (await getStrategy(created.tenantId, created.id))!;
    await updateStrategy(created.tenantId, created.id, { title: 'Newer' }, 'a', { base: stale });
    await expect(updateStrategy(created.tenantId, created.id, { summary: 'from a stale read' }, 'b', { base: stale }))
      .rejects.toMatchObject({ code: 'conflict', httpStatus: 409 });
    expect((await getStrategy(created.tenantId, created.id))!.title, 'the newer write was erased').toBe('Newer');
  });
});

describe('ADR 0845 D5 — separation of duties survives a delegated key and a shared workspace', () => {
  it('approving your own submission with your own API key is still self-approval', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    const admin = client(); const adminUser = await signup(admin, tenantId);
    await addMember(owner, orgId, adminUser.userId, ['admin']);
    const key = await owner.post('/host/openwop-app/developer-keys', { name: 'mine', scopes: ['*'] });
    expect(key.status, JSON.stringify(key.body)).toBe(201);
    await withGate(async () => {
      const s = (await owner.post(S, { orgId, title: 'Via key' })).body;
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      const appr = (await pendingActivation(owner, s.id))!;
      // The key must resolve to its ISSUER (the recorded submitter). Without this the 403
      // below can come from the fail-closed `null` arm with no mapping at all.
      const submitter = (await getApproval(appr.approvalId))?.strategyRequestedBy;
      expect(submitter).toBeTruthy();
      expect(await canonicalDecider(tenantId, `apikey:${key.body.key.keyId}`), 'the key did not resolve to its issuer').toBe(submitter);
      const viaKey = await fetch(`${BASE}${APPROVALS}/${appr.approvalId}/claim`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key.body.token}` }, body: '{}',
      });
      const body = await viaKey.json().catch(() => ({}));
      expect(viaKey.status, JSON.stringify(body)).toBe(403);
      expect(JSON.stringify(body), 'refused for the wrong reason').toContain('separation-of-duties');
      expect((await owner.get(`${S}/${s.id}`)).body.status).toBe('draft');
    });
  });

  // A REAL key through the real lookup (`apiKeyService.ts` registers it at load). A fake
  // `registerDelegationLookup` here replaced the process-global lookup for good and made the
  // via-key leg above order-dependent (it 403'd `forbidden_scope` under shuffle).
  it('canonicalDecider maps a key to its issuer, and fails closed on a foreign or unknown key', async () => {
    const { owner, tenantId } = await ownerWithOrg();
    const key = await owner.post('/host/openwop-app/developer-keys', { name: 'canon', scopes: ['*'] });
    expect(key.status, JSON.stringify(key.body)).toBe(201);
    const keyId = key.body.key.keyId as string;
    const issuer = key.body.key.createdBy as string;
    expect(issuer).toBeTruthy();
    expect(await canonicalDecider(tenantId, 'user:bob')).toBe('user:bob');
    expect(await canonicalDecider(tenantId, `apikey:${keyId}`)).toBe(issuer);
    expect(await canonicalDecider(`${tenantId}-other`, `apikey:${keyId}`)).toBeNull();
    expect(await canonicalDecider(tenantId, 'apikey:dk:nope')).toBeNull();
  });

  it('org-scoped distinct holder counts a shared workspace\'s SUB-org admins (no root-only skip)', async () => {
    const T = `ws:str3-sod-${Date.now()}-${n++}`;
    const sub = await createOrg({ tenantId: T, createdBy: 'user:sod-a', name: 'Sub' });
    await createMember({ orgId: sub.orgId, tenantId: T, displayName: 'a', subject: 'user:sod-a', roles: ['admin'] });
    await createMember({ orgId: sub.orgId, tenantId: T, displayName: 'b', subject: 'user:sod-b', roles: ['admin'] });
    expect(await hasDistinctScopeHolder(T, 'host:members:manage', 'user:sod-a', { orgId: sub.orgId }), 'fails open in a ws: tenant').toBe(true);
    // The workspace-wide question is unchanged: sub-org admins are not workspace deciders.
    expect(await hasDistinctScopeHolder(T, 'host:members:manage', 'user:sod-a')).toBe(false);
  });
});

describe('ADR 0845 D1 — run lane: proposal bar, sync bar, typed node failure, verb ratchet', () => {
  it('an agent check-in needs READ (it is a proposal); a sync check-in needs WRITE', async () => {
    const { owner, orgId: orgA, tenantId } = await ownerWithOrg();
    const orgB = (await owner.post('/host/openwop-app/orgs', { name: 'Bravo' })).body.orgId;
    const m = client(); const mu = await signup(m, tenantId);
    await addMember(owner, orgA, mu.userId, ['editor']);
    await addMember(owner, orgB, mu.userId, ['viewer']);
    await enableToggle('strategy-approval-gate', 'off');
    // A SOURCED KR: without a `measure.source` the sync write is refused by `appendCheckIn`'s
    // own source guard too, so `canWrite` would not be the only thing refusing it.
    const b = (await owner.post(S, { orgId: orgB, title: 'B', scope: 'org', objectives: [{ title: 'o', keyResults: [{ title: 'kr', measure: { kind: 'numeric', source: { kind: 'crm-deal-total', orgId: orgB } } }] }] })).body;
    const krId = b.objectives[0].keyResults[0].id;
    const surface = buildStrategySurface({ tenantId, actingUserId: mu.userId });
    const proposed = (await surface.checkIn({ strategyId: b.id, krId, value: 1 })) as CheckInOut;
    expect(proposed.checkIn?.status, 'a viewer could not even propose').toBe('proposed');
    const sync = (await surface.checkIn({ strategyId: b.id, krId, value: 1, mode: 'sync' })) as CheckInOut;
    expect(sync.checkIn).toBeNull();
    expect(sync.reason).toBe('forbidden');
  });

  it('the check-in node fails typed when nothing was recorded (no success-with-null)', async () => {
    const ctx = { inputs: { strategyId: 's', krId: 'k', value: 1 }, features: { strategy: { listStrategies: async () => ({ strategies: [] }), checkIn: async () => ({ checkIn: null, reason: 'forbidden' }) } } };
    const node = (strategyNodes as Record<string, (c: unknown) => Promise<NodeOut>>)['feature.strategy.nodes.check-in']!;
    const out = await node(ctx);
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('forbidden');
  });

  it('every surface verb is classified (a new verb fails until gated)', () => {
    const surface = buildStrategySurface({ tenantId: 't-ratchet' });
    expect(Object.keys(surface).sort()).toEqual(Object.keys(SURFACE_VERB_ACCESS).sort());
  });
});

/**
 * ADR 0845 D3 — every writer of `strategy:record` is pinned. A protected writer must
 * ask `gateProtectedWrite`; a new writer fails here until someone classifies it.
 */
describe('ADR 0845 D3 — strategy:record writer ratchet', () => {
  const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === '__tests__' ? [] : walk(p);
    return p.endsWith('.ts') ? [p] : [];
  });
  const WRITER = /\b(createStrategy|updateStrategy|replaceLinks|appendStrategyLink|archiveStrategy)\(|\bstrategies\.(put|compareAndSwap)\(/g;
  // file (relative to src/) → number of writer call sites. Classes:
  //  routes.ts: create/PATCH/restore/import are `gated-route` (asserted below);
  //    promote (+ its compensation), links, decisions-link, archive are unprotected-only.
  //  activationApproval.ts: the decide flip. Seeders: system writers.
  //  strategyService.ts: the definitions + their internal put/CAS sites + erasure.
  const PINNED: Record<string, number> = {
    'features/strategy/routes.ts': 11,
    'features/strategy/activationApproval.ts': 1,
    'features/strategy/strategyService.ts': 11,
    'host/strategyShowcaseSeed.ts': 1,
    'host/demoOpsPlanningSeed.ts': 2,
  };
  it('pins every writer call site', () => {
    const found: Record<string, number> = {};
    for (const f of walk(SRC)) {
      const src = readFileSync(f, 'utf8').replace(/^\s*(\*|\/\/).*$/gm, '');
      const hits = (src.match(WRITER) ?? []).length;
      if (hits > 0) found[f.slice(SRC.length + 1)] = hits;
    }
    expect(found).toEqual(PINNED);
  });

  it('every gated route writer asks the one rule (code, not comments)', () => {
    const routes = readFileSync(join(SRC, 'features/strategy/routes.ts'), 'utf8').replace(/^\s*(\*|\/\/).*$/gm, '');
    expect((routes.match(/gateProtectedWrite\(/g) ?? []).length, 'PATCH + restore + import').toBe(3);
    expect(routes).toContain('queueStrategyActivationIfGated(tenantOf(req), created');
    expect((routes.match(/requireMetricSourcesReadable\(req,/g) ?? []).length, 'create + PATCH + restore').toBe(3);
  });

  it('the collection has ONE binding (a second `strategy:record` handle would bypass every writer above)', () => {
    const hits = walk(SRC).filter((f) => readFileSync(f, 'utf8').includes("'strategy:record'"));
    expect(hits.map((f) => f.slice(SRC.length + 1))).toEqual(['features/strategy/strategyService.ts']);
  });
});

describe('ADR 0845 STR3CD-3 — relocating an approved strategy re-opens review', () => {
  it('moving an ACTIVE strategy into another org returns it to draft (gate ON)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const orgB = (await owner.post('/host/openwop-app/orgs', { name: 'Dest' })).body.orgId;
    const s = await liveStrategy(owner, orgId, 'Approved in A');
    await withGate(async () => {
      const r = await owner.patch(`${S}/${s.id}`, { orgId: orgB });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.orgId).toBe(orgB);
      expect(r.body.status, 'a live strategy changed org with no approval from the destination').toBe('draft');
      expect(r.body.autoRevertedFields).toContain('orgId');
    });
  });
});

describe('ADR 0845 D8 / STR3CD-6 — a metric source must be an org the writer can read', () => {
  it('an org-A editor cannot point a KR at org B\'s data; the owner (who can read B) can', async () => {
    const { owner, orgId: orgA, tenantId } = await ownerWithOrg();
    const orgB = (await owner.post('/host/openwop-app/orgs', { name: 'Bravo' })).body.orgId;
    const m = client(); const mu = await signup(m, tenantId);
    await addMember(owner, orgA, mu.userId, ['editor']);
    await enableToggle('strategy-approval-gate', 'off');
    const kr = (src: string) => ({ title: 'Pipeline', measure: { kind: 'currency', source: { kind: 'crm-deal-total', orgId: src } } });
    const denied = await m.post(S, { orgId: orgA, title: 'Leak', objectives: [{ title: 'o', keyResults: [kr(orgB)] }] });
    expect(denied.status, 'org-B data wired into an org-A KR by someone who cannot read B').toBe(403);
    const own = await m.post(S, { orgId: orgA, title: 'Own', objectives: [{ title: 'o', keyResults: [kr(orgA)] }] });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const byOwner = await owner.post(S, { orgId: orgA, title: 'Cross', objectives: [{ title: 'o', keyResults: [kr(orgB)] }] });
    expect(byOwner.status, JSON.stringify(byOwner.body)).toBe(201);
    // Editing a KR whose source someone else configured does not lock the editor out.
    const keep = await m.patch(`${S}/${byOwner.body.id}`, { objectives: (byOwner.body.objectives as Array<{ title: string }>).map((o) => ({ ...o, title: 'renamed' })) });
    expect(keep.status, JSON.stringify(keep.body)).toBe(200);
  });
});

describe('ADR 0845 D2 — legacy rows and resolved rows', () => {
  it('#4507 — a legacy row (no digest) is refused and closed, never activated', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    await withGate(async () => {
      const s = (await owner.post(S, { orgId, title: 'Legacy' })).body;
      const appr = await createStrategyActivationApproval({ tenantId, orgId, strategyId: s.id, strategyTitle: s.title, strategyFromStatus: 'draft', proposal: 'legacy' });
      expect(appr.strategyContentDigest, 'the fixture is a legacy row').toBeUndefined();
      const claim = await owner.post(`${APPROVALS}/${appr.approvalId}/claim`);
      expect(claim.status, JSON.stringify(claim.body)).toBe(409);
      expect(JSON.stringify(claim.body)).toContain('unbound_legacy');
      expect((await owner.get(`${S}/${s.id}`)).body.status).toBe('draft');
      expect((await getApproval(appr.approvalId))?.status).toBe('rejected');
    });
  });

  it('resolving drops the content snapshot but keeps the digest it was bound to', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await withGate(async () => {
      const s = (await owner.post(S, { orgId, title: 'Strip', objectives: [{ title: 'o', keyResults: [] }] })).body;
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      const appr = (await pendingActivation(owner, s.id))!;
      expect(appr.strategySnapshot).toBeTruthy();
      expect((await owner.post(`${APPROVALS}/${appr.approvalId}/claim`)).status).toBe(200);
      const row = await getApproval(appr.approvalId);
      expect(row?.strategySnapshot).toBeUndefined();
      expect(row?.strategyContentDigest).toBe(appr.strategyContentDigest);
    });
  });
});

describe('ADR 0845 D1 — behavioural sweep: no verb returns or writes another org\'s strategy for an org-A run', () => {
  it('every classified verb, called at the org-B strategy, yields nothing of it', async () => {
    const { owner, orgId: orgA, tenantId } = await ownerWithOrg();
    const orgB = (await owner.post('/host/openwop-app/orgs', { name: 'Bravo' })).body.orgId;
    const m = client(); const mu = await signup(m, tenantId);
    await addMember(owner, orgA, mu.userId, ['editor']);
    await enableToggle('strategy-approval-gate', 'off');
    const b = (await owner.post(S, { orgId: orgB, title: 'B secret plan', scope: 'org', status: 'active', objectives: [{ title: 'B secret obj', keyResults: [{ title: 'kr', measure: { kind: 'numeric' } }] }] })).body;
    const surface = buildStrategySurface({ tenantId, actingUserId: mu.userId }) as Record<string, (a: Record<string, unknown>) => Promise<unknown>>;
    const args = { id: b.id, strategyId: b.id, krId: b.objectives[0].keyResults[0].id, value: 1, staleDays: 0.0001 };
    for (const verb of Object.keys(SURFACE_VERB_ACCESS)) {
      const out = JSON.stringify(await surface[verb]!(args));
      expect(out, `${verb} leaked org B`).not.toContain('B secret');
      expect(out, `${verb} leaked org B`).not.toContain(b.id);
    }
  });
});
