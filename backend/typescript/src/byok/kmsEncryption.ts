/**
 * KMS-backed envelope encryption for BYOK secrets owned by signed-in users.
 *
 * Used by the `user:*` tenant path (Firebase Auth + Postgres). Anon
 * tenants keep using the ephemeral in-memory store (which never
 * persists), and the legacy local-master-key path stays for non-public
 * dev. This file handles only the KMS-wrapped persistent path.
 *
 * Envelope scheme:
 *   1. Generate a fresh 32-byte DEK (data-encryption key) per record.
 *   2. AES-256-GCM-encrypt plaintext with DEK + random 12-byte IV.
 *   3. KMS-encrypt the DEK with the configured KMS key.
 *   4. Persist {wrappedDek, iv, ct, tag, kmsKeyName, v: 2}.
 *
 * The DEK never leaves process memory longer than necessary. The
 * KMS-wrapped DEK is the only on-disk durable token.
 *
 * KMS configuration:
 *   - OPENWOP_BYOK_KMS_KEY    `projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>`
 *   - GOOGLE_APPLICATION_CREDENTIALS or workload-identity on Cloud Run
 *
 * The `KmsClient` interface is provider-neutral: Google Cloud KMS, AWS
 * KMS, and Azure Key Vault each implement it (see kmsBackends.ts). The
 * `@google-cloud/kms` SDK is an OPTIONAL dependency — it is dynamically
 * imported only when a GCP key is actually configured, so a non-GCP
 * deployment never needs the package installed.
 *
 * Test seam: `setKmsClientForTesting()` swaps the KMS client with an
 * AES-256-GCM-backed stub. The wire shape is identical, so tests can
 * exercise the same encrypt/decrypt round-trip without a live KMS.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createLogger } from '../observability/logger.js';
import { matchNonGcpKmsBackend } from './kmsBackends.js';

const log = createLogger('byok.kmsEncryption');

const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGO = 'aes-256-gcm' as const;

export interface KmsEncryptedRecord {
  /** v2 — legacy, inner AES-GCM has NO AAD (pre-2026-07). v3 — inner AES-GCM is
   *  bound to the record's (tenantId, credentialRef) via setAAD (vuln-scan M2), so a
   *  storage-layer row misroute fails the GCM auth-tag check instead of leaking a
   *  cross-tenant secret. Both are decryptable (v2 without AAD); new writes are v3. */
  v: 2 | 3;
  iv: string;            // base64 12B
  ct: string;            // base64 ciphertext
  tag: string;           // base64 16B
  wrappedDek: string;    // base64 KMS-wrapped DEK
  kmsKeyName: string;    // for key rotation / auditing
}

/** The tenant-binding context for the v3 inner-GCM AAD. Canonical fixed-delimiter
 *  string (NOT JSON — key-order/whitespace drift would make stored secrets
 *  undecryptable); `\x1f` (unit separator) cannot appear in a tenantId/ref. */
export interface KmsAadContext { tenantId: string; credentialRef: string }
function aadOf(ctx: KmsAadContext): Buffer {
  return Buffer.from(`${ctx.tenantId}\x1f${ctx.credentialRef}`, 'utf-8');
}

/**
 * Minimal KMS client surface. Production wraps Google Cloud KMS;
 * tests wrap a local AES-256-GCM stub.
 */
export interface KmsClient {
  encrypt(plaintextDek: Buffer): Promise<Buffer>;
  decrypt(wrappedDek: Buffer): Promise<Buffer>;
  keyName(): string;
  /**
   * Resolve the backend's SDK without performing a KMS operation, so boot can
   * tell whether this client could EVER work (ADR 0024 follow-up).
   *
   * Each cloud SDK is an optionalDependency loaded by a lazy `import()` on first
   * encrypt/decrypt. That deferral meant `bootstrapKmsFromEnv` logged
   * "BYOK KMS configured" for a backend it had never loaded — and when the Azure
   * dependency tree turned out to be incomplete (npm does not reliably install
   * the transitive deps OF an optionalDependency), the app booted clean, claimed
   * success, and only failed at the first secret operation. Optional so a test
   * stub need not implement it; absent ⇒ nothing to preflight.
   */
  preflight?(): Promise<void>;
}

let configuredClient: KmsClient | null = null;

export function configureKmsClient(client: KmsClient): void {
  configuredClient = client;
}

export function isKmsConfigured(): boolean {
  return configuredClient !== null;
}

