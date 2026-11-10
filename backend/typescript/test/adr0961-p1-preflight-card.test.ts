/**
 * ADR 0961 P1 — a client with no ad account gets a checklist card, not a failure.
 *
 * Real app (memory storage, cookie sessions), real launch, real stage run. Exit
 * criterion (ADR 0961 § Phased plan, P1): "A client with no ad connection gets a
 * checklist card, not a failure". Cases:
 *   - a brief that runs ads, for a client with no ad account: the autopilot run
 *     WAITS on one `clarification` card naming the ad account; nothing fails
 *     and the drafting stage does not start;
 *   - "Check again" with nothing fixed asks again (a new open card, still
 *     waiting), never fails and never proceeds;
 *   - once the client's own ad account is connected, "Check again" lets the
 *     preflight complete and the drafting stage start;
 *   - only an ACTIVE, ORG-scoped connection of the campaign's client counts
 *     (another client's, a workspace-wide one, a person's, or one that needs
 *     reconsent does not — ADR 0921 D4);
 *   - a brief without ads is never asked for an ad account.
 *
 * Sabotage witnesses (each reds the named case; run 2026-10-20):
 *   - the second `ctx.suspend` (`:again`) removed: "Check again with nothing
 *     fixed…" (the node falls through to a failure);
 *   - `c.orgId !== orgId` dropped in `adAccountsForOrg`: "only an ACTIVE,
 *     ORG-scoped…";
 *   - the `ad_variants` condition removed: "a brief without ads…".
 * Re-probed 2026-11-04 (w84g1-*): the node's `ready` short-circuit, the card's
 * item label, `c.status === 'active'`, the `reconnect:` naming and the second
 * suspend each red their case.
 *
 * Double guard (recorded): a person's connection is skipped by `c.userId` AND by
 * `c.orgId !== orgId` in `adAccountsForOrg`, because `createSecretConnection`
 * keeps `orgId` only on an org-scoped row (a user-scoped row cannot name an org).
 * So the `c.userId` check is an equivalent mutant here (w84g1-pf-userid vacuous).
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
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { ensureDraftCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';
import { __setConnectionStatusForTests, createSecretConnection, revokeConnection } from '../src/features/connections/connectionsService.js';
import { adAccountsForOrg } from '../src/host/adsAdapter.js';
import { configureKmsClient, createLocalAesKmsClient } from '../src/byok/kmsEncryption.js';
import { stageRunId } from '../src/features/campaign-autopilot/stageRun.js';
import { bareRunId } from './support/bareRunId.js';

let BASE: string;
let server: http.Server;
let storage: Storage;
let TENANT: string;
let adminCookie: string;
let adminUser: string;
let orgA: string;
let orgB: string;

function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie: adminCookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T };
}

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

async function campaignFor(orgId: string, withAds: boolean): Promise<MarketingCampaign> {
  const brief = await createBrief(TENANT, orgId, adminUser, {
    name: `Ads ${randomBytes(3).toString('hex')}`,
    productName: 'Widget', personaIds: ['p-1'], messaging: { primaryValueProp: 'Faster' },
    channels: [{ type: withAds ? 'ad_variants' : 'email_sequence', enabled: true, config: {} }],
  });
  return (await ensureDraftCampaign(TENANT, brief, adminUser)).campaign;
}

/** Wait for `ok`; a timeout FAILS (a named assertion), never returns the stale value. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  return vi.waitFor(async () => {
    const v = await read();
    expect(ok(v), 'until: condition not reached').toBe(true);
    return v;
  }, { timeout: ms, interval: 50 });
}

/** Narrow a nullable result, failing the case with a message instead of a cast. */
function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}

interface OpenInterrupt { token: string; nodeId: string; kind: string; data?: { questions?: Array<{ question?: string }> } }
const openInterrupts = async (runId: string): Promise<OpenInterrupt[]> =>
  (await call<{ interrupts: OpenInterrupt[] }>('GET', `/host/openwop-app/runs/${encodeURIComponent(bareRunId(runId))}/interrupts`)).body?.interrupts ?? [];

/** Launch, and return the autopilot run once it waits on its checklist card. */
async function launchToCard(c: MarketingCampaign): Promise<{ runId: string; card: OpenInterrupt }> {
  const r = await call<{ runId: string }>('POST', `/host/openwop-app/campaign-autopilot/campaigns/${c.id}/launch`);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const run = await until(() => storage.getRun(bareRunId(r.body.runId)), (x) => !!x && x.status !== 'pending' && x.status !== 'running');
  expect(run?.status, JSON.stringify({ status: run?.status, error: run?.error })).toMatch(/^waiting/);
  const cards = await openInterrupts(r.body.runId);
  expect(cards).toHaveLength(1);
  return { runId: r.body.runId, card: must(cards[0], 'the checklist card') };
}

const stageOf = (runId: string) => storage.getRun(stageRunId(TENANT, bareRunId(runId), 'drafts'));

