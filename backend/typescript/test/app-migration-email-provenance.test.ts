/**
 * ADR 0622 D7 review S2 — app migration 20 `stamp-user-email-provenance`.
 *
 * The gate reads a MISSING `User.emailProvenance` as `'self'` (fail-closed);
 * this one-shot boot stamp is what keeps that from refusing every legitimate
 * legacy accept. It assigns the provenance the row's LANE implies:
 *   'idp'   iff source ∈ {saml, scim}
 *   'self'  iff the row lives in a personal tenant (user: / anon:)
 *   'admin' otherwise (a shared-workspace row)
 * and never touches a row that is already stamped or has no email. Idempotent,
 * per-row CAS, never throws. `source:'oidc'` is deliberately NOT 'idp' — the
 * OIDC lane never wrote an email before USERS-20.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { APP_MIGRATIONS } from '../src/host/appMigrations.js';
import { __resetUsersStore, backfillEmailProvenance, effectiveEmailProvenance, getUser, type User } from '../src/features/users/usersService.js';

// A raw handle on the SAME namespace `usersService` uses, so the test can
// write LEGACY rows (no `emailProvenance`) — `createUser` always stamps one now.
const raw = new DurableCollection<User>('users:user', (u) => u.userId);

function legacy(userId: string, tenantId: string, source: User['source'], email?: string): User {
  const now = '2026-01-01T00:00:00.000Z';
  return { userId, tenantId, principalId: `${source}:${userId}`, groups: [], source, status: 'active', createdAt: now, updatedAt: now, ...(email ? { email } : {}) };
}

describe('app migration 20 — stamp-user-email-provenance', () => {
  beforeEach(async () => {
    const s = await openStorage('memory://');
    initHostExtPersistence(s);
    await __resetUsersStore();
  });

  it('is in the real APP_MIGRATIONS set, after 19', () => {
    const m = APP_MIGRATIONS.find((x) => x.name === 'stamp-user-email-provenance');
    expect(m).toBeTruthy();
    expect(m!.version).toBe(20);
    expect(APP_MIGRATIONS.filter((x) => x.version === 20)).toHaveLength(1);
  });

  it('stamps each unstamped row from its LANE; leaves stamped and address-less rows alone', async () => {
    await raw.put(legacy('user:saml1', 'ws:acme', 'saml', 'a@acme.test'));
    await raw.put(legacy('user:scim1', 'ws:acme', 'scim', 'b@acme.test'));
    await raw.put(legacy('user:oidc-personal', 'user:abc', 'oidc', 'c@acme.test'));
    await raw.put(legacy('user:pw-anon', 'anon:xyz', 'password', 'd@acme.test'));
    await raw.put(legacy('user:oidc-shared', 'ws:acme', 'oidc', 'e@acme.test'));
    await raw.put(legacy('user:manual-shared', 'ws:acme', 'manual', 'f@acme.test'));
    await raw.put(legacy('user:no-email', 'ws:acme', 'manual'));
    await raw.put({ ...legacy('user:already', 'user:def', 'oidc', 'g@acme.test'), emailProvenance: 'idp' });

    // Before the stamp: every unstamped emailed row reads as self (fail-closed).
    expect(effectiveEmailProvenance((await getUser('user:saml1'))!)).toBe('self');

    const r = await backfillEmailProvenance();
    expect(r).toMatchObject({ examined: 8, stamped: 6, idp: 2, self: 2, admin: 2, casLost: 0, failed: 0 });

    expect((await getUser('user:saml1'))!.emailProvenance).toBe('idp');
    expect((await getUser('user:scim1'))!.emailProvenance).toBe('idp');
    expect((await getUser('user:oidc-personal'))!.emailProvenance).toBe('self');
    expect((await getUser('user:pw-anon'))!.emailProvenance).toBe('self');
    expect((await getUser('user:oidc-shared'))!.emailProvenance).toBe('admin');
    expect((await getUser('user:manual-shared'))!.emailProvenance).toBe('admin');
    expect((await getUser('user:no-email'))!.emailProvenance).toBeUndefined();
    expect((await getUser('user:already'))!.emailProvenance).toBe('idp'); // never re-derived
  });

  it('is idempotent and concurrency-safe: a second run (and two concurrent runs) stamp nothing new', async () => {
    await raw.put(legacy('user:s', 'ws:acme', 'saml', 'a@acme.test'));
    await raw.put(legacy('user:p', 'user:abc', 'password', 'b@acme.test'));
    const [r1, r2] = await Promise.all([backfillEmailProvenance(), backfillEmailProvenance()]);
    expect(r1.stamped + r2.stamped).toBe(2); // each row stamped exactly once across both
    expect(r1.failed + r2.failed).toBe(0);
    const r3 = await backfillEmailProvenance();
    expect(r3).toMatchObject({ examined: 2, stamped: 0, casLost: 0, failed: 0 });
    expect((await getUser('user:s'))!.emailProvenance).toBe('idp');
    expect((await getUser('user:p'))!.emailProvenance).toBe('self');
  });

  it('the real migration entry runs the backfill (the wiring, not just the mechanism)', async () => {
    await raw.put(legacy('user:wired', 'ws:acme', 'scim', 'w@acme.test'));
    const m = APP_MIGRATIONS.find((x) => x.version === 20)!;
    const s = await openStorage('memory://');
    await m.run(s); // the entry ignores `storage` — it reads the host-ext collection
    expect((await getUser('user:wired'))!.emailProvenance).toBe('idp');
  });
});
