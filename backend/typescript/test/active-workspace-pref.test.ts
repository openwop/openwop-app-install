/**
 * Server-side last-active-workspace (ADR 0434 Phase 4).
 *
 * The defect: switching workspaces produced exactly ONE side effect — a
 * `Set-Cookie`. Nothing was persisted server-side, and every session-mint path
 * hard-coded `tenantId = personalTenant`. So the active workspace was
 * device-local: switch on your laptop, open the app on your desktop, and you
 * silently landed in your personal tenant looking at different data. That
 * reproduces the "same account, different data on different machines" report
 * with NO failure condition required.
 *
 * The security-critical half is the resolution rule: a stored preference is
 * honored only while the subject is STILL a member. Otherwise a preference set
 * before a revocation would resurrect access at mint time, ahead of the
 * per-request revalidation in the auth middleware.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  clearActiveWorkspace,
  clearActiveWorkspaceIfPointingAt,
  resolveActiveWorkspace,
  setActiveWorkspace,
} from '../src/host/activeWorkspacePref.js';

const SUBJECT = 'oidc:user-1';
const PERSONAL = 'user:abc123';
const SHARED = 'ws:acme';

const isMember = async (): Promise<boolean> => true;
const notMember = async (): Promise<boolean> => false;

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});
afterEach(async () => {
  await clearActiveWorkspace(SUBJECT);
});

describe('resolveActiveWorkspace', () => {
  it('returns the personal tenant when no preference was ever stored', async () => {
    await expect(resolveActiveWorkspace(SUBJECT, PERSONAL, isMember)).resolves.toBe(PERSONAL);
  });

  it('restores the stored workspace on a NEW device — the whole point', async () => {
    await setActiveWorkspace(SUBJECT, SHARED);
    // A fresh mint carries no cookie; resolution is purely server-side.
    await expect(resolveActiveWorkspace(SUBJECT, PERSONAL, isMember)).resolves.toBe(SHARED);
  });

  it('FAILS CLOSED to the personal tenant when membership was revoked', async () => {
    await setActiveWorkspace(SUBJECT, SHARED);
    // The user was removed from ws:acme after setting the preference.
    await expect(resolveActiveWorkspace(SUBJECT, PERSONAL, notMember)).resolves.toBe(PERSONAL);
  });

  it('does not consult membership for the personal tenant itself', async () => {
    await setActiveWorkspace(SUBJECT, PERSONAL);
    // notMember would reject it if the guard were applied indiscriminately —
    // a caller is always the implicit owner of their own personal tenant.
    await expect(resolveActiveWorkspace(SUBJECT, PERSONAL, notMember)).resolves.toBe(PERSONAL);
  });

  it('is keyed on SUBJECT — one subject\'s preference never leaks to another', async () => {
    await setActiveWorkspace(SUBJECT, SHARED);
    await expect(resolveActiveWorkspace('oidc:other-user', PERSONAL, isMember)).resolves.toBe(PERSONAL);
  });

  it('last write wins', async () => {
    await setActiveWorkspace(SUBJECT, SHARED);
    await setActiveWorkspace(SUBJECT, 'ws:other');
    await expect(resolveActiveWorkspace(SUBJECT, PERSONAL, isMember)).resolves.toBe('ws:other');
  });

  it('clearing returns the subject to their personal tenant', async () => {
    await setActiveWorkspace(SUBJECT, SHARED);
    await clearActiveWorkspace(SUBJECT);
    await expect(resolveActiveWorkspace(SUBJECT, PERSONAL, isMember)).resolves.toBe(PERSONAL);
  });

  it('a throwing membership check resolves to the personal tenant, never the stored one', async () => {
    await setActiveWorkspace(SUBJECT, SHARED);
    const boom = async (): Promise<boolean> => { throw new Error('store down'); };
    await expect(resolveActiveWorkspace(SUBJECT, PERSONAL, boom)).resolves.toBe(PERSONAL);
  });
});

describe('clearActiveWorkspaceIfPointingAt (IDN-9 — membership removal)', () => {
  it('clears the preference when it points at the workspace they left', async () => {
    await setActiveWorkspace(SUBJECT, SHARED);
    await clearActiveWorkspaceIfPointingAt(SUBJECT, SHARED);
    await expect(resolveActiveWorkspace(SUBJECT, PERSONAL, isMember)).resolves.toBe(PERSONAL);
  });

  it('PRESERVES a preference pointing at a DIFFERENT workspace', async () => {
    // Losing membership in ws:other must not reset where they work in ws:acme —
    // an unconditional clear would be wrong.
    await setActiveWorkspace(SUBJECT, SHARED);
    await clearActiveWorkspaceIfPointingAt(SUBJECT, 'ws:other');
    await expect(resolveActiveWorkspace(SUBJECT, PERSONAL, isMember)).resolves.toBe(SHARED);
  });

  it('is a no-op when no preference exists', async () => {
    await clearActiveWorkspaceIfPointingAt('oidc:nobody', SHARED);
    await expect(resolveActiveWorkspace('oidc:nobody', PERSONAL, isMember)).resolves.toBe(PERSONAL);
  });
});
