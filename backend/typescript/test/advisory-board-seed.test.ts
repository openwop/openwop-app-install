/**
 * Board of Advisors demo seed (ADR 0040) — proves `seedAdvisoryBoards`:
 *   - creates the simulated-persona advisor agents + the two demo boards;
 *   - is idempotent (a second call creates nothing);
 *   - preseeds each advisor's RFC-0004 memory, which RECALLS in a convene
 *     (an advisor turn comes back `grounded: true` for a matching prompt);
 *   - gates on the `advisory-board` toggle (off ⇒ nothing seeded).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { seedAdvisoryBoards, countAdvisors, clearAdvisoryBoards, mergeDuplicateSeededAdvisors } from '../src/host/advisoryBoardSeed.js';
import { createRosterEntry, listRoster } from '../src/host/rosterService.js';
import { createBoard } from '../src/features/advisory-board/service.js';
import { exampleDataStatus } from '../src/host/exampleDataSeeders.js';
import { listBoards } from '../src/features/advisory-board/service.js';
import { resolveAgentKnowledgeRetrieve } from '../src/host/agentKnowledgeComposition.js';
import { createAgentMemoryPort } from '../src/host/agentMemoryAdapter.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'kb', 'advisory-board']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { post: (p: string, b?: unknown) => call('POST', p, b) };
}

/** A signed-up owner in a fresh tenant, with one org (the seed needs an org). */
async function ownerTenant(): Promise<{ tenantId: string; userId: string }> {
  const tenantId = `org:seed-${Date.now()}-${n++}`;
  const c = client();
  const login = await c.post('/host/openwop-app/test/login', { email: `seed-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { tenantId, userId: login.body.user.userId };
}

describe('advisory-board seed', () => {
  it('seeds 8 advisors + 2 boards, is idempotent, and preseeded memory is recallable per advisor', async () => {
    const { tenantId, userId } = await ownerTenant();
    const storage = __hostExtStorage();
    expect(storage).not.toBeNull();

    const first = await seedAdvisoryBoards(tenantId, storage!, {});
    expect(first.advisorsCreated).toBe(8);
    expect(first.boardsCreated).toBe(2);

    // Idempotent — a second call creates nothing.
    const second = await seedAdvisoryBoards(tenantId, storage!, {});
    expect(second.advisorsCreated).toBe(0);
    expect(second.boardsCreated).toBe(0);

    // Both boards exist (shared), with the expected handles + disclaimers.
    const boards = await listBoards(tenantId, userId);
    const byHandle = new Map(boards.map((b) => [b.handle, b]));
    expect(byHandle.has('titans')).toBe(true);
    expect(byHandle.has('timeless')).toBe(true);
    expect(byHandle.get('titans')!.advisors).toHaveLength(4);
    // Living board carries the ack + a disclaimer; historical board carries a disclaimer.
    expect(byHandle.get('titans')!.disclaimer).toMatch(/simulated/i);

    // Preseeded memory is recallable for an advisor (keyed by rosterId, with the
    // `knowledge` capability active) — exactly what the AI chat's chat.turn agent
    // dispatch composes (ADR 0038), so the persona recalls it in a council chat.
    const advisorRosterId = byHandle.get('timeless')!.advisors[0]!;
    const memory = createAgentMemoryPort(tenantId);
    // ADR 0442 P3 — a default-scope agent (no `memoryScope`) recalls
    // `agent:<rosterId>` with no acting participant, exactly as before.
    const retrieve = await resolveAgentKnowledgeRetrieve(tenantId, advisorRosterId, memory);
    expect(retrieve, 'advisor has the knowledge capability + a memory binding').toBeDefined();
    const chunks = await retrieve!('How should I weigh a hard decision with strong pros and cons?');
    expect(chunks.some((c) => c.kind === 'memory')).toBe(true);
  });

  it('surfaces advisors + cms-homepage in the demo-data status registry, and clears them', async () => {
    const { tenantId } = await ownerTenant();
    const storage = __hostExtStorage();
    await seedAdvisoryBoards(tenantId, storage!, {});

    const steps = await exampleDataStatus(tenantId, storage!);
    const byId = new Map(steps.map((s) => [s.id, s]));
    // The advisors row reports the 8 seeded advisors; cms-homepage is present (host-global).
    expect(byId.get('advisors')?.count).toBe(8);
    expect(byId.get('cms-homepage')?.count).toBeGreaterThanOrEqual(1);
    expect(await countAdvisors(tenantId)).toBe(8);

    // Clearing removes the seeded advisors + boards (count returns to zero).
    const cleared = await clearAdvisoryBoards(tenantId, storage!);
    expect(cleared.advisorsCleared).toBe(8);
    expect(cleared.boardsCleared).toBe(2);
    expect(await countAdvisors(tenantId)).toBe(0);
    expect(await listBoards(tenantId, undefined)).toHaveLength(0);
  });

  it('seeds nothing when the advisory-board toggle is off', async () => {
    const d = getToggleDefault('advisory-board');
    if (d) await saveConfig({ ...d, status: 'off' }, 'test');
    const { tenantId } = await ownerTenant();
    const storage = __hostExtStorage();
    const r = await seedAdvisoryBoards(tenantId, storage!, {});
    expect(r.skippedToggleOff).toBe(true);
    expect(r.advisorsCreated).toBe(0);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  });
});

describe('duplicate seeded advisors are merged on heal', () => {
  // Seen on production 2026-10-02: the board editor listed all eight advisors
  // TWICE, and convening a board found none of them. A reseed before the seeder
  // matched the legacy agent-id form minted a second roster row per advisor.
  const advisorRows = async (tenantId: string) =>
    (await listRoster(tenantId)).filter((e) => e.agentRef.agentId.includes('advisor-'));

  /** Reproduce the legacy state: a twin row per advisor on the tenant-scoped id.
   *  Planted as RAW rows — `createRosterEntry` refuses a second member with the
   *  same persona today, which is exactly why these can only be old data. */
  async function plantLegacyTwins(tenantId: string): Promise<string[]> {
    const twins: string[] = [];
    for (const row of await advisorRows(tenantId)) {
      const slug = row.agentRef.agentId.replace('user.advisor-', '');
      const rosterId = `${row.rosterId}-legacy`;
      const twin = { ...row, rosterId, agentRef: { ...row.agentRef, agentId: `user.${tenantId}.advisor-${slug}` }, createdAt: new Date(Date.parse(row.createdAt) - 60_000).toISOString() };
      await __hostExtStorage()!.kvSet(`hostext:roster:${tenantId}:${rosterId}`, JSON.stringify(twin));
      twins.push(rosterId);
    }
    return twins;
  }

  it('leaves ONE row per advisor and keeps every board seat', async () => {
    const { tenantId } = await ownerTenant();
    await seedAdvisoryBoards(tenantId, __hostExtStorage()!);
    const originals = (await advisorRows(tenantId)).map((r) => r.rosterId);
    const twins = await plantLegacyTwins(tenantId);
    expect((await advisorRows(tenantId)).length).toBe(originals.length * 2);

    // A user board seated on the TWIN rows — the case that could lose its seats.
    const orgId = (await listBoards(tenantId, undefined))[0]!.orgId;
    await createBoard(tenantId, orgId, 'user-1', { name: 'Directors', handle: 'directors', advisors: twins.slice(0, 4), visibility: 'shared', personaKind: 'original' });

    const result = await seedAdvisoryBoards(tenantId, __hostExtStorage()!, { heal: true });
    expect(result.duplicatesMerged).toBe(originals.length);

    const after = await advisorRows(tenantId);
    expect(after.length).toBe(originals.length);
    expect(new Set(after.map((r) => r.persona)).size).toBe(originals.length);

    const live = new Set(after.map((r) => r.rosterId));
    for (const b of await listBoards(tenantId, undefined)) {
      expect(b.advisors.length, `${b.handle} lost a seat`).toBe(4);
      for (const id of b.advisors) expect(live.has(id), `${b.handle} seats a deleted row`).toBe(true);
      expect(new Set(b.advisors).size, `${b.handle} seats an advisor twice`).toBe(b.advisors.length);
    }
  });

  it('is a no-op on a clean tenant, and only runs on the heal path', async () => {
    const { tenantId } = await ownerTenant();
    await seedAdvisoryBoards(tenantId, __hostExtStorage()!);
    expect(await mergeDuplicateSeededAdvisors(tenantId, __hostExtStorage()!)).toBe(0);
    const before = (await advisorRows(tenantId)).length;
    await plantLegacyTwins(tenantId);
    const plain = await seedAdvisoryBoards(tenantId, __hostExtStorage()!);
    expect(plain.duplicatesMerged).toBeUndefined();
    expect((await advisorRows(tenantId)).length).toBe(before * 2); // an ordinary seed deletes nothing
  });

  it('recognises a seeded twin under an agent id form it has never seen, by its content', async () => {
    const { tenantId } = await ownerTenant();
    await seedAdvisoryBoards(tenantId, __hostExtStorage()!);
    const row = (await advisorRows(tenantId))[0]!;
    const twin = { ...row, rosterId: `${row.rosterId}-odd`, agentRef: { ...row.agentRef, agentId: 'user.something-else-entirely' } };
    await __hostExtStorage()!.kvSet(`hostext:roster:${tenantId}:${twin.rosterId}`, JSON.stringify(twin));
    expect(await mergeDuplicateSeededAdvisors(tenantId, __hostExtStorage()!)).toBe(1);
    expect((await listRoster(tenantId)).filter((e) => e.persona === row.persona).length).toBe(1);
  });

  it('never touches an advisor the user authored', async () => {
    const { tenantId } = await ownerTenant();
    await seedAdvisoryBoards(tenantId, __hostExtStorage()!);
    const own = await createRosterEntry({
      tenantId, persona: 'My Own Advisor', agentRef: { agentId: 'user.my-own-advisor', version: '1.0.0' },
      label: 'mine', description: 'authored by the user', autonomyLevel: 'review', roleKey: 'advisor',
    });
    expect(await mergeDuplicateSeededAdvisors(tenantId, __hostExtStorage()!)).toBe(0);
    expect((await listRoster(tenantId)).some((e) => e.rosterId === own.rosterId)).toBe(true);
  });
});
