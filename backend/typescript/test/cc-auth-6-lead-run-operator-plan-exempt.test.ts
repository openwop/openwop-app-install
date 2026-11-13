/**
 * CC-AUTH-6 — lead-intelligence surface ops (the in-run lane the grade / route /
 * qualify chains call through `ctx.features.crm`) honour the listed operator's
 * plan exemption (ADR 1108), and refuse a plan-blocked customer as a PLAN refusal.
 *
 * Observed live on app.openwop.dev (build dd32bfdb4, 2026-11-12 ~09:23Z): after
 * #5819 the listed operator's lead grade/route dispatch in a free-plan workspace
 * was ADMITTED (202), but runs c21392c6… and 45d96077… FAILED inside the run with
 * `forbidden` "Lead intelligence is not enabled for this workspace." although
 * `crm.lead-intelligence` was ON for the tenant. Mechanism: `crm/surface.ts`
 * `assertLeadRun` / `gradeLead` / `qualificationFrame` resolved `crm` and
 * `crm.lead-intelligence` with `{ tenantId }` only, so the run's `planExempt`
 * never reached `resolveOne` and the workspace's plan refused `crm` — and the
 * refusal was mislabelled "not enabled".
 *
 * Gate probe: each op is called WITHOUT a lead stamp, so a scope that passes the
 * gate fails one step later with the op's own typed error (`… runs inside a run`
 * / `routingEpoch` / `wrong_client`); a scope the gate refuses gets `forbidden`.
 *
 * Fixture: a real client org (the operator is a member, so the ADR 0832 org floor
 * passes) and a real contact bound to it as a lead (`bindLead`).
 *
 * Controls: a customer in the SAME free workspace is refused — at the seam
 * (`featureSurfaces` gate, `host_capability_disabled`, which already resolves `crm`
 * with the run's toggle subject) — so this fix grants a customer nothing; an
 * actorless run (the SLA reroute child, which #5819 stamps with nothing) is refused
 * the same way; `crm.lead-intelligence` switched OFF is still `feature_disabled`
 * for the operator (the surface's own gate).
 *
 * Sabotage witness: revert `assertLeadIntelEnabled` to `{ tenantId: scope.tenantId }`
 * → the three "operator passes" cases go red with `forbidden`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { bindLead } from '../src/features/crm/leadIntel/leadStore.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';

const OPERATOR_PERSONAL = 'user:ccauth6-operator';
const CUSTOMER_PERSONAL = 'user:ccauth6-customer';
let TENANT: string;
let OP_USER: string;
let CU_USER: string;
let LEAD: { orgId: string; contactId: string };
const saved: Record<string, string | undefined> = {};
const ENV = {
  OPENWOP_STORAGE_DSN: 'memory://',
  OPENWOP_SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  OPENWOP_SUPERADMIN_TENANTS: OPERATOR_PERSONAL,
  // A narrowed plan: the crm bundle is sold, so a free workspace is not entitled to it.
  OPENWOP_BILLING_BUNDLE_PRICES: JSON.stringify({ price_crm: 'crm' }),
  OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify({ free: ['billing'], pro: ['billing'] }),
};
type Scope = Parameters<typeof buildFeatureSurfaces>[0];
const crm = (scope: Scope) => buildFeatureSurfaces(scope)['crm']! as unknown as Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
const operator = (): Scope => ({ tenantId: TENANT, actingUserId: OP_USER, personalTenant: OPERATOR_PERSONAL, planExempt: true });
const customer = (): Scope => ({ tenantId: TENANT, actingUserId: CU_USER, personalTenant: CUSTOMER_PERSONAL, planExempt: true });
const actorless = (): Scope => ({ tenantId: TENANT, runId: 'run-ccauth6-reroute' });

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  for (const id of ['crm', 'crm.lead-intelligence', 'billing']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  TENANT = (await createWorkspace({ name: 'Free Agency', ownerSubject: 'oidc:ccauth6-owner' })).tenantId;
  OP_USER = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:ccauth6-operator', source: 'oidc' })).userId;
  CU_USER = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:ccauth6-customer', source: 'oidc' })).userId;
  for (const u of [OP_USER, CU_USER]) await createMember({ tenantId: TENANT, orgId: TENANT, subject: u, displayName: u, roles: ['admin'] });
  const orgId = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'CC-AUTH-6 Client' })).orgId;
  for (const u of [OP_USER, CU_USER]) await createMember({ tenantId: TENANT, orgId, subject: u, displayName: u, roles: ['editor'] });
  const contactId = (await createContact({ tenantId: TENANT, name: 'CCAUTH6 Lead', email: 'ccauth6-lead@example.test', stage: 'lead' })).contactId;
  await bindLead({ tenantId: TENANT, orgId, contactId, source: 'manual', boundBy: OP_USER });
  LEAD = { orgId, contactId };
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('CC-AUTH-6 — lead-intelligence in-run gate', () => {
  it('the operator passes the gate on gradeLead (fails one step later: no run)', async () => {
    await expect(crm(operator()).gradeLead!(LEAD)).rejects.toMatchObject({ code: 'validation_error', message: expect.stringMatching(/runs inside a run/) });
  });
  it('the operator passes the gate on routeLead (assertLeadRun) and leadEvidence (qualificationFrame)', async () => {
    await expect(crm(operator()).routeLead!({ ...LEAD, routingEpoch: 1 })).rejects.toMatchObject({ code: 'validation_error', message: expect.stringMatching(/run inside a run/) });
    await expect(crm(operator()).leadEvidence!(LEAD)).rejects.toMatchObject({ code: 'validation_error' });
  });
  it('control: a customer in the same free workspace is still refused (seam, plan-blocked crm)', async () => {
    for (const op of [() => crm(customer()).gradeLead!(LEAD), () => crm(customer()).routeLead!({ ...LEAD, routingEpoch: 1 }), () => crm(customer()).leadEvidence!(LEAD)]) {
      await expect(op()).rejects.toMatchObject({ code: 'host_capability_disabled' });
    }
  });
  it('control: an actorless run (SLA reroute child) gets no exemption', async () => {
    await expect(crm(actorless()).gradeLead!(LEAD)).rejects.toMatchObject({ code: 'host_capability_disabled' });
  });
  it('control: crm.lead-intelligence switched OFF is still feature_disabled for the operator', async () => {
    const d = getToggleDefault('crm.lead-intelligence')!;
    await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      await expect(crm(operator()).gradeLead!(LEAD)).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'feature_disabled' } });
    } finally { await saveConfig({ ...d, status: 'on' }, 'test'); }
  });
});
