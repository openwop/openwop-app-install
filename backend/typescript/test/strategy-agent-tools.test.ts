/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — the Strategy Analyst's REAL conversational
 * tools resolve + enforce the same authority as the strategy routes. Boots the
 * REAL app (the ADR 0308 D2 registration seam is what's under test), mirroring
 * app-builder-agent-tools.test.ts.
 *
 * /grade-tests wave 19 sabotage witnesses: dropping `canSubjectReadStrategy` from the list or
 * get tool reds the authority-parity cases (a creator-only draft of ANOTHER user); forcing the
 * toggle on reds both typed-off cases; salting the memo key reds idempotency; minting the memo
 * with the wrong kind reds the read-back. The tool's own "no acting user ⇒ empty" guard is a
 * DOUBLE GUARD with `canSubjectReadStrategy`'s `if (!subject) return false` — removing either
 * alone stays green (recorded ceiling); the case still asserts the observable contract.
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
import { getDocument, listVersions } from '../src/features/documents/documentsService.js';

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
  const packDir = new URL('../../../packs/vendor.openwop-app.strategy.agents/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as { agents: { toolAllowlist: string[] }[] };

  // One case: the allowlist is exactly the five ids AND each is registered. (A separate
  // "all five register" case was folded in — wave 19: the corpus-wide registered-set pins
  // `safe-mode-baseline-census` + `schema-read-exemption-completeness` also red on a rename.)
  it('the allowlist is exactly the five registered tool ids', () => {
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual([...ALL_IDS].sort());
    const ids = builtinAgentToolIds();
    for (const id of ALL_IDS) expect(ids, `${id} is not registered`).toContain(id);
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
    // Authority parity: another user's creator-only draft is NOT listed (route: creator-only).
    const hidden = await createStrategy(TENANT, orgId, 'u-2', { title: 'Hidden draft', scope: 'user' });
    const again = JSON.parse((await provider({ actingUserId: 'u-1' }).executeTool({ name: STRATEGY_LIST_TOOL_ID, input: {} })).content) as { strategies: { id: string }[] };
    expect(again.strategies.map((x) => x.id), 'an unreadable draft was listed').not.toContain(hidden.id);
    expect(again.strategies.map((x) => x.id)).toContain(s.id);
  });

  it('read tools FAIL EMPTY without an acting user (no subjectless enumeration)', async () => {
    await setStrategy('on');
    // A shared strategy exists, so an empty result is the guard — not an empty tenant.
    await createStrategy(TENANT, orgId, 'u-1', { title: 'Exists', scope: 'org' });
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
    // UNREADABLE (another user's creator-only draft) answers exactly like missing…
    const hidden = await createStrategy(TENANT, orgId, 'u-2', { title: 'Private draft', scope: 'user' });
    const denied = await provider({ actingUserId: 'u-1' }).executeTool({ name: STRATEGY_GET_TOOL_ID, input: { strategyId: hidden.id } });
    expect(denied.isError).toBeFalsy();
    expect(JSON.parse(denied.content), 'an unreadable strategy leaked through get-strategy').toEqual({ strategy: null });
    // …and the positive control: its creator reads it.
    const mine = await provider({ actingUserId: 'u-2' }).executeTool({ name: STRATEGY_GET_TOOL_ID, input: { strategyId: hidden.id } });
    expect((JSON.parse(mine.content) as { strategy: { title?: string } | null }).strategy?.title).toBe('Private draft');
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
    // Read the Document back: it exists, is a board-update, and carries the memo.
    const doc = await getDocument(TENANT, orgId, ra.documentId);
    expect(doc?.kind).toBe('board-update');
    expect(doc?.title).toBe('Q3 Update');
    // Idempotent: an identical memo in the same run reuses the same Document.
    const b = await p.executeTool({ name: STRATEGY_BOARD_MEMO_TOOL_ID, input: { markdown: '# Q3 board update\n\nOn track.', title: 'Q3 Update' } });
    const rb = JSON.parse(b.content) as { documentId: string };
    expect(rb.documentId).toBe(ra.documentId);
    const versions = await listVersions(TENANT, orgId, ra.documentId);
    expect(versions, 'the retry added a second version').toHaveLength(1);
    expect(versions[0]!.content).toBe('# Q3 board update\n\nOn track.');
  });
});
