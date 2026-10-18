/**
 * A transient Cloud KMS gRPC failure must not answer an unhandled 500.
 *
 * MEASURED 2026-10-13 00:00:33Z on 00945-fgt: `POST /host/openwop-app/
 * trigger-ingest/{id}` returned 500 `unhandled error: 1 CANCELLED: CANCELLED`
 * (stack: key_management_service_client → google-gax) while opening the
 * subscription's sealed webhook secret, failing a certification cut that
 * passed minutes later on the same build. The fix: ONE in-process retry on
 * CANCELLED/UNAVAILABLE, then a retriable `503 service_unavailable` with
 * `Retry-After` (v2 errors.md). Any other KMS error passes through unchanged.
 *
 * The HTTP leg drives the real chain the ingest route uses —
 * `openWebhookSecret` → `kmsDecrypt` → the GCP client → `errorEnvelopeMiddleware`
 * — behind a mocked SDK that fails on a script.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const decryptFailures: unknown[] = [];
let decryptCalls = 0;
function grpcError(code: number, text: string): Error {
  return Object.assign(new Error(`${code} ${text}: ${text}`), { code });
}

vi.mock('@google-cloud/kms', () => ({
  KeyManagementServiceClient: class {
    async initialize(): Promise<void> {}
    // Identity "wrap": enough for a seal → open round-trip.
    async encrypt(req: { plaintext: Buffer }): Promise<unknown> { return [{ ciphertext: req.plaintext }]; }
    async decrypt(req: { ciphertext: Buffer }): Promise<unknown> {
      decryptCalls++;
      if (decryptFailures.length > 0) throw decryptFailures.shift();
      return [{ plaintext: req.ciphertext }];
    }
  },
}));

import { _resetKmsForTesting, configureKmsClient, createGoogleCloudKmsClient } from '../src/byok/kmsEncryption.js';
import { openWebhookSecret, sealWebhookSecret } from '../src/host/webhookSecretCodec.js';
import { errorEnvelopeMiddleware } from '../src/middleware/errorEnvelope.js';
import { OpenwopError } from '../src/types.js';

const KEY = 'projects/p/locations/l/keyRings/r/cryptoKeys/k';

async function sealed(): Promise<string> {
  configureKmsClient(createGoogleCloudKmsClient(KEY));
  return sealWebhookSecret('whsec_test-secret');
}

afterEach(() => {
  decryptFailures.length = 0;
  decryptCalls = 0;
  _resetKmsForTesting();
});

describe('GCP KMS transient failures', () => {
  it('retries ONCE on CANCELLED and succeeds', async () => {
    const stored = await sealed();
    decryptFailures.push(grpcError(1, 'CANCELLED'));
    await expect(openWebhookSecret(stored)).resolves.toBe('whsec_test-secret');
    expect(decryptCalls).toBe(2);
  });

  it('retries ONCE on UNAVAILABLE and succeeds', async () => {
    const stored = await sealed();
    decryptFailures.push(grpcError(14, 'UNAVAILABLE'));
    await expect(openWebhookSecret(stored)).resolves.toBe('whsec_test-secret');
    expect(decryptCalls).toBe(2);
  });

  it('a transient failure that survives the retry is a 503 service_unavailable, not a raw gRPC error', async () => {
    const stored = await sealed();
    decryptFailures.push(grpcError(1, 'CANCELLED'), grpcError(14, 'UNAVAILABLE'));
    const err = await openWebhookSecret(stored).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenwopError);
    expect(err).toMatchObject({ code: 'service_unavailable', httpStatus: 503, details: { retryAfterSeconds: 1 } });
    expect(decryptCalls).toBe(2); // one retry, never a loop
  });

  it('a non-transient error is NOT retried and passes through unchanged', async () => {
    const stored = await sealed();
    const denied = grpcError(7, 'PERMISSION_DENIED');
    decryptFailures.push(denied);
    await expect(openWebhookSecret(stored)).rejects.toBe(denied);
    expect(decryptCalls).toBe(1);
  });

  it('over HTTP: the error middleware answers 503 + Retry-After (was an unhandled 500)', async () => {
    const stored = await sealed();
    decryptFailures.push(grpcError(1, 'CANCELLED'), grpcError(1, 'CANCELLED'));
    const app = express();
    app.post('/ingest', async (_req, res, next) => {
      try { res.json({ secretLength: (await openWebhookSecret(stored)).length }); } catch (e) { next(e); }
    });
    app.use(errorEnvelopeMiddleware());
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/ingest`, { method: 'POST' });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      const body = await res.json() as { error: string; details?: { retryAfterSeconds?: number } };
      expect(body.error).toBe('service_unavailable');
      expect(body.details?.retryAfterSeconds).toBe(1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
