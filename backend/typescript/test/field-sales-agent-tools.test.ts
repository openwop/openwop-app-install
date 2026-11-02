/**
 * CFP-1 repair (D9 field-sales) — the advisory READ chat tools for the three
 * Sales-vertical agents: Territory Planner, Channel Manager, Commissions Analyst.
 *
 * The contract under test: each pack's `toolAllowlist` now resolves to a REAL
 * host-registered agent tool (the CFP-1 tripwire), and each tool enforces the
 * same access decision as its HTTP read routes — toggle ON + org `workspace:read`
 * — while failing EMPTY (never enumerating) without an acting user and returning
 * a typed `feature_disabled` when off. Boots the REAL app (the registration seam
 * under test).
 *
 * Each feature holds ONE seeded row, so a served read is non-empty and the
 * fail-empty answers (no acting user; a same-tenant non-member without
 * `workspace:read`) are distinguishable from it.
 *
 * Tracker TST-DCB-4. Red when a feature's toggle check goes, when the territory
 * read stops failing empty without an acting user, when the model-id validation
 * goes, or when a pack allowlist gains an unregistered id (grade-tests w70).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createModel } from '../src/features/territories/entities/territories.js';
import { createDealer } from '../src/features/dealers/entities/dealer.js';
import { createPlan } from '../src/features/sales-commissions/entities/plan.js';
import { createCompany } from '../src/features/crm/entities/companies.js';
import {
  TERRITORIES_LIST_MODELS_TOOL_ID,
  TERRITORIES_ACTIVE_MODEL_TOOL_ID,
  TERRITORIES_LIST_TERRITORIES_TOOL_ID,
  TERRITORIES_LIST_RULES_TOOL_ID,
  TERRITORIES_LIST_QUOTAS_TOOL_ID,
  TERRITORIES_PREVIEW_TOOL_ID,
  TERRITORIES_ATTAINMENT_TOOL_ID,
} from '../src/features/territories/agentTools.js';
import {
  DEALERS_LIST_DEALERS_TOOL_ID,
  DEALERS_LIST_OUTLETS_TOOL_ID,
  DEALERS_LIST_REGISTRATIONS_TOOL_ID,
} from '../src/features/dealers/agentTools.js';
import {
  COMMISSIONS_LIST_PLANS_TOOL_ID,
  COMMISSIONS_LIST_STATEMENTS_TOOL_ID,
} from '../src/features/sales-commissions/agentTools.js';

const TENANT = 'default';
const OWNER = 'u-1';
/** Same tenant, no membership in the org: the `workspace:read` gate's subject. */
const STRANGER = 'u-stranger';

const TERRITORY_TOOL_IDS = [
  TERRITORIES_LIST_MODELS_TOOL_ID,
  TERRITORIES_ACTIVE_MODEL_TOOL_ID,
  TERRITORIES_LIST_TERRITORIES_TOOL_ID,
  TERRITORIES_LIST_RULES_TOOL_ID,
  TERRITORIES_LIST_QUOTAS_TOOL_ID,
  TERRITORIES_PREVIEW_TOOL_ID,
  TERRITORIES_ATTAINMENT_TOOL_ID,
];
const DEALER_TOOL_IDS = [DEALERS_LIST_DEALERS_TOOL_ID, DEALERS_LIST_OUTLETS_TOOL_ID, DEALERS_LIST_REGISTRATIONS_TOOL_ID];
const COMMISSION_TOOL_IDS = [COMMISSIONS_LIST_PLANS_TOOL_ID, COMMISSIONS_LIST_STATEMENTS_TOOL_ID];

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // The org RBAC gate mirrors the HTTP read routes — the sole org auto-resolves
  // and its owner holds workspace:read (and manage).
  const org = await createOrg({ tenantId: TENANT, createdBy: OWNER, name: 'Acme', ownerSubject: OWNER });
  await createModel(TENANT, org.orgId, { name: 'FY27 model' }, OWNER);
  const company = await createCompany({ tenantId: TENANT, orgId: org.orgId, name: 'Northwind', createdBy: OWNER });
  await createDealer(TENANT, org.orgId, { companyId: company.companyId, name: 'Northwind Dealer' }, OWNER);
  await createPlan(TENANT, org.orgId, {
    name: 'AE plan', currency: 'USD', assignment: { kind: 'rep', ref: OWNER },
    rules: [{ basis: 'deal-won', type: 'percentage', rate: 7.5 }], effectiveFrom: '2026-01-01',
  }, OWNER);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
};

