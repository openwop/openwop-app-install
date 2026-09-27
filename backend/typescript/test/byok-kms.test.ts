/**
 * KMS-encrypted BYOK tests (P3.4).
 *
 * Wire shape: signed-in tenants (`user:*`) store secrets in
 * `byok_tenant_secrets` (sqlite) / `byok_secrets` (postgres) using
 * KMS envelope encryption. Anon (`anon:*`) tenants stay ephemeral.
 *
 * We test against an in-memory sqlite store with a local-AES KMS
 * stub. The stub matches the production Google Cloud KMS shape, so
 * the same encrypt/decrypt round-trip exercises the same code path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, createCipheriv } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStorage } from '../src/storage/index.js';
import {
  configureSecretResolver,
  resolveSecret,
  setSecret,
  removeSecret,
  listSecretRefs,
  deleteAllSecretsForTenant,
  clearCache,
} from '../src/byok/secretResolver.js';
import {
  configureKmsClient,
  createLocalAesKmsClient,
  _resetKmsForTesting,
  kmsEncrypt,
  kmsDecrypt,
} from '../src/byok/kmsEncryption.js';
import type { Storage } from '../src/storage/storage.js';

let storage: Storage;

beforeEach(async () => {
  storage = await openStorage('memory://');
  const dataDir = mkdtempSync(join(tmpdir(), 'openwop-kms-'));
  configureSecretResolver({ storage, dataDir });
  // Install a deterministic test KMS stub so encryption is hermetic.
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));
  clearCache();
});

afterEach(async () => {
  _resetKmsForTesting();
  clearCache();
  await storage.close();
});

const CTX = { tenantId: 'user:abc', credentialRef: 'OPENAI_API_KEY' };

describe('KMS envelope encryption (kmsEncryption.ts)', () => {
  it('round-trips a UTF-8 plaintext (v3, AAD-bound)', async () => {
    const record = await kmsEncrypt('hunter2', CTX);
    expect(record.v).toBe(3); // v3 — tenant-bound (vuln-scan M2)
    expect(record.iv).toBeTruthy();
    expect(record.ct).toBeTruthy();
    expect(record.tag).toBeTruthy();
    expect(record.wrappedDek).toBeTruthy();
    expect(record.kmsKeyName).toBe('test/local-aes');

    const decoded = await kmsDecrypt(record, CTX);
    expect(decoded).toBe('hunter2');
  });

  it('FAILS to decrypt under a different tenant AAD (the M2 tenant binding)', async () => {
    const record = await kmsEncrypt('hunter2', { tenantId: 'user:alice', credentialRef: 'k' });
    // A storage misroute that hands this row to user:bob decrypts with bob's AAD → GCM tag fails.
    await expect(kmsDecrypt(record, { tenantId: 'user:bob', credentialRef: 'k' })).rejects.toThrow();
    // A different ref under the same tenant also fails (ref is part of the binding).
    await expect(kmsDecrypt(record, { tenantId: 'user:alice', credentialRef: 'other' })).rejects.toThrow();
  });

  it('still decrypts a legacy v2 record (no AAD) — backward compat', async () => {
    // Build a v2 record (pre-AAD) with the SAME configured KMS client so the DEK unwraps.
    const key = randomBytes(32);
    const kms = createLocalAesKmsClient(key, 'test/local-aes');
    configureKmsClient(kms);
    const dek = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const ct = Buffer.concat([cipher.update('legacy-secret', 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrappedDek = await kms.encrypt(dek);
    const v2 = { v: 2 as const, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64'), wrappedDek: wrappedDek.toString('base64'), kmsKeyName: 'test/local-aes' };
    // v2 ignores AAD, so any ctx decrypts it.
    expect(await kmsDecrypt(v2, { tenantId: 'anything', credentialRef: 'x' })).toBe('legacy-secret');
  });

  it('rejects tampered ciphertext', async () => {
    const record = await kmsEncrypt('hunter2', CTX);
    // Flip one byte in the ciphertext payload.
    const ct = Buffer.from(record.ct, 'base64');
    ct[0] = ct[0]! ^ 0xff;
    const tampered = { ...record, ct: ct.toString('base64') };
    await expect(kmsDecrypt(tampered, CTX)).rejects.toThrow();
  });

  it('uses a fresh DEK per encrypt call', async () => {
    const r1 = await kmsEncrypt('same-plaintext', CTX);
    const r2 = await kmsEncrypt('same-plaintext', CTX);
    expect(r1.wrappedDek).not.toBe(r2.wrappedDek);
    expect(r1.iv).not.toBe(r2.iv);
    // Both still decrypt to the same plaintext.
    expect(await kmsDecrypt(r1, CTX)).toBe('same-plaintext');
    expect(await kmsDecrypt(r2, CTX)).toBe('same-plaintext');
  });
});

describe('secretResolver — signed-in tenant routing', () => {
  it('routes `user:*` tenants to KMS-encrypted persistent storage', async () => {
    await setSecret('OPENAI_API_KEY', 'sk-test-abc', { tenantId: 'user:abc' });

    const refs = await listSecretRefs({ tenantId: 'user:abc' });
    expect(refs).toEqual(['OPENAI_API_KEY']);

    const got = await resolveSecret('OPENAI_API_KEY', { tenantId: 'user:abc' });
    expect(got).toBe('sk-test-abc');
  });

  it('isolates secrets across `user:*` tenants', async () => {
    await setSecret('SHARED_KEY', 'alice-value', { tenantId: 'user:alice' });
    await setSecret('SHARED_KEY', 'bob-value', { tenantId: 'user:bob' });

    expect(await resolveSecret('SHARED_KEY', { tenantId: 'user:alice' })).toBe('alice-value');
    expect(await resolveSecret('SHARED_KEY', { tenantId: 'user:bob' })).toBe('bob-value');
    expect(await listSecretRefs({ tenantId: 'user:alice' })).toEqual(['SHARED_KEY']);
    expect(await listSecretRefs({ tenantId: 'user:bob' })).toEqual(['SHARED_KEY']);
  });

  it('does not see flat-scope secrets when reading as signed-in tenant', async () => {
    // Write via the legacy flat path.
    await setSecret('LEGACY_KEY', 'flat-value', { tenantId: 'demo' });
    // Signed-in tenant sees nothing.
    expect(await resolveSecret('LEGACY_KEY', { tenantId: 'user:abc' })).toBeNull();
  });

  it('persists encrypted form (not plaintext) at rest', async () => {
    await setSecret('SECRET_X', 'plaintext-value-xyz', { tenantId: 'user:abc' });
    const onDisk = await storage.getTenantSecret('user:abc', 'SECRET_X');
    expect(onDisk).not.toBeNull();
    expect(onDisk).not.toContain('plaintext-value-xyz');
    // Wire shape sanity check.
    const parsed = JSON.parse(onDisk!);
    expect(parsed.v).toBe(3); // v3 — tenant-bound (vuln-scan M2)
    expect(parsed.wrappedDek).toBeTruthy();
  });

  it('removes a single secret', async () => {
    await setSecret('A', '1', { tenantId: 'user:abc' });
    await setSecret('B', '2', { tenantId: 'user:abc' });
    await removeSecret('A', { tenantId: 'user:abc' });
    expect(await listSecretRefs({ tenantId: 'user:abc' })).toEqual(['B']);
  });

  it('account-deletion wipes every tenant secret in one call', async () => {
    await setSecret('A', '1', { tenantId: 'user:abc' });
    await setSecret('B', '2', { tenantId: 'user:abc' });
    await setSecret('C', '3', { tenantId: 'user:other' });

    const removed = await deleteAllSecretsForTenant('user:abc');
    expect(removed).toBe(2);
    expect(await listSecretRefs({ tenantId: 'user:abc' })).toEqual([]);
    expect(await listSecretRefs({ tenantId: 'user:other' })).toEqual(['C']);
  });

  it('rejects signed-in setSecret when KMS is not configured', async () => {
    _resetKmsForTesting();
    await expect(
      setSecret('K', 'v', { tenantId: 'user:abc' }),
    ).rejects.toThrow(/KMS not configured/);
  });
});

describe('secretResolver — legacy flat-path tenant isolation (vuln-scan M3)', () => {
  const prevEphemeral = process.env.OPENWOP_BYOK_EPHEMERAL;
  beforeEach(() => {
    _resetKmsForTesting();            // no KMS → non-user/-ws tenants hit the flat path
    delete process.env.OPENWOP_BYOK_EPHEMERAL; // no ephemeral either
  });
  afterEach(() => {
    if (prevEphemeral === undefined) delete process.env.OPENWOP_BYOK_EPHEMERAL;
    else process.env.OPENWOP_BYOK_EPHEMERAL = prevEphemeral;
  });

  it('isolates two non-KMS tenants storing the SAME ref (was: silent cross-read)', async () => {
    await setSecret('SHARED', 'a-value', { tenantId: 'demo-a' });
    await setSecret('SHARED', 'b-value', { tenantId: 'demo-b' });
    expect(await resolveSecret('SHARED', { tenantId: 'demo-a' })).toBe('a-value');
    expect(await resolveSecret('SHARED', { tenantId: 'demo-b' })).toBe('b-value');
    // Each tenant lists ONLY its own ref (no cross-tenant ref-name disclosure).
    expect(await listSecretRefs({ tenantId: 'demo-a' })).toEqual(['SHARED']);
    expect(await listSecretRefs({ tenantId: 'demo-b' })).toEqual(['SHARED']);
  });

  it('keeps a scopeless host-global ref in the global namespace', async () => {
    await setSecret('HOST_GLOBAL', 'host-value'); // no scope → bare-ref key
    expect(await resolveSecret('HOST_GLOBAL')).toBe('host-value');
    // A tenant-scoped read does NOT see the host-global ref (different key).
    expect(await resolveSecret('HOST_GLOBAL', { tenantId: 'demo-a' })).toBeNull();
  });
});
