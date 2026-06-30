/**
 * ADR 0081 Phase 6 — cron validation at PUT /config.
 *
 * A malformed `scheduleCron` previously persisted a silently never-firing job (ADR 0078
 * P2 review LOW). The route now validates the cron at the HTTP boundary with the
 * scheduler's single parser (host/cronSchedule#parseCron) and 400s a bad expression.
 *
 * Runs in demo mode so the dev-token principal resolves to the tenant owner
 * (workspace:write) and the toggle is enabled — letting the request reach the cron guard.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __clearToggleStore, getEffectiveConfig, saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __resetInsightsSuiteStore } from '../src/features/insights-suite/insightsSuiteService.js';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_DEMO_MODE = 'true'; // dev principal → tenant owner (workspace:write)
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __clearToggleStore();
  await __resetInsightsSuiteStore();
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  // Enable the toggle so requireFeatureEnabled passes (mirrors the demo seeder).
  const base = (await getEffectiveConfig('insights-suite')) ?? getToggleDefault('insights-suite');
  if (base) await saveConfig({ ...base, status: 'beta' }, 'cron-test');
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_DEMO_MODE;
  await new Promise<void>((res) => server.close(() => res()));
});

const putConfig = (bodyObj: Record<string, unknown>) =>
  fetch(`${BASE}/v1/host/openwop-app/insights-suite/config`, { method: 'PUT', headers: H, body: JSON.stringify(bodyObj) });

describe('ADR 0081 §6 — cron validation at PUT /config', () => {
  it('rejects a malformed cron with 400 invalid_request', async () => {
    const res = await putConfig({ principalUserId: 'u-ceo', scheduleCron: 'not a cron' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('invalid_request');
  });

  it('rejects an out-of-range cron field with 400', async () => {
    const res = await putConfig({ principalUserId: 'u-ceo', scheduleCron: '99 * * * *' });
    expect(res.status).toBe(400);
  });

  it('accepts a valid cron with 200 and persists it', async () => {
    const res = await putConfig({ principalUserId: 'u-ceo', businessUnits: ['TX'], scheduleCron: '0 6 * * 2', scheduleTimezone: 'America/Chicago' });
    expect(res.status).toBe(200);
    const body = await res.json() as { config?: { scheduleCron?: string } };
    expect(body.config?.scheduleCron).toBe('0 6 * * 2');
  });

  it('accepts an absent cron (schedule simply not configured) with 200', async () => {
    const res = await putConfig({ principalUserId: 'u-ceo', businessUnits: ['TX'] });
    expect(res.status).toBe(200);
  });
});