async function checkAgain(token: string): Promise<void> {
  const res = await call('POST', `/interrupts/${token}`, { resumeValue: { answers: [] } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-orchestration', 'campaign-autopilot']) await setToggle(id, true);
  // A signed-in (`ws:`) tenant stores connection secrets only under KMS.
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));
  const ws = await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:ap1-owner' });
  TENANT = ws.tenantId;
  const admin = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:ap1-admin', source: 'oidc' });
  adminUser = admin.userId;
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin.userId, displayName: 'Admin', roles: ['admin'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  for (const o of [orgA, orgB]) await createMember({ tenantId: TENANT, orgId: o, subject: admin.userId, displayName: 'Admin', roles: ['editor'] });
  adminCookie = cookieFor(admin.userId, 'ws:home-ap1-admin');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0961 P1 — the preflight checklist card', () => {
  it('a client with no ad account gets one checklist card naming it, not a failure; drafting does not start', async () => {
    const c = await campaignFor(orgA, true);
    const pf = await call<{ preflight: { ready: boolean; items: Array<{ id: string; status: string }> } }>('GET', `/host/openwop-app/campaign-autopilot/campaigns/${c.id}/preflight`);
    expect(pf.body.preflight.items.find((i) => i.id === 'ad-account')).toMatchObject({ status: 'missing' });
    const { runId, card } = await launchToCard(c);
    expect(card.kind).toBe('clarification');
    expect(card.data?.questions?.[0]?.question ?? '').toContain("The client's ad account is connected");
    expect(await stageOf(runId)).toBeNull();
  });

  it('"Check again" with nothing fixed asks again, and once the client connects an ad account it continues to drafting', { timeout: 60_000 }, async () => {
    const c = await campaignFor(orgB, true);
    const { runId, card } = await launchToCard(c);
    await checkAgain(card.token);
    // Still blocked: a NEW open card, still waiting, not failed.
    const again = await until(() => openInterrupts(runId), (cs) => cs.length === 1 && cs[0]?.token !== card.token);
    expect(again).toHaveLength(1);
    expect(again[0]?.token).not.toBe(card.token);
    expect((await storage.getRun(bareRunId(runId)))?.status).toMatch(/^waiting/);
    expect(await stageOf(runId)).toBeNull();
    // A third round alternates back to the first key and still asks.
    const second = must(again[0], 'the second card');
    await checkAgain(second.token);
    const third = await until(() => openInterrupts(runId), (cs) => cs.length === 1 && cs[0]?.token !== second.token);
    expect(third).toHaveLength(1);
    expect(third[0]?.token).not.toBe(second.token);
    expect((await storage.getRun(bareRunId(runId)))?.status).toMatch(/^waiting/);
    expect(await stageOf(runId)).toBeNull();

    // The client connects its own ad account; "Check again" now proceeds.
    const conn = await createSecretConnection({ tenantId: TENANT, provider: 'meta-ads', kind: 'bearer', secret: 'test-token', scope: 'org', orgId: c.orgId });
    try {
      await checkAgain(must(third[0], 'the third card').token);
      const done = await until(() => storage.getRun(bareRunId(runId)), (r) => r?.status === 'completed' || r?.status === 'failed');
      expect(done?.status, JSON.stringify({ status: done?.status, error: done?.error })).toBe('completed');
      expect((await stageOf(runId))?.workflowId).toBe('campaign-studio.campaign-orchestration');
    } finally {
      await revokeConnection(TENANT, conn.connectionId).catch(() => undefined);
    }
  });

  it('only an ACTIVE, ORG-scoped connection of the campaign\'s client counts', async () => {
    const other = await createSecretConnection({ tenantId: TENANT, provider: 'google-ads', kind: 'bearer', secret: 't', scope: 'org', orgId: orgB });
    const workspace = await createSecretConnection({ tenantId: TENANT, provider: 'tiktok-ads', kind: 'bearer', secret: 't', scope: 'workspace' });
    const personal = await createSecretConnection({ tenantId: TENANT, provider: 'linkedin-ads', kind: 'bearer', secret: 't', scope: 'user', userId: adminUser });
    let staleId: string | undefined;
    try {
      const a = await adAccountsForOrg(TENANT, orgA);
      expect(a.active).toEqual([]);
      expect((await adAccountsForOrg(TENANT, orgB)).active).toEqual(['google']);
      // One that needs reconsent is named, not counted.
      const stale = await createSecretConnection({ tenantId: TENANT, provider: 'meta-ads', kind: 'bearer', secret: 't', scope: 'org', orgId: orgA });
      staleId = stale.connectionId;
      await __setConnectionStatusForTests(stale.connectionId, 'needs-reconsent');
      expect(await adAccountsForOrg(TENANT, orgA)).toEqual({ active: [], inactive: ['meta'] });
      // …and the checklist names it as a reconnect, not a fresh connect.
      const c = await campaignFor(orgA, true);
      const pf = await call<{ preflight: { items: Array<{ id: string; missing?: string[] }> } }>('GET', `/host/openwop-app/campaign-autopilot/campaigns/${c.id}/preflight`);
      expect(pf.body.preflight.items.find((i) => i.id === 'ad-account')).toMatchObject({ status: 'missing', missing: ['reconnect:meta'] });
    } finally {
      for (const x of [other, workspace, personal]) await revokeConnection(TENANT, x.connectionId).catch(() => undefined);
      if (staleId) await revokeConnection(TENANT, staleId).catch(() => undefined);
    }
  });

  it('a brief without ads is never asked for an ad account', async () => {
    const c = await campaignFor(orgA, false);
    const pf = await call<{ preflight: { ready: boolean; items: Array<{ id: string }> } }>('GET', `/host/openwop-app/campaign-autopilot/campaigns/${c.id}/preflight`);
    expect(pf.body.preflight.ready).toBe(true);
    expect(pf.body.preflight.items.map((i) => i.id)).not.toContain('ad-account');
  });
});
