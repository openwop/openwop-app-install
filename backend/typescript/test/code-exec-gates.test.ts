/**
 * CFP A10 (Phase-2 security fix) — the code-exec approval gate across lanes +
 * the execution-result artifact projection.
 *
 * The corrected finding: the CHAT lane already gates the SENSITIVE tools via the
 * ADR 0150 firewall (conversationToolLoop wires SENSITIVE_APPROVAL_TOOLS). The
 * real gaps were:
 *   1. the RUN lane (workflow / scheduled / heartbeat dispatch via
 *      `agentRunnerNode` → `runAgentDispatchLive`) had NO firewall, so a
 *      SENSITIVE tool ran ungated. A `require-approval` verdict now surfaces as an
 *      ESCALATED dispatch result (held tool names + honest message), never a
 *      silent completion or a raw execution;
 *   2. the VOICE lane built its firewall without `requireApprovalTools` and only
 *      when the tenant had rules — so it too ran SENSITIVE tools ungated (proven
 *      here against the exact hook options both lanes now pass);
 *   3. the chat CODE_EXEC builtin dropped the advertised `code.execution-result`
 *      artifact — it now persists one via `persistRunArtifact` and returns its
 *      id/key, readable back with a matching tenant.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { runAgentDispatchLive, type AgentToolDef, type LiveDispatchDeps } from '../src/host/agentDispatch.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { getRunArtifact, __resetRunArtifactStore } from '../src/host/runArtifactStore.js';
import { registerCodeExecArtifactType } from '../src/features/code-exec/artifactTypes.js';
import { buildFirewallHook, SENSITIVE_APPROVAL_TOOLS } from '../src/features/capability-firewall/firewallHook.js';
import type { AiCallResult, AiToolCallResult } from '../src/executor/types.js';

const CODE_EXEC_ID = 'openwop:feature.code-exec.nodes.run';

// ── the sandbox seam: a local HTTP endpoint that returns a canned exec result ──
let sandbox: http.Server;
beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerCodeExecArtifactType(); // idempotent (Map.set) — makes the typed projection honored
  sandbox = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ exitCode: 0, stdout: '42\n', stderr: '', timedOut: false }));
  });
  await new Promise<void>((r) => sandbox.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_CODE_EXEC_ENDPOINT = `http://127.0.0.1:${(sandbox.address() as AddressInfo).port}/exec`;
});
afterAll(async () => {
  delete process.env.OPENWOP_CODE_EXEC_ENDPOINT;
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  await new Promise<void>((r) => sandbox.close(() => r()));
});
beforeEach(async () => { await __resetRunArtifactStore(); });

describe('chat CODE_EXEC — execution-result artifact projection', () => {
  it('a successful run returns artifact fields and the artifact is readable by matching tenant', async () => {
    const provider = createAgentToolProvider({ tenantId: 't-code', conversationId: 'conv-1', actingUserId: 'u-1' });
    const res = await provider.executeTool({ name: CODE_EXEC_ID, input: { code: 'print(6*7)' } });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content) as { exitCode: number; stdout: string; artifactId?: string; artifactKey?: string };
    // The tool result still carries the raw execution output …
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain('42');
    // … PLUS the newly-projected artifact reference.
    expect(typeof body.artifactId).toBe('string');
    // DATA-1 — the synthetic runId is tenant-prefixed (no cross-tenant key collision).
    expect(body.artifactKey).toContain('chat-code:t-code:conv-1');

    // The artifact is durable, typed, and tenant-scoped.
    const record = await getRunArtifact(body.artifactKey!);
    expect(record).toBeTruthy();
    expect(record!.tenantId).toBe('t-code');
    expect(record!.artifactTypeId).toBe('code.execution-result');
    expect(record!.content).toContain('42');
  });

  it('is deterministic: the same code re-run does not mint a second artifact', async () => {
    const provider = createAgentToolProvider({ tenantId: 't-code', conversationId: 'conv-2', actingUserId: 'u-1' });
    const first = JSON.parse((await provider.executeTool({ name: CODE_EXEC_ID, input: { code: 'print(1)' } })).content);
    const again = JSON.parse((await provider.executeTool({ name: CODE_EXEC_ID, input: { code: 'print(1)' } })).content);
    expect(again.artifactId).toBe(first.artifactId);
    expect(again.artifactKey).toBe(first.artifactKey);
  });
});

describe('capability firewall — the RUN + VOICE lanes gate SENSITIVE code-exec', () => {
  // Both lanes now build the hook with these exact options. This locks the
  // safe-mode baseline: code-exec needs approval even with NO tenant rules.
  const laneHook = (bypass: boolean) => buildFirewallHook({
    rules: [],
    requireApprovalTools: SENSITIVE_APPROVAL_TOOLS,
    bypassApproval: bypass,
  });

  it('require-approval for code-exec when not pre-authorized (bypassApproval:false)', () => {
    expect(laneHook(false).evaluate([], CODE_EXEC_ID).decision).toBe('require-approval');
  });

  it('the OLD voice behavior (no requireApprovalTools, rule-less) would have ALLOWED it — the bug being fixed', () => {
    expect(buildFirewallHook({ rules: [] }).evaluate([], CODE_EXEC_ID).decision).toBe('allow');
  });

  it('a non-sensitive tool is unaffected (still allow)', () => {
    expect(laneHook(false).evaluate([], 'openwop:knowledge.search').decision).toBe('allow');
  });
});

describe('runAgentDispatchLive — a held SENSITIVE tool escalates (does not execute)', () => {
  const CODE_TOOL: AgentToolDef = {
    name: CODE_EXEC_ID,
    description: 'Run code',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
  };
  const resolveCode: LiveDispatchDeps['resolveTool'] = (n) => (n === CODE_EXEC_ID ? CODE_TOOL : undefined);
  const callAINever: LiveDispatchDeps['callAI'] = async (): Promise<AiCallResult> => { throw new Error('callAI must not be used'); };

  beforeEach(() => {
    getAgentRegistry().register({
      agentId: 'coder.agent', persona: 'Coder', modelClass: 'research',
      systemPrompt: 'Use code.', packName: 'test', packVersion: '0',
      toolAllowlist: [CODE_EXEC_ID], confidence: { defaultThreshold: 0.5 },
    });
  });
  afterEach(() => getAgentRegistry()._resetForTest());

  it('the model asks for code-exec, the firewall holds it, the run ESCALATES and the tool never runs', async () => {
    const callAIWithTools = async (): Promise<AiToolCallResult> =>
      ({ toolCalls: [{ id: 'c1', name: CODE_EXEC_ID, input: { code: 'print(1)' } }], finishReason: 'tool-call' });
    let executed = 0;
    const executeTool: LiveDispatchDeps['executeTool'] = async () => { executed += 1; return { content: 'ran' }; };
    // The run-lane firewall, exactly as agentRunnerNode builds it (safe mode, no bypass).
    const firewall = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, bypassApproval: false });

    const res = await runAgentDispatchLive(
      { agentId: 'coder.agent', task: 'run some code', availableTools: [CODE_EXEC_ID] },
      { callAI: callAINever, callAIWithTools, executeTool, resolveTool: resolveCode, firewall },
    );

    expect(res.status).toBe('escalated');
    expect(executed).toBe(0); // the SENSITIVE tool NEVER executed
    const result = res.result as { status?: string; heldTools?: string[] };
    expect(result.status).toBe('awaiting_approval');
    expect(result.heldTools).toContain(CODE_EXEC_ID);
  });

  it('WITHOUT the firewall the same call executes (the ungated path the fix closes)', async () => {
    let round = 0;
    const callAIWithTools = async (): Promise<AiToolCallResult> => {
      round += 1;
      if (round === 1) return { toolCalls: [{ id: 'c1', name: CODE_EXEC_ID, input: { code: 'print(1)' } }], finishReason: 'tool-call' };
      return { content: 'done', toolCalls: [], finishReason: 'stop' };
    };
    let executed = 0;
    const executeTool: LiveDispatchDeps['executeTool'] = async () => { executed += 1; return { content: 'ran' }; };

    const res = await runAgentDispatchLive(
      { agentId: 'coder.agent', task: 'run some code', availableTools: [CODE_EXEC_ID] },
      { callAI: callAINever, callAIWithTools, executeTool, resolveTool: resolveCode },
    );

    expect(res.status).toBe('completed');
    expect(executed).toBe(1); // ungated — proves the firewall is what gates
  });
});
