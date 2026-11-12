/**
 * ADR 1102 D8 (`INS91-8`) — erasing the person the suite runs as erases the suite.
 *
 * The census (`subject-erasure-feature-stores`) proves the eraser is REGISTERED.
 * This proves it does what its docblock says: the config row, every weekly job the
 * tenant holds under the feature's prefix (the principal's and any orphan), and
 * every anniversary subscription (whose id carries the raw principal) with its
 * delivery rows. The code-review pass found the eraser had no behavioural test.
 *
 * Red when: the subject-form match is narrowed (a `user:` key stops matching a raw
 * principal); the eraser touches a config whose principal is someone else; it
 * reaches another tenant; it leaves a job, a subscription or the row; it stops
 * reporting what it touched; a second run touches anything.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { listJobs, registerJob, resetScheduling } from '../src/host/schedulingService.js';
import { __resetTriggerBridgeStore, listSubscriptions, registerSubscription } from '../src/host/triggerBridgeService.js';
import {
  __resetInsightsSuiteStore, applyConfig, eraseInsightsSuiteSubject, getConfig,
} from '../src/features/insights-suite/insightsSuiteService.js';

const ARMED = { scheduleCron: '0 6 * * 2', planSource: { projectId: 'acme-analytics' } };

async function seed(tenantId: string, principalUserId: string): Promise<void> {
  await applyConfig({ tenantId, principalUserId, businessUnit: 'TX', ...ARMED, updatedAt: '2026-11-11T00:00:00.000Z' });
  // A legacy (pre-1102) anniversary subscription, as an old save left it.
  await registerSubscription({
    subscriptionId: `insights-anniversary:${tenantId}:${principalUserId}`, tenantId, source: 'webhook',
    workflowId: 'openwop-app.insights.anniversary-draft', featureId: 'insights-suite', verificationMode: 'none', label: 'legacy',
  });
}

const insightsJobs = async (tenantId: string) => (await listJobs(tenantId)).filter((j) => j.jobId.startsWith(`insights-weekly:${tenantId}:`));
const insightsSubs = async (tenantId: string) => (await listSubscriptions(tenantId)).filter((s) => s.subscriptionId.startsWith(`insights-anniversary:${tenantId}:`));

describe('eraseInsightsSuiteSubject (ADR 1102 D8)', () => {
  beforeEach(async () => {
    initHostExtPersistence(await openStorage('memory://'));
    await __resetInsightsSuiteStore();
    await __resetTriggerBridgeStore();
    await resetScheduling();
  });

  it('erases the row, every weekly job and every anniversary subscription, and reports them', async () => {
    await seed('ws-a', 'u-dana');
    // An orphan an earlier principal left (INS91-5), still under this tenant's prefix.
    await registerJob({ jobId: 'insights-weekly:ws-a:u-earlier', tenantId: 'ws-a', cronExpr: '0 5 * * 1', featureId: 'insights-suite', enabled: true });
    expect(await insightsJobs('ws-a')).toHaveLength(2);

    const report = await eraseInsightsSuiteSubject('ws-a', 'u-dana');
    expect(report.rowsTouched).toBe(4); // 2 jobs + 1 subscription + the config row
    expect(await getConfig('ws-a')).toBeNull();
    expect(await insightsJobs('ws-a')).toEqual([]);
    expect(await insightsSubs('ws-a'), 'the raw principal survived in a subscription id').toEqual([]);
  });

  it('matches the `user:` spelling of the same person', async () => {
    await seed('ws-a', 'u-dana');
    expect((await eraseInsightsSuiteSubject('ws-a', 'user:u-dana')).rowsTouched).toBeGreaterThan(0);
    expect(await getConfig('ws-a')).toBeNull();
  });

  it('touches nothing for someone else, and nothing in another tenant', async () => {
    await seed('ws-a', 'u-dana');
    await seed('ws-b', 'u-dana');
    expect((await eraseInsightsSuiteSubject('ws-a', 'u-someone-else')).rowsTouched).toBe(0);
    expect(await getConfig('ws-a')).not.toBeNull();
    expect(await insightsJobs('ws-a')).toHaveLength(1);

    await eraseInsightsSuiteSubject('ws-a', 'u-dana');
    expect(await getConfig('ws-b'), 'the erasure reached another tenant').not.toBeNull();
    expect(await insightsJobs('ws-b')).toHaveLength(1);
    expect(await insightsSubs('ws-b')).toHaveLength(1);
  });

  it('is idempotent: a second run touches nothing', async () => {
    await seed('ws-a', 'u-dana');
    await eraseInsightsSuiteSubject('ws-a', 'u-dana');
    expect((await eraseInsightsSuiteSubject('ws-a', 'u-dana')).rowsTouched).toBe(0);
  });

  it('fails closed on empty input', async () => {
    await seed('ws-a', 'u-dana');
    expect((await eraseInsightsSuiteSubject('', 'u-dana')).rowsTouched).toBe(0);
    expect((await eraseInsightsSuiteSubject('ws-a', '')).rowsTouched).toBe(0);
    expect(await getConfig('ws-a')).not.toBeNull();
  });
});
