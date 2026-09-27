/**
 * RFC 0053 — run-level dead-letter sink.
 *
 * A run that dies terminally must land in a durable, inspectable sink
 * (`run.dead_lettered`) and stay FORK-ELIGIBLE, so a poisoned run can be
 * examined and replayed rather than logged and lost. The RFC is `Accepted`
 * with a live peer implementer; this suite is this host's witness.
 *
 * Three things are load-bearing and each is asserted rather than assumed:
 *
 *   1. ORDERING. `run.dead_lettered` precedes `run.failed`.
 *      `observability.md` §"Terminal events" requires the terminal event to be
 *      LAST in the stream; appending the dead-letter row after it would break
 *      that contract (and `eventOrdering.test.ts`).
 *   2. REDACTION. `reason` is the classified user message, never the raw
 *      provider `error.message` — which the executor's own comments note can
 *      echo BYOK key material. RFC 0053 §C requires a redaction-safe reason.
 *   3. FORK-ELIGIBILITY (§C.2). Forking a dead-lettered run still works. The
 *      fork route gates on ownership, not status — incidental today, asserted
 *      here so it stays true.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';

let server: http.Server;
let BASE: string;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

/** A secret-shaped string the raw error carries and the dead-letter row must not. */
const LEAKY = 'sk-live-DEADBEEFdeadbeef0123456789';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });

  getNodeRegistry().register({
    typeId: 'test.always-fails',
    version: '1.0.0',
    async execute() {
      // The raw message carries key-shaped material, exactly like a provider
      // error that echoes the credential back.
      throw new Error(`upstream rejected the request (key ${LEAKY})`);
    },
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface Ev { type?: string; nodeId?: string; payload?: Record<string, unknown> }

async function failedRun(workflowId: string, nodeConfig: Record<string, unknown> = {}): Promise<{ runId: string; events: Ev[] }> {
  await api('/v1/host/openwop-app/workflows', {
    method: 'POST',
    body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'boom', typeId: 'test.always-fails', config: nodeConfig }], edges: [] }),
  });
  const create = await api<{ runId: string }>('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' }),
  });
  expect(create.status).toBe(201);
  const runId = create.body.runId;
  let status = 'pending';
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 25));
    status = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status;
    if (['completed', 'failed', 'cancelled'].includes(status)) break;
  }
  expect(status).toBe('failed');
  const events = (await api<{ events?: Ev[] }>(`/v1/runs/${runId}/debug-bundle`)).body.events ?? [];
  return { runId, events };
}

describe('RFC 0053 — a terminally-failed run is dead-lettered', () => {
  it('emits run.dead_lettered naming the failing node', async () => {
    const { runId, events } = await failedRun('rfc0053.basic');
    const dl = events.find((e) => e.type === 'run.dead_lettered');
    expect(dl, 'no run.dead_lettered event was emitted').toBeTruthy();
    expect(dl?.payload?.runId).toBe(runId);
    expect(dl?.payload?.nodeId).toBe('boom');
    expect(dl?.payload?.attempts).toBe(1); // no config.retry ⇒ one attempt
    expect(typeof dl?.payload?.reason).toBe('string');
  });

  it('appends it BEFORE run.failed — the terminal event stays last', async () => {
    const { events } = await failedRun('rfc0053.ordering');
    const iDead = events.findIndex((e) => e.type === 'run.dead_lettered');
    const iFailed = events.findIndex((e) => e.type === 'run.failed');
    expect(iDead).toBeGreaterThanOrEqual(0);
    expect(iFailed).toBeGreaterThanOrEqual(0);
    expect(iDead, 'run.dead_lettered must precede the terminal run.failed').toBeLessThan(iFailed);
    // And run.failed is genuinely the last event in the stream.
    expect(iFailed).toBe(events.length - 1);
  });

  it('reason is redaction-safe — never the raw provider message', async () => {
    const { events } = await failedRun('rfc0053.redaction');
    const dl = events.find((e) => e.type === 'run.dead_lettered');
    const reason = String(dl?.payload?.reason ?? '');
    // The load-bearing assertion: the key-shaped material in the thrown error
    // does not reach the dead-letter row.
    expect(reason).not.toContain(LEAKY);
    expect(reason).not.toContain('sk-live-');
  });

  it('counts real attempts when the node declares config.retry', async () => {
    const { events } = await failedRun('rfc0053.attempts', { retry: { maxAttempts: 3 } });
    const dl = events.find((e) => e.type === 'run.dead_lettered');
    // Three attempts were made and all failed — the row must say 3, not 1.
    expect(dl?.payload?.attempts).toBe(3);
    expect(events.filter((e) => e.type === 'node.failed' && e.nodeId === 'boom').length).toBe(3);
  });

  it('stays FORK-ELIGIBLE (§C.2) — a dead-lettered run can still be forked', async () => {
    const { runId } = await failedRun('rfc0053.forkable');
    const fork = await api<{ runId: string }>(`/v1/runs/${runId}:fork`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'replay' }),
    });
    // The whole point of the sink: inspect, fix the cause, re-run from here.
    expect(fork.status).toBe(201);
    expect(fork.body.runId).toBeTruthy();
  });
});

