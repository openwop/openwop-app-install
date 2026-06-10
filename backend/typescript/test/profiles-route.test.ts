/**
 * User profiles (ADR 0005, Phase 1) — ROUTE-level harness. Boots the real app
 * and drives the self-service profile surface over HTTP: toggle gating, lazy
 * materialization, self-edit + completeness, the team-visible by-id read, the
 * tenant directory, and the cross-tenant IDOR guard.
 *
 * Note on tenancy: password signup lands each user in its OWN anon-derived
 * tenant, so two clients here are naturally cross-tenant — which is exactly what
 * lets us assert the IDOR guard. The directory is tenant-scoped (it shows the
 * whole team under a shared-tenant SSO/SCIM deployment; in the password demo
 * that's just the caller).
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const PORT = 18661;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(PORT, res);
  });
  // `users` must be on (signup); `profiles` we toggle within the tests.
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
  put: (p: string, b?: unknown) => Promise<Res>;
  del: (p: string) => Promise<Res>;
  /** Snapshot the current session cookie (to revive this identity in a fresh client). */
  snapshot: () => string;
}
function client(initialCookie = ''): Client {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookies = typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
    for (const sc of setCookies as string[]) {
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
    snapshot: () => cookie,
  };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: ReturnType<typeof client>): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/sample/users/auth/signup', { email: uniqEmail('p'), password: 'password123' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const enableProfiles = async (status: 'on' | 'off'): Promise<void> => {
  const def = getToggleDefault('profiles');
  if (def) await saveConfig({ ...def, status }, 'test');
};

/** Two users in the SAME tenant: the second signup, made on the first user's
 *  now-bound session, inherits its tenant. Each user's session cookie is
 *  snapshotted into its own client so they can act independently. */
async function sameTenantPair(): Promise<{ alice: Client; aliceId: string; bob: Client; bobId: string }> {
  const seed = client();
  const a = await signup(seed);
  const aliceCookie = seed.snapshot();
  const b = await signup(seed); // inherits alice's bound tenant
  const bobCookie = seed.snapshot();
  return { alice: client(aliceCookie), aliceId: a.userId, bob: client(bobCookie), bobId: b.userId };
}

describe('profiles Phase 1 — toggle gating', () => {
  it('404s when the profiles toggle is off', async () => {
    await enableProfiles('off');
    const c = client();
    await signup(c);
    const r = await c.get('/v1/host/sample/profiles/me');
    expect(r.status).toBe(404);
  });
});

describe('profiles Phase 1 — self-service CRUD', () => {
  it('GET /me lazily creates an empty profile (completeness 0)', async () => {
    await enableProfiles('on');
    const c = client();
    const me = await signup(c);
    const r = await c.get('/v1/host/sample/profiles/me');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.userId).toBe(me.userId);
    expect(r.body.completeness).toBe(0);
    expect(r.body.skills).toEqual([]);
    expect(r.body.equipment).toEqual([]);
    expect(r.body.portfolioAssetTokens).toEqual([]);
  });

  it('PATCH /me edits fields, raises completeness, and persists', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const patch = await c.patch('/v1/host/sample/profiles/me', {
      jobTitle: 'Staff Engineer',
      department: 'Platform',
      bio: 'I build reference hosts.',
      equipment: ['laptop', 'keyboard'],
      interests: ['protocols', 'distributed systems'],
      availability: { timezone: 'America/New_York', hoursPerWeek: 40, status: 'available' },
    });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.jobTitle).toBe('Staff Engineer');
    // 10 (job) + 10 (dept) + 15 (bio) + 5 (equip) + 10 (interests) + 10 (avail) = 60
    expect(patch.body.completeness).toBe(60);
    // Persisted: a fresh read reflects it.
    const after = await c.get('/v1/host/sample/profiles/me');
    expect(after.body.department).toBe('Platform');
    expect(after.body.availability.status).toBe('available');
  });

  it('PATCH /me with null clears a field (completeness drops)', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    await c.patch('/v1/host/sample/profiles/me', { bio: 'temporary' });
    const before = await c.get('/v1/host/sample/profiles/me');
    expect(before.body.bio).toBe('temporary');
    expect(before.body.completeness).toBe(15);
    const cleared = await c.patch('/v1/host/sample/profiles/me', { bio: null });
    expect(cleared.body.bio).toBeUndefined();
    expect(cleared.body.completeness).toBe(0);
  });

  it('rejects an invalid availability.status (400)', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const r = await c.patch('/v1/host/sample/profiles/me', { availability: { status: 'vacationing' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
  });

  it('secret-shaped tokens in free text are scrubbed', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const r = await c.patch('/v1/host/sample/profiles/me', { bio: 'my key is sk-abcdefghijklmnop please ignore' });
    expect(r.body.bio).toContain('[REDACTED:secret-shaped]');
    expect(r.body.bio).not.toContain('sk-abcdefghijklmnop');
  });
});

