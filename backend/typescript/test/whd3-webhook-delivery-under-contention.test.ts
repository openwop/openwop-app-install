/**
 * WHD-3 — a REAL completed run's webhook lands inside the conformance window
 * while dead subscribers are holding the delivery queue.
 *
 * WHY THIS IS NOT `whd1-delivery-isolation` AGAIN. That test enters at the
 * queue: it hand-builds five `WebhookDeliveryRecord`s and times one
 * `processDueWebhookDeliveries` call. It proves the batch is concurrent. It
 * cannot prove a subscriber is served, because nothing in it subscribes, no run
 * runs, and no event fans out — and the defect WHD-1 closed was only ever
 * visible from that outer position: the suite's `webhook-signed-delivery`
 * registers a receiver, completes a run and waits 20 s, and on the deployed host
 * the first attempt arrived ~5.5 MINUTES later. Every layer was individually
 * correct. So this one goes in through the front door — `POST /v1/webhooks`,
 * `POST /v1/runs`, the event-log fan-out, the durable queue, and the polling
 * worker `main()` starts — and asserts on what the subscriber sees.
 *
 * IT MUST CREATE THE CONTENTION IT MEASURES. `adr0722-webhook-fanout-projected`
 * already enters at this level and would pass on the broken worker: one
 * subscriber on a fresh `memory://` queue has nothing to wait behind. Here four
 * subscribers point at an endpoint that ACCEPTS the connection and never
 * answers — the shape of a dead-but-routable receiver, which is what occupies a
 * worker for the full `DELIVERY_TIMEOUT_MS` (10 s). An unresolvable or refusing
 * host fails in milliseconds and contends with nothing.
 *
 * THE ASSERTION IS ORDER-INDEPENDENT, and it has to be. The claim is
 * `ORDER BY next_attempt_at ASC` and the fan-out stamps every row of one event
 * inside the same millisecond, so which row a sequential worker reaches first
 * is not something this test may assume. Two legs cover both orders:
 *   - the healthy delivery lands inside `LANDS_WITHIN_MS` — red when the healthy
 *     row is BEHIND a dead one (it would wait 10 s per dead row ahead of it);
 *   - when it lands, ALL the dead subscribers are in flight at once — red when
 *     the healthy row happened to go FIRST, because a sequential worker never
 *     has more than one request open. This leg is also the proof that the
 *     contention existed: without it, a fan-out that silently matched only the
 *     healthy subscriber would pass the first leg having measured nothing.
 *
 * FAST BY CONSTRUCTION, not by a seam. `DELIVERY_TIMEOUT_MS` is a module
 * constant with no override, and none was added: the test never waits a
 * timeout out. Green costs one poll interval; red costs `LANDS_WITHIN_MS`.
 * Teardown destroys the hung sockets so the in-flight batch settles at once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

import { createApp } from '../src/index.js';
import { startWebhookDeliveryWorker, type WebhookDeliveryWorker } from '../src/host/webhookDeliveryWorker.js';
import type { Storage } from '../src/storage/storage.js';

/** Dead subscribers. With the healthy one this is exactly `CLAIM_BATCH` (5), so
 *  all of them share ONE claimed batch — the unit WHD-1 was about. */
const DEAD_SUBSCRIBERS = 4;
/**
 * The bound on "run created → healthy subscriber holds the delivery".
 *
 * The conformance window is 20 s (`retryWaitMs` widens it to 90 s only when a
 * backoff policy is advertised, and this host advertises none). 5 s is a
 * quarter of that, and sits well clear of both outcomes it separates: the
 * concurrent worker is bounded by its 1 s poll interval, and a sequential one
 * needs at least one full `DELIVERY_TIMEOUT_MS` (10 s) per dead row ahead.
 */
const LANDS_WITHIN_MS = 5_000;
const CONFORMANCE_WINDOW_MS = 20_000;

const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };

