/**
 * ADR 0023 §12 T4 — the single approval loop for assistant actions
 * (ADR 0025 §4 "no new approval store", made literal):
 *
 *   - enqueue creates the typed PendingAction AND its PendingApproval on the
 *     host queue (back-linked), with taint computed from the cited sources;
 *   - the SAME approval is decidable from BOTH surfaces — the approvals inbox
 *     (claim/reject) and the assistant's pending-actions routes — through one
 *     CAS-guarded implementation (exactly one winner; losers 409);
 *   - editing a still-pending draft stamps editedAt; decided actions refuse
 *     edits (re-draft, not edit).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetAssistantStore, getPendingAction } from '../src/features/assistant/assistantService.js';
import { enqueueActionWithApproval } from '../src/features/assistant/actionApproval.js';
import { getApproval, __resetApprovalStore } from '../src/host/approvalService.js';
import { getRosterEntry } from '../src/host/rosterService.js';
import { findChiefOfStaff } from '../src/features/assistant/chiefOfStaff.js';

let BASE: string;
const TOKEN = 'dev-token';
const TENANT = 'default'; // bearer-auth default tenant — routes resolve this

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
  await __resetAssistantStore();
  await __resetApprovalStore();
  await new Promise<void>((res) => {
    server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const on = await jf('/v1/host/openwop-app/feature-toggles/admin/configs/assistant', {
    method: 'PUT',
    body: JSON.stringify({ status: 'on', bucketUnit: 'tenant', salt: 'assistant' }),
  });
  if (on.status !== 200) throw new Error(`toggle enable failed: ${on.status}`);
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function jf<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...((init.headers as Record<string, string>) ?? {}) },
  });
  const raw = res.status === 204 ? undefined : await res.json();
  return { status: res.status, body: raw as T };
}

function draftEmail(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'email.send' as const,
    payload: { to: ['dana@example.com'] },
    draft: 'Hi Dana — following up on the Q3 numbers we discussed.',
    riskLevel: 'medium' as const,
    requiredScopes: ['https://www.googleapis.com/auth/gmail.send'],
    reason: 'Commitment "send Q3 numbers" is overdue by 2 days.',
    sourceRefs: [
      { kind: 'gmail' as const, externalId: 'msg-1', contentHash: 'h1', capturedAt: new Date().toISOString(), contentTrust: 'untrusted' as const },
    ],
    ...overrides,
  };
}

describe('enqueue → the single approval loop', () => {
  it('creates the action + its PendingApproval, back-linked, taint computed from sources', async () => {
    const action = await enqueueActionWithApproval(TENANT, draftEmail());
    expect(action.approvalId).toBeTruthy();
    expect(action.derivedFromUntrusted).toBe(true); // OR over sourceRefs taint

    const approval = await getApproval(action.approvalId!);
    expect(approval).toMatchObject({
      kind: 'assistant-action',
      actionId: action.actionId,
      status: 'pending',
    });
    expect(approval!.proposal).toContain('email.send');
    expect(approval!.proposal).toContain('dana@example.com');

    // ADR 0023 (corrected) — the approval is attributed to the REAL
    // Chief-of-Staff roster member, not the old `rosterId:'assistant'` phantom.
    const cos = await findChiefOfStaff(TENANT);
    expect(cos, 'enqueue ensured a Chief-of-Staff roster member').not.toBeNull();
    expect(approval!.rosterId).toBe(cos!.rosterId);
    expect(approval!.rosterId).not.toBe('assistant');
    expect(approval!.persona).toBe(cos!.persona);
    expect(getRosterEntry(approval!.rosterId)).resolves.not.toBeNull(); // resolves to a real entry

    // The "Waiting on me" surface sees it — same queue as run proposals.
    const inbox = await jf<{ items: Array<{ approvalId: string; actionId?: string }> }>('/v1/host/openwop-app/approvals?status=pending');
    expect(inbox.body.items.some((i) => i.approvalId === action.approvalId)).toBe(true);
  });

  it('the approvals inbox embeds the rich action-card metadata (risk/taint/citations/draft)', async () => {
    // Regression: assistant-action approvals once rendered blank in the inbox
    // (no run, no card metadata) because the list returned only the bare
    // PendingApproval. The feature now projects the typed PendingAction onto
    // each actionId-carrying row so the ActionCard can render.
    // payload carries an extra non-card field — the projector must allowlist it
    // out (only the destination `to` is rendered), so it never reaches the row.
    const action = await enqueueActionWithApproval(TENANT, draftEmail({
      payload: { to: ['dana@example.com'], internalToken: 'must-not-leak' },
    }));
    const inbox = await jf<{
      items: Array<{
        approvalId: string;
        kind?: string;
        action?: {
          actionId: string;
          kind: string;
          draft: string;
          riskLevel?: string;
          derivedFromUntrusted?: boolean;
          reason?: string;
          sourceRefs?: Array<{ kind: string; contentTrust?: string }>;
          payload?: Record<string, unknown>;
        } | null;
      }>;
    }>('/v1/host/openwop-app/approvals?status=pending');
    const row = inbox.body.items.find((i) => i.approvalId === action.approvalId);
    expect(row, 'the enqueued action is in the pending inbox').toBeTruthy();
    expect(row!.kind).toBe('assistant-action');
    expect(row!.action).toMatchObject({
      actionId: action.actionId,
      kind: 'email.send',
      riskLevel: 'medium',
      derivedFromUntrusted: true, // taint surfaces on the card banner
    });
    expect(row!.action!.draft).toContain('Q3 numbers');
    expect(row!.action!.reason).toContain('overdue');
    expect(row!.action!.sourceRefs?.[0]).toMatchObject({ kind: 'gmail', contentTrust: 'untrusted' });
    // destination is projected; the non-allowlisted field is dropped.
    expect((row!.action!.payload as { to?: unknown }).to).toEqual(['dana@example.com']);
    expect(row!.action!.payload).not.toHaveProperty('internalToken');
  });

  it('claim from the approvals inbox approves the action; a second decision 409s (CAS)', async () => {
    const action = await enqueueActionWithApproval(TENANT, draftEmail());
    const claim = await jf<{ status: string; actionId: string }>(`/v1/host/openwop-app/approvals/${action.approvalId}/claim`, {
      method: 'POST',
      body: '{}',
    });
    expect(claim.status).toBe(200);
    expect(claim.body).toMatchObject({ status: 'approved', actionId: action.actionId });

    const row = await getPendingAction(TENANT, action.actionId);
    // T6: the winning claim also dispatches execution — the status is the
    // decision projection (approved) or already the execution outcome
    // (failed here: no Google connection exists, fail-closed). Never pending
    // or rejected.
    expect(['approved', 'sent', 'failed']).toContain(row?.status);
    expect(row?.approvedByUserId).toBeTruthy();

    // Loser path — both surfaces refuse a second decision.
    expect((await jf(`/v1/host/openwop-app/approvals/${action.approvalId}/claim`, { method: 'POST', body: '{}' })).status).toBe(409);
    expect((await jf(`/v1/host/openwop-app/assistant/pending-actions/${action.actionId}/reject`, { method: 'POST', body: '{}' })).status).toBe(409);
  });

  it('rejecting from the assistant route resolves the shared approval row too', async () => {
    const action = await enqueueActionWithApproval(TENANT, draftEmail());
    const rejected = await jf<{ status: string }>(`/v1/host/openwop-app/assistant/pending-actions/${action.actionId}/reject`, {
      method: 'POST',
      body: '{}',
    });
    expect(rejected.status).toBe(200);
    expect((await getPendingAction(TENANT, action.actionId))?.status).toBe('rejected');
    expect((await getApproval(action.approvalId!))?.status).toBe('rejected'); // ONE loop, one state
  });

  it('edit re-faces the approver while pending; decided actions refuse edits', async () => {
    const action = await enqueueActionWithApproval(TENANT, draftEmail());
    const edited = await jf<{ draft: string; editedAt?: string; derivedFromUntrusted?: boolean }>(
      `/v1/host/openwop-app/assistant/pending-actions/${action.actionId}`,
      { method: 'PATCH', body: JSON.stringify({ draft: 'Hi Dana — revised wording.' }) },
    );
    expect(edited.status).toBe(200);
    expect(edited.body.draft).toBe('Hi Dana — revised wording.');
    expect(edited.body.editedAt).toBeTruthy();
    expect(edited.body.derivedFromUntrusted).toBe(true); // taint never launders on edit

    await jf(`/v1/host/openwop-app/assistant/pending-actions/${action.actionId}/approve`, { method: 'POST', body: '{}' });
    const postDecide = await jf(`/v1/host/openwop-app/assistant/pending-actions/${action.actionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ draft: 'too late' }),
    });
    expect(postDecide.status).toBe(409);
  });

  it('an untainted, low-risk action carries no taint flag', async () => {
    const action = await enqueueActionWithApproval(TENANT, draftEmail({
      riskLevel: 'low',
      sourceRefs: [{ kind: 'manual', externalId: 'note-1', contentHash: 'h2', capturedAt: new Date().toISOString() }],
    }));
    expect(action.derivedFromUntrusted).toBeUndefined();
  });
});
