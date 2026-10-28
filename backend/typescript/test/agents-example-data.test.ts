/**
 * Agents-demo experience — backend foundations (PRD Phase 0).
 *
 * Covers the new host-extension surfaces that back the "AI coworkers" UX:
 *   - POST /host/openwop-app/example-data/seed seeds the registered demo domains
 *     idempotently (no-op on re-run; never clobbers an existing roster)
 *   - seeded boards carry source-tagged cards; the To Do column triggers the
 *     agent's first portfolio workflow
 *   - POST /host/openwop-app/roster/:id/check (heartbeat) claims the first To Do
 *     card, starts a run, and moves the card to Working
 *   - scheduler jobs are durable + tenant-scoped + roster-filterable, and a
 *     :trigger on a workflow-bearing job starts a real run
 *   - PATCH /host/openwop-app/agents/:id edits a user-authored agent's instructions
 *
 * Order-independent: the first seed runs in `beforeAll` (its response is asserted
 * in case 1, never in the hook), the cold-registry case re-hydrates what it
 * drops, and the heal case never picks the board the heartbeat case uses.
 *
 * TST-BNA-1. Red when: `OPENWOP_DEMO_SEED_ENABLED=false` stops skipping, heal no
 * longer restores a missing board or a deleted schedule (deleted in the MINTED
 * `<tenant>:<rosterId>:<slug>` id shape), or a persona PATCH is accepted.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { __setMockArchiveGuardForTest } from '../src/host/heartbeatService.js';
import { toWireRunId } from '../src/host/v2Ids.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
/** The FIRST seed's response, taken in beforeAll and asserted in case 1. */
let firstSeed: { status: number; body: { seeded: boolean; agents: number; domains: string[] } };
const SEED_DOMAINS = ['user-agents', 'roster', 'workflows', 'boards', 'cards', 'schedules', 'org-chart'];

beforeAll(async () => {
  // ADR 0963 D8 — the seeded twins are all mock archive; this file tests the
  // loop's mechanics over them, so the archive guard is off here (and pinned elsewhere).
  __setMockArchiveGuardForTest(false);
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  // Every case below reads the seeded tenant; seeding here (not in case 1)
  // keeps the file order-independent. No assertions in the hook.
  firstSeed = await api('/host/openwop-app/example-data/seed', { method: 'POST', body: '{}' });
});

afterAll(async () => {
  __setMockArchiveGuardForTest(true);
  await new Promise<void>((res) => server.close(() => res()));
});

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'OpenWOP-Version': '2',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: (text.length ? JSON.parse(text) : null) as T };
}

interface RosterEntry {
  rosterId: string;
  persona: string;
  workflows: string[];
  autonomyLevel?: 'auto' | 'guided' | 'review';
  roleKey?: string;
}

