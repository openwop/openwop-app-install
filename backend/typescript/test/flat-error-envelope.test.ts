/**
 * H27 / S22 — every host-emitted HTTP error body is the CANONICAL FLAT envelope.
 *
 *   { "error": "<code>", "message": "<human text>", "details"?: { … } }
 *
 * `schemas/error-envelope.schema.json` is authoritative: `error` is a code
 * STRING, `message` is REQUIRED, and `additionalProperties: false` means every
 * contextual fact — `retriable`, `retryAfter`, `protocol`, `field` — rides
 * `details`. Between 2026-06 and 2026-08 a NESTED `{ error: { code, message,
 * retriable } }` form drifted into ~88 inline `res.status(n).json(…)` sites in
 * this host, prescribed by four seam contracts and a few `rest-endpoints.md`
 * code-list entries that were themselves drift. S22 (openwop#1031) settled it
 * for the schema; this file is the host-side witness.
 *
 * WHY OVER HTTP rather than by unit-testing `sendError`. A unit test of the
 * helper proves the helper is flat, which was never in doubt — the bug was that
 * ~88 routes did not GO THROUGH a helper. So these legs boot the real app and
 * read real response bodies, which is the only observation that distinguishes
 * "the envelope is flat" from "one function that emits a flat envelope exists".
 *
 * The routes below are a deliberate cross-section of the converted surfaces
 * rather than all of them: a canonical endpoint (`/v1/runs` residency
 * admission), a spec-canonical `/v1/host/sample/*` seam (runner, workload
 * identity, memory compaction, anon surface), an app host-extension product
 * route (voice), and an interop refusal that carries `details.retriable` +
 * `details.protocol` (a2a / mcp). Whole-surface coverage is the ratchet's job
 * (`flat-error-envelope-ratchet.test.ts`), which is static and cannot be
 * out-run by a route this file forgot to name.
 *
 * @see spec/v1/rest-endpoints.md §"Error response shape"
 * @see schemas/error-envelope.schema.json
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { assertFlatErrorEnvelope, detailOf, errorCodeOf, retriableOf } from './helpers/errorEnvelope.js';

let BASE: string;
let server: http.Server;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'flat-error-envelope-secret-at-least-32-chars';
  // Each converted seam mounts behind its own env gate. They are set here so a
  // leg that 404s means "this route regressed", never "the seam was off" — an
  // unmounted route is asserted against explicitly below, because a 404 body is
  // itself a flat envelope and would otherwise pass vacuously.
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_TEST_TRIGGER_COMPACTION = 'true';
  process.env.OPENWOP_ANON_ACTOR_ENABLED = 'true';
  process.env.OPENWOP_I18N_DEFAULT_LOCALE = 'en';
  process.env.OPENWOP_I18N_LOCALES = 'en,pt-BR';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE = 'https://openwop.test/aud';
  process.env.OPENWOP_WORKLOAD_IDENTITY_ISSUER = 'https://openwop.test/iss';
  process.env.OPENWOP_WORKLOAD_IDENTITY_TRUST = JSON.stringify([
    { issuer: 'https://peer.test/iss', scheme: 'spiffe', issuerClass: 'spiffe', tenantId: 'tenant-a', scopes: ['runs:read'] },
  ]);
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
});
afterAll(async () => {
  for (const key of [
    'OPENWOP_TEST_SEAM_ENABLED',
    'OPENWOP_TEST_TRIGGER_COMPACTION',
    'OPENWOP_ANON_ACTOR_ENABLED',
    'OPENWOP_I18N_DEFAULT_LOCALE',
    'OPENWOP_I18N_LOCALES',
    'OPENWOP_MCP_SERVER_ENABLED',
    'OPENWOP_WEBHOOK_ALLOW_PRIVATE',
    'OPENWOP_WORKLOAD_IDENTITY_AUDIENCE',
    'OPENWOP_WORKLOAD_IDENTITY_ISSUER',
    'OPENWOP_WORKLOAD_IDENTITY_TRUST',
  ]) delete process.env[key];
  await new Promise<void>((res) => server.close(() => res()));
});

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

/** Every converted surface, driven to a REAL refusal. `expectCode` is asserted
 *  only where the code is deterministic; the envelope SHAPE is asserted for all. */
const REFUSALS: ReadonlyArray<{
  name: string;
  path: string;
  body: unknown;
  expectCode?: string;
}> = [
  {
    name: 'runner seam — dispatch validation (routes/runnerSeam.ts)',
    path: '/v1/host/sample/runner/dispatch',
    body: { subject: '', runId: '', stepId: '' },
    expectCode: 'validation_error',
  },
  {
    name: 'workload-identity seam — refusal (routes/workloadIdentitySeam.ts)',
    path: '/v1/host/sample/test/workload-identity/resolve',
    body: { identity: { scheme: 'spiffe', subject: 'spiffe://example/x', token: 'eyJhbGciOiJIUzI1NiJ9.a.b' } },
  },
  {
    name: 'memory-compaction seam — missing memoryRef (routes/memoryCompactionSeam.ts)',
    path: '/v1/test/memory/seed',
    body: {},
    expectCode: 'invalid_argument',
  },
  {
    name: 'test seam — prompt/compose missing templateId (routes/testSeam.ts)',
    path: '/v1/host/openwop-app/prompt/compose',
    body: {},
    expectCode: 'invalid_argument',
  },
  {
    name: 'agents — TTS missing text (routes/agents.ts)',
    path: '/v1/host/sample/ai/call-speech-synthesizer',
    body: { voiceId: 'v1' },
    expectCode: 'invalid_request',
  },
];

