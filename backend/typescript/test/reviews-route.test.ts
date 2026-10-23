/**
 * Unified review projection (ADR 0068) — route-level coverage.
 *
 * Proves the /reviews inbox composes runtime interrupts + pending approvals into
 * one normalized shape, dispatches a decision to the SOURCE owner's resolve path,
 * is stale-safe (409 on re-decide), derives the action list from the source
 * (422 for an un-offered action), and never leaks existence (404, not 403).
 *
 * Round 2 (8fw1g4): the cross-tenant 404 now uses a REAL review owned by a second
 * tenant (a scoped env key, `k-reviews-other:t-reviews-other`) with an owner positive
 * control — a nonexistent id never reaches `getReview`'s tenant fence (round-1 probe
 * rv-tenant404 was vacuous). Re-decide asserts the route's OWN 409 by message: the
 * downstream resolve path also answers `409 interrupt_already_resolved`, so a code-only
 * check stayed green with the route's guard removed (probe rv-409 was vacuous).
 *
 * Sabotages that red this file: the 422 action derivation, the route's resolvedAt 409,
 * getReview's tenant fence, and the review.updated frame's runId.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createApproval, __resetApprovalStore } from '../src/host/approvalService.js';
import { getNotificationEmitter } from '../src/notifications/emitter.js';
import type { NotificationRecord } from '../src/types.js';
import { bareRunId } from './support/bareRunId.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
/** A key scoped to a SECOND tenant — the owner of the cross-tenant review. */
const OTHER_TOKEN = 'k-reviews-other';
let prevKeys: string | undefined;

beforeAll(async () => {
  prevKeys = process.env.OPENWOP_API_KEYS;
  process.env.OPENWOP_API_KEYS = `dev-token:*,${OTHER_TOKEN}:t-reviews-other`;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  if (prevKeys === undefined) delete process.env.OPENWOP_API_KEYS;
  else process.env.OPENWOP_API_KEYS = prevKeys;
  await __resetApprovalStore();
  await new Promise<void>((res) => server.close(() => res()));
});

async function api<T = unknown>(path: string, init: RequestInit = {}, token: string = TOKEN): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface ErrorBody { error?: string; message?: string }
interface Review { reviewId: string; source: string; kind: string; status: string; tenantId: string; actions: Array<{ action: string }>; summary?: string; interruptId?: string; approvalId?: string }

/** A run-settle poll on the real condition (the run status); no hook exists to await. */
async function pollWaiting(runId: string, token: string = TOKEN): Promise<string> {
  return vi.waitFor(async () => {
    const s = (await api<{ status: string }>(`/runs/${runId}`, {}, token)).body.status;
    if (!(s.startsWith('waiting') || ['completed', 'failed', 'cancelled'].includes(s))) throw new Error(`run ${runId} still ${s}`);
    return s;
  }, { timeout: 5000, interval: 20 });
}

