/**
 * PROF-1 (Blocker) — profile avatars/portfolio images must OUTLIVE the 7-day
 * scratch TTL the `/media/upload` lane mints. The SPA uploads through that lane,
 * and before this fix the profile stored the scratch token forever: the bytes
 * died a week later while `viewProfile` kept serving the dead token (a broken
 * `<img>` for every profile picture, invisible to any test without a clock).
 *
 * The fix promotes the token IN PLACE onto the durable lane when the profile
 * persists it (`requireImageToken` → `mediaStorage.promoteToDurable`), and the
 * profiles byte-ref provider shields the promoted bytes from the ADR 0579
 * orphan sweep (which only knows `media:asset` library rows).
 *
 * Time-travel discipline: only `Date` is faked (`toFake: ['Date']`) so the HTTP
 * server keeps working; all post-travel reads ride the auth-exempt
 * `GET /assets/:token` route or direct service imports — an 8-day jump would
 * otherwise expire the session cookie and fail for an unrelated reason.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});
afterEach(() => {
  vi.useRealTimers();
});

interface Res<T = any> { status: number; body: T }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const sc of getSetCookies(res.headers) as string[]) {
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function signedIn(): Promise<ReturnType<typeof client>> {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `dur-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return c;
}

// A 1×1 transparent PNG (the repo's standard fixture bytes).
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function upload(c: ReturnType<typeof client>): Promise<string> {
  const r = await c.post('/v1/host/openwop-app/media/upload', { contentBase64: PNG_1x1, contentType: 'image/png', name: 'a.png' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.token as string;
}

const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

/** Travel `ms` forward faking ONLY `Date` (server timers/sockets stay real). */
function travel(ms: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(Date.now() + ms));
}

describe('PROF-1 — profile images survive past the scratch TTL (time-travel)', () => {
  it('a persisted avatar outlives 7 days; an unpromoted upload does not (both polarities)', async () => {
    const c = await signedIn();
    const avatarToken = await upload(c);
    const controlToken = await upload(c); // uploaded, never persisted → stays scratch

    const set = await c.put('/v1/host/openwop-app/profiles/me/avatar', { token: avatarToken });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    // Promotion is IN PLACE — the stored reference is the SAME token the client
    // holds (token-keyed idempotency + remove-by-token stay intact).
    expect(set.body.avatarAssetToken).toBe(avatarToken);

    travel(EIGHT_DAYS_MS);

    // Counter-polarity FIRST: the un-promoted control token is dead, which
    // proves the clock actually advanced and the scratch TTL really bites —
    // without this the avatar assertion could pass vacuously on a frozen clock.
    const dead = await c.get(`/v1/host/openwop-app/assets/${encodeURIComponent(controlToken)}`);
    expect(dead.status).toBe(404);

    // The promoted avatar bytes are still served.
    const alive = await c.get(`/v1/host/openwop-app/assets/${encodeURIComponent(avatarToken)}`);
    expect(alive.status).toBe(200);
  });

  it('a persisted portfolio image outlives 7 days', async () => {
    const c = await signedIn();
    const token = await upload(c);
    const add = await c.post('/v1/host/openwop-app/profiles/me/portfolio', { token });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.portfolioAssetTokens).toContain(token);

    travel(EIGHT_DAYS_MS);

    const alive = await c.get(`/v1/host/openwop-app/assets/${encodeURIComponent(token)}`);
    expect(alive.status).toBe(200);
  });
});

