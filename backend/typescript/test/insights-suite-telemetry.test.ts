/**
 * INS-1 — Insights Suite reconciliation telemetry.
 *
 * `applyConfig` reconciles a tenant's suite config onto the workflow engine (a weekly
 * variance schedule + a work-anniversary trigger subscription) but emitted NO structured
 * log, so ops had no per-tenant view of whether the schedule/trigger were armed. It now
 * emits one `insights_suite_reconciled` line per apply. (The per-RUN outcome/cost of the
 * workflows themselves rides the executor's standard run events — out of scope here.)
 *
 * ADR 0599 §6 (ISC-7): `scheduleArmed` may only be true after `registerJob` reported ok,
 * and the job/subscription ids appear ONLY when the primitive is armed.
 * Sabotage that reds it (/grade-tests w20): `scheduleArmed = false` or a pinned
 * `anniversaryArmed:false` reds case 1; leaking the `jobId`/`subscriptionId` spread
 * on an unarmed apply reds case 2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { applyConfig, __resetInsightsSuiteStore } from '../src/features/insights-suite/insightsSuiteService.js';

function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  return fn().finally(() => spy.mockRestore()).then(() => lines.join(''));
}

const base = (over: Record<string, unknown> = {}) => ({
  tenantId: 'tA', principalUserId: 'u1', businessUnits: ['Sales', 'Eng'], updatedAt: '2026-06-20T00:00:00.000Z', ...over,
});

describe('INS-1 — insights_suite_reconciled telemetry', () => {
  beforeEach(async () => {
    initHostExtPersistence(await openStorage('memory://'));
    await __resetInsightsSuiteStore();
  });
  afterEach(() => vi.restoreAllMocks());

  it('logs schedule + anniversary as ARMED when both are configured', async () => {
    const out = await capture(async () => {
      await applyConfig(base({ scheduleCron: '0 9 * * 1', anniversaryTriggerEnabled: true }));
    });
    expect(out).toContain('insights_suite_reconciled');
    expect(out).toMatch(/"scheduleArmed":true/);
    expect(out).toMatch(/"anniversaryArmed":true/);
    expect(out).toMatch(/"businessUnits":2/);
    expect(out).toContain('"cron":"0 9 * * 1"');
    // Positive control for case 2's "omits the ids": armed ⇒ the ids ARE present.
    expect(out).toContain('"jobId":"insights-weekly:tA:u1"');
    expect(out).toContain('"subscriptionId":"insights-anniversary:tA:u1"');
  });

  it('logs both as NOT armed when neither is configured (and omits the ids)', async () => {
    const out = await capture(async () => { await applyConfig(base()); });
    expect(out).toMatch(/"scheduleArmed":false/);
    expect(out).toMatch(/"anniversaryArmed":false/);
    // `"cron"` alone cannot catch a leaked spread (an undefined cron is dropped by
    // JSON.stringify), so the jobId — always defined — is the schedule-side witness.
    expect(out).not.toContain('"jobId"');
    expect(out).not.toContain('"cron"');
    expect(out).not.toContain('"subscriptionId"');
  });
});