interface Landed { readonly at: number; readonly headers: http.IncomingHttpHeaders; readonly body: string }

let app: Express;
let appServer: http.Server;
let base = '';
let worker: WebhookDeliveryWorker;

let healthyServer: http.Server;
let healthyUrl = '';
const landed: Landed[] = [];

let deadServer: http.Server;
let deadBase = '';
/** Requests the dead endpoint has accepted and is sitting on. Never answered. */
const heldOpen = new Set<http.ServerResponse>();
let deadAnswered = 0;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // Loopback receivers need the SAME relaxation at both layers — registration
  // (`assertEgressUrlAllowed`) and the delivery-time dispatcher. One flag, the
  // one every other real-network webhook test uses.
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';

  healthyServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      landed.push({ at: Date.now(), headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  healthyUrl = `http://127.0.0.1:${await listen(healthyServer)}/healthy`;

  deadServer = http.createServer((req, res) => {
    // Drain the body so the request is fully received, then say nothing, ever.
    req.resume();
    heldOpen.add(res);
    res.on('finish', () => { deadAnswered += 1; });
    res.on('close', () => heldOpen.delete(res));
  });
  deadBase = `http://127.0.0.1:${await listen(deadServer)}`;

  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  appServer = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  // `createApp` does not start the delivery worker — `main()` does, with this
  // exact call. Starting the REAL polling worker (rather than calling
  // `processDueWebhookDeliveries` once, as the queue-level tests do) keeps the
  // greedy drain loop and its one-batch-at-a-time guard inside the measurement.
  worker = startWebhookDeliveryWorker(app.locals['storage'] as Storage, 'whd3-worker');
}, 120_000); // a boot dies at the HOOK timeout, which --testTimeout does not raise

afterAll(async () => {
  worker.stop();
  // Stop LISTENING before destroying the held sockets: if a (sabotaged,
  // sequential) worker is still walking the batch, its next dead row must be
  // refused in a millisecond rather than accepted and held for another 10 s.
  const deadClosed = new Promise<void>((r) => deadServer.close(() => r()));
  deadServer.closeAllConnections();
  await deadClosed;
  await new Promise<void>((r) => healthyServer.close(() => r()));
  await new Promise<void>((r) => appServer.close(() => r()));
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
});

