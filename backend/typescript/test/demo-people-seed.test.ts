/**
 * `demo-people` seeder round-trip (app-seeding-strategy.md §4 Phase 1, ADR 0031).
 *
 * The substrate every later demo phase resolves owner/assignee/member ids
 * against. Verifies: idempotent seed, a live count that matches, an org + three
 * teams + one member per coworker, and a surgical clear that round-trips clean on
 * a fresh tenant (seed → clear → seed).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { seedDemoPeople, clearDemoPeople, countDemoPeople } from '../src/host/demoPeopleSeed.js';
import { listOrgs, listTeams, listMembers } from '../src/host/accessControlService.js';
import { listUsers } from '../src/features/users/usersService.js';
import { SOLSTICE_PEOPLE, SOLSTICE_TEAMS, PERSON_PRINCIPAL_PREFIX } from '../src/host/seed-data/solsticeDemo.js';

let storage: Storage;
beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('demo-people seeder', () => {
  it('seeds 12 coworkers, an org, and three teams; idempotent; clears clean', async () => {
    const tenantId = 'demo-people-t1';

    // Fresh tenant → seed populates everything.
    const first = await seedDemoPeople(tenantId);
    expect(first.created).toBeGreaterThan(0);
    expect(await countDemoPeople(tenantId)).toBe(SOLSTICE_PEOPLE.length);

    // Org resolves, carries the three business teams and one member per coworker.
    const orgs = await listOrgs(tenantId);
    expect(orgs).toHaveLength(1);
    const orgId = orgs[0]!.orgId;
    const teams = await listTeams(tenantId, orgId);
    expect(teams.map((t) => t.name).sort()).toEqual(SOLSTICE_TEAMS.map((t) => t.name).sort());
    const members = await listMembers(tenantId, orgId);
    // One member per coworker (the CEO owner member + the other 11).
    expect(members.length).toBe(SOLSTICE_PEOPLE.length);
    // Every member is bound to a seeded demo user subject.
    const demoUserIds = new Set((await listUsers(tenantId)).filter((u) => u.principalId.startsWith(PERSON_PRINCIPAL_PREFIX)).map((u) => u.userId));
    expect(members.every((m) => m.subject && demoUserIds.has(m.subject))).toBe(true);

    // Idempotent: a re-seed creates nothing net-new and the count holds.
    const second = await seedDemoPeople(tenantId);
    expect(second.created).toBe(0);
    expect(await countDemoPeople(tenantId)).toBe(SOLSTICE_PEOPLE.length);

    // Clear removes the org (we minted it) + every coworker.
    const cleared = await clearDemoPeople(tenantId, storage);
    expect(cleared.cleared).toBeGreaterThan(0);
    expect(await countDemoPeople(tenantId)).toBe(0);
    expect(await listOrgs(tenantId)).toHaveLength(0);

    // Round-trips: a fresh seed after clear rebuilds the full substrate.
    const third = await seedDemoPeople(tenantId);
    expect(third.created).toBeGreaterThan(0);
    expect(await countDemoPeople(tenantId)).toBe(SOLSTICE_PEOPLE.length);
  });

  it('reuses a pre-existing org instead of minting a second one', async () => {
    const tenantId = 'demo-people-t2';
    const { createOrg } = await import('../src/host/accessControlService.js');
    // A pre-existing workspace org (created before seeding).
    const ws = await createOrg({ tenantId, createdBy: 'user:real', name: 'My Workspace' });

    await seedDemoPeople(tenantId);
    const orgs = await listOrgs(tenantId);
    // Still exactly one org — the pre-existing one, reused (not a second Solstice org).
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.orgId).toBe(ws.orgId);
    // Teams + members landed on the reused org.
    expect((await listTeams(tenantId, ws.orgId)).length).toBe(SOLSTICE_TEAMS.length);

    // Clear must NOT delete the user's workspace org — only its demo members/teams.
    await clearDemoPeople(tenantId, storage);
    expect(await listOrgs(tenantId)).toHaveLength(1);
    expect(await countDemoPeople(tenantId)).toBe(0);
  });

  it('is tenant-isolated: seeding/clearing tenant B never touches tenant A (review #1344)', async () => {
    const a = 'demo-people-iso-a';
    const b = 'demo-people-iso-b';
    // Tenant A seeds a full substrate.
    await seedDemoPeople(a);
    const aOrgId = (await listOrgs(a))[0]!.orgId;
    const aTeams = (await listTeams(a, aOrgId)).length;
    const aMembers = (await listMembers(a, aOrgId)).length;
    expect(aTeams).toBeGreaterThan(0);

    // Tenant B seeds, then fully clears (org deletable — B holds no business rows).
    await seedDemoPeople(b);
    const bOrgId = (await listOrgs(b))[0]!.orgId;
    expect(bOrgId).not.toBe(aOrgId); // distinct random ids — no fixed-id collision
    await clearDemoPeople(b, storage);
    expect(await listOrgs(b)).toHaveLength(0);

    // Tenant A is completely untouched — org, teams, members all survive.
    expect((await listOrgs(a)).map((o) => o.orgId)).toContain(aOrgId);
    expect((await listTeams(a, aOrgId)).length).toBe(aTeams);
    expect((await listMembers(a, aOrgId)).length).toBe(aMembers);
    expect(await countDemoPeople(a)).toBe(SOLSTICE_PEOPLE.length);
  });
});
