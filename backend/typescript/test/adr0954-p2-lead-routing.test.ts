/**
 * ADR 0954 P2 — lead routing (D5).
 *
 * Exit criteria (witnessed):
 *  - round robin is fair under concurrent arrivals: nine leads routed at once
 *    over a pool of three land three per owner, each on a distinct turn (CAS);
 *  - an ineligible owner is skipped (a viewer of the client, a member of
 *    another client) and recorded;
 *  - no cross-client assignment: a lead is never routed to someone without
 *    `workspace:write` on its client.
 * plus: nobody eligible goes to the unassigned queue; capacity picks the
 * least-loaded owner under the cap; a round is ledgered (a re-execution returns
 * the recorded choice and does not turn the rotation); territories' `contact`
 * rules match leads; the real chain grades then routes end to end; the routes
 * are client-scoped (a B-only operator gets 404).
 *
 * Sabotage-witnessed (P2): replacing `takeTurn`'s compareAndSwap with a read +
 * put reds the fairness case; dropping the `eligible` check reds the
 * ineligible and cross-client cases; dropping the ledger lookup reds
 * "a re-execution returns the recorded choice".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace, deleteMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { tombstoneId } from '../src/features/consent/consentService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { bindLead, getLeadProfile, getLeadBindingId, getPendingLeadRoute, reserveLeadRoute, stampPendingGrade } from '../src/features/crm/leadIntel/leadStore.js';
import { saveRoutingPolicy } from '../src/features/crm/leadIntel/routingPolicy.js';
import { getRoutingDecision, routeLead as runRouting } from '../src/features/crm/leadIntel/routing.js';
import { gradeLeadForRun } from '../src/features/crm/leadIntel/grading.js';
import { contentHashOf, V0_CONTENT } from '../src/features/crm/leadIntel/model.js';
import { LEAD_INTEL_TOGGLE } from '../src/features/crm/leadIntel/constants.js';
import { setLeadTerritoryResolver } from '../src/host/leadTerritoryRouting.js';
import { evaluateRecord, type AssignmentRule } from '../src/features/territories/entities/assignment.js';
import { registerLeadTerritoryRouting } from '../src/features/territories/leadRouting.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let orgA: string;
let orgB: string;
let admin: string;
let o1: string; let o2: string; let o3: string;
let viewerA: string;
let onlyB: string;
const cookies: Record<string, string> = {};

/** Trusted service fixtures reserve a real primary round, as HTTP admission does.
 * A recorded fork is a read/replay and does not reserve another dispatch. */