async function subscribe(url: string): Promise<string> {
  const res = await fetch(`${base}/v1/webhooks`, {
    method: 'POST',
    headers: { ...AUTH, 'OpenWOP-Version': '1.1' },
    body: JSON.stringify({ url, events: ['run.completed'] }),
  });
  const body = await res.json() as { subscriptionId?: string; subscription?: { subscriptionId?: string } };
  const id = body.subscriptionId ?? body.subscription?.subscriptionId;
  if (res.status !== 201 || !id) throw new Error(`subscribe(${url}) answered ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return id;
}

async function runToCompletion(): Promise<string> {
  const created = await fetch(`${base}/v1/runs`, { method: 'POST', headers: AUTH, body: JSON.stringify({ workflowId: 'conformance-noop' }) });
  const body = await created.json() as { runId?: string };
  if (created.status >= 300 || !body.runId) throw new Error(`POST /v1/runs answered ${created.status}: ${JSON.stringify(body).slice(0, 200)}`);
  let status = '';
  for (let i = 0; i < 200 && status !== 'completed'; i += 1) {
    const snap = await (await fetch(`${base}/v1/runs/${body.runId}`, { headers: AUTH })).json() as { status?: string };
    status = snap.status ?? '';
    if (status === 'failed' || status === 'cancelled') throw new Error(`the run ended ${status}, not completed — nothing downstream of it is meaningful`);
    if (status !== 'completed') await new Promise((r) => setTimeout(r, 25));
  }
  if (status !== 'completed') throw new Error(`the run never completed (last status "${status}")`);
  return body.runId;
}

describe('WHD-3 — webhook delivery for a real run, under real queue contention', () => {
  it('the healthy subscriber holds its delivery inside the window while every dead one is still in flight', async () => {
    const storage = app.locals['storage'] as Storage;
    // Dead subscribers FIRST, healthy LAST: insertion order is the likeliest
    // tiebreak for rows stamped in one millisecond, so this is the arrangement
    // most hostile to the healthy row. The test does not RELY on it — see the
    // in-flight leg — but there is no reason to hand a regression the easy order.
    const deadIds: string[] = [];
    for (let i = 0; i < DEAD_SUBSCRIBERS; i += 1) deadIds.push(await subscribe(`${deadBase}/dead/${i}`));
    const healthyId = await subscribe(healthyUrl);

    const startedAt = Date.now();
    const runId = await runToCompletion();
    const runTookMs = Date.now() - startedAt;

    const arrived = await until(() => landed.length > 0, LANDS_WITHIN_MS - runTookMs);
    const elapsedMs = (landed[0]?.at ?? Date.now()) - startedAt;
    expect(
      arrived,
      `no delivery reached the healthy subscriber within ${LANDS_WITHIN_MS}ms of creating the run (the run itself took ${runTookMs}ms; ` +
        `${heldOpen.size} dead subscriber(s) were holding a connection). The conformance window is ${CONFORMANCE_WINDOW_MS}ms and a ` +
        'sequential batch spends 10s on each dead row ahead of this one — a slow subscriber is delaying an unrelated one again (WHD-1).',
    ).toBe(true);
    expect(elapsedMs).toBeLessThan(LANDS_WITHIN_MS);

    // It is the REAL run's terminal event, signed — not some other delivery.
    const delivery = landed[0]!;
    const event = JSON.parse(delivery.body) as { type?: string; runId?: string };
    expect(event.type).toBe('run.completed');
    expect(event.runId).toBe(runId);
    expect(delivery.headers['x-openwop-signature'], 'a delivery without the signature is not the production path').toMatch(/^sha256=[0-9a-f]{64}$/);

    // THE CONTENTION LEG. A concurrent batch opens all five requests together,
    // so the dead ones are already in flight; the short wait only absorbs the
    // receiver-side scheduling of four accepts. A sequential worker never holds
    // more than ONE of them open, whatever order it walked the batch in.
    await until(() => heldOpen.size >= DEAD_SUBSCRIBERS, 1_000);
    expect(
      heldOpen.size,
      `only ${heldOpen.size} of ${DEAD_SUBSCRIBERS} dead subscribers were in flight when the healthy delivery landed. Either the batch is ` +
        'being walked one row at a time (the healthy row merely happened to go first), or the fan-out never matched the dead ' +
        'subscribers and this test measured an uncontended queue.',
    ).toBe(DEAD_SUBSCRIBERS);
    expect(deadAnswered, 'the dead endpoint must never have answered — otherwise it was not contention').toBe(0);

    // And the queue agrees with the wire: one row per subscriber, the healthy
    // one terminal, the dead ones still owed.
    const healthyRows = await storage.listWebhookDeliveries({ subscriptionIds: [healthyId], limit: 5 });
    expect(healthyRows.map((r) => r.status)).toEqual(['delivered']);
    const deadRows = await storage.listWebhookDeliveries({ subscriptionIds: deadIds, limit: 20 });
    expect(deadRows.map((r) => r.status)).toEqual(Array.from({ length: DEAD_SUBSCRIBERS }, () => 'pending'));

    // Recorded so a slow drift toward the bound is visible in the log long
    // before it becomes a red. `process.stdout` rather than `console`: vitest
    // swallows a passing test's console output, and a passing run is exactly
    // when this number is wanted.
    process.stdout.write(`[WHD-3] run ${runTookMs}ms; healthy delivery ${elapsedMs}ms after run creation; ${heldOpen.size} dead in flight\n`);
  }, 30_000);
});
