/**
 * `isWorkspaceMember` bounded lookup + fail-safe (ADR 0434 / IDN-7).
 *
 * This runs on EVERY authenticated request and, since ADR 0434 P4, at session
 * mint too. It used to be `members.list()` — a full CROSS-TENANT scan whose cost
 * grew with total members across all tenants. Same shape as this repo's prior
 * `host_ext_kv` prefix-scan incident, on the hottest path in the app.
 *
 * The safety property pinned here is the one that makes a secondary index
 * acceptable on an AUTHORIZATION path: the tenant index tolerates a missing
 * marker ("delayed, not lost"), which is harmless for retention but would be a
 * FALSE NEGATIVE here — locking a real member out of their own workspace. So a
 * negative from the index is always confirmed against the primary rows.
 *
 * THREE lookup paths (`accessControlService.ts` `isWorkspaceMember`): the
 * `access-member-index` point read, the tenant-indexed slice
 * (`listForTenantIndexed`), then the authoritative `members.list()`. A normal
 * member is found by the first, so the fail-safe case below deletes BOTH index
 * entries from raw storage before asserting — otherwise the fallback is never
 * reached (round-1 probe `8fw5g4-wml-fallback` was vacuous for exactly that).
 * Members are created in `beforeAll`, so no case depends on another's order.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  createMember,
  createWorkspace,
  deleteMember,
  isWorkspaceMember,
} from '../src/host/accessControlService.js';

let wsA = '';
let wsB = '';
let storage: Storage;
let carolMemberId = '';

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  const a = await createWorkspace({ name: 'Acme', ownerSubject: 'oidc:owner-a' });
  const b = await createWorkspace({ name: 'Beta', ownerSubject: 'oidc:owner-b' });
  wsA = a.tenantId;
  wsB = b.tenantId;
  // Every case's fixtures, created up front so shuffle cannot reorder a case
  // ahead of the member it reads.
  await createMember({ orgId: wsA, tenantId: wsA, subject: 'oidc:alice', displayName: 'Alice' });
  carolMemberId = (await createMember({ orgId: wsA, tenantId: wsA, subject: 'oidc:carol', displayName: 'Carol' })).memberId;
});

describe('isWorkspaceMember', () => {
  it('finds a member of the workspace', async () => {
    await expect(isWorkspaceMember('oidc:alice', wsA)).resolves.toBe(true);
  });

  it('does NOT leak membership across workspaces', async () => {
    // Alice is in wsA only — the bounded scan must not match her against wsB.
    // Positive control first, so the negative is not "alice does not exist".
    await expect(isWorkspaceMember('oidc:alice', wsA)).resolves.toBe(true);
    await expect(isWorkspaceMember('oidc:alice', wsB)).resolves.toBe(false);
  });

  it('returns false for a subject with no membership anywhere', async () => {
    await expect(isWorkspaceMember('oidc:nobody', wsA)).resolves.toBe(false);
  });

  it('the workspace owner is a member', async () => {
    await expect(isWorkspaceMember('oidc:owner-a', wsA)).resolves.toBe(true);
  });

  it('revocation takes effect IMMEDIATELY — no cache, no TTL', async () => {
    const m = await createMember({ orgId: wsA, tenantId: wsA, subject: 'oidc:bob', displayName: 'Bob' });
    await expect(isWorkspaceMember('oidc:bob', wsA)).resolves.toBe(true);
    await deleteMember(m.memberId);
    // The whole reason this check is per-request: a removed member loses access
    // on the very next request, not after a cache window.
    await expect(isWorkspaceMember('oidc:bob', wsA)).resolves.toBe(false);
  });

  it('a member whose index marker is missing is STILL found (fail-safe)', async () => {
    // A negative lookup runs `listForTenantIndexed`, whose one-time backfill would
    // otherwise re-create the markers deleted below.
    await expect(isWorkspaceMember('oidc:nobody', wsA)).resolves.toBe(false);
    // The "delayed, not lost" gap, made real: drop BOTH index entries for carol from
    // raw storage — the point-read row and the tenant-slice marker. Keys are the
    // `DurableCollection` layout (`hostext:<name>:<id>`, `hostextidx:<name>:<tenant>:<id>`).
    expect(await storage.kvDelete(`hostext:access-member-index:${wsA}::oidc:carol`)).toBe(true);
    expect(await storage.kvDelete(`hostextidx:access-members:${wsA}:${carolMemberId}`)).toBe(true);
    // Only the authoritative primary rows can find her now.
    await expect(isWorkspaceMember('oidc:carol', wsA)).resolves.toBe(true);
  });
});