function requireKmsClient(): KmsClient {
  if (!configuredClient) {
    throw new Error('KMS client not configured — call configureKmsClient() at boot');
  }
  return configuredClient;
}

/**
 * Create a Google Cloud KMS client bound to a specific key.
 * Used at boot when OPENWOP_BYOK_KMS_KEY is set.
 *
 * The `@google-cloud/kms` SDK is loaded lazily on first use so the
 * package stays an optional dependency: non-GCP hosts that never
 * configure a GCP key never load (or need to install) it.
 */
export function createGoogleCloudKmsClient(keyName: string): KmsClient {
  if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(keyName)) {
    throw new Error(
      `OPENWOP_BYOK_KMS_KEY must match projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>; got: ${keyName}`,
    );
  }
  // Deferred import + single-flight client construction. We type the
  // client structurally so the file does not statically depend on the
  // optional package's types either.
  interface GcpKmsClient {
    initialize?(): Promise<unknown>;
    encrypt(req: { name: string; plaintext: Buffer }): Promise<[{ ciphertext?: unknown }]>;
    decrypt(req: { name: string; ciphertext: Buffer }): Promise<[{ plaintext?: unknown }]>;
  }
  let clientPromise: Promise<GcpKmsClient> | null = null;
  function getClient(): Promise<GcpKmsClient> {
    if (!clientPromise) {
      // Non-literal specifier: TypeScript skips module resolution, so
      // typecheck/build stay green when the optional package is omitted.
      const pkg = '@google-cloud/kms';
      clientPromise = import(pkg)
        .then((mod): GcpKmsClient => new mod.KeyManagementServiceClient())
        .catch((err) => {
          throw new Error(
            'OPENWOP_BYOK_KMS_KEY is set to a Google Cloud key but the optional ' +
              '@google-cloud/kms package is not installed. Run `npm install @google-cloud/kms`, ' +
              'or use a different BYOK backend (local-AES / AWS KMS / Azure Key Vault). ' +
              `Underlying error: ${(err as Error).message}`,
          );
        })
        // Initialize HERE, awaited. Every generated gax method does
        // `this.initialize().catch(err => { throw err; })` — a re-throw inside a
        // catch mints a NEW rejected promise nobody handles. So when credentials
        // are unavailable, the first encrypt() failed twice: once to our await
        // (fine) and once as an unhandledRejection, which the process policy turns
        // into drain-and-exit. MEASURED 2026-09-26: one POST /webhooks on a host
        // with no GCP identity took the whole server down. Awaiting initialize()
        // first means a credential failure throws in THIS chain and the gax
        // methods never run on a failed stub.
        .then(async (client) => {
          await client.initialize?.();
          return client;
        });
      // A failed init is not cached forever: the next call retries (a transient
      // metadata-server blip must not wedge sealing until restart). Handled here,
      // so resetting it creates no unhandled rejection of its own.
      clientPromise.catch(() => { clientPromise = null; });
    }
    return clientPromise;
  }
  return {
    keyName: () => keyName,
    // ADR 0024 follow-up: resolve the SDK without a KMS round-trip.
    preflight: async () => { await getClient(); },
    async encrypt(plaintextDek) {
      const client = await getClient();
      const [resp] = await client.encrypt({ name: keyName, plaintext: plaintextDek });
      const cipher = resp.ciphertext;
      if (!cipher) throw new Error('KMS encrypt returned empty ciphertext');
      return Buffer.from(cipher as Uint8Array);
    },
    async decrypt(wrappedDek) {
      const client = await getClient();
      const [resp] = await client.decrypt({ name: keyName, ciphertext: wrappedDek });
      const plain = resp.plaintext;
      if (!plain) throw new Error('KMS decrypt returned empty plaintext');
      return Buffer.from(plain as Uint8Array);
    },
  };
}

/**
 * AES-256-GCM-backed KmsClient for tests. The "wrapped DEK" is just
 * the DEK encrypted with a fixed test key. Same shape as Google KMS,
 * no network, deterministic in CI.
 */