describe('profiles Phase 1 — directory + team-read + IDOR', () => {
  it('directory lists the caller; by-id read is team-visible; cross-tenant is 404', async () => {
    await enableProfiles('on');
    const alice = client();
    const a = await signup(alice);
    await alice.get('/v1/host/sample/profiles/me'); // materialize

    // Directory (tenant-scoped) contains alice's own profile.
    const dir = await alice.get('/v1/host/sample/profiles');
    expect(dir.status).toBe(200);
    expect(dir.body.profiles.some((p: { userId: string }) => p.userId === a.userId)).toBe(true);

    // By-id read of self (the team-visible path).
    const self = await alice.get(`/v1/host/sample/profiles/${encodeURIComponent(a.userId)}`);
    expect(self.status).toBe(200);
    expect(self.body.userId).toBe(a.userId);

    // A second user in a DIFFERENT (anon-derived) tenant.
    const bob = client();
    const b = await signup(bob);
    await bob.get('/v1/host/sample/profiles/me');

    // Cross-tenant IDOR guard: alice cannot read bob's profile by id (404, no leak).
    const foreign = await alice.get(`/v1/host/sample/profiles/${encodeURIComponent(b.userId)}`);
    expect(foreign.status).toBe(404);
    // And alice's directory does not contain bob.
    const dir2 = await alice.get('/v1/host/sample/profiles');
    expect(dir2.body.profiles.some((p: { userId: string }) => p.userId === b.userId)).toBe(false);
  });

  it('anonymous (not signed in) is refused', async () => {
    await enableProfiles('on');
    const anon = client(); // no signup → anonymous session
    const r = await anon.get('/v1/host/sample/profiles/me');
    expect(r.status).toBe(401);
  });
});

