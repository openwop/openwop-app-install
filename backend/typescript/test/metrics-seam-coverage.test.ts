/**
 * ADR 0556 P1 — the seams the golden-path suite cannot reach over HTTP.
 *
 * `metrics-golden-telemetry.test.ts` drives success / failure / retry / replay /
 * recovery through a booted app. The seams here are equally real functions, but
 * reaching them through the HTTP surface would need a live model provider, an
 * enabled MCP mount, a signed attestation manifest and a quorum of approvers —
 * so each is called at its own entry point instead. What does NOT change is the
 * standard: every assertion is the whole attribute object, and every test is
 * red when its instrumentation call is deleted.
 *
 * The recurring question these answer is not "did a counter move" but "can a
 * VALUE that a peer, a tenant or a provider chose reach a label". Each seam
 * therefore has an adversarial case: a method name a scanner invented, an error
 * body a provider echoed, a language an author asked for.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import {
  _resetMetricsForTest,
  emissionsOf,
  labelViolations,
} from '../src/observability/metrics.js';
import { runWithAuthority, recordAuthorityAction } from '../src/host/authorityContext.js';
import {
  classifyMcpClientOutcome,
  classifySandboxError,
  classifyWorkflowKind,
} from '../src/observability/metricSeams.js';
import {
  digestOf,
  nextCompensationOrdinal,
  recordObligation,
  resolveObligation,
  _resetCompensationLedgerForTest,
} from '../src/host/compensationLedger.js';
import {
  declarationKey,
  unwindRun,
  type CompensationDeclaration,
  type InverseOutcome,
} from '../src/host/compensationUnwind.js';
import { handleA2aRequest } from '../src/host/a2aServer.js';
import { dispatch as mcpDispatch } from '../src/host/mcpServerRouter.js';
import { runInSandbox } from '../src/host/sandbox.js';
import { createAiProvidersAdapter } from '../src/aiProviders/aiProvidersHost.js';
import { getSuspendManager, setSuspendBackend } from '../src/executor/suspendManager.js';
import { timeoutApprovalGateIfDue } from '../src/executor/approvalGateTimeout.js';
import { sweepDueTimers } from '../src/executor/timerResume.js';
import type { Storage } from '../src/storage/storage.js';
import type { AiProviderPolicy, ProviderPolicyResolver } from '../src/host/index.js';

let server: http.Server;
let BASE: string;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
  storage = app.locals.storage as Storage;
  setSuspendBackend(storage);
});

afterAll(async () => {
  delete process.env.OPENWOP_A2A_SERVER_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(async () => {
  _resetMetricsForTest();
  await _resetCompensationLedgerForTest();
});

function attrsOf(name: string): Array<Record<string, unknown>> {
  return emissionsOf(name).map((e) => ({ ...e.attributes }));
}

describe('ADR 0556 P1 — compensation (RFC 0151)', () => {
  const base = {
    tenantId: 't-metrics',
    runId: 'run-metrics-1',
    forwardLogicalInvocationId: 'inv-1',
    compensationOrdinal: 1,
    effectKind: 'payment' as const,
    shape: 'forward-effect' as const,
    resultDigest: 'rd',
    contractDigest: 'cd',
  };

  it('records an obligation once per COMMITTED effect, not once per call', async () => {
    const first = await recordObligation(base);
    // First-write-wins: a replayed or re-dispatched run must not mint a second
    // obligation, and the counter has to agree with the ledger. A counter placed
    // before the dedupe would report two refunds owed where one is.
    await recordObligation(base);

    expect(attrsOf('openwop.compensation.obligation')).toEqual([
      { effect_kind: 'payment', shape: 'forward-effect' },
    ]);

    _resetMetricsForTest();
    await resolveObligation({
      tenantId: base.tenantId,
      inverseActionId: first.inverseActionId,
      to: 'started',
      reason: 'unwinding',
    });
    await resolveObligation({
      tenantId: base.tenantId,
      inverseActionId: first.inverseActionId,
      to: 'failed',
      reason: 'gateway refused',
    });
    // `failed` is NOT terminal by design (a compensation is itself an effect
    // that can fail), so partial unwind must be visible as its own state rather
    // than collapsed into a generic "not completed".
    expect(attrsOf('openwop.compensation.resolved')).toEqual([
      { effect_kind: 'payment', state: 'started' },
      { effect_kind: 'payment', state: 'failed' },
    ]);
  });

  it('an ILLEGAL transition is a bug, not an unwind outcome — it is not counted', async () => {
    const row = await recordObligation({ ...base, forwardLogicalInvocationId: 'inv-2' });
    await resolveObligation({ tenantId: base.tenantId, inverseActionId: row.inverseActionId, to: 'started', reason: 'go' });
    await resolveObligation({ tenantId: base.tenantId, inverseActionId: row.inverseActionId, to: 'completed' });
    _resetMetricsForTest();

    // `completed` is terminal — re-running it is a double-undo, which for a
    // `forward-effect` shape means a second refund.
    await expect(
      resolveObligation({ tenantId: base.tenantId, inverseActionId: row.inverseActionId, to: 'started', reason: 'again' }),
    ).rejects.toThrow(/illegal compensation transition/);
    expect(emissionsOf('openwop.compensation.resolved')).toHaveLength(0);
  });
});

describe('ADR 0556 P1 — the REAL unwind drives the compensation metrics', () => {
  // The tests above call `recordObligation`/`resolveObligation` directly, which
  // proves the ledger emits but not that anything CALLS it. ADR 0554 P2 shipped
  // the unwind that does — so this drives `unwindRun`, the actual producer, and
  // asserts the metric sees a real reverse-completion pass. Without it, the
  // compensation counters could stay at zero in production while every ledger
  // test stayed green.
  const T = 'tenant-metrics-unwind';
  const ROOT = 'run-metrics-unwind';
  const REFUND: CompensationDeclaration = {
    nodeTypeId: 'test.payment.refund',
    inputMapping: { chargeId: 'ch_1' },
    retry: { maxAttempts: 2, backoffMs: 0 },
  };

  async function commit(nodeId: string) {
    return recordObligation({
      tenantId: T,
      runId: ROOT,
      rootRunId: ROOT,
      nodeId,
      compensationNodeTypeId: REFUND.nodeTypeId,
      forwardLogicalInvocationId: `${ROOT}:${nodeId}`,
      compensationOrdinal: await nextCompensationOrdinal(T, ROOT),
      effectKind: 'payment',
      shape: 'forward-effect',
      resultDigest: digestOf({ charged: nodeId }),
      contractDigest: digestOf(REFUND),
    });
  }

  it('a successful unwind emits started→completed per obligation, in reverse order', async () => {
    await commit('charge-1');
    await commit('charge-2');
    expect(attrsOf('openwop.compensation.obligation')).toEqual([
      { effect_kind: 'payment', shape: 'forward-effect' },
      { effect_kind: 'payment', shape: 'forward-effect' },
    ]);

    _resetMetricsForTest();
    await unwindRun({
      tenantId: T,
      runId: ROOT,
      declarations: new Map([
        [declarationKey(ROOT, 'charge-1'), REFUND],
        [declarationKey(ROOT, 'charge-2'), REFUND],
      ]),
      deps: {
        async appendEvent() { /* the §D event lane is ADR 0554's own concern */ },
        async markPlanRequested() { /* the §D rollup is ADR 0554's concern too */ },
        async invoke(): Promise<InverseOutcome> { return { ok: true }; },
        async sleep() { /* no wall-clock in tests */ },
      },
    });

    // Two obligations, each started then completed — the transitions an operator
    // reads to decide whether an unwind actually finished.
    expect(attrsOf('openwop.compensation.resolved')).toEqual([
      { effect_kind: 'payment', state: 'started' },
      { effect_kind: 'payment', state: 'completed' },
      { effect_kind: 'payment', state: 'started' },
      { effect_kind: 'payment', state: 'completed' },
    ]);
  });

  it('a retried-then-exhausted inverse surfaces as `failed`, not as a silent gap', async () => {
    await commit('charge-solo');
    _resetMetricsForTest();

    await unwindRun({
      tenantId: T,
      runId: ROOT,
      declarations: new Map([[declarationKey(ROOT, 'charge-solo'), REFUND]]),
      deps: {
        async appendEvent() { /* … */ },
        async markPlanRequested() { /* the §D rollup is ADR 0554's concern too */ },
        async invoke(): Promise<InverseOutcome> { return { ok: false, retryable: true, detail: 'gateway refused' }; },
        async sleep() { /* … */ },
      },
    });

    // `failed` is NON-terminal by design (a compensation is itself an effect
    // that can fail and be retried), so it MUST appear as its own state. If the
    // unwind ended without emitting it, an operator would see an obligation
    // that started and never resolved — indistinguishable from a hung process.
    const states = attrsOf('openwop.compensation.resolved').map((a) => a.state);
    expect(states).toContain('started');
    expect(states).toContain('failed');
    expect(states).not.toContain('completed');
  });

  it('an UNRESOLVABLE inverse reaches `manual_intervention_required` — the state SLO C1 alerts on', async () => {
    // Added because a sabotage went green: flipping `markManual`'s target state
    // to `completed` was undetected, since the two legs above park at `failed`
    // and never reach that path. `docs/SLO.md` C1 is an objective ON this state
    // ("≤ 0.1% of obligations"), so an SLO existed for a series no test proved
    // could be emitted. A non-retryable outcome is what drives it: no retry can
    // fix an unresolvable node type, so an operator must.
    await commit('charge-manual');
    _resetMetricsForTest();

    await unwindRun({
      tenantId: T,
      runId: ROOT,
      declarations: new Map([[declarationKey(ROOT, 'charge-manual'), REFUND]]),
      deps: {
        async appendEvent() { /* the §D event lane is ADR 0554's own concern */ },
        async markPlanRequested() { /* the §D rollup is ADR 0554's concern too */ },
        async invoke(): Promise<InverseOutcome> {
          return { ok: false, retryable: false, detail: 'no such compensator node type' };
        },
        async sleep() { /* no wall-clock in tests */ },
      },
    });

    const states = attrsOf('openwop.compensation.resolved').map((a) => a.state);
    expect(states).toContain('manual_intervention_required');
    // And NOT completed — reporting a human-blocked unwind as clean is the
    // failure mode C1 exists to catch.
    expect(states).not.toContain('completed');
  });
});

