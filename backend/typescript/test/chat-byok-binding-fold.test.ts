/**
 * Does an anonymous visitor's chat binding follow them into their account?
 *
 * WHY THIS TEST EXISTS. I filed this as a data gap (`DATA-1`) after reading
 * `routes/migrate.ts`'s header comment, which lists only `runs.tenant_id`,
 * `workflows.tenant_id` and BYOK secrets — no host-ext rows. That comment is
 * incomplete: the implementation calls `reassignTenant`, which re-keys host-ext
 * KV by INTROSPECTION, and `planHostExtRekey` returns a `move` for a row whose
 * KEY encodes the tenant (which `host:chatByokConfig` is, since the collection
 * keys by `tenantId`).
 *
 * So the finding was wrong — for the second time in this session, from the same
 * root cause: reading a doc comment as if it were the implementation. This test
 * replaces that reading with a fact, and leaves a guard either way. If the fold
 * ever stops carrying the binding, an anonymous visitor who set up a key and
 * then signed in would silently land on the first-run wizard — the exact class
 * of false prompt ADR 0517 exists to remove.
 *
 * Tracker TST-CEB-1 (/grade-tests w67). The first version planned a rekey of a
 * HAND-COPIED key (`hostext:host:chatByokConfig:<tenant>`), which tested the
 * generic rekey (already pinned by `reassign-tenant-key-rewrite.test.ts`) and
 * never the real binding row. Every case now writes through the REAL writer
 * (`setChatByokConfig`) and reads back through the REAL reader
 * (`getChatByokConfig`) across a real `storage.reassignTenant`.
 * Red when (w67g3, witnessed): `planHostExtRekey` moves the value but keeps the
 * old key.
 *
 * @see docs/adr/0517-byok-active-config-durability.md
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { getChatByokConfig, setChatByokConfig } from '../src/host/chatByokConfig.js';

const ANON = 'anon:AbCd1234';
const USER = 'user:c51185914124375f328788edbc4a29f8';
const NOW = '2026-08-05T00:00:00.000Z';
// A `managed:` ref names no stored secret, so the real writer accepts it without a
// BYOK vault entry — the binding row itself is what this file is about.
const BINDING = { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'managed:openwop-free' };

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('chat BYOK binding survives the anon → user fold (ADR 0517 / ADR 0003 P4c)', () => {
  it('MOVES the row to the user tenant — key AND value', async () => {
    await setChatByokConfig({ tenantId: ANON }, BINDING, NOW);
    expect(await getChatByokConfig(ANON)).not.toBeNull(); // the seed landed

    await storage.reassignTenant(ANON, USER);

    // A value-only rewrite would be the bug: the JSON would say `user:` while the
    // row KEY still said `anon:`, so `getChatByokConfig(userTenant)` would miss it
    // and the user would be asked for a key they had already given us.
    expect(await getChatByokConfig(USER)).toMatchObject({ tenantId: USER, provider: 'google', credentialRef: 'managed:openwop-free' });
    expect(await getChatByokConfig(ANON)).toBeNull();
  });

  it('leaves another tenant\'s binding completely alone', async () => {
    const other = 'anon:SomeoneElse';
    await setChatByokConfig({ tenantId: ANON }, BINDING, NOW);
    await setChatByokConfig({ tenantId: other }, { ...BINDING, model: 'other-model' }, NOW);

    await storage.reassignTenant(ANON, USER);

    expect(await getChatByokConfig(other)).toMatchObject({ tenantId: other, model: 'other-model' });
    expect(await getChatByokConfig(USER)).toMatchObject({ tenantId: USER, model: 'gemini-3.1-flash-lite' });
  });

  it('is idempotent — re-running the fold on an already-migrated row is a no-op', async () => {
    // The route is best-effort and retried (migrateTenant.ts retries on failure),
    // so a second pass must not resurrect or duplicate the binding.
    await setChatByokConfig({ tenantId: ANON }, BINDING, NOW);
    await storage.reassignTenant(ANON, USER);
    const again = await storage.reassignTenant(ANON, USER);
    expect(again.hostExtKeysRekeyed).toBe(0);
    expect(await getChatByokConfig(USER)).toMatchObject({ tenantId: USER, credentialRef: 'managed:openwop-free' });
    expect(await getChatByokConfig(ANON)).toBeNull();
  });
});
