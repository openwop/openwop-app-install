/**
 * ADR 0655 D7 (EMWF-9) — the email agent tools share the routes' ADR 0419 entitlement
 * gate: a narrowed plan 402s the HTTP routes, so the copywriter agent must refuse too —
 * the read fails EMPTY, the write fails typed. The plan is narrowed BEFORE boot (the
 * `entitlement-central-gate.test.ts` shape: plan config is read at startup). Born red:
 * the tools checked the toggle only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { EMAIL_GET_CAMPAIGN_TOOL_ID, EMAIL_SAVE_DRAFT_TOOL_ID } from '../src/features/email/agentTools.js';

const TENANT = 'default';
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_mktg: 'marketing' });
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'], pro: ['billing'] });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  for (const id of ['email', 'billing']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => {
  delete process.env.OPENWOP_BILLING_PLAN_FEATURES; delete process.env.OPENWOP_BILLING_BUNDLE_PRICES;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('EMWF-9 — email agent tools honour the plan entitlement', () => {
  it('a narrowed plan makes the read tool EMPTY and the write tool a typed refusal', async () => {
    const provider = createAgentToolProvider({ tenantId: TENANT, actingUserId: 'u-1' });
    const read = await provider.executeTool({ name: EMAIL_GET_CAMPAIGN_TOOL_ID, input: {} });
    expect(read.isError, read.content).toBeFalsy();
    expect(read.content).not.toContain('"campaigns"');
    expect(read.content.toLowerCase()).toContain('plan');
    const write = await provider.executeTool({ name: EMAIL_SAVE_DRAFT_TOOL_ID, input: { subject: 's', body: 'b' } });
    expect(write.isError).toBe(true);
    expect(JSON.parse(write.content)).toMatchObject({ error: 'not_entitled' });
  });
});