/** Stand up a suspended approval-gate run; returns its id + the deciding tenant. */
async function suspendGate(workflowId: string, token: string = TOKEN): Promise<{ runId: string; tenantId: string; interruptId: string }> {
  await api('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Approve the draft' } }], edges: [] }) }, token);
  // No body.tenantId — the run inherits the caller's tenant, so the inbox (which
  // filters by req.tenantId) sees it without guessing the dev principal's tenant.
  const runId = (await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: { artifact: 'draft v1' } }) }, token)).body.runId;
  expect((await pollWaiting(runId, token)).startsWith('waiting')).toBe(true);
  const ints = (await api<{ interrupts: Array<{ interruptId: string; nodeId: string }> }>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`, {}, token)).body;
  const interruptId = ints.interrupts.find((i) => i.nodeId === 'gate')?.interruptId;
  if (!interruptId) throw new Error(`fixture: run ${runId} has no open gate interrupt`);
  // Read the tenant the PROJECTION uses (the caller's tenant), so a seeded
  // approval lands in the same scope the inbox lists.
  const tenantId = (await api<Review>(`/host/openwop-app/reviews/interrupt:${interruptId}`, {}, token)).body.tenantId;
  return { runId, tenantId, interruptId };
}

describe('GET /reviews — unified projection', () => {
  it('lists a runtime interrupt and a pending approval in one normalized shape', async () => {
    const { interruptId, tenantId } = await suspendGate('reviews.test.list');
    await createApproval({ tenantId, rosterId: 'roster:x', persona: 'Scout', workflowId: 'wf.x', proposal: 'Run intake on the Garcia card' });

    const list = (await api<{ items: Review[] }>('/host/openwop-app/reviews?status=pending')).body.items;
    const interruptReview = list.find((r) => r.reviewId === `interrupt:${interruptId}`);
    const approvalReview = list.find((r) => r.source === 'approval');

    expect(interruptReview).toBeTruthy();
    expect(interruptReview!.source).toBe('interrupt');
    expect(interruptReview!.kind).toBe('approval');
    expect(interruptReview!.actions.map((a) => a.action).sort()).toEqual(['approve', 'reject']);
    expect(interruptReview!.summary).toContain('Approve the draft');

    expect(approvalReview).toBeTruthy();
    expect(approvalReview!.actions.map((a) => a.action).sort()).toEqual(['approve', 'reject']);
    expect(approvalReview!.summary).toContain('Garcia');
  });

  it('GET one review by id returns it; an unknown id 404s (no existence leak)', async () => {
    const { interruptId } = await suspendGate('reviews.test.get');
    const ok = await api<Review>(`/host/openwop-app/reviews/interrupt:${interruptId}`);
    expect(ok.status).toBe(200);
    expect(ok.body.reviewId).toBe(`interrupt:${interruptId}`);

    expect((await api(`/host/openwop-app/reviews/interrupt:does-not-exist`)).status).toBe(404);
    expect((await api(`/host/openwop-app/reviews/approval:does-not-exist`)).status).toBe(404);
    expect((await api(`/host/openwop-app/reviews/garbage-no-prefix`)).status).toBe(404);

    // A REAL review in ANOTHER tenant: the owner reads it (positive control), this
    // caller gets the same 404 as a nonexistent id — never 200, never 403.
    const foreign = await suspendGate('reviews.test.get-foreign', OTHER_TOKEN);
    expect(foreign.tenantId, 'fixture: the foreign gate must live in the second tenant').toBe('t-reviews-other');
    const owner = await api<Review>(`/host/openwop-app/reviews/interrupt:${foreign.interruptId}`, {}, OTHER_TOKEN);
    expect(owner.status).toBe(200);
    const stranger = await api<ErrorBody>(`/host/openwop-app/reviews/interrupt:${foreign.interruptId}`);
    expect(stranger.status).toBe(404);
    const strangerDecide = await api<ErrorBody>(`/host/openwop-app/reviews/interrupt:${foreign.interruptId}/actions/approve`, { method: 'POST', body: JSON.stringify({}) });
    expect(strangerDecide.status).toBe(404);
    expect(strangerDecide.body.error).toBe('not_found');
  });
});

describe('POST /reviews/:id/actions/:action — dispatch to the source owner', () => {
  it('resolves an interrupt review via the unified surface; re-decide is stale-safe (409)', async () => {
    const { runId, interruptId } = await suspendGate('reviews.test.resolve');

    const decide = await api<{ status: string }>(`/host/openwop-app/reviews/interrupt:${interruptId}/actions/approve`, { method: 'POST', body: JSON.stringify({}) });
    expect(decide.status).toBe(200);
    expect(decide.body.status).toBe('resolved');

    // The run left the waiting state, and the interrupt dropped out of the inbox.
    const after = await pollWaiting(runId);
    expect(after.startsWith('waiting')).toBe(false);
    const list = (await api<{ items: Review[] }>('/host/openwop-app/reviews?status=pending')).body.items;
    expect(list.some((r) => r.reviewId === `interrupt:${interruptId}`)).toBe(false);

    // A second decision on the now-resolved review fails closed.
    const again = await api<ErrorBody>(`/host/openwop-app/reviews/interrupt:${interruptId}/actions/approve`, { method: 'POST', body: JSON.stringify({}) });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('interrupt_already_resolved');
    // The ROUTE's own guard (the downstream resolve path answers the same code
    // with a different message).
    expect(again.body.message).toBe('Review already resolved.');
  });

  it('rejects an action the source does not offer (422, action list derived from source)', async () => {
    const { interruptId } = await suspendGate('reviews.test.badaction');
    const r = await api<ErrorBody & { details?: { available?: string[] } }>(`/host/openwop-app/reviews/interrupt:${interruptId}/actions/escalate`, { method: 'POST', body: JSON.stringify({}) });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('validation_error');
    expect(r.body.details?.available?.sort()).toEqual(['approve', 'reject']);
  });
});

// ADR 0074 — the decision owner broadcasts a `review.updated` cache hint to the
// SSE subscriber set (the same fanout the notifications stream serves), so every
// live surface reconciles. Asserted at the emitter boundary: subscribe, decide,
// observe the frame.
describe('POST /reviews/:id/actions — broadcasts review.updated (ADR 0074)', () => {
  it('emits a review.updated signal frame on interrupt resolve carrying reviewId + runId/nodeId', async () => {
    const { runId, interruptId } = await suspendGate('reviews.test.signal');
    const frames: NotificationRecord[] = [];
    const unsubscribe = getNotificationEmitter().subscribe((n) => {
      if (n.type === 'review.updated') frames.push(n);
    });

    const decide = await api<{ status: string }>(`/host/openwop-app/reviews/interrupt:${interruptId}/actions/approve`, { method: 'POST', body: JSON.stringify({}) });
    expect(decide.body.status).toBe('resolved');
    unsubscribe();

    const frame = frames.find((f) => (f.metadata as { reviewId?: string }).reviewId === `interrupt:${interruptId}`);
    expect(frame).toBeTruthy();
    expect((frame!.metadata as { status?: string }).status).toBe('resolved');
    // Carries the run-scoped secondary index so chat/Runs cards (which hold
    // runId+nodeId, not reviewId) can match the frame.
    expect(frame!.runId).toBe(bareRunId(runId));
    expect(frame!.nodeId).toBe('gate');
    // Broadcast (no recipient) so it reaches every tenant member's stream.
    expect(frame!.recipientUserId).toBeUndefined();
  });
});
