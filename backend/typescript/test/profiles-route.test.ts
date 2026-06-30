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
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  // `users` must be on (signup). `profiles` graduated to always-on (no toggle).
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
    const setCookies = getSetCookies(res.headers);
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
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam. Pass a shared `tenantId` to make co-tenant users.
async function signup(c: ReturnType<typeof client>, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('p'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
// No-op since profiles graduated to always-on (the toggle is gone, so
// getToggleDefault('profiles') is undefined). Retained so the existing call
// sites compile; the surface now serves unconditionally.
const enableProfiles = async (status: 'on' | 'off'): Promise<void> => {
  const def = getToggleDefault('profiles');
  if (def) await saveConfig({ ...def, status }, 'test');
};

/** Two users in the SAME tenant (the SSO/SCIM shared-tenant shape the profiles
 *  directory + org-RBAC target): mint each into one explicit `tenantId`, each in
 *  its own client so they act independently.
 *
 *  The shared tenant is `org:`-prefixed, NOT `user:` — a `user:<hash>` tenant is
 *  the single-human PERSONAL-tenant derivation (one OIDC subject → one human),
 *  which resolveCallerUser canonicalizes onto ONE durable user; a shared SSO/SCIM
 *  tenant has many humans and stays principal-keyed. (Co-tenant peers under a
 *  `user:` tenant was a fixture inaccuracy that the canonicalization collapsed.) */
async function sameTenantPair(): Promise<{ alice: Client; aliceId: string; bob: Client; bobId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const alice = client();
  const a = await signup(alice, { tenantId });
  const bob = client();
  const b = await signup(bob, { tenantId });
  return { alice, aliceId: a.userId, bob, bobId: b.userId };
}

describe('profiles Phase 1 — always-on (graduated off its toggle)', () => {
  it('serves /me unconditionally — no 404-while-off (§ Correction 2026-06-12)', async () => {
    // Profiles graduated to always-on: agent pinning + per-user surfaces ride on
    // it, so it is foundational substrate, not an A/B feature. `enableProfiles`
    // is now a no-op (the toggle is gone); the surface serves to any signed-in
    // caller and lazily materializes the profile.
    await enableProfiles('off');
    const c = client();
    await signup(c);
    const r = await c.get('/v1/host/openwop-app/profiles/me');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('self-serve display name: PATCH /users/me sets it; the profile surfaces it', async () => {
    const c = client();
    await signup(c);
    const set = await c.patch('/v1/host/openwop-app/users/me', { displayName: 'Jordan Rivera' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.displayName).toBe('Jordan Rivera');
    // The profile view surfaces the user's display name (read from identity).
    const prof = await c.get('/v1/host/openwop-app/profiles/me');
    expect(prof.body.displayName).toBe('Jordan Rivera');
  });
});

describe('profiles — agent pinning (ADR 0023)', () => {
  it('pins/unpins a tenant agent; 404s a foreign/unknown agent; idempotent', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    // Seed the tenant's roster so there's a real agent to pin.
    const seeded = await c.post('/v1/host/openwop-app/example-data/seed', {});
    expect(seeded.status).toBe(200);
    const roster = await c.get('/v1/host/openwop-app/roster');
    const agent = (roster.body.roster as Array<{ rosterId: string }>)[0]!;
    expect(agent?.rosterId).toBeTruthy();

    // Pin → appears in pinnedAgentIds; idempotent.
    const p1 = await c.put(`/v1/host/openwop-app/profiles/me/pinned-agents/${encodeURIComponent(agent.rosterId)}`);
    expect(p1.status, JSON.stringify(p1.body)).toBe(200);
    expect(p1.body.pinnedAgentIds).toContain(agent.rosterId);
    const p2 = await c.put(`/v1/host/openwop-app/profiles/me/pinned-agents/${encodeURIComponent(agent.rosterId)}`);
    expect(p2.body.pinnedAgentIds.filter((id: string) => id === agent.rosterId)).toHaveLength(1);

    // Unknown agent → 404 (fail-closed, no phantom pins).
    const bad = await c.put('/v1/host/openwop-app/profiles/me/pinned-agents/host:does-not-exist');
    expect(bad.status).toBe(404);

    // Unpin → removed.
    const u = await c.del(`/v1/host/openwop-app/profiles/me/pinned-agents/${encodeURIComponent(agent.rosterId)}`);
    expect(u.status).toBe(200);
    expect(u.body.pinnedAgentIds).not.toContain(agent.rosterId);
  });

  it('chat-pin is an INDEPENDENT target from the sidebar pin (ADR 0040 welcome row)', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const seeded = await c.post('/v1/host/openwop-app/example-data/seed', {});
    expect(seeded.status).toBe(200);
    const roster = await c.get('/v1/host/openwop-app/roster');
    const agent = (roster.body.roster as Array<{ rosterId: string }>)[0]!;

    // Pin to AI chat → lands in pinnedChatAgentIds, NOT pinnedAgentIds (the two
    // targets are independent).
    const p = await c.put(`/v1/host/openwop-app/profiles/me/pinned-chat-agents/${encodeURIComponent(agent.rosterId)}`);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.pinnedChatAgentIds).toContain(agent.rosterId);
    expect(p.body.pinnedAgentIds ?? []).not.toContain(agent.rosterId);

    // Unknown agent → 404 (fail-closed).
    const bad = await c.put('/v1/host/openwop-app/profiles/me/pinned-chat-agents/host:nope');
    expect(bad.status).toBe(404);

    // Unpin from chat → removed; sidebar list untouched throughout.
    const u = await c.del(`/v1/host/openwop-app/profiles/me/pinned-chat-agents/${encodeURIComponent(agent.rosterId)}`);
    expect(u.status).toBe(200);
    expect(u.body.pinnedChatAgentIds).not.toContain(agent.rosterId);
  });

  it('UN-pinning a deleted/unknown agent succeeds (self-heal — DELETE never 404s)', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    // Pinning an unknown agent 404s; UN-pinning one is always safe (you're
    // removing an id from your OWN list) — this is how the sidebar self-heals.
    const unpin = await c.del('/v1/host/openwop-app/profiles/me/pinned-agents/host:never-existed');
    expect(unpin.status, JSON.stringify(unpin.body)).toBe(200);
  });

  it('clearing demo data unpins the deleted agents (cascade)', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    await c.post('/v1/host/openwop-app/example-data/seed', {});
    const roster = await c.get('/v1/host/openwop-app/roster');
    const agent = (roster.body.roster as Array<{ rosterId: string }>)[0]!;
    await c.put(`/v1/host/openwop-app/profiles/me/pinned-agents/${encodeURIComponent(agent.rosterId)}`);
    expect((await c.get('/v1/host/openwop-app/profiles/me')).body.pinnedAgentIds).toContain(agent.rosterId);

    // Clearing the agents step deletes the roster members AND cascades the unpin.
    const cleared = await c.post('/v1/host/openwop-app/example-data/clear', { steps: ['agents'] });
    expect(cleared.status).toBe(200);
    const me = await c.get('/v1/host/openwop-app/profiles/me');
    expect(me.body.pinnedAgentIds).not.toContain(agent.rosterId);
  });

  it("a foreign-tenant agent cannot be pinned (IDOR guard)", async () => {
    await enableProfiles('on');
    const { alice, bob } = await sameTenantPair();
    // Give bob's DIFFERENT tenant an agent; alice must not be able to pin it.
    const other = client();
    await signup(other, { tenantId: `user:other-${Date.now()}` });
    await other.post('/v1/host/openwop-app/example-data/seed', {});
    const otherRoster = await other.get('/v1/host/openwop-app/roster');
    const foreign = (otherRoster.body.roster as Array<{ rosterId: string }>)[0]!;
    void bob;
    const r = await alice.put(`/v1/host/openwop-app/profiles/me/pinned-agents/${encodeURIComponent(foreign.rosterId)}`);
    expect(r.status).toBe(404);
  });
});

