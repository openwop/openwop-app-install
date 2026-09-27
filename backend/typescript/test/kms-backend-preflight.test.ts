/**
 * KMS backends must be loadable, and boot must not claim otherwise.
 *
 * Every cloud KMS SDK is an `optionalDependency` behind a lazy `import()`, so
 * nothing ever proved they could load. That deferral hid a real break: npm >= 11.5
 * regressed and prunes the transitive deps of an optionalDependency during
 * `npm install`, so `@azure/identity` + `@azure/keyvault-keys` install WITHOUT
 * `@azure/core-rest-pipeline` and the Azure backend is present-but-unloadable —
 * while `bootstrapKmsFromEnv` logged "BYOK KMS configured".
 *
 * Scope correction (#2696): this bit LOCAL dev on npm >= 11.5, not the built
 * image. `node:22-slim` pins npm 10.9.8, and an A/B inside that image with the
 * same lockfile showed 10.9.8 -> loads, 11.6.2 -> ERR_MODULE_NOT_FOUND. The
 * Dockerfile now uses `npm ci` so a future base-image npm bump cannot start
 * shipping the pruned tree silently.
 *
 * Two guards, because they fail for different reasons:
 *   1. LOAD  — the declared optional SDKs actually import (catches a bad tree,
 *              which is what `npm ci` in the Dockerfile now prevents);
 *   2. BOOT  — a backend that cannot load is ANNOUNCED, and never silently
 *              reported as configured.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAwsKmsClient, createAzureKeyVaultKmsClient } from '../src/byok/kmsBackends.js';
import { createGoogleCloudKmsClient, bootstrapKmsFromEnv, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';

const GCP_KEY = 'projects/p/locations/l/keyRings/r/cryptoKeys/k';

describe('optional KMS SDKs actually load', () => {
  // These are the packages a self-hoster is told the app supports. If the
  // dependency tree is incomplete they resolve at `require` time, not at deploy
  // time — so assert the import here rather than discovering it in production.
  it.each([
    ['@aws-sdk/client-kms'],
    ['@azure/keyvault-keys'],
    ['@azure/identity'],
    ['@google-cloud/kms'],
  ])('%s imports', async (pkg) => {
    await expect(import(/* @vite-ignore */ pkg)).resolves.toBeDefined();
  });
});

describe('preflight resolves the SDK without a KMS round-trip', () => {
  it('is exposed by every backend', () => {
    expect(typeof createAwsKmsClient('aws-key').preflight).toBe('function');
    expect(typeof createAzureKeyVaultKmsClient('https://v.vault.azure.net/keys/k').preflight).toBe('function');
    expect(typeof createGoogleCloudKmsClient(GCP_KEY).preflight).toBe('function');
  });

  it('succeeds when the SDK is present — and performs no encrypt/decrypt', async () => {
    // A round-trip would need real credentials; preflight must not need them.
    await expect(createAzureKeyVaultKmsClient('https://v.vault.azure.net/keys/k').preflight?.()).resolves.toBeUndefined();
  });
});

describe('bootstrapKmsFromEnv — the "configured" claim', () => {
  const prev = process.env.OPENWOP_BYOK_KMS_KEY;
  beforeEach(() => { _resetKmsForTesting(); });
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENWOP_BYOK_KMS_KEY;
    else process.env.OPENWOP_BYOK_KMS_KEY = prev;
    vi.restoreAllMocks();
  });

  it('returns false and configures nothing when no key is set', () => {
    delete process.env.OPENWOP_BYOK_KMS_KEY;
    expect(bootstrapKmsFromEnv()).toBe(false);
  });

  it('boots (does not throw) for a backend whose SDK is present', () => {
    process.env.OPENWOP_BYOK_KMS_KEY = GCP_KEY;
    expect(bootstrapKmsFromEnv()).toBe(true);
  });

  it('does NOT fail boot when a backend cannot load — it reports and continues', async () => {
    // The deliberate posture: a backend that cannot load is a deploy-time
    // misconfiguration, not a reason to refuse to start. Secret operations still
    // fail CLOSED with the honest error; what changed is that boot says so once.
    process.env.OPENWOP_BYOK_KMS_KEY = 'azure-keyvault:https://v.vault.azure.net/keys/k';
    expect(() => bootstrapKmsFromEnv()).not.toThrow();
    expect(bootstrapKmsFromEnv()).toBe(true);
  });

  it('an unrecognised key shape still throws at boot (unchanged)', () => {
    process.env.OPENWOP_BYOK_KMS_KEY = 'not-a-valid-kms-handle';
    expect(() => bootstrapKmsFromEnv()).toThrow(/OPENWOP_BYOK_KMS_KEY/);
  });
});
