/**
 * ADR 0862 D1/D2 — approve what you see, on EVERY lane.
 *
 * ADR 0662 made `expectedContentHash` "required on approve" — on
 * `POST /assistant/pending-actions/:id/approve`, a route no client calls. The two
 * lanes that carry every real approval (`/approvals/:id/claim` from both inboxes
 * and the agent drawer, `/reviews/:id/actions/approve` from ReviewCard) passed no
 * hash, and `decideActionViaApproval` skipped the check when none arrived. The
 * 0662 tests stayed green because they drove the unused route.
 *
 * So this file drives the GENERIC lanes over HTTP, and every arm asserts the
 * absence of execution as well as the status code — a 409 that still dispatched
 * would be the defect wearing a refusal.
 *
 * Sabotages that turn it red (grade-tests w11): the hash requirement dropped in
 * `decideActionViaApproval`; the EARLY pre-CAS check dropped (the PEER EDIT case's
 * `decidedBy` assertion — the post-CAS check alone still answers 409 with both rows
 * pending); the claim / reviews lanes not forwarding the hash; the review projecting a
 * wrong `contentHash`; the edit CAS ignoring the hash, its no-hash 400, or its response
 * echoing the OLD hash; the edit's `pending` gate; reopen ignoring `executionRunId`; a
 * quorum policy on the approval; the reject projected as approved.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import {
  __resetAssistantStore,
  getPendingAction,
  reopenPendingAction,
  setPendingActionExecution,
  decidePendingAction,
} from '../src/features/assistant/assistantService.js';
import { contentHashOf, enqueueActionWithApproval } from '../src/features/assistant/actionApproval.js';
import { getApproval, __resetApprovalStore } from '../src/host/approvalService.js';

let BASE: string;
const TOKEN = 'dev-token';
const TENANT = 'default';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
  await __resetAssistantStore();
  await __resetApprovalStore();
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function jf<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...((init.headers as Record<string, string>) ?? {}) },
  });
  const raw = res.status === 204 ? undefined : await res.json();
  return { status: res.status, body: raw as T };
}

const invite = () => ({
  kind: 'calendar.invite' as const,
  payload: {
    to: ['dana@example.com'],
    event: { summary: 'Q3 review', start: { dateTime: '2026-10-09T15:00:00Z' }, end: { dateTime: '2026-10-09T15:30:00Z' }, location: 'Room 4' },
  },
  draft: 'Invite Dana to the Q3 review.',
});

async function hashNow(actionId: string): Promise<string> {
  return contentHashOf((await getPendingAction(TENANT, actionId))!);
}

describe('D1 — the inbox claim lane requires the hash', () => {
  it('a claim with NO hash is refused 400 and consumes nothing', async () => {
    const action = await enqueueActionWithApproval(TENANT, invite());
    const r = await jf(`/host/openwop-app/approvals/${action.approvalId}/claim`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(400);
    expect((await getApproval(action.approvalId!))?.status).toBe('pending');
    const row = await getPendingAction(TENANT, action.actionId);
    expect(row?.status).toBe('pending');
    expect(row?.executionRunId).toBeUndefined();
  });

  it('a PEER EDIT after the approver rendered the card: the old hash is refused 409, nothing executes', async () => {
    const action = await enqueueActionWithApproval(TENANT, invite());
    const seen = await hashNow(action.actionId);
    // A second editor changes the time between the approver's render and their click.
    const edit = await jf(`/host/openwop-app/assistant/pending-actions/${action.actionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        expectedContentHash: seen,
        payload: { ...invite().payload, event: { ...invite().payload.event, start: { dateTime: '2026-10-09T03:00:00Z' } } },
      }),
    });
    expect(edit.status).toBe(200);
    const r = await jf<{ details?: { reason?: string } }>(`/host/openwop-app/approvals/${action.approvalId}/claim`, {
      method: 'POST', body: JSON.stringify({ expectedContentHash: seen }),
    });
    expect(r.status).toBe(409);
    expect(r.body.details?.reason).toBe('action_changed');
    const approval = await getApproval(action.approvalId!);
    expect(approval?.status).toBe('pending');
    // Refused by the EARLY check, before the CAS: never resolved. A consumed-then-reopened
    // approval (the post-CAS path) keeps the `decidedBy` the CAS stamped.
    expect(approval?.decidedBy, 'refused before the CAS — not consumed and reopened').toBeUndefined();
    const row = await getPendingAction(TENANT, action.actionId);
    expect(row?.status).toBe('pending');
    expect(row?.executionRunId).toBeUndefined();
  });

  it('the CURRENT hash is accepted (negative control — not a refusal of everyone)', async () => {
    const action = await enqueueActionWithApproval(TENANT, invite());
    const r = await jf(`/host/openwop-app/approvals/${action.approvalId}/claim`, {
      method: 'POST', body: JSON.stringify({ expectedContentHash: await hashNow(action.actionId) }),
    });
    expect(r.status).toBe(200);
    expect((await getApproval(action.approvalId!))?.status).toBe('approved');
  });

  it('a REJECT needs no hash', async () => {
    const action = await enqueueActionWithApproval(TENANT, invite());
    const r = await jf(`/host/openwop-app/approvals/${action.approvalId}/reject`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(200);
    expect((await getPendingAction(TENANT, action.actionId))?.status).toBe('rejected');
    expect((await getApproval(action.approvalId!))?.status).toBe('rejected');
  });
});

describe('D1 — the reviews lane requires the hash, and projects it', () => {
  it('the review carries the card fields + contentHash; approve without it is 400, with it 200', async () => {
    const action = await enqueueActionWithApproval(TENANT, invite());
    const reviewId = `approval:${action.approvalId}`;
    const got = await jf<{ assistantAction?: { contentHash?: string; payload?: Record<string, unknown> } }>(
      `/host/openwop-app/reviews/${encodeURIComponent(reviewId)}`,
    );
    expect(got.status).toBe(200);
    expect(got.body.assistantAction?.contentHash).toBe(await hashNow(action.actionId));
    expect(got.body.assistantAction?.payload?.event).toBeTruthy();

    const bare = await jf(`/host/openwop-app/reviews/${encodeURIComponent(reviewId)}/actions/approve`, { method: 'POST', body: '{}' });
    expect(bare.status).toBe(400);
    expect((await getApproval(action.approvalId!))?.status).toBe('pending');

    const ok = await jf(`/host/openwop-app/reviews/${encodeURIComponent(reviewId)}/actions/approve`, {
      method: 'POST', body: JSON.stringify({ expectedContentHash: got.body.assistantAction!.contentHash }),
    });
    expect(ok.status).toBe(200);
  });
});

describe('D2 — the edit lane is a CAS on the version the editor read', () => {
  it('an edit with no hash is 400; a stale hash is 409; the response is the card with the NEW hash', async () => {
    const action = await enqueueActionWithApproval(TENANT, invite());
    const none = await jf(`/host/openwop-app/assistant/pending-actions/${action.actionId}`, {
      method: 'PATCH', body: JSON.stringify({ draft: 'x' }),
    });
    expect(none.status).toBe(400);

    const first = await hashNow(action.actionId);
    const ok = await jf<{ contentHash?: string; draft?: string }>(`/host/openwop-app/assistant/pending-actions/${action.actionId}`, {
      method: 'PATCH', body: JSON.stringify({ draft: 'Revised.', expectedContentHash: first }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.draft).toBe('Revised.');
    expect(ok.body.contentHash).toBe(await hashNow(action.actionId));
    expect(ok.body.contentHash).not.toBe(first);

    const stale = await jf(`/host/openwop-app/assistant/pending-actions/${action.actionId}`, {
      method: 'PATCH', body: JSON.stringify({ draft: 'Lost update', expectedContentHash: first }),
    });
    expect(stale.status).toBe(409);
    expect((await getPendingAction(TENANT, action.actionId))?.draft).toBe('Revised.');

    // Edit-then-approve binds to the edited bytes.
    const claim = await jf(`/host/openwop-app/approvals/${action.approvalId}/claim`, {
      method: 'POST', body: JSON.stringify({ expectedContentHash: ok.body.contentHash }),
    });
    expect(claim.status).toBe(200);
  });

  it('an edit that lands after the decision cannot put a decided action back to pending', async () => {
    const action = await enqueueActionWithApproval(TENANT, invite());
    const seen = await hashNow(action.actionId);
    // The decision lands first (the approval CAS's projection)…
    await decidePendingAction(TENANT, action.actionId, { status: 'approved', approvedByUserId: 'u:a' });
    // …then the editor's write, gated on the version they read.
    const late = await jf(`/host/openwop-app/assistant/pending-actions/${action.actionId}`, {
      method: 'PATCH', body: JSON.stringify({ draft: 'too late', expectedContentHash: seen }),
    });
    expect(late.status).toBe(409);
    expect((await getPendingAction(TENANT, action.actionId))?.status).toBe('approved');
  });

  it('reopen refuses an action that already has an execution run', async () => {
    const action = await enqueueActionWithApproval(TENANT, invite());
    await decidePendingAction(TENANT, action.actionId, { status: 'approved' });
    await setPendingActionExecution(TENANT, action.actionId, 'run-xyz');
    expect(await reopenPendingAction(TENANT, action.actionId)).toBeNull();
    const row = await getPendingAction(TENANT, action.actionId);
    expect(row?.status).toBe('approved');
    expect(row?.executionRunId).toBe('run-xyz');
  });

  it('assistant-action approvals carry no quorum policy (the finalize-time check is the only vote)', async () => {
    const action = await enqueueActionWithApproval(TENANT, invite());
    expect((await getApproval(action.approvalId!))?.policy).toBeUndefined();
  });
});
