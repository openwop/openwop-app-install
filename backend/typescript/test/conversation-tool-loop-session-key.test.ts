/**
 * ADR 0132 / ADR 0773 B.2 — the tool loop reads a conversation's capability
 * scope by the chat SESSION id.
 *
 * ConversationMeta (where the scope lives) is keyed by the chat session id; the
 * chat UI's scope control writes by it, and so does the Pair context route. The
 * loop used to read it by the run-derived gate id (`runId:nodeId:0`), so on every
 * chat-started run a scope set from the UI never narrowed anything. This drives
 * the REAL turn entry with the managed round stubbed and asserts what the model
 * is OFFERED — the observable, not the store.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const offered: string[][] = [];
vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return {
    ...actual,
    dispatchManagedToolsRound: vi.fn(async (req: { tools: Array<{ name: string }> }) => {
      offered.push(req.tools.map((t) => t.name));
      return { text: 'done', toolUses: [] };
    }),
  };
});

import { runConversationAgentToolTurn } from '../src/host/conversationToolLoop.js';
import { setConversationCapabilityScope } from '../src/host/conversationStore.js';
import type { ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import type { RunRecord } from '../src/types.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';

const TENANT = 'tenant-scope-key';
const ONLY = 'openwop:kanban.add-todo';
const agent = { agentId: 'a', persona: 'P', toolAllowlist: [] } as unknown as ResolvedAgentManifest;
const run = (metadata: Record<string, unknown>, runId: string): RunRecord =>
  ({ runId, tenantId: TENANT, inputs: { credentialRef: 'managed:openwop-free' }, metadata } as unknown as RunRecord);

async function offeredFor(r: RunRecord): Promise<string[]> {
  offered.length = 0;
  await runConversationAgentToolTurn({
    run: r, agent, systemPrompt: 'sp', history: [{ role: 'user', content: 'hi' }],
    runId: r.runId, nodeId: 'n', conversationId: `${r.runId}:n:0`,
    policyResolver: (() => undefined) as unknown as ProviderPolicyResolver,
  });
  expect(offered.length).toBeGreaterThan(0);
  return offered[0]!;
}

let reset: () => void = () => {};
beforeAll(async () => {
  const { initHostExtPersistence, __resetHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
  const { openStorage } = await import('../src/storage/index.js');
  initHostExtPersistence(await openStorage('memory://'));
  reset = __resetHostExtPersistence;
});
afterAll(() => reset());

describe('the tool loop reads the capability scope by the chat session id', () => {
  it('control: with no scope, the baseline offers more than one tool (so the narrowing below is observable)', async () => {
    const all = await offeredFor(run({ chatSessionId: 'sess-none' }, 'run-control'));
    expect(all).toContain(ONLY);
    expect(all.length).toBeGreaterThan(1);
  });

  it('a scope written under the SESSION id narrows a chat-started run', async () => {
    await setConversationCapabilityScope(TENANT, 'sess-1', { mode: 'restricted', enabled: [ONLY] });
    expect(await offeredFor(run({ chatSessionId: 'sess-1' }, 'run-1'))).toEqual([ONLY]);
  });

  it('a run with no session stamp still reads by the gate id (the fallback)', async () => {
    await setConversationCapabilityScope(TENANT, 'run-2:n:0', { mode: 'restricted', enabled: [ONLY] });
    expect(await offeredFor(run({}, 'run-2'))).toEqual([ONLY]);
  });
});
