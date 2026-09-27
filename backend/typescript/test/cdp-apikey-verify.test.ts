/**
 * CDP-H — API-key verify durability (ADR 0270 + architect CRITICAL). A revoke MUST
 * stick: a prior/concurrent verify's best-effort lastUsedAt stamp must never
 * re-persist the pre-revoke record and un-revoke the key (fixed via compareAndSwap).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { issueApiKey, verifyApiKey, revokeApiKey } from '../src/features/developer-keys/apiKeyService.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

describe('CDP-H verifyApiKey durability', () => {
  it('a revoke sticks even after repeated verifies (no lastUsedAt clobber)', async () => {
    const { token, key } = await issueApiKey({ tenantId: 'org:kv', name: 'k', createdBy: 'u1', scopes: ['manifest:read'] });
    // several verifies (each does the best-effort lastUsedAt CAS)
    expect(await verifyApiKey(token)).toBeTruthy();
    expect(await verifyApiKey(token)).toBeTruthy();
    // revoke, then interleave more verifies — must stay revoked
    expect(await revokeApiKey('org:kv', key.keyId, { callerSubject: 'u1', isAdmin: false })).toBe(true);
    for (let i = 0; i < 5; i++) expect(await verifyApiKey(token)).toBeNull();
  });

  it('an expired key never authenticates', async () => {
    const { token } = await issueApiKey({ tenantId: 'org:kv2', name: 'exp', createdBy: 'u1', expiresAt: '2000-01-01T00:00:00.000Z' });
    expect(await verifyApiKey(token)).toBeNull();
  });
  it('TOK-D-2 (ADR 0448) — a legacy hashidx pointer without tenantId is lazily healed on the next verify', async () => {
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
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
    // The heal is a void promise; poll briefly for it to land.
    let healed: string | undefined;
    for (let i = 0; i < 20 && healed === undefined; i++) {
      healed = (await hashIndex.get(th))!.tenantId;
      if (healed === undefined) await new Promise((r) => setTimeout(r, 5));
    }
    expect(healed).toBe('org:heal'); // now tenant-purge-reachable
  });
});
