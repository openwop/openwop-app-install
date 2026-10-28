/**
 * ADR 0954 P0 — the lead scoring model store, the evaluator on the one engine,
 * v0 parity and the per-visitor event index (gap L3).
 *
 * Exit criteria:
 *  - v0 equals the pre-P0 `computeLeadScore` on fixtures. The OLD algorithm is
 *    kept below as the oracle and run against the same events, including rows
 *    written before the index existed;
 *  - a model with an unknown signal (or a non-monotone band table) is a 422;
 *  - no per-contact tenant scan remains: the score reads the index, which
 *    follows deletes (the retention purge and DSAR eraser) and reports a cap as
 *    `truncated`.
 * The end-to-end route parity with paid orders is `funnel-d-adjacent.test.ts`.
 *
 * Sabotage-witnessed (P0): removing the `cdp:collected-event` delete hook reds
 * "a deleted event leaves the index"; skipping the backfill reds "rows written
 * before the index"; dropping the `points` branch in `computePriority` reds the
 * parity case; dropping the CAS reds "a stale editor".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { createApp } from '../src/index.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { collectEvent, listCollectedEvents } from '../src/features/cdp/collectService.js';
import { eventsForVisitors, indexCollectedEvent, VISITOR_EVENT_CAP } from '../src/features/cdp/visitorEventIndex.js';
import { linkSession, sessionsForContact } from '../src/features/analytics/identityLinkService.js';
import { computeLeadScore } from '../src/features/crm/leadScoreService.js';
import { computePriority } from '../src/host/weightedScoring.js';
import { evaluateLeadScore, validateModelContent, V0_CONTENT } from '../src/features/crm/leadIntel/model.js';
import { activateModel, resolveActiveModel, saveModelVersion } from '../src/features/crm/leadIntel/modelStore.js';

let server: http.Server;
const T = (): string => `t-0954-${randomBytes(4).toString('hex')}`;

const raw = new DurableCollection<{ eventId: string; tenantId: string; eventType: string; payload: Record<string, unknown>; piiFields: string[]; at: string }>(
  'cdp:collected-event', (e) => e.eventId, undefined, (e) => e.tenantId,
);

/** The pre-P0 algorithm, verbatim in shape: a tenant scan per contact. */
async function oracle(tenantId: string, contactId: string): Promise<{ views: number; completions: number }> {
  const sessions = new Set(await sessionsForContact(tenantId, contactId, { fresh: true }));
  let views = 0;
  let completions = 0;
  if (sessions.size > 0) {
    for (const evt of await listCollectedEvents(tenantId, 50_000)) {
      if (evt.eventType !== 'funnel.step_viewed' && evt.eventType !== 'funnel.step_completed') continue;
      const visitor = (evt.payload as { visitor?: unknown }).visitor;
      if (typeof visitor !== 'string' || !sessions.has(visitor)) continue;
      if (evt.eventType === 'funnel.step_viewed') views += 1; else completions += 1;
    }
  }
  return { views, completions };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0954 P0 — v0 parity through the per-visitor index', () => {
  it('equals the old tenant-scan score, including rows written before the index', async () => {
    const tenantId = T();
    const contactId = 'contact-a';
    await linkSession(tenantId, 'sess-a1', contactId, 'form-submit');
    await linkSession(tenantId, 'sess-a2', contactId, 'form-submit');
    await linkSession(tenantId, 'sess-b1', 'contact-b', 'form-submit');
    // Legacy rows: written straight to the store, never indexed.
    for (let i = 0; i < 4; i += 1) {
      await raw.put({ eventId: `legacy-${tenantId}-${i}`, tenantId, eventType: 'funnel.step_viewed', payload: { visitor: 'sess-a1' }, piiFields: [], at: new Date(Date.now() - i * 1000).toISOString() });
    }
    await collectEvent(tenantId, 'funnel.step_viewed', { visitor: 'sess-a2' });
    await collectEvent(tenantId, 'funnel.step_completed', { visitor: 'sess-a2' });
    await collectEvent(tenantId, 'funnel.step_completed', { visitor: 'sess-a1' });
    await collectEvent(tenantId, 'funnel.step_viewed', { visitor: 'sess-b1' }); // another contact
    await collectEvent(tenantId, 'page_view', { visitor: 'sess-a1' }); // not a funnel event

    const expected = await oracle(tenantId, contactId);
    expect(expected).toEqual({ views: 5, completions: 2 });
    const score = await computeLeadScore(tenantId, contactId);
    expect(score.parts).toEqual({ linkedSessions: 2, funnelViews: 5, funnelCompletions: 2, paidOrders: 0 });
    expect(score.score).toBe(expected.views * 1 + expected.completions * 5);
    expect(score.truncated).toBe(false);
  });

  it('a deleted event leaves the index (retention purge and DSAR delete through the store)', async () => {
    const tenantId = T();
    await linkSession(tenantId, 'sess-x', 'contact-x', 'form-submit');
    const { eventId } = await collectEvent(tenantId, 'funnel.step_viewed', { visitor: 'sess-x' });
    await collectEvent(tenantId, 'funnel.step_viewed', { visitor: 'sess-x' });
    expect((await computeLeadScore(tenantId, 'contact-x')).parts.funnelViews).toBe(2);
    await raw.delete(eventId); // what the purger and the CONS-6 eraser do
    expect((await computeLeadScore(tenantId, 'contact-x')).parts.funnelViews).toBe(1);
  });

  it('a capped visitor read says truncated, never a silent lower count', async () => {
    const tenantId = T();
    const at = new Date().toISOString();
    for (let i = 0; i <= VISITOR_EVENT_CAP; i += 1) {
      const row = { eventId: `cap-${i}`, tenantId, eventType: 'funnel.step_viewed', payload: { visitor: 'busy' }, piiFields: [], at };
      await raw.put(row);
      await indexCollectedEvent(row);
    }
    const out = await eventsForVisitors(tenantId, ['busy']);
    expect(out.truncated).toBe(true);
    expect(out.events.length).toBe(VISITOR_EVENT_CAP);
  }, 120_000);
});

