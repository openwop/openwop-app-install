/**
 * Demo-deployment showcase fallback (GATED on OPENWOP_DEMO_MODE).
 *
 * In a demo deployment the read-only `__showcase__` tenant (seeded at boot via
 * seedShowcaseWorkforces) backs the workforce dashboards: a caller with no runs
 * of their own falls back to it, so an anonymous visitor sees populated
 * telemetry — tagged `source: 'showcase'` so the UI can badge it. On a clean /
 * white-label install (demo mode OFF — the default) there is NO fallback: an
 * empty tenant sees its own empty data (`source: 'tenant'`), so nothing
 * synthetic is ever shown as real.
 *
 * Covers host/workforceService.ts §seedShowcaseWorkforces + routes/workforces.ts
 * §dashboardRuns + host/demoMode.ts. (The boot-seed lives in index.ts `main()`,
 * which tests don't run, so we seed the showcase directly here.)
 */

import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { seedShowcaseWorkforces } from '../src/host/workforceService.js';

let server: http.Server;
let BASE: string;
const HERO = 'workforce.finance.invoice-exception';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  // Cookies ENABLED so a no-auth request mints a fresh anon tenant (the "visitor"
  // with zero runs of its own).
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  // Stand in for the server-only boot seed (index.ts `main()`).
  await seedShowcaseWorkforces(app.locals.storage as Storage, 1_750_000_000_000);
  await new Promise<void>((res) => {
    server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterEach(() => {
  delete process.env.OPENWOP_DEMO_MODE;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

describe('workforce dashboards — showcase fallback (demo-mode gated)', () => {
  it('demo mode ON: a fresh tenant falls back to __showcase__, tagged source=showcase', async () => {
    process.env.OPENWOP_DEMO_MODE = 'true';
    const visitor = await fetch(`${BASE}/v1/host/openwop-app/workforces/${HERO}/metrics`);
    expect(visitor.status).toBe(200);
    const body = (await visitor.json()) as { totalRuns: number; source: string };
    expect(body.totalRuns).toBe(300); // fallback populated it
    expect(body.source).toBe('showcase'); // ...and it's honestly tagged
  });

  it('demo mode OFF (default): a fresh tenant sees its own empty data, source=tenant', async () => {
    delete process.env.OPENWOP_DEMO_MODE;
    const visitor = await fetch(`${BASE}/v1/host/openwop-app/workforces/${HERO}/metrics`);
    expect(visitor.status).toBe(200);
    const body = (await visitor.json()) as { totalRuns: number; source: string };
    expect(body.totalRuns).toBe(0); // NO synthetic fallback on a clean install
    expect(body.source).toBe('tenant');
  });
});