describe('ADR 0556 P1 — interrupt age', () => {
  it('counts the interrupt at creation and its AGE at resolution', async () => {
    const created = await getSuspendManager().createInterrupt({
      runId: 'run-interrupt-1',
      nodeId: 'gate',
      kind: 'approval',
      data: { timeoutSec: 1 },
    });
    expect(attrsOf('openwop.interrupt.created')).toEqual([{ interrupt_kind: 'approval' }]);

    _resetMetricsForTest();
    // Not yet due: the gate has a deadline in the future, so nothing resolves
    // and nothing is measured. Without this the next assertion could pass on a
    // seam that fires unconditionally.
    expect(await timeoutApprovalGateIfDue(storage, created, Date.parse(created.createdAt) + 500)).toBe(false);
    expect(emissionsOf('openwop.interrupt.age')).toHaveLength(0);

    const dueAt = Date.parse(created.createdAt) + 90_000;
    expect(await timeoutApprovalGateIfDue(storage, created, dueAt)).toBe(true);

    const ages = emissionsOf('openwop.interrupt.age');
    expect(ages).toHaveLength(1);
    expect(ages[0]!.attributes).toEqual({ interrupt_kind: 'approval', resolution: 'timeout' });
    // The age is measured from the RECORD's own `createdAt`, not from a caller's
    // stopwatch: a sweep on another instance still reports the real wait.
    expect(ages[0]!.value).toBeCloseTo(90, 0);
  });

  it('a LOSING compare-and-set records nothing — one wait, one observation', async () => {
    const created = await getSuspendManager().createInterrupt({
      runId: 'run-interrupt-2',
      nodeId: 'gate',
      kind: 'approval',
      data: { timeoutSec: 1 },
    });
    const dueAt = Date.parse(created.createdAt) + 60_000;
    expect(await timeoutApprovalGateIfDue(storage, created, dueAt)).toBe(true);

    _resetMetricsForTest();
    // A second sweep over the SAME in-memory record loses the CAS (the row is
    // already resolved). Counting the attempt would inflate the histogram with
    // duplicate observations of a single human wait.
    expect(await timeoutApprovalGateIfDue(storage, created, dueAt)).toBe(false);
    expect(emissionsOf('openwop.interrupt.age')).toHaveLength(0);
  });
});

