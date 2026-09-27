/**
 * ADR 0469 Phase C — the anon-surface-write approval projects into the shared review
 * inbox (data-driven `ReviewCard`) with a clear label, an opaque-visitor requester,
 * and a risk chip — no new UI. A resolved approval offers no actions (audit row).
 */
import { describe, it, expect } from 'vitest';
import { approvalToReview } from '../src/host/reviewProjection.js';
import type { PendingApproval } from '../src/host/approvalService.js';

function anonApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: 'appr:anon:run-1:0',
    tenantId: 'acme',
    rosterId: '',
    persona: '',
    workflowId: '',
    proposal: 'Anonymous visitor requested: openwop:kanban.add-todo',
    kind: 'anon-surface-write',
    orgId: 'org-1',
    anonSurfaceWrite: { widgetId: 'wgt-1', principal: 'anon:sess-abc', runId: 'run-1', toolCallIdx: 0, tool: { name: 'openwop:kanban.add-todo', args: { title: 'x' } } },
    status: 'pending',
    createdAt: '2026-07-22T00:00:00.000Z',
    ...overrides,
  } as PendingApproval;
}

describe('ADR 0469 Phase C — anon-surface-write review projection', () => {
  it('renders an opaque "Anonymous visitor" requester + a risk chip + the tool summary', () => {
    const r = approvalToReview(anonApproval());
    expect(r.kind).toBe('anon-surface-write');
    expect(r.summary).toBe('Anonymous visitor requested: openwop:kanban.add-todo');
    expect(r.requestedBy).toEqual({ kind: 'system', id: 'anon:sess-abc', label: 'Anonymous visitor' });
    expect(r.requestedBy?.id).not.toMatch(/@|email/i); // opaque principal, never PII (RFC 0048)
    expect(r.risk?.level).toBe('medium');
    expect(r.risk?.reasons).toContain('Anonymous website visitor');
    expect(r.risk?.reasons.some((x) => x.includes('openwop:kanban.add-todo'))).toBe(true);
    expect(r.actions.map((a) => a.action)).toEqual(['approve', 'reject']);
  });

  it('a resolved approval is an audit row — no actions', () => {
    const r = approvalToReview(anonApproval({ status: 'approved' }));
    expect(r.actions).toEqual([]);
    expect(r.status).toBe('approved');
  });
});
