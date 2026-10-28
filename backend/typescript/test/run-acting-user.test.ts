/**
 * Acting-user provenance on runs (ADR 0024 §4 / D2 — the Connections-injection
 * prerequisite). Proves the run carries the authenticated human:
 *   1. POST /v1/runs stamps `metadata.actingUserId` from the principal.
 *   2. It is HOST-AUTHORITATIVE — a client-supplied metadata.actingUserId is
 *      overridden, never trusted (a caller MUST NOT name another user). This is
 *      the same override the :fork path applies to re-own a fork to the forking
 *      caller (confused-deputy guard).
 *   3. :fork re-stamps actingUserId to the FORKING caller. The source row is
 *      first re-stamped to another user, so a fork that merely COPIED the
 *      source's value would read 'someone-else' (round 1's symmetric fixture —
 *      source and fork by the same caller — made 8fw2g2-rau-fork VACUOUS).
 *
 * Breaks it: dropping the stamp in `host/runDispatch.ts` buildRunRecord
 * (8fw2g2-rau-stamp reds 1 + 2), or the fork copying `sourceRun.metadata`
 * without the `actingUserId: forkingUserId` override (8fw2g2-rau-fork-r2).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { bareRunId } from './support/bareRunId.js';

describe('run acting-user provenance (ADR 0024 §4 / D2)', () => {
  let server: http.Server;
  let storage: Storage;
  let BASE: string;
  const TOKEN = 'dev-token';
  const EXPECTED_ACTOR = `bearer:${TOKEN.slice(0, 8)}`; // auth.ts derives bearer:<8>
  let workflowId: string;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
    const disco = await jf<{ fixtures?: string[] }>('/.well-known/openwop');
    workflowId = disco.body.fixtures?.[0] ?? 'openwop-app.uppercase';
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  async function jf<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...((init.headers as Record<string, string>) ?? {}) },
    });
    const raw = res.status === 204 ? undefined : await res.json();
    return { status: res.status, body: raw as T };
  }

  const actingUserOf = async (runId: string): Promise<unknown> =>
    (await storage.getRun(bareRunId(runId)))?.metadata.actingUserId;

  it('stamps actingUserId from the authenticated principal on create', async () => {
    const created = await jf<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: {} }) });
    expect(created.status).toBe(201);
    expect(await actingUserOf(created.body.runId)).toBe(EXPECTED_ACTOR);
  });

  it('is host-authoritative — a client-supplied actingUserId is overridden, not trusted', async () => {
    const created = await jf<{ runId: string }>('/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId, inputs: {}, metadata: { actingUserId: 'spoofed-other-user', note: 'keep-me' } }),
    });
    expect(created.status).toBe(201);
    const meta = (await storage.getRun(bareRunId(created.body.runId)))?.metadata;
    expect(meta?.actingUserId).toBe(EXPECTED_ACTOR); // spoof rejected
    expect(meta?.note).toBe('keep-me'); // other client metadata preserved
  });

  it('re-stamps actingUserId on :fork (carries the human, never drops it)', async () => {
    const src = await jf<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: {} }) });
    expect(src.status).toBe(201);
    // Asymmetric fixture: the SOURCE now names another user, so only a re-stamp
    // (not a copy) yields the forking caller.
    await storage.mergeRunMetadata(bareRunId(src.body.runId), { actingUserId: 'someone-else' });
    expect(await actingUserOf(src.body.runId)).toBe('someone-else');
    const fork = await jf<{ runId: string }>(`/runs/${src.body.runId}:fork`, { method: 'POST', body: JSON.stringify({ fromSeq: 0, mode: 'replay' }) });
    expect(fork.status).toBe(201);
    expect(await actingUserOf(fork.body.runId)).toBe(EXPECTED_ACTOR);
  });
});
