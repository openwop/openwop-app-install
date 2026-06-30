/**
 * Executive Assistant loop layer (ADR 0023 Phases 2–5) — the thin graph/logic
 * node pack over ctx.features.assistant + the prioritization scorer + idempotent
 * board projection (Loop 3). Nodes run over a stub ctx (the csm-nodes pattern).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { buildAssistantSurface } from '../src/features/assistant/surface.js';
import {
  __resetAssistantStore,
  upsertCommitmentBySource,
  getCommitment,
  contentHashOf,
  projectCommitmentToBoard,
} from '../src/features/assistant/assistantService.js';
import { ensurePersonalBoard, getPersonalBoard, listCards, updateCardFields, deleteCard } from '../src/host/kanbanService.js';
import { priorityScore, prioritize, deadlineProximityOf, PRIORITY_PROFILES } from '../src/features/assistant/prioritization.js';

describe('Prioritization layer (pure — ADR 0023 §4)', () => {
  it('scores higher with closer deadlines + importance; buckets by profile', () => {
    const hot = { senderImportance: 0.9, deadlineProximity: 1, projectPriority: 0.8, priorEngagement: 0.7 };
    const cold = { senderImportance: 0.1, deadlineProximity: 0, projectPriority: 0.1, priorEngagement: 0 };
    const hotScore = priorityScore(hot, PRIORITY_PROFILES.balanced.weights);
    const coldScore = priorityScore(cold, PRIORITY_PROFILES.balanced.weights);
    expect(hotScore).toBeGreaterThan(coldScore);
    expect(prioritize(hot, PRIORITY_PROFILES.balanced).bucket).toBe('surface');
    expect(prioritize(cold, PRIORITY_PROFILES.balanced).bucket).toBe('defer');
  });

  it('deadlineProximity is 1 when overdue, 0 beyond two weeks', () => {
    const now = Date.parse('2026-06-11T00:00:00Z');
    expect(deadlineProximityOf('2026-06-01T00:00:00Z', now)).toBe(1); // overdue
    expect(deadlineProximityOf('2026-07-30T00:00:00Z', now)).toBe(0); // far
    expect(deadlineProximityOf(undefined, now)).toBe(0);
  });

  it('aggressive profile surfaces less than conservative for the same item', () => {
    const mid = { senderImportance: 0.5, deadlineProximity: 0.5, projectPriority: 0.5, priorEngagement: 0.5 };
    expect(prioritize(mid, PRIORITY_PROFILES.conservative).bucket).toBe('surface');
    expect(prioritize(mid, PRIORITY_PROFILES.aggressive).bucket).not.toBe('surface');
  });
});

describe('feature.assistant.nodes over a stub ctx', () => {
  let server: http.Server;
  // Typed from the pack's ambient module declaration (test/feature-packs.d.ts) —
  // no `any`, no eslint-disable (mirrors the csm-nodes test pattern).
  let nodes: (typeof import('../../../packs/feature.assistant.nodes/index.mjs'))['nodes'];

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => {
      server = app.listen(0, res);
    });
    await __resetAssistantStore();
    nodes = (await import('../../../packs/feature.assistant.nodes/index.mjs')).nodes;
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  const ctxFor = (tenantId: string, inputs: Record<string, unknown>) => ({ features: { assistant: buildAssistantSurface({ tenantId }) }, inputs });
  // A node's outputs are `Record<string, unknown>` (ambient pack type); read one
  // field, narrowing from `unknown` with a single cast (never `as any`).
  const field = (r: { outputs?: Record<string, unknown> }, key: string): unknown => (r.outputs ?? {})[key];

  it('upsert-commitment writes the graph (idempotent, replay-safe)', async () => {
    const source = { kind: 'gmail', externalId: 'm-7', text: 'please send the report', contentHash: contentHashOf('m-7-body') };
    const r1 = await nodes['feature.assistant.nodes.upsert-commitment'](ctxFor('t-loops', { description: 'Send the report', source, dueAt: '2026-06-12T00:00:00Z' }));
    expect(r1.status).toBe('success');
    expect(field(r1, 'created')).toBe(true);
    const r2 = await nodes['feature.assistant.nodes.upsert-commitment'](ctxFor('t-loops', { description: 'Send the report', source }));
    expect(field(r2, 'created')).toBe(false); // same key → no duplicate
  });

  it('populate-board creates an agent card on the owner board, idempotently (Loop 3)', async () => {
    await ensurePersonalBoard('t-board', 'user:carol');
    const src = { kind: 'manual' as const, externalId: 'd1', contentHash: contentHashOf('ship'), capturedAt: '2026-06-10T00:00:00Z' };
    const { commitment } = await upsertCommitmentBySource('t-board', { owner: { kind: 'self' }, description: 'Ship v2', source: src, dueAt: '2026-06-11T00:00:00Z' });

    const first = await nodes['feature.assistant.nodes.populate-board'](ctxFor('t-board', { commitmentId: commitment.commitmentId, ownerUserId: 'user:carol' }));
    expect(field(first, 'created')).toBe(true);
    const card1 = field(first, 'card') as { cardId: string; priority: string };
    expect(card1.cardId).toBeTruthy();
    // overdue + default-neutral sender/project ⇒ a mid lane, never 'low'
    expect(['normal', 'high']).toContain(card1.priority);

    // re-run → same card, not a duplicate (back-ref idempotency)
    const second = await nodes['feature.assistant.nodes.populate-board'](ctxFor('t-board', { commitmentId: commitment.commitmentId, ownerUserId: 'user:carol' }));
    expect(field(second, 'created')).toBe(false);
    const card2 = field(second, 'card') as { cardId: string };
    expect(card2.cardId).toBe(card1.cardId);
    // and the commitment now carries the card back-ref
    expect((await getCommitment('t-board', commitment.commitmentId))?.kanbanCardId).toBe(card1.cardId);
  });

  // ADR 0023 §11 Q4 — the human owns the card once it exists: manual edits win,
  // the projection only flags drift, and a deleted card is never resurrected.
  it('manual edits win: a hand-edited card drifts (flagged, not overwritten)', async () => {
    await ensurePersonalBoard('t-drift', 'user:dana');
    const src = { kind: 'manual' as const, externalId: 'drift-1', contentHash: contentHashOf('drift-1'), capturedAt: '2026-06-10T00:00:00Z' };
    const { commitment } = await upsertCommitmentBySource('t-drift', { owner: { kind: 'self' }, description: 'Draft the brief', source: src });

    const first = await projectCommitmentToBoard('t-drift', commitment.commitmentId, { ownerUserId: 'user:dana' });
    expect(first?.status).toBe('created');
    const cardId = first!.card!.id;

    // Re-project an unchanged card → reused, no drift.
    const again = await projectCommitmentToBoard('t-drift', commitment.commitmentId, { ownerUserId: 'user:dana' });
    expect(again?.status).toBe('reused');
    expect(again?.commitment.driftsFromSource).toBeFalsy();

    // The human renames the card. Next projection must NOT overwrite it — it
    // flags drift and reports 'drifted'.
    await updateCardFields(cardId, { title: 'My own wording' });
    const drifted = await projectCommitmentToBoard('t-drift', commitment.commitmentId, { ownerUserId: 'user:dana' });
    expect(drifted?.status).toBe('drifted');
    expect(drifted?.card?.id).toBe(cardId);
    expect(drifted?.card?.title).toBe('My own wording'); // not overwritten
    expect(drifted?.commitment.driftsFromSource).toBe(true);
    // still exactly one card on the board (no duplicate)
    const board = await getPersonalBoard('t-drift', 'user:dana');
    expect((await listCards(board!.id)).length).toBe(1);
  });

  it('manual delete wins: a deleted card is dismissed, not resurrected', async () => {
    await ensurePersonalBoard('t-del', 'user:erin');
    const src = { kind: 'manual' as const, externalId: 'del-1', contentHash: contentHashOf('del-1'), capturedAt: '2026-06-10T00:00:00Z' };
    const { commitment } = await upsertCommitmentBySource('t-del', { owner: { kind: 'self' }, description: 'Old task', source: src });

    const first = await projectCommitmentToBoard('t-del', commitment.commitmentId, { ownerUserId: 'user:erin' });
    const cardId = first!.card!.id;
    // The human deletes the card.
    expect(await deleteCard(cardId)).toBe(true);

    // Re-project: the pre-fix code would recreate it. Now it's dismissed.
    const after = await projectCommitmentToBoard('t-del', commitment.commitmentId, { ownerUserId: 'user:erin' });
    expect(after?.status).toBe('dismissed');
    expect(after?.card).toBeNull();
    const board = await getPersonalBoard('t-del', 'user:erin');
    expect((await listCards(board!.id)).length).toBe(0); // NOT resurrected
  });

  it('prioritize + compose-briefing + enqueue-action run over the surface', async () => {
    const pri = await nodes['feature.assistant.nodes.prioritize'](ctxFor('t-brief', { senderImportance: 0.9, deadlineProximity: 1, projectPriority: 0.8, priorEngagement: 0.6, profile: 'balanced' }));
    expect(field(pri, 'bucket')).toBe('surface');

    const src = { kind: 'manual' as const, externalId: 'b1', contentHash: contentHashOf('b1'), capturedAt: '2026-06-10T00:00:00Z' };
    await upsertCommitmentBySource('t-brief', { owner: { kind: 'self' }, description: 'Open item', source: src });
    const brief = await nodes['feature.assistant.nodes.compose-briefing'](ctxFor('t-brief', {}));
    const briefObj = field(brief, 'brief') as { topCommitments: unknown[] };
    expect(briefObj.topCommitments.length).toBeGreaterThanOrEqual(1);

    const enq = await nodes['feature.assistant.nodes.enqueue-action'](ctxFor('t-brief', { kind: 'email.send', draft: 'Hi', payload: { to: 'x@y.com' } }));
    const pa = field(enq, 'pendingAction') as { status: string };
    expect(pa.status).toBe('pending');
  });
});
