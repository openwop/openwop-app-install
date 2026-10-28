/**
 * ADR 0954 P3 — real HTTP admission and chain/timer/fork integration.
 * Deadlines come from the recorded assignment; owner activity or a booking
 * stops the clock, while another person's activity does not. Exercises
 * concurrent rungs, client scope and a reroute whose committed child loses its
 * acknowledgement before a newer manual routing round. Durable inbox failure,
 * erasure and restart interleavings live in adr0954-sla-delivery-cas.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { sweepDueTimers } from '../src/executor/timerResume.js';
import { timerResumeContinuation } from '../src/routes/interrupts.js';
import { sweepDispatchOutbox } from '../src/host/runDispatchSweeper.js';
import { DISPATCH_OUTBOX_HINT_GRACE_MS } from '../src/host/runInsert.js';
import { getNotificationEmitter } from '../src/notifications/emitter.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { createActivity, makeLinkValidators } from '../src/features/crm/crmEntitiesService.js';
import { claimBooking, bookingIdFor } from '../src/features/crm/entities/bookings.js';
import { bindLead } from '../src/features/crm/leadIntel/leadStore.js';
import { saveRoutingPolicy } from '../src/features/crm/leadIntel/routingPolicy.js';
import { getRoutingDecision } from '../src/features/crm/leadIntel/routing.js';
import { activateModel, saveModelVersion } from '../src/features/crm/leadIntel/modelStore.js';
import { checkFirstTouch, clockContinues, fireSlaRung, getSlaRung, saveSlaSettings } from '../src/features/crm/leadIntel/speedToLead.js';
import { LEAD_INTEL_TOGGLE } from '../src/features/crm/leadIntel/constants.js';
import type { InterruptRecord } from '../src/types.js';
import { toWireRunId, fromWireRunId } from '../src/host/v2Ids.js';
import { addBusinessMinutes, slaDeadline } from '../../../packs/feature.crm.nodes/index.mjs';

// A test chains several waits (routing, timer, recovery), so its budget must
// cover more than one deadline.
vi.setConfig({ testTimeout: 60_000 });

let BASE: string;
let server: http.Server;
let TENANT: string;
let orgA: string;
let orgB: string;
let admin: string;
let o1: string; let o2: string; let other: string; let onlyB: string;
const cookies: Record<string, string> = {};
let policyV = 0;

const cookieFor = (userId: string, home: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant: home, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
async function call<T = Record<string, unknown>>(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; raw: string }> {
  const res = await fetch(`${BASE}/host/openwop-app/crm/clients${path}`, {
    method, headers: { cookie: cookies[who]!, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}
const toggle = async (id: string): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
};
const newLead = async (orgId: string, name: string): Promise<string> => {
  const c = await createContact({ tenantId: TENANT, name, email: `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@example.test`, stage: 'lead' });
  await bindLead({ tenantId: TENANT, orgId, contactId: c.contactId, source: 'form', boundBy: admin });
  return c.contactId;
};
/** Every SLA source is an actual admitted routing run with frozen metadata. */
const routed = async (contactId: string, _label: string): Promise<{ epoch: number; chosen: string | null; runId: string }> => {
  const started = await call<{ runId: string; routingEpoch: number }>('admin', 'POST', `/${orgA}/leads/${contactId}/route`);
  expect(started.status, started.raw).toBe(202);
  const { runId, routingEpoch: epoch } = started.body;
  const decision = await until(() => getRoutingDecision(TENANT, orgA, contactId, epoch), `assignment on ${runId}`);
  await openTimer(runId);
  return { epoch, chosen: decision.chosen, runId };
};
const slaNotices: Array<{ to: string; rung: number; contactId: string }> = [];
// A wall-clock deadline, not a count of polls: under a loaded gate (load 14) a
// child run's admission took longer than 200 × 25 ms, so a fixed count read as
// a red with nothing broken. Each wait still names what it was waiting for.
const UNTIL_DEADLINE_MS = 20_000;
async function until<T>(read: () => Promise<T | null | undefined | false>, what: string): Promise<T> {
  const deadline = Date.now() + UNTIL_DEADLINE_MS;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const openTimer = (runId: string): Promise<InterruptRecord> => until(async () => {
  const run = await hostExtStorage().getRun(runId);
  if (run && ['failed', 'cancelled', 'completed'].includes(run.status)) throw new Error(`run ended before its timer: ${JSON.stringify({ status: run.status, error: run.error, events: (await hostExtStorage().listEvents(runId)).filter((event) => event.type === 'node.failed') })}`);
  return (await hostExtStorage().listOpenInterrupts(runId)).find((i) => i.kind === 'timer');
}, `a timer on ${runId}`);

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await toggle('crm'); await toggle(LEAD_INTEL_TOGGLE);
  TENANT = (await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:sl-owner' })).tenantId;
  const mk = async (p: string): Promise<string> => (await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:sl-${p}`, source: 'oidc' })).userId;
  admin = await mk('admin'); o1 = await mk('o1'); o2 = await mk('o2'); other = await mk('other'); onlyB = await mk('only-b');
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin, displayName: 'Admin', roles: ['admin'] });
  for (const u of [o1, o2, other, onlyB]) await createMember({ tenantId: TENANT, orgId: TENANT, subject: u, displayName: u, roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  for (const u of [o1, o2, other]) await createMember({ tenantId: TENANT, orgId: orgA, subject: u, displayName: u, roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: admin, displayName: 'Admin', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: orgB, subject: onlyB, displayName: 'onlyB', roles: ['editor'] });
  cookies.admin = cookieFor(admin, 'ws:home-admin');
  cookies.onlyB = cookieFor(onlyB, 'ws:home-only-b');
  // Every score-0 lead grades F; F leads must be touched within 30 minutes.
  const m = await saveModelVersion({ tenantId: TENANT, orgId: orgA, modelId: 'fast', expectedVersion: 0, actor: admin, content: {
    signals: [{ signalId: 'funnel.view', weight: 1 }], bands: { A: 100, B: 50, C: 25, D: 10, E: 1 }, criteria: [], sla: { F: { firstTouchMinutes: 30 } },
  } });
  await activateModel({ tenantId: TENANT, orgId: orgA, modelId: 'fast', version: m.version, actor: admin, expected: null });
  await saveRoutingPolicy({ tenantId: TENANT, orgId: orgA, expectedVersion: 0, rules: [{ ruleId: 'to-o1', strategy: 'named', named: o1 }], actor: admin });
  policyV = 1;
  getNotificationEmitter().subscribe((n) => {
    const meta = (n.metadata ?? {}) as { kind?: string; rung?: number; contactId?: string };
    if (meta.kind === 'crm.lead.sla') slaNotices.push({ to: n.recipientUserId!, rung: meta.rung!, contactId: meta.contactId! });
  });
});
afterAll(async () => { vi.restoreAllMocks(); await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0954 D6 — the deadline', () => {
  it('counts only business hours in the client’s zone', () => {
    const week = [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' }));
    // Fri 2026-10-16 16:45 New York (EDT, UTC-4) = 20:45Z; 15 min Friday + 15 min Monday.
    const due = addBusinessMinutes(Date.parse('2026-10-16T20:45:00Z'), 30, 'America/New_York', week);
    expect(new Date(due).toISOString()).toBe('2026-10-19T13:15:00.000Z');
    // Across the DST change (2026-11-01): Fri 10-30 16:50 EDT + 20 ⇒ Mon 11-02 09:10 EST = 14:10Z.
    expect(new Date(addBusinessMinutes(Date.parse('2026-10-30T20:50:00Z'), 20, 'America/New_York', week)).toISOString()).toBe('2026-11-02T14:10:00.000Z');
    // No hours ⇒ the clock runs around the clock.
    expect(addBusinessMinutes(1_000, 30, undefined, undefined)).toBe(1_000 + 30 * 60_000);
  });

  it('is computed only from the recorded decision (the same inputs give the same instants)', async () => {
    const sla = { firstTouchMinutes: 30, assignedAt: '2026-10-20T10:00:00.000Z' };
    const a = await slaDeadline({ inputs: { sla } });
    await new Promise((r) => setTimeout(r, 5));
    const b = await slaDeadline({ inputs: { sla } });
    expect(a).toEqual(b);
    expect(a.outputs).toMatchObject({ hasSla: true, slaDeadline: '2026-10-20T10:30:00.000Z', slaEscalateAt: '2026-10-20T11:00:00.000Z', slaReportAt: '2026-10-20T11:30:00.000Z' });
    expect((await slaDeadline({ inputs: { sla: null } })).outputs).toEqual({ hasSla: false });
  });
});

describe('ADR 0954 D6 — rungs', () => {
  it('each rung records one durable inbox row per round under concurrent executions', async () => {
    await saveSlaSettings(TENANT, orgA, { agencyLead: admin }, admin);
    const contactId = await newLead(orgA, 'Once');
    const { epoch, chosen, runId } = await routed(contactId, 'once');
    expect(chosen).toBe(o1);
    const before = slaNotices.length;
    const [x, y] = await Promise.all([1, 2].map(() => fireSlaRung({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: epoch, rung: 1, runId })));
    expect([x!.fired, y!.fired].sort()).toEqual([false, true]);
    expect(x!.outcome).toBe('reminded-owner');
    const again = await fireSlaRung({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: epoch, rung: 1, runId });
    expect(again).toEqual({ outcome: 'reminded-owner', fired: false });
    expect(slaNotices.slice(before)).toEqual([{ to: o1, rung: 1, contactId }]);
    expect((await fireSlaRung({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: epoch, rung: 3, runId })).outcome).toBe('reported-agency-lead');
  });

  it('an owner activity or a booking stops the clock; another person’s activity does not', async () => {
    const a = await newLead(orgA, 'Touched');
    const ra = await routed(a, 'touch-a');
    await createActivity({ tenantId: TENANT, orgId: orgA, kind: 'note', body: 'Their call', contactId: a, createdBy: other, validators: makeLinkValidators(TENANT, orgA) });
    expect((await checkFirstTouch(TENANT, orgA, a, ra.epoch)).touched).toBe(false);
    await createActivity({ tenantId: TENANT, orgId: orgA, kind: 'call', body: 'Called', contactId: a, createdBy: o1, validators: makeLinkValidators(TENANT, orgA) });
    expect((await checkFirstTouch(TENANT, orgA, a, ra.epoch)).touched).toBe(true);

    const b = await newLead(orgA, 'Booked');
    const rb = await routed(b, 'touch-b');
    const slot = Date.now() + 7 * 86_400_000;
    const now = new Date().toISOString();
    await claimBooking({ bookingId: bookingIdFor('booking-link:sl', slot), tenantId: TENANT, orgId: orgA, bookingLinkId: 'booking-link:sl', slotStartUtcMs: slot, durationMin: 30, status: 'confirmed', inviteeName: 'B', inviteeEmail: 'b@example.test', contactId: b, createdAt: now, updatedAt: now });
    expect((await checkFirstTouch(TENANT, orgA, b, rb.epoch)).touched).toBe(true);
  });

  it('a newer routing round supersedes an old clock', async () => {
    const contactId = await newLead(orgA, 'Superseded');
    const first = await routed(contactId, 'sup-1');
    await routed(contactId, 'sup-2');
    expect((await fireSlaRung({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: first.epoch, rung: 1, runId: first.runId })).outcome).toBe('superseded');
  });

  it('rung 2 re-routes away from the previous owner when the client opted in, as a new round with its own clock', async () => {
    await saveRoutingPolicy({ tenantId: TENANT, orgId: orgA, expectedVersion: policyV, rules: [{ ruleId: 'pool', strategy: 'round-robin', pool: [o1, o2] }], actor: admin });
    policyV += 1;
    await saveSlaSettings(TENANT, orgA, { escalation: 'reroute' }, admin);
    try {
      const contactId = await newLead(orgA, 'Reroute');
      const r = await routed(contactId, 'rr');
      const out = await fireSlaRung({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: r.epoch, rung: 2, runId: r.runId });
      expect(out).toEqual({ outcome: 'rerouted', fired: true });
      expect(clockContinues(out.outcome)).toBe(false);
      // The new round is its own crm-ops.route-lead run: graded, routed away from
      // the owner who missed the target, and on its own clock.
      const next = await until(() => getRoutingDecision(TENANT, orgA, contactId, r.epoch + 1), 'the new round');
      expect(next.chosen).toBeTruthy();
      expect(next.chosen).not.toBe(r.chosen);
      expect(next.skipped).toEqual(expect.arrayContaining([{ subject: r.chosen, reason: 'previous_owner' }]));
      expect(next.sla?.firstTouchMinutes).toBe(30);
      await openTimer(next.runId);
      // Fired again (a dispatch retry): the recorded outcome, no second round.
      expect(await fireSlaRung({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: r.epoch, rung: 2, runId: r.runId })).toEqual({ outcome: 'rerouted', fired: false });
      expect(await getRoutingDecision(TENANT, orgA, contactId, r.epoch + 2)).toBeNull();
    } finally {
      await saveSlaSettings(TENANT, orgA, { escalation: 'escalate' }, admin);
      await saveRoutingPolicy({ tenantId: TENANT, orgId: orgA, expectedVersion: policyV, rules: [{ ruleId: 'to-o1', strategy: 'named', named: o1 }], actor: admin });
      policyV += 1;
    }
  });

  it('settings: a field left out keeps its saved value; null clears it', async () => {
    await saveSlaSettings(TENANT, orgA, { agencyLead: admin }, admin);
    expect((await saveSlaSettings(TENANT, orgA, { escalation: 'escalate' }, admin)).agencyLead).toBe(admin);
    expect((await saveSlaSettings(TENANT, orgA, { agencyLead: null }, admin)).agencyLead).toBeUndefined();
    await saveSlaSettings(TENANT, orgA, { agencyLead: admin }, admin);
  });

  it('recovers its committed reroute after a lost admission acknowledgement and a newer manual round', async () => {
    await saveRoutingPolicy({ tenantId: TENANT, orgId: orgA, expectedVersion: policyV, rules: [{ ruleId: 'recovery-pool', strategy: 'round-robin', pool: [o1, o2] }], actor: admin });
    policyV += 1;
    await saveSlaSettings(TENANT, orgA, { escalation: 'reroute' }, admin);
    const storage = hostExtStorage();
    try {
      const contactId = await newLead(orgA, 'ChildRecovery');
      const source = await routed(contactId, 'source');
      const insert = storage.insertRun.bind(storage); const get = storage.getRun.bind(storage);
      let childId: string | undefined; let uncertain: string | undefined;
      const getFault = vi.spyOn(storage, 'getRun').mockImplementation(async (id) => {
        if (id === uncertain) { uncertain = undefined; throw new Error('child admission unconfirmed'); }
        return get(id);
      });
      const insertFault = vi.spyOn(storage, 'insertRun').mockImplementation(async (run, options) => {
        if (!childId && (run.inputs as { contactId?: unknown } | undefined)?.contactId === contactId) {
          childId = run.runId; await insert(run, options); uncertain = run.runId;
          throw new Error('child admission acknowledgement lost');
        }
        return insert(run, options);
      });
      await expect(fireSlaRung({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: source.epoch, rung: 2, runId: source.runId })).rejects.toThrow();
      insertFault.mockRestore(); getFault.mockRestore(); expect(childId).toEqual(expect.any(String));
      const child = (await storage.getRun(childId!))!;
      expect(child.status).toBe('pending');
      await sweepDispatchOutbox({ storage, hostSuite: createHostAdapterSuite({ storage }) }, 'sla-child-recovery', Date.parse(child.createdAt) + DISPATCH_OUTBOX_HINT_GRACE_MS + 1);
      const decision = await until(() => getRoutingDecision(TENANT, orgA, contactId, source.epoch + 1), 'recovered child assignment');
      expect(decision.runId).toBe(childId); expect(decision.chosen).not.toBe(source.chosen);
      await openTimer(childId!);
      const human = await routed(contactId, 'newer-manual'); expect(human.epoch).toBe(source.epoch + 2);
      expect(await fireSlaRung({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: source.epoch, rung: 2, runId: source.runId })).toEqual({ outcome: 'rerouted', fired: false });
      expect(await getRoutingDecision(TENANT, orgA, contactId, human.epoch + 1)).toBeNull();
      const runs = await storage.listRuns({ tenantId: TENANT, workflowId: 'crm-ops.route-lead' });
      expect(runs.filter((run) => (run.inputs as { contactId?: unknown } | undefined)?.contactId === contactId)).toHaveLength(3);
    } finally {
      vi.restoreAllMocks(); await saveSlaSettings(TENANT, orgA, { escalation: 'escalate' }, admin);
      await saveRoutingPolicy({ tenantId: TENANT, orgId: orgA, expectedVersion: policyV, rules: [{ ruleId: 'to-o1', strategy: 'named', named: o1 }], actor: admin }); policyV += 1;
    }
  });

  it('skips a recipient who cannot read the client', async () => {
    await saveSlaSettings(TENANT, orgA, { agencyLead: onlyB }, admin);
    try {
      const contactId = await newLead(orgA, 'NoAccess');
      const r = await routed(contactId, 'na');
      const before = slaNotices.length;
      expect((await fireSlaRung({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: r.epoch, rung: 3, runId: r.runId })).outcome).toBe('report-unaddressed');
      expect(slaNotices.length).toBe(before);
    } finally {
      await saveSlaSettings(TENANT, orgA, { agencyLead: admin }, admin);
    }
  });
});

describe('ADR 0954 D6 — the chain', () => {
  const storage = (): ReturnType<typeof hostExtStorage> => hostExtStorage();
  const sweep = async (): Promise<void> => {
    await sweepDueTimers(storage(), timerResumeContinuation(storage(), createHostAdapterSuite({ storage: storage() })), Date.now() + 365 * 86_400_000);
  };

  it('a branch fork inherits the recorded deadline; strict replay refuses an unrecorded timer; each rung fires once', async () => {
    const contactId = await newLead(orgA, 'Clock');
    const started = await call<{ runId: string; routingEpoch: number }>('admin', 'POST', `/${orgA}/leads/${contactId}/route`);
    expect(started.status, started.raw).toBe(202);
    const { runId, routingEpoch } = started.body;
    const t1 = await openTimer(runId);
    const decision = (await getRoutingDecision(TENANT, orgA, contactId, routingEpoch))!;
    expect(decision.sla).toMatchObject({ firstTouchMinutes: 30, assignedAt: decision.decidedAt });
    const due = new Date(Date.parse(decision.decidedAt) + 30 * 60_000).toISOString();
    expect((t1.data as { timestamp?: string }).timestamp).toBe(due);

    const forkAt = async (mode: 'replay' | 'branch', fromSeq: number): Promise<Response> => fetch(`${BASE}/runs/${encodeURIComponent(toWireRunId(runId, TENANT))}:fork`, { method: 'POST', headers: { cookie: cookies.admin!, 'content-type': 'application/json', 'OpenWOP-Version': '2' }, body: JSON.stringify({ mode, fromSeq }) });
    // An unresolved timer has no completed side-effect outcome to replay.
    const replay = await forkAt('replay', 0); const replayBody = await replay.text(); expect(replay.status, replayBody).toBe(201);
    const replayDecoded = fromWireRunId((JSON.parse(replayBody) as { runId: string }).runId, TENANT);
    if (!replayDecoded.ok) throw new Error('Replay returned a foreign run id');
    const refused = await until(async () => { const r = await storage().getRun(replayDecoded.runId); return r?.status === 'failed' ? r : null; }, 'strict replay refusal');
    expect(refused.error?.code).toBe('replay_source_missing'); expect(await storage().listOpenInterrupts(replayDecoded.runId)).toHaveLength(0);
    // A new branch inherits the prefix through the computed deadline, then
    // creates its own future timer at exactly that recorded instant.
    const deadlineEvent = (await storage().listEvents(runId)).find((event) => event.type === 'node.completed' && event.nodeId?.endsWith('_deadline'));
    if (!deadlineEvent) throw new Error('The source must have recorded its deadline');
    const fork = await forkAt('branch', deadlineEvent.sequence + 1);
    const forkBody = await fork.text(); expect(fork.status, forkBody).toBe(201);
    const decoded = fromWireRunId((JSON.parse(forkBody) as { runId: string }).runId, TENANT);
    if (!decoded.ok) throw new Error('Replay fork returned a foreign run id');
    const forkId = decoded.runId;
    const ft = await openTimer(forkId);
    expect((ft.data as { timestamp?: string }).timestamp).toBe(due);
    await storage().resolveInterrupt(ft.interruptId, { cancelled: true }, new Date().toISOString());

    for (const rung of [1, 2, 3] as const) {
      await sweep();
      await until(() => getSlaRung(TENANT, orgA, contactId, routingEpoch, rung), `rung ${rung}`);
    }
    expect((await getSlaRung(TENANT, orgA, contactId, routingEpoch, 1))?.outcome).toBe('reminded-owner');
    expect((await getSlaRung(TENANT, orgA, contactId, routingEpoch, 3))?.outcome).toBe('reported-agency-lead');
    expect((await getSlaRung(TENANT, orgA, contactId, routingEpoch, 2))?.outcome).toBe('escalated-agency-lead');
    expect(slaNotices.filter((n) => n.contactId === contactId)).toEqual([{ to: o1, rung: 1, contactId }, { to: admin, rung: 2, contactId }, { to: admin, rung: 3, contactId }]);
  });

  it('an owner’s first touch ends the chain before the next rung', async () => {
    const contactId = await newLead(orgA, 'Stopped');
    const started = await call<{ runId: string; routingEpoch: number }>('admin', 'POST', `/${orgA}/leads/${contactId}/route`);
    const { runId, routingEpoch } = started.body;
    await openTimer(runId);
    await sweep();
    await until(() => getSlaRung(TENANT, orgA, contactId, routingEpoch, 1), 'rung 1');
    await createActivity({ tenantId: TENANT, orgId: orgA, kind: 'call', body: 'Reached them', contactId, createdBy: o1, validators: makeLinkValidators(TENANT, orgA) });
    await openTimer(runId);
    await sweep();
    await until(async () => (await storage().getRun(runId))?.status === 'completed' || null, 'the run to complete');
    expect(await getSlaRung(TENANT, orgA, contactId, routingEpoch, 2)).toBeNull();
  });

  it('the settings routes are client-scoped and validated', async () => {
    expect((await call('admin', 'PUT', `/${orgA}/leads/sla-settings`, { timezone: 'Mars/Olympus' })).status).toBe(422);
    expect((await call('admin', 'PUT', `/${orgA}/leads/sla-settings`, { weeklyHours: [{ day: 1, start: '09:00', end: '17:00' }] })).status).toBe(422);
    const ok = await call<{ settings: { escalation: string } }>('admin', 'PUT', `/${orgA}/leads/sla-settings`, { timezone: 'America/New_York', weeklyHours: [{ day: 1, start: '09:00', end: '17:00' }], agencyLead: admin });
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.body.settings.escalation).toBe('escalate');
    expect((await call('onlyB', 'GET', `/${orgA}/leads/sla-settings`)).status).toBe(404);
    expect((await call('onlyB', 'PUT', `/${orgA}/leads/sla-settings`, {})).status).toBe(404);
  });
});
