/**
 * Demo-seed dedup + roster-delete cascade (TST-DBA-2).
 *
 * Regression coverage for the live "agents reseed into duplicates, and deleting
 * one orphans its board/schedules" report:
 *
 *  1. CONCURRENT first seeds for one tenant create exactly ONE set of personas,
 *     never duplicates — the atomic compare-and-swap first-seed claim closes the
 *     old check-then-act race (no UNIQUE index on the kv roster store). Two
 *     `Promise.all` seeds never interleave on their own, so the race is FORCED:
 *     a one-shot hold on `kvCompareAndSwap` keeps the first caller inside the
 *     claim until the second has read the (still empty) roster too.
 *  2. The SILENT auto-seed (POST /example-data/seed {}) does NOT resurrect a roster
 *     agent the user deleted; the EXPLICIT heal (heal:true / "Load demo data")
 *     does.
 *  3. DELETE /roster/:id CASCADES: the member's board (+ cards), schedule jobs,
 *     org-chart membership, and chat-callable inventory agent go with it — no
 *     dangling rows referencing a now-gone rosterId.
 *
 * Every case seeds its own state (case 1 its own tenant; cases 2–3 an explicit
 * heal first), so the file passes in any order.
 *
 * Red when: `firstSeed` ignores `claim.swapped` (forced race → 20 personas),
 * `allowCreate` is always true (silent reseed resurrects), or the cascade drops
 * the board / job / chat-agent step (probes w70g2-dc-cas-r2, -dc-allow,
 * -dc-board, -dc-jobs, -dc-chat).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { listBoards } from '../src/host/kanbanService.js';
import { listJobsByRoster } from '../src/host/schedulingService.js';
import { getChart } from '../src/host/orgChartService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { seedEverything } from '../src/host/seedEverything.js';
import { listRoster } from '../src/host/rosterService.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
const TENANT = 'default';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; // single fixed 'default' tenant
  const app = await createApp({
    port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
  });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => {
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  await new Promise<void>((res) => server.close(() => res()));
});

interface RosterEntry { rosterId: string; persona: string; agentRef: { agentId: string } }
async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text.length ? JSON.parse(text) : null) as T };
}
const roster = async (): Promise<RosterEntry[]> => (await api<{ roster: RosterEntry[] }>('/host/openwop-app/roster')).body.roster;
const heal = () => api('/host/openwop-app/example-data/seed', { method: 'POST', body: JSON.stringify({ heal: true, expectedTenantId: 'default' }) });

/** Idris on the default tenant, created by an explicit heal when missing. */
async function ensureIdris(): Promise<RosterEntry> {
  expect((await heal()).status).toBe(200);
  const idris = (await roster()).find((r) => r.persona === 'Idris');
  expect(idris, 'heal must (re)create Idris').toBeDefined();
  if (!idris) throw new Error('unreachable');
  return idris;
}

describe('demo-seed dedup + roster-delete cascade', () => {
  it('concurrent first seeds create exactly one set of personas (no duplicates)', async () => {
    // A fresh tenant of its own, so the case never depends on another's seed.
    const tenant = 'dedup-race-tenant';
    const storage = hostExtStorage();
    const markerKey = `demo:seed-claimed:${tenant}`;
    const original = storage.kvCompareAndSwap.bind(storage);
    let arrivals = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((r) => { release = r; });
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key === markerKey) {
        arrivals += 1;
        if (arrivals === 2) release();
        // Hold every claimant until both have read the empty roster (2 s fallback).
        await Promise.race([bothArrived, new Promise<void>((r) => setTimeout(r, 2000))]);
      }
      return original(key, expected, next);
    });
    try {
      const [a, b] = await Promise.all([seedEverything(tenant, storage), seedEverything(tenant, storage)]);
      expect(arrivals).toBe(2); // the race really was forced
      // Exactly one claimant seeded; the loser created nothing.
      expect([a.seeded, b.seeded].filter(Boolean).length).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const personas = (await listRoster(tenant)).map((r) => r.persona.toLowerCase());
    // No persona appears twice — the race can't double-insert.
    expect(personas.length).toBe(new Set(personas).size);
    expect(personas.length).toBe(10); // 8 twins + Executive Ops + Chief of Staff (ADR 0032)
  });

  it('DELETE /roster/:id cascades the board, schedules, org-chart membership, and chat agent', async () => {
    const idris = await ensureIdris();

    // Preconditions: a bound board, ≥1 schedule job, an org-chart seat, a chat agent.
    expect((await listBoards(TENANT)).some((bd) => bd.rosterId === idris.rosterId)).toBe(true);
    expect((await listJobsByRoster(TENANT, idris.rosterId)).length).toBeGreaterThan(0);
    expect((await getChart(TENANT))?.members.some((m) => m.rosterId === idris.rosterId)).toBe(true);
    expect((await hostExtStorage().listUserAgents(TENANT)).some((ua) => ua.agentId === idris.agentRef.agentId)).toBe(true);

    const del = await api(`/host/openwop-app/roster/${idris.rosterId}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    // Everything the member owned is gone — nothing orphaned on its rosterId.
    expect((await listBoards(TENANT)).some((bd) => bd.rosterId === idris.rosterId)).toBe(false);
    expect((await listJobsByRoster(TENANT, idris.rosterId)).length).toBe(0);
    expect((await getChart(TENANT))?.members.some((m) => m.rosterId === idris.rosterId) ?? false).toBe(false);
    expect((await hostExtStorage().listUserAgents(TENANT)).some((ua) => ua.agentId === idris.agentRef.agentId)).toBe(false);
    expect((await roster()).some((r) => r.persona === 'Idris')).toBe(false);
  });

  it('silent reseed does NOT resurrect the deleted agent; heal restores it', async () => {
    const idris = await ensureIdris();
    expect((await api(`/host/openwop-app/roster/${idris.rosterId}`, { method: 'DELETE' })).status).toBe(204);

    // Plain auto-seed on a known tenant respects the deletion.
    await api('/host/openwop-app/example-data/seed', { method: 'POST', body: JSON.stringify({ expectedTenantId: 'default' }) });
    expect((await roster()).some((r) => r.persona === 'Idris')).toBe(false);
    expect((await roster()).length).toBe(9);

    // Explicit "Load demo data" puts it back.
    expect((await heal()).status).toBe(200);
    const after = await roster();
    const restored = after.find((r) => r.persona === 'Idris');
    expect(restored).toBeDefined();
    expect(after.length).toBe(10);
    // Restored Idris has a fresh board (cascade earlier removed the old one).
    expect((await listBoards(TENANT)).some((bd) => bd.rosterId === restored?.rosterId)).toBe(true);
  });
});