async function prepareRouting(input: Parameters<typeof runRouting>[0]): Promise<void> {
  if (!(await getRoutingDecision(input.tenantId, input.orgId, input.contactId, input.routingEpoch)) && !(await getPendingLeadRoute(input.tenantId, input.orgId, input.contactId))) {
    const reserved = await reserveLeadRoute(input.tenantId, input.orgId, input.contactId, input.runId, {
      bindingId: await getLeadBindingId(input.tenantId, input.orgId, input.contactId), modelId: 'v0', modelVersion: 0,
      modelHash: contentHashOf(V0_CONTENT), definitionHash: '1'.repeat(64), requesterHash: 'fixture',
    });
    expect(reserved.pin.routingEpoch).toBe(input.routingEpoch);
    await stampPendingGrade(input.tenantId, input.orgId, input.contactId, input.runId, reserved.pin);
    expect((await gradeLeadForRun({ ...input, pinned: { bindingId: reserved.pin.bindingId, modelId: reserved.pin.modelId, version: reserved.pin.modelVersion, contentHash: reserved.pin.modelHash } })).outcome).toBe('recorded');
  }
}
async function routeLead(input: Parameters<typeof runRouting>[0]): ReturnType<typeof runRouting> {
  await prepareRouting(input);
  return runRouting(input);
}

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
let policyVersion = 0;
const setPolicy = async (orgId: string, rules: unknown[]): Promise<void> => {
  const p = await saveRoutingPolicy({ tenantId: TENANT, orgId, expectedVersion: orgId === orgA ? policyVersion : 0, rules, actor: admin });
  if (orgId === orgA) policyVersion = p.version;
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await toggle('crm'); await toggle(LEAD_INTEL_TOGGLE);
  TENANT = (await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:rt-owner' })).tenantId;
  const mk = async (p: string): Promise<string> => (await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:rt-${p}`, source: 'oidc' })).userId;
  admin = await mk('admin'); o1 = await mk('o1'); o2 = await mk('o2'); o3 = await mk('o3'); viewerA = await mk('viewer-a'); onlyB = await mk('only-b');
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin, displayName: 'Admin', roles: ['admin'] });
  for (const u of [o1, o2, o3, viewerA, onlyB]) await createMember({ tenantId: TENANT, orgId: TENANT, subject: u, displayName: u, roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  for (const u of [o1, o2, o3]) await createMember({ tenantId: TENANT, orgId: orgA, subject: u, displayName: u, roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: viewerA, displayName: 'viewer', roles: ['viewer'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: admin, displayName: 'Admin', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: orgB, subject: onlyB, displayName: 'onlyB', roles: ['editor'] });
  cookies.admin = cookieFor(admin, 'ws:home-admin');
  cookies.onlyB = cookieFor(onlyB, 'ws:home-only-b');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0954 D5 — routing', () => {
  it('round robin is fair under concurrent arrivals (each lead takes a distinct turn)', async () => {
    await setPolicy(orgA, [{ ruleId: 'everyone', strategy: 'round-robin', pool: [o1, o2, o3] }]);
    const leads = await Promise.all(Array.from({ length: 9 }, (_, i) => newLead(orgA, `RR${i}`)));
    const out = await Promise.all(leads.map((contactId, i) => routeLead({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: 1, runId: `rr-${i}` })));
    const counts = new Map<string, number>();
    for (const { decision } of out) counts.set(decision.chosen!, (counts.get(decision.chosen!) ?? 0) + 1);
    expect([...counts.values()].sort()).toEqual([3, 3, 3]);
    expect(new Set(out.map((o) => o.decision.pointerBefore)).size).toBe(9);
  });

  it('skips an ineligible owner (a viewer, a member of another client) and never routes across clients', async () => {
    await setPolicy(orgA, [{ ruleId: 'mixed', strategy: 'round-robin', pool: [viewerA, onlyB, o1] }]);
    for (let i = 0; i < 4; i += 1) {
      const contactId = await newLead(orgA, `Mixed${i}`);
      const { decision } = await routeLead({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: 1, runId: `mx-${i}` });
      expect(decision.chosen).toBe(o1);
      expect(decision.skipped).toEqual(expect.arrayContaining([{ subject: viewerA, reason: 'not_eligible' }, { subject: onlyB, reason: 'not_eligible' }]));
    }
  });

  it('nobody eligible ⇒ the client’s unassigned queue', async () => {
    await setPolicy(orgA, [{ ruleId: 'nobody', strategy: 'named', named: onlyB }]);
    const contactId = await newLead(orgA, 'Nobody');
    const { decision } = await routeLead({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: 1, runId: 'nb' });
    expect(decision.chosen).toBeNull();
    expect((await getLeadProfile(TENANT, orgA, contactId))?.unassigned).toBe(true);
  });

  it('capacity picks the least-loaded owner under the cap', async () => {
    await setPolicy(orgA, [{ ruleId: 'cap', strategy: 'capacity', pool: [o2, o3], maxOpenLeads: 100 }]);
    // o2 and o3 each hold 3 open leads from the round-robin case; give o2 one more.
    const extra = await newLead(orgA, 'Extra');
    await setPolicy(orgA, [{ ruleId: 'to-o2', strategy: 'named', named: o2 }]);
    await routeLead({ tenantId: TENANT, orgId: orgA, contactId: extra, routingEpoch: 1, runId: 'ex' });
    await setPolicy(orgA, [{ ruleId: 'cap', strategy: 'capacity', pool: [o2, o3], maxOpenLeads: 100 }]);
    const contactId = await newLead(orgA, 'Cap');
    const { decision } = await routeLead({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: 1, runId: 'cp' });
    expect(decision.chosen).toBe(o3);
  });

  it('a routing round is ledgered: a re-execution returns the recorded choice and does not turn the rotation', async () => {
    await setPolicy(orgA, [{ ruleId: 'everyone', strategy: 'round-robin', pool: [o1, o2, o3] }]);
    const contactId = await newLead(orgA, 'Ledger');
    const first = await routeLead({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: 1, runId: 'l1' });
    const again = await routeLead({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: 1, runId: 'l1-fork' });
    expect(again.replayed).toBe(true);
    expect(again.decision).toEqual(first.decision);
    const next = await routeLead({ tenantId: TENANT, orgId: orgA, contactId: await newLead(orgA, 'Next'), routingEpoch: 1, runId: 'l2' });
    expect(next.decision.pointerBefore).toBe(first.decision.pointerBefore! + 1);
  });

  it('two concurrent leads cannot both consume one owner’s final capacity slot', async () => {
    const owner = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:capacity-last-slot', source: 'oidc' })).userId;
    await createMember({ tenantId: TENANT, orgId: TENANT, subject: owner, displayName: 'Capacity owner', roles: ['viewer'] });
    await createMember({ tenantId: TENANT, orgId: orgA, subject: owner, displayName: 'Capacity owner', roles: ['editor'] });
    await setPolicy(orgA, [{ ruleId: 'one-slot', strategy: 'capacity', pool: [owner], maxOpenLeads: 1 }]);
    const contacts = await Promise.all([newLead(orgA, 'CapacityA'), newLead(orgA, 'CapacityB')]);
    const outcomes = await Promise.all(contacts.map((id, i) => routeLead({ tenantId: TENANT, orgId: orgA, contactId: id, routingEpoch: 1, runId: `capacity-${i}` })));
    expect(outcomes.filter((out) => out.decision.chosen === owner)).toHaveLength(1);
    expect(outcomes.filter((out) => out.decision.chosen === null)).toHaveLength(1);
    const profiles = await Promise.all(contacts.map((id) => getLeadProfile(TENANT, orgA, id)));
    expect(profiles.filter((profile) => profile?.owner === owner)).toHaveLength(1);
    const winner = outcomes.findIndex((out) => out.decision.chosen === owner);
    const replay = await routeLead({ tenantId: TENANT, orgId: orgA, contactId: contacts[winner]!, routingEpoch: 1, runId: 'capacity-replay' });
    expect(replay.replayed).toBe(true);
    expect(replay.decision).toEqual(outcomes[winner]!.decision);
  });

  it('a losing concurrent candidate releases capacity after the round has an immutable winning owner', async () => {
    const owners = await Promise.all(['a', 'b'].map(async (suffix) => {
      const owner = (await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:capacity-duplicate-${suffix}`, source: 'oidc' })).userId;
      await createMember({ tenantId: TENANT, orgId: TENANT, subject: owner, displayName: 'Concurrent owner', roles: ['viewer'] });
      await createMember({ tenantId: TENANT, orgId: orgA, subject: owner, displayName: 'Concurrent owner', roles: ['editor'] }); return owner;
    }));
    await setPolicy(orgA, [{ ruleId: 'duplicate-pool', strategy: 'round-robin', pool: owners }]);
    const contactId = await newLead(orgA, 'DuplicateCandidate');
    const input = { tenantId: TENANT, orgId: orgA, contactId, routingEpoch: 1, runId: 'same-round-two-executors' };
    await prepareRouting(input);
    const storage = hostExtStorage(); const cas = storage.kvCompareAndSwap.bind(storage);
    const ownerKeys = new Set(owners.map((owner) => `hostext:crm:lead-rr:${TENANT}::${orgA}::capacity:${tombstoneId(TENANT, owner)}`));
    const reserved = new Set<string>(); let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key === `hostext:crm:lead-profile:${TENANT}::${orgA}::${contactId}` && JSON.parse(next).routingHistory?.length) await both;
      const applied = await cas(key, expected, next);
      if (applied && ownerKeys.has(key)) { reserved.add(key); if (reserved.size === 2) release(); }
      return applied;
    });
    let outcomes: Awaited<ReturnType<typeof runRouting>>[];
    try { outcomes = await Promise.all([runRouting(input), runRouting(input)]); }
    finally { spy.mockRestore(); }
    expect(reserved.size).toBe(2); expect(outcomes[0]!.decision).toEqual(outcomes[1]!.decision);
    const loser = owners.find((owner) => owner !== outcomes[0]!.decision.chosen)!;
    await setPolicy(orgA, [{ ruleId: 'loser-capacity', strategy: 'capacity', pool: [loser], maxOpenLeads: 1 }]);
    const next = await routeLead({ tenantId: TENANT, orgId: orgA, contactId: await newLead(orgA, 'NextCapacity'), routingEpoch: 1, runId: 'next-capacity' });
    expect(next.decision.chosen).toBe(loser);
    expect((await getLeadProfile(TENANT, orgA, contactId))?.owner).toBe(outcomes[0]!.decision.chosen);
  });

  it('refuses a late assignment notice after the chosen owner loses client access', async () => {
    const owner = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:late-notice-owner', source: 'oidc' })).userId;
    await createMember({ tenantId: TENANT, orgId: TENANT, subject: owner, displayName: 'Recipient', roles: ['viewer'] });
    const membership = await createMember({ tenantId: TENANT, orgId: orgA, subject: owner, displayName: 'Recipient', roles: ['editor'] });
    await setPolicy(orgA, [{ ruleId: 'late-notice', strategy: 'named', named: owner }]);
    const contactId = await newLead(orgA, 'PrivateLeadName');
    const storage = hostExtStorage(); const cas = storage.kvCompareAndSwap.bind(storage); const insert = storage.insertNotification.bind(storage);
    let removed = false; let notices = 0;
    const insertSpy = vi.spyOn(storage, 'insertNotification').mockImplementation(async (record) => { if (record.type === 'crm.lead.assigned') notices++; return insert(record); });
    const casSpy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const applied = await cas(key, expected, next);
      if (!removed && applied && key === `hostext:crm:lead-profile:${TENANT}::${orgA}::${contactId}` && JSON.parse(next).owner === owner) {
        removed = true; expect(await deleteMember(membership.memberId, { actor: admin })).toBe(true);
      }
      return applied;
    });
    try {
      const result = await routeLead({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: 1, runId: 'late-notice' });
      expect(result.decision.chosen).toBe(owner); expect(removed).toBe(true); expect(notices).toBe(0);
    } finally { casSpy.mockRestore(); insertSpy.mockRestore(); }
  });

  it('a `territory` rule routes by the territory’s members (the territories seam)', async () => {
    const rule: AssignmentRule = { ruleId: 'r1', tenantId: TENANT, orgId: orgA, modelId: 'm', territoryId: 't-hot', target: 'contact', filter: { all: [{ field: 'source', op: 'eq', value: 'form' }, { field: 'stage', op: 'eq', value: 'lead' }] }, priority: 0, createdAt: '2026-01-01T00:00:00Z' };
    expect(evaluateRecord([rule], 'contact', { stage: 'lead', source: 'form' })).toEqual({ territoryId: 't-hot', ruleId: 'r1' });
    expect(evaluateRecord([rule], 'contact', { stage: 'customer', source: 'form' })).toBeNull();
    setLeadTerritoryResolver(async (_t, orgId, lead) => (orgId === orgA && evaluateRecord([rule], 'contact', lead) ? { territoryId: 't-hot', ruleId: 'r1', memberSubjectIds: [onlyB, o3] } : null));
    try {
      await setPolicy(orgA, [{ ruleId: 'terr', strategy: 'territory' }]);
      const contactId = await newLead(orgA, 'Terr');
      const { decision } = await routeLead({ tenantId: TENANT, orgId: orgA, contactId, routingEpoch: 1, runId: 'tr' });
      expect(decision).toMatchObject({ chosen: o3, strategy: 'territory' });
      expect(decision.skipped).toEqual([{ subject: onlyB, reason: 'not_eligible' }]);
    } finally {
      registerLeadTerritoryRouting(); // restore the real resolver
    }
  });

  it('the real chain grades then routes; the routes are client-scoped', async () => {
    await setPolicy(orgA, [{ ruleId: 'everyone', strategy: 'round-robin', pool: [o1, o2, o3] }]);
    const contactId = await newLead(orgA, 'Chain');
    const started = await call<{ runId: string; routingEpoch: number }>('admin', 'POST', `/${orgA}/leads/${contactId}/route`);
    expect(started.status, started.raw).toBe(202);
    let decision = null;
    for (let i = 0; i < 100 && !decision; i += 1) {
      decision = await getRoutingDecision(TENANT, orgA, contactId, started.body.routingEpoch);
      if (!decision) await new Promise((r) => setTimeout(r, 50));
    }
    expect(decision?.chosen).toBeTruthy();
    const record = await call<{ decision: { chosen: string } }>('admin', 'GET', `/${orgA}/leads/${contactId}/routing/${started.body.routingEpoch}`);
    expect(record.body.decision.chosen).toBe(decision!.chosen);
    expect((await call('onlyB', 'GET', `/${orgA}/leads/${contactId}/routing/${started.body.routingEpoch}`)).status).toBe(404);
    expect((await call('onlyB', 'POST', `/${orgA}/leads/${contactId}/route`)).status).toBe(404);
    expect((await call('onlyB', 'GET', `/${orgA}/leads/routing-policy`)).status).toBe(404);
  });
});
