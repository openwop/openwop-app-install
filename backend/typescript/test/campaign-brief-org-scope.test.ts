/**
 * Campaign-brief surface org scoping (security fix, found by the ADR 0948 P2 review).
 *
 * Every by-id read on `ctx.features['campaign-brief']` used to be tenant-only. The
 * ADR 0832 org floor fires only on a method's `orgId` argument, and these take a
 * `briefId` / `personaId` instead. So in an agency workspace, a run for client A
 * could read, ground on, and write client B's brief. Now:
 *  - `orgId` given: the row must belong to it (uniform not-found otherwise), on top
 *    of the floor's membership check;
 *  - `orgId` absent: the run's person (actor, else causing member) must hold the
 *    scope in the ROW's org;
 *  - an actorless, causeless system run keeps the tenant-trusted model.
 *
 * Driven through the real seam (`buildFeatureSurfaces`), not the raw builder.
 * Sabotage-witnessed in the PR: dropping the row-org check, or the argument match,
 * reds this file.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces, type FeatureSurface } from '../src/host/featureSurfaces.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { createBrief, getBrief } from '../src/features/campaign-brief/briefService.js';
import { createPersona } from '../src/features/campaign-brief/personaService.js';
import { campaignBriefFeature } from '../src/features/campaign-brief/feature.js';

let BASE = '';
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'campaign-brief']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

// `any`: the JSON wire boundary of a test-only HTTP helper (the adr0832 probe precedent).
function client(): { post: (p: string, b?: unknown) => Promise<{ status: number; body: any }> } {
  let cookie = '';
  return {
    post: async (path, body) => {
      const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
      return { status: res.status, body: await res.json().catch(() => undefined) };
    },
  };
}

const H = '/host/openwop-app';
const SECRET = 'Client B launch: confidential pricing';
const leaks = (v: unknown): boolean => JSON.stringify(v ?? null).includes(SECRET);

/** One agency tenant, two client orgs. The OWNER is in both; the MEMBER is an editor of A
 *  only; the VIEWER reads A only. An `org:` tenant, not `ws:`: neither is a personal
 *  tenant, which is all the org floor distinguishes, so the agency shape behaves the same. */
