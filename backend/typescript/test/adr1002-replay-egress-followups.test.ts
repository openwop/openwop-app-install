/**
 * Replay egress follow-ups to the managed-tier replay work (#5362) — three replay holes the per-tool trace found, each closed
 * at the existing ADR 0531 seam (`assertEffectAllowed`), never a parallel guard.
 *
 *  1. `workflows.compose-and-run` / `workflows.propose` wrote their transient
 *     draft, revision and ownership row BEFORE the `dispatch` guard in
 *     `runStarter`, so a refused replay left an orphan behind. The guard now
 *     runs first.
 *  2. `ai.research.web` caught the replay refusal and answered with EXAMPLE data,
 *     so a replay silently saw a different result. It now propagates, typed.
 *  3. The NATIVE web-search leg dispatched a paid model call with the plain
 *     global fetch, outside every seam. It is now guarded.
 *
 * Mock providers only: `dispatchChat` is a vi.mock, the host search key points
 * at a local server, and each case asserts its live control first so a refusal
 * cannot pass by the path simply not being reached.
 *
 * Sabotage-witnessed (2026-10-28): moving either compose/propose guard back
 * after `registerTransientDraft` reds its case; dropping any `ReplayEffectError`
 * rethrow in `webResearchSurface.ts` reds the host-key or native case; dropping
 * the native-leg guard in `headlessAi.ts` reds the native case.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { dispatchChatMock } = vi.hoisted(() => ({
  dispatchChatMock: vi.fn(async (_req: unknown) => ({
    completion: 'searched',
    citations: [{ url: 'https://example.org/source', title: 'Source' }],
    usage: { inputTokens: 3, outputTokens: 2 },
  })),
}));
vi.mock('../src/providers/dispatch.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/dispatch.js')>();
  return { ...original, dispatchChat: dispatchChatMock };
});

import { openStorage } from '../src/storage/index.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces, buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { ensureSuspendManagerInstalled } from '../src/bootstrap/suspend.js';
import { ensureEventLogInstalled } from '../src/bootstrap/eventLog.js';
import { ensureInvocationLogInstalled } from '../src/bootstrap/invocationLog.js';
import {
  registerWorkflowComposeTool, registerWorkflowProposeTool, registerComposedWorkflowDecisionHandler,
  COMPOSE_AND_RUN_TOOL_ID, PROPOSE_TOOL_ID,
} from '../src/host/workflowComposeTool.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { listRegisteredWorkflows } from '../src/host/workflowsRegistry.js';
import { listOwned } from '../src/host/workflowOwnership.js';
import { runWithEffectContext, ReplayEffectError } from '../src/host/runEffectContext.js';
import { setSecret } from '../src/byok/secretResolver.js';
import { setHeadlessAiDefault, clearHeadlessAiDefault } from '../src/host/headlessAi.js';

const TENANT = 'org:adr1002-followups';
const replaying = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithEffectContext({ runId: 'run-replay-fork', replaying: true, nodeId: 'n', tenantId: TENANT, attempt: 1 }, fn);
const live = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithEffectContext({ runId: 'run-live', replaying: false, nodeId: 'n', tenantId: TENANT, attempt: 1 }, fn);

let searchServer: http.Server;
let searchUrl: string;
let searchHits = 0;
const PREV_EPHEMERAL = process.env.OPENWOP_BYOK_EPHEMERAL;

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr1002-fu-')) });
  ensureNodesRegistered();
  ensureSuspendManagerInstalled(storage);
  ensureEventLogInstalled(storage);
  ensureInvocationLogInstalled(storage);
  const hostSuite = createHostAdapterSuite({ storage });
  registerWorkflowComposeTool({ storage, hostSuite });
  registerWorkflowProposeTool({ workflowCatalog: hostSuite.workflowCatalog });
  registerComposedWorkflowDecisionHandler({ storage, hostSuite });

  searchServer = http.createServer((_req, res) => {
    searchHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ web: { results: [{ url: 'https://example.com/a', title: 'Result A', description: 'snippet A' }] } }));
  });
  await new Promise<void>((res) => searchServer.listen(0, '127.0.0.1', res));
  searchUrl = `http://127.0.0.1:${(searchServer.address() as AddressInfo).port}/search`;
});

afterAll(async () => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  if (PREV_EPHEMERAL === undefined) delete process.env.OPENWOP_BYOK_EPHEMERAL;
  else process.env.OPENWOP_BYOK_EPHEMERAL = PREV_EPHEMERAL;
  await new Promise<void>((res) => searchServer.close(() => res()));
});

const NODES = [{ nodeId: 'a', typeId: 'core.noop' }];
const draftCounts = async (): Promise<{ registry: number; owned: number }> => ({
  registry: listRegisteredWorkflows({ includeTransient: true, includeArchived: true }).length,
  owned: (await listOwned(TENANT)).length,
});

describe.each([
  ['workflows.compose-and-run', COMPOSE_AND_RUN_TOOL_ID, { definition: { nodes: NODES }, inputs: {} }],
  ['workflows.propose', PROPOSE_TOOL_ID, { definition: { nodes: NODES }, summary: 'Run the noop.' }],
] as const)('%s — a refused replay leaves no orphan draft', (_label, toolId, input) => {
  const run = (): Promise<{ content: string; isError?: boolean; errorCode?: string }> =>
    createAgentToolProvider({ tenantId: TENANT, agentProfileId: 'agent-under-test' }).executeTool({ name: toolId, input });

  it('live control: the tool writes a draft (so the replay case is not vacuous)', async () => {
    const before = await draftCounts();
    const r = await live(run);
    expect(r.isError, r.content).toBeUndefined();
    const after = await draftCounts();
    expect(after.registry).toBe(before.registry + 1);
    expect(after.owned).toBe(before.owned + 1);
  });

  it('replay: refused with replay_source_missing BEFORE any draft, revision or ownership row', async () => {
    const before = await draftCounts();
    const r = await replaying(run);
    expect(r.isError).toBe(true);
    expect(r.errorCode).toBe('replay_source_missing');
    expect(await draftCounts()).toEqual(before);
  });
});

describe('ai.research.web — a refused egress on replay is a typed refusal, never example data', () => {
  const wr = () => buildHostSurfaceBundle({ tenantId: TENANT }).webResearch;

  it('host search key: live searches the provider; a replay throws ReplayEffectError and never reaches it', async () => {
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'k';
    process.env.OPENWOP_WEBSEARCH_BASE_URL = searchUrl;
    try {
      const hitsBefore = searchHits;
      const ok = await live(() => wr().search({ query: 'venues' }));
      expect(ok.engine).not.toBe('demo');
      expect(searchHits).toBe(hitsBefore + 1);

      const err = await replaying(() => wr().search({ query: 'venues' })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReplayEffectError);
      expect((err as ReplayEffectError).code).toBe('replay_source_missing');
      expect(searchHits).toBe(hitsBefore + 1);

      // The composed op (search + fetch) the agent tool calls refuses the same way.
      await expect(replaying(() => wr().research({ query: 'venues' }))).rejects.toBeInstanceOf(ReplayEffectError);
    } finally {
      delete process.env.OPENWOP_WEBSEARCH_API_KEY;
      delete process.env.OPENWOP_WEBSEARCH_BASE_URL;
    }
  });

  it('a page fetch refused on replay propagates instead of becoming a status-0 page', async () => {
    const err = await replaying(() => wr().fetchBatch({ urls: ['https://example.com/a'] })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplayEffectError);
  });

  it('NATIVE leg (no host key): live makes one model call; a replay makes ZERO and refuses typed', async () => {
    await setSecret('gem', 'KEY', { tenantId: TENANT });
    await setHeadlessAiDefault({ tenantId: TENANT }, { provider: 'google', model: 'gemini-3.8-flash', credentialRef: 'gem' }, new Date().toISOString());
    try {
      dispatchChatMock.mockClear();
      const ok = await live(() => wr().search({ query: 'venues' }));
      expect(ok.engine).toBe('native:google');
      expect(dispatchChatMock).toHaveBeenCalledTimes(1);

      dispatchChatMock.mockClear();
      const err = await replaying(() => wr().search({ query: 'venues' })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReplayEffectError);
      expect(dispatchChatMock).not.toHaveBeenCalled();
    } finally {
      await clearHeadlessAiDefault(TENANT);
    }
  });
});
