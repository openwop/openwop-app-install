/**
 * CFP-1 repair (CHAT-FIRST-PORT-AUDIT #1, E6) — the Funnel Architect's real
 * chat tools. The pack allowlisted five NODE typeIds nothing projected, so the
 * persona could call nothing (theater). These tools make the exchange real,
 * sharing the routes' authority: reads FAIL EMPTY without an acting user, the
 * write is DRAFT-ONLY, and no publish/experiment tool is ever registered.
 * Boots the REAL app (the `registerFeatureAgentTool` seam dispatch uses).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  FUNNELS_LIST_TOOL_ID,
  FUNNELS_GET_TOOL_ID,
  FUNNELS_STEP_STATS_TOOL_ID,
  FUNNELS_DRAFT_TOOL_ID,
} from '../src/features/funnels/agentTools.js';
import { archiveFunnel, __resetFunnels } from '../src/features/funnels/funnelsService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, listOrgs } from '../src/host/accessControlService.js';

const TENANT = 'default';
const ALL_IDS = [FUNNELS_LIST_TOOL_ID, FUNNELS_GET_TOOL_ID, FUNNELS_STEP_STATS_TOOL_ID, FUNNELS_DRAFT_TOOL_ID];

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // The org RBAC gate mirrors the HTTP route path — the sole org auto-resolves
  // and its owner (`u-1`) holds workspace:write (the app-builder test precedent).
  await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  await __resetFunnels();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setFunnels = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('funnels');
  if (d) await saveConfig({ ...d, status }, 'test');
};

function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}
const parse = (content: string): Record<string, unknown> => JSON.parse(content) as Record<string, unknown>;

describe('CFP-1 — the funnels agent tools register + the allowlist matches', () => {
  it('all four tools register into the builtin surface (so dispatch can offer them)', () => {
    const ids = builtinAgentToolIds();
    for (const id of ALL_IDS) expect(ids).toContain(id);
  });

  it('the pack allowlist is EXACTLY the four registered ids (no dropped node typeIds)', () => {
    const packDir = new URL('../../../packs/feature.funnels.agents/', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as {
      agents: { toolAllowlist: string[] }[];
    };
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual([...ALL_IDS].sort());
  });

  it('registers NO publish / unpublish / archive / experiment agent tool (draft-only firewall)', () => {
    const funnelToolIds = builtinAgentToolIds().filter((id) => id.startsWith('openwop:funnels.'));
    expect(funnelToolIds.sort()).toEqual([...ALL_IDS].sort());
    for (const id of funnelToolIds) {
      expect(id).not.toMatch(/publish|unpublish|archive|experiment/);
    }
  });
});

describe('CFP-1 — authority parity: reads FAIL EMPTY without an acting user', () => {
  it('list/get/step-stats return empty payloads for a turn with no human principal', async () => {
    await setFunnels('on');
    const p = provider(); // no actingUserId — a scheduled/system turn
    expect(parse((await p.executeTool({ name: FUNNELS_LIST_TOOL_ID, input: {} })).content)).toEqual({ funnels: [] });
    expect(parse((await p.executeTool({ name: FUNNELS_GET_TOOL_ID, input: { funnelId: 'x' } })).content)).toEqual({ funnel: null });
    expect(parse((await p.executeTool({ name: FUNNELS_STEP_STATS_TOOL_ID, input: { funnelId: 'x' } })).content)).toEqual({ steps: {}, days: 0 });
  });

  it('the draft write FAILS TYPED without an acting user (never a silent no-op)', async () => {
    const out = await provider().executeTool({ name: FUNNELS_DRAFT_TOOL_ID, input: { name: 'X' } });
    expect(out.isError).toBe(true);
    expect(parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });
});

describe('CFP-1 — toggle honesty: every tool fails closed when funnels is off', () => {
  it('reads fail EMPTY and only the write stays typed when the toggle is off', async () => {
    await setFunnels('off');
    const p = provider({ actingUserId: 'u-1' });
    // reads: empty (not typed) — the model just sees nothing; the loop is not derailed.
    const list = await p.executeTool({ name: FUNNELS_LIST_TOOL_ID, input: {} });
    expect(list.isError).toBeFalsy();
    expect(parse(list.content)).toEqual({ funnels: [] });
    const get = await p.executeTool({ name: FUNNELS_GET_TOOL_ID, input: { funnelId: 'x' } });
    expect(get.isError).toBeFalsy();
    expect(parse(get.content)).toEqual({ funnel: null });
    const stats = await p.executeTool({ name: FUNNELS_STEP_STATS_TOOL_ID, input: { funnelId: 'x' } });
    expect(stats.isError).toBeFalsy();
    expect(parse(stats.content)).toMatchObject({ steps: {}, days: 0 });
    // write: typed feature_disabled.
    const draft = await p.executeTool({ name: FUNNELS_DRAFT_TOOL_ID, input: { funnelId: 'x', name: 'X' } });
    expect(draft.isError).toBe(true);
    expect(parse(draft.content)).toMatchObject({ error: 'feature_disabled' });
    await setFunnels('on');
  });
});

describe('CFP-1 — happy path: draft → list → get → step-stats (draft-only)', () => {
  it('drafts a new funnel as status:draft, then reads it back', async () => {
    await setFunnels('on');
    const p = provider({ actingUserId: 'u-1' });

    const created = parse((await p.executeTool({ name: FUNNELS_DRAFT_TOOL_ID, input: { name: 'Launch Funnel' } })).content);
    expect(created).toMatchObject({ status: 'draft', proposed: true });
    const funnelId = created.funnelId as string;
    expect(funnelId).toBeTruthy();

    const list = parse((await p.executeTool({ name: FUNNELS_LIST_TOOL_ID, input: {} })).content);
    expect((list.funnels as { funnelId: string }[]).some((f) => f.funnelId === funnelId)).toBe(true);

    const got = parse((await p.executeTool({ name: FUNNELS_GET_TOOL_ID, input: { funnelId } })).content);
    expect((got.funnel as { name: string; status: string }).name).toBe('Launch Funnel');
    expect((got.funnel as { status: string }).status).toBe('draft');

    const stats = parse((await p.executeTool({ name: FUNNELS_STEP_STATS_TOOL_ID, input: { funnelId } })).content);
    expect(stats).toMatchObject({ funnelId, steps: {}, days: 0 });
  });

  it('revising a NON-draft funnel is refused (the public surface stays human-owned)', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = parse((await p.executeTool({ name: FUNNELS_DRAFT_TOOL_ID, input: { name: 'To Archive' } })).content);
    const funnelId = created.funnelId as string;
    // Take it out of draft the way an operator would; the agent must then refuse.
    const [org] = await listOrgs(TENANT);
    await archiveFunnel(TENANT, org!.orgId, funnelId);
    const refused = await p.executeTool({ name: FUNNELS_DRAFT_TOOL_ID, input: { funnelId, steps: [] } });
    expect(refused.isError).toBe(true);
    expect(parse(refused.content)).toMatchObject({ error: 'not_draft' });
  });

  it('a get for a missing funnel is a typed not_found (no existence leak)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: FUNNELS_GET_TOOL_ID, input: { funnelId: 'nope' } });
    expect(out.isError).toBe(true);
    expect(parse(out.content)).toMatchObject({ error: 'not_found' });
  });
});
