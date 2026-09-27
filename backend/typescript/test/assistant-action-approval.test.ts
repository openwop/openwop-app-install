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
import { contentHashOf } from '../src/features/assistant/actionApproval.js';
import { enqueueActionWithApproval } from '../src/features/assistant/actionApproval.js';
import { getApproval, __resetApprovalStore } from '../src/host/approvalService.js';
import { getRosterEntry } from '../src/host/rosterService.js';
import { findAssistantAgent } from '../src/features/assistant/capability.js';

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
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
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
    const cos = await findAssistantAgent(TENANT);
    expect(cos, 'enqueue ensured a Chief-of-Staff roster member').not.toBeNull();
    expect(approval!.rosterId).toBe(cos!.rosterId);
    expect(approval!.rosterId).not.toBe('assistant');
    expect(approval!.persona).toBe(cos!.persona);
    expect(getRosterEntry(approval!.tenantId, approval!.rosterId)).resolves.not.toBeNull(); // resolves to a real entry

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

  /**
   * ADR 0662 D2 — approve-what-you-see. Born red: before this decision the approve route
   * took no hash at all, so an action edited after the approver read it executed with the
   * new content and no indication.
   *
   * The second half is the part that matters and is easy to get wrong: ADR 0473 §(d) puts
   * the definitive check AFTER the CAS, so by the time a mismatch is found the approval is
   * consumed and the action row is already marked `approved`. Reopening only ONE side
   * leaves the other lying — an action marked approved that never executed and never
   * reported failure. Both rows must come back to `pending`.
   */
  it('a stale expectedContentHash is refused 409 and BOTH rows return to pending', async () => {
    const action = await enqueueActionWithApproval(TENANT, draftEmail());
    const before = (await getPendingAction(TENANT, action.actionId))!;
    const staleHash = contentHashOf(before);

    // Someone edits the action after the approver read it.
    const edited = await jf(`/v1/host/openwop-app/assistant/pending-actions/${action.actionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ draft: 'Completely different text the approver never saw.' }),
    });
    expect(edited.status).toBe(200);

    const refused = await jf(`/v1/host/openwop-app/assistant/pending-actions/${action.actionId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ expectedContentHash: staleHash }),
    });
    expect(refused.status).toBe(409);

    // Both sides restored — neither may be left resolved.
    const afterAction = await getPendingAction(TENANT, action.actionId);
    expect(afterAction?.status, 'the action row must be back to pending, not left approved').toBe('pending');
    const { getApproval } = await import('../src/host/approvalService.js');
    const afterApproval = await getApproval(action.approvalId!);
    expect(afterApproval?.status, 'the approval must be reopened too').toBe('pending');

    // …and the CURRENT hash is accepted, so this is a refusal to guess, not a dead end.
    const fresh = (await getPendingAction(TENANT, action.actionId))!;
    const ok = await jf(`/v1/host/openwop-app/assistant/pending-actions/${action.actionId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ expectedContentHash: contentHashOf(fresh) }),
    });
    expect(ok.status).toBe(200);
  });

  it('approve without expectedContentHash is refused 400 — an optional guard is an unguarded guard', async () => {
    const action = await enqueueActionWithApproval(TENANT, draftEmail());
    const r = await jf(`/v1/host/openwop-app/assistant/pending-actions/${action.actionId}/approve`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(400);
    expect((await getPendingAction(TENANT, action.actionId))?.status).toBe('pending');
    // A REJECT needs no hash: refusing something that changed is still a refusal.
    const rej = await jf(`/v1/host/openwop-app/assistant/pending-actions/${action.actionId}/reject`, { method: 'POST', body: '{}' });
    expect(rej.status).toBe(200);
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

    // ADR 0662 D2 — the hash is of the EDITED row (the edit above changed the draft), which
    // is the point: approving the pre-edit hash is now refused.
    const { contentHashOf } = await import('../src/features/assistant/actionApproval.js');
    const freshRow = (await getPendingAction(TENANT, action.actionId))!;
    await jf(`/v1/host/openwop-app/assistant/pending-actions/${action.actionId}/approve`, { method: 'POST', body: JSON.stringify({ expectedContentHash: contentHashOf(freshRow) }) });
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
