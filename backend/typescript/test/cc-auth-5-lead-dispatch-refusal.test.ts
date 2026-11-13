/**
 * CC-AUTH-5 + CC-LEAD-1 — lead grading for the listed operator in a free-plan
 * workspace, and a refused grade does not lock the lead.
 *
 * Observed live on app.openwop.dev (build 373d4863a, 2026-11-12):
 * - CC-AUTH-5: the operator's `POST …/crm/clients/:orgId/leads/:contactId/grade`
 *   answered 403 "This workflow belongs to the crm feature, which is not
 *   included in this workspace's plan." (`crm-ops.grade-lead`). The route served
 *   the operator, but `startReservedLeadDispatch` started the run with only
 *   `orgScopeSubject`, so the run-start gate applied the plan (ADR 1108 class).
 * - CC-LEAD-1: afterwards the lead stayed locked: qualify → 409 "Another lead
 *   operation owns the pending run.", route → 409 "A grading request owns this
 *   lead." The pending grade is stamped BEFORE `startWorkflowRun` and kept on any
 *   throw (an ambiguous insert must reconcile the same run) — but a run-start
 *   refusal is not ambiguous, no run exists, so nothing ever released it.
 *
 * Pins: the operator's grade starts a run stamped `planExempt` (HTTP); a
 * definite launch refusal (`WorkflowFeatureRefusedError`) releases the
 * reservation, so the next operation is refused for the same reason, not
 * locked; control — an AMBIGUOUS insert failure still retains it.
 *
 * Sabotage witnesses: drop the `planExempt` pass-through ⇒ "the operator's grade
 * starts" goes red (403); remove the definite-refusal release ⇒ "a definite
 * refusal releases" goes red (the pending grade stays).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { resolveCanonicalUserForTenant } from '../src/features/users/usersService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { bindLead, getPendingGrade } from '../src/features/crm/leadIntel/leadStore.js';
import { admitLeadDispatch } from '../src/features/crm/leadIntel/runAdmission.js';
import { LEAD_INTEL_TOGGLE } from '../src/features/crm/leadIntel/constants.js';
import { fromWireRunId } from '../src/host/v2Ids.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';

const OPERATOR_PERSONAL = 'user:ccauth5-operator';
let BASE = '';
let server: http.Server;
let storage: Storage;
let hostSuite: HostAdapterSuite;
let TENANT = '';
let orgA = '';
let operatorUser = '';
let operatorCookie = '';
const saved: Record<string, string | undefined> = {};
const ENV = {
  OPENWOP_STORAGE_DSN: 'memory://',
  OPENWOP_SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  OPENWOP_SUPERADMIN_TENANTS: OPERATOR_PERSONAL,
  // crm is sold in the crm bundle; the free plan does not include it.
  OPENWOP_BILLING_BUNDLE_PRICES: JSON.stringify({ price_crm: 'crm', price_mktg: 'marketing' }),
  OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify({ free: ['billing'], pro: ['billing'] }),
};

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['crm', LEAD_INTEL_TOGGLE, 'billing']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  TENANT = (await createWorkspace({ name: 'Free Agency', ownerSubject: 'oidc:ccauth5-owner' })).tenantId;
  operatorUser = (await resolveCanonicalUserForTenant({ homeTenant: OPERATOR_PERSONAL, principalId: OPERATOR_PERSONAL, source: 'oidc' })).userId;
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: operatorUser, displayName: 'Operator', roles: ['viewer'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: operatorUser, displayName: 'Operator', roles: ['editor'] });
  const now = Math.floor(Date.now() / 1000);
  operatorCookie = `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId: operatorUser, personalTenant: OPERATOR_PERSONAL, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

async function boundLead(name: string): Promise<string> {
  const contactId = (await createContact({ tenantId: TENANT, name, email: `${name}-${randomBytes(3).toString('hex')}@example.test`, stage: 'lead' })).contactId;
  await bindLead({ tenantId: TENANT, orgId: orgA, contactId, source: 'form', boundBy: operatorUser });
  return contactId;
}

describe('CC-AUTH-5 — the operator grades a lead in a free workspace', () => {
  it("the operator's grade starts a run stamped with the exemption", async () => {
    const contactId = await boundLead('avery');
    const res = await fetch(`${BASE}/host/openwop-app/crm/clients/${orgA}/leads/${contactId}/grade`, { method: 'POST', headers: { cookie: operatorCookie } });
    const raw = await res.text();
    expect(res.status, raw).toBe(202);
    const wire = (JSON.parse(raw) as { runId: string }).runId;
    const local = fromWireRunId(wire, TENANT);
    const runId = local.ok ? local.runId : wire;
    expect((await storage.getRun(runId))?.metadata).toMatchObject({ planExempt: true });
  });
});

describe('CC-LEAD-1 — a refused grade does not lock the lead', () => {
  it('a definite launch refusal releases the reservation; the next operation is refused for the same reason, not locked', async () => {
    const contactId = await boundLead('blake');
    const input = { mode: 'grade' as const, tenantId: TENANT, orgId: orgA, contactId, userId: operatorUser }; // no exemption ⇒ plan refusal
    await expect(admitLeadDispatch({ storage, hostSuite }, input)).rejects.toMatchObject({ name: 'WorkflowFeatureRefusedError' });
    expect(await getPendingGrade(TENANT, orgA, contactId)).toBeNull();
    // The retry reaches the launch again (the same plan refusal), instead of the
    // 409 a retained reservation answers ("…still in progress" / "…owns the pending run").
    await expect(admitLeadDispatch({ storage, hostSuite }, input)).rejects.toMatchObject({ name: 'WorkflowFeatureRefusedError', details: { reason: 'not_entitled', feature: 'crm' } });
    expect(await getPendingGrade(TENANT, orgA, contactId)).toBeNull();
  });

  it('control: an ambiguous insert failure still retains the reservation', async () => {
    const contactId = await boundLead('casey');
    const flaky = new Proxy(storage, {
      get(target, prop, recv) {
        if (prop === 'insertRun') return async () => { throw new Error('connection reset during insert'); };
        const v = Reflect.get(target, prop, recv) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as Storage;
    await expect(admitLeadDispatch({ storage: flaky, hostSuite }, { mode: 'grade', tenantId: TENANT, orgId: orgA, contactId, userId: operatorUser, planExempt: true, personalTenant: OPERATOR_PERSONAL })).rejects.toThrow(/connection reset/);
    expect(await getPendingGrade(TENANT, orgA, contactId)).not.toBeNull();
  });
});
