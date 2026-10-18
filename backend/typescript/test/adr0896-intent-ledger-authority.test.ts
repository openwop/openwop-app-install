/**
 * ADR 0896 — the intent ledger's approval authority (feature loop row 49).
 *
 * The mission contract is an APPROVAL: a person reviews what the agent may do and
 * says yes. Every probe here asks whether that yes is bound to what was reviewed,
 * to the person who may give it, and to the run that spends it. Each was written
 * RED against `origin/main` before the fix; the controls were green there too.
 *
 *   D1  approve what you saw — the agent's draft tool can rewrite a draft while the
 *       owner is reading it, so an approve with no version approves text nobody saw.
 *   D2  who decides — an ownerless conversation had no authority-holder, yet any
 *       visible member could approve or revoke its mission.
 *   D3  a run cannot carry its own mission stamp — `intentLedger` was not a reserved
 *       run-metadata key, so a caller could plant one (and its TTL anchor).
 *   D4  a stamp names its approval — a run stamped under an earlier mission anchored
 *       a NEW mission's TTL at its own start, expiring the new mission at once.
 *   D5  only the owner's own run may end the mission — a participant's fork carrying
 *       the source run's stamp persisted `expired` onto the owner's live ledger.
 *   D6  the reckoning reports the current mission — it read the newest stamped run
 *       of ANY approval (or a planted one) as the governing contract.
 *   D7  the agent's read carries the whole contract — `requireApproval` and the TTL
 *       were missing from `intent-ledger.get`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { addParticipant, ensureConversationMeta, userRef } from '../src/host/conversationStore.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { resolveConversationToolGate } from '../src/host/conversationToolScope.js';
import { buildRunRecord } from '../src/host/runDispatch.js';
import { INTENT_LEDGER_DRAFT_TOOL_ID, INTENT_LEDGER_GET_TOOL_ID } from '../src/features/intent-ledger/agentTools.js';
import { getLedger, ledgerDigest, saveLedger } from '../src/features/intent-ledger/ledgerStore.js';
import type { IntentLedger } from '../src/features/intent-ledger/types.js';
import type { RunRecord } from '../src/types.js';
import type { Storage } from '../src/storage/storage.js';

// IL2CD-3 — a hook that runs INSIDE the gate's expiry write, just before its CAS, so
// a revoke can land between the gate's read and its write (deterministically). Null ⇒
// the real writer, untouched.
const writeHook = vi.hoisted(() => ({ before: null as null | (() => Promise<void>) }));
vi.mock('../src/features/intent-ledger/ledgerStore.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/features/intent-ledger/ledgerStore.js')>();
  return {
    ...orig,
    writeLedger: async (...args: Parameters<typeof orig.writeLedger>) => {
      const h = writeHook.before; writeHook.before = null;
      if (h) await h();
      return orig.writeLedger(...args);
    },
  };
});

let BASE: string; let server: http.Server; let storage: Storage;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

type Res = { status: number; body: any };
function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
}
type Client = ReturnType<typeof client>;
let n = 0;
const IL = (conv: string, suffix = ''): string => `/host/openwop-app/intent-ledger/conversations/${conv}${suffix}`;
// Review H4: EVERY case founds its own tenant (the first login owns it) and adds
// peers as real editor members — in one shared tenant the later logins hold no
// membership, so a write floor would refuse them and every authority probe would
// pass for the wrong reason.
let T = '';
async function login(c: Client, who: string): Promise<string> {
  T = `org:il896-${Date.now()}-${n++}`;
  const r = await c('POST', '/host/openwop-app/test/login', { email: `${who}-${n++}@il896.test`, tenantId: T });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId as string;
}
/** A second person in the CURRENT tenant, with `role`. */
async function member(owner: Client, role: 'editor' | 'viewer' | 'admin'): Promise<{ c: Client; userId: string; memberId: string }> {
  const c = client();
  const r = await c('POST', '/host/openwop-app/test/login', { email: `${role}-${n++}@il896.test`, tenantId: T });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const userId = r.body.user.userId as string;
  const add = await owner('POST', `/host/openwop-app/orgs/${encodeURIComponent(T)}/members`, { displayName: role, subject: userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { c, userId, memberId: add.body.memberId as string };
}
const version = (l: IntentLedger): { ledgerId: string; revision: number; digest: string } => ({ ledgerId: l.ledgerId, revision: l.revision ?? 0, digest: ledgerDigest(l) });
async function ownedConversation(c: Client): Promise<string> {
  return (await c('POST', '/host/openwop-app/chat/sessions', { title: 'mission' })).body.sessionId as string;
}
const draftTool = (input: Record<string, unknown>, actingUserId: string, conversationId: string) =>
  createAgentToolProvider({ tenantId: T, runId: `run-896-${n++}`, actingUserId, conversationId }).executeTool({ name: INTENT_LEDGER_DRAFT_TOOL_ID, input });

/** An approved mission on a fresh owned conversation, approved through the route. */
async function approvedMission(extra: Partial<IntentLedger> = {}): Promise<{ owner: Client; ownerId: string; conv: string; ledger: IntentLedger }> {
  const owner = client();
  const ownerId = await login(owner, 'owner');
  const conv = await ownedConversation(owner);
  const d = await owner('POST', IL(conv, '/draft'), { goal: 'Research only', allowed: ['kb'], forbidden: ['openwop:email.send'], ...extra });
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  const a = await owner('POST', IL(conv, '/approve'), version(d.body.ledger));
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  expect(a.body.ledger.digest).toBe(ledgerDigest(a.body.ledger)); // decide responses carry it too
  return { owner, ownerId, conv, ledger: a.body.ledger as IntentLedger };
}
const fakeRun = (metadata: Record<string, unknown>): RunRecord => ({
  runId: `run-896-${n++}`, workflowId: 'wf', tenantId: T, status: 'running', inputs: null,
  metadata, configurable: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
} as unknown as RunRecord);
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

describe('D1 — approve what you saw', () => {
  it('an approve that names no version is refused (400): no caller approves a draft it never read', async () => {
    const owner = client(); await login(owner, 'd1a');
    const conv = await ownedConversation(owner);
    expect((await owner('POST', IL(conv, '/draft'), { goal: 'g', forbidden: ['openwop:email.send'] })).status).toBe(200);
    const a = await owner('POST', IL(conv, '/approve'));
    expect(a.status).toBe(400);
    expect((await getLedger(T, conv))?.status).toBe('draft');
  });

  it('the agent rewrites the draft while the owner reads it ⇒ the owner\'s approve is refused (409), not applied to the new text', async () => {
    const owner = client(); const ownerId = await login(owner, 'd1b');
    const conv = await ownedConversation(owner);
    const seen = (await owner('POST', IL(conv, '/draft'), { goal: 'Summarise', forbidden: ['openwop:email.send'] })).body.ledger as IntentLedger;
    // An injected instruction steers the chat agent to redraft without the prohibition.
    const tool = await draftTool({ goal: 'Summarise', forbidden: [] }, ownerId, conv);
    expect(tool.isError).toBeFalsy();
    const a = await owner('POST', IL(conv, '/approve'), version(seen));
    expect(a.status).toBe(409);
    expect(a.body.error).toBe('conflict');
    const now = await getLedger(T, conv);
    expect(now?.status).toBe('draft');
    expect(now?.approvedBy).toBeUndefined();
  });

  it('control — approving the revision you read lands, and records who and when', async () => {
    const { ownerId, ledger } = await approvedMission();
    expect(ledger.status).toBe('approved');
    expect(ledger.approvedBy).toBe(ownerId);
    expect(typeof ledger.approvedAt).toBe('string');
  });

  it('the DIGEST binds the content: right id + revision but a different contract digest is refused (409)', async () => {
    const owner = client(); await login(owner, 'd1d');
    const conv = await ownedConversation(owner);
    const seen = (await owner('POST', IL(conv, '/draft'), { goal: 'g', forbidden: ['openwop:email.send'] })).body.ledger as IntentLedger;
    expect((seen as IntentLedger & { digest?: string }).digest).toBe(ledgerDigest(seen)); // the server hands the digest out with the row
    const wrong = ledgerDigest({ ...seen, forbidden: [] });
    expect((await owner('POST', IL(conv, '/approve'), { ...version(seen), digest: wrong })).status).toBe(409);
    expect((await getLedger(T, conv))?.status).toBe('draft');
  });

  it('a decision missing the digest is a 400 that NAMES the fields an old client must send', async () => {
    const owner = client(); await login(owner, 'd1e');
    const conv = await ownedConversation(owner);
    const seen = (await owner('POST', IL(conv, '/draft'), { goal: 'g' })).body.ledger as IntentLedger;
    const r = await owner('POST', IL(conv, '/approve'), { ledgerId: seen.ledgerId, revision: seen.revision });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/ledgerId.*revision.*digest/);
    expect(r.body.details?.required).toEqual(['ledgerId', 'revision', 'digest']);
  });

  it('only a draft can be approved: a revoked mission is not re-armed by a bare approve (409)', async () => {
    const { owner, conv } = await approvedMission();
    const cur = (await owner('GET', IL(conv))).body.ledger as IntentLedger;
    const r = await owner('POST', IL(conv, '/reject'), version(cur));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const again = await owner('POST', IL(conv, '/approve'), version(r.body.ledger));
    expect(again.status).toBe(409);
    expect((await getLedger(T, conv))?.status).toBe('rejected');
  });

  it('a REST redraft never reuses a revision a stale page could still hold (no A-B-A)', async () => {
    const owner = client(); await login(owner, 'd1c');
    const conv = await ownedConversation(owner);
    const first = (await owner('POST', IL(conv, '/draft'), { goal: 'one' })).body.ledger as IntentLedger;
    const second = (await owner('POST', IL(conv, '/draft'), { goal: 'two' })).body.ledger as IntentLedger;
    expect(second.revision ?? 0).toBeGreaterThan(first.revision ?? 0);
    expect((await owner('POST', IL(conv, '/approve'), version(first))).status).toBe(409);
  });

  it('review B1 — /draft cannot replace an APPROVED mission (revoke first)', async () => {
    const { owner, conv, ledger } = await approvedMission();
    const d = await owner('POST', IL(conv, '/draft'), { goal: 'wider', forbidden: [] });
    expect(d.status).toBe(409);
    expect((await getLedger(T, conv))).toMatchObject({ status: 'approved', revision: ledger.revision, forbidden: ['openwop:email.send'] });
  });
});

describe('D2 — who decides', () => {
  it('an OWNERLESS conversation: an editor can neither approve nor revoke its mission (403); a workspace admin can', async () => {
    const owner = client(); await login(owner, 'd2a');
    const editor = await member(owner, 'editor');
    const conv = `il896-ownerless-${n++}`;
    await ensureConversationMeta(T, conv, { type: 'direct' } as never);
    await saveLedger({ ledgerId: 'il-x', tenantId: T, conversationId: conv, goal: 'g', allowed: [], forbidden: ['openwop:email.send'], requireApproval: [], successCriteria: [], status: 'approved', proposedBy: 'user', createdAt: hoursAgo(1), revision: 3 } as IntentLedger);
    expect((await editor.c('GET', IL(conv))).body.viewer).toEqual({ mayEdit: true, mayDecide: false });
    const seen = version((await getLedger(T, conv))!);
    const r = await editor.c('POST', IL(conv, '/reject'), seen);
    expect(r.status).toBe(403);
    expect((await getLedger(T, conv))?.status).toBe('approved');
    // The tenant's founder (owner role) holds host:members:manage — the manager of last resort.
    const ok = await owner('POST', IL(conv, '/reject'), seen);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('a participant (not the owner) cannot decide, and GET tells the page so (viewer.mayDecide=false)', async () => {
    const { owner, conv } = await approvedMission();
    const peer = await member(owner, 'editor');
    await addParticipant(T, conv, userRef(peer.userId));
    const g = await peer.c('GET', IL(conv));
    expect(g.status).toBe(200);
    expect(g.body.viewer).toEqual({ mayDecide: false, mayEdit: false });
    expect((await peer.c('POST', IL(conv, '/reject'), version(g.body.ledger))).status).toBe(403);
  });

  it('control — the owner may decide (viewer.mayDecide=true)', async () => {
    const { owner, conv } = await approvedMission();
    expect((await owner('GET', IL(conv))).body.viewer).toEqual({ mayDecide: true, mayEdit: true });
  });

  it('control — a stranger in the tenant gets the IDOR-safe 404 on every verb', async () => {
    const { owner, conv } = await approvedMission();
    const s = (await member(owner, 'editor')).c;
    for (const [m, p] of [['GET', ''], ['POST', '/approve'], ['POST', '/reject'], ['PUT', ''], ['POST', '/draft']] as const) {
      expect((await s(m, IL(conv, p), m === 'GET' ? undefined : { goal: 'x', ledgerId: 'x', revision: 1 })).status, `${m} ${p}`).toBe(404);
    }
  });

  it('control — a run with no person behind it cannot draft (acting_user_required)', async () => {
    const out = await createAgentToolProvider({ tenantId: T, runId: 'r', conversationId: 'c' }).executeTool({ name: INTENT_LEDGER_DRAFT_TOOL_ID, input: { goal: 'g' } });
    expect(JSON.parse(out.content).error).toBe('acting_user_required');
  });
});

describe('D3 — a caller cannot plant the mission stamp', () => {
  it('`intentLedger` in caller metadata does not survive into the run row', () => {
    const run = buildRunRecord({ workflowId: 'wf', tenantId: T, metadata: { intentLedger: { conversationId: 'c', scope: { mode: 'agent-default' }, goal: 'planted', successCriteria: [], resolvedAt: '2999-01-01T00:00:00.000Z' }, mine: 1 } } as never);
    expect(run.metadata?.intentLedger).toBeUndefined();
    expect(run.metadata?.mine).toBe(1);
  });
  it('nor does `intentLedgerApprovals` — the key that actually carries the anchor (IL2CD-3)', () => {
    const run = buildRunRecord({ workflowId: 'wf', tenantId: T, metadata: { intentLedgerApprovals: { 'il-x@t': { ledgerId: 'il-x', approvedAt: 't', conversationId: 'c', scope: { mode: 'agent-default' }, goal: 'planted', successCriteria: [], resolvedAt: '2999-01-01T00:00:00.000Z' } } } } as never);
    expect(run.metadata?.intentLedgerApprovals).toBeUndefined();
  });
});

/** A run's per-approval stamp, as the gate mints it (ADR 0896 D4). */
const approvalsOf = (l: IntentLedger, resolvedAt: string, extra: Record<string, unknown> = {}, runId?: string) => ({
  intentLedgerApprovals: { [`${l.ledgerId}@${l.approvedAt}`]: { ledgerId: l.ledgerId, approvedAt: l.approvedAt, ...(runId ? { runId } : {}), conversationId: l.conversationId, scope: { mode: 'restricted', enabled: l.allowed }, goal: l.goal, successCriteria: [], resolvedAt } },
  ...extra,
});

describe('D4/D5 — the TTL anchor and who may end the mission', () => {
  // A ceiling the mission narrows (`allowed: ['kb']` drops email.send), so the gate returns a scope.
  const CEIL = ['kb.search', 'openwop:email.send'];
  it('a run stamped under an EARLIER mission does not expire the new one', async () => {
    const { conv, ownerId, ledger } = await approvedMission({ expiresAtRelMs: 3_600_000 });
    const old = { ...ledger, ledgerId: 'il-old', approvedAt: hoursAgo(5) };
    const run = fakeRun({ actingUserId: ownerId, chatSessionId: conv, ...approvalsOf(old, hoursAgo(5)) });
    const gate = await resolveConversationToolGate({ tenantId: T, conversationKey: conv, ceiling: ['kb.search', 'openwop:email.send'], approvals: [], run });
    expect(gate.scope?.enabled).toEqual(['kb.search']);
    expect((await getLedger(T, conv))?.status).toBe('approved');
  });

  it('review B2 — ONE conversation-long run: revoke A, approve B, and B is anchored at its own first turn (and expires on time)', async () => {
    const { owner, conv, ownerId, ledger: a } = await approvedMission({ expiresAtRelMs: 3_600_000 });
    const run = fakeRun({ actingUserId: ownerId, chatSessionId: conv });
    await resolveConversationToolGate({ tenantId: T, conversationKey: conv, ceiling: CEIL, approvals: [], run }); // turn under A
    const revoked = (await owner('POST', IL(conv, '/reject'), version(a))).body.ledger as IntentLedger;
    const d = (await owner('POST', IL(conv, '/draft'), { goal: 'B', allowed: ['kb'], expiresAtRelMs: 3_600_000 })).body.ledger as IntentLedger;
    expect(d.revision ?? 0).toBeGreaterThan(revoked.revision ?? 0);
    const b = (await owner('POST', IL(conv, '/approve'), version(d))).body.ledger as IntentLedger;
    // A turn under B: not expired (B's anchor is now, not A's).
    const g1 = await resolveConversationToolGate({ tenantId: T, conversationKey: conv, ceiling: CEIL, approvals: [], run });
    expect(g1.scope?.enabled).toEqual(['kb.search']);
    const keys = Object.keys(run.metadata?.intentLedgerApprovals as object);
    expect(keys).toHaveLength(2); // A's entry kept, B's appended
    // Two hours later on the SAME run, B's TTL has elapsed and the expiry is persisted.
    (run.metadata!.intentLedgerApprovals as Record<string, { resolvedAt: string }>)[`${b.ledgerId}@${b.approvedAt}`]!.resolvedAt = hoursAgo(2);
    const g2 = await resolveConversationToolGate({ tenantId: T, conversationKey: conv, ceiling: CEIL, approvals: [], run });
    expect(g2.scope?.enabled).toEqual([]);
    expect((await getLedger(T, conv))?.status).toBe('expired');
  });

  it('a :fork past the TTL on its COPIED stamp is out of mandate itself but never writes back to the live ledger', async () => {
    const { conv, ledger } = await approvedMission({ expiresAtRelMs: 3_600_000 });
    const fork = fakeRun({ actingUserId: 'user:the-forker', chatSessionId: conv, ...approvalsOf(ledger, hoursAgo(2), {}, 'run-the-source') });
    const g = await resolveConversationToolGate({ tenantId: T, conversationKey: conv, ceiling: CEIL, approvals: [], run: fork });
    expect(g.scope?.enabled).toEqual([]); // deterministic: the recorded anchor
    expect((await getLedger(T, conv))?.status).toBe('approved'); // the source owner's ledger is untouched
  });

  it('delta M1 — once approvedAt + TTL has passed, ANY run records the expiry (a branch-fork the user moved to)', async () => {
    const { conv, ledger } = await approvedMission({ expiresAtRelMs: 3_600_000 });
    await saveLedger({ ...(await getLedger(T, conv))!, approvedAt: hoursAgo(2) });
    const moved = (await getLedger(T, conv))!;
    const fork = fakeRun({ actingUserId: 'user:the-forker', chatSessionId: conv, ...approvalsOf(moved, hoursAgo(2), {}, 'run-the-source') });
    const g = await resolveConversationToolGate({ tenantId: T, conversationKey: conv, ceiling: CEIL, approvals: [], run: fork });
    expect(g.scope?.enabled).toEqual([]);
    expect((await getLedger(T, conv))?.status).toBe('expired');
    void ledger;
  });

  it('a fork carrying the source\'s stamp re-reads the recorded anchor: its expiry IS the source\'s (never earlier)', async () => {
    const { conv, ledger } = await approvedMission({ expiresAtRelMs: 3_600_000 });
    // Within TTL on the source's clock ⇒ the fork, whoever forked it, keeps the tools.
    const fresh = fakeRun({ actingUserId: 'user:someone-else', chatSessionId: conv, ...approvalsOf(ledger, hoursAgo(0.5)) });
    const g = await resolveConversationToolGate({ tenantId: T, conversationKey: conv, ceiling: CEIL, approvals: [], run: fresh });
    expect(g.scope?.enabled).toEqual(['kb.search']);
    expect((await getLedger(T, conv))?.status).toBe('approved');
  });

  it('control — the run that MINTED this approval\'s stamp, past its TTL, ends the mission (persisted expired)', async () => {
    const { conv, ownerId, ledger } = await approvedMission({ expiresAtRelMs: 3_600_000 });
    const run = fakeRun({ actingUserId: ownerId, chatSessionId: conv });
    run.metadata = { ...run.metadata, ...approvalsOf(ledger, hoursAgo(2), {}, run.runId) };
    const gate = await resolveConversationToolGate({ tenantId: T, conversationKey: conv, ceiling: CEIL, approvals: [], run });
    expect(gate.scope?.enabled).toEqual([]);
    expect((await getLedger(T, conv))?.status).toBe('expired');
  });

  it('a fresh run (no stamp for this approval) mints its own anchor — it cannot end the mission early', async () => {
    const { conv, ledger } = await approvedMission({ expiresAtRelMs: 3_600_000 });
    const run = fakeRun({ actingUserId: 'user:anyone', chatSessionId: conv });
    const gate = await resolveConversationToolGate({ tenantId: T, conversationKey: conv, ceiling: CEIL, approvals: [], run });
    expect(gate.scope?.enabled).toEqual(['kb.search']);
    const entry = (run.metadata?.intentLedgerApprovals as Record<string, { resolvedAt: string }>)[`${ledger.ledgerId}@${ledger.approvedAt}`];
    expect(Date.parse(entry!.resolvedAt)).toBeGreaterThanOrEqual(Date.parse(ledger.approvedAt!));
  });

  it('the expiry write never overwrites a mission that changed under it (CAS against the row read)', async () => {
    const { conv, ownerId, ledger } = await approvedMission({ expiresAtRelMs: 3_600_000 });
    const run = fakeRun({ actingUserId: ownerId, chatSessionId: conv });
    run.metadata = { ...run.metadata, ...approvalsOf(ledger, hoursAgo(2), {}, run.runId) };
    // The owner revokes AFTER the gate read the approved row and BEFORE its write lands.
    writeHook.before = async () => { const cur = (await getLedger(T, conv))!; await saveLedger({ ...cur, status: 'rejected', revision: (cur.revision ?? 0) + 1 }); };
    const gate = await resolveConversationToolGate({ tenantId: T, conversationKey: conv, ceiling: CEIL, approvals: [], run });
    expect(writeHook.before).toBeNull(); // the hook ran: the gate reached its write
    expect(gate.scope?.enabled).toEqual([]); // this turn is still out of mandate
    expect((await getLedger(T, conv))?.status).toBe('rejected'); // …but the revoke stands
  });

  it('the voice (runless) lane anchors at the APPROVAL, not the first draft, and never persists expiry', async () => {
    const { conv, ledger } = await approvedMission({ expiresAtRelMs: 3_600_000 });
    // A draft created long ago, approved now: the runless anchor is approvedAt, so still in mandate.
    await saveLedger({ ...(await getLedger(T, conv))!, createdAt: hoursAgo(10) });
    const fresh = await resolveConversationToolGate({ tenantId: T, conversationKey: conv, ceiling: CEIL, approvals: [] });
    expect(fresh.scope?.enabled).toEqual(['kb.search']);
    await saveLedger({ ...(await getLedger(T, conv))!, approvedAt: hoursAgo(2) });
    const late = await resolveConversationToolGate({ tenantId: T, conversationKey: conv, ceiling: CEIL, approvals: [] });
    expect(late.scope?.enabled).toEqual([]);
    expect((await getLedger(T, conv))?.status).toBe('approved'); // runless never ends it for everyone
    void ledger;
  });
});

describe('D6 — the reckoning reports the CURRENT approval only', () => {
  it('a newer run stamped under another approval is not credited; events before the anchor are not credited', async () => {
    const { owner, conv, ownerId, ledger } = await approvedMission();
    const mk = async (md: Record<string, unknown>, createdAt: string, tool: string, at: string) => {
      const r = buildRunRecord({ workflowId: 'wf', tenantId: T, actingUserId: ownerId, now: createdAt });
      r.metadata = { ...(r.metadata ?? {}), chatSessionId: conv, ...md };
      await storage.insertRun(r);
      await storage.appendEvent({ eventId: `e-${n++}`, runId: r.runId, type: 'agent.toolReturned', payload: { toolName: tool, status: 'ok' }, timestamp: at });
      return r;
    };
    const mine = await mk(approvalsOf(ledger, hoursAgo(1)), hoursAgo(1), 'kb.search', hoursAgo(0.5));
    // The SAME conversation-long run did other work before this mission was approved.
    await storage.appendEvent({ eventId: `e-${n++}`, runId: mine.runId, type: 'agent.toolReturned', payload: { toolName: 'openwop:crm.delete', status: 'ok' }, timestamp: hoursAgo(3) });
    await mk(approvalsOf({ ...ledger, ledgerId: 'il-other', goal: 'NOT THE MISSION' }, hoursAgo(0.1)), hoursAgo(0.1), 'openwop:email.send', hoursAgo(0.05));
    const r = await owner('GET', IL(conv, '/reckoning'));
    expect(r.status).toBe(200);
    expect(r.body.reckoning?.goal).toBe(ledger.goal);
    expect(r.body.reckoning?.usedTools).toEqual(['kb.search']); // not the other approval's, not pre-approval work
  });
});

describe('D7b — the lifecycle writers keep the invariants', () => {
  it('the retention purger never deletes a mission in force (approved or expired), only revoked/draft ones past the window', async () => {
    const { conv, ledger } = await approvedMission();
    const old = hoursAgo(24 * 400);
    await saveLedger({ ...(await getLedger(T, conv))!, createdAt: old, updatedAt: old });
    const draftConv = `il896-purge-${n++}`;
    await saveLedger({ ...ledger, conversationId: draftConv, status: 'draft', createdAt: old, updatedAt: old });
    const { purgeRetained } = await import('../src/host/retentionPurger.js');
    await purgeRetained(T, 'confidential-pii', hoursAgo(24 * 30));
    expect((await getLedger(T, conv))?.status).toBe('approved');
    expect(await getLedger(T, draftConv)).toBeNull();
  });

  it('the DSAR eraser writes through the CAS writer: the redaction bumps the revision (a stale page cannot approve over it)', async () => {
    const { owner, ownerId, conv, ledger } = await approvedMission();
    const revoked = (await owner('POST', IL(conv, '/reject'), version(ledger))).body.ledger as IntentLedger;
    expect(revoked.rejectedBy).toBe(ownerId); // IL2CD-5: a revoke is attributed
    const { eraseIntentLedgerSubject } = await import('../src/features/intent-ledger/ledgerStore.js');
    await eraseIntentLedgerSubject(T, ownerId);
    const after = (await getLedger(T, conv))!;
    expect(after.approvedBy).not.toBe(ownerId);
    expect(after.rejectedBy).not.toBe(ownerId);
    expect(after.revision).toBe((revoked.revision ?? 0) + 1);
  });
});

describe('D7 — the agent reads the whole contract', () => {
  it('intent-ledger.get carries requireApproval and the TTL', async () => {
    const { conv, ownerId } = await approvedMission({ requireApproval: ['kb.write'], expiresAtRelMs: 600_000 });
    const out = await createAgentToolProvider({ tenantId: T, runId: 'r', actingUserId: ownerId }).executeTool({ name: INTENT_LEDGER_GET_TOOL_ID, input: { conversationId: conv } });
    const l = JSON.parse(out.content).ledger;
    expect(l.requireApproval).toEqual(['kb.write']);
    expect(l.expiresAtRelMs).toBe(600_000);
    expect(l.digest).toBe(ledgerDigest((await getLedger(T, conv))!)); // the digest an approve must echo
  });
});

describe('floors — viewer and removed member', () => {
  async function workspace() {
    const tenantId = `org:il896-${Date.now()}-${n++}`;
    const owner = client(); const editor = client(); const viewer = client();
    const ids: string[] = [];
    for (const c of [owner, editor, viewer]) {
      const r = await c('POST', '/host/openwop-app/test/login', { email: `il896f-${n++}@acme.test`, tenantId });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      ids.push(r.body.user.userId as string);
    }
    const [, editorId, viewerId] = ids as [string, string, string];
    const add = async (subject: string, role: string) => {
      const a = await owner('POST', `/host/openwop-app/orgs/${encodeURIComponent(tenantId)}/members`, { displayName: role, subject, roles: [role] });
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      return a.body.memberId as string;
    };
    const editorMemberId = await add(editorId, 'editor');
    await add(viewerId, 'viewer');
    return { tenantId, owner, editor, viewer, editorMemberId };
  }

  it('a viewer cannot open a mission on a conversation (no write role)', async () => {
    const w = await workspace();
    const s = await w.viewer('POST', '/host/openwop-app/chat/sessions', { title: 'v' });
    expect(s.status, JSON.stringify(s.body)).toBe(201); // a viewer CAN own a conversation…
    const conv = s.body.sessionId as string;
    const d = await w.viewer('POST', IL(conv, '/draft'), { goal: 'g' });
    expect(d.status, JSON.stringify(d.body)).toBe(403); // …but cannot draft its mission
    expect((await w.viewer('GET', IL(conv))).body.viewer).toEqual({ mayEdit: false, mayDecide: false });
  });

  it('a REMOVED member can no longer revoke the mission on the conversation they still own', async () => {
    const w = await workspace();
    const conv = (await w.editor('POST', '/host/openwop-app/chat/sessions', { title: 'e' })).body.sessionId as string;
    const d = await w.editor('POST', IL(conv, '/draft'), { goal: 'g', forbidden: ['openwop:email.send'] });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const a = await w.editor('POST', IL(conv, '/approve'), version(d.body.ledger));
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const del = await w.owner('DELETE', `/host/openwop-app/orgs/${encodeURIComponent(w.tenantId)}/members/${encodeURIComponent(w.editorMemberId)}`);
    expect(del.status, JSON.stringify(del.body)).toBeLessThan(300);
    const r = await w.editor('POST', IL(conv, '/reject'), version(a.body.ledger));
    expect(r.status).toBe(403); // the write floor, not an auth or visibility artefact
    expect((await getLedger(w.tenantId, conv))?.status).toBe('approved');
  });
});
