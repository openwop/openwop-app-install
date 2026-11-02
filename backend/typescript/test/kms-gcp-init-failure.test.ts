/**
 * A Google Cloud KMS client that cannot get credentials must fail the CALL, not
 * the PROCESS. The generated gax methods do `this.initialize().catch(err => {
 * throw err; })`, which mints an unhandled rejection whenever initialize fails —
 * and the host's unhandledRejection policy is drain-and-exit. MEASURED
 * 2026-09-26: one POST /webhooks on a host with no GCP identity took it down.
 * This double reproduces that exact gax shape.
 *
 * TST-DKB-3 (grade-tests wave 72; incident 2026-09-26, fix 229d0fcae). Red when:
 * `initialize()` is not awaited inside the client chain, so the gax re-throw is
 * an unhandled rejection (w72 probe gi-await), or a failed init is cached and
 * never retried (gi-reset). Waits are macrotask drains rather than timed sleeps: an
 * unhandledRejection is emitted after the microtask queue empties.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Let any stray rejection reach `unhandledRejection` (it fires after microtasks drain). */
const drain = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

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
      await drain(); // let any stray rejection surface
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a failed initialization is retried on the next call, not cached forever', async () => {
    const kms = createGoogleCloudKmsClient('projects/p/locations/l/keyRings/r/cryptoKeys/k');
    await expect(kms.encrypt(Buffer.alloc(32))).rejects.toThrow();
    await drain();
    await expect(kms.encrypt(Buffer.alloc(32))).rejects.toThrow();
    expect(initCalls).toBe(2);
  });
});