describe('ADR 0556 P1 — A2A request outcomes and version negotiation', () => {
  const opts = { agentCard: { name: 'test' }, availableTools: [] };

  it('counts a served method and its outcome', async () => {
    await handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'agent/getCard' }, opts);
    expect(attrsOf('openwop.a2a.request')).toEqual([{ method: 'agent/getCard', outcome: 'ok' }]);
  });

  it('folds a method the PEER invented onto `unknown` — one series, not one per probe', async () => {
    for (const method of ['drop/tables', 'admin/../../etc/passwd', 'x'.repeat(4096)]) {
      await handleA2aRequest({ jsonrpc: '2.0', id: 1, method }, opts);
    }
    // Three hostile method strings, ONE time series. Passing `req.method`
    // straight through would have minted three — and a scanner mints thousands.
    expect(attrsOf('openwop.a2a.request')).toEqual([
      { method: 'unknown', outcome: 'method_not_found' },
      { method: 'unknown', outcome: 'method_not_found' },
      { method: 'unknown', outcome: 'method_not_found' },
    ]);
  });

  it('counts a params error distinctly from a not-found', async () => {
    await handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} }, opts);
    expect(attrsOf('openwop.a2a.request')).toEqual([{ method: 'message/send', outcome: 'invalid_params' }]);
  });

  it('records the version DISPOSITION at the route, never the requested version', async () => {
    const rq = (headers: Record<string, string>) =>
      fetch(`${BASE}/v1/host/openwop-app/a2a`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent/getCard' }),
      });

    await rq({});                              // a 0.3-era peer sends no header
    await rq({ 'a2a-version': '0.3' });
    await rq({ 'a2a-version': '99.9-attacker-controlled' });

    // The `profile` label (added 2026-08-18, ADR 0552 P4) is what makes the
    // legacy-retirement question answerable: `absent` IS a 0.3 request under
    // §B's receiver rule, so disposition alone cannot separate the populations.
    expect(attrsOf('openwop.protocol.version')).toEqual([
      { protocol: 'a2a', disposition: 'absent', profile: 'a2a-0.3-legacy' },
      { protocol: 'a2a', disposition: 'served', profile: 'a2a-0.3-legacy' },
      { protocol: 'a2a', disposition: 'unsupported', profile: 'none' },
    ]);
    // The requested version is peer-supplied; if it reached a label, one header
    // per request would be one time series per request.
    expect(JSON.stringify(emissionsOf('openwop.protocol.version'))).not.toContain('attacker-controlled');
  });
});

