/**
 * ADR 0318 — heartbeat admin settings routes: the superadmin gate is fail-closed
 * (deny an authenticated non-superadmin), the wildcard bearer is allowed, and a
 * PUT round-trips (valid body persists + resolves the effective state; an invalid
 * body is a 422). Route-level because the gate + validation are only observable
 * through the HTTP boundary (grade-code Testability).
 *
 * Every case starts from NO saved row (the singleton `hostext:heartbeat-admin:default`
 * is deleted in beforeEach), so the "defaults" case does not depend on running
 * before the PUT case.
 *
 * Tracker TST-DFB-1. Red when (w71g1, witnessed): `requireSuperadmin` is dropped from
 * the GET or the PUT; the PUT stops persisting; the 1-minute cadence floor is dropped;
 * the view reports `overridden` without a saved row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HeartbeatAdminView } from '../src/features/heartbeat-admin/types.js';

interface ErrorBody { error: string; message: string }

describe('heartbeat-admin settings routes (ADR 0318)', () => {
  let server: http.Server;
  let BASE: string;
  let storage: Storage;
  const PATH = '/host/openwop-app/heartbeat/settings';
  const ROW_KEY = 'hostext:heartbeat-admin:default';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage as Storage;
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });
  beforeEach(async () => {
    await storage.kvDelete(ROW_KEY);
    expect(await storage.kvGet(ROW_KEY)).toBeNull();
  });

  const admin = { authorization: 'Bearer dev-token' };

  it('GET denies an authenticated non-superadmin (anon session) — 403', async () => {
    const res = await fetch(`${BASE}${PATH}`); // no bearer ⇒ anon cookie session
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe('forbidden');
    expect(body.message).toContain('requires a superadmin principal');
  });

  it('PUT denies an authenticated non-superadmin — 403 (fail-closed on the mutation)', async () => {
    const res = await fetch(`${BASE}${PATH}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'on', hostDefaultIntervalMs: 600_000 }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe('forbidden');
    expect(body.message).toContain('requires a superadmin principal');
    expect(await storage.kvGet(ROW_KEY)).toBeNull(); // nothing written
  });

  it('GET allows the wildcard bearer and defaults to off/not-overridden', async () => {
    const res = await fetch(`${BASE}${PATH}`, { headers: admin });
    expect(res.status).toBe(200);
    const view = (await res.json()) as HeartbeatAdminView;
    expect(view.overridden).toBe(false);
    expect(view.effective.status).toBe('off');
  });

  it('PUT (superadmin) with a valid body persists + round-trips the effective state', async () => {
    const put = await fetch(`${BASE}${PATH}`, {
      method: 'PUT',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'on', hostDefaultIntervalMs: 900_000, enabledUntil: null, runBudgetPerHour: 30 }),
    });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as HeartbeatAdminView;
    expect(saved.overridden).toBe(true);
    expect(saved.config.status).toBe('on');
    expect(saved.config.hostDefaultIntervalMs).toBe(900_000);
    expect(saved.effective.status).toBe('on');

    // A fresh GET reflects the persisted row.
    const get = (await (await fetch(`${BASE}${PATH}`, { headers: admin })).json()) as HeartbeatAdminView;
    expect(get.overridden).toBe(true);
    expect(get.config.hostDefaultIntervalMs).toBe(900_000);
    expect(get.config.runBudgetPerHour).toBe(30);
  });

  it('PUT (superadmin) with an out-of-bounds cadence is a 422', async () => {
    const res = await fetch(`${BASE}${PATH}`, {
      method: 'PUT',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'on', hostDefaultIntervalMs: 59_999 }), // one under the 1-min floor
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe('validation_error');
    expect(body.message).toContain('hostDefaultIntervalMs');
    expect(await storage.kvGet(ROW_KEY)).toBeNull();
  });
});
