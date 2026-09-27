/**
 * `deleteOrg` never scans a whole access-control namespace (2026-09-26).
 *
 * Production: `DELETE /orgs/org-a2a3fc26` answered 500 twice with "canceling
 * statement due to statement timeout". The first full scan on that request, the
 * refuse-while-populated guard, was pre-filtered by #4143. The cascade behind it
 * still ran four FULL cross-tenant `list()` scans (teams, members, groups, custom
 * roles), and `access-members` grows with every workspace on the host.
 *
 * The witness makes a full-namespace `kvList` behave the way it did on production
 * (it throws the statement-timeout error) for the duration of `deleteOrg`, then
 * asserts the delete still succeeds and removes EXACTLY the org's scaffolding:
 * a sibling org in the same tenant, and another tenant, keep theirs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  createCustomRole, createGroup, createMember, createOrg, createTeam, deleteOrg,
  listCustomRoles, listGroups, listMembers, listTeams,
} from '../src/host/accessControlService.js';

let armed = false;
const fullScans: string[] = [];
/** A registered collection's own namespace prefix, i.e. `hostext:<name>:`. */
const NAMESPACE_RE = /^hostext:[^:]+(?::[^:]+)?:$/;

beforeAll(async () => {
  const real = await openStorage('memory://');
  const trapped = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'kvList') {
        return async (prefix: string) => {
          if (armed && prefix.startsWith('hostext:access-') && NAMESPACE_RE.test(prefix)) {
            fullScans.push(prefix);
            throw new Error('canceling statement due to statement timeout');
          }
          return target.kvList(prefix);
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Storage;
  initHostExtPersistence(trapped);
});

async function scaffold(tenantId: string, name: string): Promise<string> {
  const org = await createOrg({ tenantId, createdBy: 'test', name });
  await createTeam({ orgId: org.orgId, tenantId, name: `${name} team` });
  await createMember({ orgId: org.orgId, tenantId, displayName: `${name} member` });
  await createGroup({ orgId: org.orgId, tenantId, name: `${name} group` });
  await createCustomRole({ orgId: org.orgId, tenantId, name: `${name} role`, scopes: [] });
  return org.orgId;
}

async function counts(tenantId: string, orgId: string): Promise<number[]> {
  return [
    (await listTeams(tenantId, orgId)).length,
    (await listMembers(tenantId, orgId)).length,
    (await listGroups(tenantId, orgId)).length,
    (await listCustomRoles(tenantId, orgId)).length,
  ];
}

describe('deleteOrg cascade is bounded (no full access-* namespace scan)', () => {
  it('deletes exactly the org scaffolding while every full namespace scan times out', async () => {
    const T = 'orgdel-bounded-t1';
    const doomed = await scaffold(T, 'Doomed');
    const sibling = await scaffold(T, 'Sibling');
    const foreign = await scaffold('orgdel-bounded-t2', 'Foreign');
    const before = await counts(T, doomed);
    expect(before.every((n) => n >= 1), 'non-vacuity: the org has scaffolding of every kind').toBe(true);
    const siblingBefore = await counts(T, sibling);
    const foreignBefore = await counts('orgdel-bounded-t2', foreign);

    armed = true;
    let res: Awaited<ReturnType<typeof deleteOrg>>;
    try {
      res = await deleteOrg(doomed);
    } finally {
      armed = false;
    }
    expect(fullScans, 'deleteOrg ran a full access-* namespace scan').toEqual([]);
    expect(res.org).toBe(true);
    expect([res.teams, res.members, res.groups, res.roles]).toEqual(before);
    expect(await counts(T, doomed)).toEqual([0, 0, 0, 0]);
    expect(await counts(T, sibling)).toEqual(siblingBefore);
    expect(await counts('orgdel-bounded-t2', foreign)).toEqual(foreignBefore);
  });

  it('listForOrg returns what list()+filter returns', async () => {
    const c = new DurableCollection<{ id: string; tenantId: string; orgId?: string }>('zz-listfororg', (r) => r.id);
    await c.put({ id: 'a', tenantId: 't', orgId: 'org-1' });
    await c.put({ id: 'b', tenantId: 'u', orgId: 'org-1' });
    await c.put({ id: 'c', tenantId: 't', orgId: 'org-10' }); // the needle is a substring of this one
    await c.put({ id: 'd', tenantId: 't' });
    const expected = (await c.list()).filter((r) => r.orgId === 'org-1').map((r) => r.id).sort();
    expect((await c.listForOrg('org-1')).map((r) => r.id).sort()).toEqual(expected);
    expect(expected).toEqual(['a', 'b']);
  });
});
