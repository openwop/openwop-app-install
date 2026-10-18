/**
 * ADR 0624 D4 / D6 / D7 + PROF-11(d) — ROUTE-level harness over the real app
 * (the `profiles-route.test.ts` shape):
 *
 *   D6  PROF-9  — a skill name containing `%` endorses fine
 *                 (`encodeURIComponent('50% off')` → 200; the route no longer
 *                 double-decodes Express's already-decoded param → `URIError` → 500);
 *       PROF-10 — the 13th pin is an honest 409 `validation_error` with
 *                 `details.maxPinned: 12`; the 12 pins are UNCHANGED (no silent
 *                 eviction of the oldest); the chat target is independent.
 *   D4  `completenessMissing[]` (weight desc, sums with `completeness` to 100) on
 *       the `/me` lane ONLY — `/team` and `GET /:userId` do NOT carry it.
 *   D7  PROF-5  — endorsements projected `{ count, endorsedByMe, endorserUserIds }`
 *                 for the VIEWER (the endorser sees `true`, the owner and a third
 *                 member `false`);
 *       PROF-12 — the endorse handlers append an ids-only audit row (never the
 *                 skill name).
 *   PROF-11(d) — from a switched `ws:` shared workspace, `/profiles/me` and the
 *       directory still serve the HOME tenant's rows (ADR 0042 home-tenant by
 *       design; the pin that turns red before an "obvious" widening reaches the
 *       `knowledgeBindingPrune` self-heal).
 *
 * Sabotage that turns it red (grade-tests w3 probes, each witnessed):
 *   - the endorse route re-`decodeURIComponent`s the param        → D6 / PROF-9
 *   - the pin cap allows a 13th / drops `target` from details     → D6 / PROF-10
 *   - `/me` drops `completenessMissing`; the team view carries it → the two D4 cases
 *   - `endorsedByMe` = "anyone endorsed"; the directory loses the
 *     viewer; the audit row is written on a no-op; or it carries
 *     the skill name                                             → D7 / PROF-5 + PROF-12
 *   - `/me` reads the ACTIVE (`ws:`) tenant instead of the home   → PROF-11(d)
 * Honest ceiling: the `completenessMissing` weight-desc sort cannot be
 * sabotage-witnessed — `COMPLETENESS_WEIGHTS` is already in weight-desc order.
 *
 * BLOCKED-ON-PRODUCT (grade-code Blocker): a RAW undecodable `%` should be a
 * 400, but `errorEnvelopeMiddleware` (`src/middleware/errorEnvelope.ts`) maps
 * every non-`OpenwopError` — Express's `URIError` carrying `status: 400` — to
 * 500 and ignores `err.status`. The test asserts only `>= 400` until that lands.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import { listChain } from '../src/host/auditChainService.js';
import { COMPLETENESS_WEIGHTS } from '../src/features/profiles/completeness.js';
import type { OwnProfileView, ProfileView, ProfileViewSkill } from '../src/features/profiles/profilesService.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'orgs']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

/** The host error envelope (`errorEnvelope.ts`). */
interface ErrorBody { error: string; message?: string; details?: unknown }
interface DirectoryBody { profiles: ProfileView[] }
interface Res<T> { status: number; body: T }
/** Typed per call at the JSON boundary — the one place a wire body becomes a product type. */
type Call = <T = ErrorBody>(p: string, b?: unknown) => Promise<Res<T>>;
interface Client { get: Call; post: Call; patch: Call; put: Call; del: Call }
function client(): Client {
  let cookie = '';
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const sc of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]!; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}
const P = '/host/openwop-app/profiles';
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<string> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `a0624-${Date.now()}-${n++}@acme.test`, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId;
}
/** Three co-tenant members in one explicit `org:` tenant. */
async function trio(): Promise<{ tenantId: string; alice: Client; aliceId: string; bob: Client; bobId: string; carol: Client; carolId: string }> {
  const tenantId = `org:a0624-${Date.now()}-${n++}`;
  const alice = client(); const aliceId = await signup(alice, { tenantId });
  const bob = client(); const bobId = await signup(bob, { tenantId });
  const carol = client(); const carolId = await signup(carol, { tenantId });
  return { tenantId, alice, aliceId, bob, bobId, carol, carolId };
}
const skillOf = (body: { skills: ProfileViewSkill[] } | undefined, name: string): ProfileViewSkill | undefined => body?.skills.find((s) => s.name === name);