// A 1×1 transparent PNG.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
async function upload(c: ReturnType<typeof client>, contentType: string, contentBase64: string): Promise<string> {
  const r = await c.post('/v1/host/sample/media/upload', { contentBase64, contentType, name: 'a' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.token;
}

describe('profiles Phase 2 — avatar + portfolio (media-asset refs)', () => {
  it('sets + clears an avatar from a tenant-scoped image token', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const token = await upload(c, 'image/png', PNG_1x1);

    const resp = await c.put('/v1/host/sample/profiles/me/avatar', { token });
    expect(resp.status, JSON.stringify(resp.body)).toBe(200);
    expect(resp.body.avatarAssetToken).toBe(token);
    expect(resp.body.completeness).toBe(15);

    const del = await c.del('/v1/host/sample/profiles/me/avatar');
    expect(del.status).toBe(200);
    expect(del.body.avatarAssetToken).toBeUndefined();
    expect(del.body.completeness).toBe(0);
  });

  it('rejects a foreign-tenant token (404) and a non-image token (400)', async () => {
    await enableProfiles('on');
    const alice = client();
    await signup(alice);
    const bob = client();
    await signup(bob);

    // Bob's token cannot be used by Alice (different tenant) → 404.
    const bobToken = await upload(bob, 'image/png', PNG_1x1);
    const foreign = await alice.put('/v1/host/sample/profiles/me/avatar', { token: bobToken });
    expect(foreign.status).toBe(404);

    // A non-image asset in Alice's own tenant → 400.
    const textToken = await upload(alice, 'text/plain', Buffer.from('hello').toString('base64'));
    const notImage = await alice.put('/v1/host/sample/profiles/me/avatar', { token: textToken });
    expect(notImage.status).toBe(400);
  });

  it('adds/removes portfolio assets (idempotent add, 404 on missing remove)', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const token = await upload(c, 'image/png', PNG_1x1);

    const add = await c.post('/v1/host/sample/profiles/me/portfolio', { token });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.portfolioAssetTokens).toContain(token);
    expect(add.body.completeness).toBe(10);

    // Idempotent re-add (still one entry).
    const again = await c.post('/v1/host/sample/profiles/me/portfolio', { token });
    expect(again.body.portfolioAssetTokens.filter((t: string) => t === token)).toHaveLength(1);

    const del = await c.del(`/v1/host/sample/profiles/me/portfolio/${encodeURIComponent(token)}`);
    expect(del.status).toBe(200);
    expect(del.body.portfolioAssetTokens).not.toContain(token);

    const delMissing = await c.del(`/v1/host/sample/profiles/me/portfolio/${encodeURIComponent(token)}`);
    expect(delMissing.status).toBe(404);
  });
});

