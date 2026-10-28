/**
 * End-to-end smoke for the agent-autonomy stack — boots the REAL app
 * (createApp + sqlite memory + real route registration + schema migrations) and
 * drives the actual daemon functions against the app's own storage/hostSuite.
 *
 * This is the wiring proof the unit tests can't give: routes registered,
 * migrations applied (incl. agent_run_activity + run_budget), the attribution
 * index populated by real run creation, the autonomous daemons firing real runs
 * through the real workflow catalog, and the fleet activity feed reading them
 * back via the index.
 *
 *   1. seed demo agents → roster + boards + cards + schedules exist
 *   2. autonomous heartbeat → an agent picks a To Do card and starts a real run
 *   3. fleet activity (index-backed) shows the heartbeat run attributed
 *   4. scheduler daemon → a due schedule fires a real run
 *   5. connector deliverability probe reflects a live relay device
 *   6. /notify returns an honest synthetic receipt (no webhook configured)
 *
 * (The live-dispatch model turn once smoked here is carried by
 * `agent-dispatch-live-real.test.ts` › "completes a real structured-output turn",
 * the same createAiProvidersAdapter → mock-provider pipeline — cut w65.)
 *
 * ADR 0032 twins + RFC 0086 attribution. Tracker TST-BKW-6. Red when the
 * heartbeat or schedule attribution key is dropped from the activity
 * projection, the connector probe calls a device-less connector deliverable, or
 * the synthetic notifier claims `delivered` — each sabotage-witnessed (w65).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { __setMockArchiveGuardForTest, processDueHeartbeats } from '../src/host/heartbeatService.js';
import { processDueSchedules } from '../src/host/scheduleDaemon.js';
import { updateRosterEntry, listRosterTenants, listRoster } from '../src/host/rosterService.js';
import { registerJob } from '../src/host/schedulingService.js';

const OP: Record<string, string> = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: http.Server;
let base = '';
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => {
  // ADR 0963 D8 — the seeded twins are all mock archive; see approvals.test.ts.
  __setMockArchiveGuardForTest(false);
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'smoke', serviceVersion: '0', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
afterEach(async () => { __setMockArchiveGuardForTest(true); await new Promise<void>((r) => server.close(() => r())); });

async function post<T>(path: string, body?: unknown, headers: Record<string, string> = OP): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}
async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, { headers: OP });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}
interface FleetFeed { items: Array<{ source: string; rosterId?: string; runId: string }>; truncated: boolean }
interface ConnectorProbe { ok: boolean; liveRelayDevices: number }

function deps(): { storage: Storage; hostSuite: HostAdapterSuite } {
  return { storage: app.locals.storage as Storage, hostSuite: app.locals.hostSuite as HostAdapterSuite };
}

describe('agent autonomy — end-to-end smoke', () => {
  it('seeds, auto-heartbeats a real run, and shows it in the index-backed fleet feed', async () => {
    // 1. Seed demo agents (roster + boards + To Do cards + schedules).
    expect((await post('/host/openwop-app/example-data/seed', {})).status).toBe(200);
    const roster = await listRoster('default');
    expect(roster.length).toBeGreaterThan(0);

    // 2. Opt a `guided` twin whose first To Do card is routine (IT Service Desk
    //    — Idris) into an autonomous heartbeat cadence, then run the real
    //    heartbeat daemon pass. Guided + a routine (non-high) pick RUNS the
    //    workflow (unlike a `review` twin, which would only queue a proposal),
    //    so the daemon starts a real heartbeat-sourced run. (ADR 0032's canonical
    //    set has no default-`auto` twin; guided-routine is the autonomous path.)
    const agent = roster.find((r) => r.roleKey === 'it-service-desk')!;
    await updateRosterEntry(agent.tenantId, agent.rosterId, { heartbeatIntervalMs: 60_000 });
    const now = Date.now();
    const ran = await processDueHeartbeats(deps(), listRosterTenants, now);
    expect(ran).toBeGreaterThanOrEqual(1); // picked a To Do card → started a real run

    // 3. The fleet activity feed (index-backed, not a scan) shows it, attributed.
    const fleet = (await get<FleetFeed>('/host/openwop-app/fleet/activity')).body;
    expect(fleet.truncated).toBe(false);
    expect(fleet.items.length).toBeGreaterThanOrEqual(1);
    const hb = fleet.items.find((i) => i.source === 'heartbeat');
    expect(hb).toBeTruthy();
    expect(hb?.rosterId).toBeTruthy();
    expect(hb?.runId).toBeTruthy();
  });

  it('fires a due schedule through the real daemon', async () => {
    await post('/host/openwop-app/example-data/seed', {});
    const agentEntry = (await listRoster('default'))[0]!;
    const workflowId = agentEntry.workflows[0]!;
    expect(workflowId).toBeTruthy();

    // Register a schedule, then drive the daemon with a clock 2h ahead so the
    // job's nextFireAt is due.
    const t0 = Date.parse('2026-06-02T10:00:00Z');
    await registerJob({ jobId: 'smoke-job', tenantId: 'default', cronExpr: '0 * * * *', workflowId, rosterId: agentEntry.rosterId, agentId: agentEntry.agentRef.agentId, timezone: 'UTC' }, t0);
    const fired = await processDueSchedules(deps(), t0 + 2 * 3_600_000);
    expect(fired).toBeGreaterThanOrEqual(1);

    // The schedule run is attributed in the fleet feed.
    const fleet = (await get<FleetFeed>('/host/openwop-app/fleet/activity?rosterId=' + encodeURIComponent(agentEntry.rosterId))).body;
    expect(fleet.items.some((i) => i.source === 'schedule')).toBe(true);
  });

  it('connector deliverability probe reflects a live relay device', async () => {
    const made = (await post<{ connectorId: string }>('/host/openwop-app/messaging/connectors', { channel: 'signal', displayName: 'Signal' })).body;
    await post(`/host/openwop-app/messaging/connectors/${made.connectorId}/enable`, {});
    // No device yet → not deliverable.
    expect((await post<ConnectorProbe>(`/host/openwop-app/messaging/connectors/${made.connectorId}/test`, {})).body.ok).toBe(false);

    // Register + activate + heartbeat a signal relay device → deliverable.
    const reg = (await post<{ relayId: string; activationCode: string }>('/host/openwop-app/messaging/relay/register', { channel: 'signal' })).body;
    const act = (await post<{ deviceToken: string }>('/host/openwop-app/messaging/relay/activate', { relayId: reg.relayId, activationCode: reg.activationCode })).body;
    await post('/host/openwop-app/messaging/device/heartbeat', { status: 'connected' }, { 'x-openwop-device-token': act.deviceToken, 'content-type': 'application/json' });
    const probe = (await post<ConnectorProbe>(`/host/openwop-app/messaging/connectors/${made.connectorId}/test`, {})).body;
    expect(probe.ok).toBe(true);
    expect(probe.liveRelayDevices).toBeGreaterThanOrEqual(1);
  });

  it('/notify returns an honest synthetic receipt with no webhook configured', async () => {
    const r = (await post<{ status: string; detail: string }>('/host/openwop-app/messaging/notify', { kind: 'email', to: 'a@b.com', text: 'hi' })).body;
    expect(r.status).toBe('accepted'); // not 'delivered'
    expect(r.detail).toContain('no provider configured');
  });
});
