/**
 * P2-APP — host-sample conformance seam adapters (RFC 0099 §F + RFC 0100 §2/§4).
 *
 * The `@openwop/openwop-conformance` 1.25.0 behavioral legs drive four
 * `/host/openwop-app/*` seams that adapt the real ingestion / durable-task
 * services for black-box verification. These tests pin the seam contracts the
 * conformance asserts (so a regression fails here, not silently soft-skips in
 * the suite), and prove the seams drive the REAL services — not a parallel
 * demonstrator:
 *
 *   - `POST /host/openwop-app/trigger-bridge/ingest` — registers an ephemeral
 *     subscription + runs the real `ingestExternalEvent`, then surfaces the
 *     in-run `TriggerEvent` + the content-free `trigger.delivery.attempted`.
 *     SSRF-drop (§F.4) + Authorization-header-strip (§F.1).
 *   - `POST /host/openwop-app/a2a/tasks/start` — starts a real approval-gated run
 *     and persists its durable Task projection (taskId == runId).
 *   - `GET  /host/openwop-app/a2a/tasks/{id}` — reads the persisted A2ATaskState.
 *   - `POST /host/openwop-app/a2a/tasks/push-config` — RFC 0093 egress-guard a
 *     caller push URL (a2a-push-egress-ssrf).
 *
 * The trigger-ingestion SSRF drop is a LAYERED guard in `resolveAttachment`
 * (`host/triggerIngestionService.ts`): the denied-host check, then https-only, then the
 * pinned-resolution egress dispatcher. The `http://169.254.169.254` fixture is refused
 * by the first two, so the host check is not individually witnessed here, on purpose:
 * an https link-local fixture would let a sabotaged guard attempt a real egress.
 *
 * Tracker TST-DFC-1. Red when (w71g1, witnessed): credential headers pass into the
 * in-run envelope; tasks/get misreports the projection; the push-config egress guard
 * is dropped (asserted as the exact 400 `a2a_push_egress_denied`, which a fallthrough
 * 404 cannot satisfy); push-config on an absent task stops 404ing; the durable-tasks
 * flag gate is dropped (asserted by its own message, not the lookup's 404).
 *
 * @see docs/adr/0034-external-event-trigger-ingestion-host.md
 * @see docs/adr/0035-async-durable-a2a-tasks-host.md
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TRIGGER_INGESTION_ENABLED = 'true';
  process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
  process.env.OPENWOP_A2A_DURABLE_TASKS = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TRIGGER_INGESTION_ENABLED;
  delete process.env.OPENWOP_A2A_SERVER_ENABLED;
  delete process.env.OPENWOP_A2A_DURABLE_TASKS;
});

const post = (path: string, body: unknown) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
const get = (path: string) => fetch(`${BASE}${path}`, { headers: H });
interface ErrorBody { error: string; message: string }

describe('RFC 0099 §F — host-sample trigger ingest seam', () => {
  it('drops an attachment whose resolution hits a private/metadata address (trigger-ingestion-ssrf)', async () => {
    const res = await post('/host/openwop-app/trigger-bridge/ingest', {
      source: 'email',
      verification: { mode: 'none' },
      attachmentUrl: 'http://169.254.169.254/latest/meta-data/',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      triggerEvent?: { email?: { attachments?: unknown[] } };
      ssrfRefused?: boolean;
    };
    // The conformance accepts EITHER signal — assert both hold here.
    expect(body.ssrfRefused).toBe(true);
    expect((body.triggerEvent?.email?.attachments ?? []).length).toBe(0);
  });

  it('strips a credential-bearing webhook header and keeps the durable event content-free (trigger-ingestion-content-redaction)', async () => {
    const res = await post('/host/openwop-app/trigger-bridge/ingest', {
      source: 'webhook',
      verification: { mode: 'none' },
      webhook: { method: 'POST', headers: { Authorization: 'Bearer canary', 'X-Event-Type': 'issue.created' }, body: { x: 1 } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deliveryEvent?: Record<string, unknown>;
      triggerEvent?: { webhook?: { headers?: Record<string, string> } };
    };
    // The durable trigger.delivery.attempted carries no inbound content.
    const evtJson = JSON.stringify(body.deliveryEvent ?? {});
    expect(evtJson.includes('Bearer canary')).toBe(false);
    expect(evtJson.includes('Authorization')).toBe(false);
    expect(Object.keys(body.deliveryEvent ?? {}).sort()).toEqual(
      ['attempt', 'dedupKey', 'outcome', 'runId', 'subscriptionId'].sort(),
    );
    // The in-run envelope's curated headers drop Authorization, keep the allowlisted one.
    const headers = body.triggerEvent?.webhook?.headers ?? {};
    expect(Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')).toBe(false);
    expect(headers['X-Event-Type']).toBe('issue.created');
  });
});

describe('RFC 0100 §2/§4 — host-sample durable A2A task seams', () => {
  it('tasks/start binds taskId == runId and tasks/get returns a live input-required projection after disconnect', async () => {
    const start = await post('/host/openwop-app/a2a/tasks/start', { scenario: 'paused-at-approval' });
    expect(start.status).toBe(201);
    const taskId = ((await start.json()) as { taskId?: string }).taskId;
    expect(typeof taskId).toBe('string');

    const read = await get(`/host/openwop-app/a2a/tasks/${encodeURIComponent(taskId!)}`);
    expect(read.status).toBe(200);
    const rec = (await read.json()) as { state?: string; runId?: string; taskId?: string; interruptKind?: string };
    expect(rec.state).toBe('input-required');
    expect(rec.interruptKind).toBe('approval');
    expect(rec.runId).toBe(taskId);
    expect(rec.taskId).toBe(taskId);
  });

  it('tasks/get returns 404 for an unknown task', async () => {
    const read = await get('/host/openwop-app/a2a/tasks/run_does_not_exist');
    expect(read.status).toBe(404);
    expect((await read.json()) as ErrorBody).toMatchObject({ error: 'not_found', message: 'durable task not found' });
  });

  it('push-config refuses a private/loopback push URL before any push (a2a-push-egress-ssrf)', async () => {
    const res = await post('/host/openwop-app/a2a/tasks/push-config', { taskId: 'run_x', url: 'http://10.0.0.5/push' });
    // Exact: without the guard the request falls through to the task lookup and 404s,
    // which a "any 4xx" assertion used to accept.
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error).toBe('a2a_push_egress_denied');
  });

  it('push-config accepts a public https URL but 404s when the task does not exist', async () => {
    const res = await post('/host/openwop-app/a2a/tasks/push-config', {
      taskId: 'run_absent',
      url: 'https://caller.example.com/a2a/push',
    });
    expect(res.status).toBe(404); // URL passed the egress guard; the task lookup missed
    expect((await res.json()) as ErrorBody).toMatchObject({ error: 'not_found', message: 'durable task not found' });
  });
});

describe('seam gating — 404 when the capability flag is off', () => {
  it('a2a task seams 404 when durable tasks are disabled', async () => {
    delete process.env.OPENWOP_A2A_DURABLE_TASKS;
    try {
      const read = await get('/host/openwop-app/a2a/tasks/anything');
      expect(read.status).toBe(404);
      // The flag gate's own refusal — an unknown task also 404s, so the message decides.
      expect(((await read.json()) as ErrorBody).message).toContain('a2a durable tasks disabled');
    } finally {
      process.env.OPENWOP_A2A_DURABLE_TASKS = 'true';
    }
  });
});
