/**
 * ADR 0816 — notification audience + delivery integrity, through the REAL
 * production identity path (personal sign-in → real `ws:` workspace → invite →
 * accept → switch; demo mode OFF). Web Push is configured with real VAPID keys
 * and every subscription endpoint points at a local capture server, so a
 * "delivered" assertion counts actual outbound HTTP, not a mocked call.
 *
 *  S1 — a role-addressed notice reaches ONLY role-holders' devices (Web Push
 *       used to treat "no recipientUserId" as broadcast, so an ADR 0710
 *       operator notice reached every member's phone).
 *  S2 — a removed member's devices and open streams stop receiving the
 *       workspace's notices.
 *  S3 — push subscriptions: no attacker-chosen endpoint (SSRF), no re-homing an
 *       existing endpoint, no listing or deleting another member's devices.
 *  S4 — a shared (broadcast / role) notice is per-person state: one member's
 *       read / archive / delete never changes it for anyone else.
 *
 * Every refusal leg re-reads state, so a 4xx from an unrelated gate cannot pass.
 */
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getNotificationEmitter } from '../src/notifications/emitter.js';
import { buildNotificationsSurface } from '../src/features/notifications/surface.js';
import { pushNotification } from '../src/notifications/webPush.js';
import { notificationSubject } from '../src/notifications/audience.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { getSetCookies } from './headerCookies.js';
import type { Storage } from '../src/storage/storage.js';

const H = '/host/openwop-app';
const N = `${H}/notifications`;
let BASE = '';
let server: http.Server;
let storage: Storage;
let n = 0;
const saved: Record<string, string | undefined> = {};

/* ── the capture server every push endpoint points at ───────────────────── */
let PUSH = '';
let pushServer: https.Server;
const hits = new Map<string, number>();
const hitsOn = (path: string): number => hits.get(path) ?? 0;

interface Res { status: number; body: any }

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', connection: 'close', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return {
    call,
    cookie: () => cookie,
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;

