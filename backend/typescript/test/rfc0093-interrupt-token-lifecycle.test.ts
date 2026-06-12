/**
 * RFC 0093 §B — interrupt signed-token lifecycle.
 *
 *   §B.1 Expiry: tokens are minted with `expiresAt` (default 30 min via
 *        OPENWOP_INTERRUPT_TOKEN_TTL_SEC, capped at the interrupt's own
 *        `timeoutMs` deadline); past expiry both signed-token endpoints
 *        refuse with the canonical `410 interrupt_expired` envelope.
 *   §B.2 Invalidation: use after resolution keeps the existing
 *        `409 interrupt_already_resolved`; an unresolved token dies with
 *        its run (cancelled / completed / failed ⇒ 409).
 *
 * Drives the real express routes (`registerInterruptRoutes`) over an
 * in-memory storage backend, with interrupt rows inserted directly so the
 * lifecycle clock can be controlled.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend, getSuspendManager } from '../src/executor/suspendManager.js';
import { registerInterruptRoutes } from '../src/routes/interrupts.js';
import { errorEnvelopeMiddleware } from '../src/middleware/errorEnvelope.js';

let storage: Storage;
let server: http.Server;
let base = '';

beforeAll(async () => {
  storage = await openStorage('memory://');
  setEventLogBackend(storage);
  setSuspendBackend(storage);
  const app = express();
  app.use(express.json());
  registerInterruptRoutes(app, { storage });
  app.use(errorEnvelopeMiddleware());
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await storage.close();
});

afterEach(() => {
  delete process.env.OPENWOP_INTERRUPT_TOKEN_TTL_SEC;
});

let seq = 0;
async function seedRun(status: RunRecord['status']): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-tok-${++seq}`,
    workflowId: 'wf-token-lifecycle',
    tenantId: 'default',
    status,
    inputs: {},
    metadata: {},
    configurable: {},
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertRun(run);
  return run;
}

async function seedInterrupt(
  runId: string,
  over: Partial<InterruptRecord> = {},
): Promise<InterruptRecord> {
  const record: InterruptRecord = {
    interruptId: `int-tok-${++seq}`,
    runId,
    nodeId: 'gate',
    kind: 'clarification',
    token: `tok-${seq}-${Math.random().toString(36).slice(2)}`,
    data: { prompt: 'go?' },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  };
  await storage.insertInterrupt(record);
  return record;
}

async function jsonFetch(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('rfc0093 §B.1 — token expiry', () => {
  it('GET returns 410 interrupt_expired for a token past expiresAt', async () => {
    const run = await seedRun('waiting-input');
    const it_ = await seedInterrupt(run.runId, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const res = await jsonFetch(`/v1/interrupts/${encodeURIComponent(it_.token)}`);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('interrupt_expired');
  });

  it('POST returns 410 interrupt_expired for a token past expiresAt', async () => {
    const run = await seedRun('waiting-input');
    const it_ = await seedInterrupt(run.runId, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const res = await jsonFetch(`/v1/interrupts/${encodeURIComponent(it_.token)}`, {
      method: 'POST',
      body: JSON.stringify({ resumeValue: { answer: 'late' } }),
    });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('interrupt_expired');
  });

  it('an unexpired token inspects fine and reports its expiresAt', async () => {
    const run = await seedRun('waiting-input');
    const it_ = await seedInterrupt(run.runId);
    const res = await jsonFetch(`/v1/interrupts/${encodeURIComponent(it_.token)}`);
    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBe(it_.expiresAt);
    expect(res.body.resolved).toBe(false);
  });

  it('pre-migration rows (no expiresAt) are treated as non-expiring', async () => {
    const run = await seedRun('waiting-input');
    const it_ = await seedInterrupt(run.runId, { expiresAt: undefined });
    const res = await jsonFetch(`/v1/interrupts/${encodeURIComponent(it_.token)}`);
    expect(res.status).toBe(200);
  });
});

describe('rfc0093 §B.1 — minting (suspendManager)', () => {
  it('mints expiresAt ≈ now + 30 min by default', async () => {
    const run = await seedRun('running');
    const before = Date.now();
    const rec = await getSuspendManager().createInterrupt({
      runId: run.runId,
      nodeId: 'gate',
      kind: 'clarification',
      data: { prompt: 'q' },
    });
    expect(rec.expiresAt).toBeTruthy();
    const expires = Date.parse(rec.expiresAt!);
    expect(expires).toBeGreaterThanOrEqual(before + 29 * 60_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 31 * 60_000);
    // ≥256-bit opaque random token, as before.
    expect(rec.token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
  });

  it('honors OPENWOP_INTERRUPT_TOKEN_TTL_SEC', async () => {
    process.env.OPENWOP_INTERRUPT_TOKEN_TTL_SEC = '60';
    const run = await seedRun('running');
    const before = Date.now();
    const rec = await getSuspendManager().createInterrupt({
      runId: run.runId,
      nodeId: 'gate',
      kind: 'clarification',
      data: {},
    });
    const expires = Date.parse(rec.expiresAt!);
    expect(expires).toBeGreaterThanOrEqual(before + 55_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 65_000);
  });

  it('caps the token lifetime at the interrupt own timeoutMs deadline', async () => {
    const run = await seedRun('running');
    const before = Date.now();
    const rec = await getSuspendManager().createInterrupt({
      runId: run.runId,
      nodeId: 'gate',
      kind: 'approval',
      data: { timeoutMs: 5_000 }, // far below the 30-min default
    });
    const expires = Date.parse(rec.expiresAt!);
    expect(expires).toBeLessThanOrEqual(Date.now() + 5_500);
    expect(expires).toBeGreaterThanOrEqual(before + 4_000);
  });
});

describe('rfc0093 §B.2 — invalidation', () => {
  it('use after resolution keeps returning 409 interrupt_already_resolved', async () => {
    // Run is NON-terminal so the 409 is attributable to resolution alone.
    const run = await seedRun('waiting-input');
    const it_ = await seedInterrupt(run.runId);
    await storage.resolveInterrupt(it_.interruptId, { ok: true }, new Date().toISOString());
    const res = await jsonFetch(`/v1/interrupts/${encodeURIComponent(it_.token)}`, {
      method: 'POST',
      body: JSON.stringify({ resumeValue: { again: true } }),
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('interrupt_already_resolved');
  });

  it.each(['cancelled', 'completed', 'failed'] as const)(
    'an UNRESOLVED token is refused with 409 once the owning run is %s',
    async (status) => {
      const run = await seedRun(status);
      const it_ = await seedInterrupt(run.runId);
      const post = await jsonFetch(`/v1/interrupts/${encodeURIComponent(it_.token)}`, {
        method: 'POST',
        body: JSON.stringify({ resumeValue: { answer: 'too-late' } }),
      });
      expect(post.status).toBe(409);
      expect(post.body.error).toBe('interrupt_already_resolved');
      const get = await jsonFetch(`/v1/interrupts/${encodeURIComponent(it_.token)}`);
      expect(get.status).toBe(409);
      expect(get.body.error).toBe('interrupt_already_resolved');
    },
  );

  it('a resolved interrupt stays inspectable (resolved: true) — the 409 belongs to resolve', async () => {
    const run = await seedRun('completed');
    const it_ = await seedInterrupt(run.runId);
    await storage.resolveInterrupt(it_.interruptId, { ok: true }, new Date().toISOString());
    const res = await jsonFetch(`/v1/interrupts/${encodeURIComponent(it_.token)}`);
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(true);
  });

  it('an unknown token stays 404 invalid_interrupt_token', async () => {
    const res = await jsonFetch(`/v1/interrupts/tok_does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invalid_interrupt_token');
  });
});
