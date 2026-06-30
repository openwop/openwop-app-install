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
import { seedAdvisoryBoards, countAdvisors, clearAdvisoryBoards } from '../src/host/advisoryBoardSeed.js';
import { exampleDataStatus } from '../src/host/exampleDataSeeders.js';
import { listBoards } from '../src/features/advisory-board/service.js';
import { resolveAgentKnowledgeRetrieve } from '../src/host/agentKnowledgeComposition.js';
import { createAgentMemoryPort, agentMemoryScope } from '../src/host/agentMemoryAdapter.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
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
  const login = await c.post('/v1/host/openwop-app/test/login', { email: `seed-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
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
    const retrieve = await resolveAgentKnowledgeRetrieve(tenantId, advisorRosterId, memory, agentMemoryScope(advisorRosterId));
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