describe('agents-demo backend foundations', () => {
  it('seeds the 10 canonical work-twins (incl. the Chief of Staff) and is idempotent', async () => {
    const first = firstSeed;
    expect(first.status).toBe(200);
    expect(first.body.seeded).toBe(true);
    expect(first.body.agents).toBe(10); // 8 twins + Iris + Executive Operations (ADR 0032)
    expect(first.body.domains).toEqual(SEED_DOMAINS);

    const roster = await api<{ roster: RosterEntry[] }>('/host/openwop-app/roster');
    expect(roster.body.roster.length).toBe(10);
    expect(roster.body.roster.map((r) => r.persona)).toContain('Ava'); // Sales Execution Twin

    // Seedable autonomy (white-label): a `recommend` twin ships in `review` (so
    // the approval flow is demoable out of the box); an `execute-with-approval`
    // twin ships `guided` (routine picks run, high-stakes propose).
    const sales = roster.body.roster.find((r) => r.roleKey === 'sales-execution')!;
    expect(sales.autonomyLevel).toBe('review');
    const it = roster.body.roster.find((r) => r.roleKey === 'it-service-desk')!;
    expect(it.autonomyLevel).toBe('guided');
    // The Chief of Staff (Iris) is seeded review-mode + carries its roleKey
    // (the persisted role identity the assistant + theming key off).
    const iris = roster.body.roster.find((r) => r.persona === 'Iris')!;
    expect(iris.autonomyLevel).toBe('review');
    expect(iris.roleKey).toBe('chief-of-staff');

    // Re-seed is a no-op (does not clobber the existing roster).
    const second = await api<{ seeded: boolean; domains: string[] }>('/host/openwop-app/example-data/seed', { method: 'POST', body: '{}' });
    expect(second.body.seeded).toBe(false);
    expect(second.body.domains).toEqual(SEED_DOMAINS);
    const rosterAgain = await api<{ roster: RosterEntry[] }>('/host/openwop-app/roster');
    expect(rosterAgain.body.roster.length).toBe(10);
  });

  it('registers each seeded persona as a chat-callable inventory agent (so @Idris works in chat)', async () => {
    // The chat `@`-mention list is fed by GET /agents (RFC 0072); before this
    // wiring the personas existed ONLY as roster entries (a synthetic
    // attribution-only agentRef) and were unreachable from chat. The seed now
    // registers each as a tenant-owned user-agent with the persona's authored
    // systemPrompt, so it surfaces in the inventory and the chat-responder can
    // resolve inputs.agentId → systemPrompt (gated by ownerTenant).
    const inv = await api<{ agents: Array<{ agentId: string; persona: string; modelClass: string; packName: string }> }>(
      '/agents',
    );
    expect(inv.status).toBe(200);
    const personas = inv.body.agents.map((a) => a.persona);
    for (const name of ['Ava', 'Felix', 'Cleo', 'Idris', 'Mira', 'Ren', 'Pax', 'Quill', 'Iris']) {
      expect(personas).toContain(name);
    }
    // The roster↔inventory link: the persona's inventory agentId is the
    // deterministic, persona-scoped `user.<slug>` the roster entry's agentRef
    // points at (ADR 0379 P2 — the tenant lives in the row, not the id).
    const idris = inv.body.agents.find((a) => a.persona === 'Idris')!;
    expect(idris.agentId).toBe('user.idris');
    expect(idris.modelClass).toBe('chat');
    expect(idris.packName).toBe('user:default'); // tenant-scoped provenance (ownerTenant)
  });

  it('seeded board has source-tagged cards under a triggering To Do column', async () => {
    const roster = await api<{ roster: RosterEntry[] }>('/host/openwop-app/roster');
    const idris = roster.body.roster.find((r) => r.roleKey === 'it-service-desk')!;
    // Work-twin portfolios bind the pinned template pack (ADR 0032 Phase 2.0).
    expect(idris.workflows[0]).toBe('tmpl.it.incident-triage');

    const boards = await api<{ boards: Array<{ id: string; rosterId?: string; columns: Array<{ id: string; triggerWorkflowId?: string }> }> }>(
      '/host/openwop-app/kanban/boards',
    );
    const board = boards.body.boards.find((b) => b.rosterId === idris.rosterId)!;
    expect(board).toBeTruthy();
    const todo = board.columns.find((c) => c.id === 'todo')!;
    expect(todo.triggerWorkflowId).toBe('tmpl.it.incident-triage');

    const detail = await api<{ cards: Array<{ source?: string; sourceLabel?: string; columnId: string }> }>(
      `/host/openwop-app/kanban/boards/${board.id}`,
    );
    expect(detail.body.cards.length).toBeGreaterThan(0);
    expect(detail.body.cards.some((c) => c.source === 'schedule')).toBe(true);

    // ?include=cards returns every board WITH its cards in one request (the
    // dashboard batch path — no N+1 getBoard).
    const batched = await api<{ boards: Array<{ id: string; rosterId?: string; cards: Array<{ source?: string }> }> }>(
      '/host/openwop-app/kanban/boards?include=cards',
    );
    expect(batched.status).toBe(200);
    const idrisBoard = batched.body.boards.find((b) => b.rosterId === idris.rosterId)!;
    expect(Array.isArray(idrisBoard.cards)).toBe(true);
    expect(idrisBoard.cards.length).toBeGreaterThan(0);
  });

  // ADR 0963 D8 — with the guard ON (production), a seeded twin's Check now takes
  // nothing: every card it has names a Work-Twin mock archive (ADR 0939).
  it('with the archive guard on, a seeded twin picks nothing and says why', async () => {
    __setMockArchiveGuardForTest(true);
    try {
      const roster = await api<{ roster: RosterEntry[] }>('/host/openwop-app/roster');
      const idris = roster.body.roster.find((r) => r.roleKey === 'it-service-desk')!;
      const checked = await api<{ picked: boolean; reason?: string }>(`/host/openwop-app/roster/${idris.rosterId}/check`, { method: 'POST', body: '{}' });
      expect(checked.body).toMatchObject({ picked: false, reason: 'mock_archive' });
    } finally {
      __setMockArchiveGuardForTest(false);
    }
  });

  it('heartbeat check claims a To Do card, starts a run, and moves it to Working', async () => {
    const roster = await api<{ roster: RosterEntry[] }>('/host/openwop-app/roster');
    // Idris (IT Service Desk) is `guided`, and its first To Do card is routine
    // (normal priority), so the heartbeat RUNS it rather than proposing — the
    // demoable autonomous path. Its trigger workflow is a draft-only template
    // (no approval gate) so the run reaches `completed`.
    const idris = roster.body.roster.find((r) => r.roleKey === 'it-service-desk')!;

    const checked = await api<{ picked: boolean; cardId: string; runId: string; lastHeartbeatAt?: string }>(
      `/host/openwop-app/roster/${idris.rosterId}/check`,
      { method: 'POST', body: '{}' },
    );
    expect(checked.status).toBe(200);
    expect(checked.body.picked).toBe(true);
    expect(typeof checked.body.runId).toBe('string');
    // The heartbeat stamps "last checked" on the entry + returns it.
    expect(typeof checked.body.lastHeartbeatAt).toBe('string');
    const afterCheck = await api<RosterEntry & { lastHeartbeatAt?: string }>(`/host/openwop-app/roster/${idris.rosterId}`);
    expect(afterCheck.status).toBe(200);
    expect(afterCheck.body.lastHeartbeatAt).toBe(checked.body.lastHeartbeatAt);

    // The run exists AND runs to completion — the bound template workflow
    // (tmpl.it.incident-triage → mock-ai draft steps) must execute to a terminal
    // `completed` state, not just be created. Dispatch is async (setImmediate),
    // so poll until terminal.
    // The heartbeat answers the bare run id; a major-2 run read takes it bound (`dev-token` acts in `default`).
    const runPath = `/runs/${encodeURIComponent(toWireRunId(checked.body.runId, 'default'))}`;
    const status = await vi.waitFor(async () => {
      const run = await api<{ status: string }>(runPath);
      expect(run.status).toBe(200);
      expect(['completed', 'failed']).toContain(run.body.status);
      return run.body.status;
    }, { timeout: 10_000, interval: 20 });
    expect(status).toBe('completed');

    // The card moved out of To Do (into Working).
    const boards = await api<{ boards: Array<{ id: string; rosterId?: string }> }>('/host/openwop-app/kanban/boards');
    const board = boards.body.boards.find((b) => b.rosterId === idris.rosterId)!;
    const detail = await api<{ cards: Array<{ id: string; columnId: string }> }>(`/host/openwop-app/kanban/boards/${board.id}`);
    const movedCard = detail.body.cards.find((c) => c.id === checked.body.cardId)!;
    expect(movedCard.columnId).toBe('working');

    // The activity feed surfaces that run with its outcome, a timestamp, and
    // the enriched provenance fields (createdAt / completedAt / durationMs).
    const activity = await api<{
      items: Array<{
        runId: string; status: string; source: string; timestamp: string;
        createdAt?: string; completedAt?: string; durationMs?: number; causationId?: string;
      }>;
    }>(`/host/openwop-app/roster/${idris.rosterId}/activity`);
    expect(activity.status).toBe(200);
    const entry = activity.body.items.find((i) => i.runId === checked.body.runId)!;
    expect(entry).toBeTruthy();
    expect(entry.source).toBe('heartbeat');
    expect(entry.status).toBe('completed');
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
    // A completed run carries both bookends and a non-negative duration.
    expect(typeof entry.createdAt).toBe('string');
    expect(typeof entry.completedAt).toBe('string');
    expect(typeof entry.durationMs).toBe('number');
    expect(entry.durationMs!).toBeGreaterThanOrEqual(0);
  });

  it('scheduler jobs are durable + roster-filterable, and :trigger starts a run', async () => {
    const roster = await api<{ roster: RosterEntry[] }>('/host/openwop-app/roster');
    const idris = roster.body.roster.find((r) => r.roleKey === 'it-service-desk')!;

    // The seed registered Idris's schedules; filter by roster.
    const byRoster = await api<{ jobs: Array<{ jobId: string; rosterId?: string; workflowId?: string }> }>(
      `/host/openwop-app/scheduler/jobs?rosterId=${encodeURIComponent(idris.rosterId)}`,
    );
    expect(byRoster.body.jobs.length).toBeGreaterThan(0);
    expect(byRoster.body.jobs.every((j) => j.rosterId === idris.rosterId)).toBe(true);

    const job = byRoster.body.jobs.find((j) => j.workflowId)!;
    const fired = await api<{ runsFired: number; runId?: string }>(
      `/host/openwop-app/scheduler/jobs/${encodeURIComponent(job.jobId)}/trigger`,
      { method: 'POST', body: '{}' },
    );
    expect(fired.status).toBe(200);
    expect(fired.body.runsFired).toBe(1);
    expect(typeof fired.body.runId).toBe('string');
  });

  it('PATCH edits a user-authored agent’s instructions', async () => {
    const created = await api<{ agentId: string; systemPrompt?: string }>('/host/openwop-app/agents', {
      method: 'POST',
      body: JSON.stringify({ persona: 'Edith', modelClass: 'chat', systemPrompt: 'You are Edith. Original.' }),
    });
    expect(created.status).toBe(201);

    const patched = await api<{ systemPrompt: string }>(`/host/openwop-app/agents/${created.body.agentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ systemPrompt: 'You are Edith. Updated instructions.' }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.systemPrompt).toBe('You are Edith. Updated instructions.');

    // persona is immutable.
    const rejected = await api<{ error: string; message: string }>(`/host/openwop-app/agents/${created.body.agentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ persona: 'Renamed' }),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe('validation_error');
    expect(rejected.body.message).toContain('`persona` is immutable');
    const after = await api<{ persona: string; systemPrompt?: string }>(`/host/openwop-app/agents/${created.body.agentId}`);
    expect(after.status).toBe(200);
    expect(after.body.persona).toBe('Edith');
  });

  it('skips demo seeding entirely when OPENWOP_DEMO_SEED_ENABLED=false (white-label)', async () => {
    // The toggle is read per-call, so a branded deployment can ship a clean
    // tenant with no demo personas. Early-return shape is `agents: 0`, distinct
    // from the idempotent no-op (`seeded:false, agents:10`).
    process.env.OPENWOP_DEMO_SEED_ENABLED = 'false';
    try {
      const res = await api<{ seeded: boolean; agents: number }>('/host/openwop-app/example-data/seed', {
        method: 'POST',
        body: '{}',
      });
      expect(res.status).toBe(200);
      expect(res.body.seeded).toBe(false);
      expect(res.body.agents).toBe(0);
    } finally {
      delete process.env.OPENWOP_DEMO_SEED_ENABLED;
    }
  });

  it('resolve() reads a seeded agent through from durable storage on a cold registry (multi-instance)', async () => {
    // The registry is boot-hydrated, NOT read-through. Simulate an instance that
    // booted before the seed: drop the in-process map, leaving the durable
    // user-agent rows (written by the seed in the first test) intact. Runs last;
    // vitest isolates module state per file, so this reset can't leak into other
    // suites.
    // Every user agent the tenant can see now, so the `finally` can put the
    // registry back exactly (other cases read it; shuffle may run them after).
    const inv = await api<{ agents: Array<{ agentId: string; packName: string }> }>('/agents');
    const userAgentIds = inv.body.agents.filter((a) => a.packName === 'user:default').map((a) => a.agentId);
    try {
      getAgentRegistry()._resetForTest();
      expect(getAgentRegistry().get('user.idris', 'default')).toBeNull(); // cold: not in-process

      // resolve() falls through to the agent-pack resolver, which now hydrates a
      // user/seeded agent from storage on a miss — so the chat-responder dispatch
      // and the by-id inventory routes route correctly on any instance.
      // ADR 0379 P2 — user agents live under the (tenant, agentId) registry key,
      // so the read-through carries the tenant (as every production caller does).
      const hydrated = await getAgentRegistry().resolve('user.idris', 'default');
      expect(hydrated?.persona).toBe('Idris');
      expect(hydrated?.ownerTenant).toBe('default'); // tenant-scoping preserved
      // Now cached in-process (last-write-wins register).
      expect(getAgentRegistry().get('user.idris', 'default')?.persona).toBe('Idris');
      // A tenant-less lookup deliberately sees pack agents only.
      expect(getAgentRegistry().get('user.idris')).toBeNull();
    } finally {
      // Re-hydrate what the reset dropped (pack agents re-resolve on demand).
      for (const id of userAgentIds) await getAgentRegistry().resolve(id, 'default');
    }
  });
});

