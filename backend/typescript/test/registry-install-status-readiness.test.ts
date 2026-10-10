/**
 * NP-V2 P7 — boot-time registry install failures are COUNTED and reported on
 * /readiness (informational, never gating `ready`), so `verify-deploy.sh` can
 * refuse a revision that reports one. The 2026-09-20 refusals were survivable,
 * which is exactly why a warn line alone hid them for eight days.
 *
 * Mounts ONLY `registerHealthRoutes` on a bare express (the claim is the route's
 * report, not app wiring — no `createApp`). Managed providers are mocked to none
 * so a CLEAN host is `ready`: without that the test host is already `degraded`,
 * and "a failure does not gate `ready`" compared degraded to degraded — the
 * wave-10 probe that made registry failures gate `ready` stayed green.
 *
 * Sabotage witnesses: the status copy dropped → case 1 red; `registryPacks`
 * removed from /readiness, or failures not recorded → case 2 red; registry
 * failures folded into `ready` → case 2 red.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { registerHealthRoutes } from '../src/routes/health.js';
import {
  recordRegistryInstallFailure,
  recordRegistryInstallSuccess,
  registryInstallStatus,
  resetRegistryInstallStatus,
  setRegistryInstallAttempted,
} from '../src/host/registryInstallStatus.js';

// Hoisted above the imports by vitest.
vi.mock('../src/providers/managedProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/managedProvider.js')>()),
  getManagedProviderStatuses: async () => [],
}));

let server: http.Server;
let PORT: number;
const PREV_ENFORCE = process.env.OPENWOP_AUTH_ENFORCE_BEARER;

beforeAll(async () => {
  delete process.env.OPENWOP_AUTH_ENFORCE_BEARER; // apiKeyConfigError must not degrade the clean read
  const app = express();
  registerHealthRoutes(app);
  server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  PORT = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  if (PREV_ENFORCE === undefined) delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
  else process.env.OPENWOP_AUTH_ENFORCE_BEARER = PREV_ENFORCE;
});

interface ReadinessBody { status: string; checks: { registryPacks?: unknown } }

describe('NP-V2 P7 — registry install status', () => {
  it('counts attempts, successes and failures, and hands out a copy', () => {
    resetRegistryInstallStatus(0);
    setRegistryInstallAttempted(2);
    recordRegistryInstallSuccess();
    recordRegistryInstallFailure('core.openwop.workflows.x', '1.0.0', 'pinned', 'install_failed');
    const s = registryInstallStatus();
    expect(s).toMatchObject({ attempted: 2, installed: 1, failed: [{ name: 'core.openwop.workflows.x', version: '1.0.0', lane: 'pinned', code: 'install_failed' }], skipped: [] });
    s.failed.push({ name: 'tampered', version: '0', lane: 'pinned', code: 'install_failed' });
    expect(registryInstallStatus().failed).toHaveLength(1);
  });

  it('/readiness reports it under checks.registryPacks without gating `ready` on it', async () => {
    // Non-vacuity precondition: a clean host reads `ready` / 200, so a gate
    // added by the failure below would be visible.
    resetRegistryInstallStatus(0);
    const cleanRes = await fetch(`http://127.0.0.1:${PORT}/readiness`);
    const clean = (await cleanRes.json()) as ReadinessBody;
    expect(cleanRes.status).toBe(200);
    expect(clean.status).toBe('ready');

    setRegistryInstallAttempted(1);
    recordRegistryInstallFailure('core.openwop.workflows.x', '1.0.0', 'pinned', 'install_failed');
    const r = await fetch(`http://127.0.0.1:${PORT}/readiness`);
    const body = (await r.json()) as ReadinessBody;
    expect(body.checks.registryPacks).toMatchObject({ attempted: 1, installed: 0, failed: [{ name: 'core.openwop.workflows.x', version: '1.0.0', lane: 'pinned', code: 'install_failed' }], skipped: [] });
    // Informational: the vendored copy serves, so a failure alone is not "degraded".
    expect(r.status).toBe(200);
    expect(body.status).toBe('ready');
  });
});