describe('F1 — every reference-OUT path reclaims the promoted bytes (no indefinite PII retention)', () => {
  it('replacing the avatar demotes the overwritten token; the new one stays durable', async () => {
    const c = await signedIn();
    const first = await upload(c);
    const second = await upload(c);
    expect((await c.put('/v1/host/openwop-app/profiles/me/avatar', { token: first })).status).toBe(200);
    expect((await c.put('/v1/host/openwop-app/profiles/me/avatar', { token: second })).status).toBe(200);

    travel(EIGHT_DAYS_MS);
    expect((await c.get(`/v1/host/openwop-app/assets/${encodeURIComponent(first)}`)).status).toBe(404); // released
    expect((await c.get(`/v1/host/openwop-app/assets/${encodeURIComponent(second)}`)).status).toBe(200); // live ref
  });

  it('clearing the avatar demotes its token back to the scratch window', async () => {
    const c = await signedIn();
    const token = await upload(c);
    expect((await c.put('/v1/host/openwop-app/profiles/me/avatar', { token })).status).toBe(200);
    expect((await c.del('/v1/host/openwop-app/profiles/me/avatar')).status).toBe(200);

    travel(EIGHT_DAYS_MS);
    expect((await c.get(`/v1/host/openwop-app/assets/${encodeURIComponent(token)}`)).status).toBe(404);
  });

  it('removing a portfolio image demotes it; a kept sibling stays durable', async () => {
    const c = await signedIn();
    const removed = await upload(c);
    const kept = await upload(c);
    expect((await c.post('/v1/host/openwop-app/profiles/me/portfolio', { token: removed })).status).toBe(201);
    expect((await c.post('/v1/host/openwop-app/profiles/me/portfolio', { token: kept })).status).toBe(201);
    expect((await c.del(`/v1/host/openwop-app/profiles/me/portfolio/${encodeURIComponent(removed)}`)).status).toBe(200);

    travel(EIGHT_DAYS_MS);
    expect((await c.get(`/v1/host/openwop-app/assets/${encodeURIComponent(removed)}`)).status).toBe(404);
    expect((await c.get(`/v1/host/openwop-app/assets/${encodeURIComponent(kept)}`)).status).toBe(200);
  });

  it('a token STILL referenced elsewhere on the profile is NOT demoted (the co-referent guard)', async () => {
    const c = await signedIn();
    const token = await upload(c);
    expect((await c.put('/v1/host/openwop-app/profiles/me/avatar', { token })).status).toBe(200);
    expect((await c.post('/v1/host/openwop-app/profiles/me/portfolio', { token })).status).toBe(201);
    // Clearing the avatar releases the ref — but the portfolio still holds it,
    // so the post-write referent check must keep it durable.
    expect((await c.del('/v1/host/openwop-app/profiles/me/avatar')).status).toBe(200);

    travel(EIGHT_DAYS_MS);
    expect((await c.get(`/v1/host/openwop-app/assets/${encodeURIComponent(token)}`)).status).toBe(200);
  });

  it('subject erasure (DSAR + the admin cascade) reclaims avatar AND portfolio bytes — the /team-visible URL dies', async () => {
    const c = await signedIn();
    const avatarToken = await upload(c);
    const portfolioToken = await upload(c);
    expect((await c.put('/v1/host/openwop-app/profiles/me/avatar', { token: avatarToken })).status).toBe(200);
    expect((await c.post('/v1/host/openwop-app/profiles/me/portfolio', { token: portfolioToken })).status).toBe(201);
    const me = await c.get('/v1/host/openwop-app/profiles/me');
    expect(me.status).toBe(200);

    const { deleteSubjectProfile } = await import('../src/features/profiles/profilesService.js');
    expect(await deleteSubjectProfile(me.body.tenantId as string, me.body.userId as string)).toBe(true);

    travel(EIGHT_DAYS_MS);
    // The same token-URLs the /team directory rendered — dead after the window.
    expect((await c.get(`/v1/host/openwop-app/assets/${encodeURIComponent(avatarToken)}`)).status).toBe(404);
    expect((await c.get(`/v1/host/openwop-app/assets/${encodeURIComponent(portfolioToken)}`)).status).toBe(404);
  });
});

describe('F2 — a refused write never strands durable bytes', () => {
  it('the full-portfolio 409 leaves the candidate token on the scratch lane', async () => {
    const c = await signedIn();
    for (let i = 0; i < 24; i += 1) {
      const t = await upload(c);
      const add = await c.post('/v1/host/openwop-app/profiles/me/portfolio', { token: t });
      expect(add.status, JSON.stringify(add.body)).toBe(201);
    }
    const over = await upload(c);
    const refused = await c.post('/v1/host/openwop-app/profiles/me/portfolio', { token: over });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);

    // The refused token must NOT have been promoted (F2: the capacity check
    // fires before any promotion) — its expiry stays inside the scratch window…
    const { resolveMediaAsset } = await import('../src/host/inMemorySurfaces.js');
    const entry = await resolveMediaAsset(over);
    expect(entry).not.toBeNull();
    expect(entry!.expiresAtMs - Date.now()).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 60_000);

    // …so the bytes die on their own instead of being stranded for a century.
    travel(EIGHT_DAYS_MS);
    expect((await c.get(`/v1/host/openwop-app/assets/${encodeURIComponent(over)}`)).status).toBe(404);
  });
});

