/**
 * ADR 0469 Phase A — anonymous-actor operator surface: the production write/egress
 * activation on the widget. Behavioral coverage of the four Phase-A seams:
 *
 *   - A2 write→HOLD: a granted anon write creates a DURABLE `anon-surface-write`
 *     approval (deterministic business key) and is NEVER executed in-turn; the loop
 *     is told `pending_approval`.
 *   - A3 cap gates CREATION (anti-flood): `checkAnonWrite` denies past the per-day
 *     write cap; the wrapper audits `anon-write-capped` and creates no approval.
 *   - A1 idempotency: a retried dispatch (same run + tool-call index) reuses the row
 *     — no duplicate operator-inbox entries.
 *   - A4 approve→execute / reject→no effect, AND the no-secret floor survives the
 *     approve path: a DELIVERABLE (ADR 0308) held write fails closed on approve and
 *     the approval RE-OPENS (approval is not a secret-reach bypass).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  runAnonReadTurn,
  registerAnonSurfaceWriteGate,
} from '../src/host/anonymousActor.js';
import {
  createAnonSurfaceWriteApproval,
  getApproval,
  getAnonSurfaceWriteApprovalHandler,
  eraseApprovalSubject,
  ERASED_SUBJECT_SENTINEL,
} from '../src/host/approvalService.js';
import { checkAnonWrite } from '../src/features/chat-widget/capsTracker.js';
import { createOrg } from '../src/host/accessControlService.js';
import type { WidgetConfig } from '../src/features/chat-widget/widgetService.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

const AGENT = { agentId: 'a-anon', persona: 'Greeter', systemPrompt: 'You are a public assistant.' };
const READ = 'openwop:knowledge.search';        // tenant-scoped read — succeeds with NO acting user
const DELIVERABLE = 'openwop:kanban.add-todo';  // ADR 0308 — fails closed without an acting user
const DAY = '2026-07-22';

// ADR 0470 P3 — the per-widget-per-day write counter is now consumed even by an
// uncapped write (bounded by the secure default), so each cap-sensitive test passes a
// DISTINCT widgetId to isolate its counter (a shared id leaks budget across tests).
function widget(caps: WidgetConfig['caps'], id = 'wgt-1'): WidgetConfig {
  return {
    widgetId: id, tenantId: 'acme', orgId: 'org-1', agentId: AGENT.agentId,
    allowedDomains: ['example.com'], caps, token: 'wgt_tok', enabled: true,
    createdBy: 'op', createdAt: DAY, updatedAt: DAY,
  };
}

/** One-round provider: request `calls`, then settle. Captures the settle-round
 *  messages so a test can see what result the loop was told. */
function scriptedProvider(
  calls: { id: string; name: string; input: Record<string, unknown> }[],
  captured: { round2: AiToolCallRequest['messages'] },
): (r: AiToolCallRequest) => Promise<AiToolCallResult> {
  let round = 0;
  return async (r) => {
    round += 1;
    if (round === 1) return { content: '', toolCalls: calls };
    captured.round2 = r.messages;
    return { content: 'done', toolCalls: [] };
  };
}

/** Wire the SAME hold hook the publicGateway wires: cap-gate FIRST, then create the
 *  durable hold. `w`/`day` are closed over so the test controls the cap. */
function holdHook(w: WidgetConfig, day: string) {
  return async (
    call: { name: string; input?: Record<string, unknown> },
    hctx: { runId: string; principal: string; toolCallIdx: number },
  ): Promise<{ status: 'held' | 'capped' | 'error' }> => {
    const capd = await checkAnonWrite(w, day);
    if (!capd.allowed) return { status: 'capped' };
    await createAnonSurfaceWriteApproval({
      tenantId: w.tenantId, orgId: w.orgId, widgetId: w.widgetId,
      principal: hctx.principal, runId: hctx.runId, toolCallIdx: hctx.toolCallIdx,
      tool: { name: call.name, ...(call.input ? { args: call.input } : {}) },
    });
    return { status: 'held' };
  };
}

let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  storage = await openStorage('memory://');
  initHostExtPersistence(storage); // the approval store rides the host-ext singleton
  registerAnonSurfaceWriteGate();  // A4 handler on the core approvals hook
  // Seed org-1 with `op-1` as owner → holds workspace:write (the decider-scope gate).
  await createOrg({ tenantId: 'acme', createdBy: 'op-1', name: 'Org One', orgId: 'org-1', ownerSubject: 'op-1' });
});