describe('D6 / PROF-9 — a `%` in a skill name endorses (no double decode)', () => {
  it("encodeURIComponent('50% off') → 200 with the endorsement landed; a RAW % is refused before the handler", async () => {
    const { alice, aliceId, bob } = await trio();
    const set = await alice.put<OwnProfileView>(`${P}/me/skills`, { skills: [{ name: '50% off', proficiency: 3 }] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const end = await bob.post<ProfileView>(`${P}/${encodeURIComponent(aliceId)}/skills/${encodeURIComponent('50% off')}/endorse`);
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    expect(skillOf(end.body, '50% off')?.endorsements.count).toBe(1);
    const un = await bob.del<ProfileView>(`${P}/${encodeURIComponent(aliceId)}/skills/${encodeURIComponent('50% off')}/endorse`);
    expect(un.status).toBe(200);
    expect(skillOf(un.body, '50% off')?.endorsements.count).toBe(0);
    // A raw, undecodable `%` never reaches the handler: Express's own router
    // throws `URIError` (with `status: 400`) while matching the param. FINDING
    // (ADR 0624 deviation, not a profiles defect): this host's core
    // `error-envelope` does not honour `err.status`, so the refusal surfaces as
    // 500 today — filed as a core follow-on; asserted here as a refusal only.
    const raw = await fetch(`${BASE}${P}/${encodeURIComponent(aliceId)}/skills/50%zz/endorse`, { method: 'POST' });
    expect(raw.status).toBeGreaterThanOrEqual(400);
  });
});

describe('D6 / PROF-10 — the 13th pin is an honest 409, the 12 pins are unchanged', () => {
  it('12 pins land in order; the 13th → 409 validation_error { maxPinned: 12 }; the chat target is an independent cap', async () => {
    const tenantId = `org:a0624-pins-${Date.now()}-${n++}`;
    const c = client();
    await signup(c, { tenantId });
    const ids: string[] = [];
    for (let i = 0; i < 13; i++) ids.push((await createRosterEntry({ tenantId, persona: `Pin${i}`, agentRef: { agentId: `pin.${i}` } })).rosterId);
    for (let i = 0; i < 12; i++) {
      const r = await c.put(`${P}/me/pinned-agents/${encodeURIComponent(ids[i]!)}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const thirteenth = await c.put(`${P}/me/pinned-agents/${encodeURIComponent(ids[12]!)}`);
    expect(thirteenth.status).toBe(409);
    expect(thirteenth.body.error).toBe('validation_error');
    expect(thirteenth.body.details).toEqual({ maxPinned: 12, target: 'sidebar' });
    const me = await c.get<OwnProfileView>(`${P}/me`);
    expect(me.body.pinnedAgentIds).toEqual(ids.slice(0, 12)); // unchanged — no eviction of the oldest
    // Re-pinning an already-pinned agent at the cap is still the idempotent 200.
    const again = await c.put(`${P}/me/pinned-agents/${encodeURIComponent(ids[0]!)}`);
    expect(again.status).toBe(200);
    // The chat pin target has its own cap.
    const chat = await c.put<OwnProfileView>(`${P}/me/pinned-chat-agents/${encodeURIComponent(ids[12]!)}`);
    expect(chat.status, JSON.stringify(chat.body)).toBe(200);
    expect(chat.body.pinnedChatAgentIds).toEqual([ids[12]]);
    // Unpin one, then the 13th fits.
    await c.del(`${P}/me/pinned-agents/${encodeURIComponent(ids[0]!)}`);
    const fits = await c.put<OwnProfileView>(`${P}/me/pinned-agents/${encodeURIComponent(ids[12]!)}`);
    expect(fits.status).toBe(200);
    expect(fits.body.pinnedAgentIds).toEqual([...ids.slice(1, 12), ids[12]]);
  });
});

describe('D4 — completenessMissing[] on the /me lane ONLY', () => {
  it('GET /me carries the full weights table (empty profile), weight desc, summing with completeness to 100; PATCH /me drops the earned field', async () => {
    const { alice } = await trio();
    const me = await alice.get<OwnProfileView>(`${P}/me`);
    expect(me.status).toBe(200);
    expect(me.body.completeness).toBe(0);
    const missing = me.body.completenessMissing;
    expect(missing.map((m) => m.field)).toEqual(['avatar', 'bio', 'skills', 'jobTitle', 'department', 'availability', 'interests', 'portfolio', 'equipment']);
    for (let i = 1; i < missing.length; i++) expect(missing[i - 1]!.weight).toBeGreaterThanOrEqual(missing[i]!.weight);
    expect(missing.reduce((a, m) => a + m.weight, 0) + me.body.completeness).toBe(100);
    expect(COMPLETENESS_WEIGHTS.reduce((a, w) => a + w.weight, 0)).toBe(100);

    const patched = await alice.patch<OwnProfileView>(`${P}/me`, { jobTitle: 'Producer', bio: 'x' });
    expect(patched.status).toBe(200);
    expect(patched.body.completeness).toBe(25);
    const after = patched.body.completenessMissing;
    expect(after.map((m) => m.field)).not.toContain('jobTitle');
    expect(after.map((m) => m.field)).not.toContain('bio');
    expect(after.reduce((a, m) => a + m.weight, 0)).toBe(75);
    // Every /me writer answers with the own view.
    const skills = await alice.put<OwnProfileView>(`${P}/me/skills`, { skills: [{ name: 'Go', proficiency: 2 }] });
    expect(skills.body.completenessMissing.map((m) => m.field)).not.toContain('skills');
    // `workflows` earns no weight, so the own view after it is exactly what is still missing.
    const wfs = await alice.put<OwnProfileView>(`${P}/me/workflows`, { workflows: ['wf.a'] });
    expect(wfs.body.completenessMissing.map((m) => m.field)).toEqual(['avatar', 'department', 'availability', 'interests', 'portfolio', 'equipment']);
  });

  it('/team and GET /:userId do NOT carry completenessMissing (self-only guidance)', async () => {
    const { alice, aliceId, bob } = await trio();
    await alice.patch(`${P}/me`, { jobTitle: 'Producer' });
    const team = await bob.get<DirectoryBody>(P);
    expect(team.status).toBe(200);
    const rows = team.body.profiles;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) expect('completenessMissing' in row, `directory row ${row.userId} carries completenessMissing`).toBe(false);
    const one = await bob.get<ProfileView>(`${P}/${encodeURIComponent(aliceId)}`);
    expect(one.status).toBe(200);
    expect('completenessMissing' in one.body).toBe(false);
    expect(one.body.completeness).toBe(10); // the NUMBER stays team-visible
    // The endorse response is a team view too.
    await alice.put(`${P}/me/skills`, { skills: [{ name: 'Go', proficiency: 2 }] });
    const end = await bob.post<ProfileView>(`${P}/${encodeURIComponent(aliceId)}/skills/Go/endorse`);
    expect(end.status).toBe(200);
    expect('completenessMissing' in end.body).toBe(false);
  });
});

describe('D7 / PROF-5 + PROF-12 — viewer-projected endorsements and the ids-only audit row', () => {
  it('endorsedByMe is per VIEWER; count + endorserUserIds are shared; the audit chain carries ids only (never the skill name)', async () => {
    const { tenantId, alice, aliceId, bob, bobId, carol } = await trio();
    await alice.put(`${P}/me/skills`, { skills: [{ name: 'Lighting', proficiency: 4 }] });
    const end = await bob.post<ProfileView>(`${P}/${encodeURIComponent(aliceId)}/skills/Lighting/endorse`);
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    expect(skillOf(end.body, 'Lighting')?.endorsements).toEqual({ count: 1, endorsedByMe: true, endorserUserIds: [bobId] });
    // The owner's own view and a third member's view.
    const own = await alice.get<OwnProfileView>(`${P}/me`);
    expect(skillOf(own.body, 'Lighting')?.endorsements).toEqual({ count: 1, endorsedByMe: false, endorserUserIds: [bobId] });
    const third = await carol.get<ProfileView>(`${P}/${encodeURIComponent(aliceId)}`);
    expect(skillOf(third.body, 'Lighting')?.endorsements).toEqual({ count: 1, endorsedByMe: false, endorserUserIds: [bobId] });
    const teamRow = (await bob.get<DirectoryBody>(P)).body.profiles.find((p) => p.userId === aliceId);
    expect(skillOf(teamRow, 'Lighting')?.endorsements.endorsedByMe).toBe(true);
    // No raw endorser ARRAY leaks anywhere on the wire.
    expect(Array.isArray(skillOf(own.body, 'Lighting')?.endorsements)).toBe(false);

    // PROF-12 — the audit row: ids only.
    const un = await bob.del(`${P}/${encodeURIComponent(aliceId)}/skills/Lighting/endorse`);
    expect(un.status).toBe(200);
    const chain = await listChain(tenantId);
    const rows = chain.filter((e) => e.kind.startsWith('profiles.endorsement.'));
    expect(rows.map((e) => e.kind)).toEqual(['profiles.endorsement.given', 'profiles.endorsement.removed']);
    for (const row of rows) {
      expect(Object.keys(row.payload).sort()).toEqual(['actor', 'endorserUserId', 'tenantId', 'userId']);
      expect(row.payload).toMatchObject({ tenantId, userId: aliceId, endorserUserId: bobId, actor: bobId });
      expect(JSON.stringify(row.payload)).not.toContain('Lighting');
    }
    // An idempotent re-remove (and re-add) is a NO transition: the service
    // reports `changed: false` and the route writes NO audit row — a `removed`
    // row for nothing removed would be a lie in the chain (review S1; the
    // earlier shape pinned three rows, i.e. pinned the defect).
    const again = await bob.del(`${P}/${encodeURIComponent(aliceId)}/skills/Lighting/endorse`);
    expect(again.status).toBe(200);
    expect((await listChain(tenantId)).filter((e) => e.kind.startsWith('profiles.endorsement.'))).toHaveLength(2);
    await bob.post(`${P}/${encodeURIComponent(aliceId)}/skills/Lighting/endorse`);
    await bob.post(`${P}/${encodeURIComponent(aliceId)}/skills/Lighting/endorse`); // idempotent re-add
    expect((await listChain(tenantId)).filter((e) => e.kind.startsWith('profiles.endorsement.')).map((e) => e.kind))
      .toEqual(['profiles.endorsement.given', 'profiles.endorsement.removed', 'profiles.endorsement.given']);
  });
});

describe('PROF-11(d) — a switched `ws:` workspace still serves the HOME tenant\'s profile row on the /me lane (ADR 0042, by design)', () => {
  it('/profiles/me and the directory from inside a ws: workspace read the home-tenant rows written before the switch', async () => {
    const c = client();
    const userId = await signup(c); // home = personal tenant
    const home = await c.patch(`${P}/me`, { jobTitle: 'HomeTitle' });
    expect(home.status, JSON.stringify(home.body)).toBe(200);
    const ws = await c.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: `Profiles WS ${n++}` });
    expect(ws.status, JSON.stringify(ws.body)).toBe(201);
    expect(ws.body.workspaceId).toMatch(/^ws:/);
    const sw = await c.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws.body.workspaceId)}/switch`);
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);

    const me = await c.get<OwnProfileView>(`${P}/me`);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.userId).toBe(userId);
    expect(me.body.jobTitle).toBe('HomeTitle'); // the HOME row, not a fresh ws:-keyed one
    expect(me.body.tenantId).not.toMatch(/^ws:/);
    // CORRECTED (ADR 0888 D1): this used to assert that the DIRECTORY inside a
    // `ws:` workspace served the HOME tenant's rows — which pinned the defect
    // (`PR2WF-2`: a workspace's directory never showed its own members). In a
    // shared workspace the directory now lists the people who SHARED their
    // profile with it; the caller's own home row reaches it only once they share.
    const dir = await c.get<DirectoryBody & { scope: string }>(P);
    expect(dir.status).toBe(200);
    expect(dir.body.scope).toBe('workspace');
    expect(dir.body.profiles.find((p) => p.userId === userId)).toBeUndefined();
    expect((await c.put(`${P}/me/workspace-share`)).status).toBe(200);
    const shared = await c.get<DirectoryBody>(P);
    expect(shared.body.profiles.find((p) => p.userId === userId)?.jobTitle).toBe('HomeTitle');
    // A write from inside the workspace lands on the SAME home row.
    const patched = await c.patch<OwnProfileView>(`${P}/me`, { department: 'FromWs' });
    expect(patched.status).toBe(200);
    expect(patched.body.tenantId).toBe(me.body.tenantId);
    expect(patched.body.jobTitle).toBe('HomeTitle');
  });
});
