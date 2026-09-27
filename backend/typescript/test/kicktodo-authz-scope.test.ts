/**
 * GC-1 — the SCOPE half of the KickTodo privileged seam: proves against the
 * real access-control resolver (not handler source) that `host:kicktodo:manage`
 * is genuinely admin-class — an `editor` member of a shared tenant does NOT
 * resolve it, an `admin` does, and a non-member resolves to zero scopes. That is
 * the property the audit's B1/B2/B14/B15/B17 all turn on.
 *
 * THE HTTP HALF LIVES IN `kicktodo-authz-http.test.ts` — the boundary proof that
 * the gate FIRES over a real request on EVERY `requireKicktodoManage` route
 * (admin admitted / editor 403 / non-member refused / toggle-OFF 404), with a
 * source ratchet so a new gated route without a proof row goes red. GC-1 was
 * CLOSED there on 2026-08-01 (ADR 0506) for one route and extended to all of them
 * by H52 (tracker KTH-4).
 *
 * HISTORY, so the next person does not repeat the mistake THIS header used to
 * make: until 2026-08 this file said a full HTTP 403/200 proof was unreachable
 * because "the `test/login` seam cannot mint" a session whose ACTIVE tenant is a
 * shared workspace while the PERSONAL tenant differs, and that closing it
 * "needs a session-model change". That was stale the day the seam grew its
 * `sharedWorkspace` flag; ADR 0554 §P3 recorded the working recipe and flagged
 * this header for retirement. No session-model change was needed. The recipe:
 *   1. `test/login` with `sharedWorkspace: true` (otherwise the seam collapses
 *      personal onto active and `isOwnPersonalWorkspace` short-circuits the gate);
 *   2. membership in the workspace-ROOT org (`orgId === tenantId`) — what
 *      `isWorkspaceMember` matches on;
 *   3. the member row must exist BEFORE login (membership is evaluated at mint):
 *      derive the future subject with `userIdFor(WS, principal)`, create, log in.
 * See ADR 0506 (the derivation) and ADR 0554 §P3 (the three corrections).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createOrg, createMember, resolveSubjectScopesUnion, scopesForRoles,
  MANAGEMENT_SCOPES, BUILT_IN_ROLES,
} from '../src/host/accessControlService.js';

const T = 'shared-tenant-scope';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('host:kicktodo:manage is genuinely admin-class (GC-1, scope half — HTTP half in kicktodo-authz-http.test.ts)', () => {
  it('is a management scope, held by admin/owner and NOT by editor/viewer', () => {
    expect(MANAGEMENT_SCOPES).toContain('host:kicktodo:manage');
    expect(BUILT_IN_ROLES.admin.scopes).toContain('host:kicktodo:manage');
    expect(scopesForRoles(['owner'])).toContain('host:kicktodo:manage');
    expect(scopesForRoles(['editor'])).not.toContain('host:kicktodo:manage');
    expect(scopesForRoles(['viewer'])).not.toContain('host:kicktodo:manage');
  });

  it('resolves through REAL org membership: an editor member lacks it, an admin member has it', async () => {
    const org = await createOrg({ tenantId: T, name: 'Authz Org', createdBy: 'user:setup' });
    await createMember({ tenantId: T, orgId: org.orgId, subject: 'user:editor', displayName: 'Ed', roles: ['editor'] });
    await createMember({ tenantId: T, orgId: org.orgId, subject: 'user:admin', displayName: 'Ad', roles: ['admin'] });

    const ed = await resolveSubjectScopesUnion(T, 'user:editor');
    const ad = await resolveSubjectScopesUnion(T, 'user:admin');
    expect(ed.scopes).not.toContain('host:kicktodo:manage'); // would be refused
    expect(ad.scopes).toContain('host:kicktodo:manage');     // would be admitted
  });

  it('a NON-member of the tenant resolves to zero scopes — fail-closed, not fail-open', async () => {
    const org = await createOrg({ tenantId: T, name: 'Authz Org', createdBy: 'user:setup' });
    await createMember({ tenantId: T, orgId: org.orgId, subject: 'user:insider', displayName: 'In', roles: ['admin'] });
    const outsider = await resolveSubjectScopesUnion(T, 'user:total-stranger');
    expect(outsider.scopes).toHaveLength(0);
    expect(outsider.scopes).not.toContain('host:kicktodo:manage');
  });
});
