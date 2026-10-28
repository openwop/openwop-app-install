/**
 * Webhook HMAC secrets sealed at rest (`host/webhookSecretCodec.ts`; closes the
 * types.ts TODO — "use KMS in production"). KMS envelope when configured
 * (mandatory in the auth posture: the `index.ts` boot guard refuses `auth`
 * without it); legacy/dev plaintext rows pass through unchanged on read.
 *
 * Witnessed (grade-tests w63): sealing skipped with KMS configured → the
 * envelope case red; the legacy pass-through dropped → both plaintext cases
 * red; opening without decrypting → the envelope case red.
 * The fourth case used to recompute an HMAC over `open(seal(s))`, which is
 * implied by the envelope case's exact round-trip; it now pins the fail-closed
 * half instead: a row sealed under another key never opens.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureKmsClient, createLocalAesKmsClient, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';
import { sealWebhookSecret, openWebhookSecret } from '../src/host/webhookSecretCodec.js';

const KEY = randomBytes(32);

describe('webhookSecretCodec — no KMS (local/demo posture)', () => {
  beforeAll(() => { _resetKmsForTesting(); });

  it('passes plaintext through unchanged in both directions (prior behavior preserved)', async () => {
    expect(await sealWebhookSecret('whsec_plain')).toBe('whsec_plain');
    expect(await openWebhookSecret('whsec_plain')).toBe('whsec_plain');
  });
});

describe('webhookSecretCodec — KMS configured (enterprise posture)', () => {
  beforeAll(() => { configureKmsClient(createLocalAesKmsClient(KEY, 'test/local-aes')); });
  afterAll(() => { _resetKmsForTesting(); });

  it('seals to a wsec:kms:v1 envelope that never contains the plaintext, and opens back exactly', async () => {
    const secret = 'whsec_super_secret_value_123';
    const sealed = await sealWebhookSecret(secret);
    expect(sealed.startsWith('wsec:kms:v1:')).toBe(true);
    expect(sealed).not.toContain(secret);
    expect(await openWebhookSecret(sealed)).toBe(secret);
  });

  it('legacy plaintext rows still open verbatim (no migration needed)', async () => {
    expect(await openWebhookSecret('pre-existing-plaintext-secret')).toBe('pre-existing-plaintext-secret');
  });

  it('a secret sealed under ANOTHER KMS key fails closed on open (never returns a wrong secret)', async () => {
    const secret = 'whsec_shared_with_subscriber';
    const sealed = await sealWebhookSecret(secret);
    // The key is rotated away without re-sealing: the worker must refuse to sign
    // (a failed attempt, ADR 0755) rather than sign with garbage.
    configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/other-key'));
    try {
      await expect(openWebhookSecret(sealed)).rejects.toThrow();
    } finally {
      configureKmsClient(createLocalAesKmsClient(KEY, 'test/local-aes'));
    }
    // Positive control: under the sealing key it opens exactly.
    expect(await openWebhookSecret(sealed)).toBe(secret);
  });
});
