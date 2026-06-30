/**
 * BYOK SecretResolver — sqlite-backed with AES-256-GCM encryption at
 * rest. Persists across restarts.
 *
 * The wire-side contract (per spec/v1/auth.md + run-options.md):
 *   - Run requests carry opaque `credentialRef` strings — never values.
 *   - The resolver maps refs to raw secrets at execute time.
 *   - Resolved secrets MUST NOT appear in events / errors / traces /
 *     persisted run docs. Enforced by `ephemeralRunSecrets.ts` strip
 *     on the event-log + interrupt boundaries.
 *
 * Storage layer: encrypted records live in the `byok_secrets` sqlite
 * table (one row per credentialRef). Plaintext is decrypted on-demand
 * into an in-process cache to avoid hitting sqlite + crypto on every
 * node dispatch.
 *
 * Production deployers swap:
 *   - The master key (env var → KMS-wrapped DEK + KMS API call)
 *   - The storage (sqlite → Postgres / Firestore / Vault)
 * The resolver interface stays the same.
 */

import { resolve } from 'node:path';
import { createLogger } from '../observability/logger.js';
import { decrypt, encrypt, loadMasterKey, type EncryptedRecord } from './encryption.js';
import {
  isKmsConfigured,
  kmsDecrypt,
  kmsEncrypt,
  type KmsEncryptedRecord,
} from './kmsEncryption.js';
import type { Storage } from '../storage/storage.js';

const log = createLogger('byok.secretResolver');

let backend: Storage | null = null;
let masterKeyPath: string | null = null;

/**
 * SEC-1: bounded TTL + LRU cache for decrypted plaintext secrets. The prior
 * implementation was an unbounded `Map` — plaintext lived in process memory for
 * the full process lifetime with no eviction (a slow leak and a longer-than-
 * necessary exposure window for secret material). This caps both: entries
 * expire after `SECRET_CACHE_TTL_MS` (re-resolved on demand) and the map is
 * FIFO/LRU-bounded to `SECRET_CACHE_CAP`. It does NOT replace the documented
 * production swap-point — a managed vault (Vault/HSM) is still the production
 * action — but it closes the *eviction* gap for the reference host.
 */
const SECRET_CACHE_TTL_MS = 5 * 60_000;
const SECRET_CACHE_CAP = 5_000;

class BoundedSecretCache {
  private readonly map = new Map<string, { value: string; expiry: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly cap: number,
  ) {}