describe('ADR 0556 P1 — MCP request outcomes', () => {
  const deps = { principal: null, storage: undefined } as unknown as Parameters<typeof mcpDispatch>[1];

  it('counts an inbound served method', async () => {
    await mcpDispatch({ jsonrpc: '2.0', id: 1, method: 'ping' }, deps);
    expect(attrsOf('openwop.mcp.request')).toEqual([
      { direction: 'inbound', method: 'ping', outcome: 'ok' },
    ]);
  });

  it('folds an unserved method onto `unknown` and reports method_not_found', async () => {
    await mcpDispatch({ jsonrpc: '2.0', id: 1, method: 'tools/../../call' }, deps);
    expect(attrsOf('openwop.mcp.request')).toEqual([
      { direction: 'inbound', method: 'unknown', outcome: 'method_not_found' },
    ]);
  });

  it('records the initialize version disposition, mismatch separately from served', async () => {
    await mcpDispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, deps);
    await mcpDispatch({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, deps);
    // `initialize` exists only on the legacy revision, so a peer that reaches it
    // is served legacy by construction — the population the 2027-08-12
    // retirement needs counted. A mismatch serves nothing.
    expect(attrsOf('openwop.protocol.version')).toEqual([
      { protocol: 'mcp', disposition: 'absent', profile: 'mcp-2025-06-18-legacy' },
      { protocol: 'mcp', disposition: 'mismatch', profile: 'none' },
    ]);
  });

  it('the outbound classifier maps every McpError code, and folds anything else', () => {
    // The outbound `call` pipeline needs a registered connector, a governance
    // allow and a live credential to reach; its classification table is what an
    // alert reads, so the table is pinned directly.
    expect(classifyMcpClientOutcome({ code: 'mcp_timeout' })).toBe('timeout');
    expect(classifyMcpClientOutcome({ code: 'mcp_not_connected' })).toBe('not_connected');
    expect(classifyMcpClientOutcome({ code: 'connector_not_allowed' })).toBe('not_allowed');
    expect(classifyMcpClientOutcome({ code: 'mcp_error' })).toBe('remote_error');
    // A code nobody added to the table must not become its own series.
    expect(classifyMcpClientOutcome({ code: 'something_new_next_quarter' })).toBe('transport_error');
    expect(classifyMcpClientOutcome(new Error('bare'))).toBe('transport_error');
  });
});

