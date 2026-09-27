/**
 * CFP-1 remediation — the Production Planner's real chat tools.
 *
 * The exchange contract under test: the Production Planner can READ the Vendor
 * Directory (with the routes' pricing redaction) to ground on, and IGNITE a run
 * that generates + persists a production plan — both gated exactly like the HTTP
 * routes (toggle, acting user, org RBAC). Boots the REAL app (the ADR 0308 D2
 * registration seam is what's under test — the pre-remediation pack allowlisted
 * two node typeIds nothing resolved, so the agent had zero tools).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  PRODUCTION_GET_VENDORS_TOOL_ID,
  PRODUCTION_PLAN_TOOL_ID,
} from '../src/features/production/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { createVendor } from '../src/features/production/productionService.js';

const TENANT = 'default';
const OWNER = 'u-1';
const EDITOR = 'u-editor';

let orgId: string;

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // The org RBAC gate mirrors the HTTP route path — the sole org auto-resolves,
  // its owner (`u-1`) holds workspace:write + host:members:manage (sees pricing),
  // and an explicit `editor` member (`u-editor`) holds workspace:read/write but
  // NOT host:members:manage (pricing redacted — the redaction-parity case).
  const org = await createOrg({ tenantId: TENANT, createdBy: OWNER, name: 'Acme', ownerSubject: OWNER });
  orgId = org.orgId;
  await createMember({ tenantId: TENANT, orgId, displayName: 'Ed', subject: EDITOR, roles: ['editor'] });
  await createVendor({
    tenantId: TENANT,
    orgId,
    type: 'agency',
    name: 'Pixel Forge',
    capabilities: [{ name: 'Motion design', category: 'video' }],
    priceRanges: [{ capability: 'Motion design', min: 100, max: 200, unit: 'per-hour' }],
    createdBy: OWNER,
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setProduction = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('production');
  if (d) await saveConfig({ ...d, status }, 'test');
};

function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

describe('CFP-1 — the pack rides the real host-registered tools', () => {
  const packDir = new URL('../../../packs/feature.production.agents/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as {
    agents: { toolAllowlist: string[]; systemPromptRef: string }[];
  };

  it('both tools register into the builtin surface', () => {
    const ids = builtinAgentToolIds();
    expect(ids).toContain(PRODUCTION_GET_VENDORS_TOOL_ID);
    expect(ids).toContain(PRODUCTION_PLAN_TOOL_ID);
  });

  it('the allowlist is exactly the two registered tool ids (no unresolvable node typeIds)', () => {
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual(
      [PRODUCTION_GET_VENDORS_TOOL_ID, PRODUCTION_PLAN_TOOL_ID].sort(),
    );
  });

  it('the prompt names the tools it can actually call', () => {
    const prompt = readFileSync(new URL(manifest.agents[0]!.systemPromptRef, packDir), 'utf8');
    expect(prompt).toContain('openwop:production.get-vendors');
    expect(prompt).toContain('openwop:production.plan');
    expect(prompt).not.toContain('feature.production.nodes.plan-generate');
  });
});

describe('CFP-1 — get-vendors: the read tool (redaction parity, fail-empty)', () => {
  it('returns vendors with priceRanges for a members-manage caller (owner)', async () => {
    await setProduction('on');
    const out = await provider({ actingUserId: OWNER }).executeTool({ name: PRODUCTION_GET_VENDORS_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { orgId: string; vendors: Array<Record<string, unknown>> };
    expect(res.orgId).toBe(orgId);
    expect(res.vendors).toHaveLength(1);
    expect(res.vendors[0]!.name).toBe('Pixel Forge');
    expect(res.vendors[0]!.priceRanges).toBeDefined();
    // Internal columns never reach the model.
    expect(res.vendors[0]!.tenantId).toBeUndefined();
    expect(res.vendors[0]!.createdBy).toBeUndefined();
  });

  it('redacts priceRanges for a workspace member WITHOUT members-manage (editor)', async () => {
    const out = await provider({ actingUserId: EDITOR }).executeTool({ name: PRODUCTION_GET_VENDORS_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { vendors: Array<Record<string, unknown>> };
    expect(res.vendors).toHaveLength(1);
    expect(res.vendors[0]!.name).toBe('Pixel Forge');
    expect(res.vendors[0]!.priceRanges).toBeUndefined(); // redaction parity
  });

  it('fails EMPTY without an acting user (no typed error — the read-tool rule)', async () => {
    const out = await provider().executeTool({ name: PRODUCTION_GET_VENDORS_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ vendors: [] });
  });

  it('fails EMPTY when the toggle is off', async () => {
    await setProduction('off');
    const out = await provider({ actingUserId: OWNER }).executeTool({ name: PRODUCTION_GET_VENDORS_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ vendors: [] });
    await setProduction('on');
  });
});

describe('CFP-1 — plan: the action tool (typed failures, real run ignition)', () => {
  it('requires a human-initiated turn (typed error)', async () => {
    await setProduction('on');
    const out = await provider().executeTool({ name: PRODUCTION_PLAN_TOOL_ID, input: { channels: ['landing_page'] } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('fails closed when the toggle is off (typed, not a throw)', async () => {
    await setProduction('off');
    const out = await provider({ actingUserId: OWNER }).executeTool({ name: PRODUCTION_PLAN_TOOL_ID, input: { channels: ['landing_page'] } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setProduction('on');
  });

  it('ignites a real production-plan run and returns the runId', async () => {
    const out = await provider({ actingUserId: OWNER }).executeTool({
      name: PRODUCTION_PLAN_TOOL_ID,
      input: { channels: ['landing_page', 'ad_variants'], assets: ['hero image'] },
    });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { runId: string; orgId: string };
    expect(typeof res.runId).toBe('string');
    expect(res.runId.length).toBeGreaterThan(0);
    expect(res.orgId).toBe(orgId);
  });
});