describe('demo seed heal mode — restores missing surfaces (live bug 2026-06-04)', () => {
  // Reproduces the production failure: a tenant whose roster entries survived
  // but whose BOARD rows were lost (rows predating the read-through-durability
  // hardening). The old create-only seed skipped existing personas entirely,
  // so "Load demo data" could never bring the boards back.
  it('plain re-seed does NOT resurrect a deleted board; heal:true restores it with cards', async () => {
    const { listBoardsWithCards, deleteBoard } = await import('../src/host/kanbanService.js');
    const { deleteJob, getJob, listJobsByRoster } = await import('../src/host/schedulingService.js');
    const { listRoster } = await import('../src/host/rosterService.js');

    // Baseline from the beforeAll seed: every agent has a board. Never pick the
    // IT Service Desk (Idris) board — the heartbeat case claims its card.
    const idrisId = (await listRoster('default')).find((r) => r.roleKey === 'it-service-desk')?.rosterId;
    const before = await listBoardsWithCards('default');
    const victim = before.find((b) => b.rosterId && b.rosterId !== idrisId);
    expect(victim, 'a seeded board other than Idris\'s').toBeDefined();
    const victimRoster = victim!.rosterId!;
    expect(await deleteBoard(victim!.id)).toBe(true);
    // Also lose one schedule job for the same member, in the id shape the seed MINTS.
    const jobs = await listJobsByRoster('default', victimRoster);
    const lost = jobs.find((j) => j.jobId.startsWith(`default:${victimRoster}:`));
    expect(lost, 'positive control: the member has a minted schedule to lose').toBeDefined();
    expect(await deleteJob(lost!.jobId)).toBe(true);
    expect(await getJob(lost!.jobId)).toBeNull();
    const lostJobIds = [lost!.jobId];

    // Silent auto-seed shape (no heal): the board MUST stay gone — the auto
    // path must never resurrect a deliberate deletion.
    const plain = await api<{ seeded: boolean; healed?: unknown }>('/host/openwop-app/example-data/seed', { method: 'POST', body: '{}' });
    expect(plain.status).toBe(200);
    expect(plain.body.healed).toBeUndefined();
    expect((await listBoardsWithCards('default')).some((b) => b.rosterId === victimRoster)).toBe(false);
    expect(await getJob(lost!.jobId)).toBeNull();

    // Explicit heal: the board comes back, WITH its sample cards.
    const heal = await api<{ seeded: boolean; healed: { boards: number; schedules: number; profiles: number; prunedLegacy: number; orgChart: boolean } }>(
      '/host/openwop-app/example-data/seed',
      { method: 'POST', body: JSON.stringify({ heal: true }) },
    );
    expect(heal.status).toBe(200);
    expect(heal.body.healed.boards).toBe(1);
    expect(heal.body.healed.schedules).toBe(1);
    expect(heal.body.healed.prunedLegacy).toBe(0); // no legacy personas on a freshly-seeded tenant
    const after = (await listBoardsWithCards('default')).find((b) => b.rosterId === victimRoster);
    expect(after).toBeDefined();
    expect(after!.cards.length).toBeGreaterThan(0);
    for (const id of lostJobIds) expect(await getJob(id)).not.toBeNull();

    // Heal is idempotent: a second heal finds nothing missing.
    const again = await api<{ healed: { boards: number; schedules: number; profiles: number; prunedLegacy: number; orgChart: boolean } }>(
      '/host/openwop-app/example-data/seed',
      { method: 'POST', body: JSON.stringify({ heal: true }) },
    );
    expect(again.body.healed).toEqual({ boards: 0, schedules: 0, profiles: 0, prunedLegacy: 0, orgChart: false });
  });
});
