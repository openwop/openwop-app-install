/**
 * Strategy check-ins + measurement (ADR 0231 §C1) — ROUTE + SURFACE coverage:
 *   - typed measure validation on the KR (bad kind/weight → 400)
 *   - human route check-in ⇒ CONFIRMED; progress + staleness surface in /health
 *   - surface (agent) check-in ⇒ PROPOSED, then human confirm/dismiss routes
 *   - surface sync mode: fail-closed 403 without `measure.source`; confirmed with
 *   - weighted rollup math (KR weights → objective; objective weights → strategy)
 *   - all measured KRs stale ⇒ an otherwise ON-TRACK strategy is downgraded to at-risk
 *
 * Sabotage witnesses (grade-tests w19, `w19g2-ci-*`): agent ⇒ 'confirmed', the
 * sync source check removed, proposed rows counted as progress, a decrease
 * span inverted, KR / objective weights flattened to 1, the stale count or the
 * all-stale downgrade dropped, the approval decide flipped — each turns a case red.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { buildStrategySurface } from '../src/features/strategy/surface.js';
import { computeKrProgress, computeStrategyProgress, type StrategyCheckIn } from '../src/features/strategy/checkIns.js';
import type { Strategy, StrategyHealthRow } from '../src/features/strategy/types.js';
import type { PendingApproval } from '../src/host/approvalService.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('strategy', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);

const S = '/host/openwop-app/strategy';
const freshTenant = (): string => `org:ci-${Date.now()}-${n++}`;

async function ownerWithStrategy(measured = true): Promise<{ owner: Client; orgId: string; s: Strategy; tenantId: string }> {
  const tenantId = freshTenant();
  const owner = client();
  const login = await owner.post('/host/openwop-app/test/login', { email: uniqEmail('ci'), tenantId });
  expect(login.status).toBe(201);
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  const s: Strategy = (await owner.post(S, {
    orgId, title: 'Measured plan', scope: 'org',
    objectives: [{
      title: 'Grow ARR', weight: 3,
      keyResults: measured
        ? [{ title: 'ARR', weight: 2, measure: { kind: 'currency', baseline: 0, target: 100, direction: 'increase', unit: 'USD' } },
           { title: 'Churn', weight: 1, measure: { kind: 'percent', baseline: 10, target: 5, direction: 'decrease' } }]
        : [{ title: 'Vibes', target: 'good' }],
    }],
  })).body;
  expect(s.id, JSON.stringify(s)).toBeTruthy();
  return { owner, orgId, s, tenantId };
}
/** A second measured strategy in an existing owner's org (same KR shape). */
async function ownerWithStrategyIn(owner: Client, orgId: string): Promise<Strategy> {
  const res = await owner.post(S, {
    orgId, title: 'Fresh plan', scope: 'org',
    objectives: [{ title: 'Grow ARR', weight: 3, keyResults: [
      { title: 'ARR', weight: 2, measure: { kind: 'currency', baseline: 0, target: 100, direction: 'increase', unit: 'USD' } },
      { title: 'Churn', weight: 1, measure: { kind: 'percent', baseline: 10, target: 5, direction: 'decrease' } },
    ] }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Strategy;
}
const krIds = (s: Strategy): string[] => s.objectives[0]!.keyResults.map((k) => k.id);
/** This strategy's row on GET /strategy/health. */
async function healthRow(owner: Client, id: string): Promise<StrategyHealthRow> {
  const res = await owner.get(`${S}/health`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const row = (res.body.strategies as StrategyHealthRow[]).find((x) => x.id === id);
  expect(row, `no health row for ${id}`).toBeTruthy();
  return row!;
}
const pendingItems = async (owner: Client, status: 'pending' | 'approved'): Promise<PendingApproval[]> =>
  (await owner.get(`/host/openwop-app/approvals?status=${status}`)).body.items as PendingApproval[];

describe('measure validation', () => {
  it('rejects a bad measure kind / weight out of band', async () => {
    const { owner, orgId } = await ownerWithStrategy();
    // Each 400 must come from the field under test, not the other one.
    const badKind = await owner.post(S, { orgId, title: 'Bad', objectives: [{ title: 'O', keyResults: [{ title: 'K', measure: { kind: 'vibes' } }] }] });
    expect(badKind.status).toBe(400);
    expect(badKind.body.details?.field).toBe('measure.kind');
    const badWeight = await owner.post(S, { orgId, title: 'Bad', objectives: [{ title: 'O', weight: 99, keyResults: [] }] });
    expect(badWeight.status).toBe(400);
    expect(badWeight.body.details?.field).toBe('objective.weight');
  });
});

describe('check-ins — human route vs agent surface vs sync (ADR 0231 actor classing)', () => {
  it('a human check-in is CONFIRMED and drives /health progress', async () => {
    const { owner, s, tenantId } = await ownerWithStrategy();
    const [arrKr, churnKr] = krIds(s);
    await owner.patch(`${S}/${s.id}`, { status: 'active' });

    const r = await owner.post(`${S}/${s.id}/key-results/${arrKr}/check-ins`, { value: 50, note: 'halfway', confidence: 'high' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe('confirmed');
    expect(r.body.origin).toBe('human');

    // churn 10 → 5 on a decrease measure = 100% progress
    expect((await owner.post(`${S}/${s.id}/key-results/${churnKr}/check-ins`, { value: 5 })).status).toBe(201);

    const row = await healthRow(owner, s.id);
    expect(row.signals?.measuredKrCount).toBe(2);
    expect(row.signals?.staleKrCount).toBe(0);
    // KR-weighted: ARR (w2, 0.5) + churn (w1, 1.0) ⇒ (1 + 1) / 3 = 2/3.
    // An unweighted mean would read 0.75 — the two KRs deliberately DIFFER.
    expect(row.signals?.progress).toBeCloseTo(2 / 3, 5);

    const list = await owner.get(`${S}/${s.id}/check-ins?krId=${arrKr}`);
    expect(list.body.checkIns).toHaveLength(1);
    expect(list.body.checkIns[0].note).toBe('halfway');
    void tenantId;
  });

  it('an agent surface check-in is PROPOSED; a human confirms (or dismisses) it', async () => {
    const { owner, s, tenantId } = await ownerWithStrategy();
    const [arrKr] = krIds(s);
    const surface = buildStrategySurface({ tenantId });

    const out = JSON.parse(JSON.stringify(await surface.checkIn({ strategyId: s.id, krId: arrKr, value: 25, note: 'analyst estimate' })));
    expect(out.checkIn.status).toBe('proposed'); // structurally — never confirmed from an agent
    expect(out.checkIn.origin).toBe('agent');

    // Proposed rows do NOT drive progress …
    const rowBefore = await healthRow(owner, s.id);
    expect(rowBefore.signals?.progress).toBeUndefined();
    expect(rowBefore.signals?.proposedCheckInCount).toBe(1);

    // … until a human confirms.
    const conf = await owner.post(`${S}/${s.id}/check-ins/${out.checkIn.checkInId}/confirm`);
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    expect(conf.body.status).toBe('confirmed');
    // Re-deciding is a 409 (already decided).
    expect((await owner.post(`${S}/${s.id}/check-ins/${out.checkIn.checkInId}/dismiss`)).status).toBe(409);

    const rowAfter = await healthRow(owner, s.id);
    // Unvalued KRs drop out of the weighted mean entirely (they read as stale,
    // not as zero) — only ARR (25%) contributes.
    expect(rowAfter.signals?.progress).toBeCloseTo(0.25, 5);
  });

  it('sync mode is fail-closed without measure.source and CONFIRMED with it', async () => {
    const { owner, s, tenantId } = await ownerWithStrategy();
    const [arrKr] = krIds(s);
    const surface = buildStrategySurface({ tenantId });

    // No source configured ⇒ refused fail-closed (forbidden_scope).
    await expect(surface.checkIn({ strategyId: s.id, krId: arrKr, value: 10, mode: 'sync' })).rejects.toMatchObject({ code: 'forbidden_scope' });

    // A human configures the standing source; the sync write is then confirmed.
    const patched = await owner.patch(`${S}/${s.id}`, {
      objectives: [{
        id: s.objectives[0]!.id, title: 'Grow ARR', weight: 3,
        keyResults: [{ id: arrKr, title: 'ARR', weight: 2, measure: { kind: 'currency', baseline: 0, target: 100, source: { kind: 'crm-deal-total', orgId: s.orgId } } }],
      }],
    });
    expect(patched.status).toBe(200);
    const out = JSON.parse(JSON.stringify(await surface.checkIn({ strategyId: s.id, krId: arrKr, value: 42, mode: 'sync', actor: 'run:sync-1' })));
    expect(out.checkIn.status).toBe('confirmed');
    expect(out.checkIn.origin).toBe('sync');
    expect(out.checkIn.actor).toBe('run:sync-1');
  });
});

// CHAT-FIRST-PORT-AUDIT D3 — an agent-proposed check-in is decided on ONE shared
// approval record: it renders in the reviews inbox, and deciding from the inbox
// and from the strategy page are the SAME CAS operation (no double-decide, no
// bespoke minting).
describe('check-in ↔ shared approval (D3 reconciliation)', () => {
  const APPR = '/host/openwop-app/approvals';

  it('a proposed check-in raises a strategy-checkin approval in the reviews inbox', async () => {
    const { owner, s, tenantId } = await ownerWithStrategy();
    const [arrKr] = krIds(s);
    const surface = buildStrategySurface({ tenantId });
    const out = JSON.parse(JSON.stringify(await surface.checkIn({ strategyId: s.id, krId: arrKr, value: 25 })));

    const items = await pendingItems(owner, 'pending');
    const row = items.find((a) => a.kind === 'strategy-checkin' && a.strategyCheckIn?.checkInId === out.checkIn.checkInId);
    expect(row, JSON.stringify(items)).toBeTruthy();
    expect(row!.strategyId).toBe(s.id);
    expect(row!.orgId).toBe(s.orgId);
  });

  it('inbox-decide and page-decide converge on ONE record (deciding in the inbox confirms the check-in; the page then 409s)', async () => {
    const { owner, s, tenantId } = await ownerWithStrategy();
    const [arrKr] = krIds(s);
    const surface = buildStrategySurface({ tenantId });
    const out = JSON.parse(JSON.stringify(await surface.checkIn({ strategyId: s.id, krId: arrKr, value: 25 })));

    const row = (await pendingItems(owner, 'pending')).find((a) => a.strategyCheckIn?.checkInId === out.checkIn.checkInId);
    expect(row).toBeTruthy();
    // Decide from the INBOX (claim === confirm).
    expect((await owner.post(`${APPR}/${row!.approvalId}/claim`)).status).toBe(200);

    // The check-in row reflects the inbox decision — ONE durable record.
    const list = await owner.get(`${S}/${s.id}/check-ins?krId=${arrKr}`);
    expect(list.body.checkIns[0].status).toBe('confirmed');

    // The PAGE decide now refuses (same record, already decided) — the bespoke
    // route can no longer mint a second decision.
    expect((await owner.post(`${S}/${s.id}/check-ins/${out.checkIn.checkInId}/confirm`)).status).toBe(409);
    expect((await owner.post(`${S}/${s.id}/check-ins/${out.checkIn.checkInId}/dismiss`)).status).toBe(409);
  });

  it('a page confirm resolves the shared approval (it leaves the pending inbox as approved)', async () => {
    const { owner, s, tenantId } = await ownerWithStrategy();
    const [arrKr] = krIds(s);
    const surface = buildStrategySurface({ tenantId });
    const out = JSON.parse(JSON.stringify(await surface.checkIn({ strategyId: s.id, krId: arrKr, value: 25 })));

    // Decide from the PAGE.
    expect((await owner.post(`${S}/${s.id}/check-ins/${out.checkIn.checkInId}/confirm`)).status).toBe(200);

    // The shared approval left the pending inbox and is recorded approved.
    const pending = (await pendingItems(owner, 'pending')).filter((a) => a.strategyCheckIn?.checkInId === out.checkIn.checkInId);
    expect(pending).toHaveLength(0);
    const approved = (await pendingItems(owner, 'approved')).find((a) => a.strategyCheckIn?.checkInId === out.checkIn.checkInId);
    expect(approved, 'the page decision resolved the shared record').toBeTruthy();
  });
});

describe('progress math (pure)', () => {
  it('computeKrProgress clamps and respects direction; rollup weights compose', () => {
    const inc = { id: 'k1', title: 'up', measure: { kind: 'numeric' as const, baseline: 100, target: 200 } };
    expect(computeKrProgress(inc, 150)).toBeCloseTo(0.5);
    expect(computeKrProgress(inc, 250)).toBe(1);
    expect(computeKrProgress(inc, 50)).toBe(0);
    const dec = { id: 'k2', title: 'down', measure: { kind: 'percent' as const, baseline: 10, target: 5, direction: 'decrease' as const } };
    expect(computeKrProgress(dec, 7.5)).toBeCloseTo(0.5);
    const boolKr = { id: 'k3', title: 'done', measure: { kind: 'boolean' as const } };
    expect(computeKrProgress(boolKr, 1)).toBe(1);
    expect(computeKrProgress(boolKr, 0)).toBe(0);

    const T = '2030-01-01T00:00:00.000Z';
    const strategy: Strategy = {
      tenantId: 't', id: 's', orgId: 'org', scope: 'org', title: 'Pure', planningHorizon: 'annual', period: { label: 'FY30' },
      status: 'active', initiatives: [], links: [], createdBy: 'u', createdAt: T, updatedAt: T,
      objectives: [
        { id: 'o1', title: 'A', weight: 3, keyResults: [inc] },
        { id: 'o2', title: 'B', weight: 1, keyResults: [dec] },
      ],
    };
    const rows: StrategyCheckIn[] = [
      { checkInId: '1', tenantId: 't', strategyId: 's', krId: 'k1', value: 150, status: 'confirmed', origin: 'human', actor: 'u', createdAt: T },
      { checkInId: '2', tenantId: 't', strategyId: 's', krId: 'k2', value: 5, status: 'confirmed', origin: 'human', actor: 'u', createdAt: T },
    ];
    // Fixed clock: "now" is the check-ins' own instant, so neither is stale.
    const p = computeStrategyProgress(strategy, rows, Date.parse(T));
    // objective A (w3) at 0.5, objective B (w1) at 1.0 ⇒ (3*0.5 + 1*1)/4 = 0.625
    expect(p.progress).toBeCloseTo(0.625, 5);
    expect(p.staleKrCount).toBe(0);
  });

  it('stale measured KRs mark the strategy at-risk in /health', async () => {
    const { owner, orgId, s } = await ownerWithStrategy();
    // An ON-TRACK link-derived baseline: one linked project (execution present,
    // no milestones, not at-risk) ⇒ verdict() says on-track. Without it the
    // verdict is already off-track (objectives, nothing linked), and the
    // all-stale downgrade can never fire — the earlier version of this case
    // accepted ['at-risk','off-track'] and could not fail (w19g2-ci-atrisk).
    const proj = await owner.post('/host/openwop-app/projects', { orgId, name: 'Apollo' });
    expect(proj.status, JSON.stringify(proj.body)).toBe(201);
    const link = async (id: string) => {
      const r = await owner.put(`${S}/${id}/links`, { links: [{ kind: 'project', projectId: proj.body.id }] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await owner.patch(`${S}/${id}`, { status: 'active' })).status).toBe(200);
    };
    await link(s.id);

    // MATCHED POSITIVE CONTROL — the same shape with every KR freshly checked in
    // reads on-track, so the at-risk below is the staleness and nothing else.
    const fresh = await ownerWithStrategyIn(owner, orgId);
    await link(fresh.id);
    for (const [kr, value] of krIds(fresh).map((k, i) => [k, i === 0 ? 50 : 7.5] as const)) {
      expect((await owner.post(`${S}/${fresh.id}/key-results/${kr}/check-ins`, { value })).status).toBe(201);
    }
    const control = await healthRow(owner, fresh.id);
    expect(control.signals?.staleKrCount).toBe(0);
    expect(control.health, 'the link-derived baseline must be on-track').toBe('on-track');

    // Measured KRs, zero check-ins ⇒ all stale ⇒ on-track downgraded to at-risk.
    const row = await healthRow(owner, s.id);
    expect(row.signals?.measuredKrCount).toBe(2);
    expect(row.signals?.staleKrCount).toBe(2);
    expect(row.health).toBe('at-risk');
  });
});