describe('profiles Phase 3 — skills + endorsements', () => {
  it('replaces own skills; a peer endorses (idempotent, preserved across edits); self/cross-tenant fail closed', async () => {
    await enableProfiles('on');
    const { alice, aliceId, bob, bobId } = await sameTenantPair();
    const aliceSkill = (body: any, name: string): any => body.skills.find((s: { name: string }) => s.name === name);

    // Alice declares skills.
    const sk = await alice.put('/v1/host/sample/profiles/me/skills', {
      skills: [{ name: 'TypeScript', proficiency: 5 }, { name: 'Rust', proficiency: 3 }],
    });
    expect(sk.status, JSON.stringify(sk.body)).toBe(200);
    expect(sk.body.skills).toHaveLength(2);
    expect(sk.body.completeness).toBe(15); // skills present

    // Bob endorses Alice's TypeScript.
    const end = await bob.post(`/v1/host/sample/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    expect(aliceSkill(end.body, 'TypeScript').endorsements).toContain(bobId);

    // Idempotent re-endorse (still one).
    const again = await bob.post(`/v1/host/sample/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(aliceSkill(again.body, 'TypeScript').endorsements.filter((e: string) => e === bobId)).toHaveLength(1);

    // Editing the skill list PRESERVES endorsements on a surviving skill and drops a removed one.
    const edited = await alice.put('/v1/host/sample/profiles/me/skills', {
      skills: [{ name: 'TypeScript', proficiency: 4 }, { name: 'Go', proficiency: 2 }],
    });
    expect(aliceSkill(edited.body, 'TypeScript').endorsements).toContain(bobId); // preserved
    expect(aliceSkill(edited.body, 'TypeScript').proficiency).toBe(4); // updated
    expect(aliceSkill(edited.body, 'Rust')).toBeUndefined(); // removed

    // Un-endorse.
    const un = await bob.del(`/v1/host/sample/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(aliceSkill(un.body, 'TypeScript').endorsements).not.toContain(bobId);

    // Self-endorsement is forbidden.
    const selfEnd = await alice.post(`/v1/host/sample/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(selfEnd.status).toBe(403);

    // A non-existent skill → 404.
    const noSkill = await bob.post(`/v1/host/sample/profiles/${encodeURIComponent(aliceId)}/skills/COBOL/endorse`);
    expect(noSkill.status).toBe(404);

    // A cross-tenant endorser can't even see Alice → 404 (IDOR guard).
    const stranger = client();
    await signup(stranger);
    const xt = await stranger.post(`/v1/host/sample/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(xt.status).toBe(404);

    // Malformed skills payload → 400.
    const bad = await alice.put('/v1/host/sample/profiles/me/skills', { skills: [{ name: 'X' }] });
    expect(bad.status).toBe(400);
  });
});

describe('profiles Phase 4 — email-verification surfacing', () => {
  it('GET /me reflects emailVerified, flipping false → true after the user verifies', async () => {
    await enableProfiles('on');
    const c = client();
    const email = uniqEmail('verify');
    const su = await c.post('/v1/host/sample/users/auth/signup', { email, password: 'password123' });
    expect(su.status, JSON.stringify(su.body)).toBe(201);
    const token = su.body.verifyToken;
    expect(token, 'verifyToken should be exposed in test env').toBeTruthy();

    const before = await c.get('/v1/host/sample/profiles/me');
    expect(before.body.emailVerified).toBe(false);

    const v = await c.post('/v1/host/sample/users/auth/email/verify', { email, token });
    expect(v.status).toBe(204);

    const after = await c.get('/v1/host/sample/profiles/me');
    expect(after.body.emailVerified).toBe(true);
  });
});

describe('profiles followup — review hardening', () => {
  it('sanitizes contact link URLs: drops javascript:/data:, keeps https/mailto', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const r = await c.patch('/v1/host/sample/profiles/me', {
      contact: {
        location: 'NYC',
        links: [
          { label: 'site', url: 'https://example.com' },
          { label: 'mail', url: 'mailto:a@b.com' },
          { label: 'evil', url: 'javascript:alert(1)' },
          { label: 'evil2', url: 'data:text/html,<script>alert(1)</script>' },
        ],
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const urls = r.body.contact.links.map((l: { url: string }) => l.url);
    expect(urls).toContain('https://example.com');
    expect(urls).toContain('mailto:a@b.com');
    expect(urls).not.toContain('javascript:alert(1)');
    expect(urls.some((u: string) => u.startsWith('data:'))).toBe(false);
    expect(r.body.contact.links).toHaveLength(2); // the two dangerous links were dropped
  });

  it('returns 409 (not 500) when the portfolio is full (max 24)', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    for (let i = 0; i < 24; i++) {
      const t = await upload(c, 'image/png', PNG_1x1);
      const add = await c.post('/v1/host/sample/profiles/me/portfolio', { token: t });
      expect(add.status, JSON.stringify(add.body)).toBe(201);
    }
    const t25 = await upload(c, 'image/png', PNG_1x1);
    const over = await c.post('/v1/host/sample/profiles/me/portfolio', { token: t25 });
    expect(over.status).toBe(409);
    expect(over.body.error).toBe('validation_error');
  });

  it('rejects a non-numeric skill proficiency (400, not a NaN write)', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const r = await c.put('/v1/host/sample/profiles/me/skills', { skills: [{ name: 'X', proficiency: 'high' }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
  });

  it('GET /:userId surfaces emailVerified for a peer (same tenant)', async () => {
    await enableProfiles('on');
    const { alice, aliceId, bob } = await sameTenantPair();
    await alice.get('/v1/host/sample/profiles/me'); // materialize
    const read = await bob.get(`/v1/host/sample/profiles/${encodeURIComponent(aliceId)}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.userId).toBe(aliceId);
    expect(read.body.emailVerified).toBe(false); // alice signed up but never verified
  });

  it('directory omits orphan profiles whose owning user was deleted', async () => {
    await enableProfiles('on');
    const { alice, aliceId, bob } = await sameTenantPair();
    await alice.get('/v1/host/sample/profiles/me'); // materialize alice's profile
    const del = await bob.del(`/v1/host/sample/users/users/${encodeURIComponent(aliceId)}`);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    const dir = await bob.get('/v1/host/sample/profiles');
    expect(dir.status).toBe(200);
    expect(dir.body.profiles.some((p: { userId: string }) => p.userId === aliceId)).toBe(false);
  });
});
