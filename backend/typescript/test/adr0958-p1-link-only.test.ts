/**
 * ADR 0958 P1 — link-only mode: the ADR 0924 client approver is a link-only
 * `client-stakeholder` collaborator, and each approval link decides through a
 * system-minted `decide` grant on the change set (resourceId
 * `${changeSetId}:${grantId}`). Through the real routes and the sharing viewer.
 *
 * Pins:
 *  - witness 6: revoking the GRANT alone (collaborator still active, link record
 *    and sharing row still present) darkens the link for reading and deciding;
 *  - a re-sent link supersedes the old one: the old grant is revoked and the old
 *    link is dead;
 *  - the approver shows in the ADR 0958 collaborators panel, link-only and never
 *    accepted, with its change-set grant; that panel cannot revoke or suspend a
 *    `client`-policy client's last approver, and its revoke kills the links;
 *  - no member, not even a client admin, can grant the `change-set` kind on the
 *    collaborator grant route, and the kind is not offered to them; no agent tool
 *    or node calls the grant mint (a census of every caller);
 *  - each mode has one lane: a signed-in collaborator's grant is refused through
 *    a link, and a link-only collaborator's grant through a session;
 *  - a pre-P1 approver row is adopted with its id kept, so the approval row's
 *    `client-approver:<id>` still names the same person.
 *
 * Sabotage, each run 2026-10-26 and each red:
 *  - `liveContext` skips `checkGrantLink` → the revoked-grant link still decides;
 *  - drop `systemMintOnly` from the grant route check → the admin grants a change set;
 *  - drop the mode check on the link lane → the signed-in grant passes as a link;
 *  - adopt with a fresh id instead of the legacy one → the decision names a new id;
 *  - call setCollaboratorStatus directly in the panel route → the last approver is revoked.
 *  Stayed GREEN, and why: dropping the `record.grantId` match in `liveContext`.
 *  A re-send already purges the old sharing row and revokes the old grant, and
 *  either alone kills the old link, so the match is a third layer for a re-send
 *  whose cleanup half-failed. It is kept, and is not claimed as witnessed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';
import { createClient, updateClient } from '../src/features/campaign-ops/clientService.js';
import { addAsset } from '../src/features/campaign-ops/assetService.js';
import { createRequest, recordInterpretation } from '../src/features/campaign-ops/requestService.js';
import { proposeChangeSet } from '../src/features/campaign-ops/changeSetService.js';
import { __resetAdoptedApproversForTests, CHANGE_SET_GRANT_KIND, listApprovers } from '../src/features/campaign-ops/portal.js';
import { getApproval } from '../src/host/approvalService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import {
  bindCollaborator, checkGrantLink, checkGrantUse, createCollaborator, getCollaborator, grantAccess, listGrants,
} from '../src/host/externalCollaborators.js';
import type { ChangeSet, ClientApprover } from '../src/features/campaign-ops/types.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let orgA: string;
let editorId: string;
let adminId: string;
let editorCookie: string;
let adminCookie: string;
let ann: ClientApprover;
let n = 0;

function cookieFor(userId: string, home: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant: home, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}
interface Res<T> { status: number; body: T; raw: string }
async function call<T = Record<string, unknown>>(cookie: string | null, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}/host/openwop-app${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}
const ops = (p: string): string => `/campaign-ops/clients/${orgA}${p}`;
const tokenOf = (url: string): string => decodeURIComponent(url.split('/shared/')[1]!);
const decide = (token: string, body: unknown) => call<{ status?: string }>(null, 'POST', `/public-campaign-approval/${encodeURIComponent(token)}/decision`, body);
const readPackage = (token: string) => call(null, 'GET', `/shared/${encodeURIComponent(token)}`);
const toggle = async (id: string, status: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

async function inReview(title: string): Promise<{ cs: ChangeSet; approvalId: string }> {
  const page = await createPage({ tenantId: TENANT, orgId: orgA, title, createdBy: 'seed', sections: [{ type: 'hero', data: { heading: `${title} — Tuesday, Nov 3` } }] });
  await transitionPage(TENANT, orgA, page.pageId, 'publish', 'seed');
  const field = `sections[${page.sections[0].sectionId}].data.heading`;
  const asset = await addAsset({ tenantId: TENANT, orgId: orgA, destination: 'openwop.cms.page', locator: { pageId: page.pageId }, label: title, editableFields: [field], createdBy: 'seed' });
  const req = await createRequest({ tenantId: TENANT, orgId: orgA, text: `Change ${++n}: move the webinar`, assetIds: [asset.assetId], createdBy: editorId });
  await recordInterpretation(TENANT, orgA, req.requestId, 1, { intents: [{ kind: 'replace_text', find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5', evidence: 'move the webinar' }], questions: [] });
  const out = await proposeChangeSet({
    tenantId: TENANT, orgId: orgA, requestId: req.requestId, version: 1, idempotencyKey: `p1:${req.requestId}`, createdBy: editorId,
    proposal: { assets: [{ assetId: asset.assetId, edits: [{ field, find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5' }] }] },
  });
  if (out.kind !== 'created') throw new Error(`proposal not created: ${JSON.stringify(out)}`);
  const r = await call<{ approvalId: string }>(editorCookie, 'POST', ops(`/change-sets/${out.changeSet.changeSetId}/request-approval`));
  expect(r.status, r.raw).toBe(201);
  return { cs: out.changeSet, approvalId: r.body.approvalId };
}

async function annLink(changeSetId: string): Promise<string> {
  const r = await call<{ links: Array<{ approverId: string; url: string }> }>(adminCookie, 'POST', ops(`/change-sets/${changeSetId}/approval-links`));
  expect(r.status, r.raw).toBe(201);
  return tokenOf(r.body.links.find((l) => l.approverId === ann.approverId)!.url);
}
const grantFor = async (changeSetId: string) =>
  (await listGrants(TENANT, orgA, ann.approverId)).find((g) => g.resource.kind === CHANGE_SET_GRANT_KIND && g.resource.id === changeSetId && g.status === 'active');

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['cms', 'campaign-ops', 'campaign-ops-client-portal', 'campaign-ops.external-collab']) await toggle(id, 'on');
  TENANT = (await createWorkspace({ name: 'P1 Agency', ownerSubject: 'oidc:p1-owner' })).tenantId;
  editorId = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:p1-editor', source: 'oidc' })).userId;
  adminId = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:p1-admin', source: 'oidc' })).userId;
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A (synthetic)' })).orgId;
  for (const [subject, clientRole] of [[editorId, 'editor'], [adminId, 'admin']] as const) {
    await createMember({ tenantId: TENANT, orgId: TENANT, subject, displayName: subject, roles: ['viewer'] });
    await createMember({ tenantId: TENANT, orgId: orgA, subject, displayName: subject, roles: [clientRole] });
  }
  await createClient({ tenantId: TENANT, orgId: orgA, name: 'Client A (synthetic)', createdBy: 'seed' });
  await updateClient(TENANT, orgA, { mode: 'live' });
  editorCookie = cookieFor(editorId, 'ws:home-p1-ed');
  adminCookie = cookieFor(adminId, 'ws:home-p1-ad');
  const a = await call<{ approver: ClientApprover }>(adminCookie, 'POST', ops('/approvers'), { email: 'ann@client.test', displayName: 'Ann' });
  expect(a.status, a.raw).toBe(201);
  ann = a.body.approver;
  expect((await call(adminCookie, 'PATCH', ops(''), { approvalPolicy: 'client' })).status).toBe(200);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0958 P1 — the approval link is backed by a grant', () => {
  it('witness 6: revoking the grant alone darkens the link for reading and deciding', async () => {
    const { cs, approvalId } = await inReview('Grant revoked');
    const token = await annLink(cs.changeSetId);
    expect((await readPackage(token)).status).toBe(200);
    const grant = await grantFor(cs.changeSetId);
    expect(grant, 'the link is backed by a live decide grant').toMatchObject({ actions: ['view', 'decide'], createdBy: 'system:campaign-ops-portal' });
    // Revoke through the agency's collaborators panel; nothing else changes.
    const r = await call(adminCookie, 'DELETE', ops(`/collaborators/${ann.approverId}/grants/${grant!.grantId}`));
    expect(r.status, r.raw).toBe(200);
    expect((await getCollaborator(TENANT, orgA, ann.approverId))?.status).toBe('active');
    expect((await readPackage(token)).status).toBe(404);
    expect((await decide(token, { action: 'approve', expectedChangeSetHash: cs.hash })).status).toBe(404);
    expect((await getApproval(approvalId))?.status).toBe('pending');
  });

  it('a re-sent link supersedes the old one: its grant is revoked and it is dead', async () => {
    const { cs, approvalId } = await inReview('Re-send');
    const first = await annLink(cs.changeSetId);
    const firstGrant = (await grantFor(cs.changeSetId))!.grantId;
    const second = await annLink(cs.changeSetId);
    expect((await listGrants(TENANT, orgA, ann.approverId)).find((g) => g.grantId === firstGrant)?.status).toBe('revoked');
    expect((await readPackage(first)).status).toBe(404);
    expect((await decide(first, { action: 'approve', expectedChangeSetHash: cs.hash })).status).toBe(404);
    const d = await decide(second, { action: 'approve', expectedChangeSetHash: cs.hash });
    expect(d.status, d.raw).toBe(200);
    expect((await getApproval(approvalId))?.decidedBy).toBe(`client-approver:${ann.approverId}`);
  });

  it('the approver is one collaborator record: link-only, never accepted, with its grant', async () => {
    const { cs } = await inReview('Panel');
    await annLink(cs.changeSetId);
    const r = await call<{ collaborators: Array<{ collaboratorId: string; kind: string; mode: string; accepted: boolean; email?: string; grants: Array<{ resource: { kind: string; id: string } }> }> }>(adminCookie, 'GET', ops('/collaborators'));
    expect(r.status, r.raw).toBe(200);
    const row = r.body.collaborators.find((c) => c.collaboratorId === ann.approverId);
    expect(row).toMatchObject({ kind: 'client-stakeholder', mode: 'link-only', accepted: false });
    expect(row!.grants.some((g) => g.resource.kind === CHANGE_SET_GRANT_KIND && g.resource.id === cs.changeSetId)).toBe(true);
    // A second approver with the same email is still refused on the portal route.
    expect((await call(adminCookie, 'POST', ops('/approvers'), { email: 'ann@client.test', displayName: 'Ann again' })).status).toBe(409);
  });

  it('the collaborators panel keeps the client\'s last approver, and revoking there kills the links', async () => {
    const status = (id: string, st: string) => call<{ details?: { reason?: string }; collaborator?: { status: string } }>(adminCookie, 'POST', ops(`/collaborators/${id}/status`), { status: st });
    for (const st of ['revoked', 'suspended']) {
      const r = await status(ann.approverId, st);
      expect(r.status, r.raw).toBe(409);
      expect(r.body.details?.reason).toBe('last_client_approver');
    }
    expect((await getCollaborator(TENANT, orgA, ann.approverId))?.status).toBe('active');
    // With a second approver, the panel's revoke is the portal's: grants revoked, links dark.
    const eve = (await call<{ approver: ClientApprover }>(adminCookie, 'POST', ops('/approvers'), { email: 'eve@client.test', displayName: 'Eve' })).body.approver;
    const { cs, approvalId } = await inReview('Panel revoke');
    const r = await call<{ links: Array<{ approverId: string; url: string }> }>(adminCookie, 'POST', ops(`/change-sets/${cs.changeSetId}/approval-links`));
    const eveToken = tokenOf(r.body.links.find((l) => l.approverId === eve.approverId)!.url);
    const out = await status(eve.approverId, 'revoked');
    expect(out.status, out.raw).toBe(200);
    expect(out.body.collaborator?.status).toBe('revoked');
    expect((await listGrants(TENANT, orgA, eve.approverId)).every((g) => g.status === 'revoked')).toBe(true);
    expect((await readPackage(eveToken)).status).toBe(404);
    expect((await decide(eveToken, { action: 'approve', expectedChangeSetHash: cs.hash })).status).toBe(404);
    expect((await getApproval(approvalId))?.status).toBe('pending');
  });

  it('no member can grant a change set, and the kind is not offered to them', async () => {
    const { cs } = await inReview('Member grant');
    const r = await call<{ message?: string }>(adminCookie, 'POST', ops(`/collaborators/${ann.approverId}/grants`), { resource: { kind: CHANGE_SET_GRANT_KIND, id: cs.changeSetId }, actions: ['decide'] });
    expect(r.status, r.raw).toBe(400);
    expect(r.body.message).not.toContain(CHANGE_SET_GRANT_KIND);
    expect(await grantFor(cs.changeSetId)).toBeUndefined();
  });

  it('no agent tool or node mints a grant: the only callers are the member route and the portal', () => {
    const walk = (d: string, ext: RegExp, out: string[] = []): string[] => {
      for (const f of readdirSync(d)) {
        if (f === 'node_modules') continue;
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p, ext, out); else if (ext.test(p)) out.push(p);
      }
      return out;
    };
    const src = join(__dirname, '../src');
    const callers = walk(src, /\.ts$/).filter((f) => /\bgrantAccess\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(src, f)).sort();
    expect(callers).toEqual(['features/campaign-ops/collaboration/routes.ts', 'features/campaign-ops/portal.ts', 'host/externalCollaborators.ts']);
    // Nodes and agent tools ship in packs: none names the grant route or the mint.
    const packs = join(__dirname, '../../../packs');
    const packHits = walk(packs, /\.(m?js|json)$/).filter((f) => /collaborators\/[^'"`\s]*\/grants|grantAccess/.test(readFileSync(f, 'utf8'))).map((f) => relative(packs, f));
    expect(packHits).toEqual([]);
  });

  it('each mode has one lane: a signed-in grant fails as a link, a link-only grant fails as a session', async () => {
    const { cs } = await inReview('Lanes');
    // A signed-in client stakeholder, bound to a user, holding a system-minted decide grant.
    const signed = await createCollaborator({ tenantId: TENANT, orgId: orgA, kind: 'client-stakeholder', email: 'carol@client.test', displayName: 'Carol', createdBy: adminId });
    await bindCollaborator(TENANT, orgA, signed.collaboratorId, 'user-carol');
    const g = await grantAccess({ tenantId: TENANT, orgId: orgA, collaboratorId: signed.collaboratorId, resource: { kind: CHANGE_SET_GRANT_KIND, id: cs.changeSetId }, actions: ['view'], createdBy: 'system:test' });
    await expect(checkGrantUse({ grantId: g.grantId, via: { userId: 'user-carol' }, action: 'view' })).resolves.toMatchObject({ orgId: orgA });
    await expect(checkGrantLink({ tenantId: TENANT, orgId: orgA, resourceId: `${cs.changeSetId}:${g.grantId}`, action: 'view', target: { kind: CHANGE_SET_GRANT_KIND, id: cs.changeSetId } }))
      .rejects.toMatchObject({ httpStatus: 404 });
    // The approver's link grant, presented as a session by any user id.
    await annLink(cs.changeSetId);
    const annGrant = (await grantFor(cs.changeSetId))!;
    await expect(checkGrantLink({ tenantId: TENANT, orgId: orgA, resourceId: `${cs.changeSetId}:${annGrant.grantId}`, action: 'decide', target: { kind: CHANGE_SET_GRANT_KIND, id: cs.changeSetId } }))
      .resolves.toMatchObject({ orgId: orgA });
    await expect(checkGrantUse({ grantId: annGrant.grantId, via: { userId: 'user-carol' }, action: 'view' })).rejects.toMatchObject({ httpStatus: 404 });
    // And the link names the tenant and org it was minted in, never another.
    await expect(checkGrantLink({ tenantId: TENANT, orgId: 'org-elsewhere', resourceId: `${cs.changeSetId}:${annGrant.grantId}`, action: 'view', target: { kind: CHANGE_SET_GRANT_KIND, id: cs.changeSetId } }))
      .rejects.toMatchObject({ httpStatus: 404 });
  });

  it('a pre-P1 approver row is adopted with its id, so the approval row names the same person', async () => {
    const legacy = new DurableCollection<ClientApprover>('campaign-ops:client-approver', (a) => `${a.tenantId}::${a.orgId}::${a.approverId}`, undefined, (a) => a.tenantId);
    const approverId = `capr_${randomUUID()}`;
    const at = '2026-10-20T10:00:00.000Z';
    await legacy.put({ tenantId: TENANT, orgId: orgA, approverId, kind: 'client-stakeholder', email: 'dan@client.test', displayName: 'Dan', status: 'active', mode: 'link-only', createdBy: adminId, createdAt: at, updatedAt: at });
    __resetAdoptedApproversForTests();
    const dan = (await listApprovers(TENANT, orgA)).find((a) => a.approverId === approverId);
    expect(dan).toMatchObject({ email: 'dan@client.test', status: 'active', createdAt: at });
    expect(await legacy.get(`${TENANT}::${orgA}::${approverId}`), 'the legacy row is gone once adopted').toBeNull();
    const { cs, approvalId } = await inReview('Adopted');
    const r = await call<{ links: Array<{ approverId: string; url: string }> }>(adminCookie, 'POST', ops(`/change-sets/${cs.changeSetId}/approval-links`));
    const token = tokenOf(r.body.links.find((l) => l.approverId === approverId)!.url);
    expect((await decide(token, { action: 'approve', expectedChangeSetHash: cs.hash })).status).toBe(200);
    expect((await getApproval(approvalId))?.decidedBy).toBe(`client-approver:${approverId}`);
  });
});