describe('profiles Phase 1 — self-service CRUD', () => {
  it('GET /me lazily creates an empty profile (completeness 0)', async () => {
    await enableProfiles('on');
    const c = client();
    const me = await signup(c);
    const r = await c.get('/v1/host/openwop-app/profiles/me');
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
    const patch = await c.patch('/v1/host/openwop-app/profiles/me', {
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
    const after = await c.get('/v1/host/openwop-app/profiles/me');
    expect(after.body.department).toBe('Platform');
    expect(after.body.availability.status).toBe('available');
  });

  it('PATCH /me with null clears a field (completeness drops)', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    await c.patch('/v1/host/openwop-app/profiles/me', { bio: 'temporary' });
    const before = await c.get('/v1/host/openwop-app/profiles/me');
    expect(before.body.bio).toBe('temporary');
    expect(before.body.completeness).toBe(15);
    const cleared = await c.patch('/v1/host/openwop-app/profiles/me', { bio: null });
    expect(cleared.body.bio).toBeUndefined();
    expect(cleared.body.completeness).toBe(0);
  });

  it('rejects an invalid availability.status (400)', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const r = await c.patch('/v1/host/openwop-app/profiles/me', { availability: { status: 'vacationing' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
  });

  it('secret-shaped tokens in free text are scrubbed', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const r = await c.patch('/v1/host/openwop-app/profiles/me', { bio: 'my key is sk-abcdefghijklmnop please ignore' });
    expect(r.body.bio).toContain('[REDACTED:secret-shaped]');
    expect(r.body.bio).not.toContain('sk-abcdefghijklmnop');
  });
});

describe('profiles Phase 1 — directory + team-read + IDOR', () => {
  it('directory lists the caller; by-id read is team-visible; cross-tenant is 404', async () => {
    await enableProfiles('on');
    const alice = client();
    const a = await signup(alice);
    await alice.get('/v1/host/openwop-app/profiles/me'); // materialize

    // Directory (tenant-scoped) contains alice's own profile.
    const dir = await alice.get('/v1/host/openwop-app/profiles');
    expect(dir.status).toBe(200);
    expect(dir.body.profiles.some((p: { userId: string }) => p.userId === a.userId)).toBe(true);

    // By-id read of self (the team-visible path).
    const self = await alice.get(`/v1/host/openwop-app/profiles/${encodeURIComponent(a.userId)}`);
    expect(self.status).toBe(200);
    expect(self.body.userId).toBe(a.userId);

    // A second user in a DIFFERENT (anon-derived) tenant.
    const bob = client();
    const b = await signup(bob);
    await bob.get('/v1/host/openwop-app/profiles/me');

    // Cross-tenant IDOR guard: alice cannot read bob's profile by id (404, no leak).
    const foreign = await alice.get(`/v1/host/openwop-app/profiles/${encodeURIComponent(b.userId)}`);
    expect(foreign.status).toBe(404);
    // And alice's directory does not contain bob.
    const dir2 = await alice.get('/v1/host/openwop-app/profiles');
    expect(dir2.body.profiles.some((p: { userId: string }) => p.userId === b.userId)).toBe(false);
  });

  it('anonymous (not signed in) is refused', async () => {
    await enableProfiles('on');
    const anon = client(); // no signup → anonymous session
    const r = await anon.get('/v1/host/openwop-app/profiles/me');
    expect(r.status).toBe(401);
  });
});

// A 1×1 transparent PNG.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
async function upload(c: ReturnType<typeof client>, contentType: string, contentBase64: string): Promise<string> {
  const r = await c.post('/v1/host/openwop-app/media/upload', { contentBase64, contentType, name: 'a' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.token;
}

describe('profiles Phase 2 — avatar + portfolio (media-asset refs)', () => {
  it('sets + clears an avatar from a tenant-scoped image token', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const token = await upload(c, 'image/png', PNG_1x1);

    const resp = await c.put('/v1/host/openwop-app/profiles/me/avatar', { token });
    expect(resp.status, JSON.stringify(resp.body)).toBe(200);
    expect(resp.body.avatarAssetToken).toBe(token);
    expect(resp.body.completeness).toBe(15);

    const del = await c.del('/v1/host/openwop-app/profiles/me/avatar');
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
    const foreign = await alice.put('/v1/host/openwop-app/profiles/me/avatar', { token: bobToken });
    expect(foreign.status).toBe(404);

    // A non-image asset in Alice's own tenant → 400.
    const textToken = await upload(alice, 'text/plain', Buffer.from('hello').toString('base64'));
    const notImage = await alice.put('/v1/host/openwop-app/profiles/me/avatar', { token: textToken });
    expect(notImage.status).toBe(400);
  });

  it('adds/removes portfolio assets (idempotent add, 404 on missing remove)', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const token = await upload(c, 'image/png', PNG_1x1);

    const add = await c.post('/v1/host/openwop-app/profiles/me/portfolio', { token });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.portfolioAssetTokens).toContain(token);
    expect(add.body.completeness).toBe(10);

    // Idempotent re-add (still one entry).
    const again = await c.post('/v1/host/openwop-app/profiles/me/portfolio', { token });
    expect(again.body.portfolioAssetTokens.filter((t: string) => t === token)).toHaveLength(1);

    const del = await c.del(`/v1/host/openwop-app/profiles/me/portfolio/${encodeURIComponent(token)}`);
    expect(del.status).toBe(200);
    expect(del.body.portfolioAssetTokens).not.toContain(token);

    const delMissing = await c.del(`/v1/host/openwop-app/profiles/me/portfolio/${encodeURIComponent(token)}`);
    expect(delMissing.status).toBe(404);
  });
});

describe('profiles Phase 3 — skills + endorsements', () => {
  it('replaces own skills; a peer endorses (idempotent, preserved across edits); self/cross-tenant fail closed', async () => {
    await enableProfiles('on');
    const { alice, aliceId, bob, bobId } = await sameTenantPair();
    const aliceSkill = (body: any, name: string): any => body.skills.find((s: { name: string }) => s.name === name);

    // Alice declares skills.
    const sk = await alice.put('/v1/host/openwop-app/profiles/me/skills', {
      skills: [{ name: 'TypeScript', proficiency: 5 }, { name: 'Rust', proficiency: 3 }],
    });
    expect(sk.status, JSON.stringify(sk.body)).toBe(200);
    expect(sk.body.skills).toHaveLength(2);
    expect(sk.body.completeness).toBe(15); // skills present

    // Bob endorses Alice's TypeScript.
    const end = await bob.post(`/v1/host/openwop-app/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    expect(aliceSkill(end.body, 'TypeScript').endorsements).toContain(bobId);

    // Idempotent re-endorse (still one).
    const again = await bob.post(`/v1/host/openwop-app/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(aliceSkill(again.body, 'TypeScript').endorsements.filter((e: string) => e === bobId)).toHaveLength(1);

    // Editing the skill list PRESERVES endorsements on a surviving skill and drops a removed one.
    const edited = await alice.put('/v1/host/openwop-app/profiles/me/skills', {
      skills: [{ name: 'TypeScript', proficiency: 4 }, { name: 'Go', proficiency: 2 }],
    });
    expect(aliceSkill(edited.body, 'TypeScript').endorsements).toContain(bobId); // preserved
    expect(aliceSkill(edited.body, 'TypeScript').proficiency).toBe(4); // updated
    expect(aliceSkill(edited.body, 'Rust')).toBeUndefined(); // removed

    // Un-endorse.
    const un = await bob.del(`/v1/host/openwop-app/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(aliceSkill(un.body, 'TypeScript').endorsements).not.toContain(bobId);

    // Self-endorsement is forbidden.
    const selfEnd = await alice.post(`/v1/host/openwop-app/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(selfEnd.status).toBe(403);

    // A non-existent skill → 404.
    const noSkill = await bob.post(`/v1/host/openwop-app/profiles/${encodeURIComponent(aliceId)}/skills/COBOL/endorse`);
    expect(noSkill.status).toBe(404);

    // A cross-tenant endorser can't even see Alice → 404 (IDOR guard).
    const stranger = client();
    await signup(stranger);
    const xt = await stranger.post(`/v1/host/openwop-app/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(xt.status).toBe(404);

    // Malformed skills payload → 400.
    const bad = await alice.put('/v1/host/openwop-app/profiles/me/skills', { skills: [{ name: 'X' }] });
    expect(bad.status).toBe(400);
  });
});

describe('ADR 0025 — personal activity feed', () => {
  it('GET /me/activity is empty for a fresh user and surfaces a user-attributed run (always-on)', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);

    // Empty for a fresh user (no orchestrated runs yet).
    const empty = await c.get('/v1/host/openwop-app/profiles/me/activity');
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body.items).toEqual([]);
    expect(empty.body.truncated).toBe(false);

    // Register a workflow, schedule it for me, and fire it.
    const wfId = 'wf.activity-e2e';
    const reg = await c.post('/v1/host/openwop-app/workflows', { workflowId: wfId, nodes: [{ nodeId: 'op', typeId: 'test.passthrough', config: {} }], edges: [] });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const job = await c.post('/v1/host/openwop-app/scheduler/jobs', { owner: 'me', cronExpr: '0 9 * * *', workflowId: wfId });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    const trig = await c.post(`/v1/host/openwop-app/scheduler/jobs/${encodeURIComponent(job.body.jobId)}/trigger`, {});
    expect(trig.status, JSON.stringify(trig.body)).toBe(200);
    expect(trig.body.runId).toBeTruthy();

    // The fired run is attributed to the user → appears in /me/activity.
    const act = await c.get('/v1/host/openwop-app/profiles/me/activity');
    expect(act.status).toBe(200);
    const item = act.body.items.find((i: any) => i.runId === trig.body.runId);
    expect(item, JSON.stringify(act.body.items)).toBeTruthy();
    expect(item.source).toBe('schedule');
    expect(item.ownerUserId).toBeTruthy();
    expect(item.workflowId).toBe(wfId);

    // Graduated to always-on — still serves with the toggle "off" (a no-op now).
    await enableProfiles('off');
    const stillServes = await c.get('/v1/host/openwop-app/profiles/me/activity');
    expect(stillServes.status).toBe(200);
  });
});

describe('ADR 0025 — assigned-workflow portfolio', () => {
  it('PUT /me/workflows replaces the portfolio (deduped, bounded); empty by default; bad payload 400', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);

    // Empty by default.
    const fresh = await c.get('/v1/host/openwop-app/profiles/me');
    expect(fresh.body.workflows).toEqual([]);

    // Set a portfolio — duplicates collapse, order preserved.
    const set = await c.put('/v1/host/openwop-app/profiles/me/workflows', { workflows: ['wf.a', 'wf.b', 'wf.a'] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.workflows).toEqual(['wf.a', 'wf.b']);

    // Persists across reads.
    const after = await c.get('/v1/host/openwop-app/profiles/me');
    expect(after.body.workflows).toEqual(['wf.a', 'wf.b']);

    // Replace (not merge).
    const replaced = await c.put('/v1/host/openwop-app/profiles/me/workflows', { workflows: ['wf.c'] });
    expect(replaced.body.workflows).toEqual(['wf.c']);

    // Malformed payload → 400.
    const bad = await c.put('/v1/host/openwop-app/profiles/me/workflows', { workflows: [1, 2] });
    expect(bad.status).toBe(400);
  });
});

describe('profiles Phase 4 — email-verification surfacing', () => {
  it('GET /me surfaces emailVerified=true for a federated (OIDC) identity', async () => {
    // ADR 0026: there is no host password store / verify-token flow anymore — a
    // real account is federated (Firebase OIDC / SAML / SCIM), whose email is
    // verified by the IdP, so the profile surfaces it as verified.
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const me = await c.get('/v1/host/openwop-app/profiles/me');
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.emailVerified).toBe(true);
  });
});

describe('profiles followup — review hardening', () => {
  it('sanitizes contact link URLs: drops javascript:/data:, keeps https/mailto', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const r = await c.patch('/v1/host/openwop-app/profiles/me', {
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
      const add = await c.post('/v1/host/openwop-app/profiles/me/portfolio', { token: t });
      expect(add.status, JSON.stringify(add.body)).toBe(201);
    }
    const t25 = await upload(c, 'image/png', PNG_1x1);
    const over = await c.post('/v1/host/openwop-app/profiles/me/portfolio', { token: t25 });
    expect(over.status).toBe(409);
    expect(over.body.error).toBe('validation_error');
  });

  it('rejects a non-numeric skill proficiency (400, not a NaN write)', async () => {
    await enableProfiles('on');
    const c = client();
    await signup(c);
    const r = await c.put('/v1/host/openwop-app/profiles/me/skills', { skills: [{ name: 'X', proficiency: 'high' }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
  });

  it('GET /:userId surfaces emailVerified for a peer (same tenant)', async () => {
    await enableProfiles('on');
    const { alice, aliceId, bob } = await sameTenantPair();
    await alice.get('/v1/host/openwop-app/profiles/me'); // materialize
    const read = await bob.get(`/v1/host/openwop-app/profiles/${encodeURIComponent(aliceId)}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.userId).toBe(aliceId);
    // A federated (OIDC/SAML/SCIM) identity's email is IdP-verified (ADR 0026 —
    // there is no host password store with an unverified state anymore).
    expect(read.body.emailVerified).toBe(true);
  });

  it('directory omits orphan profiles whose owning user was deleted', async () => {
    await enableProfiles('on');
    const { alice, aliceId, bob } = await sameTenantPair();
    await alice.get('/v1/host/openwop-app/profiles/me'); // materialize alice's profile
    const del = await bob.del(`/v1/host/openwop-app/users/users/${encodeURIComponent(aliceId)}`);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    const dir = await bob.get('/v1/host/openwop-app/profiles');
    expect(dir.status).toBe(200);
    expect(dir.body.profiles.some((p: { userId: string }) => p.userId === aliceId)).toBe(false);
  });
});