describe('F4 — migration 18 backfills pre-fix rows', () => {
  it('promotes a legacy scratch avatar, clears a dead portfolio ref, and is idempotent', async () => {
    const { hostExtStorage } = await import('../src/host/hostExtPersistence.js');
    const { storeMediaAsset, resolveMediaAsset } = await import('../src/host/inMemorySurfaces.js');
    const { backfillProfileMediaDurability, getProfile } = await import('../src/features/profiles/profilesService.js');

    const tenantId = `org:mig18-${Date.now()}-${n++}`;
    const userId = `user:mig18-${n}`;
    const scratch = await storeMediaAsset(tenantId, { contentBase64: PNG_1x1, contentType: 'image/png', ttlSeconds: 7 * 24 * 60 * 60 });
    const deadToken = `tok-dead-${Date.now()}`; // never stored — the asset is "already gone"
    const ts = new Date().toISOString();
    // A pre-fix row, written raw (the service would promote on write today).
    await hostExtStorage().kvSet(`hostext:profiles:profile:${userId}`, JSON.stringify({
      userId, tenantId, avatarAssetToken: scratch.token, portfolioAssetTokens: [deadToken],
      skills: [], equipment: [], interests: [], workflows: [], pinnedAgentIds: [], pinnedChatAgentIds: [],
      createdAt: ts, updatedAt: ts,
    }));

    await backfillProfileMediaDurability();
    const after = await getProfile(tenantId, userId);
    expect(after?.avatarAssetToken).toBe(scratch.token); // live ref kept…
    const entry = await resolveMediaAsset(scratch.token);
    expect(entry!.expiresAtMs - Date.now()).toBeGreaterThan(365 * 24 * 60 * 60 * 1000); // …and now durable
    expect(after?.portfolioAssetTokens).toEqual([]); // the dead ref is cleared

    await backfillProfileMediaDurability(); // idempotent — a re-run changes nothing
    expect(await getProfile(tenantId, userId)).toEqual(after);
  });
});

describe('PROF-1 — the ADR 0579 orphan sweep honors profile references', () => {
  it('spares a profile-referenced durable token, reclaims a true orphan (both polarities)', async () => {
    const { storeMediaAsset, resolveMediaAsset } = await import('../src/host/inMemorySurfaces.js');
    const { getOrCreateProfile, setAvatarToken } = await import('../src/features/profiles/profilesService.js');
    const { sweepOrphanedMediaBytes } = await import('../src/features/media/erasure.js');

    const tenantId = `org:sweep-${Date.now()}-${n++}`;
    const userId = `user:sweep-${n}`;
    const durableTtl = 100 * 365 * 24 * 60 * 60;
    const referenced = await storeMediaAsset(tenantId, { contentBase64: PNG_1x1, contentType: 'image/png', ttlSeconds: durableTtl });
    const orphan = await storeMediaAsset(tenantId, { contentBase64: PNG_1x1, contentType: 'image/png', ttlSeconds: durableTtl });
    await getOrCreateProfile(tenantId, userId);
    await setAvatarToken(tenantId, userId, referenced.token);

    const prevGrace = process.env.OPENWOP_MEDIA_ORPHAN_GRACE_MS;
    process.env.OPENWOP_MEDIA_ORPHAN_GRACE_MS = '0';
    try {
      const removed = await sweepOrphanedMediaBytes(tenantId);
      expect(removed).toBe(1); // exactly the orphan — never the profile's bytes
      expect(await resolveMediaAsset(orphan.token)).toBeNull();
      expect(await resolveMediaAsset(referenced.token)).not.toBeNull();
    } finally {
      if (prevGrace === undefined) delete process.env.OPENWOP_MEDIA_ORPHAN_GRACE_MS; else process.env.OPENWOP_MEDIA_ORPHAN_GRACE_MS = prevGrace;
    }
  });

  it('fails CLOSED when a byte-ref provider throws — nothing is deleted on partial knowledge', async () => {
    // Registered LAST in this file on purpose: the provider registry is
    // module-global for this worker, so every later sweep in the file would
    // abort too.
    const { storeMediaAsset, resolveMediaAsset } = await import('../src/host/inMemorySurfaces.js');
    const { registerExternalByteRefProvider } = await import('../src/features/media/mediaStorage.js');
    const { sweepOrphanedMediaBytes } = await import('../src/features/media/erasure.js');

    const tenantId = `org:sweepfail-${Date.now()}-${n++}`;
    const orphan = await storeMediaAsset(tenantId, { contentBase64: PNG_1x1, contentType: 'image/png', ttlSeconds: 100 * 365 * 24 * 60 * 60 });
    registerExternalByteRefProvider(async () => { throw new Error('enumeration unavailable'); });

    const prevGrace = process.env.OPENWOP_MEDIA_ORPHAN_GRACE_MS;
    process.env.OPENWOP_MEDIA_ORPHAN_GRACE_MS = '0';
    try {
      const removed = await sweepOrphanedMediaBytes(tenantId);
      expect(removed).toBe(0);
      expect(await resolveMediaAsset(orphan.token)).not.toBeNull(); // still there — sweep aborted
    } finally {
      if (prevGrace === undefined) delete process.env.OPENWOP_MEDIA_ORPHAN_GRACE_MS; else process.env.OPENWOP_MEDIA_ORPHAN_GRACE_MS = prevGrace;
    }
  });
});
