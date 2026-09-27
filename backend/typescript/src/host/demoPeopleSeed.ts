/**
 * `demo-people` seeder (app-seeding-strategy.md §4 Phase 1, ADR 0031).
 *
 * The substrate EVERY later phase resolves `owner`/`assignee`/`member` ids
 * against: the 12 Solstice Roasters coworkers (users + profiles) and the org +
 * three business teams (sales / marketing / customer-success). `dependsOn: []`
 * — this seeds FIRST.
 *
 * Mechanics (app-seeding-strategy.md §2):
 * - Real services only (`createUser`, `getOrCreateProfile`/`updateOwnProfile`,
 *   `accessControlService`), never raw KV — validation/indexes/hooks fire.
 * - Deterministic ids: each user's principal is `demo:people:<slug>` and
 *   `createUser` derives a stable `userId` from `(tenantId, principalId)`, so the
 *   seed is idempotent and count/clear can find exactly the demo coworkers.
 * - Org resolution matches every downstream business seeder
 *   (`listOrgs(tenantId)[0]`): reuse the tenant's first org when one exists (so
 *   people, CRM, commerce, … all share ONE org), else mint one with `createOrg`'s
 *   RANDOM id (never a fixed per-tenant id — review #1344 CRITICAL). Ownership is
 *   marked by `createdBy === DEMO_PEOPLE_ACTOR`; `clear()` only deletes the org
 *   when WE own it.
 * - Never mints credentials or flips toggles; users/profiles/orgs are always-on
 *   substrate (no toggle gate).
 */
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import { createUser, listUsers, deleteUser } from '../features/users/usersService.js';
import {
  getOrCreateProfile, updateOwnProfile, setOwnSkills, deleteSubjectProfile,
} from '../features/profiles/profilesService.js';
import { removeProfile } from '../features/profiles/profilesKnowledgeService.js';
import {
  createOrg, listOrgs, deleteOrg,
  createTeam, listTeams, deleteTeam,
  createMember, listMembers, deleteMember,
} from './accessControlService.js';
import {
  SOLSTICE_PEOPLE, SOLSTICE_TEAMS, SOLSTICE_BRAND,
  DEMO_PEOPLE_ACTOR, PERSON_PRINCIPAL_PREFIX,
  personPrincipal, solsticeEmail, type SolsticePerson,
} from './seed-data/solsticeDemo.js';

const log = createLogger('seed.demoPeople');

/** The demo coworker users present for a tenant (principal-prefix marked). */
async function demoUsers(tenantId: string): Promise<Awaited<ReturnType<typeof listUsers>>> {
  return (await listUsers(tenantId)).filter((u) => u.principalId.startsWith(PERSON_PRINCIPAL_PREFIX));
}

export async function countDemoPeople(tenantId: string): Promise<number> {
  return (await demoUsers(tenantId)).length;
}

/** Read-only org resolution (clear path): the tenant's first org, and whether WE
 *  own it (`createdBy === DEMO_PEOPLE_ACTOR`). Never creates — clear must not
 *  mint. `orgId` is undefined when the tenant has no org. */
async function resolveOrg(
  tenantId: string,
): Promise<{ orgId: string | undefined; ownedByUs: boolean }> {
  const existing = (await listOrgs(tenantId))[0];
  return { orgId: existing?.orgId, ownedByUs: existing?.createdBy === DEMO_PEOPLE_ACTOR };
}

