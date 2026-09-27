/**
 * A Google Cloud KMS client that cannot get credentials must fail the CALL, not
 * the PROCESS. The generated gax methods do `this.initialize().catch(err => {
 * throw err; })`, which mints an unhandled rejection whenever initialize fails —
 * and the host's unhandledRejection policy is drain-and-exit. MEASURED
 * 2026-09-26: one POST /webhooks on a host with no GCP identity took it down.
 * This double reproduces that exact gax shape.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

let initCalls = 0;
vi.mock('@google-cloud/kms', () => ({
  KeyManagementServiceClient: class {
    private stub: Promise<unknown> | undefined;
    initialize(): Promise<unknown> {
      initCalls++;
      if (!this.stub) this.stub = Promise.reject(new Error('Could not load the default credentials.'));
      return this.stub;
    }
    encrypt(): Promise<unknown> {
      // The generated-client shape, verbatim in spirit.
      this.initialize().catch((err) => { throw err; });
      return this.initialize().then(() => [{ ciphertext: Buffer.from('x') }]);
    }
    decrypt(): Promise<unknown> {
      this.initialize().catch((err) => { throw err; });
      return this.initialize().then(() => [{ plaintext: Buffer.from('x') }]);
    }
  },
}));

import { createGoogleCloudKmsClient } from '../src/byok/kmsEncryption.js';

afterEach(() => { initCalls = 0; });

describe('GCP KMS with no credentials', () => {
  it('encrypt() rejects to its caller and leaves NO unhandled rejection behind', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const kms = createGoogleCloudKmsClient('projects/p/locations/l/keyRings/r/cryptoKeys/k');
      await expect(kms.encrypt(Buffer.alloc(32))).rejects.toThrow(/default credentials/);
      await new Promise((r) => setTimeout(r, 50)); // let any stray rejection surface
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a failed initialization is retried on the next call, not cached forever', async () => {
    const kms = createGoogleCloudKmsClient('projects/p/locations/l/keyRings/r/cryptoKeys/k');
    await expect(kms.encrypt(Buffer.alloc(32))).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    await expect(kms.encrypt(Buffer.alloc(32))).rejects.toThrow();
    expect(initCalls).toBe(2);
  });
});