describe('ADR 0954 D1 — the engine and the model', () => {
  it('`points` is Σ min(raw, cap) × weight, unclamped; other aggregations are unchanged', () => {
    const set = { aggregation: 'points' as const, criteria: [
      { id: 'v', name: 'v', weight: 1, direction: 'benefit' as const },
      { id: 'o', name: 'o', weight: 20, direction: 'benefit' as const, cap: 2 },
    ] };
    expect(computePriority(set, { v: 37, o: 5 })).toBe(37 + 40);
    expect(computePriority({ ...set, aggregation: 'weighted-sum' }, { v: 37, o: 5 })).toBeLessThanOrEqual(10);
    expect(evaluateLeadScore(V0_CONTENT, { 'funnel.view': 3, 'funnel.completion': 2, 'commerce.paid-order': 1 }))
      .toMatchObject({ score: 3 + 10 + 20, band: 'C' });
  });

  it('an unknown signal, a non-monotone band table or a duplicate criterion is a 422', () => {
    const ok = { signals: [{ signalId: 'funnel.view', weight: 1 }], bands: { A: 50, B: 40, C: 30, D: 20, E: 10 } };
    expect(() => validateModelContent(ok)).not.toThrow();
    expect(() => validateModelContent({ ...ok, signals: [{ signalId: 'twitter.followers', weight: 1 }] })).toThrow(expect.objectContaining({ httpStatus: 422, details: { field: 'signals[0].signalId' } }));
    expect(() => validateModelContent({ ...ok, bands: { A: 50, B: 50, C: 30, D: 20, E: 10 } })).toThrow(expect.objectContaining({ httpStatus: 422 }));
    expect(() => validateModelContent({ ...ok, criteria: [
      { criterionId: 'budget', label: 'Budget', answer: { kind: 'range', min: 0, max: 10 } },
      { criterionId: 'budget', label: 'Again', answer: { kind: 'range', min: 0, max: 10 } },
    ] })).toThrow(expect.objectContaining({ httpStatus: 422 }));
    expect(() => validateModelContent({ ...ok, sla: { A: { firstTouchMinutes: 0 } } })).toThrow(expect.objectContaining({ httpStatus: 422 }));
  });

  it('versions are immutable; a stale editor is refused; the active model is a CAS pointer; no model ⇒ v0', async () => {
    const tenantId = T();
    const orgId = 'org-client-a';
    expect((await resolveActiveModel(tenantId, orgId)).modelId).toBe('v0');
    const content = { signals: [{ signalId: 'funnel.completion', weight: 10 }], bands: { A: 50, B: 40, C: 30, D: 20, E: 10 } };
    const v1 = await saveModelVersion({ tenantId, orgId, modelId: 'standard', expectedVersion: 0, content, actor: 'u1' });
    expect(v1.version).toBe(1);
    await expect(saveModelVersion({ tenantId, orgId, modelId: 'standard', expectedVersion: 0, content, actor: 'u2' }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'model_version_conflict' } });
    const v2 = await saveModelVersion({ tenantId, orgId, modelId: 'standard', expectedVersion: 1, content: { ...content, signals: [{ signalId: 'funnel.completion', weight: 12 }] }, actor: 'u1' });
    expect(v2.contentHash).not.toBe(v1.contentHash);

    await activateModel({ tenantId, orgId, modelId: 'standard', version: 1, actor: 'u1', expected: null });
    await expect(activateModel({ tenantId, orgId, modelId: 'standard', version: 2, actor: 'u2', expected: null }))
      .rejects.toMatchObject({ httpStatus: 409 });
    await activateModel({ tenantId, orgId, modelId: 'standard', version: 2, actor: 'u1', expected: { modelId: 'standard', version: 1 } });
    expect(await resolveActiveModel(tenantId, orgId)).toMatchObject({ modelId: 'standard', version: 2 });
    // Another client is untouched.
    expect((await resolveActiveModel(tenantId, 'org-client-b')).modelId).toBe('v0');
  });
});