function provider(scope: { actingUserId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

async function call(id: string, input: Record<string, unknown> = {}, scope: { actingUserId?: string } = {}) {
  return provider(scope).executeTool({ name: id, input });
}

describe('CFP-1 — field-sales agent tools register into the builtin surface', () => {
  it('every allowlisted id resolves to a real host tool', () => {
    const ids = builtinAgentToolIds();
    for (const id of [...TERRITORY_TOOL_IDS, ...DEALER_TOOL_IDS, ...COMMISSION_TOOL_IDS]) {
      expect(ids, `missing ${id}`).toContain(id);
    }
  });

  it('each pack allowlist is exactly its registered tool ids', () => {
    const packAllow = (dir: string): string[] => {
      const manifest = JSON.parse(readFileSync(new URL(`../../../packs/${dir}/pack.json`, import.meta.url), 'utf8')) as {
        agents: { toolAllowlist: string[] }[];
      };
      return [...manifest.agents[0]!.toolAllowlist].sort();
    };
    expect(packAllow('vendor.openwop-app.territories.agents')).toEqual([...TERRITORY_TOOL_IDS].sort());
    expect(packAllow('vendor.openwop-app.dealers.agents')).toEqual([...DEALER_TOOL_IDS].sort());
    expect(packAllow('vendor.openwop-app.sales-commissions.agents')).toEqual([...COMMISSION_TOOL_IDS].sort());
  });
});

describe('CFP-1 — reads enforce the route predicate (toggle + acting user)', () => {
  it('territories: happy path returns a real (empty) read; off is typed; no-acting-user is empty', async () => {
    await setToggle('territories', 'on');
    const ok = await call(TERRITORIES_LIST_MODELS_TOOL_ID, {}, { actingUserId: OWNER });
    expect(ok.isError).toBeFalsy();
    const served = JSON.parse(ok.content) as { models: { name: string }[] };
    expect(served.models.map((m) => m.name)).toEqual(['FY27 model']);

    // A same-tenant non-member lacks workspace:read ⇒ fail-closed EMPTY.
    const stranger = await call(TERRITORIES_LIST_MODELS_TOOL_ID, {}, { actingUserId: STRANGER });
    expect(stranger.isError).toBeFalsy();
    expect(JSON.parse(stranger.content)).toEqual({ models: [], activeModelId: null });

    // Fail-empty without an acting user (a system/scheduled turn must not enumerate).
    const anon = await call(TERRITORIES_LIST_MODELS_TOOL_ID, {}, {});
    expect(anon.isError).toBeFalsy();
    expect(JSON.parse(anon.content)).toEqual({ models: [], activeModelId: null });

    // A model-scoped read with a missing modelId is a TYPED validation error.
    const badInput = await call(TERRITORIES_LIST_TERRITORIES_TOOL_ID, {}, { actingUserId: OWNER });
    expect(badInput.isError).toBe(true);
    const bad = JSON.parse(badInput.content) as { error?: string; message?: string };
    expect(bad.error).toBe('validation_error');
    expect(bad.message).toContain('Pass the `modelId` to read');

    await setToggle('territories', 'off');
    const off = await call(TERRITORIES_ACTIVE_MODEL_TOOL_ID, {}, { actingUserId: OWNER });
    expect(off.isError).toBe(true);
    expect(JSON.parse(off.content)).toMatchObject({ error: 'feature_disabled' });
  });

  it('dealers: happy path, off, and no-acting-user', async () => {
    await setToggle('dealers', 'on');
    const ok = await call(DEALERS_LIST_DEALERS_TOOL_ID, {}, { actingUserId: OWNER });
    expect(ok.isError).toBeFalsy();
    expect((JSON.parse(ok.content) as { dealers: { name: string }[] }).dealers.map((d) => d.name)).toEqual(['Northwind Dealer']);

    const anonDealers = await call(DEALERS_LIST_DEALERS_TOOL_ID, {}, {});
    expect(anonDealers.isError).toBeFalsy();
    expect(JSON.parse(anonDealers.content)).toEqual({ dealers: [] });
    const stranger = await call(DEALERS_LIST_DEALERS_TOOL_ID, {}, { actingUserId: STRANGER });
    expect(stranger.isError).toBeFalsy();
    expect(JSON.parse(stranger.content)).toEqual({ dealers: [] });

    const anon = await call(DEALERS_LIST_REGISTRATIONS_TOOL_ID, {}, {});
    expect(anon.isError).toBeFalsy();
    expect(JSON.parse(anon.content)).toEqual({ registrations: [] });

    await setToggle('dealers', 'off');
    const off = await call(DEALERS_LIST_OUTLETS_TOOL_ID, {}, { actingUserId: OWNER });
    expect(off.isError).toBe(true);
    expect(JSON.parse(off.content)).toMatchObject({ error: 'feature_disabled' });
  });

  it('commissions: happy path, off, and no-acting-user (money reads stay read-only)', async () => {
    await setToggle('sales-commissions', 'on');
    const ok = await call(COMMISSIONS_LIST_PLANS_TOOL_ID, {}, { actingUserId: OWNER });
    expect(ok.isError).toBeFalsy();
    expect((JSON.parse(ok.content) as { plans: { name: string }[] }).plans.map((p) => p.name)).toEqual(['AE plan']);

    const anonPlans = await call(COMMISSIONS_LIST_PLANS_TOOL_ID, {}, {});
    expect(anonPlans.isError).toBeFalsy();
    expect(JSON.parse(anonPlans.content)).toEqual({ plans: [] });
    const stranger = await call(COMMISSIONS_LIST_PLANS_TOOL_ID, {}, { actingUserId: STRANGER });
    expect(stranger.isError).toBeFalsy();
    expect(JSON.parse(stranger.content)).toEqual({ plans: [] });

    // Subject-scoped statements: no acting user ⇒ nothing.
    const anon = await call(COMMISSIONS_LIST_STATEMENTS_TOOL_ID, {}, {});
    expect(anon.isError).toBeFalsy();
    expect(JSON.parse(anon.content)).toEqual({ statements: [] });

    await setToggle('sales-commissions', 'off');
    const off = await call(COMMISSIONS_LIST_STATEMENTS_TOOL_ID, {}, { actingUserId: OWNER });
    expect(off.isError).toBe(true);
    expect(JSON.parse(off.content)).toMatchObject({ error: 'feature_disabled' });
  });
});
