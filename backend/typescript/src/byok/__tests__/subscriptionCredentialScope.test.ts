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
 */
import { describe, it, expect } from 'vitest';
import { assertSubscriptionScopeAllowed, assertSubscriptionStorageTenant } from '../subscriptionCredentialScope.js';
import { OpenwopError } from '../../types.js';

describe('RFC 0121 §B.8 subscription-credential-user-scope-only', () => {
  it('permits a `user`-scope subscription bind (the only allowed scope)', () => {
    expect(() => assertSubscriptionScopeAllowed('user')).not.toThrow();
  });

  it('rejects a `tenant`-scope bind with credential_scope_forbidden (403)', () => {
    try {
      assertSubscriptionScopeAllowed('tenant');
      throw new Error('expected assertSubscriptionScopeAllowed to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OpenwopError);
      const e = err as OpenwopError;
      expect(e.code).toBe('credential_scope_forbidden');
      expect(e.httpStatus).toBe(403);
    }
  });

  it('rejects a `workspace`-scope bind with credential_scope_forbidden (403)', () => {
    try {
      assertSubscriptionScopeAllowed('workspace');
      throw new Error('expected assertSubscriptionScopeAllowed to throw');
    } catch (err) {
      expect((err as OpenwopError).code).toBe('credential_scope_forbidden');
      expect((err as OpenwopError).httpStatus).toBe(403);
    }
  });

  it('rejects any non-`user` scope (fail-closed on unknown scope strings)', () => {
    for (const scope of ['', 'org', 'global', 'default', 'TENANT']) {
      expect(() => assertSubscriptionScopeAllowed(scope), `scope='${scope}' must be forbidden`).toThrowError(
        /credential_scope_forbidden|user scope/,
      );
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
    try {
      assertSubscriptionStorageTenant('ws:team-uuid');
      throw new Error('expected assertSubscriptionStorageTenant to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OpenwopError);
      expect((err as OpenwopError).code).toBe('credential_scope_forbidden');
      expect((err as OpenwopError).httpStatus).toBe(403);
    }
  });

  it('rejects anon / default / undefined personal tenants (fail-closed, no durable owner)', () => {
    for (const t of ['anon:sid', 'default', '', undefined]) {
      expect(
        () => assertSubscriptionStorageTenant(t),
        `personalTenant='${String(t)}' must be forbidden`,
      ).toThrowError(/credential_scope_forbidden|user-scoped/);
    }
  });
});
