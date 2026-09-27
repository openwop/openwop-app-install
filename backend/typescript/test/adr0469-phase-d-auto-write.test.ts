/**
 * ADR 0469 Phase D — the `rate-limit-session-cap` write control.
 *
 *  - AUTO-EXECUTE: a granted write under the control runs INLINE (not held) when the
 *    per-session cap allows — audited `anon-write-auto-allowed`. The no-secret floor
 *    still holds (a deliverable runs actingUserId-undefined → fails closed).
 *  - OVER CAP: denied inline, audited `anon-write-auto-capped`, never executed.
 *  - EGRESS FALL-BACK (architect Q1): a surface that declares egress audiences keeps
 *    the write on the HITL hold path — auto-execute is never reached, so no
 *    audience-unbound egress is auto-run.
 *  - per-session counter fail-closed when uncapped; the cross-field save guard.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { runAnonReadTurn } from '../src/host/anonymousActor.js';
import { checkAnonAutoWrite } from '../src/features/chat-widget/capsTracker.js';
import { provisionWidget, patchWidget } from '../src/features/chat-widget/widgetService.js';
import type { WidgetConfig } from '../src/features/chat-widget/widgetService.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

const AGENT = { agentId: 'a-anon', persona: 'Greeter', systemPrompt: 'You are a public assistant.' };
const DELIVERABLE = 'openwop:kanban.add-todo'; // ADR 0308 — fails closed without an acting user
const DAY = '2026-07-22';

function scriptedProvider(calls: { id: string; name: string; input: Record<string, unknown> }[], captured: { round2: AiToolCallRequest['messages'] }): (r: AiToolCallRequest) => Promise<AiToolCallResult> {
  let round = 0;
  return async (r) => { round += 1; if (round === 1) return { content: '', toolCalls: calls }; captured.round2 = r.messages; return { content: 'done', toolCalls: [] }; };
}
const reasonsOf = async (storage: Awaited<ReturnType<typeof openStorage>>, runId: string): Promise<string[]> =>
  (await storage.listEvents(runId)).filter((e) => e.type === 'authorization.decided').map((e) => (e.payload as { reason: string }).reason);

describe('ADR 0469 Phase D — rate-limit-session-cap auto-write', () => {
  it('AUTO-EXECUTES the write inline (not held) when the cap allows — audited anon-write-auto-allowed', async () => {
    const storage = await openStorage('memory://');
    const captured = { round2: [] as AiToolCallRequest['messages'] };
    const turn = await runAnonReadTurn({
      storage, tenantId: 'acme', agent: AGENT,
      grant: { read: [], write: [DELIVERABLE], writeControl: 'rate-limit-session-cap' },
      surfaceSessionKey: 'w:s1', fencedUserMessage: 'go',
      callAIWithTools: scriptedProvider([{ id: 'c1', name: DELIVERABLE, input: { title: 'x' } }], captured),
      autoWriteUnderCap: async () => ({ allowed: true }),
    });
    // Executed inline: the loop was fed the tool RESULT, not a pending_approval hold.
    expect(JSON.stringify(captured.round2)).toContain(`Result of ${DELIVERABLE}`);
    expect(JSON.stringify(captured.round2)).not.toContain('pending_approval');
    // The no-secret floor still holds: the deliverable ran actingUserId-undefined → fails closed.
    expect(JSON.stringify(captured.round2)).toContain('acting_user_required');
    expect(await reasonsOf(storage, turn.runId)).toContain('anon-write-auto-allowed');
  });

  it('N3 — the auto path LANDS a real tool result end-to-end (a tool that succeeds actingUserId-undefined)', async () => {
    // Granting a tenant-scoped tool that SUCCEEDS without an acting user (knowledge.search)
    // AS a write proves the auto-execute plumbing runs the tool and feeds back its REAL
    // result — not just the fail-closed floor a deliverable proves. (No genuine MUTATION
    // tool lands today: every tenant-write tool is an ADR 0308 deliverable — see the ADR
    // 0469 §N3 characterization; a non-deliverable write tool is a separate follow-on.)
    const READ = 'openwop:knowledge.search';
    const storage = await openStorage('memory://');
    const captured = { round2: [] as AiToolCallRequest['messages'] };
    const turn = await runAnonReadTurn({
      storage, tenantId: 'acme', agent: AGENT,
      grant: { read: [], write: [READ], writeControl: 'rate-limit-session-cap' }, // read tool GRANTED AS a write
      surfaceSessionKey: 'w:s-land', fencedUserMessage: 'go',
      callAIWithTools: scriptedProvider([{ id: 'c1', name: READ, input: { query: 'hi' } }], captured),
      autoWriteUnderCap: async () => ({ allowed: true }),
    });
    expect(JSON.stringify(captured.round2)).toContain(`Result of ${READ}`); // executed
    expect(JSON.stringify(captured.round2)).not.toContain('acting_user_required'); // SUCCEEDED (not fail-closed)
    expect(JSON.stringify(captured.round2)).not.toContain('pending_approval'); // not held
    expect(await reasonsOf(storage, turn.runId)).toContain('anon-write-auto-allowed');
  });

  it('OVER CAP: denied inline (never executed), audited anon-write-auto-capped', async () => {
    const storage = await openStorage('memory://');
    const captured = { round2: [] as AiToolCallRequest['messages'] };
    const turn = await runAnonReadTurn({
      storage, tenantId: 'acme', agent: AGENT,
      grant: { read: [], write: [DELIVERABLE], writeControl: 'rate-limit-session-cap' },
      surfaceSessionKey: 'w:s2', fencedUserMessage: 'go',
      callAIWithTools: scriptedProvider([{ id: 'c1', name: DELIVERABLE, input: { title: 'x' } }], captured),
      autoWriteUnderCap: async () => ({ allowed: false }),
    });
    expect(JSON.stringify(captured.round2)).toContain('anon_write_auto_capped');
    // Denied BEFORE the tool ran — so the executed-tool's fail-closed marker is absent.
    expect(JSON.stringify(captured.round2)).not.toContain('acting_user_required');
    expect(await reasonsOf(storage, turn.runId)).toContain('anon-write-auto-capped');
  });

  it('EGRESS FALL-BACK (Q1): a surface with egress audiences HOLDS the write — auto-execute is never reached', async () => {
    const storage = await openStorage('memory://');
    const captured = { round2: [] as AiToolCallRequest['messages'] };
    let autoCalled = false;
    let heldCalled = false;
    await runAnonReadTurn({
      storage, tenantId: 'acme', agent: AGENT,
      grant: { read: [], write: [DELIVERABLE], writeControl: 'rate-limit-session-cap', egressAudiences: ['api.acme.example'] },
      surfaceSessionKey: 'w:s3', fencedUserMessage: 'go',
      callAIWithTools: scriptedProvider([{ id: 'c1', name: DELIVERABLE, input: { title: 'x' } }], captured),
      autoWriteUnderCap: async () => { autoCalled = true; return { allowed: true }; },
      holdGrantedWrite: async () => { heldCalled = true; return { status: 'held' }; },
    });
    expect(autoCalled).toBe(false); // never auto-run on an egress surface
    expect(heldCalled).toBe(true);  // fell back to the HITL hold path
    expect(JSON.stringify(captured.round2)).toContain('pending_approval');
  });
});

function widget(caps: WidgetConfig['caps']): WidgetConfig {
  return { widgetId: 'wgt-d', tenantId: 'acme', orgId: 'org-1', agentId: 'a', allowedDomains: ['x.com'], caps, token: 'wgt_t', enabled: true, createdBy: 'op', createdAt: DAY, updatedAt: DAY };
}

describe('ADR 0469 Phase D — checkAnonAutoWrite (per-session, fail-closed when uncapped)', () => {
  beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

  it('fails closed when no per-session cap is set (an unbounded auto control is forbidden)', async () => {
    expect(await checkAnonAutoWrite(widget({}), 'sess-a', DAY)).toEqual({ allowed: false, reason: 'auto_write_cap' });
  });

  it('allows up to the cap, denies over it', async () => {
    const w = widget({ maxAutoWritesPerSession: 2 });
    expect((await checkAnonAutoWrite(w, 'sess-b', DAY)).allowed).toBe(true);
    expect((await checkAnonAutoWrite(w, 'sess-b', DAY)).allowed).toBe(true);
    expect(await checkAnonAutoWrite(w, 'sess-b', DAY)).toEqual({ allowed: false, reason: 'auto_write_cap' });
    // A different session has its OWN budget.
    expect((await checkAnonAutoWrite(w, 'sess-c', DAY)).allowed).toBe(true);
  });
});

describe('ADR 0469 Phase D — cross-field validation (control requires its bound)', () => {
  beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

  it('rejects rate-limit-session-cap without maxAutoWritesPerSession', async () => {
    await expect(provisionWidget('t', 'o', 'u', {
      agentId: 'a', allowedDomains: ['x.com'],
      anonToolGrant: { write: [DELIVERABLE], writeControl: 'rate-limit-session-cap' },
    })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('accepts it WITH the per-session bound; a later patch that removes the bound is rejected', async () => {
    const w = await provisionWidget('t', 'o', 'u', {
      agentId: 'a', allowedDomains: ['x.com'], caps: { maxAutoWritesPerSession: 3 },
      anonToolGrant: { write: [DELIVERABLE], writeControl: 'rate-limit-session-cap' },
    });
    expect(w.anonToolGrant?.writeControl).toBe('rate-limit-session-cap');
    expect(w.caps.maxAutoWritesPerSession).toBe(3);
    await expect(patchWidget('t', 'o', w.widgetId, { caps: {} })).rejects.toMatchObject({ code: 'validation_error' });
  });
});