describe('ADR 0556 P1 — sandbox resource and escape failures', () => {
  it('separates an ESCAPE ATTEMPT from an ordinary script error', () => {
    // The distinction is the whole point: one is a security signal an operator
    // pages on, the other is an author's typo. A single `failed` outcome would
    // put them on the same line.
    runInSandbox('process.exit(1)');
    expect(attrsOf('openwop.sandbox.execution')).toEqual([{ runtime: 'vm', outcome: 'escape_attempt' }]);

    _resetMetricsForTest();
    runInSandbox('null.x');
    expect(attrsOf('openwop.sandbox.execution')).toEqual([{ runtime: 'vm', outcome: 'error' }]);
  });

  it('counts a capability denial and a clean run', () => {
    runInSandbox('host("send")', { allowedHostCalls: [] });
    expect(attrsOf('openwop.sandbox.execution')).toEqual([{ runtime: 'vm', outcome: 'capability_denied' }]);

    _resetMetricsForTest();
    runInSandbox('1 + 1');
    expect(attrsOf('openwop.sandbox.execution')).toEqual([{ runtime: 'vm', outcome: 'ok' }]);
  });

  it('a Code-API abort is a TIMEOUT, not a network fault', () => {
    // The adapter reports an abort as `code: 'sandbox_transport_error'` with
    // `message: 'sandbox_timeout'`, so that the endpoint location never leaks
    // into the message. Reading only the code would file every sandbox timeout
    // as a transport problem — the opposite of the capacity signal it is.
    expect(classifySandboxError(Object.assign(new Error('sandbox_timeout'), { code: 'sandbox_transport_error' })))
      .toBe('timeout');
    expect(classifySandboxError(Object.assign(new Error('sandbox_transport_error'), { code: 'sandbox_transport_error' })))
      .toBe('transport_error');
    expect(classifySandboxError(Object.assign(new Error('over'), { code: 'resource_exhausted' })))
      .toBe('resource_exhausted');
  });
});

