/**
 * ADR 1156 P1 — a held chat tool call is approved on a card in the conversation.
 *
 * Drives the real chat tool turn (`runConversationAgentToolTurn`) with a scripted managed
 * model, a probe tool held by the conversation's own scope, and the real ledger. Pins:
 *  1. a held call is recorded with the asking turn's id (`askId`) and the tool's own
 *     description (`describeApproval` lines), and the turn reports it as a held call (the
 *     card's `tool-approval-requested` event);
 *  2. after a one-call approval, the continue turn that repeats the call runs it and
 *     reports `ran` for that card;
 *  3. when the approved call runs and the tool refuses it, the card's outcome is
 *     `refused`, with the tool's own words;
 *  4. when the continue turn asks for DIFFERENT arguments, the approval is not used, the
 *     old card is `superseded` and a new ask is pending under the new turn;
 *  5. a call-grain denial covers that call only: the same call is refused to the model at
 *     once (`approval_declined`, no new ask), a different call is a new ask, and the tool
 *     stays in the conversation (it is not folded out of scope); a denial with no grain
 *     keeps its old tool-wide meaning;
 *  6. a describer that throws falls back to the arguments (no lines), and lines are
 *     scrubbed and capped;
 *  7. the approvals route lets only a signed-in person decide: the predicate refuses an
 *     API key (even one the owner minted), an env key, the test seam and anon; over the
 *     route, the owner's own session reads the row with its `askId` and approves it.
 *
 * Sabotage notes: dropping `askId` from the record call reds 1; reading the settle from
 * the wrong call id reds 2 and 3; removing the `replacedAskId` branch reds 4; folding
 * call-grain denials into the scope, or dropping the `declined` gate, reds 5; letting a
 * describer throw out of the turn reds 6; removing `isPersonSession` reds 7.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const script = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown> | null>, tool: '', seen: [] as string[] }));
vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return {
    ...actual,
    // Each turn: round 1 calls the probe with the scripted input (null = no call), round 2 answers.
    dispatchManagedToolsRound: vi.fn(async (req: { messages: unknown }) => {
      script.seen.push(JSON.stringify(req.messages));
      const next = script.calls.shift();
      if (next) return { text: '', toolUses: [{ id: `c-${script.seen.length}`, name: script.tool, input: next }] };
      return { text: 'done', toolUses: [] };
    }),
  };
});

import { registerFeatureAgentTool } from '../src/host/agentToolProvider.js';
import { runConversationAgentToolTurn } from '../src/host/conversationToolLoop.js';
import { ensureConversationMeta, setConversationCapabilityScope } from '../src/host/conversationStore.js';
import { listToolApprovals, recordToolApprovalRequested, resolveToolApproval, boundApprovalLines, scopeFoldRows, REQUESTED_LINES_MAX, REQUESTED_LINE_MAX_CHARS } from '../src/features/conversation-tools/approvalLedger.js';
import type { ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import type { PrincipalAuth, RunRecord } from '../src/types.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';

const PROBE = 'openwop:adr1156.board-edit';
const THROWER = 'openwop:adr1156.describer-throws';
const T = 't-1156';
const OWNER = 'owner-1156';
const ran: Array<Record<string, unknown>> = [];
let refuse = false;

let reset: () => void = () => {};
beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // These cases pin P1: the continue turn relies on the model repeating the call. That is
  // still the path when P2 is off or outside its run window; P2 has its own file
  // (adr1156-p2-approved-call-runs.test.ts).
  process.env.OPENWOP_APPROVED_CALL_RUN = 'off';
  const { initHostExtPersistence, __resetHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
  const { openStorage } = await import('../src/storage/index.js');
  initHostExtPersistence(await openStorage('memory://'));
  reset = __resetHostExtPersistence;
  registerFeatureAgentTool({
    contentTrust: 'trusted', effect: 'write',
    def: { name: PROBE, description: 'ADR 1156 probe', inputSchema: { type: 'object' } },
    describeApproval: (input) => [{ group: 'Kitchen', text: `Move the oak table to ${String(input.to)}` }, 'Keep the lamp'],
    run: async (input: Record<string, unknown>) => {
      if (refuse) return { content: JSON.stringify({ message: 'The board changed since this was proposed.' }), isError: true };
      ran.push(input);
      return { content: 'moved' };
    },
  });
  registerFeatureAgentTool({
    contentTrust: 'trusted', effect: 'write',
    def: { name: THROWER, description: 'ADR 1156 throwing describer', inputSchema: { type: 'object' } },
    describeApproval: () => { throw new Error('describer broke'); },
    run: async () => ({ content: 'ran' }),
  });
});
afterAll(() => { reset(); delete process.env.OPENWOP_APPROVED_CALL_RUN; });

const agent = (allow: string[]): ResolvedAgentManifest => ({
  agentId: 'adr1156-agent', persona: 'P', modelClass: 'chat', systemPrompt: 'sp', toolAllowlist: allow,
  packName: 'test.adr1156', packVersion: '0.0.1',
});
const AT = '2026-01-01T00:00:00.000Z';
const noPolicies: ProviderPolicyResolver = { resolveForRun: async () => [] };

let n = 0;
async function conversation(tool = PROBE): Promise<{ session: string; turn: (input: Record<string, unknown> | null) => ReturnType<typeof runConversationAgentToolTurn> }> {
  const session = `sess-1156-${n++}`;
  await ensureConversationMeta(T, session, { type: 'agent', ownerUserId: OWNER });
  await setConversationCapabilityScope(T, session, { mode: 'restricted', requireApproval: [tool] });
  const run: RunRecord = {
    runId: `r-${session}`, workflowId: 'adr1156.chat', tenantId: T, status: 'running',
    inputs: { credentialRef: 'managed:openwop-free' }, metadata: { actingUserId: OWNER, chatSessionId: session }, configurable: {},
    createdAt: AT, updatedAt: AT,
  };
  let k = 0;
  return {
    session,
    turn: (input) => {
      script.calls = [input];
      script.tool = tool;
      k += 1;
      return runConversationAgentToolTurn({
        run, agent: agent([tool]), systemPrompt: 'sp', history: [{ role: 'user', content: 'go' }],
        runId: run.runId, nodeId: 'gate', conversationId: `${run.runId}:gate:0`, policyResolver: noPolicies,
        turnMessageId: `${run.runId}:gate:0:${k}:agent`,
      });
    },
  };
}
const rowOf = async (session: string, tool = PROBE) => (await listToolApprovals(T, session)).find((r) => r.toolName === tool);
const approve = async (session: string, decision: 'approved' | 'denied' = 'approved', ...grain: ['call' | 'conversation'] | []) => {
  const r = await rowOf(session);
  expect(r?.status, 'fixture: an ask is pending').toBe('pending');
  return resolveToolApproval(T, session, PROBE, decision, OWNER, r!.requestedAt, ...grain);
};

describe('ADR 1156 — the held-call card, through the chat tool turn', () => {
  it('1. a held call names its turn and carries the tool\'s own description', async () => {
    const c = await conversation();
    ran.length = 0;
    const out = await c.turn({ to: 'the window' });
    expect(ran).toEqual([]);
    expect(out?.heldCalls?.map((h) => h.toolName)).toEqual([PROBE]);
    const row = await rowOf(c.session);
    expect(row).toMatchObject({ status: 'pending', askId: `r-${c.session}:gate:0:1:agent`, requestedAt: out!.heldCalls![0]!.requestedAt });
    expect(row?.requestedLines).toEqual([{ group: 'Kitchen', text: 'Move the oak table to the window' }, { text: 'Keep the lamp' }]);
  });

  it('2. one-call approval, then the same call: it runs and the card says ran', async () => {
    const c = await conversation();
    await c.turn({ to: 'the window' });
    expect((await approve(c.session, 'approved', 'call')).ok).toBe(true);
    ran.length = 0;
    const out = await c.turn({ to: 'the window' });
    expect(ran).toEqual([{ to: 'the window' }]);
    expect(out?.settledApprovals).toEqual([{ askId: `r-${c.session}:gate:0:1:agent`, toolName: PROBE, outcome: 'ran' }]);
    expect(out?.heldCalls ?? []).toEqual([]);
  });

  it('3. the approved call runs and the tool refuses it: the card says refused, in the tool\'s words', async () => {
    const c = await conversation();
    await c.turn({ to: 'the door' });
    await approve(c.session);
    refuse = true;
    try {
      const out = await c.turn({ to: 'the door' });
      expect(out?.settledApprovals).toEqual([{ askId: `r-${c.session}:gate:0:1:agent`, toolName: PROBE, outcome: 'refused', reason: 'The board changed since this was proposed.' }]);
    } finally { refuse = false; }
  });

  it('4. the continue turn asks for different arguments: not used, the old card is superseded, a new ask waits', async () => {
    const c = await conversation();
    await c.turn({ to: 'the window' });
    await approve(c.session);
    ran.length = 0;
    const out = await c.turn({ to: 'the hall' });
    expect(ran).toEqual([]);
    expect(out?.settledApprovals).toEqual([{ askId: `r-${c.session}:gate:0:1:agent`, toolName: PROBE, outcome: 'superseded' }]);
    expect(out?.heldCalls?.map((h) => h.toolName)).toEqual([PROBE]);
    expect(await rowOf(c.session)).toMatchObject({ status: 'pending', askId: `r-${c.session}:gate:0:2:agent` });
  });

  it('5. a call-grain denial covers that call only; a grain-less denial still blocks the tool', async () => {
    const c = await conversation();
    await c.turn({ to: 'the window' });
    expect((await approve(c.session, 'denied', 'call')).ok).toBe(true);
    const denied = await rowOf(c.session);
    expect(scopeFoldRows([denied!], false), 'a call-grain denial does not remove the tool').toEqual([]);
    // The same call: refused to the model at once, no new ask.
    const again = await c.turn({ to: 'the window' });
    expect(again?.events.find((e) => e.type === 'agent.toolReturned')).toMatchObject({ status: 'forbidden', error: { code: 'approval_declined' } });
    expect(again?.heldCalls ?? []).toEqual([]);
    expect((await rowOf(c.session))?.status).toBe('denied');
    // A different call: a new ask, under the new turn.
    const other = await c.turn({ to: 'the hall' });
    expect(other?.heldCalls?.map((h) => h.toolName)).toEqual([PROBE]);
    expect(await rowOf(c.session)).toMatchObject({ status: 'pending', askId: `r-${c.session}:gate:0:3:agent` });

    // Control: the composer dialog's Deny (no grain) keeps its tool-wide meaning.
    const d = await conversation();
    await d.turn({ to: 'the window' });
    expect((await approve(d.session, 'denied')).ok).toBe(true);
    const wide = await rowOf(d.session);
    expect(wide?.grain).toBe('conversation');
    expect(scopeFoldRows([wide!], false).map((r) => r.toolName)).toEqual([PROBE]);
  });

  it('6. a throwing describer falls back to the arguments; lines are scrubbed and capped', async () => {
    const c = await conversation(THROWER);
    const out = await c.turn({ x: 1 });
    expect(out?.heldCalls?.map((h) => h.toolName)).toEqual([THROWER]);
    const row = await rowOf(c.session, THROWER);
    expect(row?.requestedLines).toBeUndefined();
    expect(row?.requestedInput).toBe('{"x":1}');

    const many = boundApprovalLines(Array.from({ length: REQUESTED_LINES_MAX + 5 }, (_, i) => ({ text: `line ${i} ${'move the oak table '.repeat(60)}` })));
    expect(many).toHaveLength(REQUESTED_LINES_MAX);
    expect(many![0]!.text.length).toBe(REQUESTED_LINE_MAX_CHARS);
    expect(JSON.stringify(boundApprovalLines(['key sk-ant-api03-SECRETSECRETSECRETSECRET here']))).not.toContain('SECRETSECRET');
    expect(boundApprovalLines('not lines')).toBeUndefined();
    // Lines are cleared with the ask, like the arguments.
    await recordToolApprovalRequested(T, 'clear-1156', PROBE, { input: { a: 1 }, lines: [{ text: 'x' }] });
    const asked = await rowOf('clear-1156');
    await resolveToolApproval(T, 'clear-1156', PROBE, 'approved', OWNER, asked!.requestedAt);
    expect((await rowOf('clear-1156'))?.requestedLines).toBeUndefined();
  });
});

describe('ADR 1156 D7 — only a signed-in person decides', () => {
  let server: http.Server;
  let BASE = '';
  beforeAll(async () => {
    reset();
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const { createApp } = await import('../src/index.js');
    const { saveConfig } = await import('../src/host/featureToggles/service.js');
    const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    const d = getToggleDefault('conversation-tools');
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }, 120_000);
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('the predicate: a signed-in session or a person\'s OIDC bearer, never a key or the test seam', async () => {
    const { isPersonSession } = await import('../src/features/conversation-tools/routes.js');
    const p = (auth: PrincipalAuth) => ({ principal: { principalId: OWNER, tenants: [T], token: '', auth } });
    expect(isPersonSession(p({ kind: 'subject' }))).toBe(true);
    expect(isPersonSession(p({ kind: 'api-key', issuer: OWNER, scopes: [] })), 'a key the owner minted is not the owner pressing a button').toBe(false);
    expect(isPersonSession(p({ kind: 'env-key' }))).toBe(false);
    expect(isPersonSession(p({ kind: 'test-seam' }))).toBe(false);
    expect(isPersonSession(p({ kind: 'anon' }))).toBe(false);
    expect(isPersonSession({})).toBe(false);
  });

  it('over the route, a signed-in owner reads the card\'s row (askId) and approves it', async () => {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const h = res.headers as { getSetCookie?: () => string[] };
      for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    const login = await call('POST', '/host/openwop-app/test/login', { email: 'owner-1156@firm.test', tenantId: 't-1156-route' });
    expect(login.status).toBe(201);
    const userId = (login.body.user as { userId: string }).userId;
    const session = 'sess-1156-route';
    await ensureConversationMeta('t-1156-route', session, { type: 'agent', ownerUserId: userId });
    await recordToolApprovalRequested('t-1156-route', session, PROBE, { input: { to: 'x' }, askId: 'ask-1' });
    const base = `/host/openwop-app/conversation-tools/sessions/${session}`;
    const asPerson = { cookie };
    const read = await call('GET', `${base}/capability-scope`, undefined, asPerson);
    expect(read.status).toBe(200);
    expect((read.body.viewer as { mayApprove: boolean }).mayApprove).toBe(true);
    const row = (read.body.approvals as Array<{ askId?: string; requestedAt: string }>)[0]!;
    expect(row.askId).toBe('ask-1');
    // ADR 1156 P2 (D10) — the sealed full input never leaves the server.
    expect(JSON.stringify(read.body)).not.toContain('sealedInput');
    const ok = await call('POST', `${base}/approvals/${encodeURIComponent(PROBE)}`, { decision: 'approved', requestedAt: row.requestedAt, grain: 'call' }, asPerson);
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain('sealedInput');
    expect((await listToolApprovals('t-1156-route', session))[0]?.sealedInput, 'fixture: the approved row does hold one').toBeTruthy();
  });
});
