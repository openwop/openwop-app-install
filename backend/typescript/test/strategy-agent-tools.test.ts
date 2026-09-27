/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — the Strategy Analyst's REAL conversational
 * tools resolve + enforce the same authority as the strategy routes. Boots the
 * REAL app (the ADR 0308 D2 registration seam is what's under test), mirroring
 * app-builder-agent-tools.test.ts.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  STRATEGY_LIST_TOOL_ID, STRATEGY_GET_TOOL_ID, STRATEGY_CONTEXT_TOOL_ID,
  STRATEGY_HEALTH_TOOL_ID, STRATEGY_BOARD_MEMO_TOOL_ID,
} from '../src/features/strategy/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createStrategy } from '../src/features/strategy/strategyService.js';

const TENANT = 'default';
const ALL_IDS = [STRATEGY_LIST_TOOL_ID, STRATEGY_GET_TOOL_ID, STRATEGY_CONTEXT_TOOL_ID, STRATEGY_HEALTH_TOOL_ID, STRATEGY_BOARD_MEMO_TOOL_ID];

let server: http.Server;
let orgId: string;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  orgId = org.orgId;
  // Documents ON so the board-memo tool exercises the persist path.
  const docs = getToggleDefault('documents');
  if (docs) await saveConfig({ ...docs, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setStrategy = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('strategy');
  if (d) await saveConfig({ ...d, status }, 'test');
};

function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

describe('CFP-1 — strategy agent tools register + the pack rides exactly them', () => {
  const packDir = new URL('../../../packs/feature.strategy.agents/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as { agents: { toolAllowlist: string[] }[] };

  it('all five tools register into the builtin surface', () => {
    const ids = builtinAgentToolIds();
    for (const id of ALL_IDS) expect(ids).toContain(id);
  });

  it('the allowlist is exactly the five registered tool ids', () => {
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual([...ALL_IDS].sort());
  });
});

describe('CFP-1 — strategy read tools: toggle + acting-user gates + authority parity', () => {
  it('list-strategies returns the workspace\'s shared strategies for an acting user', async () => {
    await setStrategy('on');
    const s = await createStrategy(TENANT, orgId, 'u-1', { title: 'Grow ARR', scope: 'org' });
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: STRATEGY_LIST_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { strategies: { id: string; title: string }[] };
    expect(parsed.strategies.some((x) => x.id === s.id && x.title === 'Grow ARR')).toBe(true);
  });

  it('read tools FAIL EMPTY without an acting user (no subjectless enumeration)', async () => {
    await setStrategy('on');
    const list = await provider().executeTool({ name: STRATEGY_LIST_TOOL_ID, input: {} });
    expect(list.isError).toBeFalsy();
    expect(JSON.parse(list.content)).toEqual({ strategies: [] });
    const health = await provider().executeTool({ name: STRATEGY_HEALTH_TOOL_ID, input: {} });
    expect(JSON.parse(health.content)).toEqual({ strategies: [] });
  });

  it('read tools fail closed (typed) when the toggle is off', async () => {
    await setStrategy('off');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: STRATEGY_HEALTH_TOOL_ID, input: {} });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setStrategy('on');
  });

  it('get-strategy is a uniform empty result for a missing/unreadable id (no existence leak)', async () => {
    await setStrategy('on');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: STRATEGY_GET_TOOL_ID, input: { strategyId: 'nope' } });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ strategy: null });
  });
});

describe('CFP-1 — strategy board-memo action: gates + persistence via the documents owner', () => {
  it('requires a human-initiated turn', async () => {
    await setStrategy('on');
    const out = await provider().executeTool({ name: STRATEGY_BOARD_MEMO_TOOL_ID, input: { markdown: '# Memo' } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('fails closed (typed) when the toggle is off', async () => {
    await setStrategy('off');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: STRATEGY_BOARD_MEMO_TOOL_ID, input: { markdown: '# Memo' } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setStrategy('on');
  });

  it('persists a board-update Document and is idempotent within a run', async () => {
    await setStrategy('on');
    const p = provider({ actingUserId: 'u-1', runId: 'run-memo' });
    const a = await p.executeTool({ name: STRATEGY_BOARD_MEMO_TOOL_ID, input: { markdown: '# Q3 board update\n\nOn track.', title: 'Q3 Update' } });
    expect(a.isError).toBeFalsy();
    const ra = JSON.parse(a.content) as { persisted: boolean; documentId: string; version: number };
    expect(ra.persisted).toBe(true);
    expect(ra.documentId).toBeTruthy();
    // Idempotent: an identical memo in the same run reuses the same Document.
    const b = await p.executeTool({ name: STRATEGY_BOARD_MEMO_TOOL_ID, input: { markdown: '# Q3 board update\n\nOn track.', title: 'Q3 Update' } });
    const rb = JSON.parse(b.content) as { documentId: string };
    expect(rb.documentId).toBe(ra.documentId);
  });
});