describe('RFC 0053 — the capability advert is honest', () => {
  // NOTE the wire location: RFC 0053 calls this `host.deadLetter`, but that is
  // the capability FAMILY name — `capabilities.schema.json` places both
  // `deadLetter` and `queueBus` as TOP-LEVEL capability properties. Asserting
  // against the schema's actual shape, not the RFC's prose shorthand.
  async function caps(): Promise<Record<string, unknown>> {
    const r = await api<{ capabilities?: Record<string, unknown> }>('/.well-known/openwop');
    return r.body.capabilities ?? {};
  }

  it('advertises deadLetter.supported, distinct from queueBus', async () => {
    const c = await caps();
    const dl = c['deadLetter'] as { supported?: boolean } | undefined;
    expect(dl?.supported).toBe(true);
    // Distinct surfaces — the RFC calls out this exact confusion. queueBus
    // dead-letters transport MESSAGES; this one dead-letters RUNS.
    const qb = c['queueBus'] as { deadLetterSupported?: boolean } | undefined;
    expect(qb?.deadLetterSupported).toBe(true);
    expect(dl).not.toBe(qb);
  });

  it('omits retentionDays when run retention is disabled — no fabricated deadline', async () => {
    // Run retention is operator opt-in (OPENWOP_RUN_RETENTION_DAYS) and off by
    // default in this suite, so nothing is ever purged. Advertising a number
    // would claim a purge deadline the host does not honor; the schema's
    // `minimum: 1` leaves omission as the only honest encoding.
    expect(process.env.OPENWOP_RUN_RETENTION_DAYS ?? '').toBe('');
    const dl = (await caps())['deadLetter'] as Record<string, unknown>;
    expect('retentionDays' in dl).toBe(false);
  });
});

describe('ADR 0531 + RFC 0053 — the dead-letter reason is intelligible, not "check the logs"', () => {
  it('classifies replay_source_missing instead of falling through to the generic arm', async () => {
    const { classifyDispatchError } = await import('../src/observability/errorRecovery.js');
    const { AiProviderError } = await import('../src/aiProviders/aiProvidersHost.js');
    // The executor wraps every terminal {code,message} into an AiProviderError
    // before classifying, so this is exactly the shape the seam produces.
    const c = classifyDispatchError(
      new AiProviderError('replay_source_missing' as never, 'a replay reached an unclassified effect'),
    );
    // The whole point: NOT the default arm. Three surfaces read this string —
    // the ErrorCard, the failure notification, and the RFC 0053 dead-letter row.
    expect(c.userMessage).not.toContain('Something went wrong');
    expect(c.userMessage.toLowerCase()).toContain('replay');
    // `abort`, not retry — retrying a replay reproduces the same refusal.
    expect(c.action).toBe('abort');
  });
});