describe('ADR 0469 A2 — a granted anon write is HELD, not executed', () => {
  it('creates a durable anon-surface-write approval + tells the loop pending_approval', async () => {
    const captured = { round2: [] as AiToolCallRequest['messages'] };
    const w = widget({}, 'wgt-a2'); // uncapped (distinct id — P3 default now counts)
    const turn = await runAnonReadTurn({
      storage, tenantId: w.tenantId, agent: AGENT,
      grant: { read: [], write: [DELIVERABLE], writeControl: 'hitl' },
      surfaceSessionKey: `${w.widgetId}:s1`, fencedUserMessage: 'add a todo',
      callAIWithTools: scriptedProvider([{ id: 'c1', name: DELIVERABLE, input: { title: 'x' } }], captured),
      holdGrantedWrite: holdHook(w, DAY),
    });
    // The held write reaches the operator inbox as a durable, pending approval…
    const appr = await getApproval(`appr:anon:${turn.runId}:0`);
    expect(appr?.kind).toBe('anon-surface-write');
    expect(appr?.status).toBe('pending');
    expect(appr?.anonSurfaceWrite?.tool.name).toBe(DELIVERABLE);
    expect(appr?.orgId).toBe(w.orgId);
    // …and the loop was told it is awaiting review — the tool never ran in-turn.
    expect(JSON.stringify(captured.round2)).toContain('pending_approval');
    // The decision ledger records the granted-but-held write.
    const decisions = (await storage.listEvents(turn.runId)).filter((e) => e.type === 'authorization.decided').map((e) => e.payload as { reason: string; allowed: boolean });
    expect(decisions).toContainEqual(expect.objectContaining({ allowed: true, reason: 'anon-write-held' }));
  });
});

describe('ADR 0469 A3 — the per-day write cap gates approval CREATION (anti-flood)', () => {
  it('denies past the cap and creates no approval + audits anon-write-capped', async () => {
    const w = widget({ maxWritesPerDay: 1 }, 'wgt-a3');
    // First write consumes the single-write budget → held.
    const captured1 = { round2: [] as AiToolCallRequest['messages'] };
    const t1 = await runAnonReadTurn({
      storage, tenantId: w.tenantId, agent: AGENT,
      grant: { read: [], write: [DELIVERABLE], writeControl: 'hitl' },
      surfaceSessionKey: `${w.widgetId}:s2`, fencedUserMessage: 'go',
      callAIWithTools: scriptedProvider([{ id: 'c1', name: DELIVERABLE, input: { title: 'x' } }], captured1),
      holdGrantedWrite: holdHook(w, DAY),
    });
    expect((await getApproval(`appr:anon:${t1.runId}:0`))?.status).toBe('pending');
    // Second write (a fresh turn, SAME widget+day) is over the cap → capped, no hold.
    const captured2 = { round2: [] as AiToolCallRequest['messages'] };
    const t2 = await runAnonReadTurn({
      storage, tenantId: w.tenantId, agent: AGENT,
      grant: { read: [], write: [DELIVERABLE], writeControl: 'hitl' },
      surfaceSessionKey: `${w.widgetId}:s3`, fencedUserMessage: 'go',
      callAIWithTools: scriptedProvider([{ id: 'c1', name: DELIVERABLE, input: { title: 'x' } }], captured2),
      holdGrantedWrite: holdHook(w, DAY),
    });
    expect(await getApproval(`appr:anon:${t2.runId}:0`)).toBeNull();
    expect(JSON.stringify(captured2.round2)).toContain('anon_write_capped');
    const decisions = (await storage.listEvents(t2.runId)).filter((e) => e.type === 'authorization.decided').map((e) => e.payload as { reason: string; allowed: boolean });
    expect(decisions).toContainEqual(expect.objectContaining({ allowed: false, reason: 'anon-write-capped' }));
  });
});

describe('ADR 0469 A1 — the hold is idempotent (deterministic business key)', () => {
  it('a retried create with the same run + tool-call index reuses the row', async () => {
    const base = { tenantId: 'acme', orgId: 'org-1', widgetId: 'wgt-1', principal: 'anon:sess-abc', runId: 'run-x', toolCallIdx: 0, tool: { name: READ } };
    const a = await createAnonSurfaceWriteApproval(base);
    const b = await createAnonSurfaceWriteApproval(base);
    expect(a.approvalId).toBe(b.approvalId);
    expect(a.approvalId).toBe('appr:anon:run-x:0');
  });
});

