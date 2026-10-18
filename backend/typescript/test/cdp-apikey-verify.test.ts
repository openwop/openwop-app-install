/**
 * CDP-H — API-key verify durability (ADR 0270 + architect CRITICAL). A revoke MUST
 * stick: a prior/concurrent verify's best-effort lastUsedAt stamp must never
 * re-persist the pre-revoke record and un-revoke the key (fixed via compareAndSwap).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { issueApiKey, verifyApiKey, revokeApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

interface KeyRow { keyId: string; tenantId: string; tokenHash: string; lastUsedAt?: string; revokedAt?: string }
const drain = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

describe('CDP-H verifyApiKey durability', () => {
  it('a revoke sticks even after repeated verifies (no lastUsedAt clobber)', async () => {
    const { token, key } = await issueApiKey({ tenantId: 'org:kv', name: 'k', createdBy: 'u1', scopes: ['manifest:read'] });
    const records = new DurableCollection<KeyRow>('devkey:record', (k) => k.keyId);

    // Force the race the fix closes: hold verify's best-effort lastUsedAt write
    // (whether it is a CAS or a plain put) until AFTER the revoke has landed.
    // Only the stamp write is held — it carries lastUsedAt and no revokedAt.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held = 0;
    const isStamp = (self: unknown, row: unknown): boolean => {
      const r = row as Partial<KeyRow> | null;
      return Reflect.get(self as object, 'name') === 'devkey:record' && r?.keyId === key.keyId && r.lastUsedAt !== undefined && r.revokedAt === undefined;
    };
    const origCas = DurableCollection.prototype.compareAndSwap;
    const origPut = DurableCollection.prototype.put;
    const cas = vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockImplementation(async function (this: DurableCollection<unknown>, expected, next) {
      if (isStamp(this, next)) { held++; await gate; }
      return origCas.call(this, expected, next);
    });
    const put = vi.spyOn(DurableCollection.prototype, 'put').mockImplementation(async function (this: DurableCollection<unknown>, item) {
      if (isStamp(this, item)) { held++; await gate; }
      return origPut.call(this, item);
    });
    try {
      // A use well past the 5-minute stamp resolution ⇒ verify writes lastUsedAt.
      expect(await verifyApiKey(token, Date.now() + 10 * 60_000)).toBeTruthy();
      expect(held).toBe(1); // the stamp write is in flight, pre-revoke
      expect(await revokeApiKey('org:kv', key.keyId, { callerSubject: 'u1', isAdmin: false })).toBe(true);
      release();
      await drain();
    } finally {
      release();
      cas.mockRestore();
      put.mockRestore();
    }
    // The late stamp must not have re-persisted the pre-revoke row.
    expect((await records.get(key.keyId))?.revokedAt).toBeTruthy();
    for (let i = 0; i < 3; i++) expect(await verifyApiKey(token, Date.now() + 20 * 60_000)).toBeNull();
  });

  it('an expired key never authenticates', async () => {
    const { token } = await issueApiKey({ tenantId: 'org:kv2', name: 'exp', createdBy: 'u1', expiresAt: '2000-01-01T00:00:00.000Z' });
    expect(await verifyApiKey(token)).toBeNull();
  });
  it('TOK-D-2 (ADR 0448) — a legacy hashidx pointer without tenantId is lazily healed on the next verify', async () => {
    const { token, key } = await issueApiKey({ tenantId: 'org:heal', name: 'legacy', createdBy: 'u1', scopes: ['manifest:read'] });

    // Simulate a PRE-fix pointer: overwrite the index row with the old shape
    // (no tenantId), exactly as rows written before the OQ3 tenantId fix look.
    const hashIndex = new DurableCollection<{ key: string; keyId: string; tenantId?: string }>('devkey:hashidx', (r) => r.key);
    const rec = new DurableCollection<{ keyId: string; tokenHash: string }>('devkey:record', (k) => k.keyId);
    const stored = await rec.get(key.keyId);
    const th = stored!.tokenHash;
    await hashIndex.put({ key: th, keyId: key.keyId }); // legacy shape: tenantId undefined
    expect((await hashIndex.get(th))!.tenantId).toBeUndefined();

    // A verify still succeeds AND heals the pointer in place (fire-and-forget).
    expect(await verifyApiKey(token)).toBeTruthy();
    // The heal is a void promise; wait on the real condition, not a sleep.
    await vi.waitFor(async () => expect((await hashIndex.get(th))!.tenantId).toBe('org:heal')); // now tenant-purge-reachable
  });
});
