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
 *
 * TST-DKB-1 (grade-tests wave 72) — a NAMED TRIPWIRE (CLAUDE.md: it reds when
 * `@azure/core-rest-pipeline` is pruned). Corrections from the w72 pass: the
 * cannot-load case used the Azure key while the SDK WAS present, so the path it
 * names never ran and the announcement was asserted nowhere — it now forces the
 * pruned-dependency failure with `vi.doMock` and asserts the error line; the
 * "present SDK boots" case used a GCP key, whose background preflight ran real
 * ADC credential discovery after the case ended — it now uses an AWS key
 * (import + construct only). Red when: an optional SDK stops importing; a
 * preflight throws on a present SDK (w72 probe kp-azure-preflight); boot with no
 * key claims a backend (kp-nokey); a load failure stops being announced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAwsKmsClient, createAzureKeyVaultKmsClient } from '../src/byok/kmsBackends.js';
import { createGoogleCloudKmsClient, bootstrapKmsFromEnv, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';

const GCP_KEY = 'projects/p/locations/l/keyRings/r/cryptoKeys/k';
const AWS_KEY = 'aws-kms:arn:aws:kms:us-east-1:123:key/abc';
const AZURE_URL = 'https://v.vault.azure.net/keys/k';

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
  it('is exposed by every backend', async () => {
    // Called, not just typeof'd. GCP's preflight would initialize() (credential
    // discovery), so for GCP only its presence is checked; AWS and Azure resolve
    // the SDK without any I/O.
    await expect(createAwsKmsClient('arn:aws:kms:us-east-1:123:key/abc').preflight!()).resolves.toBeUndefined();
    await expect(createAzureKeyVaultKmsClient(AZURE_URL).preflight!()).resolves.toBeUndefined();
    expect(typeof createGoogleCloudKmsClient(GCP_KEY).preflight).toBe('function');
  });

  it('succeeds when the SDK is present — and performs no encrypt/decrypt', async () => {
    // A round-trip would need real credentials; preflight must not need them.
    // DefaultAzureCredential with no identity throws on first USE, so a preflight
    // that wrapped/unwrapped would reject here.
    await expect(createAzureKeyVaultKmsClient(AZURE_URL).preflight?.()).resolves.toBeUndefined();
  });
});

/** Capture stderr lines (the logger writes error-level JSON lines there). */
function captureStderr(): { lines: () => string[] } {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  return { lines: () => chunks.join('').split('\n').filter(Boolean) };
}
const drain = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

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

  it('boots (does not throw) for a backend whose SDK is present', async () => {
    process.env.OPENWOP_BYOK_KMS_KEY = AWS_KEY;
    const errors = captureStderr();
    expect(bootstrapKmsFromEnv()).toBe(true);
    await drain();
    expect(errors.lines().filter((l) => l.includes('cannot load'))).toEqual([]);
  });

  it('does NOT fail boot when a backend cannot load — it reports and continues', async () => {
    // The deliberate posture: a backend that cannot load is a deploy-time
    // misconfiguration, not a reason to refuse to start. Secret operations still
    // fail CLOSED with the honest error; what changed is that boot says so once.
    // The failure is FORCED: the Azure SDK import rejects, as it does when npm
    // >= 11.5 prunes its transitive dependencies.
    vi.doMock('@azure/keyvault-keys', () => { throw new Error('w72: forced Azure SDK load failure'); });
    try {
      process.env.OPENWOP_BYOK_KMS_KEY = `azure-keyvault:${AZURE_URL}`;
      const errors = captureStderr();
      expect(bootstrapKmsFromEnv()).toBe(true);
      await vi.waitFor(() => expect(errors.lines().some((l) => l.includes('BYOK KMS backend cannot load'))).toBe(true));
      const line = errors.lines().find((l) => l.includes('BYOK KMS backend cannot load'))!;
      // vitest wraps a throwing mock factory in its own message, so the
      // pruned-transitive wording branch (`azureLoadFailureMessage`) is not
      // reachable here — azure-kms-load-diagnostic.test.ts pins that branch. This
      // case pins the ANNOUNCEMENT: one error line, naming the key and the advice.
      expect(errors.lines().filter((l) => l.includes('BYOK KMS backend cannot load'))).toHaveLength(1);
      expect(line).toContain(`"kmsKeyName":"azure-keyvault:${AZURE_URL}"`);
      expect(line).toContain('Run `npm install @azure/keyvault-keys @azure/identity`');
    } finally {
      vi.doUnmock('@azure/keyvault-keys');
    }
  });

  it('an unrecognised key shape still throws at boot (unchanged)', () => {
    process.env.OPENWOP_BYOK_KMS_KEY = 'not-a-valid-kms-handle';
    expect(() => bootstrapKmsFromEnv()).toThrow(/OPENWOP_BYOK_KMS_KEY/);
  });
});