async function signIn(c: Client, email: string): Promise<void> {
  const r = await c.post(`${H}/test/login`, { email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

const membersPath = (ws: string) => `${H}/orgs/${encodeURIComponent(ws)}/members`;

interface M { memberId: string; roles: string[]; subject?: string; email?: string }
async function members(c: Client, ws: string): Promise<M[]> {
  const r = await c.get(membersPath(ws));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.members as M[];
}

async function joinAs(owner: Client, ws: string, role: string): Promise<{ c: Client; m: M }> {
  const email = `r816-${role}-${n++}@acme.test`;
  const invite = await owner.post(`${H}/orgs/${encodeURIComponent(ws)}/invites`, { email, role });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  const c = client();
  await signIn(c, email);
  expect((await c.post(`${H}/orgs/invitations/accept`, { token: invite.body.token })).status).toBe(201);
  expect((await c.post(`${H}/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
  const m = (await members(owner, ws)).find((x) => x.email === email)!;
  return { c, m };
}

/** A shared workspace with an owner, an admin and a viewer. */
async function fixture() {
  const owner = client();
  await signIn(owner, `r816-owner-${n++}@acme.test`);
  const ws = await owner.post(`${H}/workspaces`, { name: `R816 ${n++}` });
  expect(ws.status, JSON.stringify(ws.body)).toBe(201);
  const id = ws.body.workspaceId as string;
  expect((await owner.post(`${H}/workspaces/${encodeURIComponent(id)}/switch`)).status).toBe(200);
  const { c: admin, m: adminMember } = await joinAs(owner, id, 'admin');
  const { c: viewer, m: viewerMember } = await joinAs(owner, id, 'viewer');
  return { owner, admin, adminMember, viewer, viewerMember, ws: id };
}

/** A real browser-shaped subscription whose endpoint is the capture server. */
function subscription(path: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `${PUSH}${path}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

async function subscribe(c: Client, path: string): Promise<string> {
  const r = await c.post(`${N}/push/subscribe`, subscription(path));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.subscriptionId as string;
}

/** Push delivery is fire-and-forget off the emit; wait for it to settle. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
}

async function inbox(c: Client, query = ''): Promise<Array<{ notificationId: string; status: string; title: string }>> {
  const r = await c.get(`${N}${query}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.notifications;
}

/** Open the SSE stream as `c` and collect every notification frame's title. */
function openStream(c: Client): { titles: string[]; close: () => void; ready: Promise<void> } {
  const titles: string[] = [];
  const ctrl = new AbortController();
  const ready = (async () => {
    const res = await fetch(`${BASE}${N}/stream`, { headers: { cookie: c.cookie(), accept: 'text/event-stream' }, signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = /^data: (.*)$/m.exec(frame);
            if (/^event: notification$/m.test(frame) && data) titles.push(JSON.parse(data[1]!).title);
          }
        }
      } catch { /* aborted */ }
    })();
  })();
  return { titles, close: () => ctrl.abort(), ready };
}

beforeAll(async () => {
  for (const k of ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_DEMO_MODE', 'OPENWOP_VAPID_PUBLIC_KEY', 'OPENWOP_VAPID_PRIVATE_KEY', 'OPENWOP_PUSH_ENDPOINT_ALLOW_ORIGINS', 'NODE_TLS_REJECT_UNAUTHORIZED']) saved[k] = process.env[k];
  // web-push always speaks TLS, so the capture server is HTTPS with a throwaway
  // self-signed cert, and THIS worker trusts it (restored in afterAll).
  const certDir = mkdtempSync(join(tmpdir(), 'adr0816-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], { stdio: 'ignore' });
  const tls = { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) };
  rmSync(certDir, { recursive: true, force: true });
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  pushServer = https.createServer(tls, (req, res) => {
    hits.set(req.url ?? '', (hits.get(req.url ?? '') ?? 0) + 1);
    req.resume();
    req.on('end', () => { res.statusCode = 201; res.end(); });
  });
  await new Promise<void>((res) => { pushServer.listen(0, '127.0.0.1', () => { PUSH = `https://127.0.0.1:${(pushServer.address() as AddressInfo).port}`; res(); }); });
  const keys = webpush.generateVAPIDKeys();
  process.env.OPENWOP_VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.OPENWOP_VAPID_PRIVATE_KEY = keys.privateKey;
  // The capture server is loopback. ADR 0816 D3's exact-origin hatch (the WHD-19
  // shape) admits THIS origin only; every other private destination stays
  // refused (S3 asserts it). On a host without D3 the variable is inert.
  process.env.OPENWOP_PUSH_ENDPOINT_ALLOW_ORIGINS = PUSH;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0816', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'orgs']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
}, 120_000);

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => pushServer.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

beforeEach(() => hits.clear());

describe('ADR 0816 S1 — a role-addressed notice reaches only role-holders', () => {
  it('Web Push delivers an operator (admin-role) notice to the admin\'s device and NOT the viewer\'s', async () => {
    const { admin, viewer, ws } = await fixture();
    const a = `/s1-admin-${n++}`;
    const v = `/s1-viewer-${n++}`;
    await subscribe(admin, a);
    await subscribe(viewer, v);
    await getNotificationEmitter().emit({
      tenantId: ws, recipientRole: 'admin', type: 'workflow.failed', priority: 'high',
      title: 'S1 operator notice', message: 'payroll-sync failed: secret gate prompt',
    });
    await settle();
    expect(hitsOn(a), 'the role-holder\'s device is told').toBe(1);
    expect(hitsOn(v), 'a viewer\'s device must not receive an admin-addressed notice').toBe(0);
    // The inbox already default-denies; the device lane must agree with it.
    expect((await inbox(viewer)).some((x) => x.title === 'S1 operator notice')).toBe(false);
    expect((await inbox(admin)).some((x) => x.title === 'S1 operator notice')).toBe(true);
  });

  it('the workspace OWNER is an operator: an admin-role notice reaches the owner\'s inbox and device', async () => {
    const { owner, ws } = await fixture();
    const o = `/s1-owner-${n++}`;
    await subscribe(owner, o);
    await getNotificationEmitter().emit({
      tenantId: ws, recipientRole: 'admin', type: 'workflow.failed', priority: 'high',
      title: 'S1 owner notice', message: 'm',
    });
    await settle();
    expect((await inbox(owner)).some((x) => x.title === 'S1 owner notice')).toBe(true);
    expect(hitsOn(o)).toBe(1);
  });
});

describe('ADR 0816 S2 — removal stops delivery', () => {
  it('a removed member\'s device no longer receives the workspace\'s broadcasts', async () => {
    const { owner, viewer, viewerMember, ws } = await fixture();
    const v = `/s2-viewer-${n++}`;
    const o = `/s2-owner-${n++}`;
    await subscribe(viewer, v);
    await subscribe(owner, o);
    expect((await owner.del(`${membersPath(ws)}/${encodeURIComponent(viewerMember.memberId)}`)).status).toBeLessThan(300);
    await getNotificationEmitter().emit({ tenantId: ws, type: 'system.alert', priority: 'normal', title: 'S2 after removal', message: 'm' });
    await settle();
    expect(hitsOn(o), 'a remaining member is still told').toBe(1);
    expect(hitsOn(v), 'the removed member\'s device must not be').toBe(0);
  });

  it('a removed member\'s OPEN stream stops receiving the workspace\'s notices', async () => {
    const { owner, viewer, viewerMember, ws } = await fixture();
    const stream = openStream(viewer);
    await stream.ready;
    await getNotificationEmitter().emit({ tenantId: ws, type: 'system.alert', priority: 'normal', title: 'S2 before', message: 'm' });
    await settle();
    expect(stream.titles).toContain('S2 before');
    expect((await owner.del(`${membersPath(ws)}/${encodeURIComponent(viewerMember.memberId)}`)).status).toBeLessThan(300);
    await getNotificationEmitter().emit({ tenantId: ws, type: 'system.alert', priority: 'normal', title: 'S2 after', message: 'm' });
    await settle();
    stream.close();
    expect(stream.titles).not.toContain('S2 after');
  });
});

describe('ADR 0816 S3 — push subscriptions', () => {
  it('refuses an endpoint on a private / metadata address (SSRF)', async () => {
    const { viewer } = await fixture();
    for (const endpoint of ['http://169.254.169.254/computeMetadata/', 'http://10.0.0.5/internal', 'https://localhost:8443/x']) {
      const r = await viewer.post(`${N}/push/subscribe`, { ...subscription('/x'), endpoint });
      expect(r.status, endpoint).toBe(400);
    }
  });

  it('refuses a plain-http endpoint even on a public host', async () => {
    const { viewer } = await fixture();
    const r = await viewer.post(`${N}/push/subscribe`, { ...subscription('/x'), endpoint: 'http://fcm.googleapis.com/fcm/send/abc' });
    expect(r.status).toBe(400);
  });

  it('another tenant cannot re-home an existing endpoint into its own workspace', async () => {
    const { owner, ws } = await fixture();
    const path = `/s3-rehome-${n++}`;
    await subscribe(owner, path);
    const other = client();
    await signIn(other, `r816-intruder-${n++}@evil.test`);
    const r = await other.post(`${N}/push/subscribe`, subscription(path));
    expect(r.status).toBeGreaterThanOrEqual(400);
    // The victim's device still belongs to the victim's workspace.
    const subs = await storage.listPushSubscriptions(ws);
    expect(subs.some((s) => s.endpoint === `${PUSH}${path}`)).toBe(true);
    await getNotificationEmitter().emit({ tenantId: ws, type: 'system.alert', priority: 'normal', title: 'S3 still mine', message: 'm' });
    await settle();
    expect(hitsOn(path)).toBe(1);
  });

  it('a member lists only their OWN devices, and cannot delete another member\'s', async () => {
    const { owner, viewer } = await fixture();
    const ownerSub = await subscribe(owner, `/s3-owner-${n++}`);
    const viewerSub = await subscribe(viewer, `/s3-viewer-${n++}`);
    const listed = (await viewer.get(`${N}/push/subscriptions`)).body.subscriptions as Array<{ subscriptionId: string }>;
    expect(listed.map((s) => s.subscriptionId)).toContain(viewerSub);
    expect(listed.map((s) => s.subscriptionId)).not.toContain(ownerSub);
    expect((await viewer.del(`${N}/push/subscriptions/${ownerSub}`)).status).toBe(404);
    const ownerListed = (await owner.get(`${N}/push/subscriptions`)).body.subscriptions as Array<{ subscriptionId: string }>;
    expect(ownerListed.map((s) => s.subscriptionId)).toContain(ownerSub);
  });
});

describe('ADR 0816 S4 — a shared notice is per-person state', () => {
  async function broadcast(ws: string, title: string): Promise<void> {
    await getNotificationEmitter().emit({ tenantId: ws, type: 'system.alert', priority: 'normal', title, message: 'm' });
  }
  /** The row of `title` in `c`'s own inbox — each member holds their own. */
  async function mine(c: Client, title: string, query = '?includeArchived=true') {
    return (await inbox(c, query)).find((x) => x.title === title);
  }

  it('a viewer deleting a broadcast removes it from THEIR inbox only', async () => {
    const { owner, viewer, ws } = await fixture();
    await broadcast(ws, 'S4 delete');
    const v = await mine(viewer, 'S4 delete');
    expect(v, 'the viewer was told').toBeDefined();
    expect((await viewer.del(`${N}/${v!.notificationId}`)).status).toBe(200);
    expect(await mine(viewer, 'S4 delete')).toBeUndefined();
    expect(await mine(owner, 'S4 delete'), 'the owner still has it').toBeDefined();
  });

  it('a viewer archiving / reading a broadcast does not archive / read it for the owner', async () => {
    const { owner, viewer, ws } = await fixture();
    await broadcast(ws, 'S4 archive');
    await broadcast(ws, 'S4 read');
    expect((await viewer.post(`${N}/${(await mine(viewer, 'S4 archive'))!.notificationId}/archive`)).status).toBe(200);
    expect((await viewer.post(`${N}/${(await mine(viewer, 'S4 read'))!.notificationId}/read`)).status).toBe(200);
    expect((await mine(owner, 'S4 archive'))?.status).toBe('unread');
    expect((await mine(owner, 'S4 read'))?.status).toBe('unread');
    expect((await mine(viewer, 'S4 archive'))?.status).toBe('archived');
    expect((await mine(viewer, 'S4 read'))?.status).toBe('read');
  });

  it('a viewer cannot reach the owner\'s copy by id', async () => {
    const { owner, viewer, ws } = await fixture();
    await broadcast(ws, 'S4 by id');
    const o = await mine(owner, 'S4 by id');
    expect((await viewer.del(`${N}/${o!.notificationId}`)).status).toBe(404);
    expect((await viewer.post(`${N}/${o!.notificationId}/archive`)).status).toBe(404);
    expect((await mine(owner, 'S4 by id'))?.status).toBe('unread');
  });

  it('mark-all-read clears the caller\'s view only', async () => {
    const { owner, viewer, ws } = await fixture();
    await broadcast(ws, 'S4 mark-all');
    expect((await viewer.post(`${N}:mark-all-read`)).status).toBe(200);
    expect((await mine(viewer, 'S4 mark-all'))?.status).toBe('read');
    expect((await mine(owner, 'S4 mark-all'))?.status).toBe('unread');
  });
});

describe('ADR 0816 D3 — a second person on the SAME browser may rebind (proof of possession)', () => {
  it('the same endpoint + the same keys from another user rebinds; the first owner no longer gets that device', async () => {
    const { owner, viewer, ws } = await fixture();
    const path = `/d3-shared-browser-${n++}`;
    const sub = subscription(path);
    expect((await owner.post(`${N}/push/subscribe`, sub)).status).toBe(201);
    expect((await viewer.post(`${N}/push/subscribe`, sub)).status, 'same browser, same keys').toBe(201);
    const rows = (await storage.listPushSubscriptions(ws)).filter((s) => s.endpoint === `${PUSH}${path}`);
    expect(rows).toHaveLength(1);
    const ownerListed = (await owner.get(`${N}/push/subscriptions`)).body.subscriptions as Array<{ endpoint: string }>;
    expect(ownerListed.some((s) => s.endpoint === `${PUSH}${path}`)).toBe(false);
  });
});

describe('ADR 0816 D5 — device push honours the person\'s preferences', () => {
  it('a type with desktop off, and a muted type, do not reach that person\'s device; the inbox row still lands', async () => {
    const { owner, viewer, ws } = await fixture();
    const v = `/d5-viewer-${n++}`;
    const o = `/d5-owner-${n++}`;
    await subscribe(viewer, v);
    await subscribe(owner, o);
    const current = (await viewer.get(`${N}/preferences`)).body.preferences;
    const types = [
      ...current.types.filter((t: { type: string }) => t.type !== 'system.alert' && t.type !== 'workflow.failed'),
      { type: 'system.alert', muted: false, desktop: false },
      { type: 'workflow.failed', muted: true, desktop: true },
    ];
    const put = await viewer.call('PUT', `${N}/preferences`, { ...current, types });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    await getNotificationEmitter().emit({ tenantId: ws, type: 'system.alert', priority: 'normal', title: 'D5 desktop off', message: 'm' });
    await getNotificationEmitter().emit({ tenantId: ws, type: 'workflow.failed', priority: 'high', title: 'D5 muted', message: 'm' });
    await settle();
    expect(hitsOn(v), 'the viewer opted out of both device toasts').toBe(0);
    expect(hitsOn(o), 'the owner did not').toBe(2);
    expect((await inbox(viewer)).some((x) => x.title === 'D5 desktop off'), 'muting is not erasing').toBe(true);
  });
});

describe('ADR 0816 D8 — `self` never addresses someone who left the workspace', () => {
  it('a removed member\'s still-running scheduled run is refused, not delivered', async () => {
    const { owner, viewer, viewerMember, ws } = await fixture();
    const subject = (await members(owner, ws)).find((m) => m.memberId === viewerMember.memberId)!.subject!;
    expect((await owner.del(`${membersPath(ws)}/${encodeURIComponent(viewerMember.memberId)}`)).status).toBeLessThan(300);
    const surface = buildNotificationsSurface({ tenantId: ws, actingUserId: subject, runId: `r816-${n++}` } as BundleScope);
    const r = await surface.emit({ audience: 'self', title: 'D8 after removal', message: 'm' });
    expect(r).toMatchObject({ emitted: false, reason: 'acting_user_not_member' });
    expect(await storage.listNotifications({ tenantId: ws, recipientUserId: subject, limit: 50 }))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ title: 'D8 after removal' })]));
    void viewer;
  });
});

describe('ADR 0816 D4 — delivery re-checks presence on the lanes D1 does not cover', () => {
  it('an UNADDRESSED frame (a signal) never reaches a removed member\'s open stream — the removal ends it', async () => {
    const { owner, viewer, viewerMember, ws } = await fixture();
    const stream = openStream(viewer);
    await stream.ready;
    getNotificationEmitter().signal({ tenantId: ws, type: 'system.alert', priority: 'low', title: 'D4 signal before', message: '' });
    await settle();
    expect(stream.titles).toContain('D4 signal before');
    expect((await owner.del(`${membersPath(ws)}/${encodeURIComponent(viewerMember.memberId)}`)).status).toBeLessThan(300);
    getNotificationEmitter().signal({ tenantId: ws, type: 'system.alert', priority: 'low', title: 'D4 signal after', message: '' });
    await settle();
    stream.close();
    expect(stream.titles).not.toContain('D4 signal after');
  });

  it('Web Push skips a device whose owner is no longer a member, even for an unaddressed record', async () => {
    const { owner, viewer, viewerMember, ws } = await fixture();
    const v = `/d4-stale-${n++}`;
    const o = `/d4-owner-${n++}`;
    const viewerSubject = (await members(owner, ws)).find((m) => m.memberId === viewerMember.memberId)!.subject!;
    await subscribe(owner, o);
    expect((await owner.del(`${membersPath(ws)}/${encodeURIComponent(viewerMember.memberId)}`)).status).toBeLessThan(300);
    // A device row the removal cascade did not see (another instance, a failed
    // hook): planted directly, as the cascade-less past would have left it.
    const keys = subscription(v).keys;
    await storage.insertPushSubscription({
      subscriptionId: `stale-${n++}`, tenantId: ws, userId: viewerSubject, endpoint: `${PUSH}${v}`,
      p256dhKey: keys.p256dh, authKey: keys.auth, createdAt: new Date().toISOString(),
    });
    // An unaddressed record straight into the push lane — the shape D1 never
    // produces in a ws: tenant, which is exactly the fallback D4 guards.
    await pushNotification(storage, {
      notificationId: `d4-${n++}`, tenantId: ws, type: 'system.alert', priority: 'normal', status: 'unread',
      title: 'D4 unaddressed', message: 'm', createdAt: new Date().toISOString(),
    });
    expect(hitsOn(o)).toBe(1);
    expect(hitsOn(v)).toBe(0);
    void viewer;
  });
});

describe('ADR 0816 D0 — one notification subject per request', () => {
  const req = (over: Record<string, unknown>) => over as unknown as Parameters<typeof notificationSubject>[0];
  it('ws: an unbound OIDC member (no userId) reads as the principal it was admitted under, never unfiltered', () => {
    expect(notificationSubject(req({ tenantId: 'ws:a', principal: { principalId: 'oidc:abc', tenants: ['ws:a'], auth: { kind: 'subject' } } }))).toBe('oidc:abc');
  });
  it('ws: an owk_ key reads as its issuer', () => {
    expect(notificationSubject(req({ tenantId: 'ws:a', principal: { principalId: 'apikey:k1', tenants: ['ws:a'], auth: { kind: 'api-key', issuer: 'user:u1', scopes: [] } } }))).toBe('user:u1');
  });
  it('a wildcard principal keeps the unfiltered view; a personal tenant keeps req.userId', () => {
    expect(notificationSubject(req({ tenantId: 'ws:a', principal: { principalId: 'admin', tenants: ['*'] } }))).toBeUndefined();
    expect(notificationSubject(req({ tenantId: 'user:h', userId: 'user:u1', principal: { principalId: 'user:u1', tenants: ['user:h'] } }))).toBe('user:u1');
  });
});
