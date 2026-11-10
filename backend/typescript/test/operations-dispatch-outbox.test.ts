/**
 * ADR 0551 P2 — the dispatch-outbox operator surface, ROUTE-level.
 *
 * Route-level by necessity: the superadmin gate, the required reason and the
 * audit write are observable only through the HTTP boundary. The CAS itself is
 * proven at the storage layer (`dispatch-outbox-observability.test.ts`); what is
 * proven here is that the surface is not reachable by the wrong caller and that
 * a redrive cannot happen without a recorded reason.
 *
 * The states asserted are deliberately distinct, for the same reason the
 * attestation projection's are: "no dead intent" and "already redriven" answer
 * the same 404, and neither is a 500. A queue console that reports an
 * infrastructure error when a peer simply got there first teaches operators to
 * retry through a failure that is not one.
 *
 * Sabotage (witnessed, w80 round 1): dropping either `requireSuperadmin`, the
 * reason check or its `.trim()`, the reason on the row, the audit action, the
 * 404 branch, the CAS's `status = 'dead'`, the attempts reset, `perInstance:
 * false`, the dead count or the projection's key set each reds its case.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const SUPER_TENANT = 'org:test-outbox-super';
const OPS = '/host/openwop-app/operations';

let BASE: string;
let server: http.Server;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SUPERADMIN_TENANTS = SUPER_TENANT;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 60_000);

afterAll(async () => {
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T> { status: number; body: T }
/** The refusal envelope (`middleware/errorEnvelope.ts`). */
interface ErrorBody { error: string; message: string }
interface DeadRow { runId: string; tenantId: string; workflowId: string; attempts: number; lastError: string | null; createdAt: string; updatedAt: string }
interface SummaryBody {
  counts: { pending: number; dead: number };
  oldestPendingCreatedAt: string | null;
  oldestPendingAgeS: number | null;
  dead: DeadRow[];
  deadSample: { limit: number; truncated: boolean };
  perInstance: boolean;
}
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
  };
}