export function createLocalAesKmsClient(testKey: Buffer, label = 'test/local-aes'): KmsClient {
  if (testKey.length !== 32) throw new Error('test KMS key must be 32 bytes');
  return {
    keyName: () => label,
    async encrypt(plaintextDek) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGO, testKey, iv);
      const ct = Buffer.concat([cipher.update(plaintextDek), cipher.final()]);
      const tag = cipher.getAuthTag();
      // Pack as iv|tag|ct for portability
      return Buffer.concat([iv, tag, ct]);
    },
    async decrypt(wrappedDek) {
      const iv = wrappedDek.subarray(0, IV_BYTES);
      const tag = wrappedDek.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ct = wrappedDek.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv(ALGO, testKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    },
  };
}

/** Envelope-encrypt a UTF-8 plaintext string. Always writes a v3 record whose inner
 *  AES-GCM is bound to `ctx` (tenantId, credentialRef) via AAD — a misrouted row
 *  decrypts to nothing under a different tenant's AAD (vuln-scan M2). */
export async function kmsEncrypt(plaintext: string, ctx: KmsAadContext): Promise<KmsEncryptedRecord> {
  const client = requireKmsClient();
  const dek = randomBytes(DEK_BYTES);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, dek, iv);
    cipher.setAAD(aadOf(ctx)); // v3 tenant binding
    const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrappedDek = await client.encrypt(dek);
    return {
      v: 3,
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: tag.toString('base64'),
      wrappedDek: wrappedDek.toString('base64'),
      kmsKeyName: client.keyName(),
    };
  } finally {
    // Best-effort zeroing of the DEK before GC.
    dek.fill(0);
  }
}

/** Envelope-decrypt a record. Throws on tamper or KMS denial. `ctx` supplies the v3
 *  AAD (reconstructed from the row's own tenant + ref) — a row whose stored
 *  (tenant, ref) don't match the requested ones fails the GCM auth-tag check. v2
 *  records (legacy, no AAD) decrypt without it. */
export async function kmsDecrypt(record: KmsEncryptedRecord, ctx: KmsAadContext): Promise<string> {
  if (record.v !== 2 && record.v !== 3) throw new Error(`unsupported KMS record version: ${record.v}`);
  const client = requireKmsClient();
  const wrappedDek = Buffer.from(record.wrappedDek, 'base64');
  const iv = Buffer.from(record.iv, 'base64');
  const ct = Buffer.from(record.ct, 'base64');
  const tag = Buffer.from(record.tag, 'base64');
  if (iv.length !== IV_BYTES) throw new Error(`bad iv length: ${iv.length}`);
  if (tag.length !== TAG_BYTES) throw new Error(`bad tag length: ${tag.length}`);
  const dek = await client.decrypt(wrappedDek);
  try {
    if (dek.length !== DEK_BYTES) throw new Error(`bad DEK length: ${dek.length}`);
    const decipher = createDecipheriv(ALGO, dek, iv);
    if (record.v === 3) decipher.setAAD(aadOf(ctx)); // must match the encrypt-side AAD
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf-8');
  } finally {
    dek.fill(0);
  }
}

/**
 * Bootstrap from environment. Returns true if KMS is configured.
 * Logs a structured info line for ops visibility.
 *
 * `OPENWOP_BYOK_KMS_KEY` selects the backend by shape (see kmsBackends.ts):
 * an `aws-kms:` / `azure-keyvault:` prefix routes to AWS KMS / Azure Key Vault,
 * otherwise the GCP `projects/.../cryptoKeys/...` form is used. An unrecognized
 * value throws so a misconfigured `auth` deploy fails fast at boot.
 */
export function bootstrapKmsFromEnv(): boolean {
  const keyName = process.env.OPENWOP_BYOK_KMS_KEY;
  if (!keyName) return false;
  const nonGcp = matchNonGcpKmsBackend(keyName);
  const client = nonGcp ?? createGoogleCloudKmsClient(keyName);
  configureKmsClient(client);
  log.info('BYOK KMS configured', { kmsKeyName: keyName });
  // Preflight the SDK so the line above stops being a claim we have not checked.
  // Deliberately does NOT block or fail boot: a backend that cannot load is a
  // deploy-time misconfiguration, not a reason to refuse to start (the operator
  // may not have exercised BYOK yet), and every secret operation still fails
  // CLOSED with the honest error. What changes is that the failure is announced
  // ONCE, loudly, at boot instead of being discovered by the first customer write.
  void client.preflight?.().catch((err: unknown) => {
    log.error('BYOK KMS backend cannot load — secret operations WILL fail', {
      kmsKeyName: keyName,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return true;
}

/** Test affordance — wipe the configured client. */
export function _resetKmsForTesting(): void {
  configuredClient = null;
}