describe('ADR 0556 P1 — model-provider calls', () => {
  const scope = {
    runId: 'test-run',
    nodeId: 'test-node',
    tenantId: 'test-tenant',
    attempt: 1,
    secrets: { openai: 'sk-test' },
    policyResolver: {
      async resolveForRun(): Promise<AiProviderPolicy[]> { return []; },
    } as ProviderPolicyResolver,
  };

  /** The tool-calling round is non-streaming, so one JSON body is a complete
   *  provider response — the plain chat round streams SSE and would need a
   *  readable body to exercise the same mapper. Both funnel through
   *  `mapDispatchErrors`, which is the seam under test. */
  const toolCall = () => createAiProvidersAdapter(scope).callAIWithTools({
    provider: 'openai',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'foo', description: 'd', inputSchema: { type: 'object' } }],
  });

  it('counts a successful call by provider', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'hi', tool_calls: [] }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      text: () => Promise.resolve(''),
    } as Response));
    try { await toolCall(); } finally { vi.unstubAllGlobals(); }

    expect(attrsOf('openwop.provider.call')).toEqual([{ provider: 'openai', outcome: 'ok' }]);
  });

  it('maps an upstream 404 to the CANONICAL code, never the provider body', async () => {
    const leak = 'no such model for key sk-live-CUSTOMER-SECRET on org acme';
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(leak),
    } as Response));
    try {
      await expect(toolCall()).rejects.toMatchObject({ code: 'model_not_supported' });
    } finally { vi.unstubAllGlobals(); }

    expect(attrsOf('openwop.provider.call')).toEqual([{ provider: 'openai', outcome: 'model_not_supported' }]);
    // The upstream body is provider-controlled, unbounded, and has been observed
    // echoing credentials. It must not be anywhere near a label.
    expect(JSON.stringify(emissionsOf('openwop.provider.call'))).not.toContain('sk-live');
  });
});

