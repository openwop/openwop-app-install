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
 * @see docs/adr/0517-byok-active-config-durability.md
 */
import { describe, expect, it } from 'vitest';
import { planHostExtRekey } from '../src/storage/tenantMigration.js';

const ANON = 'anon:AbCd1234';
const USER = 'user:c51185914124375f328788edbc4a29f8';

/** The row a chat binding actually writes: `DurableCollection('host:chatByokConfig', c => c.tenantId)`. */
const bindingKey = (tenant: string) => `hostext:host:chatByokConfig:${tenant}`;
const bindingValue = (tenant: string) => JSON.stringify({
  tenantId: tenant,
  provider: 'google',
  model: 'gemini-3.1-flash-lite',
  credentialRef: 'byok:google',
  updatedAt: '2026-08-05T00:00:00.000Z',
});

describe('chat BYOK binding survives the anon → user fold (ADR 0517 / ADR 0003 P4c)', () => {
  it('MOVES the row to the user tenant — key AND value', () => {
    const action = planHostExtRekey(bindingKey(ANON), bindingValue(ANON), ANON, USER);

    // `value` alone would be the bug: the JSON would say `user:` while the row
    // KEY still said `anon:`, so `getChatByokConfig(userTenant)` would miss it
    // and the user would be asked for a key they had already given us.
    expect(action.kind).toBe('move');
    if (action.kind !== 'move') return;
    expect(action.k).toBe(bindingKey(USER));
    expect(JSON.parse(action.v)).toMatchObject({ tenantId: USER, credentialRef: 'byok:google' });
  });

  it('leaves another tenant\'s binding completely alone', () => {
    const other = 'anon:SomeoneElse';
    expect(planHostExtRekey(bindingKey(other), bindingValue(other), ANON, USER).kind).toBe('none');
  });

  it('is idempotent — re-running the fold on an already-migrated row is a no-op', () => {
    // The route is best-effort and retried (migrateTenant.ts retries on failure),
    // so a second pass must not resurrect or duplicate the binding.
    expect(planHostExtRekey(bindingKey(USER), bindingValue(USER), ANON, USER).kind).toBe('none');
  });
});
