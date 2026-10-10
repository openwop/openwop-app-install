/**
 * User profiles — ROUTE-level harness (ADR 0005 profiles; ADR 0023 agent
 * pinning; ADR 0040 chat-pin; ADR 0025 activity + workflow portfolio; ADR 0624
 * endorsement view; review gaps PROF-2 / F3, PROF-3, PROF-4 / F6). Boots the real
 * app and drives the self-service profile surface over HTTP: lazy
 * materialization, self-edit + completeness, the team-visible by-id read, the
 * tenant directory, the cross-tenant IDOR guards, the PII cascade on user delete,
 * and the CAS discipline of every profile writer.
 *
 * Tenancy: users are minted through the env-gated ADR 0026 test-login seam.
 * Without an explicit `tenantId` each lands in its OWN personal tenant, so two
 * plain clients are naturally cross-tenant (what lets us assert the IDOR guard);
 * `sameTenantPair` seats two humans in one `org:` tenant (the SSO/SCIM shape).
 *
 * Sabotage that turns it red (grade-tests w3 probes, each witnessed):
 *   - pin route resolves a roster id in ANY tenant        → 'a foreign-tenant agent cannot be pinned'
 *   - unpin also requires the agent to exist             → 'UN-pinning a deleted/unknown agent succeeds'
 *   - chat pins land in `pinnedAgentIds`                 → 'chat-pin is an INDEPENDENT target'
 *   - roster delete skips `unpinAgentsForTenant`         → 'clearing demo data unpins'
 *   - `getProfile` drops its tenant check                → 'cross-tenant is 404', endorse IDOR
 *   - PATCH `null` leaves the field                      → 'PATCH /me with null clears a field'
 *   - no availability.status / proficiency validation    → the two 400 cases
 *   - no secret scrub / no link-scheme sanitizing        → the scrub / sanitize cases
 *   - avatar accepts a non-image                         → 'rejects a foreign-tenant token … non-image'
 *   - portfolio re-add not idempotent / cap off by one   → portfolio + 409 cases
 *   - self-endorse allowed / endorsements reset on edit  → Phase 3 case
 *   - activity feed empty / workflows not deduped        → ADR 0025 cases
 *   - emailVerified forced false                         → both emailVerified cases
 *   - directory stops filtering owner-less rows          → 'directory omits orphan profiles'
 *   - erasure keeps the profile row                      → PROF-2 delete case
 *   - user delete swallows the strict KB removal         → PROF-2 F3 case
 *   - `listProfiles` full-scans                          → PROF-3
 *   - the profile CAS becomes a blind put                → all three PROF-4 cases
 * (The foreign-token 404 is guarded twice — the route check AND
 * `promoteToDurable`'s tenant check — so removing either alone stays green.)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import type { DurableCollection as DurableCollectionType } from '../src/host/hostExtPersistence.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember } from '../src/host/accessControlService.js';
import type { AgentActivityItem } from '../src/host/agentActivity.js';
import type { OwnProfileView, ProfileView, ProfileViewSkill } from '../src/features/profiles/profilesService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  // `users` must be on (signup). `profiles` graduated to always-on (no toggle).
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

/** The host error envelope (`errorEnvelope.ts`). */
interface ErrorBody { error: string; message?: string; details?: unknown }
interface DirectoryBody { profiles: ProfileView[] }
interface RosterBody { roster: Array<{ rosterId: string }> }
interface Res<T> { status: number; body: T }
/** Typed per call at the JSON boundary — the one place a wire body becomes a product type. */
type Call = <T = ErrorBody>(p: string, b?: unknown) => Promise<Res<T>>;
interface Client {
  get: Call;
  post: Call;
  patch: Call;
  put: Call;
  del: Call;
}
function client(initialCookie = ''): Client {
  let cookie = initialCookie;
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const sc of getSetCookies(res.headers)) {
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1]!;
    }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
  };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam. Pass a shared `tenantId` to make co-tenant users.
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: uniqEmail('p'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

/** Two users in the SAME tenant (the SSO/SCIM shared-tenant shape the profiles
 *  directory + org-RBAC target): mint each into one explicit `tenantId`, each in
 *  its own client so they act independently.
 *
 *  The shared tenant is `org:`-prefixed, NOT `user:` — a `user:<hash>` tenant is
 *  the single-human PERSONAL-tenant derivation (one OIDC subject → one human),
 *  which resolveCallerUser canonicalizes onto ONE durable user; a shared SSO/SCIM
 *  tenant has many humans and stays principal-keyed. (Co-tenant peers under a
 *  `user:` tenant was a fixture inaccuracy that the canonicalization collapsed.) */
async function sameTenantPair(): Promise<{ tenantId: string; alice: Client; aliceId: string; bob: Client; bobId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const alice = client();
  const a = await signup(alice, { tenantId });
  const bob = client();
  const b = await signup(bob, { tenantId });
  // USERS-19 (ADR 0617 D2): an `org:` tenant is NOT a personal shape, so the
  // second co-tenant no longer inherits implicit OWNER authority from the
  // collapsed seam cookie (that was exactly the SAML-shaped hole). Bob is the
  // admin actor in the PROF-2 / directory tests, so seat him explicitly.
  // ADR 0833 D6 — Alice FOUNDED the tenant (the seam's first login owns it),
  // and only an owner may delete an owner, so Bob is seated as a co-owner.
  await createMember({ tenantId, orgId: tenantId, subject: b.userId, displayName: 'Bob', roles: ['owner'] });
  return { tenantId, alice, aliceId: a.userId, bob, bobId: b.userId };
}

/** Seed the caller's tenant roster and return its first agent. */
async function firstSeededAgent(c: Client): Promise<{ rosterId: string }> {
  const seeded = await c.post<unknown>('/host/openwop-app/example-data/seed', {});
  expect(seeded.status).toBe(200);
  const roster = await c.get<RosterBody>('/host/openwop-app/roster');
  const agent = roster.body.roster[0];
  expect(agent?.rosterId).toBeTruthy();
  return agent!;
}

describe('profiles Phase 1 — self display name', () => {
  it('self-serve display name: PATCH /users/me sets it; the profile surfaces it', async () => {
    const c = client();
    await signup(c);
    const set = await c.patch<{ displayName: string }>('/host/openwop-app/users/me', { displayName: 'Jordan Rivera' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.displayName).toBe('Jordan Rivera');
    // The profile view surfaces the user's display name (read from identity).
    const prof = await c.get<OwnProfileView>('/host/openwop-app/profiles/me');
    expect(prof.body.displayName).toBe('Jordan Rivera');
  });
});

describe('profiles — agent pinning (ADR 0023)', () => {
  it('pins/unpins a tenant agent; 404s a foreign/unknown agent; idempotent', async () => {
    const c = client();
    await signup(c);
    const agent = await firstSeededAgent(c);

    // Pin → appears in pinnedAgentIds; idempotent.
    const p1 = await c.put<OwnProfileView>(`/host/openwop-app/profiles/me/pinned-agents/${encodeURIComponent(agent.rosterId)}`);
    expect(p1.status, JSON.stringify(p1.body)).toBe(200);
    expect(p1.body.pinnedAgentIds).toContain(agent.rosterId);
    const p2 = await c.put<OwnProfileView>(`/host/openwop-app/profiles/me/pinned-agents/${encodeURIComponent(agent.rosterId)}`);
    expect(p2.body.pinnedAgentIds.filter((id) => id === agent.rosterId)).toHaveLength(1);

    // Unknown agent → 404 (fail-closed, no phantom pins).
    const bad = await c.put('/host/openwop-app/profiles/me/pinned-agents/host:does-not-exist');
    expect(bad.status).toBe(404);

    // Unpin → removed.
    const u = await c.del<OwnProfileView>(`/host/openwop-app/profiles/me/pinned-agents/${encodeURIComponent(agent.rosterId)}`);
    expect(u.status).toBe(200);
    expect(u.body.pinnedAgentIds).not.toContain(agent.rosterId);
  });

  it('chat-pin is an INDEPENDENT target from the sidebar pin (ADR 0040 welcome row)', async () => {
    const c = client();
    await signup(c);
    const agent = await firstSeededAgent(c);

    // Pin to AI chat → lands in pinnedChatAgentIds, NOT pinnedAgentIds (the two
    // targets are independent).
    const p = await c.put<OwnProfileView>(`/host/openwop-app/profiles/me/pinned-chat-agents/${encodeURIComponent(agent.rosterId)}`);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.pinnedChatAgentIds).toContain(agent.rosterId);
    expect(p.body.pinnedAgentIds).not.toContain(agent.rosterId);

    // Unknown agent → 404 (fail-closed).
    const bad = await c.put('/host/openwop-app/profiles/me/pinned-chat-agents/host:nope');
    expect(bad.status).toBe(404);

    // Unpin from chat → removed; sidebar list untouched throughout.
    const u = await c.del<OwnProfileView>(`/host/openwop-app/profiles/me/pinned-chat-agents/${encodeURIComponent(agent.rosterId)}`);
    expect(u.status).toBe(200);
    expect(u.body.pinnedChatAgentIds).not.toContain(agent.rosterId);
  });

  it('UN-pinning a deleted/unknown agent succeeds (self-heal — DELETE never 404s)', async () => {
    const c = client();
    await signup(c);
    // Pinning an unknown agent 404s; UN-pinning one is always safe (you're
    // removing an id from your OWN list) — this is how the sidebar self-heals.
    const unpin = await c.del<OwnProfileView>('/host/openwop-app/profiles/me/pinned-agents/host:never-existed');
    expect(unpin.status, JSON.stringify(unpin.body)).toBe(200);
    expect(unpin.body.pinnedAgentIds).toEqual([]);
  });

  it('clearing demo data unpins the deleted agents (cascade)', async () => {
    const c = client();
    await signup(c);
    const agent = await firstSeededAgent(c);
    await c.put(`/host/openwop-app/profiles/me/pinned-agents/${encodeURIComponent(agent.rosterId)}`);
    expect((await c.get<OwnProfileView>('/host/openwop-app/profiles/me')).body.pinnedAgentIds).toContain(agent.rosterId);

    // Clearing the agents step deletes the roster members AND cascades the unpin.
    const cleared = await c.post<unknown>('/host/openwop-app/example-data/clear', { steps: ['agents'] });
    expect(cleared.status).toBe(200);
    const me = await c.get<OwnProfileView>('/host/openwop-app/profiles/me');
    expect(me.body.pinnedAgentIds).not.toContain(agent.rosterId);
  });

  it("a foreign-tenant agent cannot be pinned (IDOR guard)", async () => {
    const alice = client();
    await signup(alice);
    // A DIFFERENT tenant owns the agent; alice must not be able to pin it.
    const other = client();
    await signup(other, { tenantId: `user:other-${Date.now()}-${n++}` });
    const foreign = await firstSeededAgent(other);
    const r = await alice.put(`/host/openwop-app/profiles/me/pinned-agents/${encodeURIComponent(foreign.rosterId)}`);
    expect(r.status).toBe(404);
  });
});

describe('profiles Phase 1 — self-service CRUD', () => {
  it('GET /me lazily creates an empty profile (completeness 0)', async () => {
    const c = client();
    const me = await signup(c);
    const r = await c.get<OwnProfileView>('/host/openwop-app/profiles/me');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.userId).toBe(me.userId);
    expect(r.body.completeness).toBe(0);
    expect(r.body.skills).toEqual([]);
    expect(r.body.equipment).toEqual([]);
    expect(r.body.portfolioAssetTokens).toEqual([]);
  });

  it('PATCH /me edits fields, raises completeness, and persists', async () => {
    const c = client();
    await signup(c);
    const patch = await c.patch<OwnProfileView>('/host/openwop-app/profiles/me', {
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
    const after = await c.get<OwnProfileView>('/host/openwop-app/profiles/me');
    expect(after.body.department).toBe('Platform');
    expect(after.body.availability?.status).toBe('available');
  });

  it('PATCH /me with null clears a field (completeness drops)', async () => {
    const c = client();
    await signup(c);
    await c.patch('/host/openwop-app/profiles/me', { bio: 'temporary' });
    const before = await c.get<OwnProfileView>('/host/openwop-app/profiles/me');
    expect(before.body.bio).toBe('temporary');
    expect(before.body.completeness).toBe(15);
    const cleared = await c.patch<OwnProfileView>('/host/openwop-app/profiles/me', { bio: null });
    expect(cleared.body.bio).toBeUndefined();
    expect(cleared.body.completeness).toBe(0);
  });

  it('rejects an invalid availability.status (400)', async () => {
    const c = client();
    await signup(c);
    const r = await c.patch('/host/openwop-app/profiles/me', { availability: { status: 'vacationing' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
  });

  it('secret-shaped tokens in free text are scrubbed', async () => {
    const c = client();
    await signup(c);
    const r = await c.patch<OwnProfileView>('/host/openwop-app/profiles/me', { bio: 'my key is sk-abcdefghijklmnop please ignore' });
    expect(r.body.bio).toContain('[REDACTED:secret-shaped]');
    expect(r.body.bio).not.toContain('sk-abcdefghijklmnop');
  });
});

describe('profiles Phase 1 — directory + team-read + IDOR', () => {
  it('directory lists the caller; by-id read is team-visible; cross-tenant is 404', async () => {
    const alice = client();
    const a = await signup(alice);
    await alice.get('/host/openwop-app/profiles/me'); // materialize

    // Directory (tenant-scoped) contains alice's own profile.
    const dir = await alice.get<DirectoryBody>('/host/openwop-app/profiles');
    expect(dir.status).toBe(200);
    expect(dir.body.profiles.some((p) => p.userId === a.userId)).toBe(true);

    // By-id read of self (the team-visible path).
    const self = await alice.get<ProfileView>(`/host/openwop-app/profiles/${encodeURIComponent(a.userId)}`);
    expect(self.status).toBe(200);
    expect(self.body.userId).toBe(a.userId);

    // A second user in a DIFFERENT (personal) tenant.
    const bob = client();
    const b = await signup(bob);
    await bob.get('/host/openwop-app/profiles/me');

    // Cross-tenant IDOR guard: alice cannot read bob's profile by id (404, no leak).
    const foreign = await alice.get(`/host/openwop-app/profiles/${encodeURIComponent(b.userId)}`);
    expect(foreign.status).toBe(404);
    // And alice's directory does not contain bob.
    const dir2 = await alice.get<DirectoryBody>('/host/openwop-app/profiles');
    expect(dir2.body.profiles.some((p) => p.userId === b.userId)).toBe(false);
  });

  it('anonymous (not signed in) is refused', async () => {
    const anon = client(); // no signup → anonymous session
    const r = await anon.get('/host/openwop-app/profiles/me');
    expect(r.status).toBe(401);
  });
});

// A 1×1 transparent PNG.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
async function upload(c: Client, contentType: string, contentBase64: string): Promise<string> {
  const r = await c.post<{ token: string }>('/host/openwop-app/media/upload', { contentBase64, contentType, name: 'a' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.token;
}

describe('profiles Phase 2 — avatar + portfolio (media-asset refs)', () => {
  it('sets + clears an avatar from a tenant-scoped image token', async () => {
    const c = client();
    await signup(c);
    const token = await upload(c, 'image/png', PNG_1x1);

    const resp = await c.put<OwnProfileView>('/host/openwop-app/profiles/me/avatar', { token });
    expect(resp.status, JSON.stringify(resp.body)).toBe(200);
    expect(resp.body.avatarAssetToken).toBe(token);
    expect(resp.body.completeness).toBe(15);

    const del = await c.del<OwnProfileView>('/host/openwop-app/profiles/me/avatar');
    expect(del.status).toBe(200);
    expect(del.body.avatarAssetToken).toBeUndefined();
    expect(del.body.completeness).toBe(0);
  });

  it('rejects a foreign-tenant token (404) and a non-image token (400)', async () => {
    const alice = client();
    await signup(alice);
    const bob = client();
    await signup(bob);

    // Bob's token cannot be used by Alice (different tenant) → 404.
    const bobToken = await upload(bob, 'image/png', PNG_1x1);
    const foreign = await alice.put('/host/openwop-app/profiles/me/avatar', { token: bobToken });
    expect(foreign.status).toBe(404);

    // A non-image asset in Alice's own tenant → 400.
    const textToken = await upload(alice, 'text/plain', Buffer.from('hello').toString('base64'));
    const notImage = await alice.put('/host/openwop-app/profiles/me/avatar', { token: textToken });
    expect(notImage.status).toBe(400);
  });

  it('adds/removes portfolio assets (idempotent add, 404 on missing remove)', async () => {
    const c = client();
    await signup(c);
    const token = await upload(c, 'image/png', PNG_1x1);

    const add = await c.post<OwnProfileView>('/host/openwop-app/profiles/me/portfolio', { token });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.portfolioAssetTokens).toContain(token);
    expect(add.body.completeness).toBe(10);

    // Idempotent re-add (still one entry).
    const again = await c.post<OwnProfileView>('/host/openwop-app/profiles/me/portfolio', { token });
    expect(again.body.portfolioAssetTokens.filter((t) => t === token)).toHaveLength(1);

    const del = await c.del<OwnProfileView>(`/host/openwop-app/profiles/me/portfolio/${encodeURIComponent(token)}`);
    expect(del.status).toBe(200);
    expect(del.body.portfolioAssetTokens).not.toContain(token);

    const delMissing = await c.del(`/host/openwop-app/profiles/me/portfolio/${encodeURIComponent(token)}`);
    expect(delMissing.status).toBe(404);
  });
});

describe('profiles Phase 3 — skills + endorsements', () => {
  it('replaces own skills; a peer endorses (idempotent, preserved across edits); self/cross-tenant fail closed', async () => {
    const { alice, aliceId, bob, bobId } = await sameTenantPair();
    const aliceSkill = (body: ProfileView, name: string): ProfileViewSkill | undefined => body.skills.find((s) => s.name === name);

    // Alice declares skills.
    const sk = await alice.put<OwnProfileView>('/host/openwop-app/profiles/me/skills', {
      skills: [{ name: 'TypeScript', proficiency: 5 }, { name: 'Rust', proficiency: 3 }],
    });
    expect(sk.status, JSON.stringify(sk.body)).toBe(200);
    expect(sk.body.skills).toHaveLength(2);
    expect(sk.body.completeness).toBe(15); // skills present

    // Bob endorses Alice's TypeScript.
    const end = await bob.post<ProfileView>(`/host/openwop-app/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    // ADR 0624 D7 — the route view projects endorsements as { count, endorsedByMe, endorserUserIds }.
    expect(aliceSkill(end.body, 'TypeScript')?.endorsements).toEqual({ count: 1, endorsedByMe: true, endorserUserIds: [bobId] });

    // Idempotent re-endorse (still one).
    const again = await bob.post<ProfileView>(`/host/openwop-app/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(aliceSkill(again.body, 'TypeScript')?.endorsements.endorserUserIds.filter((e) => e === bobId)).toHaveLength(1);
    expect(aliceSkill(again.body, 'TypeScript')?.endorsements.count).toBe(1);

    // Editing the skill list PRESERVES endorsements on a surviving skill and drops a removed one.
    const edited = await alice.put<OwnProfileView>('/host/openwop-app/profiles/me/skills', {
      skills: [{ name: 'TypeScript', proficiency: 4 }, { name: 'Go', proficiency: 2 }],
    });
    expect(aliceSkill(edited.body, 'TypeScript')?.endorsements.endorserUserIds).toContain(bobId); // preserved
    expect(aliceSkill(edited.body, 'TypeScript')?.endorsements.endorsedByMe).toBe(false); // Alice is the owner, not an endorser
    expect(aliceSkill(edited.body, 'TypeScript')?.proficiency).toBe(4); // updated
    expect(aliceSkill(edited.body, 'Rust')).toBeUndefined(); // removed

    // Un-endorse.
    const un = await bob.del<ProfileView>(`/host/openwop-app/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(aliceSkill(un.body, 'TypeScript')?.endorsements).toEqual({ count: 0, endorsedByMe: false, endorserUserIds: [] });

    // Self-endorsement is forbidden.
    const selfEnd = await alice.post(`/host/openwop-app/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(selfEnd.status).toBe(403);

    // A non-existent skill → 404.
    const noSkill = await bob.post(`/host/openwop-app/profiles/${encodeURIComponent(aliceId)}/skills/COBOL/endorse`);
    expect(noSkill.status).toBe(404);

    // A cross-tenant endorser can't even see Alice → 404 (IDOR guard).
    const stranger = client();
    await signup(stranger);
    const xt = await stranger.post(`/host/openwop-app/profiles/${encodeURIComponent(aliceId)}/skills/TypeScript/endorse`);
    expect(xt.status).toBe(404);

    // Malformed skills payload → 400.
    const bad = await alice.put('/host/openwop-app/profiles/me/skills', { skills: [{ name: 'X' }] });
    expect(bad.status).toBe(400);
  });
});

describe('ADR 0025 — personal activity feed', () => {
  it('GET /me/activity is empty for a fresh user and surfaces a user-attributed run (always-on)', async () => {
    interface ActivityBody { items: AgentActivityItem[]; truncated: boolean }
    const c = client();
    await signup(c);

    // Empty for a fresh user (no orchestrated runs yet).
    const empty = await c.get<ActivityBody>('/host/openwop-app/profiles/me/activity');
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body.items).toEqual([]);
    expect(empty.body.truncated).toBe(false);

    // Register a workflow, schedule it for me, and fire it.
    const wfId = 'wf.activity-e2e';
    const reg = await c.post<unknown>('/host/openwop-app/workflows', { workflowId: wfId, nodes: [{ nodeId: 'op', typeId: 'test.passthrough', config: {} }], edges: [] });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const job = await c.post<{ jobId: string }>('/host/openwop-app/scheduler/jobs', { owner: 'me', cronExpr: '0 9 * * *', workflowId: wfId });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    const trig = await c.post<{ runId: string }>(`/host/openwop-app/scheduler/jobs/${encodeURIComponent(job.body.jobId)}/trigger`, {});
    expect(trig.status, JSON.stringify(trig.body)).toBe(200);
    expect(trig.body.runId).toBeTruthy();

    // The fired run is attributed to the user → appears in /me/activity.
    const act = await c.get<ActivityBody>('/host/openwop-app/profiles/me/activity');
    expect(act.status).toBe(200);
    const item = act.body.items.find((i) => i.runId === trig.body.runId);
    expect(item, JSON.stringify(act.body.items)).toBeTruthy();
    expect(item!.source).toBe('schedule');
    expect(item!.ownerUserId).toBeTruthy();
    expect(item!.workflowId).toBe(wfId);
  });
});

describe('ADR 0025 — assigned-workflow portfolio', () => {
  it('PUT /me/workflows replaces the portfolio (deduped, bounded); empty by default; bad payload 400', async () => {
    const c = client();
    await signup(c);

    // Empty by default.
    const fresh = await c.get<OwnProfileView>('/host/openwop-app/profiles/me');
    expect(fresh.body.workflows).toEqual([]);

    // Set a portfolio — duplicates collapse, order preserved.
    const set = await c.put<OwnProfileView>('/host/openwop-app/profiles/me/workflows', { workflows: ['wf.a', 'wf.b', 'wf.a'] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.workflows).toEqual(['wf.a', 'wf.b']);

    // Persists across reads.
    const after = await c.get<OwnProfileView>('/host/openwop-app/profiles/me');
    expect(after.body.workflows).toEqual(['wf.a', 'wf.b']);

    // Replace (not merge).
    const replaced = await c.put<OwnProfileView>('/host/openwop-app/profiles/me/workflows', { workflows: ['wf.c'] });
    expect(replaced.body.workflows).toEqual(['wf.c']);

    // Malformed payload → 400.
    const bad = await c.put('/host/openwop-app/profiles/me/workflows', { workflows: [1, 2] });
    expect(bad.status).toBe(400);
  });
});

describe('profiles Phase 4 — email-verification surfacing', () => {
  it('GET /me surfaces emailVerified=true for a federated (OIDC) identity', async () => {
    // ADR 0833 D9 — verified is decided by PROVENANCE (who asserted the address),
    // not by the lane that created the row. The ADR 0026 test seam mints a
    // `source:'oidc'` user whose address the IdP asserted → vouched → true.
    const c = client();
    await signup(c);
    const me = await c.get<OwnProfileView>('/host/openwop-app/profiles/me');
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.emailVerified).toBe(true);
  });
});

describe('profiles followup — review hardening', () => {
  it('sanitizes contact link URLs: drops javascript:/data:, keeps https/mailto', async () => {
    const c = client();
    await signup(c);
    const r = await c.patch<OwnProfileView>('/host/openwop-app/profiles/me', {
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
    const urls = (r.body.contact?.links ?? []).map((l) => l.url);
    expect(urls).toContain('https://example.com');
    expect(urls).toContain('mailto:a@b.com');
    expect(urls).not.toContain('javascript:alert(1)');
    expect(urls.some((u) => u.startsWith('data:'))).toBe(false);
    expect(urls).toHaveLength(2); // the two dangerous links were dropped
  });

  it('returns 409 (not 500) when the portfolio is full (max 24)', async () => {
    const c = client();
    await signup(c);
    for (let i = 0; i < 24; i++) {
      const t = await upload(c, 'image/png', PNG_1x1);
      const add = await c.post('/host/openwop-app/profiles/me/portfolio', { token: t });
      expect(add.status, JSON.stringify(add.body)).toBe(201);
    }
    const t25 = await upload(c, 'image/png', PNG_1x1);
    const over = await c.post('/host/openwop-app/profiles/me/portfolio', { token: t25 });
    expect(over.status).toBe(409);
    expect(over.body.error).toBe('validation_error');
  });

  it('rejects a non-numeric skill proficiency (400, not a NaN write)', async () => {
    const c = client();
    await signup(c);
    const r = await c.put('/host/openwop-app/profiles/me/skills', { skills: [{ name: 'X', proficiency: 'high' }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
  });

  it('GET /:userId surfaces emailVerified for a peer (same tenant)', async () => {
    const { alice, aliceId, bob } = await sameTenantPair();
    await alice.get('/host/openwop-app/profiles/me'); // materialize
    const read = await bob.get<ProfileView>(`/host/openwop-app/profiles/${encodeURIComponent(aliceId)}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.userId).toBe(aliceId);
    // ADR 0833 D9 — provenance-decided; the seam's `source:'oidc'` address is IdP-asserted.
    expect(read.body.emailVerified).toBe(true);
  });

  it('directory omits orphan profiles whose owning user was deleted', async () => {
    const { tenantId, alice, aliceId, bob, bobId } = await sameTenantPair();
    await alice.get('/host/openwop-app/profiles/me'); // materialize alice's profile
    await bob.get('/host/openwop-app/profiles/me'); // …and bob's (the non-vacuity control)
    const del = await bob.del(`/host/openwop-app/users/users/${encodeURIComponent(aliceId)}`);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    // The delete cascade erases alice's ROW too, so it alone cannot reach the
    // directory's orphan filter. A genuine orphan — a stored profile whose owner
    // has no users row in the tenant (e.g. a cascade that ran partially) —
    // is what the filter exists for.
    const { getOrCreateProfile } = await import('../src/features/profiles/profilesService.js');
    const ghost = `user:ghost-${Date.now()}-${n++}`;
    await getOrCreateProfile(tenantId, ghost);
    const dir = await bob.get<DirectoryBody>('/host/openwop-app/profiles');
    expect(dir.status).toBe(200);
    const ids = dir.body.profiles.map((p) => p.userId);
    expect(ids).toContain(bobId);
    expect(ids).not.toContain(aliceId);
    expect(ids).not.toContain(ghost);
  });
});

describe('PROF-2 — admin user-delete cascades the profile PII', () => {
  it('delete user → profile 404 by-id + Team Portfolio KB doc gone', async () => {
    const { alice, aliceId, bob } = await sameTenantPair();
    // The KB indexer is gated on the `production` toggle (the consumer).
    const prod = getToggleDefault('production');
    expect(prod, 'the production toggle must exist for the KB half of this test').toBeTruthy();
    await saveConfig({ ...prod!, status: 'on' }, 'test');

    const patch = await alice.patch<OwnProfileView>('/host/openwop-app/profiles/me', { bio: 'Cascade test bio', jobTitle: 'Engineer' });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    const tenantId = patch.body.tenantId;

    // PATCH /me AWAITS `indexProfile` (ADR 0643 D6), so the doc exists when the 200 returns.
    const { getDocument } = await import('../src/features/kb/kbService.js');
    const docId = `profile:${aliceId}`;
    const doc = await getDocument(tenantId, '_team', `mgd-team-${tenantId}`, docId);
    expect(doc, 'precondition: the Team Portfolio KB doc must exist before the delete').not.toBeNull();

    const del = await bob.del(`/host/openwop-app/users/users/${encodeURIComponent(aliceId)}`);
    expect(del.status, JSON.stringify(del.body)).toBe(204);

    // The by-id read no longer serves the orphaned PII…
    const read = await bob.get(`/host/openwop-app/profiles/${encodeURIComponent(aliceId)}`);
    expect(read.status).toBe(404);
    // …and the KB doc died with it.
    expect(await getDocument(tenantId, '_team', `mgd-team-${tenantId}`, docId)).toBeNull();
  });

  it('a KB-cascade failure BLOCKS the delete; the retry succeeds (review F3)', async () => {
    const { alice, aliceId, bob } = await sameTenantPair();
    const prod = getToggleDefault('production');
    expect(prod).toBeTruthy();
    await saveConfig({ ...prod!, status: 'on' }, 'test');

    const patch = await alice.patch<OwnProfileView>('/host/openwop-app/profiles/me', { bio: 'F3 retryability', jobTitle: 'Engineer' });
    expect(patch.status).toBe(200);
    const tenantId = patch.body.tenantId;
    // PATCH /me AWAITS `indexProfile` (ADR 0643 D6) — one read, no poll.
    const { getDocument } = await import('../src/features/kb/kbService.js');
    const doc = await getDocument(tenantId, '_team', `mgd-team-${tenantId}`, `profile:${aliceId}`);
    expect(doc, 'precondition: the KB doc must exist so its delete can fail').not.toBeNull();

    // Sabotage the KB doc's row delete only (doc rows key `<tenant>:_team:profile:<user>`;
    // the profile ROW key is the bare userId, so it stays deletable).
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const origDelete = DurableCollection.prototype.delete;
    const spy = vi.spyOn(DurableCollection.prototype, 'delete').mockImplementation(function (this: DurableCollectionType<unknown>, id: string) {
      if (id.includes(':_team:profile:')) return Promise.reject(new Error('kb delete sabotage'));
      return origDelete.call(this, id);
    });
    try {
      const del = await bob.del(`/host/openwop-app/users/users/${encodeURIComponent(aliceId)}`);
      expect(del.status, JSON.stringify(del.body)).toBe(500); // refused — NOT a silent partial delete
      // Nothing was deleted: the strict KB removal runs FIRST, so the profile
      // row (and the user) survive for the retry.
      const stillThere = await bob.get(`/host/openwop-app/profiles/${encodeURIComponent(aliceId)}`);
      expect(stillThere.status).toBe(200);
    } finally {
      spy.mockRestore();
    }

    // The retry (sabotage lifted) completes the whole cascade.
    const retry = await bob.del(`/host/openwop-app/users/users/${encodeURIComponent(aliceId)}`);
    expect(retry.status, JSON.stringify(retry.body)).toBe(204);
    expect((await bob.get(`/host/openwop-app/profiles/${encodeURIComponent(aliceId)}`)).status).toBe(404);
    expect(await getDocument(tenantId, '_team', `mgd-team-${tenantId}`, `profile:${aliceId}`)).toBeNull();
  });
});

describe('PROF-3 — tenant reads ride the armed index, never a full scan', () => {
  it('listProfiles never calls DurableCollection.list()', async () => {
    const { alice } = await sameTenantPair();
    const me = await alice.get<OwnProfileView>('/host/openwop-app/profiles/me');
    expect(me.status).toBe(200);
    const tenantId = me.body.tenantId;

    const svc = await import('../src/features/profiles/profilesService.js');
    // Warm pass: the ONE-TIME index backfill (sentinel-guarded) may legitimately
    // scan; the pin below is about the steady state.
    await svc.listProfiles(tenantId);

    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const listSpy = vi.spyOn(DurableCollection.prototype, 'list');
    try {
      const rows = await svc.listProfiles(tenantId);
      expect(rows.some((p) => p.userId === me.body.userId)).toBe(true); // non-vacuous: real rows came back
      expect(listSpy).not.toHaveBeenCalled(); // the no-scan pin
    } finally {
      listSpy.mockRestore();
    }
  });
});

describe('PROF-4 — concurrent endorsements are CAS-protected', () => {
  it('three concurrent endorsers all land (no lost update)', async () => {
    const svc = await import('../src/features/profiles/profilesService.js');
    const tenantId = `org:cas-${Date.now()}-${n++}`;
    const target = `user:cas-target-${n}`;
    await svc.getOrCreateProfile(tenantId, target);
    await svc.setOwnSkills(tenantId, target, [{ name: 'TypeScript', proficiency: 4 }]);

    // All three read the same baseline before any write commits (each runs to
    // its first await synchronously), so a blind read-modify-write put drops
    // endorsements here; the CAS loser must retry and merge.
    const endorsers = [`user:e1-${n}`, `user:e2-${n}`, `user:e3-${n}`];
    await Promise.all(endorsers.map((e) => svc.setEndorsement(tenantId, target, 'TypeScript', e, true)));

    const p = await svc.getProfile(tenantId, target);
    expect(new Set(p!.skills[0]!.endorsements)).toEqual(new Set(endorsers));
  });

  it('a skills edit racing an endorsement loses NEITHER (review F6 — all writers CAS)', async () => {
    const svc = await import('../src/features/profiles/profilesService.js');
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const tenantId = `org:cas-race-${Date.now()}-${n++}`;
    const target = `user:cas-race-${n}`;
    const endorser = `user:cas-race-endorser-${n}`;
    await svc.getOrCreateProfile(tenantId, target);
    await svc.setOwnSkills(tenantId, target, [{ name: 'Go', proficiency: 3 }]);

    // DETERMINISTIC interleave (a bare Promise.all race is scheduling-dependent
    // and stayed green under a blind-put sabotage — a vacuous probe): commit the
    // endorsement INSIDE the skills edit's baseline read, so the edit's read is
    // stale by construction. A blind put then clobbers the endorsement; the CAS
    // retry re-reads and merges.
    const origGet = DurableCollection.prototype.get;
    let armed = true;
    const spy = vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollectionType<unknown>, id: string) {
      const row = await origGet.call(this, id);
      if (armed && id === target) {
        armed = false; // only the skills edit's FIRST baseline read
        await svc.setEndorsement(tenantId, target, 'Go', endorser, true);
      }
      return row;
    });
    try {
      await svc.setOwnSkills(tenantId, target, [{ name: 'Go', proficiency: 5 }]);
    } finally {
      spy.mockRestore();
    }

    const p = await svc.getProfile(tenantId, target);
    const skill = p!.skills.find((s) => s.name === 'Go');
    expect(skill?.proficiency).toBe(5); // the edit landed…
    expect(skill?.endorsements).toContain(endorser); // …and so did the endorsement
  });

  it('the endorsement write is a compare-and-swap, not a blind put', async () => {
    const svc = await import('../src/features/profiles/profilesService.js');
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const tenantId = `org:cas-pin-${Date.now()}-${n++}`;
    const target = `user:cas-pin-${n}`;
    await svc.getOrCreateProfile(tenantId, target);
    await svc.setOwnSkills(tenantId, target, [{ name: 'Rust', proficiency: 3 }]);

    const putSpy = vi.spyOn(DurableCollection.prototype, 'put');
    const casSpy = vi.spyOn(DurableCollection.prototype, 'compareAndSwap');
    try {
      const updated = await svc.setEndorsement(tenantId, target, 'Rust', `user:pin-${n}`, true);
      expect(updated?.changed).toBe(true);
      expect(updated?.profile.skills[0]?.endorsements).toContain(`user:pin-${n}`);
      expect(casSpy).toHaveBeenCalled();
      expect(putSpy).not.toHaveBeenCalled();
    } finally {
      putSpy.mockRestore();
      casSpy.mockRestore();
    }
  });
});
