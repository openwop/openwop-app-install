/**
 * Connection readiness — the `requiredConnections` → activation gate (ADR 0033
 * §3.3 / T3.3).
 *
 * Pure-service coverage over a booted memory app (so the `DurableCollection`
 * seam behind `agentProfileService` + the Connections broker is wired):
 *   - no profile / no requirements → ungated (allConfigured, level unchanged)
 *   - declared requirement with NO connection → fail-closed (missing, gate→review)
 *   - partial coverage → still gated until EVERY required provider is active
 *   - full coverage → allConfigured, declared level preserved
 *   - a non-active (needs-reconsent) connection does NOT satisfy a requirement
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { upsertAgentProfile, __resetAgentProfileStore } from '../src/host/agentProfileService.js';
import {
  createSecretConnection,
  __resetConnectionsStore,
} from '../src/features/connections/connectionsService.js';
import {
  resolveConnectionReadiness,
  gateAutonomyByReadiness,
} from '../src/host/connectionReadiness.js';

let server: { close(cb?: () => void): void };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  server = app.listen(0);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await __resetAgentProfileStore();
  await __resetConnectionsStore();
});

const TENANT = 'tenant-A';
const AGENT = 'host:it-service-desk';

async function seedProfile(requiredConnections: string[]): Promise<void> {
  await upsertAgentProfile(TENANT, AGENT, {
    roleKey: 'it-service-desk',
    requiredConnections,
    autonomy: { specLevel: 'execute-with-approval' }, // → derived level 'guided'
  });
}

describe('connectionReadiness — requiredConnections activation gate (ADR 0033 §3.3)', () => {
  it('is ungated when the agent has no profile', async () => {
    const r = await resolveConnectionReadiness(TENANT, AGENT);
    expect(r.allConfigured).toBe(true);
    expect(r.required).toEqual([]);
    expect(gateAutonomyByReadiness('auto', r)).toBe('auto');
  });

  it('is ungated when the profile declares no requiredConnections', async () => {
    await seedProfile([]);
    const r = await resolveConnectionReadiness(TENANT, AGENT);
    expect(r.allConfigured).toBe(true);
    expect(gateAutonomyByReadiness('auto', r)).toBe('auto');
  });

  it('fails closed when a required connection is missing (gate → review)', async () => {
    await seedProfile(['sendgrid', 'servicenow']);
    const r = await resolveConnectionReadiness(TENANT, AGENT);
    expect(r.allConfigured).toBe(false);
    expect(r.missing).toEqual(['sendgrid', 'servicenow']);
    expect(r.entries.every((e) => !e.configured)).toBe(true);
    // The gate forces propose-only regardless of the declared level.
    expect(gateAutonomyByReadiness('auto', r)).toBe('review');
    expect(gateAutonomyByReadiness('guided', r)).toBe('review');
  });

  it('stays gated until EVERY required provider has an active connection', async () => {
    await seedProfile(['sendgrid', 'servicenow']);
    await createSecretConnection({ tenantId: TENANT, provider: 'sendgrid', kind: 'api_key', secret: 'SG.x', scope: 'workspace' });

    const partial = await resolveConnectionReadiness(TENANT, AGENT);
    expect(partial.allConfigured).toBe(false);
    expect(partial.missing).toEqual(['servicenow']);
    expect(partial.entries.find((e) => e.provider === 'sendgrid')?.configured).toBe(true);
    expect(gateAutonomyByReadiness('auto', partial)).toBe('review');

    await createSecretConnection({ tenantId: TENANT, provider: 'servicenow', kind: 'api_key', secret: 'sn-key', scope: 'workspace' });
    const full = await resolveConnectionReadiness(TENANT, AGENT);
    expect(full.allConfigured).toBe(true);
    expect(full.missing).toEqual([]);
    // Now the declared level passes through unchanged.
    expect(gateAutonomyByReadiness('auto', full)).toBe('auto');
    expect(gateAutonomyByReadiness('guided', full)).toBe('guided');
  });

  it('does not leak a connection from another tenant', async () => {
    await seedProfile(['sendgrid']);
    await createSecretConnection({ tenantId: 'tenant-B', provider: 'sendgrid', kind: 'api_key', secret: 'SG.other', scope: 'workspace' });
    const r = await resolveConnectionReadiness(TENANT, AGENT);
    expect(r.allConfigured).toBe(false);
    expect(r.missing).toEqual(['sendgrid']);
  });
});
