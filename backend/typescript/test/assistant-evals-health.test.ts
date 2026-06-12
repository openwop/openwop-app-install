/**
 * ADR 0029 / ADR 0023 §12 T8 — evals, health & the approvals index:
 *   - extraction eval: a labeled calendar corpus → precision/recall of the
 *     deterministic ingest leg (RFC 0081 scorecard-shaped result);
 *   - priority-scoring eval: profile fixtures → expected bucket ordering is
 *     stable across the three admin profiles;
 *   - the health snapshot: approval/edit rates, citation coverage, stale
 *     commitments, taint share — computed on existing seams;
 *   - the approvals (tenant,status) index: list + card-dedup correctness
 *     across create → resolve → prune, tenant-isolated.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import {
  __resetAssistantStore,
  listCommitments,
  upsertCommitmentBySource,
} from '../src/features/assistant/assistantService.js';
import { enqueueActionWithApproval, decideActionViaApproval } from '../src/features/assistant/actionApproval.js';
import { buildAssistantHealth } from '../src/features/assistant/health.js';
import { buildAssistantSurface } from '../src/features/assistant/surface.js';
import { prioritize, PRIORITY_PROFILES } from '../src/features/assistant/prioritization.js';
import {
  createApproval,
  listApprovals,
  resolveApproval,
  hasPendingApprovalForCard,
  __resetApprovalStore,
} from '../src/host/approvalService.js';

let nodes: (typeof import('../../../packs/feature.assistant.nodes/index.mjs'))['nodes'];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 19003, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __resetAssistantStore();
  await __resetApprovalStore();
  nodes = (await import('../../../packs/feature.assistant.nodes/index.mjs')).nodes;
});

describe('extraction eval (labeled corpus → precision/recall)', () => {
  it('the deterministic ingest leg scores perfectly on well-formed items and skips malformed ones', async () => {
    const TENANT = 't-eval-extract';
    // Labeled corpus: 3 extractable events, 2 malformed (no id / no summary).
    const corpus = {
      items: [
        { id: 'e1', summary: 'Board meeting', start: { dateTime: '2026-06-15T09:00:00Z' } },
        { id: 'e2', summary: '1:1 with Sam', start: { dateTime: '2026-06-15T13:00:00Z' } },
        { id: 'e3', summary: 'Q3 planning', start: { date: '2026-06-16' } },
        { id: '', summary: 'ghost' },
        { id: 'e5' },
      ],
    };
    const expected = new Set(['Prepare for "Board meeting"', 'Prepare for "1:1 with Sam"', 'Prepare for "Q3 planning"']);

    await nodes['feature.assistant.nodes.ingest-commitments']!({
      inputs: { body: corpus },
      config: { sourceKind: 'calendar' },
      features: { assistant: buildAssistantSurface({ tenantId: TENANT }) },
    });
    const stored = await listCommitments(TENANT);
    const got = new Set(stored.map((c) => c.description));

    // RFC 0081 scorecard shape: per-metric scores in [0,1].
    const truePositives = [...got].filter((d) => expected.has(d)).length;
    const scorecard = {
      metrics: {
        precision: truePositives / got.size,
        recall: truePositives / expected.size,
      },
    };
    expect(scorecard.metrics.precision).toBe(1);
    expect(scorecard.metrics.recall).toBe(1);
  });
});

describe('priority-scoring eval (profile fixtures)', () => {
  it('bucket assignment is stable and ordered across the three admin profiles', () => {
    const urgent = { senderImportance: 0.9, deadlineProximity: 0.95, projectPriority: 0.8, priorEngagement: 0.7 };
    const ambient = { senderImportance: 0.2, deadlineProximity: 0.05, projectPriority: 0.3, priorEngagement: 0.2 };
    const rank = { surface: 2, handle: 1, defer: 0 } as const;
    for (const profile of Object.values(PRIORITY_PROFILES)) {
      const hot = prioritize(urgent, profile);
      const cold = prioritize(ambient, profile);
      expect(hot.score).toBeGreaterThan(cold.score);
      expect(rank[hot.bucket]).toBeGreaterThanOrEqual(rank[cold.bucket]);
    }
    // Profile semantics (prioritization.ts): `conservative` surfaces MORE
    // (low bar — ask the human often); `aggressive` handles/defers more
    // (high bar). A mid-priority item must surface under conservative at
    // least as readily as under aggressive.
    const mid = { senderImportance: 0.55, deadlineProximity: 0.5, projectPriority: 0.5, priorEngagement: 0.5 };
    const aggressive = prioritize(mid, PRIORITY_PROFILES.aggressive);
    const conservative = prioritize(mid, PRIORITY_PROFILES.conservative);
    expect(rank[conservative.bucket]).toBeGreaterThanOrEqual(rank[aggressive.bucket]);
  });
});

describe('health snapshot', () => {
  it('computes approval/edit rates, citation coverage, stale + taint shares on the real stores', async () => {
    const TENANT = 'default';
    await __resetAssistantStore();
    // One overdue cited commitment, one future uncited.
    await upsertCommitmentBySource(TENANT, {
      owner: { kind: 'self' },
      description: 'Overdue cited',
      source: { kind: 'drive', externalId: 'f1', contentHash: 'h1', capturedAt: new Date().toISOString(), url: 'https://drive/f1', contentTrust: 'untrusted' },
      dueAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    await upsertCommitmentBySource(TENANT, {
      owner: { kind: 'self' },
      description: 'Future uncited',
      source: { kind: 'manual', externalId: 'm1', contentHash: 'h2', capturedAt: new Date().toISOString() },
      dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    // One tainted cited nudge approved (→ sent), one rejected untainted.
    const a1 = await enqueueActionWithApproval(TENANT, {
      kind: 'nudge', payload: {}, draft: 'nudge one',
      sourceRefs: [{ kind: 'gmail', externalId: 'g1', contentHash: 'h3', capturedAt: new Date().toISOString(), contentTrust: 'untrusted' }],
    });
    await decideActionViaApproval(TENANT, a1.approvalId!, 'approved', { decidedByUserId: 'u1' });
    const a2 = await enqueueActionWithApproval(TENANT, { kind: 'nudge', payload: {}, draft: 'nudge two' });
    await decideActionViaApproval(TENANT, a2.approvalId!, 'rejected', {});

    const health = await buildAssistantHealth(TENANT);
    expect(health.commitments.open).toBe(2);
    expect(health.commitments.stale).toBe(1);
    expect(health.commitments.citationCoverage).toBe(0.5);
    expect(health.actions.sent).toBe(1);
    expect(health.actions.rejected).toBe(1);
    expect(health.actions.approvalRate).toBe(0.5);
    expect(health.actions.editRate).toBe(0);
    expect(health.actions.citationCoverage).toBe(0.5);
    expect(health.actions.taintedShare).toBe(0.5);
    expect(health.loops.map((l) => l.loopId)).toContain('morning-briefing');
  });
});

describe('approvals (tenant,status) index — ADR 0029', () => {
  it('list + card-dedup stay correct across create → resolve, tenant-isolated', async () => {
    await __resetApprovalStore();
    const a = await createApproval({ tenantId: 't-ix-a', rosterId: 'r1', persona: 'p', workflowId: 'wf', cardId: 'card-1', proposal: 'run wf on card-1' });
    await createApproval({ tenantId: 't-ix-a', rosterId: 'r1', persona: 'p', workflowId: 'wf', cardId: 'card-2', proposal: 'run wf on card-2' });
    await createApproval({ tenantId: 't-ix-b', rosterId: 'r2', persona: 'p', workflowId: 'wf', cardId: 'card-1', proposal: 'other tenant' });

    expect((await listApprovals('t-ix-a', 'pending')).length).toBe(2);
    expect((await listApprovals('t-ix-b', 'pending')).length).toBe(1);
    expect(await hasPendingApprovalForCard('t-ix-a', 'card-1')).toBe(true);
    expect(await hasPendingApprovalForCard('t-ix-b', 'card-2')).toBe(false);

    const resolved = await resolveApproval(a.approvalId, { status: 'approved' });
    expect(resolved?.changed).toBe(true);
    expect((await listApprovals('t-ix-a', 'pending')).length).toBe(1);
    expect((await listApprovals('t-ix-a', 'approved')).length).toBe(1);
    expect((await listApprovals('t-ix-a')).length).toBe(2);
    expect(await hasPendingApprovalForCard('t-ix-a', 'card-1')).toBe(false);
  });
});
