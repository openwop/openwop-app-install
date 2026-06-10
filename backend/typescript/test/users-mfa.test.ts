/**
 * TOTP MFA — RFC 6238 (ADR 0002, Phase 5).
 *
 * Verifies the second-factor invariants:
 *  - enrollment is two-step: pending until a live TOTP activates it (no lockout
 *    from a half-finished enrollment);
 *  - an active enrollment verifies a correct TOTP and rejects a wrong one
 *    (constant-time, ±1 step window);
 *  - recovery codes are single-use;
 *  - fail-closed: an unknown / pending user verifies to false (finding H5);
 *  - disable removes the factor.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { activate, beginEnrollment, disableMfa, isMfaActive, totp, verify, __resetMfaStore } from '../src/features/users/mfaService.js';

const dir = mkdtempSync(join(tmpdir(), 'owop-mfa-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('TOTP MFA (RFC 6238)', () => {
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(join(dir, 'mfa.db')));
    await __resetMfaStore();
  });

  it('enrollment is pending until a live TOTP activates it', async () => {
    const { secretBase32, otpauthUri, recoveryCodes } = await beginEnrollment({ tenantId: 't', userId: 'user:1', accountLabel: 'a@t.test' });
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(recoveryCodes).toHaveLength(8);
    expect(await isMfaActive('user:1')).toBe(false); // pending, not active
    // a wrong code does not activate
    expect(await activate({ userId: 'user:1', token: '000000' })).toBe(false);
    expect(await isMfaActive('user:1')).toBe(false);
    // the live code activates
    expect(await activate({ userId: 'user:1', token: totp(secretBase32) })).toBe(true);
    expect(await isMfaActive('user:1')).toBe(true);
    // re-enrolling while ACTIVE throws a clean 409 conflict, not a bare Error/500 (finding #6)
    await expect(beginEnrollment({ tenantId: 't', userId: 'user:1', accountLabel: 'a@t.test' })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('verifies a correct TOTP, rejects a wrong one, and rejects replay (finding #6)', async () => {
    const t0 = Date.now();
    const { secretBase32 } = await beginEnrollment({ tenantId: 't', userId: 'user:2', accountLabel: 'b@t.test' });
    await activate({ userId: 'user:2', token: totp(secretBase32, t0), atMs: t0 });
    // A later step verifies (activation already consumed step t0).
    const t1 = t0 + 60_000;
    expect(await verify({ userId: 'user:2', token: totp(secretBase32, t1), atMs: t1 })).toBe(true);
    expect(await verify({ userId: 'user:2', token: '123456', atMs: t1 })).toBe(false);
    // Replay protection: the SAME code at the SAME step is now rejected (RFC 6238 §5.2).
    expect(await verify({ userId: 'user:2', token: totp(secretBase32, t1), atMs: t1 })).toBe(false);
    // ...and a code at or before the last-used step is rejected.
    expect(await verify({ userId: 'user:2', token: totp(secretBase32, t0), atMs: t0 })).toBe(false);
  });

  it('recovery codes are single-use', async () => {
    const { secretBase32, recoveryCodes } = await beginEnrollment({ tenantId: 't', userId: 'user:3', accountLabel: 'c@t.test' });
    await activate({ userId: 'user:3', token: totp(secretBase32) });
    const code = recoveryCodes[0];
    expect(await verify({ userId: 'user:3', token: code })).toBe(true);
    expect(await verify({ userId: 'user:3', token: code })).toBe(false); // consumed
  });

  it('fail-closed for unknown / pending users; disable removes the factor', async () => {
    expect(await verify({ userId: 'ghost', token: '000000' })).toBe(false); // unknown
    const { secretBase32 } = await beginEnrollment({ tenantId: 't', userId: 'user:4', accountLabel: 'd@t.test' });
    expect(await verify({ userId: 'user:4', token: totp(secretBase32) })).toBe(false); // pending, not active
    await activate({ userId: 'user:4', token: totp(secretBase32) });
    expect(await isMfaActive('user:4')).toBe(true);
    await disableMfa('user:4');
    expect(await isMfaActive('user:4')).toBe(false);
    expect(await verify({ userId: 'user:4', token: totp(secretBase32) })).toBe(false);
  });
});
