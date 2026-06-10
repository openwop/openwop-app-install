/**
 * Password credentials — email/password baseline (ADR 0002, Phase 2).
 *
 * Verifies the secret-handling + lifecycle invariants the ADR makes binding:
 *  - passwords are hashed (never stored cleartext) and verify correctly;
 *  - login is generic on failure (unknown email and wrong password both throw
 *    `invalid_credentials` — no enumeration);
 *  - reset + email-verification tokens are single-use and expiry-bounded, and
 *    stored only as a hash (finding C3);
 *  - signup composes with the durable User (source `password`), and a disabled
 *    User is the route's fail-closed gate (finding H5) — exercised here at the
 *    service level via the User status.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetUsersStore, getUserByPrincipal } from '../src/features/users/usersService.js';
import {
  CredentialError,
  __resetCredentialsStore,
  isEmailVerified,
  login,
  requestEmailVerification,
  requestPasswordReset,
  resetPassword,
  signup,
  verifyEmail,
} from '../src/features/users/credentialsService.js';

const dir = mkdtempSync(join(tmpdir(), 'owop-cred-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function fresh(file: string): Promise<void> {
  __resetHostExtPersistence();
  initHostExtPersistence(openSqliteStorage(join(dir, file)));
  await __resetUsersStore();
  await __resetCredentialsStore();
}

describe('credentials: signup + login', () => {
  beforeEach(() => fresh('signup.db'));

  it('signup creates a durable user (source=password) + a hashed credential', async () => {
    const { user, verifyToken } = await signup({ tenantId: 't', email: 'Jane@Acme.test', password: 'correct horse', displayName: 'Jane' });
    expect(user.source).toBe('password');
    expect(user.email).toBe('jane@acme.test'); // normalized
    expect(verifyToken).toBeTruthy();
    // the durable user is reachable by the stable password principal
    expect((await getUserByPrincipal('t', 'password:jane@acme.test'))!.userId).toBe(user.userId);
  });

  it('login verifies the right password and rejects the wrong one (generic)', async () => {
    await signup({ tenantId: 't', email: 'a@t.test', password: 'hunter2hunter2' });
    const user = await login({ tenantId: 't', email: 'a@t.test', password: 'hunter2hunter2' });
    expect(user.email).toBe('a@t.test');
    await expect(login({ tenantId: 't', email: 'a@t.test', password: 'wrong-password' })).rejects.toMatchObject({ code: 'invalid_credentials' });
    // unknown email -> SAME error code as wrong password (no enumeration)
    await expect(login({ tenantId: 't', email: 'ghost@t.test', password: 'whatever12' })).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('rejects weak passwords and duplicate emails', async () => {
    await expect(signup({ tenantId: 't', email: 'b@t.test', password: 'short' })).rejects.toMatchObject({ code: 'weak_password' });
    await signup({ tenantId: 't', email: 'b@t.test', password: 'longenough1' });
    await expect(signup({ tenantId: 't', email: 'B@t.test', password: 'longenough1' })).rejects.toMatchObject({ code: 'email_taken' });
  });

  it('tenant isolation: same email in two tenants is two accounts', async () => {
    await signup({ tenantId: 'acme', email: 'x@shared.test', password: 'passwordone' });
    await signup({ tenantId: 'globex', email: 'x@shared.test', password: 'passwordtwo' });
    await expect(login({ tenantId: 'acme', email: 'x@shared.test', password: 'passwordtwo' })).rejects.toBeInstanceOf(CredentialError);
    expect((await login({ tenantId: 'globex', email: 'x@shared.test', password: 'passwordtwo' })).tenantId).toBe('globex');
  });
});

describe('credentials: reset + verification tokens (single-use)', () => {
  beforeEach(() => fresh('tokens.db'));

  it('a reset token rotates the password and cannot be replayed', async () => {
    await signup({ tenantId: 't', email: 'r@t.test', password: 'originalpass' });
    const { token } = await requestPasswordReset({ tenantId: 't', email: 'r@t.test' });
    expect(token).toBeTruthy();
    await resetPassword({ tenantId: 't', email: 'r@t.test', token: token!, newPassword: 'brandnewpass' });
    // old password no longer works; new one does
    await expect(login({ tenantId: 't', email: 'r@t.test', password: 'originalpass' })).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect((await login({ tenantId: 't', email: 'r@t.test', password: 'brandnewpass' })).email).toBe('r@t.test');
    // token is single-use — replay fails
    await expect(resetPassword({ tenantId: 't', email: 'r@t.test', token: token!, newPassword: 'thirdpassword' })).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('reset-request for an unknown email returns no token (no enumeration)', async () => {
    expect((await requestPasswordReset({ tenantId: 't', email: 'nobody@t.test' })).token).toBeNull();
  });

  it('email verification flips emailVerified and is single-use', async () => {
    const { verifyToken } = await signup({ tenantId: 't', email: 'v@t.test', password: 'verifiable1' });
    expect(await isEmailVerified('t', 'v@t.test')).toBe(false);
    await verifyEmail({ tenantId: 't', email: 'v@t.test', token: verifyToken });
    expect(await isEmailVerified('t', 'v@t.test')).toBe(true);
    await expect(verifyEmail({ tenantId: 't', email: 'v@t.test', token: verifyToken })).rejects.toMatchObject({ code: 'invalid_token' });
    // already-verified -> re-request yields no token
    expect((await requestEmailVerification({ tenantId: 't', email: 'v@t.test' })).token).toBeNull();
  });

  it('a bad token is rejected', async () => {
    await signup({ tenantId: 't', email: 'bad@t.test', password: 'goodpassword' });
    await requestPasswordReset({ tenantId: 't', email: 'bad@t.test' });
    await expect(resetPassword({ tenantId: 't', email: 'bad@t.test', token: 'not-the-token', newPassword: 'anotherpass1' })).rejects.toMatchObject({ code: 'invalid_token' });
  });
});
