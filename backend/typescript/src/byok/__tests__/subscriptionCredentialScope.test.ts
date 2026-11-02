/**
 * RFC 0121 §B.8 — `subscription-credential-user-scope-only` invariant (rail-(a)).
 *
 * The acquisition-FREE safety rail: a subscription-mode credential (a reused
 * personal consumer subscription) MUST bind at `user` scope; a `tenant`/`workspace`
 * bind is rejected with `credential_scope_forbidden` (403) — the exact cross-user
 * sharing the invariant exists to prevent. This is the applied-control witness for
 * the enforcement the live bind seam (`POST /v1/host/openwop-app/credentials/bind`,
 * routes/agents.ts) calls UNCONDITIONALLY before any consent/acquisition. Enforced
 * with no `subscription` advertisement and no credential acquisition (both deferred
 * on RFC 0121 UQ1 legal/ToS clearance), so it carries zero ToS risk.
 *
 * Sabotage-witnessed (grade-tests w74): letting `tenant` through, turning the
 * `scope !== 'user'` allowlist into a tenant/workspace denylist, answering 400, accepting
 * any truthy storage tenant, dereferencing an undefined one, or answering the storage
 * refusal with another code each reds its case. The scope-field cases have a unit twin in
 * `test/subscription-credential-scope.unit.test.ts` (kept: protected, dedupe on a human
 * ask); the STORAGE half is unique at unit level.
 */
import { describe, it, expect } from 'vitest';
import { assertSubscriptionScopeAllowed, assertSubscriptionStorageTenant } from '../subscriptionCredentialScope.js';
import { OpenwopError } from '../../types.js';

/** Run `fn`, return what it threw (undefined when it did not throw). */
function thrown(fn: () => void): unknown {
  try { fn(); } catch (e) { return e; }
  return undefined;
}

const FORBIDDEN = { code: 'credential_scope_forbidden', httpStatus: 403 };

describe('RFC 0121 §B.8 subscription-credential-user-scope-only', () => {
  it('permits a `user`-scope subscription bind (the only allowed scope)', () => {
    expect(() => assertSubscriptionScopeAllowed('user')).not.toThrow();
  });

  it('rejects a `tenant`-scope bind with credential_scope_forbidden (403)', () => {
    const err = thrown(() => assertSubscriptionScopeAllowed('tenant'));
    expect(err).toBeInstanceOf(OpenwopError);
    expect(err).toMatchObject(FORBIDDEN);
  });

  it('rejects a `workspace`-scope bind with credential_scope_forbidden (403)', () => {
    const err = thrown(() => assertSubscriptionScopeAllowed('workspace'));
    expect(err).toBeInstanceOf(OpenwopError);
    expect(err).toMatchObject(FORBIDDEN);
  });

  it('rejects any non-`user` scope (fail-closed on unknown scope strings)', () => {
    for (const scope of ['', 'org', 'global', 'default', 'TENANT']) {
      const err = thrown(() => assertSubscriptionScopeAllowed(scope));
      expect(err, `scope='${scope}' must be forbidden`).toBeInstanceOf(OpenwopError);
      expect(err, `scope='${scope}' must be forbidden`).toMatchObject(FORBIDDEN);
    }
  });
});

describe('RFC 0121 §B.8 subscription-credential STORAGE-tenant rail (grade-code, storage-side)', () => {
  it('permits storage in the caller’s own `user:`-scoped personal tenant', () => {
    expect(() => assertSubscriptionStorageTenant('user:abc123')).not.toThrow();
  });

  it('rejects a shared `ws:` workspace tenant with credential_scope_forbidden (403)', () => {
    // The exact leak the field-scope check misses: a signed-in user acting in a shared
    // workspace passes `scope:"user"` but their active tenant is `ws:` → must fail closed.
    const err = thrown(() => assertSubscriptionStorageTenant('ws:team-uuid'));
    expect(err).toBeInstanceOf(OpenwopError);
    expect(err).toMatchObject(FORBIDDEN);
  });

  it('rejects anon / default / undefined personal tenants (fail-closed, no durable owner)', () => {
    for (const t of ['anon:sid', 'default', '', undefined]) {
      const err = thrown(() => assertSubscriptionStorageTenant(t));
      expect(err, `personalTenant='${String(t)}' must be forbidden`).toBeInstanceOf(OpenwopError);
      expect(err, `personalTenant='${String(t)}' must be forbidden`).toMatchObject(FORBIDDEN);
    }
  });
});
