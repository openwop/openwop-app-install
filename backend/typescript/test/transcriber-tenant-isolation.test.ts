/**
 * RFC 0106 §B / §F + RFC 0055 `media-asset-url-tenant-scoped` — `callTranscriber`
 * MUST bind a resolved `audio.url` media asset to the caller's tenant, so a leaked
 * (unguessable) capability token cannot let one tenant transcribe another's audio
 * and land the transcript on its own run log.
 *
 * Booted WITHOUT `OPENWOP_TEST_SEAM_ENABLED` on purpose: with the test seam on the
 * call-transcriber seam forces `provider:'mock'`, which short-circuits to the canned
 * turn BEFORE the url/tenant path — so the real-path tenant check only runs here.
 * The asset is stored under a foreign tenant; the request's tenant differs, so the
 * check throws `invalid_request` before any provider call (no transcript leaks).
 *
 * Wave 61: a 400 `invalid_request` is ALSO what the non-host-url and the
 * exactly-one refusals answer, so the foreign case now asserts the exact
 * not-found message, and a POSITIVE CONTROL stores an asset under the tenant the
 * request actually carries and gets a transcript back. `OPENWOP_VOICE_MOCK`
 * (set and restored here) makes `transcribeManaged` deterministic with no
 * provider key — it is NOT the seam flag, so the real url/tenant path still runs.
 * A `*` env key leaves `req.tenantId` unset (auth.ts, env-key lane), so the
 * route resolves the request's tenant as `default`.
 * This file is also the witness that agents.ts's own `STT_SAMPLE` route is
 * registered: with the seam off there is no LEGACY `/host/sample` rewrite
 * (see transcriber-seam.test.ts).
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { assertFlatErrorEnvelope, errorCodeOf } from './helpers/errorEnvelope.js';

let BASE: string;
// ADR 0900 D1: with the test seam off the seam admits only a CONFIGURED wildcard
// (`<key>:*`), never the public `dev-token:*` fallback, so this suite configures one.
const WILDCARD_KEY = 'seam-stt-wildcard-operator-key';
const H = { authorization: `Bearer ${WILDCARD_KEY}`, 'content-type': 'application/json' };
let server: http.Server;
let savedKeys: string | undefined;
let savedVoiceMock: string | undefined;
/** The tenant a `*` env-key request resolves to (`req.tenantId ?? 'default'`). */
const REQUEST_TENANT = 'default';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  savedKeys = process.env.OPENWOP_API_KEYS;
  process.env.OPENWOP_API_KEYS = `${WILDCARD_KEY}:*`;
  savedVoiceMock = process.env.OPENWOP_VOICE_MOCK;
  process.env.OPENWOP_VOICE_MOCK = 'true'; // deterministic transcribeManaged; NOT the seam flag
  delete process.env.OPENWOP_TEST_SEAM_ENABLED; // force the REAL url path, not the mock short-circuit
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  if (savedKeys === undefined) delete process.env.OPENWOP_API_KEYS; else process.env.OPENWOP_API_KEYS = savedKeys;
  if (savedVoiceMock === undefined) delete process.env.OPENWOP_VOICE_MOCK; else process.env.OPENWOP_VOICE_MOCK = savedVoiceMock;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
});

const SEAM = '/host/sample/ai/call-transcriber';
const post = (body: unknown) => fetch(`${BASE}${SEAM}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

describe('RFC 0055 media-asset-url-tenant-scoped — callTranscriber tenant binding', () => {
  it('rejects a foreign tenant\'s asset url (no cross-tenant transcript)', async () => {
    // Mint an asset OWNED BY a different tenant than the request will carry.
    const victim = await storeMediaAsset('tenant-victim-7f3a', {
      contentBase64: Buffer.from('not-real-audio').toString('base64'),
      contentType: 'audio/mpeg',
    });

    const res = await post({ audio: { url: victim.url } });
    // The tenant check throws before any provider call → 400 invalid_request, NOT a turn.
    expect(res.status).toBe(400);
    // H27 / S22 — INVERTED. This read `error.code`; the canonical envelope is
    // FLAT, so the code is `error` itself.
    const body = await res.json() as { finalText?: unknown; events?: unknown };
    const envelope = assertFlatErrorEnvelope(body, 'foreign-tenant transcriber refusal');
    // The TENANT refusal — not the non-host-url or exactly-one refusal, which
    // answer the same status and code.
    expect(envelope.message).toBe('Media asset not found for `audio.url`.');
    // ADR 0812 P3c-0 — the sample seam is a major-2 path: the host code travels
    // vendor-namespaced (`v2ErrorCode`). Same refusal, same 400.
    expect(errorCodeOf(body)).toBe('openwop-app.invalid_request');
    // Crucially: NO transcript / events leaked for the foreign asset.
    expect(body.finalText).toBeUndefined();
    expect(body.events).toBeUndefined();
  });

  it('transcribes the caller\'s OWN tenant\'s asset (positive control for the refusal above)', async () => {
    const own = await storeMediaAsset(REQUEST_TENANT, {
      contentBase64: Buffer.from('not-real-audio').toString('base64'),
      contentType: 'audio/mpeg',
    });
    const res = await post({ audio: { url: own.url } });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as { finalText?: unknown };
    // 'not-real-audio' is 14 bytes: the asset's bytes reached the transcriber.
    expect(body.finalText).toBe('live transcript (14 bytes)');
  });
});
