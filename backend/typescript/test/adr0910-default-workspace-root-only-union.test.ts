/**
 * ADR 0910 D0 / P0 — a declared default workspace (`host-kicktodo`, ADR 0684) is
 * MEMBERSHIP-ROOTED for authority, like a `ws:` workspace: only the ROOT membership
 * is tenant-wide, so a sub-org row there grants nothing outside its sub-org.
 *
 * Before D0 the ADR 0815 D1b rules keyed on the `ws:` prefix and missed
 * `host-kicktodo`. A sub-org `owner` row (which an env key seeds as
 * `bearer:<first 8>` through `POST /orgs`) contributed OWNER_SCOPES to the
 * tenant-wide union and passed `requireKicktodoManage` — an unaudited seat keyed
 * to a credential prefix.
 *
 * Sabotage (witnessed): registering no membership-rooted workspaces (the pre-D0
 * shape) reds the sub-org-owner and bearer legs; reverting the union site
 * (`resolveSubjectScopesUnionDirect`) alone reds them too; widening
 * `isSharedWorkspaceTenant` to the default workspace reds the predicate leg.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  createMember, createOrg, isMembershipRootedWorkspace, isSharedWorkspaceTenant, registerMembershipRootedWorkspaces,
  resolveSubjectScopesUnion, resolveTenantLevelScopes,
} from '../src/host/accessControlService.js';
import { hasKicktodoManageAuthority, KICKTODO_MANAGE_SCOPE } from '../src/features/featureRoute.js';

const DEFAULT_WS = 'host-kicktodo-d0';
let n = 0;

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});
beforeEach(() => registerMembershipRootedWorkspaces([DEFAULT_WS]));

/** A workspace shaped like `host-kicktodo`: a system-owned root org, a participant
 *  root row (viewer), and a SUB-org whose owner row is `subOwner`. */
async function workspace(tenantId: string, subOwner: string): Promise<{ participant: string }> {
  const participant = `user:participant-${++n}`;
  await createOrg({ tenantId, orgId: tenantId, createdBy: 'system', name: 'Root' });
  await createMember({ tenantId, orgId: tenantId, displayName: 'Participant', subject: participant, roles: ['viewer'] });
  await createOrg({ tenantId, createdBy: subOwner, name: 'Sub-org', ownerSubject: subOwner });
  return { participant };
}

describe('ADR 0910 D0 — a declared default workspace is membership-rooted for authority', () => {
  it('a sub-org OWNER row grants no tenant-wide scope and does not pass the KickTodo manage gate', async () => {
    const T = `${DEFAULT_WS}`;
    const owner = `user:sub-owner-${++n}`;
    await workspace(T, owner);
    const { scopes } = await resolveSubjectScopesUnion(T, owner);
    expect(scopes).not.toContain(KICKTODO_MANAGE_SCOPE);
    expect(scopes).not.toContain('host:byok:manage');
    expect(await hasKicktodoManageAuthority(T, owner)).toBe(false);
    expect((await resolveTenantLevelScopes(T, owner)).scopes).not.toContain(KICKTODO_MANAGE_SCOPE);
  });

  it('the env-key seat: a `bearer:` sub-org owner (what POST /orgs seeds) is not a manage holder', async () => {
    registerMembershipRootedWorkspaces([DEFAULT_WS, `${DEFAULT_WS}-bearer`]);
    const T = `${DEFAULT_WS}-bearer`;
    await workspace(T, 'bearer:abcd1234');
    expect(await hasKicktodoManageAuthority(T, 'bearer:abcd1234')).toBe(false);
  });

  it('CONTROL: the same rows in an UNdeclared tenant keep today\'s union (the sub-org owner holds manage)', async () => {
    const T = `plain-tenant-${++n}`;
    const owner = `user:plain-owner-${n}`;
    await workspace(T, owner);
    expect(isMembershipRootedWorkspace(T)).toBe(false);
    expect(await hasKicktodoManageAuthority(T, owner)).toBe(true);
  });

  it('CONTROL: `ws:` workspaces were already root-only and stay so', async () => {
    const T = `ws:${'0'.repeat(7)}${++n}-0000-4000-8000-000000000000`;
    const owner = `user:ws-owner-${n}`;
    await workspace(T, owner);
    expect(isMembershipRootedWorkspace(T)).toBe(true);
    expect(await hasKicktodoManageAuthority(T, owner)).toBe(false);
  });

  it('the notification predicate is NOT widened (no full-roster fan-out in a default workspace, ADR 0684 §6)', () => {
    expect(isMembershipRootedWorkspace(DEFAULT_WS)).toBe(true);
    expect(isSharedWorkspaceTenant(DEFAULT_WS)).toBe(false);
  });
});
