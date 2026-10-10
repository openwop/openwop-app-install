/**
 * ADR 0764 D3 (`CHATWF-3`) — starting a run is a guarded effect.
 *
 * The agent-runner node behind a chat's deep @mention is deliberately
 * unclassified, so a `:fork` RE-EXECUTES it with provider calls served from the
 * invocation log — the same tool calls re-fire. Before this guard,
 * `startWorkflowRun` had no `assertEffectAllowed`, so every run-starting tool
 * started a duplicate REAL run on the fork.
 *
 * Driven through the REAL `startWorkflowRun` and the REAL tool provider (not a
 * stubbed starter — the stub is exactly how the prior deep-investigation test
 * could not see this), inside the same ambient context the executor wraps every
 * node execution in.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { createHostAdapterSuite, type HostAdapterSuite } from '../src/host/index.js';
import type { Storage } from '../src/storage/storage.js';
import { startWorkflowRun } from '../src/host/runStarter.js';
import { runWithEffectContext, ReplayEffectError, LeaseLostError, markDispatchLeaseLost } from '../src/host/runEffectContext.js';
import { registerWorkflowComposeTool, COMPOSE_AND_RUN_TOOL_ID } from '../src/host/workflowComposeTool.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { ensureSuspendManagerInstalled } from '../src/bootstrap/suspend.js';
import { ensureEventLogInstalled } from '../src/bootstrap/eventLog.js';
import { ensureInvocationLogInstalled } from '../src/bootstrap/invocationLog.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { SEAM_CALL_SITES } from '../src/host/effectSeamManifest.js';

const TENANT = 'org:run-start-guard';
let storage: Storage;
let hostSuite: HostAdapterSuite;

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-runstart-')) });
  ensureNodesRegistered();
  ensureSuspendManagerInstalled(storage);
  ensureEventLogInstalled(storage);
  ensureInvocationLogInstalled(storage);
  hostSuite = createHostAdapterSuite({ storage });
  registerWorkflowComposeTool({ storage, hostSuite });
});

const runCount = async () => (await storage.listRuns({ tenantId: TENANT, limit: 1000 })).length;

describe('ADR 0764 D3 — startWorkflowRun is an effect seam', () => {
  it('is classified in the RFC 0173 manifest', () => {
    expect(SEAM_CALL_SITES.find((c) => c.file === 'src/host/runStarter.ts')?.seam).toBe('queue.run-start');
  });

  it('a replay fork is REFUSED and writes no run row', async () => {
    const before = await runCount();
    await expect(
      runWithEffectContext({ runId: 'fork-under-test', replaying: true }, () =>
        startWorkflowRun({ storage, hostSuite }, { tenantId: TENANT, workflowId: 'openwop-app.uppercase', inputs: { text: 'x' } }),
      ),
    ).rejects.toBeInstanceOf(ReplayEffectError);
    expect(await runCount()).toBe(before);
  });

  it('a LIVE node execution still starts the run (the guard only bites on replay)', async () => {
    const before = await runCount();
    const runId = await runWithEffectContext({ runId: 'live-parent', replaying: false }, () =>
      startWorkflowRun({ storage, hostSuite }, { tenantId: TENANT, workflowId: 'openwop-app.uppercase', inputs: { text: 'x' } }),
    );
    expect(runId).toBeTruthy();
    expect(await runCount()).toBe(before + 1);
  });

  it('an agent tool re-fired on a fork returns a tool error NAMING the refusal — no duplicate run', async () => {
    // What the agent-runner's loop actually sees: the provider swallows the throw
    // into a tool error and carries the structured code (it does NOT fail the node —
    // ADR 0764 B1 corrected the draft that claimed it did).
    const provider = createAgentToolProvider({ tenantId: TENANT, agentProfileId: 'agent-under-test' });
    const before = await runCount();
    const out = await runWithEffectContext({ runId: 'fork-under-test', replaying: true }, () =>
      provider.executeTool({ name: COMPOSE_AND_RUN_TOOL_ID, input: { definition: { nodes: [{ nodeId: 'a', typeId: 'core.noop' }] } } }),
    ) as { content: string; isError?: boolean; errorCode?: string };
    expect(out.isError).toBe(true);
    expect(out.errorCode).toBe('replay_source_missing');
    expect(await runCount()).toBe(before);
  });

  it('a LOST LEASE propagates out of the tool provider — never swallowed into a tool result (CHATCD-3)', async () => {
    const provider = createAgentToolProvider({ tenantId: TENANT, agentProfileId: 'agent-under-test' });
    markDispatchLeaseLost('reclaimed-run');
    const before = await runCount();
    await expect(runWithEffectContext({ runId: 'reclaimed-run', replaying: false }, () =>
      provider.executeTool({ name: COMPOSE_AND_RUN_TOOL_ID, input: { definition: { nodes: [{ nodeId: 'a', typeId: 'core.noop' }] } } }),
    )).rejects.toBeInstanceOf(LeaseLostError);
    expect(await runCount()).toBe(before);
  });
});