let n = 0;
async function login(tenantId: string) {
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: `outbox-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return c;
}

function run(runId: string): RunRecord {
  const iso = new Date().toISOString();
  return { runId, workflowId: 'wf-ops', tenantId: 't-ops', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: iso, updatedAt: iso };
}

/** A dead intent, made through the SAME storage transition the sweeper uses at
 *  its attempt cap — not by writing the row by hand, which would prove nothing
 *  about the state the surface actually sees. */
async function deadIntent(runId: string): Promise<void> {
  await insertRunWithStartContext(storage, run(runId), { admission: { plan: 'exempt:test-fixture' }, enqueueDispatch: true });
  await storage.rescheduleDispatchOutbox(runId, Date.now(), true, 'workflow not found: wf-ops');
  expect((await storage.getDispatchOutbox(runId))?.status).toBe('dead');
}

describe('ADR 0551 P2 — the gate', () => {
  it('a plain tenant admin can neither read the queue nor redrive it', async () => {
    await deadIntent('gated');
    const c = await login('org:some-other-tenant');
    // `requireSuperadmin` answers 403 `forbidden` (host/superadmin.ts). The exact
    // code and message, so a different refusal (an unrelated 404) cannot pass.
    const r = await c.get<ErrorBody>(`${OPS}/dispatch-outbox/summary`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
    expect(r.body.message).toContain('requires a superadmin principal');
    const w = await c.post<ErrorBody>(`${OPS}/dispatch-outbox/gated/redrive`, { reason: 'let me in' });
    expect(w.status).toBe(403);
    expect(w.body.error).toBe('forbidden');
    expect(w.body.message).toContain('requires a superadmin principal');
    // The gate is FAIL-CLOSED, not cosmetic: the row is untouched.
    expect((await storage.getDispatchOutbox('gated'))?.status).toBe('dead');
  });
});

describe('ADR 0551 P2 — the summary projection', () => {
  it('reports whole-queue counts, the oldest age, and says it is fleet-wide', async () => {
    await deadIntent('summarised');
    await insertRunWithStartContext(storage, run('summary-pending'), { admission: { plan: 'exempt:test-fixture' }, enqueueDispatch: true });
    const c = await login(SUPER_TENANT);
    const r = await c.get<SummaryBody>(`${OPS}/dispatch-outbox/summary`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const stats = await storage.dispatchOutboxStats();
    expect(r.body.counts.dead).toBeGreaterThanOrEqual(1);
    // Whole-table numbers: exactly what the adapter aggregates.
    expect(r.body.counts).toEqual({ pending: stats.pending, dead: stats.dead });
    // The oldest age: a pending row exists, so both fields are real values.
    expect(typeof r.body.oldestPendingCreatedAt).toBe('string');
    expect(r.body.oldestPendingCreatedAt).toBe(stats.oldestPendingCreatedAt);
    expect(typeof r.body.oldestPendingAgeS).toBe('number');
    expect(r.body.oldestPendingAgeS).toBeGreaterThanOrEqual(0);
    // Unlike the DLQ and SSE reads on this hub, the outbox is a durable table —
    // so this is the one Operations panel whose numbers are a fleet aggregate,
    // and the response says so rather than leaving the console to assume.
    expect(r.body.perInstance).toBe(false);
    const row = r.body.dead.find((d) => d.runId === 'summarised');
    expect(row).toMatchObject({ workflowId: 'wf-ops', tenantId: 't-ops' });
    // The projection carries no payload and no credential — an outbox row has
    // neither, and `lastError` is written by this host.
    expect(Object.keys(row!).sort()).toEqual(
      ['attempts', 'createdAt', 'lastError', 'runId', 'tenantId', 'updatedAt', 'workflowId'],
    );
  });

  it('an empty queue reports zero — never an absent block the console would render as unknown', async () => {
    // The app's queue is shared with the other cases, so it is never empty here:
    // over HTTP, assert the block is the adapter's numbers and the sample says it
    // is not truncated…
    const c = await login(SUPER_TENANT);
    const r = await c.get<SummaryBody>(`${OPS}/dispatch-outbox/summary`);
    const stats = await storage.dispatchOutboxStats();
    expect(r.body.counts).toEqual({ pending: stats.pending, dead: stats.dead });
    expect(r.body.deadSample).toMatchObject({ truncated: false });
    // …and the zero half on a genuinely EMPTY queue, at the adapter the route reads.
    const fresh = await openStorage('memory://');
    try {
      expect(await fresh.dispatchOutboxStats()).toEqual({ pending: 0, dead: 0, oldestPendingCreatedAt: null });
    } finally { await fresh.close(); }
  });
});

describe('ADR 0551 P2 — redrive', () => {
  it('REQUIRES a reason', async () => {
    await deadIntent('needs-reason');
    const c = await login(SUPER_TENANT);
    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      const r = await c.post<ErrorBody>(`${OPS}/dispatch-outbox/needs-reason/redrive`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toBe('validation_error');
      expect(r.body.message).toContain('`reason` is required');
    }
    // Refused means REFUSED — a validation failure must not half-apply.
    expect((await storage.getDispatchOutbox('needs-reason'))?.status).toBe('dead');
  });

  it('re-queues the intent, records the reason on the row, and audits the actor', async () => {
    await deadIntent('redriven');
    const c = await login(SUPER_TENANT);
    const r = await c.post(`${OPS}/dispatch-outbox/redriven/redrive`, { reason: 'workflow restored after a bad deploy' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);

    const row = (await storage.getDispatchOutbox('redriven'))!;
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.lastError).toContain('workflow restored after a bad deploy');
    // The audit chain carries WHO; the row carries WHY. Both, because either
    // alone leaves an operator reconstructing the other from timestamps.
    const audit = await storage.listAudit({ actionPrefix: 'operations.dispatch-outbox.redrive', limit: 200 });
    const entry = audit.find((a) => a.resource === 'redriven');
    expect(entry, 'redrive must append an audit entry').toBeTruthy();
    expect(entry!.outcome).toBe('success');
  });

  it('a SECOND redrive 404s — the CAS makes the surface idempotent', async () => {
    await deadIntent('twice');
    const c = await login(SUPER_TENANT);
    expect((await c.post(`${OPS}/dispatch-outbox/twice/redrive`, { reason: 'first' })).status).toBe(202);
    const second = await c.post<ErrorBody>(`${OPS}/dispatch-outbox/twice/redrive`, { reason: 'second' });
    expect(second.status).toBe(404);
    expect(second.body.error).toBe('not_found');
    expect(second.body.message).toContain('No dead dispatch intent');
    // Crucially the row is NOT reset a second time: the first redrive's reason
    // survives, so the queue records the transition that actually happened.
    const row = (await storage.getDispatchOutbox('twice'))!;
    expect(row.lastError).toContain('first');
    expect(row.lastError).not.toContain('second');
  });

  it('cannot redrive a live pending intent', async () => {
    await insertRunWithStartContext(storage, run('still-pending'), { admission: { plan: 'exempt:test-fixture' }, enqueueDispatch: true });
    const c = await login(SUPER_TENANT);
    const r = await c.post<ErrorBody>(`${OPS}/dispatch-outbox/still-pending/redrive`, { reason: 'impatient' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
    expect(r.body.message).toContain('No dead dispatch intent');
    // Its attempt budget is untouched — a redrive of a row the worker is still
    // spending attempts on would silently extend that budget.
    expect((await storage.getDispatchOutbox('still-pending'))?.attempts).toBe(0);
  });
});
