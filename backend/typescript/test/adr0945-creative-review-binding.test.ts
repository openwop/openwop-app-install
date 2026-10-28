/**
 * ADR 0945 × ADR 0942 — the creative-review approval binding, end to end.
 *
 *   - a needs_review verdict ⇒ `requestCreativeReview` opens one `creative-publish-review`
 *     row with the client policy's approvers, the requester as a submitter;
 *   - the requester cannot approve it; an eligible admin can;
 *   - THEN the real publish gate (`assertCreativePublishable`, with the real registered
 *     check — no stub) lets the asset out (build-0904-search's ask);
 *   - a NEW verdict on the same asset is not covered by the old approval;
 *   - a `fail` verdict, an unknown verdict and another org's asset are one not-found;
 *   - a rejected review keeps the gate shut; a re-request opens a new cycle;
 *   - a second request while one is open returns the same row.
 *
 * What turns it red: the check reading anything but an approved row for exactly the
 * hash; the eligibility check missing (the requester approves their own); the
 * verdict precondition dropped; a fresh row per request.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { assertCreativePublishable, registerCreativeReviewApproval } from '../src/host/creativePublishGate.js';
import { recordVerdict, FIDELITY_RULESET_VERSION, type FidelityVerdict } from '../src/host/creativeFidelity/index.js';
import { createAsset, type MediaAsset } from '../src/features/media/mediaService.js';
import * as mediaStorage from '../src/features/media/mediaStorage.js';
import { createMember, createOrg } from '../src/host/accessControlService.js';
import { claimApproval, rejectApproval } from '../src/host/approvalDecision.js';
import { getApproval } from '../src/host/approvalService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { isCreativeReviewApproved, requestCreativeReview } from '../src/features/campaign-orchestration/creativeReview.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { AUTONOMY_TOGGLE } from '../src/host/autonomyPolicy/index.js';
import { issueApiKey, revokeApiKey } from '../src/features/developer-keys/apiKeyService.js';

const T = 'org:g945bind';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let ORG = '';
let OTHER_ORG = '';
let n = 0;
let deps: { storage: Storage; hostSuite: HostAdapterSuite };
let server: http.Server;
let BASE = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  deps = { storage: app.locals.storage as Storage, hostSuite: app.locals.hostSuite as HostAdapterSuite };
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  ORG = (await createOrg({ tenantId: T, createdBy: 'seed', name: 'Client A', ownerSubject: 'u-owner' })).orgId;
  OTHER_ORG = (await createOrg({ tenantId: T, createdBy: 'seed', name: 'Client B', ownerSubject: 'u-owner' })).orgId;
  for (const [subject, role] of [['u-requester', 'admin'], ['u-admin-2', 'admin'], ['u-editor', 'editor']] as const) {
    await createMember({ tenantId: T, orgId: ORG, subject, displayName: subject, roles: [role] });
  }
  // The app registers the real check at feature init; assert it rather than re-register.
}, 120_000);
afterAll(async () => { registerCreativeReviewApproval(null); await new Promise<void>((res) => server.close(() => res())); });

const groundingFor = (verdictId: string, outcome: FidelityVerdict['outcome']) => ({
  mode: 'composite', productId: 'prod:mug', sources: [{ assetId: 'masset:src', sha256: 'a'.repeat(64) }], provider: 'openwop', model: 'renderer@x', op: 'render',
  fidelity: { verdictId, outcome, rulesetVersion: FIDELITY_RULESET_VERSION },
});
/** A stored AI product asset whose grounding names `verdictId` (the gate reads it). */
async function asset(orgId: string, verdictId: string, outcome: FidelityVerdict['outcome']): Promise<MediaAsset> {
  const b64 = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from(`#bind${++n}`)]).toString('base64');
  const s = await mediaStorage.put(T, { contentBase64: b64, contentType: 'image/png' });
  return createAsset({ tenantId: T, orgId, name: 'mug.png', contentType: 'image/png', sizeBytes: s.sizeBytes, storageRef: s.storageRef, serveToken: s.serveToken, uploadedBy: 'u-requester', contentHash: createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex'), lineage: { generatedBy: 'ai' }, grounding: groundingFor(verdictId, outcome) });
}
async function withVerdict(outcome: FidelityVerdict['outcome'], orgId = ORG, existing?: MediaAsset): Promise<{ a: MediaAsset; verdictId: string }> {
  const verdictId = `fvd:bind-${outcome}-${++n}`;
  const a = existing ?? await asset(orgId, verdictId, outcome);
  await recordVerdict({ verdictId, tenantId: T, orgId, assetId: a.assetId, assetSha256: a.contentHash!, mode: 'composite', productId: 'prod:mug', sources: [{ assetId: 'masset:src', sha256: 'a'.repeat(64) }], checks: [], outcome, rulesetVersion: FIDELITY_RULESET_VERSION, checkedAt: '2026-10-20T00:00:00Z' });
  return { a, verdictId };
}
const decide = (approvalId: string, decidedBy: string) => claimApproval(deps, { tenantId: T, decidedBy }, approvalId);

describe('ADR 0945 × 0942 — creative-review binding', () => {
  it('a lost binding acknowledgement retries the same cycle and retains the original requester', async () => {
    const { a, verdictId } = await withVerdict('needs_review');
    const storage = hostExtStorage();
    const actual = storage.kvCompareAndSwap.bind(storage);
    let expectedId = '';
    const fault = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      const result = await actual(...args);
      if (!expectedId && args[0].startsWith('hostext:autonomy:creative-review:') && result.swapped) {
        expectedId = (JSON.parse(String(args[2])) as { approvalIds: string[] }).approvalIds[0]!;
        throw new Error('binding acknowledgement lost');
      }
      return result;
    });
    try {
      await expect(requestCreativeReview({ tenantId: T, assetId: a.assetId, verdictId, requestedBy: 'u-requester' })).rejects.toThrow('binding acknowledgement lost');
    } finally { fault.mockRestore(); }
    const recovered = await requestCreativeReview({ tenantId: T, assetId: a.assetId, verdictId, requestedBy: 'u-admin-2' });
    expect(recovered.approvalId).toBe(expectedId);
    expect(await getApproval(expectedId)).toMatchObject({ submitters: ['u-requester'], status: 'pending' });
    await expect(decide(expectedId, 'u-requester')).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('a racing second requester cannot create another cycle while the first binding publication is still returning', async () => {
    const { a, verdictId } = await withVerdict('needs_review');
    const storage = hostExtStorage();
    const actual = storage.kvCompareAndSwap.bind(storage);
    let notify!: () => void;
    let release!: () => void;
    const published = new Promise<void>((resolve) => { notify = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const fault = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      const result = await actual(...args);
      if (!held && args[0].startsWith('hostext:autonomy:creative-review:') && result.swapped) {
        held = true; notify(); await hold;
      }
      return result;
    });
    const first = requestCreativeReview({ tenantId: T, assetId: a.assetId, verdictId, requestedBy: 'u-requester' });
    try {
      await published;
      const second = await requestCreativeReview({ tenantId: T, assetId: a.assetId, verdictId, requestedBy: 'u-admin-2' });
      release();
      expect((await first).approvalId).toBe(second.approvalId);
      expect(await getApproval(second.approvalId)).toMatchObject({ submitters: ['u-requester'], status: 'pending' });
    } finally { release(); await first.catch(() => undefined); fault.mockRestore(); }
  });
  it('a needs_review verdict opens ONE row with policy approvers; the requester is a submitter; a repeat returns the same row', async () => {
    const { a, verdictId } = await withVerdict('needs_review');
    const first = await requestCreativeReview({ tenantId: T, assetId: a.assetId, verdictId, requestedBy: 'u-requester' });
    const again = await requestCreativeReview({ tenantId: T, assetId: a.assetId, verdictId, requestedBy: 'u-requester' });
    expect(again.approvalId).toBe(first.approvalId);
    const row = await getApproval(first.approvalId);
    expect(row).toMatchObject({ kind: 'creative-publish-review', orgId: ORG, assetId: a.assetId, verdictId, submitters: ['u-requester'], status: 'pending' });
    expect(row?.policy?.approverRoleRefs?.length).toBeGreaterThan(0);
    expect(await isCreativeReviewApproved({ tenantId: T, orgId: ORG, assetId: a.assetId, verdictId })).toBe(false);
  });

  it('the requester cannot approve; an eligible admin can; then the REAL publish gate lets the asset out', async () => {
    const { a, verdictId } = await withVerdict('needs_review');
    // Before: the gate refuses needs_review.
    expect(await assertCreativePublishable({ tenantId: T, mediaRef: a.assetId, destination: 'ads:meta' })).toMatchObject({ ok: false, code: 'fidelity_needs_review' });
    const { approvalId } = await requestCreativeReview({ tenantId: T, assetId: a.assetId, verdictId, requestedBy: 'u-requester' });
    await expect(decide(approvalId, 'u-requester')).rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_self_approval_refused' } });
    await expect(decide(approvalId, 'u-editor')).rejects.toMatchObject({ httpStatus: 403 });
    await decide(approvalId, 'u-admin-2');
    expect(await isCreativeReviewApproved({ tenantId: T, orgId: ORG, assetId: a.assetId, verdictId })).toBe(true);
    expect(await assertCreativePublishable({ tenantId: T, mediaRef: a.assetId, destination: 'ads:meta' })).toMatchObject({ ok: true });
  });

  it('a new verdict on the same asset is NOT covered by the old approval', async () => {
    const { a, verdictId } = await withVerdict('needs_review');
    const { approvalId } = await requestCreativeReview({ tenantId: T, assetId: a.assetId, verdictId, requestedBy: 'u-requester' });
    await decide(approvalId, 'u-admin-2');
    const second = await withVerdict('needs_review', ORG, a);
    expect(await isCreativeReviewApproved({ tenantId: T, orgId: ORG, assetId: a.assetId, verdictId: second.verdictId })).toBe(false);
  });

  it('a fail verdict, an unknown verdict, and another org\'s asset are the same not-found', async () => {
    const failed = await withVerdict('fail');
    await expect(requestCreativeReview({ tenantId: T, assetId: failed.a.assetId, verdictId: failed.verdictId, requestedBy: 'u-requester' })).rejects.toMatchObject({ httpStatus: 404 });
    const ok = await withVerdict('needs_review');
    await expect(requestCreativeReview({ tenantId: T, assetId: ok.a.assetId, verdictId: 'fvd:nope', requestedBy: 'u-requester' })).rejects.toMatchObject({ httpStatus: 404 });
    const foreign = await withVerdict('needs_review', OTHER_ORG);
    await expect(requestCreativeReview({ tenantId: T, assetId: foreign.a.assetId, verdictId: ok.verdictId, requestedBy: 'u-requester' })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('a rejected review keeps the gate shut; a re-request opens a new cycle', async () => {
    const { a, verdictId } = await withVerdict('needs_review');
    const first = await requestCreativeReview({ tenantId: T, assetId: a.assetId, verdictId, requestedBy: 'u-requester' });
    await rejectApproval(deps, { tenantId: T, decidedBy: 'u-admin-2' }, first.approvalId);
    expect(await isCreativeReviewApproved({ tenantId: T, orgId: ORG, assetId: a.assetId, verdictId })).toBe(false);
    expect(await assertCreativePublishable({ tenantId: T, mediaRef: a.assetId, destination: 'ads:meta' })).toMatchObject({ ok: false });
    const second = await requestCreativeReview({ tenantId: T, assetId: a.assetId, verdictId, requestedBy: 'u-requester' });
    expect(second.approvalId).not.toBe(first.approvalId);
  });
});

describe('ADR 0945 × 0942 — the request route', () => {
  it('a real delegated key freezes its human requester and cannot lose that cause on revocation', async () => {
    const before = process.env.OPENWOP_KEY_AUTHORITY;
    process.env.OPENWOP_KEY_AUTHORITY = 'enforce';
    try {
      for (const id of ['campaign-orchestration', AUTONOMY_TOGGLE]) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
      const tenantId = (await createWorkspace({ name: 'Delegated creative agency', ownerSubject: 'oidc:creative-key-owner' })).tenantId;
      const orgId = (await createOrg({ tenantId, createdBy: 'seed', name: 'Delegated creative client' })).orgId;
      const requester = (await upsertFromPrincipal({ tenantId, principalId: 'oidc:creative-key-requester', source: 'oidc' })).userId;
      const reviewer = (await upsertFromPrincipal({ tenantId, principalId: 'oidc:creative-key-reviewer', source: 'oidc' })).userId;
      for (const subject of [requester, reviewer]) {
        await createMember({ tenantId, orgId: tenantId, subject, displayName: subject, roles: ['admin'] });
        await createMember({ tenantId, orgId, subject, displayName: subject, roles: ['admin'] });
      }
      const verdictId = `fvd:key-${++n}`;
      const st = await mediaStorage.put(tenantId, { contentBase64: PNG, contentType: 'image/png' });
      const a = await createAsset({ tenantId, orgId, name: 'key-review.png', contentType: 'image/png', sizeBytes: st.sizeBytes, storageRef: st.storageRef, serveToken: st.serveToken,
        uploadedBy: requester, contentHash: createHash('sha256').update(Buffer.from(PNG, 'base64')).digest('hex'), lineage: { generatedBy: 'ai' }, grounding: groundingFor(verdictId, 'needs_review') });
      await recordVerdict({ verdictId, tenantId, orgId, assetId: a.assetId, assetSha256: a.contentHash!, mode: 'composite', productId: 'prod:mug',
        sources: [{ assetId: 'masset:src', sha256: 'a'.repeat(64) }], checks: [], outcome: 'needs_review', rulesetVersion: FIDELITY_RULESET_VERSION, checkedAt: new Date().toISOString() });
      const key = await issueApiKey({ tenantId, name: 'Creative requester', createdBy: requester, scopes: ['workspace:write'] });
      const response = await fetch(`${BASE}/host/openwop-app/campaign-orchestration/creative-reviews`, {
        method: 'POST', headers: { authorization: `Bearer ${key.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ assetId: a.assetId, verdictId }),
      });
      const text = await response.text();
      expect(response.status, text).toBe(201);
      const approvalId = (JSON.parse(text) as { approvalId: string }).approvalId;
      const requested = await getApproval(approvalId);
      expect(await revokeApiKey(tenantId, key.key.keyId, { callerSubject: requester, isAdmin: false })).toBe(true);
      await expect(claimApproval(deps, { tenantId, decidedBy: requester }, approvalId)).rejects.toMatchObject({ httpStatus: 403, details: { reason: 'autonomy_self_approval_refused' } });
      await claimApproval(deps, { tenantId, decidedBy: reviewer }, approvalId);
      expect(requested).toMatchObject({ submitters: [requester], status: 'pending' });
      expect(await isCreativeReviewApproved({ tenantId, orgId, assetId: a.assetId, verdictId })).toBe(true);
    } finally {
      if (before === undefined) delete process.env.OPENWOP_KEY_AUTHORITY; else process.env.OPENWOP_KEY_AUTHORITY = before;
    }
  });

  it('a writer on the ASSET\'s org opens a review; a reader, a stranger and an unknown asset all get the same 404', async () => {
    for (const id of ['campaign-orchestration', AUTONOMY_TOGGLE]) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
    const ws = await createWorkspace({ name: 'Bind Agency', ownerSubject: 'oidc:bind-owner' });
    const W = ws.tenantId;
    const org = (await createOrg({ tenantId: W, createdBy: 'seed', name: 'Client W' })).orgId;
    const users: Record<string, string> = {};
    for (const [key, role] of [['writer', 'editor'], ['reader', 'viewer'], ['stranger', null]] as const) {
      const u = await upsertFromPrincipal({ tenantId: W, principalId: `oidc:bind-${key}`, source: 'oidc' });
      users[key] = u.userId;
      await createMember({ tenantId: W, orgId: W, subject: u.userId, displayName: key, roles: ['viewer'] });
      if (role) await createMember({ tenantId: W, orgId: org, subject: u.userId, displayName: key, roles: [role] });
    }
    const verdictId = `fvd:route-${++n}`;
    const b64 = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from(`#route${n}`)]).toString('base64');
    const st = await mediaStorage.put(W, { contentBase64: b64, contentType: 'image/png' });
    const a = await createAsset({ tenantId: W, orgId: org, name: 'mug.png', contentType: 'image/png', sizeBytes: st.sizeBytes, storageRef: st.storageRef, serveToken: st.serveToken, uploadedBy: users.writer!, contentHash: createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex'), lineage: { generatedBy: 'ai' }, grounding: groundingFor(verdictId, 'needs_review') });
    await recordVerdict({ verdictId, tenantId: W, orgId: org, assetId: a.assetId, assetSha256: a.contentHash!, mode: 'composite', productId: 'prod:mug', sources: [{ assetId: 'masset:src', sha256: 'a'.repeat(64) }], checks: [], outcome: 'needs_review', rulesetVersion: FIDELITY_RULESET_VERSION, checkedAt: '2026-10-20T00:00:00Z' });
    const cookie = (userId: string) => { const now = Math.floor(Date.now() / 1000); return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: W, tier: 'user', userId, personalTenant: `ws:home-${userId}`, iat: now, exp: now + COOKIE_TTL_SECONDS })}`; };
    const post = async (userId: string, body: unknown) => {
      const r = await fetch(`${BASE}/host/openwop-app/campaign-orchestration/creative-reviews`, { method: 'POST', headers: { cookie: cookie(userId), 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, text: await r.text() };
    };
    const reader = await post(users.reader!, { assetId: a.assetId, verdictId });
    const stranger = await post(users.stranger!, { assetId: a.assetId, verdictId });
    const unknown = await post(users.writer!, { assetId: 'masset:nope', verdictId });
    for (const r of [reader, stranger, unknown]) expect(r.status, r.text).toBe(404);
    expect(reader.text).toBe(stranger.text);
    const ok = await post(users.writer!, { assetId: a.assetId, verdictId });
    expect(ok.status, ok.text).toBe(201);
    expect(JSON.parse(ok.text)).toMatchObject({ status: 'pending' });
  });
});
