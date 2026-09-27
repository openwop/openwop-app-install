/**
 * CHAT-FIRST-PORT-AUDIT D7 — the destination-sync chat lane.
 *
 * Contract under test: the ADR 0308 D2 registration seam projects the three
 * tools; `list` is a fail-EMPTY read; `dry-run` previews the field-map; and
 * `run` ignites the two egress owners through their sanctioned paths — the ADR
 * 0289 onward-sync WORKFLOW (with `claimIgnition` dedup) and the GOVERNED ADR
 * 0292 `warehouseLoad` whose `approval-required` gate stays intact. Boots the
 * REAL app (the registration seam is what's under test).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  DESTINATION_SYNC_LIST_TOOL_ID,
  DESTINATION_SYNC_DRY_RUN_TOOL_ID,
  DESTINATION_SYNC_RUN_TOOL_ID,
} from '../src/features/destination-sync/agentTools.js';
import { createDestinationSync } from '../src/features/destination-sync/destinationSyncService.js';
import { __resetIgnitionClaims } from '../src/host/ignitionGuard.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const TENANT = 'default';
const USER = 'u-1';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

beforeEach(async () => { await __resetIgnitionClaims(); });

const setToggle = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('destination-sync');
  if (d) await saveConfig({ ...d, status }, 'test');
};

function provider(scope: { actingUserId?: string; runId?: string; conversationId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}
const parse = (content: string): Record<string, unknown> => JSON.parse(content) as Record<string, unknown>;

describe('destination-sync agent tools — registration + gating', () => {
  it('projects the three tool ids into the builtin catalog', () => {
    const ids = builtinAgentToolIds();
    for (const id of [DESTINATION_SYNC_LIST_TOOL_ID, DESTINATION_SYNC_DRY_RUN_TOOL_ID, DESTINATION_SYNC_RUN_TOOL_ID]) {
      expect(ids).toContain(id);
    }
  });

  it('list fails EMPTY without an acting user (no leak)', async () => {
    await setToggle('on');
    const out = await provider().executeTool({ name: DESTINATION_SYNC_LIST_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(parse(out.content)).toEqual({ syncs: [] });
  });

  it('list fails EMPTY when the feature is disabled', async () => {
    await setToggle('off');
    const out = await provider({ actingUserId: USER }).executeTool({ name: DESTINATION_SYNC_LIST_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(parse(out.content)).toEqual({ syncs: [] });
    await setToggle('on');
  });

  it('list returns configured syncs for an acting user', async () => {
    await setToggle('on');
    await createDestinationSync({ tenantId: TENANT, name: 'Webhook out', destinationKind: 'webhook', sourceObject: 'contact', fieldMap: [{ from: 'email', to: 'Email' }] });
    const out = await provider({ actingUserId: USER }).executeTool({ name: DESTINATION_SYNC_LIST_TOOL_ID, input: {} });
    const parsed = parse(out.content) as { syncs: Array<{ name: string; fieldCount: number; ignitable: boolean }> };
    const row = parsed.syncs.find((s) => s.name === 'Webhook out');
    expect(row).toBeTruthy();
    expect(row?.fieldCount).toBe(1);
    expect(row?.ignitable).toBe(false);
  });

  it('dry-run fails TYPED without an acting user', async () => {
    const out = await provider().executeTool({ name: DESTINATION_SYNC_DRY_RUN_TOOL_ID, input: { syncId: 'x', sample: {} } });
    expect(out.isError).toBe(true);
    expect(parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('dry-run previews the field-mapped payload', async () => {
    await setToggle('on');
    const sync = await createDestinationSync({ tenantId: TENANT, name: 'Map', destinationKind: 'webhook', sourceObject: 'contact', fieldMap: [{ from: 'email', to: 'Email' }, { from: 'name', to: 'Name' }] });
    const out = await provider({ actingUserId: USER }).executeTool({
      name: DESTINATION_SYNC_DRY_RUN_TOOL_ID,
      input: { syncId: sync.syncId, sample: { email: 'a@b.c', name: 'Ada', extra: 'dropped' } },
    });
    expect(out.isError).toBeFalsy();
    expect(parse(out.content)).toMatchObject({ syncId: sync.syncId, mapped: { Email: 'a@b.c', Name: 'Ada' } });
  });
});

describe('destination-sync agent tools — run ignition', () => {
  it('run fails TYPED without an acting user', async () => {
    const out = await provider().executeTool({ name: DESTINATION_SYNC_RUN_TOOL_ID, input: { syncId: 'x' } });
    expect(out.isError).toBe(true);
    expect(parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('run fails TYPED when the feature is disabled', async () => {
    await setToggle('off');
    const out = await provider({ actingUserId: USER }).executeTool({ name: DESTINATION_SYNC_RUN_TOOL_ID, input: { syncId: 'x' } });
    expect(out.isError).toBe(true);
    expect(parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setToggle('on');
  });

  it('run refuses a non-ignitable destination kind (typed)', async () => {
    await setToggle('on');
    const sync = await createDestinationSync({ tenantId: TENANT, name: 'ESP', destinationKind: 'esp', sourceObject: 'contact', fieldMap: [{ from: 'email', to: 'Email' }] });
    const out = await provider({ actingUserId: USER }).executeTool({ name: DESTINATION_SYNC_RUN_TOOL_ID, input: { syncId: sync.syncId } });
    expect(out.isError).toBe(true);
    expect(parse(out.content)).toMatchObject({ error: 'unsupported_destination_kind', destinationKind: 'esp' });
  });

  it('run ignites the onward-sync workflow for an openwop-host sync; a duplicate call reuses the run', async () => {
    await setToggle('on');
    // Loopback peer URL — the background http.fetch egress is SSRF-blocked, so no
    // real network is touched; only the ignition path is under test.
    const sync = await createDestinationSync({
      tenantId: TENANT, name: 'Peer', destinationKind: 'openwop-host', sourceObject: 'contact',
      fieldMap: [{ from: 'email', to: 'email' }], connectionId: 'conn-1', peerIngestUrl: 'http://127.0.0.1:1/ingest',
    });
    const first = await provider({ actingUserId: USER }).executeTool({ name: DESTINATION_SYNC_RUN_TOOL_ID, input: { syncId: sync.syncId, records: [] } });
    expect(first.isError).toBeFalsy();
    const firstParsed = parse(first.content) as { runId?: string; ignited?: boolean };
    expect(firstParsed.ignited).toBe(true);
    expect(typeof firstParsed.runId).toBe('string');

    // Immediate duplicate inside the ignition window → reuse, no new run.
    const second = await provider({ actingUserId: USER }).executeTool({ name: DESTINATION_SYNC_RUN_TOOL_ID, input: { syncId: sync.syncId, records: [] } });
    const secondParsed = parse(second.content) as { runId?: string; ignited?: boolean };
    expect(secondParsed.ignited).toBe(false);
    expect(secondParsed.runId).toBe(firstParsed.runId);
  });

  it('run on a warehouse sync flows through the approval gate (no silent write)', async () => {
    await setToggle('on');
    const sync = await createDestinationSync({
      tenantId: TENANT, name: 'BQ', destinationKind: 'warehouse', sourceObject: 'contact',
      fieldMap: [{ from: 'email', to: 'email' }], connectionId: 'conn-bq', project: 'p', dataset: 'd', table: 't',
    });
    const out = await provider({ actingUserId: USER, runId: 'run-1' }).executeTool({
      name: DESTINATION_SYNC_RUN_TOOL_ID,
      input: { syncId: sync.syncId, records: [{ id: 'r1', email: 'a@b.c' }] },
    });
    expect(out.isError).toBeFalsy();
    const parsed = parse(out.content) as { status?: string; approvalId?: string };
    // The `actionPolicyOf('warehouse.load')` default is approval-required — the
    // load returns a pending approval, it does NOT insert.
    expect(parsed.status).toBe('requires_approval');
    expect(typeof parsed.approvalId).toBe('string');
  });
});
