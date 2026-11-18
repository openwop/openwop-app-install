/**
 * #6053 step 1 — stored undeclared (`[]`) keys become an explicit `['*']`.
 *
 * Off unless `OPENWOP_API_KEY_UNDECLARED_REWRITE` is set. `report` counts per tenant
 * and writes nothing; `apply` rewrites, and a second run changes nothing. A key that
 * already names scopes is untouched. Red when: report writes, apply misses a row,
 * apply is not idempotent, or a declared key is touched.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { __issueUndeclaredLegacyKeyForTest, issueApiKey, listApiKeys, rewriteUndeclaredKeys, undeclaredRewriteMode } from '../src/features/developer-keys/apiKeyService.js';
import { keyDeclarationPermits } from '../src/host/delegatedSubject.js';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
afterEach(() => { delete process.env.OPENWOP_API_KEY_UNDECLARED_REWRITE; });

const ADMIN = { isAdmin: true, callerSubject: 'user:x' };
const scopesOf = async (t: string): Promise<string[][]> => (await listApiKeys(t, ADMIN)).map((k) => k.scopes).sort();

describe('#6053 step 1 — the undeclared-key rewrite', () => {
  it('is off unless asked', () => {
    expect(undeclaredRewriteMode()).toBeNull();
    process.env.OPENWOP_API_KEY_UNDECLARED_REWRITE = 'report';
    expect(undeclaredRewriteMode()).toBe('report');
  });

  it('report counts per tenant and writes nothing; apply rewrites to [*] once', async () => {
    const A = `t6053-a-${Date.now()}`;
    const B = `t6053-b-${Date.now()}`;
    await __issueUndeclaredLegacyKeyForTest({ tenantId: A, name: 'l1', createdBy: 'user:x' });
    await __issueUndeclaredLegacyKeyForTest({ tenantId: A, name: 'l2', createdBy: 'user:x' });
    await __issueUndeclaredLegacyKeyForTest({ tenantId: B, name: 'l3', createdBy: 'user:x' });
    await issueApiKey({ tenantId: A, name: 'named', createdBy: 'user:x', scopes: ['workspace:read'] });

    const report = await rewriteUndeclaredKeys('report');
    expect(report.byTenant[A]).toBe(2);
    expect(report.byTenant[B]).toBe(1);
    expect(report.rewritten).toBe(0);
    expect(await scopesOf(A)).toEqual([[], [], ['workspace:read']]);

    await rewriteUndeclaredKeys('apply');
    expect(await scopesOf(A)).toEqual([['*'], ['*'], ['workspace:read']]);
    expect(await scopesOf(B)).toEqual([['*']]);
    const again = await rewriteUndeclaredKeys('apply');
    expect(again.byTenant[A] ?? 0).toBe(0);
    expect(again.rewritten).toBe(0);
  });

  it('the rewrite keeps exactly the old authority', () => {
    for (const scope of ['workspace:read', 'runs:create', 'entities:admin']) {
      expect(keyDeclarationPermits(['*'], scope)).toBe(keyDeclarationPermits([], scope));
    }
  });
});