describe('ADR 0556 P1 — the SECOND idempotent endpoint', () => {
  it('POST /v1/host/openwop-app/agents counts its own claims on its own endpoint label', async () => {
    const key = `seam-agents-${Date.now()}`;
    const body = { persona: 'Metrics Probe', modelClass: 'chat', systemPrompt: 'You are helpful.' };
    const send = () => fetch(`${BASE}/v1/host/openwop-app/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);

    // A SECOND participating route exists, and the ledger's endpoint component
    // is what keeps the two keyspaces apart. Instrumenting only /v1/runs would
    // leave half the lane invisible while the metric looked complete.
    expect(attrsOf('openwop.idempotency.claim')).toEqual([
      { endpoint: 'POST:/v1/host/openwop-app/agents', outcome: 'claimed' },
      { endpoint: 'POST:/v1/host/openwop-app/agents', outcome: 'replay' },
    ]);
  });
});

describe('ADR 0556 P1 — a timer interrupt that elapses', () => {
  it('records the age with `resolution: timer`, distinct from a rejected timeout', async () => {
    const created = await getSuspendManager().createInterrupt({
      runId: 'run-timer-1',
      nodeId: 'wait',
      kind: 'timer',
      data: { seconds: 30 },
    });
    // A `timer` is deliberately silent at creation (no bell — it needs no human),
    // but it is still counted: the created/resolved pair is what makes a stuck
    // timer visible as a gap rather than as nothing at all.
    expect(attrsOf('openwop.interrupt.created')).toEqual([{ interrupt_kind: 'timer' }]);

    _resetMetricsForTest();
    const resumed: string[] = [];
    const swept = await sweepDueTimers(
      storage,
      async (it) => { resumed.push(it.interruptId); },
      Date.parse(created.createdAt) + 45_000,
    );
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(resumed).toContain(created.interruptId);

    const ages = emissionsOf('openwop.interrupt.age')
      .filter((e) => e.attributes.interrupt_kind === 'timer');
    expect(ages).toHaveLength(1);
    // An elapsed timer RESUMES the run; a timed-out approval REJECTS it. Same
    // histogram, different `resolution`, because collapsing them would put a
    // scheduled wait and a discarded human decision on one line.
    expect(ages[0]!.attributes).toEqual({ interrupt_kind: 'timer', resolution: 'timer' });
    expect(ages[0]!.value).toBeCloseTo(45, 0);
  });
});

describe('ADR 0556 P1 — assurance freshness', () => {
  it('records the manifest age at READ, and records NOTHING when there is no age', async () => {
    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    const dir = mkdtempSync(join(tmpdir(), 'adr0556-attest-'));
    const manifest = join(dir, 'attestation.json');
    const issuedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    writeFileSync(manifest, JSON.stringify({
      payload: {
        environmentClass: 'production',
        issuedAt,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        build: { commit: 'deadbeef', commitSource: 'env' },
        profiles: [],
      },
      signature: 'not-a-real-signature',
    }));

    const read = () => fetch(`${BASE}/v1/host/openwop-app/operations/attestation/summary`, {
      headers: { authorization: 'Bearer dev-token' },
    }).then((r) => r.json() as Promise<{ state: string }>);

    try {
      process.env.OPENWOP_ATTESTATION_PATH = manifest;
      const summary = await read();
      // Unsigned by design: P1 is measuring FRESHNESS, and an invalid manifest
      // has an age exactly as a valid one does. The state is a label, not a gate.
      expect(summary.state).toBe('invalid');
      const ages = emissionsOf('openwop.attestation.age');
      expect(ages).toHaveLength(1);
      expect(ages[0]!.attributes).toEqual({ state: 'invalid', environment_class: 'production' });
      expect(ages[0]!.value).toBeCloseTo(3 * 86_400, -1);

      _resetMetricsForTest();
      delete process.env.OPENWOP_ATTESTATION_PATH;
      expect((await read()).state).toBe('absent');
      // NO observation. A manifest with no issuedAt has no age, and a zero would
      // read as "issued just now" — the most reassuring possible value for the
      // most alarming possible state. Alert on the series being ABSENT instead.
      expect(emissionsOf('openwop.attestation.age')).toHaveLength(0);
    } finally {
      delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
      delete process.env.OPENWOP_ATTESTATION_PATH;
    }
  });
});

describe('ADR 0556 P1 — the workflow-kind classifier', () => {
  it('reads the CHAIN stamp from the definition, the stack stamp from the run', () => {
    expect(classifyWorkflowKind({ definition: { metadata: { source: 'workflow-chain-pack' } } })).toBe('chain');
    expect(classifyWorkflowKind({ definition: { metadata: {} }, run: { metadata: { source: 'kanban' } } })).toBe('stack');
    expect(classifyWorkflowKind({ definition: { metadata: {} } })).toBe('builtin');
    // No definition ⇒ genuinely unknown. This is the branch `notifyRunTerminal`
    // takes for a run this process did not start, and saying so beats guessing.
    expect(classifyWorkflowKind({ run: { metadata: {} } })).toBe('unknown');
    // A tenant-chosen source must not become its own series.
    expect(classifyWorkflowKind({ definition: { metadata: {} }, run: { metadata: { source: 'acme-custom-pipeline' } } }))
      .toBe('builtin');
  });
});

describe('ADR 0556 P1 — no seam smuggled a label past the guard', () => {
  it('the violation ledger is empty across every seam exercised above', async () => {
    await recordObligation({
      tenantId: 't-guard', runId: 'r-guard', forwardLogicalInvocationId: 'inv-g',
      compensationOrdinal: 1, effectKind: 'email', shape: 'irreversible',
      resultDigest: 'rd', contractDigest: 'cd',
    });
    await handleA2aRequest({ jsonrpc: '2.0', id: 1, method: 'agent/getCard' }, { agentCard: {}, availableTools: [] });
    runInSandbox('1 + 1');

    // A violation would mean a seam passed the guard a label it DROPPED — the
    // metric would then ship with a dimension silently missing, which looks
    // exactly like a metric that never had it.
    expect([...labelViolations().entries()]).toEqual([]);
    // …and the seams genuinely emitted, so the empty ledger above is evidence
    // of clean labels rather than of no telemetry.
    expect(emissionsOf('openwop.compensation.obligation')).toHaveLength(1);
    expect(emissionsOf('openwop.a2a.request')).toHaveLength(1);
    expect(emissionsOf('openwop.sandbox.execution')).toHaveLength(1);
  });
});

describe('ADR 0556 P4 — authorization decisions are ALERTABLE, not just auditable', () => {

  /**
   * The gap ADR 0556 named in its own "not done" list: the decision facts lived
   * on the span and in the durable audit chain, and nowhere a dashboard could
   * read them. A span is sampled; an audit row is a per-decision record you have
   * to query. Neither answers "are denials rising right now".
   */
  it('emits {outcome, issuer_class} from the same call that writes the span and the log', () => {
    runWithAuthority(
      {
        actor: 'user:opaque', actorKind: 'user', issuerClass: 'oidc',
        senderConstraint: 'none', delegationDepth: 0, scopes: [], recorded: false,
        correlationId: 'corr-authz-1',
      },
      () => { recordAuthorityAction('dispatch', 'deny'); },
    );

    // The WHOLE attribute object, per this file's standard.
    expect(attrsOf('openwop.authz.decision')).toEqual([{ outcome: 'deny', issuer_class: 'oidc' }]);
  });

  /**
   * Most facts carry NO verified workload identity. Folding those into
   * `anonymous` would state something false — `anonymous` is a verified
   * anonymous issuer, not an absent one — so they get their own value.
   */
  it('an unattributed decision is labelled `unattributed`, not `anonymous`', () => {
    runWithAuthority(
      {
        actor: 'anon', actorKind: 'anonymous',
        senderConstraint: 'none', delegationDepth: 0, scopes: [], recorded: false,
        correlationId: 'corr-authz-2',
      },
      () => { recordAuthorityAction('effect', 'allow'); },
    );
    expect(attrsOf('openwop.authz.decision')).toEqual([{ outcome: 'allow', issuer_class: 'unattributed' }]);
  });

  /**
   * The adversarial case this file asks of every seam: can a value someone else
   * chose reach a label? `seam` is deliberately NOT a label — it is open-ended
   * (`effect`, `dispatch`, `sandbox`, whatever is added next), and an unbounded
   * label is the exact failure the P0 cardinality lint exists for. So driving
   * three different seams must produce ONE series, not three.
   */
  it('the open-ended `seam` never becomes a label — three seams, one series', () => {
    const facts = {
      actor: 'w', actorKind: 'workload' as const, issuerClass: 'spiffe' as const,
      senderConstraint: 'none' as const, delegationDepth: 0, scopes: [], recorded: false,
      correlationId: 'corr-authz-3',
    };
    runWithAuthority(facts, () => {
      recordAuthorityAction('effect', 'allow');
      recordAuthorityAction('dispatch', 'allow');
      recordAuthorityAction('sandbox', 'allow');
    });
    expect(attrsOf('openwop.authz.decision')).toEqual([
      { outcome: 'allow', issuer_class: 'spiffe' },
      { outcome: 'allow', issuer_class: 'spiffe' },
      { outcome: 'allow', issuer_class: 'spiffe' },
    ]);
    // No label was refused: `seam` never reached the attribute object at all.
    expect(labelViolations().size).toBe(0);
  });

  it('emits NOTHING outside an authority context — no facts, no decision to report', () => {
    recordAuthorityAction('effect', 'allow');
    expect(attrsOf('openwop.authz.decision')).toEqual([]);
  });
});
