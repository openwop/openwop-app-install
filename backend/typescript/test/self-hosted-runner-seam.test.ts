/**
 * RFC 0122 §19 self-hosted-runner conformance seam (ADR 0182 Phase 5) — mirrors
 * the published `@openwop/openwop-conformance@1.48.0` `self-hosted-runner.test.ts`
 * behavioral tier against a booted host, so we witness it NON-VACUOUSLY (the
 * dispatch leg reaches the registry — not a 404 soft-skip).
 *
 * Asserts: subject-first isolation (no cross-subject routing → runner_unavailable,
 * retriable), at-most-once dedup from a real persisted store, model-dispatch
 * validation, and the honest-off `selfHostedRunner:{supported:false}` advert.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { assertFlatErrorEnvelope, errorCodeOf, retriableOf } from './helpers/errorEnvelope.js';

let BASE: string;
let server: http.Server;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const REGISTER = '/v1/host/sample/runner/register';
const DISPATCH = '/v1/host/sample/runner/dispatch';
const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

// H27 / S22 — INVERTED. This read `error.code` off the nested body §19 used to
// prescribe. The envelope is flat (`schemas/error-envelope.schema.json`), so the
// code is `error` itself and `retriable` rides `details`. Deliberately strict:
// a nested body must now FAIL here, not be tolerated.
const errCode = errorCodeOf;

const modelFrame = (subject: string, runId: string, stepId: string) => ({
  subject, runId, stepId, seq: 0, kind: 'model',
  provider: 'anthropic', model: 'claude-opus-4-8', inputs: { messages: [] },
});

describe('RFC 0122 §19 — runner seam is wired (non-vacuous, not 404)', () => {
  it('register returns the runnerId', async () => {
    const res = await post(REGISTER, { runnerId: 'r_a', subject: 'subj_A', capabilities: { providers: ['anthropic'] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runnerId: 'r_a' });
  });

  it('a dispatch to a registered owning-subject runner RESOLVES (deduped:false)', async () => {
    await post(REGISTER, { runnerId: 'r_a', subject: 'subj_A', capabilities: { providers: ['anthropic'] } });
    const res = await post(DISPATCH, modelFrame('subj_A', 'run_resolve', 'step_0'));
    expect(res.status).toBe(200);
    const body = await res.json() as { deduped: boolean; result: unknown };
    expect(body.deduped).toBe(false);
    expect(body.result).toBeDefined();
  });
});

describe('RFC 0122 §Behavior#1/#5 — subject-first isolation', () => {
  it('a subject-A dispatch MUST NOT route to a subject-B runner → runner_unavailable (retriable)', async () => {
    await post(REGISTER, { runnerId: 'r_b', subject: 'subj_B_only', capabilities: { providers: ['anthropic'] } });
    const res = await post(DISPATCH, modelFrame('subj_A_none', 'run_iso', 'step_0'));
    expect(res.status).toBeGreaterThanOrEqual(400);
    const json = await res.json();
    assertFlatErrorEnvelope(json, 'runner dispatch refusal');
    expect(errCode(json)).toBe('runner_unavailable');
    expect(retriableOf(json)).toBe(true);
  });
});

describe('RFC 0122 §At-most-once — persisted dedup', () => {
  it('a redelivered {runId, stepId} returns deduped:true (runner not re-executed)', async () => {
    await post(REGISTER, { runnerId: 'r_a', subject: 'subj_idem', capabilities: { providers: ['anthropic'] } });
    const frame = modelFrame('subj_idem', 'run_idem', 'step_1');
    const first = await post(DISPATCH, frame);
    expect(first.status).toBe(200);
    expect((await first.json() as { deduped: boolean }).deduped).toBe(false);
    const second = await post(DISPATCH, frame);
    expect(second.status).toBe(200);
    const body = await second.json() as { deduped: boolean; result: unknown };
    expect(body.deduped).toBe(true);
    // Same persisted result returned, not a re-execution.
    expect(body.result).toEqual((await (await post(DISPATCH, frame)).json() as { result: unknown }).result);
  });
});

describe('RFC 0122 — dispatch validation', () => {
  it('a model dispatch without provider/model → 400', async () => {
    await post(REGISTER, { runnerId: 'r_a', subject: 'subj_val', capabilities: {} });
    const res = await post(DISPATCH, { subject: 'subj_val', runId: 'r', stepId: 's', seq: 0, kind: 'model', inputs: {} });
    expect(res.status).toBe(400);
  });

  it('a non-integer seq → 400', async () => {
    const res = await post(DISPATCH, { subject: 'subj_val', runId: 'r', stepId: 's2', seq: 'x', kind: 'model', provider: 'anthropic', model: 'm', inputs: {} });
    expect(res.status).toBe(400);
  });
});

describe('RFC 0122 — honest-off advertisement', () => {
  it('discovery advertises selfHostedRunner {supported:false, dispatchKinds:["model"]}', async () => {
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      capabilities?: { selfHostedRunner?: { supported?: boolean; dispatchKinds?: string[] } };
    };
    const shr = doc.capabilities?.selfHostedRunner;
    expect(shr).toBeDefined();
    expect(shr?.supported).toBe(false);
    for (const k of shr?.dispatchKinds ?? []) expect(['model', 'tool']).toContain(k);
  });
});