describe('H27 — converted routes emit the canonical FLAT error envelope', () => {
  for (const r of REFUSALS) {
    it(`${r.name} → flat { error, message, details? }`, async () => {
      const res = await post(r.path, r.body);
      // A 404 would mean the route is not mounted in this boot, which would make
      // the leg vacuous rather than passing.
      expect(res.status, `${r.path} is not mounted — this leg would prove nothing`).not.toBe(404);
      expect(res.status).toBeGreaterThanOrEqual(400);
      const env = assertFlatErrorEnvelope(res.body, r.path);
      expect(typeof env.error).toBe('string');
      expect(typeof env.message).toBe('string');
      // The precise regression: `error` must not be an object again.
      expect(typeof res.body === 'object' && res.body !== null && (res.body as { error: unknown }).error).not.toBeTypeOf('object');
      if (r.expectCode) expect(errorCodeOf(res.body)).toBe(r.expectCode);
    });
  }

  it('the anon-surface seam refuses flat, with a message (routes/anonSurfaceSeam.ts)', async () => {
    // Flag-off and unknown-surface both answer 404; either way the body is an
    // envelope, and `message` is REQUIRED — it used to be omitted entirely,
    // which is a schema violation as much as the nesting was.
    // The flag is ON in this boot ON PURPOSE: with it off, the request stops at
    // the flag-off refusal and never reaches the unknown-surface branch, so the
    // leg would pass while testing a different line. (Caught by sabotage S2 —
    // dropping `message` from the unknown-surface branch left this leg green.)
    const res = await post('/v1/host/sample/anon-surface/dispatch', { surface: 'no-such-surface', tool: 'x' });
    expect(res.status).toBe(404);
    const env = assertFlatErrorEnvelope(res.body, 'anon-surface dispatch');
    expect(env.error).toBe('not_found');
    expect(env.message.length).toBeGreaterThan(0);
  });

  it('an interop refusal puts `retriable` under `details`, never at top level and never inside `error`', async () => {
    const res = await post('/v1/host/sample/mcp/invoke', {
      serverUrl: 'http://127.0.0.1:1/never',
      requestVersion: '1999-01-01',
    });
    expect(res.status, 'the mcp-invoke seam is not mounted — leg would be vacuous').not.toBe(404);
    assertFlatErrorEnvelope(res.body, 'mcp interop refusal');
    expect(errorCodeOf(res.body)).toBe('interop_version_unsupported');
    expect(retriableOf(res.body)).toBe(false);
    expect(detailOf(res.body, 'protocol')).toBe('mcp');
    // The two places the drift used to put it.
    expect((res.body as Record<string, unknown>).retriable).toBeUndefined();
    expect((res.body as { error?: { retriable?: unknown } }).error?.retriable).toBeUndefined();
  });

  it('an INLINE refusal is localized on the same path a THROWN one is (ADR 0143)', async () => {
    // `sendError` reaches i18n through the SAME `emitEnvelope` the middleware
    // uses. Asserting it here rather than trusting the call graph: "shares the
    // localization path" is a claim, and a helper that quietly skipped it would
    // ship a Portuguese-speaking operator an English validation message with
    // every other envelope localized around it.
    const res = await fetch(`${BASE}/v1/host/sample/runner/dispatch`, {
      method: 'POST',
      headers: { ...H, 'accept-language': 'pt-BR' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { error?: string; message?: string; details?: { locale?: string } };
    expect(errorCodeOf(body)).toBe('validation_error'); // the CODE is never localized
    expect(body.message).toBe('O corpo da requisição é inválido.');
    expect(res.headers.get('content-language')).toBe('pt-BR');
    expect(body.details?.locale).toBe('pt-BR');
  });

  it('a THROWN OpenwopError and an INLINE refusal produce the same envelope shape', async () => {
    // The whole point of routing inline sites through `sendError`: there is ONE
    // shape, whichever path produced it. `/v1/runs` with no workflowId throws;
    // the runner seam answers inline.
    const thrown = await post('/v1/runs', {});
    const inline = await post('/v1/host/sample/runner/dispatch', {});
    expect(thrown.status).toBeGreaterThanOrEqual(400);
    expect(inline.status).toBeGreaterThanOrEqual(400);
    const a = assertFlatErrorEnvelope(thrown.body, 'thrown');
    const b = assertFlatErrorEnvelope(inline.body, 'inline');
    expect(Object.keys(a).sort().every((k) => ['error', 'message', 'details'].includes(k))).toBe(true);
    expect(Object.keys(b).sort().every((k) => ['error', 'message', 'details'].includes(k))).toBe(true);
  });
});
