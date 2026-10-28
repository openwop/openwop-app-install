/**
 * MG-6 cutover gate (Workforce EP1; `routes/workforces.ts` PATCH
 * /host/openwop-app/workforces/:id) — status transitions, with the production gate
 * (the workforce must have GRADUATED to bounded-autonomous, `currentTier === 'auto'`,
 * before it may cut over) and an always-available rollback.
 *
 * What breaks it: a production cutover without graduation evidence (409
 * `cutover_not_eligible`), a gate that refuses even a graduated workforce (the
 * positive control below — without it a gate that ALWAYS refuses passed; probe
 * `8fw5g4-wfc-gate-always`), a transition that answers 200 but does not persist
 * (read back with GET), or an unknown status accepted (400 `validation_error`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { clearWorkforceHistory, seedWorkforceEntities, seedWorkforceHistory } from '../src/host/workforceService.js';
import type { Storage } from '../src/storage/storage.js';

const HERO = 'workforce.finance.invoice-exception';
/** The tenant the `dev-token` bearer acts in. */
const TENANT = 'default';
/** A fixed seed clock: the history generator never reads the wall clock itself. */
const SEED_NOW_MS = 1_700_000_000_000;
/** Runs per workforce that still graduate HERO to `auto` (the seed spans six weeks). */
const GRADUATING_RUNS = 100;

interface WorkforceBody { workforceId: string; status: string; etag: string }
interface ErrorBody { error: string; message: string; details?: Record<string, unknown> }

describe('workforce cutover gate', () => {
  let server: http.Server;
  let BASE: string;
  let storage: Storage;

  beforeAll(async () => {
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({
      port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
    });
    storage = app.locals.storage as Storage;
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    // Seed the entity only (no run history → not graduated → production gated).
    await seedWorkforceEntities();
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  const url = (): string => `${BASE}/host/openwop-app/workforces/${encodeURIComponent(HERO)}`;
  const patch = async <T,>(status: string): Promise<{ status: number; body: T }> => {
    const r = await fetch(url(), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
      body: JSON.stringify({ status }),
    });
    return { status: r.status, body: (await r.json()) as T };
  };
  const readBack = async (): Promise<WorkforceBody> => {
    const r = await fetch(url(), { headers: { authorization: 'Bearer dev-token' } });
    expect(r.status).toBe(200);
    return (await r.json()) as WorkforceBody;
  };

  // Every case starts from `shadow` with no history, whatever ran before it.
  beforeEach(async () => {
    await clearWorkforceHistory(storage, TENANT);
    const reset = await patch<WorkforceBody>('shadow');
    expect(reset.status).toBe(200);
  });

  it('allows ungated forward/rollback transitions (shadow ↔ piloting)', async () => {
    const r = await patch<WorkforceBody>('piloting');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('piloting');
    expect((await readBack()).status, 'the forward transition persisted').toBe('piloting');
    const back = await patch<WorkforceBody>('shadow'); // rollback always allowed
    expect(back.status).toBe(200);
    expect(back.body.status).toBe('shadow');
    expect((await readBack()).status, 'the rollback persisted').toBe('shadow');
  });

  it('gates production on graduation — 409 when the agent has no graduation evidence', async () => {
    const r = await patch<ErrorBody>('production');
    expect(r.status).toBe(409);
    expect(r.body.details?.reason).toBe('cutover_not_eligible');
    expect((await readBack()).status, 'a refused cutover leaves the status alone').toBe('shadow');

    // Positive control: with graduation evidence (GRADUATING_RUNS seeded runs graduate HERO to
    // `auto`; measured in grade-tests wave 64 — `workforce-service.test.ts` pins the
    // 300-run timeline) the SAME request is allowed.
    await seedWorkforceHistory(storage, TENANT, { nowMs: SEED_NOW_MS, runCount: GRADUATING_RUNS });
    try {
      const ok = await patch<WorkforceBody>('production');
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('production');
      expect((await readBack()).status).toBe('production');
    } finally {
      await clearWorkforceHistory(storage, TENANT);
    }
  });

  it('rejects an unknown status with 400', async () => {
    const r = await patch<ErrorBody>('live');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
    expect(r.body.details).toEqual({ field: 'status' });
    expect((await readBack()).status).toBe('shadow');
  });
});