export async function seedDemoPeople(
  tenantId: string,
): Promise<{ created: number; details?: Record<string, unknown> }> {
  let created = 0;

  // 1) Users + profiles. createUser is idempotent by (tenantId, principalId);
  //    pre-compute the existing set so `created` counts only net-new coworkers.
  const existingPrincipals = new Set((await demoUsers(tenantId)).map((u) => u.principalId));
  const userIdBySlug = new Map<string, string>();
  const bySlug = new Map<string, SolsticePerson>();
  for (const person of SOLSTICE_PEOPLE) {
    bySlug.set(person.slug, person);
    const principalId = personPrincipal(person.slug);
    // ADR 0617 D1 — `silent`: N seeded coworkers must not fan out N
    // `host.users.user.provisioned` events to webhooks + workflow bindings.
    const user = await createUser({
      tenantId, principalId, email: solsticeEmail(person),
      // ADR 0622 D7 review S1 — host-authored seed addresses are admin-vouched.
      emailProvenance: 'admin',
      displayName: person.name, source: 'manual',
    }, { silent: true });
    userIdBySlug.set(person.slug, user.userId);
    if (!existingPrincipals.has(principalId)) created += 1;
    // Profiles are lazily materialized then patched (no createProfile). Re-running
    // just re-asserts the same values — safe and idempotent.
    await getOrCreateProfile(tenantId, user.userId);
    // ADR 0624 D3 — `silent`: the seed walks 0→35→50 per person and must not
    // fan out N `profile.updated` + N `completeness.crossed` to bindings.
    await updateOwnProfile(tenantId, user.userId, {
      jobTitle: person.title, department: person.department, bio: person.bio,
    }, { silent: true });
    await setOwnSkills(tenantId, user.userId, person.skills.map((s) => ({ name: s.name, proficiency: s.proficiency })), { silent: true });
  }

  // 2) Org — reuse the tenant's first org, else mint one with createOrg's RANDOM
  //    id (never a fixed per-tenant id) with the CEO (the `owner` person) bound as
  //    the explicit owner member. Ownership is marked by `createdBy`.
  const ceo = SOLSTICE_PEOPLE.find((p) => p.role === 'owner')!;
  let orgId: string;
  let ownedByUs: boolean;
  const existingOrg = (await listOrgs(tenantId))[0];
  if (existingOrg) {
    orgId = existingOrg.orgId;
    ownedByUs = existingOrg.createdBy === DEMO_PEOPLE_ACTOR;
  } else {
    const org = await createOrg({
      tenantId, createdBy: DEMO_PEOPLE_ACTOR,
      name: SOLSTICE_BRAND.name, description: SOLSTICE_BRAND.tagline,
      ownerSubject: userIdBySlug.get(ceo.slug), ownerDisplayName: ceo.name,
    });
    orgId = org.orgId;
    ownedByUs = true;
    created += 1; // the org itself (+ its owner member, created by createOrg)
  }

  // 3) Teams — guarded by name within the org (Team has no createdBy field).
  const existingTeams = await listTeams(tenantId, orgId);
  const teamIdBySlug = new Map<string, string>();
  for (const team of SOLSTICE_TEAMS) {
    const found = existingTeams.find((t) => t.name === team.name);
    if (found) { teamIdBySlug.set(team.slug, found.teamId); continue; }
    const t = await createTeam({ orgId, tenantId, name: team.name, description: team.description, color: team.color });
    teamIdBySlug.set(team.slug, t.teamId);
    created += 1;
  }

  // 4) Members — one per coworker, bound to the seeded user's subject. Skip a
  //    coworker who is already a member (the CEO owner member createOrg minted,
  //    or a prior seed). Guard by subject.
  const existingSubjects = new Set((await listMembers(tenantId, orgId)).map((m) => m.subject).filter(Boolean));
  for (const person of SOLSTICE_PEOPLE) {
    const subject = userIdBySlug.get(person.slug)!;
    if (existingSubjects.has(subject)) continue;
    // Org ownership is established via createOrg's `ownerSubject` (owned mode) or
    // already exists (reuse mode) — a loop-created member is NEVER an `owner`, so
    // clear()'s deleteMember never trips the last-owner guard on a reused org.
    await createMember({
      orgId, tenantId, displayName: person.name, subject, email: solsticeEmail(person),
      roles: [person.role === 'owner' ? 'admin' : person.role],
      teamIds: person.team ? [teamIdBySlug.get(person.team)!].filter(Boolean) : [],
    });
    created += 1;
  }

  const details = {
    users: SOLSTICE_PEOPLE.length,
    teams: teamIdBySlug.size,
    orgId,
    ownedOrg: ownedByUs,
  };
  log.info('demo_people_seeded', { tenantId, created, ...details });
  return { created, details };
}

export async function clearDemoPeople(
  tenantId: string,
  _storage: Storage,
): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  let cleared = 0;
  const { orgId, ownedByUs } = await resolveOrg(tenantId);
  const users = await demoUsers(tenantId);
  const demoSubjects = new Set(users.map((u) => u.userId));

  // Org + teams + members.
  let deletedWholesale = false;
  if (orgId && ownedByUs) {
    // WE minted the org → delete it wholesale (cascades teams + members). But
    // deleteOrg now REFUSES while the org still holds business rows (#1370,
    // returns `blocked`) — CRM/commerce/etc. still reference it. That only
    // happens on a SELECTIVE demo-people clear; the registry's reverse-order
    // full clear empties the org first. Treat `blocked` as an honest skip and
    // leave the whole people substrate intact (its users are still owners).
    const r = await deleteOrg(orgId);
    if (r.blocked) log.info('demo_people_clear_org_blocked', { tenantId, orgId, blockedRows: r.blocked.rows });
    else if (r.org) { cleared += 1 + r.teams + r.members; deletedWholesale = true; }
  }
  if (orgId && !deletedWholesale) {
    // Reused a pre-existing (user-owned) org → surgically remove ONLY the members
    // we bound to demo subjects and ONLY teams whose full canonical triple
    // (name + description + color) matches one we author — never a user's
    // like-named team (review #1344 HIGH).
    for (const m of await listMembers(tenantId, orgId)) {
      if (m.subject && demoSubjects.has(m.subject)) {
        try { if (await deleteMember(m.memberId)) cleared += 1; } catch { /* last-owner guard: leave it */ }
      }
    }
    const canonical = new Set(SOLSTICE_TEAMS.map((t) => `${t.name}\u0000${t.description}\u0000${t.color}`));
    for (const t of await listTeams(tenantId, orgId)) {
      if (canonical.has(`${t.name}\u0000${t.description ?? ''}\u0000${t.color ?? ''}`)) {
        if (await deleteTeam(t.teamId)) cleared += 1;
      }
    }
  }

  // Users + their profiles (profiles are keyed by userId; no delete cascade).
  for (const u of users) {
    await deleteSubjectProfile(tenantId, u.userId);
    // Review F5 — the Team Portfolio KB doc must die with the demo profile, or
    // clearing demo people leaves orphaned searchable KB docs. Best-effort (the
    // demo-clear must never fail on a KB hiccup), matching the seed's posture.
    await removeProfile(tenantId, u.userId);
    if (await deleteUser(u.userId)) cleared += 1;
  }

  log.info('demo_people_cleared', { tenantId, cleared });
  return { cleared };
}
