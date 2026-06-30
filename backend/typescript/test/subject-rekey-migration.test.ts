/**
 * ADR 0003 Phase 4d — one-shot subject re-key (service unit).
 *
 * Verifies the maintenance migration that rewrites legacy-form OrgMember.subject
 * to the canonical `user:<userId>`:
 *   (a) a legacy `oidc:<sub>` subject whose user resolves → re-keyed
 *   (b) a member already `user:<id>` → untouched
 *   (c) a legacy subject with NO resolvable user → skipped (never invented)
 *   (d) idempotent re-run → 0 further rekeys
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  __resetAccessStores,
  createMember,
  ensurePersonalWorkspace,
  isWorkspaceMember,
  listTenantMembers,
} from '../src/host/accessControlService.js';
import { __resetUsersStore, createUser } from '../src/features/users/usersService.js';
import { rekeyLegacyMemberSubjects } from '../src/host/subjectRekeyMigration.js';

const TENANT = 'anon:tenant-4d';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage); // accessControl + users durable stores
});

beforeEach(async () => {
  await __resetAccessStores();
  await __resetUsersStore();
});

describe('ADR 0003 Phase 4d — rekeyLegacyMemberSubjects', () => {
  it('re-keys a resolvable legacy oidc subject, leaves canonical + unresolvable alone, and is idempotent', async () => {
    // (a) A durable user exists for a legacy oidc subject. Seed the personal
    // workspace owner member under that LEGACY subject (the pre-fix shape).
    const legacyOidc = 'oidc:sub-alice';
    const alice = await createUser({ tenantId: TENANT, principalId: legacyOidc, source: 'oidc' });
    expect(alice.userId.startsWith('user:')).toBe(true);
    await ensurePersonalWorkspace({ tenantId: TENANT, ownerSubject: legacyOidc, ownerDisplayName: 'Alice' });

    // (b) A member already keyed by the canonical `user:<id>` subject — must be
    // left untouched.
    const canonicalSubject = 'user:already-canonical';
    await createMember({
      orgId: TENANT,
      tenantId: TENANT,
      subject: canonicalSubject,
      displayName: 'Canon',
      roles: ['viewer'],
    });

    // (c) A legacy subject with NO durable user — must be SKIPPED (not invented).
    const orphanLegacy = 'session:no-such-user';
    await createMember({
      orgId: TENANT,
      tenantId: TENANT,
      subject: orphanLegacy,
      displayName: 'Orphan',
      roles: ['viewer'],
    });

    // Sanity: pre-migration the owner is keyed under the legacy oidc subject.
    expect(await isWorkspaceMember(legacyOidc, TENANT)).toBe(true);
    expect(await isWorkspaceMember(alice.userId, TENANT)).toBe(false);

    const result = await rekeyLegacyMemberSubjects(TENANT);

    // (a) the resolvable legacy member is re-keyed to `user:<userId>`.
    expect(result.scanned).toBe(3);
    expect(result.rekeyed).toBe(1);
    expect(result.skipped).toBe(2); // canonical + orphan
    expect(await isWorkspaceMember(alice.userId, TENANT)).toBe(true);
    expect(await isWorkspaceMember(legacyOidc, TENANT)).toBe(false);

    const subjects = (await listTenantMembers(TENANT)).map((m) => m.subject);
    // (b) the already-canonical subject is untouched.
    expect(subjects).toContain(canonicalSubject);
    // (c) the orphan legacy subject is NOT re-keyed and NO identity was invented.
    expect(subjects).toContain(orphanLegacy);
    expect(subjects).toContain(alice.userId);
    // No legacy oidc subject remains.
    expect(subjects).not.toContain(legacyOidc);

    // (d) idempotent re-run → 0 further rekeys.
    const second = await rekeyLegacyMemberSubjects(TENANT);
    expect(second.rekeyed).toBe(0);
    expect(second.scanned).toBe(3);
    expect(second.skipped).toBe(3);
  });
});
