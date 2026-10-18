/**
 * XCH-HOLE-1 — the Challenge Author's `openwop:kicktodo.challenge-performance`
 * read. The metrics routes gate on the `kicktodo-metrics` toggle plus
 * `hasKicktodoManageAuthority`; this tool must make the same decision, and its
 * answer must be the same projection the routes serve.
 *
 *   - no acting user ⇒ fail EMPTY (every section null), no metrics read;
 *   - toggle off ⇒ the typed `feature_disabled` refusal;
 *   - a participant without manage authority in a tenant that HAS data ⇒ EMPTY;
 *   - a manager ⇒ exactly what metricsService/verifierSampleService return.
 *
 * What reds it: dropping the toggle check or the `hasKicktodoManageAuthority`
 * call in `runChallengePerformanceTool`, or returning a payload that differs
 * from the route-side service functions. Sabotage-witnessed 2026-10-17: deleting
 * the authority check reds the participant case; deleting the toggle check reds
 * the feature_disabled case. Deleting ONLY the explicit no-acting-user early
 * return stays green, because the shared predicate itself refuses an undefined
 * subject — the empty-without-user case pins the observable behaviour, not that
 * one line.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerToggleDefault, getToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { kicktodoMetricsFeature } from '../src/features/kicktodo-metrics/feature.js';
import { runChallengePerformanceTool } from '../src/features/kicktodo-metrics/agentTools.js';
import { activationMetrics, engagementMetrics, factoryMetrics } from '../src/features/kicktodo-metrics/metricsService.js';
import { verifierQuality } from '../src/features/kicktodo-metrics/verifierSampleService.js';
import { createCandidate } from '../src/features/kicktodo-creator/creatorService.js';

// A manager's own personal workspace (tenantId === subject ⇒ implicit owner).
const MGR = 'user:kt-perf-manager';
// A shared tenant where the caller is a participant with no manage scope.
const SHARED = 'tenant-kt-perf-shared';
const PARTICIPANT = 'user:kt-perf-participant';

function contentOf(r: { content: string }): Record<string, unknown> {
  const v: unknown = JSON.parse(r.content);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`tool content is not an object: ${r.content}`);
  return { ...v };
}

async function setMetrics(status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault('kicktodo-metrics');
  if (!d) throw new Error('kicktodo-metrics toggle default not registered');
  await saveConfig({ ...d, status }, 'test');
}

const EMPTY = { scope: 'workspace', activation: null, engagement: null, factory: null, verifierQuality: null };

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault(kicktodoMetricsFeature.toggleDefault!);
  await setMetrics('on');
  const intake = { audience: 'beginners', transformation: '', durationDaysTarget: 14, dailyMinutesTarget: 15 };
  await createCandidate({ tenantId: MGR, createdBy: MGR, topic: 'Morning pages', ...intake });
  await createCandidate({ tenantId: SHARED, createdBy: 'user:owner', topic: 'Watercolor basics', ...intake });
});

describe('openwop:kicktodo.challenge-performance — the route predicate, shared (XCH-HOLE-1)', () => {
  it('fails EMPTY without an acting user (a system turn cannot probe metrics)', async () => {
    const r = await runChallengePerformanceTool({}, { tenantId: MGR });
    expect(r.isError).toBeUndefined();
    expect(contentOf(r)).toEqual(EMPTY);
  });

  it('returns the typed feature_disabled refusal when the metrics toggle is off', async () => {
    await setMetrics('off');
    try {
      const r = await runChallengePerformanceTool({}, { tenantId: MGR, actingUserId: MGR });
      expect(r.isError).toBe(true);
      expect(contentOf(r)).toMatchObject({ error: 'feature_disabled' });
    } finally {
      await setMetrics('on');
    }
  });

  it('fails EMPTY for a participant without manage authority, even though the tenant has candidates', async () => {
    const r = await runChallengePerformanceTool({}, { tenantId: SHARED, actingUserId: PARTICIPANT });
    expect(r.isError).toBeUndefined();
    expect(contentOf(r)).toEqual(EMPTY);
  });

  it('a manager reads exactly the projection the metrics routes serve', async () => {
    const r = await runChallengePerformanceTool({}, { tenantId: MGR, actingUserId: MGR });
    expect(r.isError).toBeUndefined();
    const body = contentOf(r);
    expect(body).toEqual(JSON.parse(JSON.stringify({
      scope: 'workspace',
      kFloor: 5,
      activation: await activationMetrics(MGR),
      engagement: await engagementMetrics(MGR),
      factory: await factoryMetrics(MGR),
      verifierQuality: await verifierQuality(MGR),
    })));
    // Not vacuous: the manager's one candidate is counted, the SHARED tenant's is not.
    expect(body.factory).toMatchObject({ candidatesByState: { intake: 1 } });
  });
});
