/**
 * DG-SEC-1 — an apply grant is SELF-consent, at the route AND at the lookup.
 *
 * The defect: `POST …/orgs/:orgId/grants` took `subjectId` from the body, gated
 * only by `workspace:write`, and `consultApplyGrant` matched on subject +
 * campaign. So a colleague could mint an AUTO-SUBMIT grant over a co-worker's
 * campaign, and that campaign's runs would honour it. ADR 0541 OQ-3 (granting
 * on another member's behalf) is undecided, so no one may consent for anyone.
 *
 * Built in a REAL `ws:` shared workspace with two distinct humans, through the
 * production routes — in a personal tenant both sessions canonicalize onto one
 * user and the rule cannot be broken (see job-search-attestation-subject-rule).
 *
 * Sabotage-witnessed: restoring the body `subjectId` reddens the route leg;
 * dropping the `grantedBy === subjectId` filter reddens the lookup legs.
 *
 * Double guard, recorded (/grade-tests w81): the route leg is held by the 403
 * refusal AND by the grant taking `subjectId` from the session, never the body.
 * Dropping the refusal alone reds the status assertion; "nothing is stored" can
 * fail only when both go (one probe breaks both). The list filter, the lookup's
 * org filter and the session-sourced `grantedBy` are each witnessed too.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { enableTenantOverride } from '../src/host/featureToggles/service.js';
import { applyGrants, consultApplyGrant, createApplyGrant } from '../src/host/applyGrant.js';
import { getSetCookies } from './headerCookies.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  // The de-facto-owner bypass would hand the colleague OWNER scopes and make
  // every refusal below vacuous.
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 180_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

let n = 0;

interface Res<T> { status: number; body: T | undefined }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const sc of getSetCookies(res.headers)) {
      const m = /(__session=[^;]+)/.exec(sc);
      if (m?.[1]) cookie = m[1];
    }
    const parsed: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: parsed as T | undefined };
  };
  return {
    get: <T = unknown>(p: string) => call<T>('GET', p),
    post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b),
  };
}

async function signIn(c: ReturnType<typeof client>): Promise<string> {
  const r = await c.post<{ user?: { userId?: string } }>('/host/openwop-app/test/login', { email: `dgsec1-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const userId = r.body?.user?.userId ?? '';
  expect(userId).not.toBe('');
  return userId;
}

const ORIGIN = 'boards.example.com';
const grantBody = (campaignId: string, extra: Record<string, unknown> = {}) => ({
  campaignId, maxSubmits: 5, maxPrepared: 3, ratePerHour: 4, origins: [ORIGIN],
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...extra,
});

/** An owner and an ADMIN colleague inside one real `ws:` workspace. */
async function team() {
  const owner = client();
  const ownerId = await signIn(owner);
  const ws = await owner.post<{ workspaceId?: string }>('/host/openwop-app/workspaces', { name: `WS ${n++}` });
  expect(ws.status, JSON.stringify(ws.body)).toBe(201);
  const wsId = ws.body?.workspaceId ?? '';
  expect(wsId, 'a personal tenant would make this test vacuous').toMatch(/^ws:/);
  expect((await owner.post(`/host/openwop-app/workspaces/${encodeURIComponent(wsId)}/switch`)).status).toBe(200);
  await enableTenantOverride('job-search', wsId, 'test');

  const mate = client();
  const mateId = await signIn(mate);
  expect(mateId).not.toBe(ownerId);
  const added = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(wsId)}/members`, {
    displayName: 'Colleague', subject: mateId, roles: ['admin'],
  });
  expect(added.status, `member add failed: ${JSON.stringify(added.body)}`).toBe(201);
  expect((await mate.post(`/host/openwop-app/workspaces/${encodeURIComponent(wsId)}/switch`)).status).toBe(200);
  const grants = `/host/openwop-app/job-search/orgs/${encodeURIComponent(wsId)}/grants`;
  return { owner, ownerId, mate, mateId, wsId, grants };
}

const consult = (tenantId: string, subjectId: string, campaignId: string, extra: Partial<Parameters<typeof consultApplyGrant>[0]> = {}) =>
  consultApplyGrant({ tenantId, subjectId, campaignId, origin: ORIGIN, commitClass: 'submit', tier: 'A', now: Date.now(), ...extra });

describe('DG-SEC-1 — the route: a grant names only its own author', () => {
  it("a colleague naming a co-worker as the subject is refused, and nothing is stored", async () => {
    const t = await team();
    // The premise: the colleague really can write grants here.
    const ownGrant = await t.mate.post<{ grant?: { subjectId?: string } }>(t.grants, grantBody(`camp-own-${n++}`));
    expect(ownGrant.status, `the colleague must genuinely hold workspace:write: ${JSON.stringify(ownGrant.body)}`).toBe(201);

    const forged = await t.mate.post<{ error?: string; message?: string }>(t.grants, grantBody(`camp-victim-${n++}`, { subjectId: t.ownerId }));
    expect(forged.status, `a colleague consented for someone else: ${JSON.stringify(forged.body)}`).toBe(403);
    expect(forged.body).toEqual({ error: 'forbidden', message: 'An apply grant authorises your own applications only.' });

    const stored = (await applyGrants.listByPrefix(`${t.wsId}:`)).filter((g) => g.subjectId === t.ownerId);
    expect(stored, 'a refused grant must not be written').toEqual([]);
  }, 120_000);

  it('a self-grant still works, with or without naming yourself, and the subject is the author', async () => {
    const t = await team();
    const plain = await t.owner.post<{ grant?: { subjectId?: string; grantedBy?: string } }>(t.grants, grantBody(`camp-a-${n++}`));
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    expect(plain.body?.grant).toMatchObject({ subjectId: t.ownerId, grantedBy: t.ownerId });
    const named = await t.owner.post(t.grants, grantBody(`camp-b-${n++}`, { subjectId: t.ownerId }));
    expect(named.status, JSON.stringify(named.body)).toBe(201);
  }, 120_000);

  it("the list shows a member their OWN grants, never a colleague's", async () => {
    const t = await team();
    const campaignId = `camp-private-${n++}`;
    const mateCampaign = `camp-mate-${n++}`;
    expect((await t.owner.post(t.grants, grantBody(campaignId))).status).toBe(201);
    expect((await t.mate.post(t.grants, grantBody(mateCampaign))).status).toBe(201);
    const seen = await t.mate.get<{ grants?: Array<{ campaignId: string }> }>(t.grants);
    expect(seen.status).toBe(200);
    // Exactly the colleague's own grant: a missing body cannot pass as "nothing leaked".
    expect(seen.body?.grants?.map((g) => g.campaignId)).toEqual([mateCampaign]);
    const mine = await t.owner.get<{ grants?: Array<{ campaignId: string }> }>(t.grants);
    expect(mine.body?.grants?.map((g) => g.campaignId)).toEqual([campaignId]);
  }, 120_000);
});

describe('DG-SEC-1 — the lookup: a stored cross-subject grant is inert', () => {
  it("a grant one member holds over another's campaign authorises nothing, at either caller's shape", async () => {
    const t = await team();
    const campaignId = `camp-stored-${n++}`;
    // A row the route can no longer write, but which storage may already hold.
    await createApplyGrant({
      tenantId: t.wsId, orgId: t.wsId, subjectId: t.ownerId, grantedBy: t.mateId, campaignId,
      maxSubmits: 5, maxPrepared: 3, ratePerHour: 4, origins: [ORIGIN], resumePolicy: 'default',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    // The autopilot pipeline's shape: subject + campaign only.
    expect(await consult(t.wsId, t.ownerId, campaignId)).toMatchObject({ allowed: false, refusal: 'no-grant' });
    // computer-use's shape (ADR 0894 D7): narrowed to the grantor's own session.
    expect(await consult(t.wsId, t.ownerId, campaignId, { orgId: t.wsId, grantedBy: t.mateId }))
      .toMatchObject({ allowed: false, refusal: 'no-grant' });
  }, 120_000);

  it("the owner's own grant still authorises their campaign, and only in its own org", async () => {
    const t = await team();
    const campaignId = `camp-self-${n++}`;
    expect((await t.owner.post(t.grants, grantBody(campaignId))).status).toBe(201);
    expect(await consult(t.wsId, t.ownerId, campaignId)).toMatchObject({ allowed: true });
    expect(await consult(t.wsId, t.ownerId, campaignId, { orgId: t.wsId, grantedBy: t.ownerId })).toMatchObject({ allowed: true });
    // Cross-org stays refused.
    expect(await consult(t.wsId, t.ownerId, campaignId, { orgId: 'org-elsewhere' })).toMatchObject({ allowed: false, refusal: 'no-grant' });
  }, 120_000);
});
