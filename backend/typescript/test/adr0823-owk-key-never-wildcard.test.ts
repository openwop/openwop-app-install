/**
 * ADR 0823 D6 (as corrected) — the launch funnel exempts a WILDCARD principal
 * (`tenants: ['*']`), which may already act as any tenant. That exemption is only
 * sound while `'*'` is operator-only: an `OPENWOP_API_KEYS` entry written
 * `<key>:*` (or the local `dev-token`, withdrawn whenever keys are configured or
 * auth is enforced). Sessions and OIDC take their tenant from membership, never
 * `'*'`. This pins the remaining lane a tenant CAN mint, the self-service `owk_`
 * key, which resolves to `tenants: [key.tenantId]`:
 *   - it cannot be ISSUED for `'*'`;
 *   - a stored `'*'` row (however it got there) never AUTHENTICATES.
 *
 * Tracker TST-BLO-2. Sabotage-witnessed (w62): red when the mint stops refusing
 * '*' or verify stops refusing a stored '*' row.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { issueApiKey, verifyApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

describe('ADR 0823 — an owk_ key can never be a wildcard principal', () => {
  it('issuing a key for tenant "*" is refused', async () => {
    await expect(issueApiKey({ tenantId: '*', name: 'x', createdBy: 'u1' })).rejects.toMatchObject({ httpStatus: 400, message: 'a self-service key cannot be cross-tenant.' });
  });

  it('a stored "*" key row never verifies (and the same row verifies under a real tenant)', async () => {
    const { token } = await issueApiKey({ tenantId: 'org:owk-wild', name: 'k', createdBy: 'u1' });
    expect((await verifyApiKey(token))?.tenantId).toBe('org:owk-wild'); // control

    const storage = __hostExtStorage()!;
    const rows = (await storage.kvList('hostext:devkey:record:')).filter((r) => r.value.includes('"org:owk-wild"'));
    expect(rows, 'the probe must find exactly the stored key row').toHaveLength(1);
    await storage.kvSet(rows[0]!.key, JSON.stringify({ ...JSON.parse(rows[0]!.value), tenantId: '*' }));

    expect(await verifyApiKey(token)).toBeNull();
  });
});
