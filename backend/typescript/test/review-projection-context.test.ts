/**
 * interruptToReview enrichment (HITL approval context) — verifies the review
 * projection surfaces human-meaningful context instead of opaque ids:
 *   - the initiating workflow's name (metadata.workflowName, else workflowId)
 *   - a real requester (the initiating human, else the NAMED workflow — never
 *     the bare literal "workflow")
 *   - the concrete asset(s) under review (bundled `options[]` + artifact binding)
 *   - the conversation the run belongs to (ADR 0776)
 *
 * Round 2 (8fw1g4): the run fixture carried `status: 'waiting-interrupt'`, which is
 * not a RunStatus — an `as RunRecord` cast hid it. The fixture is now typed with no
 * cast and uses `waiting-approval` (the status an approval gate parks a run in).
 *
 * Sabotages that red this file (8fw1g4 round 1, 8 probes, all witnessed): dropping
 * the metadata workflow name, the workflowId fallback label, the initiating-user
 * requester, the bundled `options[]`, the artifact binding, and each ADR 0776
 * conversation leg (run id, data, absent).
 */

import { describe, it, expect } from 'vitest';
import { interruptToReview } from '../src/host/reviewProjection.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1', workflowId: 'wf_1d219721', tenantId: 't1', status: 'waiting-approval',
    inputs: {}, metadata: {}, configurable: {}, createdAt: '2026-06-19T00:00:00Z', updatedAt: '2026-06-19T00:00:00Z',
    ...over,
  };
}
function interrupt(data: unknown, over: Partial<InterruptRecord> = {}): InterruptRecord {
  return {
    interruptId: 'i1', runId: 'run-1', nodeId: 'approval_6', kind: 'approval',
    token: 'tok', data, createdAt: '2026-06-19T00:00:00Z', ...over,
  };
}

describe('interruptToReview — approval context enrichment', () => {
  it('surfaces the workflow human name from metadata', () => {
    const r = interruptToReview(interrupt({ prompt: 'Legal: approve the drafted content' }), run({ metadata: { workflowName: 'Multi-channel content review' } }));
    expect(r.workflowName).toBe('Multi-channel content review');
    expect(r.workflowId).toBe('wf_1d219721');
  });

  it('falls back to the workflowId when no metadata name (still not the opaque run id)', () => {
    const r = interruptToReview(interrupt({ prompt: 'Approve' }), run());
    expect(r.workflowName).toBe('wf_1d219721');
  });

  it('never attributes to the bare literal "workflow" — uses the workflow name', () => {
    const r = interruptToReview(interrupt({ prompt: 'Approve' }), run({ metadata: { workflowName: 'Legal Review' } }));
    expect(r.requestedBy).toEqual({ kind: 'system', id: 'run-1', label: 'Legal Review' });
  });

  it('attributes to the initiating human when actingUserId is present', () => {
    const r = interruptToReview(interrupt({ prompt: 'Approve' }), run({ metadata: { actingUserId: 'user:abc' } }));
    expect(r.requestedBy).toEqual({ kind: 'user', id: 'user:abc' });
  });

  it('exposes the bundled option content as the assets under review', () => {
    const r = interruptToReview(interrupt({
      prompt: 'Approve the drafted email',
      options: [{ key: 'draft', label: 'Drafted email', content: 'To: team@acme.com\nSubject: Hi\n\nBody.' }],
    }), run());
    expect(r.assets).toEqual([{ label: 'Drafted email', content: 'To: team@acme.com\nSubject: Hi\n\nBody.' }]);
    expect(r.summary).toBe('Approve the drafted email');
  });

  it('includes a pinned artifact binding as an asset', () => {
    const r = interruptToReview(interrupt({ prompt: 'Approve', artifactId: 'document:doc-1', revisionId: 'rev-2' }), run());
    expect(r.assets).toContainEqual({ artifactId: 'document:doc-1', revisionId: 'rev-2' });
    expect(r.artifactId).toBe('document:doc-1');
  });
});

describe('interruptToReview — the conversation it belongs to (ADR 0776)', () => {
  it('stamps conversationId from the run\'s chatSessionId (every chat-dispatched run carries it)', () => {
    const r = interruptToReview(interrupt({ prompt: 'Approve' }), run({ metadata: { chatSessionId: 'sess-42' } }));
    expect(r.conversationId).toBe('sess-42');
  });

  it('falls back to the interrupt data\'s explicit conversationId', () => {
    const r = interruptToReview(interrupt({ prompt: 'Approve', conversationId: 'sess-from-node' }), run());
    expect(r.conversationId).toBe('sess-from-node');
  });

  it('is absent (never invented) when neither carries one', () => {
    const r = interruptToReview(interrupt({ prompt: 'Approve' }), run());
    expect('conversationId' in r).toBe(false);
  });
});
