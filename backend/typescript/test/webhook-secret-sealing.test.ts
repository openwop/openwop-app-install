/**
 * Webhook HMAC secrets sealed at rest (closes the types.ts TODO — "use KMS in
 * production"). KMS envelope when configured (mandatory in the auth posture);
 * legacy/dev plaintext rows pass through unchanged on read.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureKmsClient, createLocalAesKmsClient, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';
import { sealWebhookSecret, openWebhookSecret } from '../src/host/webhookSecretCodec.js';

describe('webhookSecretCodec — no KMS (local/demo posture)', () => {
  beforeAll(() => { _resetKmsForTesting(); });

  it('passes plaintext through unchanged in both directions (prior behavior preserved)', async () => {
    expect(await sealWebhookSecret('whsec_plain')).toBe('whsec_plain');
    expect(await openWebhookSecret('whsec_plain')).toBe('whsec_plain');
  });
});

describe('webhookSecretCodec — KMS configured (enterprise posture)', () => {
  beforeAll(() => { configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes')); });
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

  it('the worker-visible contract holds: HMAC over the OPENED secret matches the subscriber\'s', async () => {
    const { createHmac } = await import('node:crypto');
    const secret = 'whsec_shared_with_subscriber';
    const sealed = await sealWebhookSecret(secret);
    const payload = '{"type":"run.completed"}';
    const ts = '1700000000';
    // Host signs with the opened stored secret; subscriber signs with the
    // plaintext it received at registration — they MUST agree.
    const hostSig = createHmac('sha256', await openWebhookSecret(sealed)).update(`${ts}.${payload}`).digest('hex');
    const subscriberSig = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
    expect(hostSig).toBe(subscriberSig);
  });
});
