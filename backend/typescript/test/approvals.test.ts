/**
 * Approval inbox — the "agents propose, humans dispose" gate (host extension).
 *
 * Covers:
 *   - a review-mode member's heartbeat QUEUES a proposal instead of running it
 *   - the proposal appears in GET /host/openwop-app/approvals?status=pending
 *   - a re-check does NOT duplicate the proposal for the same card (it proposes
 *     the next eligible card)
 *   - CLAIM starts the proposed run + flips the approval to approved+runId
 *   - REJECT dismisses the proposal + parks the card in the terminal column
 *   - resolving an already-resolved approval is a 409 (idempotency guard)
 *   - an AUTO-mode member is unchanged (regression): the heartbeat runs directly
 *
 * TST-BZB-13 (grade-tests w66). Red when: review-mode stops queuing; guided stops
 * proposing HIGH picks; the per-card pending-approval dedup is dropped; reject stops
 * parking the card; the escalation deep link loses `?approval=`; the approved run loses
 * its `metadata.approval` attribution block (the activity `source` is that metadata KEY —
 * the block's own `source` field is an unread echo); the claim CAS stops refusing a
 * second claimer (FORCED: both claims are held on their first read of the approval row
 * until both have arrived, so both pass the pending check and only the CAS decides).
 * The sequential re-claim 409 is a DOUBLE GUARD (loadPending's status check, then the CAS).
 * Every case seeds its own proposal from its own agent: nothing reads `queue[0]` or a
 * mode another case set, so the file is order-independent.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { __setMockArchiveGuardForTest } from '../src/host/heartbeatService.js';
import { getNotificationEmitter } from '../src/notifications/emitter.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  // ADR 0963 D8 — the seeded twins are all mock archive; this file tests the
  // loop's mechanics over them, so the archive guard is off here (and pinned elsewhere).
  __setMockArchiveGuardForTest(false);
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  __setMockArchiveGuardForTest(true);
  await new Promise<void>((res) => server.close(() => res()));
});

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: (text.length ? JSON.parse(text) : null) as T };
}

interface RosterEntry { rosterId: string; persona: string; autonomyLevel?: 'auto' | 'guided' | 'review' }
interface Approval {
  approvalId: string; rosterId: string; persona: string; workflowId: string;
  cardId?: string; status: 'pending' | 'approved' | 'rejected'; runId?: string;
}
type CheckResult = { picked: boolean; proposed?: boolean; approvalId?: string; cardId?: string; runId?: string };

async function roster(): Promise<RosterEntry[]> {
  return (await api<{ roster: RosterEntry[] }>('/host/openwop-app/roster')).body.roster;
}
async function pending(): Promise<Approval[]> {
  return (await api<{ items: Approval[] }>('/host/openwop-app/approvals?status=pending')).body.items;
}

describe('approval inbox — agents propose, humans dispose', () => {
  beforeAll(async () => {
    await api('/host/openwop-app/example-data/seed', { method: 'POST', body: '{}' });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function member(persona: string): Promise<RosterEntry> {
    const m = (await roster()).find((r) => r.persona === persona);
    expect(m, `seeded roster has ${persona}`).toBeTruthy();
    return m!;
  }
  /** Put `persona` in review mode and have its heartbeat queue ONE proposal. */
  async function propose(persona: string): Promise<{ entry: RosterEntry; checked: CheckResult }> {
    const entry = await member(persona);
    const patched = await api<RosterEntry>(`/host/openwop-app/roster/${entry.rosterId}`, {
      method: 'PATCH', body: JSON.stringify({ autonomyLevel: 'review' }),
    });
    expect(patched.status).toBe(200);
    const checked = await api<CheckResult>(`/host/openwop-app/roster/${entry.rosterId}/check`, { method: 'POST', body: '{}' });
    expect(checked.status).toBe(200);
    expect(checked.body.proposed, `${persona} queued a proposal`).toBe(true);
    expect(typeof checked.body.approvalId).toBe('string');
    return { entry, checked: checked.body };
  }

  it('guided-mode: a HIGH-priority pick proposes; a routine pick runs (architect memo 2026-06-05)', async () => {
    // Pax (People Ops) ships guided with NO requiredConnections (its autonomous
    // within-policy work is internal), so the T3.3 readiness gate does not hold
    // it at review. Its first To Do card is high priority — the heartbeat must
    // QUEUE A PROPOSAL, not start the run.
    const pax = await member('Pax');
    expect(pax.autonomyLevel).toBe('guided');

    const first = await api<CheckResult>(`/host/openwop-app/roster/${pax.rosterId}/check`, { method: 'POST', body: '{}' });
    expect(first.status).toBe(200);
    expect(first.body.picked).toBe(true);
    expect(first.body.proposed).toBe(true);
    expect(typeof first.body.approvalId).toBe('string');
    expect(first.body.runId).toBeUndefined();

    // The NEXT pick is the routine (non-high) card — guided runs it
    // immediately, exactly like auto. (The high card stays parked in To Do
    // behind its pending approval; the dedup guard skips it.)
    const second = await api<CheckResult>(`/host/openwop-app/roster/${pax.rosterId}/check`, { method: 'POST', body: '{}' });
    expect(second.status).toBe(200);
    expect(second.body.picked).toBe(true);
    expect(second.body.proposed).toBeUndefined();
    expect(typeof second.body.runId).toBe('string');

    // PATCH round-trips guided too (the update path had a review-only
    // normalizer that silently dropped it). Ren ships guided; it is round-tripped
    // to review and back so no other case sees a changed mode.
    const ren = await member('Ren');
    const toReview = await api<RosterEntry>(`/host/openwop-app/roster/${ren.rosterId}`, {
      method: 'PATCH', body: JSON.stringify({ autonomyLevel: 'review' }),
    });
    expect(toReview.body.autonomyLevel).toBe('review');
    const patched = await api<RosterEntry>(`/host/openwop-app/roster/${ren.rosterId}`, {
      method: 'PATCH', body: JSON.stringify({ autonomyLevel: 'guided' }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.autonomyLevel).toBe('guided');
    const auto = await api<RosterEntry>(`/host/openwop-app/roster/${ren.rosterId}`, {
      method: 'PATCH', body: JSON.stringify({ autonomyLevel: 'auto' }),
    });
    expect(auto.body.autonomyLevel).toBeUndefined(); // 'auto' is the default → stored as unset
    await api(`/host/openwop-app/roster/${ren.rosterId}`, { method: 'PATCH', body: JSON.stringify({ autonomyLevel: 'guided' }) });
  });

  it('auto-mode member runs directly on heartbeat — regression', async () => {
    // ADR 0032's canonical twins are draft/recommend/execute-with-approval — none
    // default to `auto`. Set a connection-free twin (Felix — no requiredConnections)
    // to auto and confirm the heartbeat runs its pick directly (proposes nothing).
    // (A twin WITH unmet requiredConnections would be held at review by the T3.3
    // readiness gate even when set to auto.)
    const felix = await member('Felix');
    const set = await api<RosterEntry>(`/host/openwop-app/roster/${felix.rosterId}`, {
      method: 'PATCH', body: JSON.stringify({ autonomyLevel: 'auto' }),
    });
    expect(set.status).toBe(200);
    expect(set.body.autonomyLevel).toBeUndefined(); // 'auto' is the default → stored as unset
    const checked = await api<CheckResult>(`/host/openwop-app/roster/${felix.rosterId}/check`, { method: 'POST', body: '{}' });
    expect(checked.status).toBe(200);
    expect(checked.body.picked).toBe(true);
    expect(checked.body.proposed).toBeUndefined();
    expect(typeof checked.body.runId).toBe('string');
  });

  it('review-mode heartbeat queues a proposal instead of running', async () => {
    const { entry, checked } = await propose('Mira');
    expect(checked.picked).toBe(true);
    expect(checked.runId).toBeUndefined(); // nothing ran

    const mine = (await pending()).find((a) => a.approvalId === checked.approvalId);
    expect(mine, 'the proposal is in the pending queue').toBeTruthy();
    expect(mine!.status).toBe('pending');
    expect(mine!.rosterId).toBe(entry.rosterId);
  });

  it('queues escalation notifications to the agent contacts when a proposal is created (ADR 0101 Phase 2)', async () => {
    const captured: Array<{ recipientUserId: string; actionUrl?: string; metadata?: Record<string, unknown> }> = [];
    const unsub = getNotificationEmitter().subscribe((n) => {
      if (n.type === 'agent.escalation') {
        captured.push({ recipientUserId: n.recipientUserId ?? '', actionUrl: n.actionUrl, metadata: n.metadata as Record<string, unknown> | undefined });
      }
    });
    try {
      // Cleo — review-mode, escalation contact 'cs-manager'.
      const { entry: cleo, checked } = await propose('Cleo');
      // 'cs-manager' has no bound User, so it canonicalizes to itself and is notified.
      const esc = captured.find((r) => r.recipientUserId === 'cs-manager');
      expect(esc).toBeTruthy();
      // Deep-links to the specific pending approval on /inbox (ADR 0336 Rec Phase 3).
      const approvalId = checked.approvalId;
      expect(esc?.actionUrl).toBe(`/inbox?approval=${encodeURIComponent(String(approvalId))}`);
      expect(esc?.metadata?.rosterId).toBe(cleo.rosterId);
      expect(esc?.metadata?.approvalId).toBe(approvalId);
    } finally {
      unsub();
    }
  });

  it('a re-check proposes the NEXT card, never a duplicate for the same card', async () => {
    const first = await propose('Ezra');
    const ezra = first.entry;
    const again = await api<CheckResult>(`/host/openwop-app/roster/${ezra.rosterId}/check`, { method: 'POST', body: '{}' });
    expect(again.body.proposed).toBe(true);
    expect(again.body.approvalId).not.toBe(first.checked.approvalId);
    expect(again.body.cardId, 'the re-check picked the card that already has a pending proposal').not.toBe(first.checked.cardId);
    // And no card has two pending approvals.
    const cardIds = (await pending()).filter((a) => a.rosterId === ezra.rosterId).map((a) => a.cardId);
    expect(cardIds).toHaveLength(2);
    expect(new Set(cardIds).size).toBe(cardIds.length);
  });

  it('CLAIM starts the proposed run and flips the approval to approved', async () => {
    const { checked } = await propose('Ava');
    const id = checked.approvalId!;
    const claimed = await api<{ status: string; runId: string }>(
      `/host/openwop-app/approvals/${encodeURIComponent(id)}/claim`,
      { method: 'POST', body: JSON.stringify({ note: 'looks right' }) },
    );
    expect(claimed.status).toBe(200);
    expect(claimed.body.status).toBe('approved');
    expect(typeof claimed.body.runId).toBe('string');

    expect((await pending()).some((a) => a.approvalId === id)).toBe(false);
    const approved = (await api<{ items: Approval[] }>('/host/openwop-app/approvals?status=approved')).body.items;
    const found = approved.find((a) => a.approvalId === id);
    expect(found?.runId).toBe(claimed.body.runId);

    // Re-claiming a resolved approval is a conflict (idempotency guard). DOUBLE GUARD:
    // loadPending's status check answers first; the CAS is witnessed by the forced race below.
    const again = await api<{ error?: string }>(`/host/openwop-app/approvals/${encodeURIComponent(id)}/claim`, { method: 'POST', body: '{}' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('conflict');
  });

  it('REJECT dismisses the proposal and parks the card in the terminal column', async () => {
    const { checked } = await propose('Iris');
    const id = checked.approvalId!;
    const row = (await api<{ items: Array<Approval & { boardId?: string }> }>('/host/openwop-app/approvals?status=pending'))
      .body.items.find((a) => a.approvalId === id);
    expect(row?.boardId, 'the proposal names its board').toBeTruthy();
    expect(row?.cardId).toBe(checked.cardId);

    const rejected = await api<{ status: string }>(
      `/host/openwop-app/approvals/${encodeURIComponent(id)}/reject`,
      { method: 'POST', body: JSON.stringify({ note: 'not now' }) },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');
    expect((await pending()).some((a) => a.approvalId === id)).toBe(false);

    // The card moved to the board's terminal (rightmost) column.
    const board = await api<{ board: { columns: Array<{ id: string }> }; cards: Array<{ id: string; columnId: string }> }>(
      `/host/openwop-app/kanban/boards/${row!.boardId}`,
    );
    const cols = board.body.board.columns;
    expect(cols.length).toBeGreaterThan(1);
    const terminalId = cols[cols.length - 1]!.id;
    const card = board.body.cards.find((c) => c.id === checked.cardId);
    expect(card?.columnId).toBe(terminalId);
  });

  it('a claimed run is attributed to the agent in its activity as an approved proposal', async () => {
    const { entry: ava, checked } = await propose('Ava');
    const claimed = await api<{ runId: string }>(
      `/host/openwop-app/approvals/${encodeURIComponent(checked.approvalId!)}/claim`, { method: 'POST', body: '{}' },
    );
    expect(claimed.status).toBe(200);
    const activity = await api<{ items: Array<{ runId: string; source: string }> }>(
      `/host/openwop-app/roster/${ava.rosterId}/activity`,
    );
    const item = activity.body.items.find((i) => i.runId === claimed.body.runId);
    expect(item).toBeTruthy();
    expect(item!.source).toBe('approval'); // not 'heartbeat'
  });

  it('concurrent claims for one proposal start exactly one run (resolve-before-dispatch lock)', async () => {
    const { checked } = await propose('Ava');
    const approvalId = checked.approvalId!;
    const id = encodeURIComponent(approvalId);

    // FORCE the race: hold each claim on its FIRST read of this approval row until
    // BOTH claims have arrived, so both pass the pending check and only the
    // resolve-before-dispatch CAS can decide. Without the hold the two requests
    // serialize and the second is refused by the pending check instead.
    const realGet = DurableCollection.prototype.get;
    let arrivals = 0;
    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>((r) => { releaseBoth = r; });
    vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollection<unknown>, key: string) {
      if (key === approvalId && arrivals < 2) {
        arrivals += 1;
        if (arrivals === 2) releaseBoth();
        await Promise.race([bothArrived, new Promise((r) => setTimeout(r, 2_000))]);
      }
      return realGet.call(this, key);
    });
    const [a, b] = await Promise.all([
      api<{ runId?: string; error?: string }>(`/host/openwop-app/approvals/${id}/claim`, { method: 'POST', body: '{}' }),
      api<{ runId?: string; error?: string }>(`/host/openwop-app/approvals/${id}/claim`, { method: 'POST', body: '{}' }),
    ]);
    vi.restoreAllMocks();
    expect(arrivals, 'both claims were inside the window — otherwise this is a sequential test').toBe(2);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 409);
    expect(oks.length).toBe(1);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.body.error).toBe('conflict');
    expect(typeof oks[0]!.body.runId).toBe('string');
  });
});
