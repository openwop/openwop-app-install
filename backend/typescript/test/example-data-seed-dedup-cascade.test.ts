/**
 * Demo-seed dedup + roster-delete cascade.
 *
 * Regression coverage for the live "agents reseed into duplicates, and deleting
 * one orphans its board/schedules" report:
 *
 *  1. CONCURRENT first seeds for one tenant create exactly ONE set of personas,
 *     never duplicates — the atomic compare-and-swap first-seed claim closes the
 *     old check-then-act race (no UNIQUE index on the kv roster store).
 *  2. The SILENT auto-seed (POST /demo/seed {}) does NOT resurrect a roster
 *     agent the user deleted; the EXPLICIT heal (heal:true / "Load demo data")
 *     does.
 *  3. DELETE /roster/:id CASCADES: the member's board (+ cards), schedule jobs,
 *     org-chart membership, and chat-callable inventory agent go with it — no
 *     dangling rows referencing a now-gone rosterId.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { listBoards } from '../src/host/kanbanService.js';
import { listJobsByRoster } from '../src/host/schedulingService.js';
import { getChart } from '../src/host/orgChartService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';

let server: http.Server;
const PORT = 18771;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'dev-token';
const TENANT = 'default';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; // single fixed 'default' tenant
  const app = await createApp({
    port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
  });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
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
const roster = async (): Promise<RosterEntry[]> => (await api<{ roster: RosterEntry[] }>('/v1/host/openwop-app/roster')).body.roster;

describe('demo-seed dedup + roster-delete cascade', () => {
  it('concurrent first seeds create exactly one set of personas (no duplicates)', async () => {
    // Two silent seeds fire at once (two tabs / a fast reload / two instances).
    const [a, b] = await Promise.all([
      api<{ seeded: boolean }>('/v1/host/openwop-app/example-data/seed', { method: 'POST', body: '{}' }),
      api<{ seeded: boolean }>('/v1/host/openwop-app/example-data/seed', { method: 'POST', body: '{}' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Exactly one claimant seeded; the loser created nothing.
    expect([a.body.seeded, b.body.seeded].filter(Boolean).length).toBe(1);

    const personas = (await roster()).map((r) => r.persona.toLowerCase());
    // No persona appears twice — the race can't double-insert.
    expect(personas.length).toBe(new Set(personas).size);
    expect(personas.length).toBe(10); // 8 twins + Executive Ops + Chief of Staff (ADR 0032)
  });

  it('DELETE /roster/:id cascades the board, schedules, org-chart membership, and chat agent', async () => {
    const idris = (await roster()).find((r) => r.persona === 'Idris')!;
    expect(idris).toBeTruthy();

    // Preconditions: a bound board, ≥1 schedule job, an org-chart seat, a chat agent.
    expect((await listBoards(TENANT)).some((bd) => bd.rosterId === idris.rosterId)).toBe(true);
    expect((await listJobsByRoster(TENANT, idris.rosterId)).length).toBeGreaterThan(0);
    expect((await getChart(TENANT))!.members.some((m) => m.rosterId === idris.rosterId)).toBe(true);
    expect((await hostExtStorage().listUserAgents(TENANT)).some((ua) => ua.agentId === idris.agentRef.agentId)).toBe(true);

    const del = await api(`/v1/host/openwop-app/roster/${idris.rosterId}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    // Everything the member owned is gone — nothing orphaned on its rosterId.
    expect((await listBoards(TENANT)).some((bd) => bd.rosterId === idris.rosterId)).toBe(false);
    expect((await listJobsByRoster(TENANT, idris.rosterId)).length).toBe(0);
    expect((await getChart(TENANT))!.members.some((m) => m.rosterId === idris.rosterId)).toBe(false);
    expect((await hostExtStorage().listUserAgents(TENANT)).some((ua) => ua.agentId === idris.agentRef.agentId)).toBe(false);
    expect((await roster()).some((r) => r.persona === 'Idris')).toBe(false);
  });

  it('silent reseed does NOT resurrect the deleted agent; heal restores it', async () => {
    // Plain auto-seed on a known tenant respects the deletion.
    await api('/v1/host/openwop-app/example-data/seed', { method: 'POST', body: '{}' });
    expect((await roster()).some((r) => r.persona === 'Idris')).toBe(false);
    expect((await roster()).length).toBe(9);

    // Explicit "Load demo data" puts it back.
    const heal = await api('/v1/host/openwop-app/example-data/seed', { method: 'POST', body: JSON.stringify({ heal: true }) });
    expect(heal.status).toBe(200);
    const after = await roster();
    expect(after.some((r) => r.persona === 'Idris')).toBe(true);
    expect(after.length).toBe(10);
    // Restored Idris has a fresh board + schedules (cascade earlier removed the old ones).
    const idris = after.find((r) => r.persona === 'Idris')!;
    expect((await listBoards(TENANT)).some((bd) => bd.rosterId === idris.rosterId)).toBe(true);
  });
});