  get(key: string): string | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    if (Date.now() > hit.expiry) {
      this.map.delete(key);
      return undefined;
    }
    // LRU touch: re-insert so the most-recently-read key is the newest.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: string): void {
    this.map.delete(key);
    if (this.map.size >= this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiry: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  /** Drop every entry whose key begins with `prefix` (tenant-scoped wipe). */
  deleteByPrefix(prefix: string): void {
    for (const key of Array.from(this.map.keys())) {
      if (key.startsWith(prefix)) this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

/** Lazy-decryption cache for the SQLite-backed path. Keyed by ref. Bounded — see SEC-1. */
const plaintextCache = new BoundedSecretCache(SECRET_CACHE_TTL_MS, SECRET_CACHE_CAP);

/**
 * Per-tenant in-memory store for ephemeral-mode BYOK (P0.3 in the
 * deploy plan). Populated when `OPENWOP_BYOK_EPHEMERAL=true` is set on
 * the host. Secrets never touch disk; they live in this Map until the
 * daily cleanup endpoint (P0.5) wipes the tenant's entry, OR until the
 * process restarts. Cloud Run cold starts wipe all session secrets,
 * which is the intended public-demo posture documented in the demo
 * banner.
 *
 * Shape: `Map<tenantId, Map<credentialRef, plaintextValue>>`.
 */
const ephemeralSecrets = new Map<string, Map<string, string>>();

function ephemeralEnabled(): boolean {
  return process.env.OPENWOP_BYOK_EPHEMERAL === 'true';
}

function ephemeralBucket(tenantId: string): Map<string, string> {
  let b = ephemeralSecrets.get(tenantId);
  if (!b) { b = new Map(); ephemeralSecrets.set(tenantId, b); }
  return b;
}

/** Scope context for secret operations. Required in ephemeral mode
 *  and for signed-in (`user:*`) tenants; optional otherwise. */
export interface SecretScope {
  tenantId: string;
  /** Principal that initiated this secret mutation, stamped into the audit
   *  log (SEC-4). Optional: system-initiated calls (token refresh, eviction)
   *  leave it unset; user-facing routes populate it from `req.principal`. */
  actorId?: string;
}

/**
 * Tenant policy:
 *   - `user:<sha>`  → signed-in personal workspace; persistent, KMS-encrypted
 *   - `ws:<uuid>`   → shared workspace (ADR 0015); same persistent, KMS-encrypted
 *                     posture — a team's BYOK secrets MUST survive + stay wrapped
 *   - `anon:<sid>`  → anonymous; ephemeral, never persisted
 *   - anything else (`demo`, conformance) → flat path (legacy)
 */
function isSignedInTenant(tenantId: string | undefined): tenantId is string {
  return (
    typeof tenantId === 'string' && (tenantId.startsWith('user:') || tenantId.startsWith('ws:'))
  );
}

/** Per-tenant decrypt cache (keyed by tenantId + ref). Bounded — see SEC-1. */
const tenantPlaintextCache = new BoundedSecretCache(SECRET_CACHE_TTL_MS, SECRET_CACHE_CAP);
const tenantCachePrefix = (tenantId: string) => `${tenantId}::`;
const tenantCacheKey = (tenantId: string, ref: string) => `${tenantCachePrefix(tenantId)}${ref}`;

/**
 * Wire the resolver to the storage backend + master-key location.
 * Called once at boot from index.ts.
 */
export function configureSecretResolver(input: { storage: Storage; dataDir: string }): void {
  backend = input.storage;
  masterKeyPath = resolve(input.dataDir, '.byok-master-key');
  // Touch the master key at boot so we crash fast on a misconfigured
  // env var, rather than at first-secret-write.
  loadMasterKey(masterKeyPath);
}

function requireConfigured(): { storage: Storage; masterKey: Buffer } {
  if (!backend || !masterKeyPath) {
    throw new Error('secretResolver not configured — call configureSecretResolver() at boot.');
  }
  return { storage: backend, masterKey: loadMasterKey(masterKeyPath) };
}

/**
 * Seal / open a HOST-GLOBAL secret with the BYOK master key (AES-256-GCM).
 *
 * Unlike `setSecret`/`resolveSecret` (which are TENANT-scoped, keyed by
 * credentialRef + SecretScope), these are for operator/host-level config that
 * has no tenant — e.g. a provider's OAuth *client* secret (ADR 0024 § host-managed
 * OAuth client config). The caller persists the returned `EncryptedRecord`
 * itself (e.g. in a DurableCollection row); the plaintext never lands in storage.
 * This keeps the BYOK envelope the single owner of encrypt-at-rest — callers
 * compose it rather than re-deriving the master key.
 */
export function sealHostSecret(plaintext: string): EncryptedRecord {
  const { masterKey } = requireConfigured();
  return encrypt(plaintext, masterKey);
}

/** Reverse `sealHostSecret`. Throws on tamper / wrong key — callers that must
 *  fail closed (resolve to "unconfigured") should catch and treat as absent. */
export function openHostSecret(record: EncryptedRecord): string {
  const { masterKey } = requireConfigured();
  return decrypt(record, masterKey);
}

/**
 * Bulk-load secrets from OPENWOP_BOOT_SECRETS at boot. Reads a JSON
 * object `{credentialRef: value}` and upserts each into storage. Useful
 * for conformance / scripted test environments that want a known set
 * of refs without going through the wizard. (Legacy alias
 * OPENWOP_SAMPLE_SECRETS still honored for existing deploys.)
 *
 * Returns the count of secrets loaded.
 */
export async function loadSecretsFromEnv(): Promise<number> {
  const raw = process.env.OPENWOP_BOOT_SECRETS ?? process.env.OPENWOP_SAMPLE_SECRETS;
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    let count = 0;
    for (const [ref, value] of Object.entries(parsed)) {
      await setSecret(ref, value);
      count++;
    }
    log.info('loaded BYOK secrets from env', { count });
    return count;
  } catch (err) {
    log.warn('OPENWOP_BOOT_SECRETS parse failed; secrets disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

export async function resolveSecret(credentialRef: string, scope?: SecretScope): Promise<string | null> {
  // Signed-in tenant: KMS-encrypted tenant-scoped storage.
  if (isSignedInTenant(scope?.tenantId)) {
    return resolveTenantSecret(scope!.tenantId, credentialRef);
  }

  if (ephemeralEnabled()) {
    if (!scope?.tenantId) {
      // In ephemeral mode the caller MUST provide a scope. Without
      // tenantId we'd have to fall back to a global map, which would
      // share secrets across tenants — exactly the leak we're closing.
      log.warn('resolveSecret called without scope in ephemeral mode', { credentialRef });
      return null;
    }
    return ephemeralBucket(scope.tenantId).get(credentialRef) ?? null;
  }

  const cached = plaintextCache.get(credentialRef);
  if (cached !== undefined) return cached;

  const { storage, masterKey } = requireConfigured();
  const encryptedJson = await storage.getEncryptedSecret(credentialRef);
  if (!encryptedJson) return null;

  try {
    const record = JSON.parse(encryptedJson) as EncryptedRecord;
    const plaintext = decrypt(record, masterKey);
    plaintextCache.set(credentialRef, plaintext);
    return plaintext;
  } catch (err) {
    log.error('failed to decrypt BYOK secret', {
      credentialRef,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function resolveTenantSecret(tenantId: string, credentialRef: string): Promise<string | null> {
  const cacheKey = tenantCacheKey(tenantId, credentialRef);
  const cached = tenantPlaintextCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (!isKmsConfigured()) {
    log.warn('signed-in tenant secret requested but KMS not configured', { tenantId, credentialRef });
    return null;
  }

  const { storage } = requireConfigured();
  const encryptedJson = await storage.getTenantSecret(tenantId, credentialRef);
  if (!encryptedJson) return null;

  try {
    const record = JSON.parse(encryptedJson) as KmsEncryptedRecord;
    const plaintext = await kmsDecrypt(record);
    tenantPlaintextCache.set(cacheKey, plaintext);
    return plaintext;
  } catch (err) {
    log.error('failed to KMS-decrypt tenant secret', {
      tenantId, credentialRef,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Persist a new (or updated) secret. Called by POST /v1/host/openwop-app/byok/secrets. */
export async function setSecret(credentialRef: string, value: string, scope?: SecretScope): Promise<void> {
  if (isSignedInTenant(scope?.tenantId)) {
    if (!isKmsConfigured()) {
      throw new Error('signed-in tenant cannot set secret: KMS not configured');
    }
    const { storage } = requireConfigured();
    const record = await kmsEncrypt(value);
    await storage.upsertTenantSecret(
      scope!.tenantId,
      credentialRef,
      JSON.stringify(record),
      new Date().toISOString(),
    );
    tenantPlaintextCache.set(tenantCacheKey(scope!.tenantId, credentialRef), value);
    // Audit the mutation (SEC-4) — credentialRef is a NAME, never the value;
    // `actor` is the initiating principal (undefined for system-initiated calls).
    log.info('secret_set', { tenantId: scope!.tenantId, credentialRef, tier: 'kms', actor: scope?.actorId });
    return;
  }

  if (ephemeralEnabled()) {
    if (!scope?.tenantId) {
      throw new Error('setSecret in ephemeral mode requires scope.tenantId');
    }
    ephemeralBucket(scope.tenantId).set(credentialRef, value);
    log.info('secret_set', { tenantId: scope.tenantId, credentialRef, tier: 'ephemeral', actor: scope.actorId });
    return;
  }
  const { storage, masterKey } = requireConfigured();
  const record = encrypt(value, masterKey);
  await storage.upsertEncryptedSecret(credentialRef, JSON.stringify(record), new Date().toISOString());
  plaintextCache.set(credentialRef, value);
  log.info('secret_set', { credentialRef, tier: 'local-aes', actor: scope?.actorId });
}

/** Remove a secret. Called by DELETE /v1/host/openwop-app/byok/secrets/:ref. */
export async function removeSecret(credentialRef: string, scope?: SecretScope): Promise<void> {
  if (isSignedInTenant(scope?.tenantId)) {
    const { storage } = requireConfigured();
    await storage.deleteTenantSecret(scope!.tenantId, credentialRef);
    tenantPlaintextCache.delete(tenantCacheKey(scope!.tenantId, credentialRef));
    log.info('secret_removed', { tenantId: scope!.tenantId, credentialRef, tier: 'kms', actor: scope?.actorId });
    return;
  }
  if (ephemeralEnabled()) {
    if (!scope?.tenantId) throw new Error('removeSecret in ephemeral mode requires scope.tenantId');
    ephemeralBucket(scope.tenantId).delete(credentialRef);
    log.info('secret_removed', { tenantId: scope.tenantId, credentialRef, tier: 'ephemeral', actor: scope.actorId });
    return;
  }
  const { storage } = requireConfigured();
  await storage.deleteSecret(credentialRef);
  plaintextCache.delete(credentialRef);
  log.info('secret_removed', { credentialRef, tier: 'local-aes', actor: scope?.actorId });
}

/** Return all stored credentialRefs for the given scope. NEVER returns values. */
export async function listSecretRefs(scope?: SecretScope): Promise<readonly string[]> {
  if (isSignedInTenant(scope?.tenantId)) {
    const { storage } = requireConfigured();
    return storage.listTenantSecretRefs(scope!.tenantId);
  }
  if (ephemeralEnabled()) {
    if (!scope?.tenantId) return [];
    return Array.from(ephemeralBucket(scope.tenantId).keys());
  }
  const { storage } = requireConfigured();
  return storage.listSecretRefs();
}

/**
 * Migrate an anon tenant's in-memory ephemeral secrets into the user
 * tenant's KMS-encrypted persistent store. Called by the anon→user
 * migration handler after Firebase Auth sign-in.
 *
 * Returns `{ migrated, failed }`. Per-entry failures (KMS API blip,
 * network error) re-insert the value into the source bucket so a
 * later retry can pick them up; successfully-migrated entries are
 * dropped from the source. This avoids the partial-loss window
 * flagged in code-review MEDIUM #3.
 *
 * Throws if KMS isn't configured (signed-in writes require KMS) —
 * callers should gate on `isKmsConfigured()` first.
 */
export async function migrateEphemeralSecretsToTenant(
  fromAnonTenantId: string,
  toUserTenantId: string,
): Promise<{ migrated: number; failed: number }> {
  if (!ephemeralEnabled()) return { migrated: 0, failed: 0 };
  if (!isSignedInTenant(toUserTenantId)) {
    throw new Error('migration target must be a signed-in (user:*) tenant');
  }
  const bucket = ephemeralSecrets.get(fromAnonTenantId);
  if (!bucket || bucket.size === 0) return { migrated: 0, failed: 0 };
  const entries = Array.from(bucket.entries());
  let migrated = 0;
  let failed = 0;
  for (const [ref, value] of entries) {
    try {
      await setSecret(ref, value, { tenantId: toUserTenantId });
      bucket.delete(ref);
      migrated++;
    } catch (err) {
      log.warn('per-secret migration failed; left in source bucket for retry', {
        fromAnonTenantId, toUserTenantId, credentialRef: ref,
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
    }
  }
  // Drop the source bucket only when it's empty (every entry moved).
  if (bucket.size === 0) ephemeralSecrets.delete(fromAnonTenantId);
  return { migrated, failed };
}

/**
 * Drop only the in-process plaintext-cache entries for a tenant.
 * Cheaper companion to `deleteAllSecretsForTenant` for the account-
 * deletion flow where the cascade has already removed the rows.
 */
export function clearTenantSecretCache(tenantId: string): void {
  // Reuse the exact prefix builder the keys are made with, so the wipe delimiter
  // can never drift from the key-builder (SEC-1).
  tenantPlaintextCache.deleteByPrefix(tenantCachePrefix(tenantId));
}

/**
 * Delete every secret owned by `tenantId` — rows + cache. Used when
 * the caller has NOT already wiped the rows via `deleteAllTenantData`
 * (account deletion handles that itself via the storage cascade).
 * Returns the count of rows removed.
 */
export async function deleteAllSecretsForTenant(tenantId: string): Promise<number> {
  if (!backend) {
    throw new Error('secretResolver not configured');
  }
  clearTenantSecretCache(tenantId);
  return backend.deleteAllTenantSecrets(tenantId);
}

/** Wipe one tenant's ephemeral secrets. Called from the daily cleanup
 *  endpoint (P0.5) when an anon session passes its TTL. */
export function clearTenantEphemeralSecrets(tenantId: string): number {
  if (!ephemeralEnabled()) return 0;
  const b = ephemeralSecrets.get(tenantId);
  if (!b) return 0;
  const n = b.size;
  ephemeralSecrets.delete(tenantId);
  return n;
}

/** Wipe ephemeral secrets for any tenant whose id is NOT in `keep`.
 *  Used by the daily cleanup job to GC expired anon sessions in bulk. */
export function clearExpiredEphemeralSecrets(keep: ReadonlySet<string>): number {
  if (!ephemeralEnabled()) return 0;
  let n = 0;
  for (const tenantId of Array.from(ephemeralSecrets.keys())) {
    if (keep.has(tenantId)) continue;
    const bucket = ephemeralSecrets.get(tenantId);
    if (!bucket) continue;
    n += bucket.size;
    ephemeralSecrets.delete(tenantId);
  }
  return n;
}

/** Test affordance — wipe every in-process cache without touching storage. */
export function clearCache(): void {
  plaintextCache.clear();
  tenantPlaintextCache.clear();
  ephemeralSecrets.clear();
}

/** Test affordance — wipe storage AND cache. */
export async function clearAllSecrets(): Promise<void> {
  if (ephemeralEnabled()) {
    ephemeralSecrets.clear();
    return;
  }
  const { storage } = requireConfigured();
  for (const ref of await storage.listSecretRefs()) await storage.deleteSecret(ref);
  plaintextCache.clear();
  tenantPlaintextCache.clear();
}
