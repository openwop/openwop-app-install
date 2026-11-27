/**
 * ADR 1099 P3b — a collaborator's proposal on the review card.
 *
 * The member who decides must see who sent it (the firm's own name for them), that
 * it came from outside the workspace, the group it belongs to, and who may decide.
 *
 * Sabotage notes: dropping the `collab` branch from `requestedBy` reds the first case;
 * dropping `deciderLabel` from the projection reds "names who may decide".
 */
import { describe, expect, it } from 'vitest';
import { approvalToReview } from '../src/host/reviewProjection.js';
import { registerClientProjectTool } from '../src/host/clientProjectTools.js';
import type { PendingApproval } from '../src/host/approvalService.js';

const LEAD = 'openwop:client.project.p3b-lead';
const ANYONE = 'openwop:client.project.p3b-anyone';
const base = { kind: 'project', featureId: 'test-adopter', effect: 'propose' as const, action: 'view' as const, description: 'x', inputSchema: { type: 'object', properties: {} }, run: async () => ({ proposals: [] }), apply: async () => {} };
registerClientProjectTool({ ...base, id: LEAD, mayDecide: async () => true, deciderLabel: "the project's lead designer" });
registerClientProjectTool({ ...base, id: ANYONE });

const row = (toolId: string, extra: Partial<NonNullable<PendingApproval['collabProposal']>> = {}): PendingApproval => ({
  approvalId: 'appr:collab:cgr_1:abc', tenantId: 'ws:t', rosterId: '', persona: '', workflowId: '',
  proposal: 'countertop: quartz', kind: 'collab-proposal', orgId: 'org_1', status: 'pending', createdAt: '2026-11-25T00:00:00.000Z',
  collabProposal: {
    grantId: 'cgr_1', collaboratorId: 'ccb_1', resource: { kind: 'project', id: 'p1' }, toolId,
    groupKey: 'intake-1', idempotencyKey: 'intake-1:countertop', summary: 'countertop: quartz', payload: { field: 'countertop' }, runId: 'run_1',
    ...extra,
  },
} as PendingApproval);

describe('ADR 1099 P3b — a collaborator proposal on the review card', () => {
  it('names the sender by the firm\'s label and chips it as outside input', () => {
    const r = approvalToReview(row(LEAD, { collaboratorLabel: 'The Garcias' }));
    expect(r.requestedBy).toEqual({ kind: 'user', id: 'collab:ccb_1', label: 'The Garcias' });
    expect(r.risk?.level).toBe('medium');
    expect(r.risk?.reasons).toContain('Proposed by someone outside your workspace');
    expect(r.summary).toBe('countertop: quartz');
    expect(r.actions.map((a) => a.action)).toEqual(['approve', 'reject']);
  });

  it('names who may decide, and the group, when the tool does', () => {
    const r = approvalToReview(row(LEAD));
    expect(r.collabProposal).toEqual({ groupKey: 'intake-1', resourceKind: 'project', resourceId: 'p1', toolId: LEAD, deciderLabel: "the project's lead designer" });
    expect(r.risk?.reasons).toContain("Only the project's lead designer can decide");
  });

  it('a tool with no decider rule shows no decider; an unlabelled sender reads "Outside collaborator"', () => {
    const r = approvalToReview(row(ANYONE));
    expect(r.collabProposal).toEqual({ groupKey: 'intake-1', resourceKind: 'project', resourceId: 'p1', toolId: ANYONE });
    expect(r.requestedBy?.label).toBe('Outside collaborator');
    expect(r.risk?.reasons.some((x) => x.startsWith('Only '))).toBe(false);
  });

  it('carries no payload on the card (the member reads the summary; apply gets the payload)', () => {
    expect(JSON.stringify(approvalToReview(row(LEAD)))).not.toContain('"payload"');
  });
});
