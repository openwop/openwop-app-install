/**
 * ANL-9 (grade-code 2026-08-18 → 2026-09-10) — the `analytics-conversions` metric
 * source reported `summary.byType.conversion` unconditionally, so an org whose
 * beacon had recorded NOTHING (not installed, never consented, telemetry-only)
 * wrote a CONFIRMED 0 check-in nightly — "zero conversions" where the truth was
 * "not measuring". The commerce-revenue arm recorded exactly this correction 30
 * lines below it. A source that can measure nothing must SKIP, not report zero;
 * zero conversions WITH traffic is a real measurement and still reports.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { buildStrategySurface } from '../src/features/strategy/surface.js';
import { recordEvent } from '../src/features/analytics/analyticsService.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('strategy', 'on');
  await enableToggle('analytics', 'on');
});
afterAll(async () => { await closeApp(); });

const S = '/v1/host/openwop-app/strategy';

async function setup(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:ac-${Date.now()}-${n++}`;
  const owner = makeClient(() => BASE);
  expect((await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('ac'), tenantId })).status).toBe(201);
  const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Site' })).body.orgId;
  const s = (await owner.post(S, {
    orgId, title: 'Conversion plan', scope: 'org',
    objectives: [{ title: 'Convert', weight: 1, keyResults: [{ title: 'Conversions', weight: 1, measure: { kind: 'numeric', baseline: 0, target: 100, source: { kind: 'analytics-conversions', orgId } } }] }],
  })).body;
  expect(s.id, JSON.stringify(s)).toBeTruthy();
  expect((await owner.patch(`${S}/${s.id}`, { status: 'active' })).status).toBe(200);
  return { owner, orgId, tenantId };
}

async function sync(tenantId: string): Promise<{ synced?: number; skippedReason?: string }> {
  const out = JSON.parse(JSON.stringify(await buildStrategySurface({ tenantId }).syncMetrics({ actor: 'run:sync' })));
  const synced = (out.synced as Array<{ value: number; source: string }>).find((x) => x.source === 'analytics-conversions');
  const skip = (out.skipped as Array<{ reason?: string }>).find((x) => String(x.reason ?? '').includes('analytics'));
  return { synced: synced?.value, skippedReason: skip?.reason };
}

describe('analytics-conversions metric source (ANL-9)', () => {
  it('SKIPS (typed reason) when the beacon has recorded nothing — never a confirmed 0', async () => {
    const { tenantId } = await setup();
    const r = await sync(tenantId);
    expect(r.synced, 'no value may be written for an unmeasured source').toBeUndefined();
    expect(r.skippedReason).toMatch(/^source_no_analytics_events/);
  });

  it('reports a REAL zero once traffic exists, and the count once conversions land', async () => {
    const { orgId, tenantId } = await setup();
    await recordEvent({ tenantId, orgId, raw: { type: 'pageview', path: '/', sessionKey: 's1' } });
    expect((await sync(tenantId)).synced, 'zero conversions WITH traffic is a measurement').toBe(0);
    await recordEvent({ tenantId, orgId, raw: { type: 'conversion', sessionKey: 's1' } });
    expect((await sync(tenantId)).synced).toBe(1);
  });
});