async function fixture() {
  const tenantId = `org:briefscope-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId: string = (await owner.post(`${H}/test/login`, { email: `bs-o-${n++}@acme.test`, tenantId })).body.user.userId;
  const member = client();
  const memberId: string = (await member.post(`${H}/test/login`, { email: `bs-m-${n++}@acme.test`, tenantId })).body.user.userId;
  const orgA: string = (await owner.post(`${H}/orgs`, { name: 'Client A' })).body.orgId;
  const orgB: string = (await owner.post(`${H}/orgs`, { name: 'Client B' })).body.orgId;
  const add = await owner.post(`${H}/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'M', subject: memberId, roles: ['editor'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  const viewer = client();
  const viewerId: string = (await viewer.post(`${H}/test/login`, { email: `bs-v-${n++}@acme.test`, tenantId })).body.user.userId;
  const addV = await owner.post(`${H}/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'V', subject: viewerId, roles: ['viewer'] });
  expect(addV.status, JSON.stringify(addV.body)).toBe(201);
  // `as never`: the service inputs carry many optional fields; only the name matters here.
  const briefA = await createBrief(tenantId, orgA, ownerId, { name: 'Client A launch', productName: 'Widget' } as never);
  const briefB = await createBrief(tenantId, orgB, ownerId, { name: SECRET, productName: SECRET } as never);
  const personaB = await createPersona(tenantId, orgB, ownerId, { name: SECRET } as never);
  return { tenantId, ownerId, memberId, viewerId, orgA, orgB, briefA: briefA.id, briefB: briefB.id, personaB: personaB.id };
}
const surface = (scope: BundleScope): FeatureSurface => buildFeatureSurfaces(scope)['campaign-brief']!;

describe('campaign-brief surface — a client-A run cannot reach client B rows', () => {
  it('actor not in B: every by-id read is a uniform not-found, lists drop B, writes refuse', async () => {
    const f = await fixture();
    const s = surface({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.memberId });
    expect(await s.getBrief!({ briefId: f.briefB })).toEqual({ brief: null });
    expect(await s.assembleContext!({ briefId: f.briefB })).toEqual({ found: false });
    expect(await s.validateBrief!({ briefId: f.briefB })).toMatchObject({ valid: false });
    expect(await s.getPersona!({ personaId: f.personaB })).toEqual({ persona: null });
    expect(await s.listAngles!({ briefId: f.briefB })).toEqual({ angles: [] });
    expect(await s.listVocEvidence!({ briefId: f.briefB })).toEqual({ evidence: [] });
    expect(await s.listTargetingPacks!({ briefId: f.briefB })).toEqual({ packs: [] });
    expect(await s.getTargetingPack!({ briefId: f.briefB, platform: 'meta' })).toEqual({ pack: null });
    const listed = await s.listBriefs!({});
    expect(leaks(listed)).toBe(false);
    expect(JSON.stringify(listed)).toContain(f.briefA);
    expect(leaks(await s.listPersonas!({}))).toBe(false);
    // Writes: refused, and B's row is untouched.
    await expect(s.setKernel!({ briefId: f.briefB, kernel: { headline: 'pwned' } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.persistVoc!({ briefId: f.briefB, candidates: [] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.persistAngles!({ briefId: f.briefB, candidates: [] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.persistTargeting!({ briefId: f.briefB, candidate: {} })).rejects.toMatchObject({ code: 'not_found' });
    expect((await getBrief(f.tenantId, f.briefB))?.kernel ?? null).toBeNull();
    // Its own org's brief still reads.
    expect((await s.getBrief!({ briefId: f.briefA })).brief).toMatchObject({ id: f.briefA });
  });

  it('a member of BOTH orgs, running for A (orgId: A), cannot ground on B by passing B\'s briefId', async () => {
    const f = await fixture();
    const s = surface({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.ownerId });
    expect(await s.getBrief!({ orgId: f.orgA, briefId: f.briefB })).toEqual({ brief: null });
    expect(await s.assembleContext!({ orgId: f.orgA, briefId: f.briefB })).toEqual({ found: false });
    expect(await s.getPersona!({ orgId: f.orgA, personaId: f.personaB })).toEqual({ persona: null });
    // Naming B for a B brief, or no org at all, is that member's right.
    expect(leaks(await s.getBrief!({ orgId: f.orgB, briefId: f.briefB }))).toBe(true);
    expect(leaks(await s.getBrief!({ briefId: f.briefB }))).toBe(true);
  });

  it('the causing member of an actorless run is held to the same rule', async () => {
    const f = await fixture();
    const s = surface({ tenantId: f.tenantId, runId: 'r1', orgScopeSubject: f.memberId });
    expect(await s.getBrief!({ briefId: f.briefB })).toEqual({ brief: null });
    expect(leaks(await s.listBriefs!({}))).toBe(false);
  });

  it('a system run (no person at all) keeps the tenant-trusted model', async () => {
    const f = await fixture();
    const s = surface({ tenantId: f.tenantId, runId: 'r1' });
    expect(leaks(await s.getBrief!({ briefId: f.briefB }))).toBe(true);
  });

  it('a run\'s brief writes need the write bar in the named org (the route bar)', () => {
    expect(campaignBriefFeature.surface && 'orgPolicy' in campaignBriefFeature.surface ? campaignBriefFeature.surface.orgPolicy?.methodScopes : undefined)
      .toMatchObject({ setKernel: 'workspace:write', persistVoc: 'workspace:write', persistAngles: 'workspace:write', persistTargeting: 'workspace:write' });
  });

  it('the write bar: a viewer of A cannot write A\'s brief (either lane); an editor of A can', async () => {
    const f = await fixture();
    const viewer = surface({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.viewerId });
    expect((await viewer.getBrief!({ briefId: f.briefA })).brief).toMatchObject({ id: f.briefA }); // reads are fine
    await expect(viewer.setKernel!({ briefId: f.briefA, kernel: { headline: 'x' } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(viewer.persistVoc!({ briefId: f.briefA, candidates: [] })).rejects.toMatchObject({ code: 'not_found' });
    // Naming the org: the seam's floor refuses at the write bar first.
    await expect(viewer.setKernel!({ orgId: f.orgA, briefId: f.briefA, kernel: { headline: 'x' } })).rejects.toMatchObject({ code: 'forbidden_scope' });
    expect((await getBrief(f.tenantId, f.briefA))?.kernel ?? null).toBeNull();

    const editor = surface({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.memberId });
    const kernel = { headline: 'A', supportingStatement: 'B', proofPoints: [], primaryCta: 'Go', secondaryCta: '', tone: 'warm', channelTones: {}, sourceDocIds: [] };
    const out = await editor.setKernel!({ briefId: f.briefA, kernel });
    expect(out.brief).toMatchObject({ id: f.briefA });
    expect((await getBrief(f.tenantId, f.briefA))?.kernel).toBeTruthy();
  });
});