describe('ADR 0469 A4 — approve→execute, reject→no effect, no-secret floor holds', () => {
  it('REJECT resolves the approval with no execution', async () => {
    const appr = await createAnonSurfaceWriteApproval({ tenantId: 'acme', orgId: 'org-1', widgetId: 'wgt-1', principal: 'anon:sess-r', runId: 'run-r', toolCallIdx: 0, tool: { name: READ } });
    const handler = getAnonSurfaceWriteApprovalHandler();
    expect(handler).not.toBeNull();
    const decided = await handler!('acme', appr.approvalId, 'rejected', { decidedByUserId: 'op-1' });
    expect(decided?.changed).toBe(true);
    expect((await getApproval(appr.approvalId))?.status).toBe('rejected');
  });

  it('APPROVE of a DELIVERABLE held write fails closed (ADR 0308) and RE-OPENS — approval is not a secret-reach bypass', async () => {
    const appr = await createAnonSurfaceWriteApproval({ tenantId: 'acme', orgId: 'org-1', widgetId: 'wgt-1', principal: 'anon:sess-d', runId: 'run-d', toolCallIdx: 0, tool: { name: DELIVERABLE, args: { title: 'x' } } });
    const handler = getAnonSurfaceWriteApprovalHandler();
    await expect(handler!('acme', appr.approvalId, 'approved', { decidedByUserId: 'op-1' })).rejects.toThrow();
    // The failed deferred execution re-opened the approval — it never claims "approved".
    expect((await getApproval(appr.approvalId))?.status).toBe('pending');
  });

  it('APPROVE of a tenant-scoped tool that needs no acting user EXECUTES and resolves approved', async () => {
    const appr = await createAnonSurfaceWriteApproval({ tenantId: 'acme', orgId: 'org-1', widgetId: 'wgt-1', principal: 'anon:sess-a', runId: 'run-a', toolCallIdx: 0, tool: { name: READ, args: { query: 'hi' } } });
    const handler = getAnonSurfaceWriteApprovalHandler();
    const decided = await handler!('acme', appr.approvalId, 'approved', { decidedByUserId: 'op-1' });
    expect(decided?.changed).toBe(true);
    expect((await getApproval(appr.approvalId))?.status).toBe('approved');
  });

  it('an under-privileged decider (no workspace:write) is REFUSED — visibility is not decision authority', async () => {
    const appr = await createAnonSurfaceWriteApproval({ tenantId: 'acme', orgId: 'org-1', widgetId: 'wgt-1', principal: 'anon:sess-u', runId: 'run-u', toolCallIdx: 0, tool: { name: READ, args: { query: 'hi' } } });
    const handler = getAnonSurfaceWriteApprovalHandler();
    // A tenant member with no membership in org-1 → zero scopes → 403, approval untouched.
    await expect(handler!('acme', appr.approvalId, 'approved', { decidedByUserId: 'stranger' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    expect((await getApproval(appr.approvalId))?.status).toBe('pending');
  });

  it('a wrong-tenant decide is refused (returns null → route 404)', async () => {
    const appr = await createAnonSurfaceWriteApproval({ tenantId: 'acme', orgId: 'org-1', widgetId: 'wgt-1', principal: 'anon:sess-t', runId: 'run-t', toolCallIdx: 0, tool: { name: READ } });
    const handler = getAnonSurfaceWriteApprovalHandler();
    expect(await handler!('other-tenant', appr.approvalId, 'approved', { decidedByUserId: 'op-1' })).toBeNull();
  });
});

describe('ADR 0469 OD4 — subject erasure cancels + fully redacts a held anon write', () => {
  const withPii = (runId: string) => ({
    tenantId: 'acme', orgId: 'org-1', widgetId: 'wgt-1', principal: `anon:sess-${runId}`,
    runId, toolCallIdx: 0,
    tool: { name: DELIVERABLE, args: { title: 'call John at 555-0100', note: 'jane@example.com' }, destination: 'https://hooks.example.com/x' },
    captured: { name: 'Jane Doe', email: 'jane@example.com', note: 'ping me' },
  });

  it('a PENDING hold is CANCELLED (rejected) + principal/captured/tool.args/destination all redacted', async () => {
    const appr = await createAnonSurfaceWriteApproval(withPii('erase-p'));
    const touched = await eraseApprovalSubject('acme', 'anon:sess-erase-p');
    expect(touched).toBeGreaterThan(0);
    const after = await getApproval(appr.approvalId);
    expect(after?.status).toBe('rejected'); // cancelled — A4 can never execute it now
    expect(after?.anonSurfaceWrite?.principal).toBe(ERASED_SUBJECT_SENTINEL);
    expect(after?.anonSurfaceWrite?.capturedName).toBe(ERASED_SUBJECT_SENTINEL);
    expect(after?.anonSurfaceWrite?.capturedEmail).toBe(ERASED_SUBJECT_SENTINEL);
    expect(after?.anonSurfaceWrite?.capturedNote).toBe(ERASED_SUBJECT_SENTINEL);
    // the nested visitor-typed args + destination — the OD4 gap — are gone
    expect(after?.anonSurfaceWrite?.tool.args).toBe(ERASED_SUBJECT_SENTINEL);
    expect(after?.anonSurfaceWrite?.tool.destination).toBe(ERASED_SUBJECT_SENTINEL);
    expect(JSON.stringify(after)).not.toContain('555-0100');
    expect(JSON.stringify(after)).not.toContain('jane@example.com');
  });

  it('a RESOLVED hold is redacted but KEEPS its terminal status (audit record)', async () => {
    const appr = await createAnonSurfaceWriteApproval(withPii('erase-r'));
    // Resolve it first (reject via the gate — op-1 holds workspace:write in org-1).
    await getAnonSurfaceWriteApprovalHandler()!('acme', appr.approvalId, 'rejected', { decidedByUserId: 'op-1' });
    expect((await getApproval(appr.approvalId))?.status).toBe('rejected');
    await eraseApprovalSubject('acme', 'anon:sess-erase-r');
    const after = await getApproval(appr.approvalId);
    expect(after?.status).toBe('rejected'); // terminal status untouched
    expect(after?.anonSurfaceWrite?.tool.args).toBe(ERASED_SUBJECT_SENTINEL);
    expect(after?.anonSurfaceWrite?.capturedEmail).toBe(ERASED_SUBJECT_SENTINEL);
  });

  it('is idempotent — a second erase of the same subject is a no-op', async () => {
    await createAnonSurfaceWriteApproval(withPii('erase-i'));
    expect(await eraseApprovalSubject('acme', 'anon:sess-erase-i')).toBeGreaterThan(0);
    expect(await eraseApprovalSubject('acme', 'anon:sess-erase-i')).toBe(0); // principal already sentinel → no match
  });

  it('leaves a DIFFERENT subject untouched', async () => {
    const appr = await createAnonSurfaceWriteApproval(withPii('erase-o'));
    await eraseApprovalSubject('acme', 'anon:sess-someone-else');
    const after = await getApproval(appr.approvalId);
    expect(after?.status).toBe('pending'); // not cancelled
    expect(after?.anonSurfaceWrite?.principal).toBe('anon:sess-erase-o'); // not redacted
  });
});

describe('ADR 0470 OQ4 — resolved anon-lead approvals are redacted (PII-free audit rows)', () => {
  const lead = (runId: string, tool: string) => createAnonSurfaceWriteApproval({
    tenantId: 'acme', orgId: 'org-1', widgetId: 'wgt-1', principal: `anon:sess-${runId}`, runId, toolCallIdx: 0,
    tool: { name: tool, args: tool === READ ? { query: 'hi', email: 'jane@example.com' } : { title: 'x', email: 'jane@example.com' } },
    captured: { name: 'Jane', email: 'jane@example.com', note: 'wants a demo' },
  });

  it('REJECT redacts captured*/tool.args/principal — the declined lead PII is gone, status stays rejected', async () => {
    const appr = await lead('oq4-r', DELIVERABLE);
    await getAnonSurfaceWriteApprovalHandler()!('acme', appr.approvalId, 'rejected', { decidedByUserId: 'op-1' });
    const after = await getApproval(appr.approvalId);
    expect(after?.status).toBe('rejected'); // audit row kept
    expect(after?.anonSurfaceWrite?.capturedEmail).toBe(ERASED_SUBJECT_SENTINEL);
    expect(after?.anonSurfaceWrite?.principal).toBe(ERASED_SUBJECT_SENTINEL);
    expect(after?.anonSurfaceWrite?.tool.args).toBe(ERASED_SUBJECT_SENTINEL);
    expect(JSON.stringify(after)).not.toContain('jane@example.com');
    expect(after?.anonSurfaceWrite?.tool.name).toBe(DELIVERABLE); // the non-PII tool name survives (audit)
  });

  it('APPROVE redacts the approval PII AFTER execution — the CRM Contact is the canonical record', async () => {
    const appr = await lead('oq4-a', READ); // READ succeeds actingUserId-undefined → approve completes
    const decided = await getAnonSurfaceWriteApprovalHandler()!('acme', appr.approvalId, 'approved', { decidedByUserId: 'op-1' });
    expect(decided?.changed).toBe(true);
    const after = await getApproval(appr.approvalId);
    expect(after?.status).toBe('approved');
    expect(after?.anonSurfaceWrite?.capturedEmail).toBe(ERASED_SUBJECT_SENTINEL);
    expect(after?.anonSurfaceWrite?.principal).toBe(ERASED_SUBJECT_SENTINEL);
    expect(JSON.stringify(after)).not.toContain('jane@example.com');
  });
});
