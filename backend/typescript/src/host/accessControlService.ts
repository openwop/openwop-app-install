/**
 * Organizations / teams / members + role-based access — host extension
 * (NON-NORMATIVE). Lives entirely under /v1/host/openwop-app/* and
 * is NOT part of the canonical v1 wire contract (spec/v1/host-extensions.md).
 *
 * Models the "RBAC like myndhyve" surface on top of openwop's existing
 * authority model rather than inventing a new one:
 *
 *   • Built-in ROLES map to the RFC 0049 scope vocabulary (manifest:read,
 *     runs:create, …) — the protocol's authorization primitive — PLUS a small
 *     set of `host:`-prefixed management scopes that govern THESE entities
 *     (org/team/member CRUD) and are deliberately distinct so they can never
 *     be mistaken for, or advertised as, RFC 0049 protocol scopes.
 *
 *   • Authority is resolved ONLY from a member's explicit `roles[]`. It is
 *     NEVER derived from the descriptive org-chart (RFC 0087) — a department,
 *     a role label, or a `reportsTo` edge confers no authority
 *     (`org-position-no-authority-escalation`, a protocol-tier SECURITY
 *     invariant). Orgs/teams here are a SEPARATE layer from the org-chart.
 *
 *   • Resolution is FAIL-CLOSED (RFC 0049): a principal with no matching
 *     member, or a member with no/unknown roles, resolves to zero scopes. The
 *     one exception is the tenant owner — the principal that owns the tenant —
 *     who is implicitly `owner`. That holds ONLY because a demo tenant == one
 *     principal today; when multi-principal tenants are real, replace it with
 *     an explicit owner member seeded at org creation.
 *
 *   • `capabilities.authorization` is advertised ONLY when the protocol-surface
 *     enforcement is actually on (ADR 0006 Phase 3, gated on
 *     `OPENWOP_AUTHORIZATION_ENFORCEMENT`); `resolveSubjectScopesUnion` below is
 *     the protocol-surface resolver. Until enforced it stays unadvertised, so it
 *     is never a false authorization-oracle. See `host/protocolAuthorization.ts`.
 *
 * Everything is tenant-scoped through the same durable per-entity store the
 * roster/org-chart extensions use; the tenant remains the hard isolation
 * boundary and an org/team/member is a grouping INSIDE it.
 *
 * @see src/host/rosterService.ts, src/host/orgChartService.ts — sibling host-ext stores
 * @see RFCS/0049 (RBAC scopes), RFCS/0087 §B (org position confers no authority)
 */

import { randomUUID, createHash } from 'node:crypto';
import { DurableCollection, countOrgHostExtRows } from './hostExtPersistence.js';
import { registerTenantIndexAdoption } from './tenantIndexAdoption.js';
import { createLogger } from '../observability/logger.js';
import { clearActiveWorkspaceIfPointingAt } from './activeWorkspacePref.js';
import { invalidateMcpCacheForPrincipal } from './mcpClientCache.js';
import { OpenwopError } from '../types.js';
import { demoMode } from './demoMode.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { ERASED, subjectKeyForms } from './subjectErasureRedaction.js';
import { isPersonalTenantId } from './requestSubject.js';
import { delegationOf, isConfiguredOperatorIssuer, isDelegatedSubject, isNarrowingDeclaration, keyPolicyMode, notifyIssuerRemoved, notifySubjectRekeyed, reportKeyPolicy } from './delegatedSubject.js';
import { isSessionAuthorityRegistered, resolveSessionSubject } from './sessionAuthority.js';

const accessLog = createLogger('host.accessControl');

/** Rejection message for the ≥1-owner invariant (ADR 0015) — a workspace MUST
 *  always retain at least one `owner`. Shared by the member mutators below. */
const LAST_OWNER_MSG =
  'Cannot remove or demote the last owner of a workspace. Transfer ownership to another member first.';

// ── Scope vocabularies ──────────────────────────────────────────────────────

/**
 * RFC 0049 protocol scope vocabulary (bare `resource:action`). These are the
 * ONLY scopes that could ever be enumerated in a `capabilities.authorization`
 * advertisement (not advertised today — see file header).
 */
/**
 * The "act as this member" request header — ONE spelling, shared by every reader.
 *
 * WHY THIS IS A CONSTANT AND NOT A LITERAL. It used to be redeclared in five
 * route files, and they DISAGREED: `routes/accessControl.ts` read
 * `x-openwop-act-as` (the name the SPA actually sends,
 * `client/accessClient.ts:107`) while cdp / orgs / environments / entities each
 * declared `x-openwop-act-as-member` — a name nothing in this repo has ever
 * sent.
 *
 * The consequence is a TRAP rather than a live leak (measured: no client calls
 * those four route families with any act-as header). But the fail direction is
 * open — `resolveEffectiveAccess(tenant, {})` with no member context returns
 * the tenant-owner principal with OWNER_SCOPES, not zero — so a caller who
 * reasonably guessed the name the rest of the app uses would be silently
 * un-narrowed instead of refused.
 *
 * Five copies of one authorization-relevant string is the drift generator; the
 * constant is the cure, and `access-header-parity.test.ts` keeps it the only
 * spelling.
 */
export const ACT_AS_HEADER = 'x-openwop-act-as';

export const PROTOCOL_SCOPES = [
  'manifest:read',
  'runs:read',
  'runs:create',
  'runs:cancel',
  'artifacts:read',
  'audit:read',
  'approvals:respond',
  'webhooks:manage',
  'packs:publish',
  'packs:yank',
  'workspace:read',
  'workspace:write',
  // ADR 0024 D2 — permission to USE an org-shared Connection's credential in a
  // run. Default-deny (NOT in viewer/editor): a member gets it only by explicit
  // grant (a custom role or admin), the confused-deputy guard for shared creds.
  'connections:use',
] as const;

/**
 * Host-extension-local management scopes. `host:`-prefixed so they are visibly
 * NOT RFC 0049 protocol scopes (architect finding 3). They gate the org/team/
 * member management routes in this extension only.
 */
export const MANAGEMENT_SCOPES = [
  'host:org:manage',
  'host:teams:manage',
  'host:members:manage',
  'host:kicktodo:manage',
  // ADR 0711 — BYOK writes in a SHARED workspace. The secret store is tenant-wide:
  // one active-config binding and one key set serve every member, so "first member
  // to click sets it for everyone" and "any member can delete the workspace key"
  // were both reachable by any authenticated co-tenant. Reserved to built-in
  // admin/owner, never mintable onto a custom role (it administers shared
  // credentials — the same reasoning as `host:connections:manage`).
  'host:byok:manage',
  // ADR 0786 D5 — buy, subscribe and open the Stripe billing portal for a
  // workspace. The subscription and its card are tenant-wide: one member's click
  // spends for, or cancels, everyone. Reserved to built-in admin/owner, never
  // mintable onto a custom role (the `host:byok:manage` reasoning).
  'host:billing:manage',
  // ADR 0788 D5 — switch MCP tools off for the workspace's external AI clients.
  // Workspace-wide policy over what every member's client can call. Reserved to
  // built-in admin/owner, never mintable onto a custom role.
  'host:mcp:manage',
  'host:groups:manage',
  'host:roles:manage',
  // ADR 0024 D2 — admin-only management of org-shared Connections (create /
  // rotate / revoke / test). Reserved to built-in admin/owner, never mintable
  // onto a custom role (it administers shared credentials).
  'host:connections:manage',
  // ADR 0272 — Sales Territory Management. `manage` gates model activation /
  // archival (the single-active-model transition); `view-all` is the P4 override
  // that bypasses territory-scoped record visibility (admin sees every record).
  // Reserved to built-in admin/owner, never mintable onto a custom role.
  'host:territories:manage',
  'host:territories:view-all',
  // ADR 0280 — Sales Commissions. Gates commission-plan admin + statement
  // approval (the payout-affecting transitions). Reserved to built-in
  // admin/owner, never mintable onto a custom role.
  'host:commissions:manage',
  // ADR 0281 — Dealer Network. Gates dealer deal-registration approval.
  // Reserved to built-in admin/owner, never mintable onto a custom role.
  'host:dealers:manage',
  // ADR 0393 — App-Builder two-way GitHub sync. Gates the canvas↔repo binding
  // (wires a durable external write channel + an inbound webhook that can
  // mutate tenant state — stronger than the workspace:write publish). Reserved
  // to built-in admin/owner, never mintable onto a custom role.
  'host:code-sync:manage',
  // ADR 0835 D1 — deploy an exported app to the operator's provider. A deploy
  // spends operator infrastructure and publishes to the internet, so it is
  // reserved to built-in admin/owner, never mintable onto a custom role.
  'host:app-deploy:manage',
  // ADR 0394 — WhatsApp BSP channel. Gates the tenant's Meta-facing no-training
  // attestation (+ future template/number management). Reserved to built-in
  // admin/owner, never mintable onto a custom role.
  'host:whatsapp:manage',
  // ADR 0434 / KTFULL-B1..B2 — KickTodo authoring, publication, Factory
  // operation, moderation and outcome-metric administration. Publishing a
  // challenge is a CONTENT-SAFETY act (the factory's gates decide what real
  // people are told to do), so it is admin-class authority, never "any
  // authenticated co-tenant".
  'host:kicktodo:manage',
  // ── ADR 0554 P3 / RFC 0151 §E — compensation operator recovery ─────────────
  //
  // THREE scopes, and the split is the control, not the naming. Boundary row 8
  // of ADR 0554 says "start/retry/waive are separate permissions"; three ids
  // granted to an identical role set would be a naming convention wearing a
  // control's clothes, so the LADDER below is what makes them distinct:
  // `:start`/`:retry` are admin-tier, `:waive` is OWNER-ONLY (the same rung
  // `host:org:manage` sits on).
  //
  // They are `host:` MANAGEMENT scopes, deliberately NOT `PROTOCOL_SCOPES`.
  // Adding to that set would be a WIRE change — stated twice in-tree:
  // `features/insights-suite/routes.ts` ("adding to RFC 0049 PROTOCOL_SCOPES
  // would be a wire change", ADR 0078 §Phase-1 correction) and
  // `host/workloadIdentity.ts`, where `PROTOCOL_SCOPES` is the closed-world
  // validator for RFC 0154 DELEGATED workload credentials, i.e. the set crosses
  // a hop boundary in fact and not merely by naming.

  /** Start an unwind for a terminated run whose obligations never ran (the ADR
   *  0554 P2 residue: a run reaped by the dispatch sweeper leaves rows at
   *  `requested`). Admin-tier — it runs the AUTHORED inverse and nothing else. */
  'host:compensation:start',
  /** Resume a HELD plan, re-running the authored inverse. Admin-tier for the
   *  same reason: it executes exactly what the workflow author declared. */
  'host:compensation:retry',
  /**
   * The AUTHORED-CONTRACT-OVERRIDE permission. OWNER-ONLY.
   *
   * It is not just "waive": it gates every operator act that departs from the
   * §B declaration — `skip` and `terminate` (decline to undo) AND `substitute`
   * (undo by other means). `substitute` is here rather than under `:retry`
   * because it runs an ARBITRARY registered `nodeTypeId` under the obligation's
   * §C identity — an effect the author never declared, presenting the same
   * downstream idempotency key. Gating that with the weaker scope would put a
   * privilege-escalation surface on the admin rung.
   */
  'host:compensation:waive',
] as const;

export type Scope = (typeof PROTOCOL_SCOPES)[number] | (typeof MANAGEMENT_SCOPES)[number];

const PROTOCOL_SCOPES_SET: ReadonlySet<string> = new Set(PROTOCOL_SCOPES);
/**
 * A custom role may carry ONLY RFC 0049 protocol scopes. The `host:` management
 * scopes (administering orgs/teams/members/groups/roles) are reserved to the
 * built-in admin/owner roles — so a custom role can never grant the power to
 * administer the access-control surface itself (in particular, never mint a
 * role-that-mints-roles). Validated fail-closed at the route boundary.
 */
export function isProtocolScope(value: unknown): value is (typeof PROTOCOL_SCOPES)[number] {
  return typeof value === 'string' && PROTOCOL_SCOPES_SET.has(value);
}

// ── Built-in role catalog (role → scopes) ───────────────────────────────────

export type BuiltInRoleId = 'viewer' | 'editor' | 'admin' | 'owner';

export interface AccessRole {
  id: BuiltInRoleId;
  name: string;
  description: string;
  scopes: Scope[];
  builtIn: true;
}

const VIEWER_SCOPES: Scope[] = ['manifest:read', 'runs:read', 'artifacts:read', 'audit:read', 'workspace:read'];
const EDITOR_SCOPES: Scope[] = [...VIEWER_SCOPES, 'runs:create', 'runs:cancel', 'workspace:write', 'approvals:respond'];
const ADMIN_SCOPES: Scope[] = [
  ...EDITOR_SCOPES,
  'webhooks:manage',
  'packs:publish',
  'packs:yank',
  'host:teams:manage',
  'host:members:manage',
  'host:groups:manage',
  'host:roles:manage',
  // ADR 0024 D2 — admin both manages org connections and may use them.
  'host:connections:manage',
  'connections:use',
  // ADR 0711 — admin/owner administer the workspace's BYOK secrets + active config.
  'host:byok:manage',
  // ADR 0786 D5 — admin/owner buy and manage the workspace's billing.
  'host:billing:manage',
  // ADR 0788 D5 — admin/owner control which MCP tools external AI clients reach.
  'host:mcp:manage',
  // ADR 0272 — admin/owner administer territory models + hold the visibility override.
  'host:territories:manage',
  'host:territories:view-all',
  // ADR 0280 — admin/owner administer commission plans + approve statements.
  'host:commissions:manage',
  // ADR 0281 — admin/owner approve dealer deal registrations.
  'host:dealers:manage',
  // ADR 0393 — admin/owner bind an app-builder canvas to a GitHub repo.
  'host:code-sync:manage',
  // ADR 0835 D1 — admin/owner deploy exported apps (operator infrastructure).
  'host:app-deploy:manage',
  // ADR 0394 — admin/owner record the WhatsApp no-training attestation.
  'host:whatsapp:manage',
  // ADR 0434 / KTFULL-B1..B2 — KickTodo authoring, publication, Factory
  // operation, moderation and outcome-metric administration. Publishing a
  // challenge is a CONTENT-SAFETY act (the factory's gates decide what real
  // people are told to do), so it is admin-class authority, never "any
  // authenticated co-tenant".
  'host:kicktodo:manage',
  // ADR 0554 P3 — admin may START and RETRY an unwind: both run the inverse the
  // workflow AUTHOR declared, and nothing else.
  'host:compensation:start',
  'host:compensation:retry',
];
const OWNER_SCOPES: Scope[] = [
  ...ADMIN_SCOPES,
  'host:org:manage',
  // ADR 0554 P3 — OWNER-ONLY, and this line is the control. Waiving (or
  // substituting) departs from the authored §B contract: it leaves a committed
  // real effect un-undone, or undoes it by means the author never declared.
  // `compensation-recovery-rbac.test.ts` asserts an ADMIN principal is refused
  // here — without that leg the three scope ids would be indistinguishable and
  // the "separate permissions" boundary would be a label.
  'host:compensation:waive',
];

export const BUILT_IN_ROLES: Record<BuiltInRoleId, AccessRole> = {
  viewer: { id: 'viewer', name: 'Viewer', description: 'Read-only access to runs, artifacts, audit, and workspace.', scopes: VIEWER_SCOPES, builtIn: true },
  editor: { id: 'editor', name: 'Editor', description: 'Create and cancel runs, write workspace, respond to approvals.', scopes: EDITOR_SCOPES, builtIn: true },
  admin: { id: 'admin', name: 'Admin', description: 'Editor plus webhook/pack management and team/member/group administration.', scopes: ADMIN_SCOPES, builtIn: true },
  owner: { id: 'owner', name: 'Owner', description: 'Full access including organization management.', scopes: OWNER_SCOPES, builtIn: true },
};

export const BUILT_IN_ROLE_IDS = Object.keys(BUILT_IN_ROLES) as BuiltInRoleId[];

export function isBuiltInRoleId(value: unknown): value is BuiltInRoleId {
  return typeof value === 'string' && value in BUILT_IN_ROLES;
}

/** Union of the scopes granted by a set of role ids. Unknown role ids are
 *  dropped (fail-closed — they grant nothing), never error. */
export function scopesForRoles(roles: readonly string[]): Scope[] {
  const set = new Set<Scope>();
  for (const r of roles) {
    if (isBuiltInRoleId(r)) for (const s of BUILT_IN_ROLES[r].scopes) set.add(s);
  }
  return [...set];
}

// ── Entities ─────────────────────────────────────────────────────────────────

export interface Organization {
  orgId: string;
  tenantId: string;
  name: string;
  slug: string;
  description?: string;
  /** The principal (tenant) that created the org — the implicit owner today. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Team {
  teamId: string;
  orgId: string;
  tenantId: string;
  name: string;
  description?: string;
  color?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrgMember {
  memberId: string;
  orgId: string;
  tenantId: string;
  /** Optional authenticated-principal identifier this member maps to. When a
   *  request's principal matches, the member's roles apply. Absent ⇒ a
   *  descriptive member (no principal binding yet). */
  subject?: string;
  displayName: string;
  email?: string;
  /** Role ids — each either a built-in (`viewer`…`owner`) or a custom role id. */
  roles: string[];
  teamIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A cross-cutting RBAC unit (distinct from a Team, which is a collaboration
 * grouping with no authority). A Group CARRIES roles and grants them to its
 * members — batch permission management. A member's effective roles are the
 * union of its own `roles[]` and the roles of every group it belongs to.
 */
export interface Group {
  groupId: string;
  orgId: string;
  tenantId: string;
  name: string;
  description?: string;
  /** Role ids — each either a built-in or a custom role id. */
  roles: string[];
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A tenant/org-scoped custom role — lets an org define roles beyond the
 * built-in four. `scopes` is validated fail-closed against the RFC 0049
 * PROTOCOL scopes at the route boundary (NOT the `host:` management scopes —
 * see `isProtocolScope`). Custom roles are NOT advertised via
 * capabilities.authorization (same posture as the built-ins).
 */
export interface CustomRole {
  roleId: string;
  orgId: string;
  tenantId: string;
  name: string;
  description?: string;
  scopes: Scope[];
  createdAt: string;
  updatedAt: string;
}

// `tenantOf` opts this collection into the GOV-1 tenant secondary index, so
// `listForTenantIndexed` is a bounded scan of one tenant's slice instead of a
// full cross-tenant `list()` + in-memory filter. It does NOT re-key the primary
// rows, so there is no migration and no data-loss risk — `ensureTenantIndex()`
// backfills legacy rows once behind a sentinel, stale markers self-heal, and
// concurrent backfills are harmless because marker writes are idempotent.
const orgs = new DurableCollection<Organization>('access-orgs', (o) => o.orgId, undefined, (o) => o.tenantId);
const teams = new DurableCollection<Team>('access-teams', (t) => t.teamId);
// ADR 0434 / IDN-7 — `tenantOf` enables the TENANT SECONDARY INDEX so
// `isWorkspaceMember` can do a BOUNDED scan of one workspace's members instead of
// `list()`'s full CROSS-TENANT scan on every authenticated request. The primary
// rows are NOT re-keyed, so there is no migration and no data-loss risk; the
// collection maintains the markers on put/delete, which is what makes this safe
// across all eleven member-writer sites (including `rekeyMemberSubject`, which
// mutates `.subject`) without a hand-maintained write-through index that a missed
// site would silently corrupt into a LOCKOUT.
const members = new DurableCollection<OrgMember>(
  'access-members',
  (m) => m.memberId,
  undefined,
  (m) => m.tenantId,
);
// ADR 0866 — the authorization resolvers read through the index only once an
// hourly reconcile has verified it (see `tenantMembers`).
registerTenantIndexAdoption('access-members', members);

/** Every member row of one tenant, by the full scan. The authoritative read. */
async function scanTenantMembers(tenantId: string): Promise<OrgMember[]> {
  return (await members.list()).filter((m) => m.tenantId === tenantId);
}

/**
 * ADR 0866 — one tenant's member rows through the tenant index once it is
 * verified, else null. Every row it returns is a real row of that
 * tenant, so a FOUND answer is right. A MISSING one is not authoritative: a
 * caller that would deny, or fall to the demo owner bypass, on absence confirms
 * with `scanTenantMembers` first (`indexedTenantMembers` is null when the index
 * is not verified, so that caller scans once, not twice). Same rule as `isWorkspaceMember`: the index may
 * say yes, never no. Same order as the scan (both sorted by member id).
 */
async function indexedTenantMembers(tenantId: string): Promise<OrgMember[] | null> {
  if (!(await members.tenantIndexVerified())) return null;
  try {
    return (await members.listForTenantIndexed(tenantId)).filter((m) => m.tenantId === tenantId);
  } catch {
    return null; // index unavailable — callers fall back to the authoritative scan
  }
}

/** For reads where a briefly missing row is harmless (a listing): no confirm. */
async function tenantMembers(tenantId: string): Promise<OrgMember[]> {
  return (await indexedTenantMembers(tenantId)) ?? scanTenantMembers(tenantId);
}
/**
 * ADR 0684 phase 5 — a POINT-READ index for workspace membership.
 *
 * `isWorkspaceMember` runs on EVERY authenticated request and at session mint,
 * and answers a point question — "is THIS subject a member of THIS workspace" —
 * with an O(N) slice scan, falling through to a FULL CROSS-TENANT scan to
 * confirm a denial. That was affordable while every workspace was small. ADR 0684
 * introduces a default workspace containing every user who has ever signed in,
 * which makes N unbounded on the hottest path in the app.
 *
 * WHY A SIDECAR AND NOT AN INDEX: `DurableCollection` carries exactly ONE
 * secondary index (`tenantOf`), already spent on `tenantId`. And
 * `indexProjection`/`listForTenantProjected` is not a substitute — it avoids
 * decoding full rows, lowering the CONSTANT while leaving the complexity at
 * O(N). It looks like the fix and does not move the axis that matters.
 *
 * WHY THIS IS SAFE: it is a pure ADDITIVE FAST PATH. A hit returns true in O(1);
 * a miss falls through to the pre-existing logic unchanged. So a missing entry
 * can never produce a false negative — the thing that would lock a real member
 * out of their own workspace — and no backfill is required for CORRECTNESS.
 * Backfill would only widen the fast path. This is the one direction an
 * authorization check must never fail, so the fast path is allowed to say "yes"
 * and never "no".
 *
 * Keyed on the same `(subject, workspaceId)` pair as the ADR 0684 §7 join ledger:
 * one key shape doing three jobs — join idempotence, removal-wins, and this —
 * because it is the same question asked at three moments.
 */
interface WorkspaceMemberIndexRow { id: string; tenantId: string; memberId: string }
const memberIndex = new DurableCollection<WorkspaceMemberIndexRow>(
  'access-member-index', (r) => r.id, undefined, (r) => r.tenantId,
);
const memberIndexKey = (workspaceId: string, subject: string): string => `${workspaceId}::${subject}`;

/** The DETERMINISTIC id of a workspace-root membership, derived from the
 *  relationship it represents — `(tenantId, subject)`.
 *
 *  ADR 0697 D1. This used to be `personalOwnerMemberId`, applied to personal
 *  workspaces alone, and its comment already named the hazard: concurrent callers
 *  computing the SAME id upsert one row, where "the random `mbr-<uuid>` path
 *  would race to two". That was written when every SHARED workspace-root
 *  membership came from a human action, so no concurrent writer could reach it.
 *  ADR 0684's auto-join added one, and the race produced exactly the twins the
 *  comment predicted — which the phase-5 index then hid, and which survived the
 *  operator's removal to re-grant membership through `isWorkspaceMember`'s
 *  authoritative fallback.
 *
 *  A personal workspace is now a SPECIAL CASE of one rule rather than the only
 *  place the rule is applied. Sub-org memberships (`orgId !== tenantId`) keep
 *  `mbr-<uuid>`: they are not the shape `isWorkspaceMember` reads, and giving
 *  them a derived id would change ids that are already in use for no gain. */
function workspaceRootMemberId(tenantId: string, subject: string): string {
  return `mbr-${createHash('sha256').update(`${tenantId}:${subject}`).digest('hex').slice(0, 12)}`;
}

/** Workspace-ROOT membership only — the shape `isWorkspaceMember` matches. */
function indexableWorkspaceMember(m: OrgMember): boolean {
  return isWorkspaceRootMembership(m) && typeof m.subject === 'string' && m.subject.length > 0;
}

async function indexWorkspaceMember(m: OrgMember): Promise<void> {
  if (!indexableWorkspaceMember(m)) return;
  try {
    await memberIndex.put({ id: memberIndexKey(m.tenantId, m.subject as string), tenantId: m.tenantId, memberId: m.memberId });
  } catch { /* the index is an optimisation; never fail a membership write for it */ }
}

async function unindexWorkspaceMember(m: OrgMember): Promise<void> {
  if (!indexableWorkspaceMember(m)) return;
  try { await memberIndex.delete(memberIndexKey(m.tenantId, m.subject as string)); } catch { /* as above */ }
}

const groups = new DurableCollection<Group>('access-groups', (g) => g.groupId);
const customRoles = new DurableCollection<CustomRole>('access-custom-roles', (r) => r.roleId);

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'org';
}

// ── Organizations ────────────────────────────────────────────────────────────

export async function createOrg(input: {
  tenantId: string;
  createdBy: string;
  name: string;
  description?: string;
  /** A FIXED org id, for reserved host-level orgs that need a deterministic id
   *  (ADR 0027 — the system site org `host-site`). Omit for normal orgs, which get
   *  a random `org-<uuid>` id. */
  orgId?: string;
  /** ADR 0006 (RBAC) Phase 1: when provided, seed an EXPLICIT owner member bound
   *  to this subject (the creating `User.userId`, ADR 0003) — so ownership is
   *  membership-derived and multi-principal-ready, not the "tenant == principal,
   *  implicitly owner" shortcut this file's header flags for replacement. */
  ownerSubject?: string;
  ownerDisplayName?: string;
}): Promise<Organization> {
  const now = nowIso();
  const org: Organization = {
    orgId: input.orgId ?? `org-${randomUUID().slice(0, 8)}`,
    tenantId: input.tenantId,
    name: input.name,
    slug: slugify(input.name),
    description: input.description,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await orgs.put(org);
  if (input.ownerSubject) {
    await createMember({
      tenantId: input.tenantId,
      orgId: org.orgId,
      subject: input.ownerSubject,
      displayName: input.ownerDisplayName ?? 'Owner',
      roles: ['owner'],
    });
  }
  return org;
}

export async function listOrgs(tenantId: string): Promise<Organization[]> {
  return (await orgs.listForTenantIndexed(tenantId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getOrg(orgId: string): Promise<Organization | null> {
  return orgs.get(orgId);
}

/**
 * CMNT-4 — THE org-scope predicate, in one place, for every lane that has a
 * subject.
 *
 * Two checks, in this order, and both matter:
 *   1. the org exists IN THIS TENANT — a foreign or dangling id is a uniform
 *      404, never a cross-tenant existence leak;
 *   2. the subject holds `scope` in it — `resolveEffectiveAccess` is the same
 *      resolver the HTTP routes and the chat tools already consult.
 *
 * WHY IT MOVED HERE. `featureRoute.requireOrgScope` (the HTTP lane) and
 * `agentToolKit.resolveReadOrgScope` / `resolveActionOrgScope` (the chat-tool
 * lane) both performed exactly this pair, and the WORKFLOW-SURFACE lane
 * performed NEITHER — `features/comments/surface.ts` took `orgId` verbatim from
 * node args, so a chain node in a multi-org tenant could read and write comment
 * threads in an org the run had no membership in. Extracting the predicate means
 * the surface shares the routes' gate rather than carrying a third, weaker copy
 * that can drift.
 *
 * Callers that need a RESULT rather than a throw (the tools' three-way
 * `empty`/`error`/`ok` shape) keep their own wrappers — this owns the DECISION,
 * not the presentation.
 */
export async function assertOrgScope(
  tenantId: string,
  subject: string,
  orgId: string,
  scope: Scope,
  /** ADR 0622 D2 — the caller's PERSONAL tenant, honoured with the SAME
   *  `isPersonalTenantId` shape guard as `assertTenantScope`: the implicit
   *  personal-owner short-circuit fires only when the org's tenant IS a
   *  `user:`/`anon:`-shaped personal tenant of this caller (USERS-19). The
   *  org-existence check still runs FIRST, so a foreign org stays a uniform
   *  404 even for a personal owner. The act-as header is HTTP-only and stays
   *  in the route (`orgs/routes.ts requireMemberManage`). */
  ctx: { personalTenant?: string } = {},
): Promise<void> {
  const org = await getOrg(orgId);
  if (!org || org.tenantId !== tenantId) {
    throw new OpenwopError('not_found', 'Organization not found.', 404, { orgId });
  }
  if (ctx.personalTenant === tenantId && isPersonalTenantId(tenantId)) return; // implicit personal owner
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  if (!access.scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  }
}

/**
 * ADR 0830 D1 — `assertOrgScope` for a lane that runs FOR someone rather than
 * for a request: a workflow run (`BundleScope.actingUserId`) or a chat turn.
 * Lifted out of `features/media/surface.ts` (ADR 0818 §4), which was its first
 * caller, so KB and media decide it identically.
 *
 * Two lanes pass without a membership read, both carried over unchanged:
 *  - NO acting user (a schedule, a trigger, a system run): tenant-trusted, as
 *    every surface without an actor is. There is nobody to resolve.
 *  - the WORKSPACE-ROOT id (`orgId === tenantId`) of a single-principal tenant
 *    (`user:`/`anon:`, and `default` in demo mode only), which need not be an org
 *    row; with one principal there is nobody to escalate over. NARROWED from
 *    media's original (ADR 0830 code grade, `KBCD-5`): it accepted `default`
 *    unconditionally, and outside demo mode `default` is the shared SAML tenant.
 * In a personal tenant a real org passes as its owner's, after the existence
 * check (`assertOrgScope`'s own personal-owner short-circuit) — for the run's
 * ACTOR only. `opts.cause` (ADR 0832 D3, grade `M1`) marks a subject that merely
 * caused an actorless run (a channel poster): that short-circuit keys on the
 * tenant's SHAPE, not on who owns it, so for a cause it would pass every member
 * of a shared personal workspace for every org in it. A cause is answered by
 * membership. (The actor arm keeps ADR 0830's behaviour; ADR 0832 residue
 * R-personal is keying it on the request-stamped `personalTenant` instead.)
 */
export async function assertRunOrgScope(tenantId: string, actingUserId: string | undefined, orgId: string, scope: Scope, opts: { cause?: boolean } = {}): Promise<void> {
  if (!actingUserId) return;
  // The root shortcut is for a tenant with ONE principal. `default` is that only in
  // demo mode: outside it, `default` is also the SAML tenant every SSO user shares
  // (`samlSso.ts`), so there the root org is answered by membership like any other.
  if (orgId === tenantId && (isPersonalTenantId(tenantId) || (tenantId === 'default' && demoMode()))) return;
  await assertOrgScope(tenantId, actingUserId, orgId, scope, isPersonalTenantId(tenantId) && !opts.cause ? { personalTenant: tenantId } : {});
}

/** ADR 0832 D3 — the subject a run-lane membership floor checks: the run's
 *  acting user, else the member who caused an actorless run (`orgScopeSubject`).
 *  For `assertRunOrgScope` / `runOrgScopeFilter` ONLY — those narrow. Never pass
 *  the result anywhere that grants (a `SubjectCaller.subject`, `resolveOne`'s
 *  `userId`, a credential or recall lookup): the causing member is not the
 *  run's actor. */
export function runOrgScopeSubject(scope: { actingUserId?: string | undefined; orgScopeSubject?: string | undefined }): string | undefined {
  return scope.actingUserId ?? scope.orgScopeSubject;
}

/** ADR 0832 — `assertRunOrgScope` for a run scope: the actor if there is one,
 *  else the causing member as a `cause` (membership only), else nothing. The
 *  one call the seam floor and the KB and media surfaces make. */
export async function assertRunScopeOrg(
  scope: { tenantId: string; actingUserId?: string | undefined; orgScopeSubject?: string | undefined },
  orgId: string,
  needed: Scope,
): Promise<void> {
  if (scope.actingUserId) return assertRunOrgScope(scope.tenantId, scope.actingUserId, orgId, needed);
  if (scope.orgScopeSubject) return assertRunOrgScope(scope.tenantId, scope.orgScopeSubject, orgId, needed, { cause: true });
}

/** ADR 0830 D1 — `assertRunOrgScope` as a FILTER, for a lane that fans out over
 *  many orgs' rows (KB `tenantRetrieve`): one membership resolve per distinct
 *  org, and a REFUSAL (absent org, missing scope) drops that org's rows rather
 *  than failing the whole read. Anything else — a storage error, an exhausted
 *  pool — is rethrown: swallowing it would answer "nothing you may read", which
 *  is indistinguishable from a tenant with no knowledge. */
export async function runOrgScopeFilter(tenantId: string, actingUserId: string | undefined, orgIds: Iterable<string>, scope: Scope, opts: { cause?: boolean } = {}): Promise<Set<string>> {
  const allowed = new Set<string>();
  for (const orgId of new Set(orgIds)) { // sequential: each resolve scans the member stores, and the pool is small
    try {
      await assertRunOrgScope(tenantId, actingUserId, orgId, scope, opts);
      allowed.add(orgId);
    } catch (err) {
      if (err instanceof OpenwopError && (err.code === 'not_found' || err.code === 'forbidden_scope')) continue;
      throw err;
    }
  }
  return allowed;
}

/**
 * Ensure `orgId` exists AS A WORKSPACE ROOT bound to `tenantId`, repairing a row
 * left in the pre-ADR-0684-correction shape. Returns what it did, so the caller
 * can log a repair distinctly from a routine create.
 *
 * WHY A REPAIR PATH IS NEEDED AT ALL. The ADR 0684 correction changed the
 * declared tenant id (`host:kicktodo` → `host-kicktodo`) but `ensureFeature
 * DefaultOrgs` keys idempotence on the ORG id, which did NOT change. So on every
 * host that had already booted the old code, `getOrg` finds the stale row, the
 * create is skipped, and the org keeps `tenantId: 'host:<f>'` forever — still not
 * a workspace root. Worse than before the correction, because auto-join now
 * writes workspace-root-shaped MEMBER rows, so `isWorkspaceMember` passes while
 * `getWorkspace` still returns null: half-working rather than cleanly broken.
 * Caught on `app.openwop.dev`, which already had `host-kicktodo` provisioned.
 *
 * THE ROW IS REPLACED, NOT MUTATED IN PLACE. `orgs` carries a tenant secondary
 * index keyed on `tenantId`, so editing that field would leave a marker stranded
 * under the old tenant pointing at a row that no longer belongs to it. `delete`
 * clears row and marker together. It fires no cascade here — `orgs` is
 * constructed without an `onDeleted`, so this does NOT touch members, unlike the
 * exported `deleteOrg` below.
 *
 * MEMBER ROWS UNDER THE OLD TENANT ARE LEFT ALONE, deliberately. They were never
 * functional (no predicate ever matched them), so they are inert, and deleting
 * production rows unattended at boot is a bigger risk than leaving dead ones.
 * They are reported in the return value so the caller can say so out loud.
 */
export async function ensureWorkspaceRootOrg(input: {
  orgId: string; tenantId: string; name: string; createdBy: string;
}): Promise<{ action: 'created' | 'repaired' | 'unchanged'; priorTenantId?: string }> {
  if (!isWorkspaceRootPair(input.orgId, input.tenantId)) {
    throw new Error(`ensureWorkspaceRootOrg: "${input.orgId}"/"${input.tenantId}" is not a workspace root — the ids must be EQUAL.`);
  }
  const existing = await getOrg(input.orgId);
  if (existing && isWorkspaceOrg(existing)) return { action: 'unchanged' };
  if (existing) {
    const priorTenantId = existing.tenantId;
    await orgs.delete(input.orgId); // row + index marker; no cascade (see above)
    await createOrg({ tenantId: input.tenantId, orgId: input.orgId, createdBy: input.createdBy, name: input.name });
    return { action: 'repaired', priorTenantId };
  }
  await createOrg({ tenantId: input.tenantId, orgId: input.orgId, createdBy: input.createdBy, name: input.name });
  return { action: 'created' };
}

export async function updateOrg(
  orgId: string,
  patch: { name?: string; description?: string | null },
): Promise<Organization | null> {
  const org = await getOrg(orgId);
  if (!org) return null;
  if (patch.name !== undefined) {
    org.name = patch.name;
    org.slug = slugify(patch.name);
  }
  if (patch.description !== undefined) {
    if (patch.description === null) delete org.description;
    else org.description = patch.description;
  }
  org.updatedAt = nowIso();
  await orgs.put(org);
  return org;
}

/** Delete an org and CASCADE its teams + members + groups (architect finding 7
 *  — no orphaned tenant-scoped rows). Returns the deleted counts. */
export async function deleteOrg(
  orgId: string,
): Promise<{ org: boolean; teams: number; members: number; groups: number; roles: number; blocked?: { rows: number } }> {
  const org = await getOrg(orgId);
  if (!org) return { org: false, teams: 0, members: 0, groups: 0, roles: 0 };
  // Grade-data RI-7 / DG-INT-5 (architect ruling: refuse-while-populated,
  // NON-THROWING) — an org still holding business rows (CRM, kanban, commerce,
  // cms, …) must not be deleted out from under them: the cascade below removes
  // only access-control scaffolding, so everything org-scoped would orphan.
  // Count via the live-collection walk, EXCLUDING our own namespaces (which this
  // function legitimately deletes) — the caller maps `blocked` to a 409.
  const businessRows = await countOrgHostExtRows(org.tenantId, orgId, ['access-', 'orgs:invite']);
  if (businessRows > 0) {
    return { org: false, teams: 0, members: 0, groups: 0, roles: 0, blocked: { rows: businessRows } };
  }
  // Pre-filtered in the database (`listForOrg`), never a full cross-tenant
  // `list()`: the guard above was fixed for the same statement timeout (#4143),
  // and the cascade was the next full scan on the same request.
  const orgTeams = await teams.listForOrg(orgId);
  const orgMembers = await members.listForOrg(orgId);
  const orgGroups = await groups.listForOrg(orgId);
  const orgRoles = await customRoles.listForOrg(orgId);
  for (const t of orgTeams) await teams.delete(t.teamId);
  for (const m of orgMembers) await members.delete(m.memberId);
  // ADR 0795 D6 — deleting an org removes its members without `deleteMember`.
  // Anyone that left with no membership in the tenant takes their keys too.
  for (const m of orgMembers) {
    if (m.subject) await notifyIfLastMembershipGone(m.tenantId, m.subject);
  }
  for (const g of orgGroups) await groups.delete(g.groupId);
  for (const r of orgRoles) await customRoles.delete(r.roleId);
  await orgs.delete(orgId);
  return { org: true, teams: orgTeams.length, members: orgMembers.length, groups: orgGroups.length, roles: orgRoles.length };
}

// ── Teams ─────────────────────────────────────────────────────────────────────

export async function createTeam(input: {
  orgId: string;
  tenantId: string;
  name: string;
  description?: string;
  color?: string;
}): Promise<Team> {
  const now = nowIso();
  const team: Team = {
    teamId: `team-${randomUUID().slice(0, 8)}`,
    orgId: input.orgId,
    tenantId: input.tenantId,
    name: input.name,
    description: input.description,
    color: input.color,
    createdAt: now,
    updatedAt: now,
  };
  await teams.put(team);
  return team;
}

export async function listTeams(tenantId: string, orgId: string): Promise<Team[]> {
  return (await teams.list())
    .filter((t) => t.tenantId === tenantId && t.orgId === orgId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getTeam(teamId: string): Promise<Team | null> {
  return teams.get(teamId);
}

export async function updateTeam(
  teamId: string,
  patch: { name?: string; description?: string | null; color?: string | null },
): Promise<Team | null> {
  const team = await teams.get(teamId);
  if (!team) return null;
  if (patch.name !== undefined) team.name = patch.name;
  if (patch.description !== undefined) {
    if (patch.description === null) delete team.description;
    else team.description = patch.description;
  }
  if (patch.color !== undefined) {
    if (patch.color === null) delete team.color;
    else team.color = patch.color;
  }
  team.updatedAt = nowIso();
  await teams.put(team);
  return team;
}

/** Delete a team and remove it from any member's `teamIds`. */
export async function deleteTeam(teamId: string): Promise<boolean> {
  const existed = await teams.delete(teamId);
  if (existed) {
    for (const m of (await members.list()).filter((m) => m.teamIds.includes(teamId))) {
      m.teamIds = m.teamIds.filter((id) => id !== teamId);
      m.updatedAt = nowIso();
      await members.put(m);
    }
  }
  return existed;
}

// ── Members ───────────────────────────────────────────────────────────────────

export async function createMember(input: {
  orgId: string;
  tenantId: string;
  displayName: string;
  subject?: string;
  email?: string;
  roles?: string[];
  teamIds?: string[];
}): Promise<OrgMember> {
  const now = nowIso();
  // ADR 0697 D1 — a workspace-root membership is keyed by the RELATIONSHIP, not
  // by a fresh random id. A random id is absent on every read, so two concurrent
  // auto-joins (ADR 0684 §7) each found nothing and each wrote a row for one
  // person. A derived id makes the second caller find the first.
  //
  // Returning the existing row is deliberately NOT an upsert: a role edit or
  // display name already on it is the operator's, and a racing auto-join must
  // not overwrite it with its own defaults.
  const derived = input.subject && input.subject.length > 0 && input.orgId === input.tenantId
    ? workspaceRootMemberId(input.tenantId, input.subject)
    : null;
  if (derived !== null) {
    const existing = await members.get(derived);
    if (existing) return existing;
  }
  const member: OrgMember = {
    memberId: derived ?? `mbr-${randomUUID().slice(0, 8)}`,
    orgId: input.orgId,
    tenantId: input.tenantId,
    subject: input.subject,
    displayName: input.displayName,
    email: input.email,
    roles: input.roles ? [...input.roles] : ['viewer'],
    teamIds: input.teamIds ? [...input.teamIds] : [],
    createdAt: now,
    updatedAt: now,
  };
  await members.put(member);
  await indexWorkspaceMember(member); // ADR 0684 phase 5 — point-read fast path
  return member;
}

export async function listMembers(tenantId: string, orgId: string): Promise<OrgMember[]> {
  return (await tenantMembers(tenantId))
    .filter((m) => m.orgId === orgId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Every member of a tenant, across ALL its orgs/workspaces. Unlike
 *  `listMembers` (org-scoped), this spans the whole tenant — used by the
 *  ADR 0003 Phase 4d subject re-key, which sweeps every legacy-keyed membership
 *  a tenant holds. */
export async function listTenantMembers(tenantId: string): Promise<OrgMember[]> {
  return (await members.list())
    .filter((m) => m.tenantId === tenantId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * ADR 0816 — the workspace-ROOT members of one tenant, read through the bounded
 * per-tenant index (`listForTenantIndexed`) instead of `listTenantMembers`'s
 * cross-tenant scan: notification audience resolution runs on every shared-
 * workspace broadcast and every inbox read, which is the IDN-7 hot-path shape.
 * The index tolerates a DELAYED marker (it self-heals on the next projected
 * read); a marker-write failure is the only way a member is briefly missed, the
 * same posture retention already accepts. An unavailable index falls back to the
 * authoritative scan rather than answering "nobody".
 */
export async function listWorkspaceRootMembers(tenantId: string): Promise<OrgMember[]> {
  let rows: OrgMember[];
  try {
    rows = await members.listForTenantIndexed(tenantId);
  } catch {
    rows = (await members.list()).filter((m) => m.tenantId === tenantId);
  }
  return rows.filter((m) => m.tenantId === tenantId && isWorkspaceRootMembership(m));
}

export async function getMember(memberId: string): Promise<OrgMember | null> {
  return members.get(memberId);
}

/** ADR 0815 D3 — a CAS read-modify-write on one member row. Null when the row
 *  is absent (or vanished mid-flight: a concurrent removal wins); a 409 after
 *  bounded contention. */
async function casMember(memberId: string, fn: (m: OrgMember) => OrgMember): Promise<{ before: OrgMember; after: OrgMember } | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await members.get(memberId);
    if (!current) return null;
    const next = fn(structuredClone(current));
    if (await members.compareAndSwap(current, next)) return { before: current, after: next };
  }
  throw new OpenwopError('conflict', 'This member was changed by someone else at the same time. Try again.', 409, { memberId, reason: 'write_contention' });
}

/** The legacy twins of a workspace-root row (ADR 0697: same workspace, same
 *  subject, another id). The same full read `deleteMember` uses, for the same
 *  reason: the sweep must see exactly what the membership check sees. */
async function twinsOf(row: OrgMember): Promise<OrgMember[]> {
  if (!indexableWorkspaceMember(row)) return [];
  return (await members.list()).filter((m) =>
    m.memberId !== row.memberId && m.tenantId === row.tenantId && m.orgId === row.orgId && m.subject === row.subject);
}

export async function updateMember(
  memberId: string,
  patch: { displayName?: string; email?: string | null; subject?: string | null; roles?: string[]; teamIds?: string[] },
): Promise<OrgMember | null> {
  const apply = (m: OrgMember): OrgMember => {
    if (patch.displayName !== undefined) m.displayName = patch.displayName;
    if (patch.email !== undefined) {
      if (patch.email === null) delete m.email;
      else m.email = patch.email;
    }
    if (patch.subject !== undefined) {
      if (patch.subject === null) delete m.subject;
      else m.subject = patch.subject;
    }
    if (patch.roles !== undefined) m.roles = [...patch.roles];
    if (patch.teamIds !== undefined) m.teamIds = [...patch.teamIds];
    m.updatedAt = nowIso();
    return m;
  };
  // ADR 0815 D3 — a CAS against the row AS READ. The blind put this replaced
  // resurrected a member a concurrent `deleteMember` had just removed (MEASURED:
  // interleaving 0 of 20). A row that vanished mid-flight is never written again.
  const primary = await casMember(memberId, apply);
  if (!primary) return null;
  const { before, after: updated } = primary;
  // ADR 0815 D3 — the ROLES change the relationship, not one row: a demotion
  // applied to the visible row left a legacy twin's old role in the tenant-wide
  // union, so it did not hold. Only roles: the twin keeps its own display fields,
  // and an identity change never reaches a root row (the route refuses it).
  const written: Array<{ before: OrgMember; after: OrgMember }> = [primary];
  if (patch.roles !== undefined) {
    try {
      for (const twin of await twinsOf(before)) {
        const w = await casMember(twin.memberId, (m) => { m.roles = [...patch.roles!]; m.updatedAt = nowIso(); return m; });
        if (w) written.push(w);
      }
    } catch (err) {
      // Contention on a twin after the primary row was written: undo what this
      // call wrote (CAS from what it wrote) rather than leave the relationship
      // half-applied, then surface the typed 409.
      for (const w of written) {
        if (!(await members.compareAndSwap(w.after, { ...w.before, updatedAt: nowIso() }))) {
          accessLog.warn('member_twin_rollback_lost_race', { tenantId: before.tenantId, orgId: before.orgId, memberId: w.after.memberId });
        }
      }
      throw err;
    }
  }
  // ≥1-owner invariant (ADR 0015), enforced ATOMICALLY at the mutator — the
  // single chokepoint, so no caller can bypass it. A post-write re-check is
  // race-safe where a pre-write count→put is not: if this demotion stripped the
  // LAST owner, restore what this call wrote (twins included) and reject.
  // (Concurrent demotions of two distinct owners can at worst both restore —
  // never leave zero.) ADR 0815 D3: each restore is a CAS from what THIS call
  // wrote, so a concurrent writer's row is never overwritten or resurrected; if
  // a restore loses and the workspace is STILL ownerless, the addressed row gets
  // its prior roles back unconditionally — a lost race may cost an edit, never
  // the workspace.
  if (written.some((w) => w.before.roles.includes('owner')) && !updated.roles.includes('owner')
      && (await countOwners(before.tenantId, before.orgId)) === 0) {
    for (const w of written) {
      if (!(await members.compareAndSwap(w.after, { ...w.before, updatedAt: nowIso() }))) {
        accessLog.warn('member_owner_restore_lost_race', { tenantId: before.tenantId, orgId: before.orgId, memberId: w.after.memberId });
      }
    }
    if ((await countOwners(before.tenantId, before.orgId)) === 0) {
      await casMember(memberId, (m) => { m.roles = [...new Set([...m.roles, ...before.roles])]; m.updatedAt = nowIso(); return m; });
    }
    throw new OpenwopError('conflict', LAST_OWNER_MSG, 409, { orgId: before.orgId, memberId, reason: 'last_owner' });
  }
  // H57 (ADR 0553 correction / RFC 0153 §D-G4) — this member's rights just
  // changed, so anything cached for them against an outbound MCP peer was
  // gathered under the OLD rights. Dropped here, at the mutator, because that
  // is the one place every caller must pass through. Placed AFTER the
  // owner-invariant restore-and-throw: a rejected demotion left the rights
  // unchanged, so it must not read as a change. Best-effort and in-process —
  // the cache KEY (which re-derives scopes per read) is what covers another
  // instance; see `mcpClientCache.ts`.
  if (before.subject) invalidateMcpCacheForPrincipal(before.tenantId, before.subject);
  if (updated.subject && updated.subject !== before.subject) invalidateMcpCacheForPrincipal(updated.tenantId, updated.subject);
  return updated;
}

/**
 * ADR 0815 D2 — the EFFECTIVE roles of the person a member row belongs to in its
 * org: direct ∪ group roles over EVERY row of (tenant, org, subject) — the row
 * plus its ADR 0697 legacy twins. ADR 0797's owner rule judged the addressed
 * row's DIRECT roles, so an admin could re-point a group-derived owner's row at
 * itself, delete a group-derived owner, or delete an owner by addressing the
 * owner's non-owner twin (`deleteMember` sweeps every twin).
 */
export async function relationshipRoles(memberId: string): Promise<string[]> {
  const row = await members.get(memberId);
  if (!row) return [];
  const rows = row.subject
    ? (await members.list()).filter((m) => m.tenantId === row.tenantId && m.orgId === row.orgId && m.subject === row.subject)
    : [row];
  if (!rows.some((m) => m.memberId === row.memberId)) rows.push(row);
  const ids = new Set(rows.map((m) => m.memberId));
  const groupRoles = (await groups.list())
    .filter((g) => g.tenantId === row.tenantId && g.orgId === row.orgId && g.memberIds.some((id) => ids.has(id)))
    .flatMap((g) => g.roles);
  return [...new Set([...rows.flatMap((m) => m.roles), ...groupRoles])];
}

/**
 * ADR 0815 D1a — does `subject` hold the `owner` ROLE (direct or via a group) in
 * any org of `tenantId`? The owner test for a ROOT-LESS shared tenant (the SAML
 * `default` tenant), where there is no workspace root to ask. Role-based like ADR
 * 0797's `requireOwner`, so a delegation (`apikey:`), which holds scopes and never
 * roles, is never an owner here. Fail-closed on a store error (throws).
 */
export async function holdsOwnerRoleInTenant(tenantId: string, subject: string): Promise<boolean> {
  if (isDelegatedSubject(subject)) return false;
  const mine = (await members.list()).filter((m) => m.tenantId === tenantId && m.subject === subject);
  if (mine.some((m) => m.roles.includes('owner'))) return true;
  const ids = new Set(mine.map((m) => m.memberId));
  return (await groups.list()).some((g) => g.tenantId === tenantId && g.roles.includes('owner') && g.memberIds.some((id) => ids.has(id)));
}

/**
 * ADR 0815 D4 — member-removed hooks. Removing someone from an org must take
 * down what they DELEGATED there, not only their row: a pending invite a removed
 * admin minted stayed redeemable (MEASURED). Fired per relationship and per org —
 * finer than ADR 0795's tenant-level `notifyIssuerRemoved`, which still answers
 * "has this person left the workspace". The owning feature subscribes; this
 * module imports none of them (the `onWorkflowForked` shape). Registered by id,
 * so a re-registration is a no-op. A hook's failure is logged, never thrown: the
 * removal is already durable, and failing it now would strand a half-removed
 * member.
 *
 * `reason: 'demoted'` — the same hooks run when an update leaves the person
 * without `host:members:manage` in that org, since an invite is a delegation of
 * exactly that authority (an open question of the unmerged row-12 draft). A hook that only cares
 * about leaving (none today) checks the reason.
 */
export interface MemberAuthorityLost {
  tenantId: string;
  orgId: string;
  subject: string;
  /** Every row id of the relationship (the row plus its twins). */
  memberIds: string[];
  /** The relationship's direct roles: what it held when removed, or holds now when demoted. */
  roles: string[];
  reason: 'removed' | 'demoted';
  /** Who did it, when the caller knows (the admin route, account deletion). */
  actor?: string;
}
export type MemberAuthorityLostHook = (lost: MemberAuthorityLost) => Promise<number>;
const memberAuthorityLostHooks: Array<{ id: string; hook: MemberAuthorityLostHook }> = [];
export function onMemberAuthorityLost(id: string, hook: MemberAuthorityLostHook): void {
  if (!memberAuthorityLostHooks.some((h) => h.id === id)) memberAuthorityLostHooks.push({ id, hook });
}
export async function runMemberAuthorityLostHooks(lost: MemberAuthorityLost): Promise<void> {
  for (const { id, hook } of memberAuthorityLostHooks) {
    try {
      const n = await hook(lost);
      if (n > 0) accessLog.info('member_authority_lost_cascade', { hook: id, reason: lost.reason, tenantId: lost.tenantId, orgId: lost.orgId, count: n });
    } catch (err) {
      accessLog.error('member_authority_lost_hook_failed', {
        hook: id, reason: lost.reason, tenantId: lost.tenantId, orgId: lost.orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Delete a member and remove it from any group's `memberIds`. Enforces the
 *  ≥1-owner invariant atomically (post-write re-check + compensating restore);
 *  removing a workspace's last owner is rejected with `conflict` (409). Bulk
 *  org-deletion deletes member rows via `members.delete()` directly, so it is
 *  not subject to this guard (a whole-workspace teardown, not a member removal). */
export async function deleteMember(memberId: string, opts: { actor?: string } = {}): Promise<boolean> {
  const member = await members.get(memberId);
  if (!member) return false;
  const existed = await members.delete(memberId);
  if (!existed) return false;
  // ADR 0697 D2 — removal is about the RELATIONSHIP, not the row it happens to be
  // stored as. D1 stops NEW twins; it cannot un-write the ones a race already
  // committed, and those are in production today. Deleting only the row the
  // operator could see left the twin behind, and `isWorkspaceMember`'s
  // authoritative fallback re-granted membership from it — the removal did not
  // hold, with nothing anywhere in an error state to say so. D1 without this
  // closes the ban path on paper and leaves it open on the existing data.
  //
  // THE SWEEP MUST SEE EXACTLY WHAT THE CHECK SEES, or removal still does not
  // hold. `isWorkspaceMember` ends on `members.list()` — it never denies on the
  // bounded slice alone — so a twin missing from the tenant index would be
  // invisible here and authoritative there. Hence the same full read. That is
  // affordable precisely here: this is a cold, rare, operator-initiated path,
  // and it already runs an unconditional `groups.list()` two statements below.
  // ADR 0684 §6 bounds the HOT paths; this is not one.
  const twins: OrgMember[] = [];
  if (indexableWorkspaceMember(member)) {
    for (const m of await members.list()) {
      if (m.memberId === memberId) continue;
      if (m.tenantId !== member.tenantId || m.orgId !== member.orgId) continue;
      if (m.subject !== member.subject) continue;
      if (await members.delete(m.memberId)) twins.push(m);
    }
  }
  const removed: OrgMember[] = [member, ...twins];
  // ADR 0684 phase 5 — drop the point-read entry. Done BEFORE the owner
  // compensating-restore below re-adds it, so the two stay consistent either way.
  await unindexWorkspaceMember(member);
  // The owner invariant is counted over EVERYTHING just removed: a duplicated
  // owner removed one row at a time would pass this check on the first delete
  // and strand the workspace on the second.
  if (removed.some((m) => m.roles.includes('owner')) && (await countOwners(member.tenantId, member.orgId)) === 0) {
    for (const m of removed) await members.put(m); // compensating restore — never orphan a workspace
    await indexWorkspaceMember(member); // ...and restore its index entry with it
    throw new OpenwopError('conflict', LAST_OWNER_MSG, 409, { orgId: member.orgId, memberId, reason: 'last_owner' });
  }
  const removedIds = new Set(removed.map((m) => m.memberId));
  for (const g of (await groups.list()).filter((g) => g.memberIds.some((id) => removedIds.has(id)))) {
    g.memberIds = g.memberIds.filter((id) => !removedIds.has(id));
    g.updatedAt = nowIso();
    await groups.put(g);
  }
  // ADR 0434 P4 / IDN-9 — a subject who just lost membership may still hold a
  // stored active-workspace preference pointing at this workspace. Resolution
  // already fail-closes on the membership re-check, so leaving it is SAFE, not
  // a bypass; clearing it is hygiene — it stops the removed member's next
  // sign-in from silently resolving-then-discarding, and it does not leave the
  // deleted relationship implied by a dangling row. Best-effort and scoped to
  // the workspace they were removed from.
  if (member.subject && member.orgId === member.tenantId) {
    await clearActiveWorkspaceIfPointingAt(member.subject, member.tenantId);
  }
  // H57 — same reasoning as `updateMember`, and the stronger case: this subject
  // holds no membership here any more, so every entry cached for them under
  // this tenant is stale by definition.
  if (member.subject) invalidateMcpCacheForPrincipal(member.tenantId, member.subject);
  // ADR 0795 D6 — a key stops when its issuer does. Only when this was the
  // subject's LAST membership in the tenant: leaving one org of several is not
  // leaving the workspace.
  if (member.subject) await notifyIfLastMembershipGone(member.tenantId, member.subject);
  if (member.subject) {
    await runMemberAuthorityLostHooks({
      tenantId: member.tenantId, orgId: member.orgId, subject: member.subject,
      memberIds: [...removedIds], roles: [...new Set(removed.flatMap((m) => m.roles))], reason: 'removed',
      ...(opts.actor ? { actor: opts.actor } : {}),
    });
  }
  return existed;
}

// ── Workspaces (ADR 0015 — workspace-as-tenant) ────────────────────────────────
//
// A Workspace IS the tenant — the isolation boundary that scopes all data, runs,
// BYOK secrets, and toggle bucketing (RFC 0048 §D). It is modeled as the
// accessControl Organization whose `orgId === tenantId` (the tenant's "root
// org"), so its OrgMembers ARE the workspace members and their RFC 0049 roles ARE
// the workspace roles — a SINGLE source of truth, no parallel membership system
// (the ADR-0004 lesson). Teams/Groups/CustomRoles keep working as intra-workspace
// groupings.
//
//   • Personal workspace — `orgId === tenantId === user:<hash>` (or `anon:<sid>`):
//     the caller's private scope; they are its implicit owner (route-auth
//     short-circuit) so a solo user manages their own workspace with no seeding.
//   • Shared workspace    — `orgId === tenantId === ws:<uuid>`, created explicitly;
//     authority is STRICTLY membership-derived (fail-closed) — the B2B case.

/** Mint a fresh shared-workspace tenant id. */
export function newWorkspaceTenantId(): string {
  return `ws:${randomUUID()}`;
}

/**
 * True iff `tenantId` is a SINGLE-PRINCIPAL tenant — one human's own sandbox, where
 * "tenant == principal" holds and there is nobody else to isolate from:
 *   - `anon:<sid>`  — an ephemeral anonymous demo session
 *   - `user:<hash>` — a signed-in human's personal workspace (ADR 0015)
 *   - `default`     — the single-principal demo / unauthenticated tenant
 *                     (`host/requestSubject.ts:21-27`)
 *
 * FALSE for a shared `ws:` workspace, which ADR 0015 defines as multi-member, and
 * false for any other shape by construction — an allowlist, so an unrecognised
 * tenant shape fails CLOSED rather than inheriting a single-principal assumption.
 *
 * Exists so the demo de-facto-owner exception (GC-6 / ADR 0508) can be scoped to the
 * tenants its rationale actually describes; keep it the ONE home for that rule so a
 * second copy cannot drift from this one.
 */
export function isSinglePrincipalTenant(tenantId: string): boolean {
  return tenantId === 'default' || tenantId.startsWith('anon:') || tenantId.startsWith('user:');
}

/**
 * ADR 0815 D1b — a SHARED workspace (ADR 0015 `ws:`): a multi-member tenant
 * whose root org IS the workspace. There, being in the workspace means holding
 * the root membership (`isWorkspaceMember`), so tenant-wide authority — roles
 * and every scope — is the root membership's. A sub-org row is authority inside
 * that sub-org only. Keyed on the id shape, so the hot-path resolvers add no read.
 */
export function isSharedWorkspaceTenant(tenantId: string): boolean {
  return tenantId.startsWith('ws:');
}

/**
 * ADR 0910 D0 — the feature-declared default workspaces (`host-kicktodo`, ADR 0684)
 * are multi-principal like a `ws:` workspace but not `ws:`-shaped, so every ADR 0815
 * D1b rule keyed on {@link isSharedWorkspaceTenant} missed them: a sub-org `owner`
 * row there contributed OWNER_SCOPES to the tenant-wide union (an env key could
 * `POST /orgs` and pass `requireKicktodoManage` through the sub-org it seeded).
 * Registered at boot from the same declarations `setDefaultWorkspaceTargets` gets.
 */
const membershipRootedDefaults = new Set<string>();

/** ADR 0910 D0 — replace the declared default workspace ids (boot; tests). */
export function registerMembershipRootedWorkspaces(ids: readonly string[]): void {
  membershipRootedDefaults.clear();
  for (const id of ids) membershipRootedDefaults.add(id);
}

/**
 * ADR 0910 D0 — a workspace whose tenant-wide AUTHORITY is its root membership only:
 * every `ws:` workspace and every declared default workspace. Used at the authority
 * sites ONLY. {@link isSharedWorkspaceTenant} is deliberately left `ws:`-only: its
 * notification callers would otherwise materialise every broadcast per participant
 * in a default workspace, the full-roster fan-out ADR 0684 §6 forbids.
 */
export function isMembershipRootedWorkspace(tenantId: string): boolean {
  return isSharedWorkspaceTenant(tenantId) || membershipRootedDefaults.has(tenantId);
}

/**
 * THE definition of a workspace root: an org whose id IS its tenant id.
 *
 * Everything below wraps this, and until the ADR 0684 correction nothing did —
 * `isWorkspaceOrg` existed with ZERO callers while five sites open-coded
 * `orgId === tenantId` against two different row types. That is not a style
 * point: `featureDefaultOrgs` enforced the OPPOSITE rule for a year, and
 * because the definition lived in five places and the assertion in a sixth,
 * nothing could notice they disagreed. A declared default org was provisioned,
 * joined and made active, and was still unenterable — measured in production
 * 2026-09-15. One named predicate is what makes that contradiction a compile
 * -time or test-time question instead of a sign-in-time one.
 *
 * Takes the two ids rather than a row so the ORG shape and the MEMBER shape —
 * which carry the same field names on unrelated types — share one answer.
 */
export function isWorkspaceRootPair(orgId: string, tenantId: string): boolean {
  return orgId === tenantId;
}

/** True iff `org` is a workspace root (its org id equals its tenant). */
export function isWorkspaceOrg(org: Organization): boolean {
  return isWorkspaceRootPair(org.orgId, org.tenantId);
}

/** True iff `m` is a workspace-ROOT membership (the shape every workspace
 *  predicate matches), as opposed to a membership in a sub-org of a tenant. */
export function isWorkspaceRootMembership(m: Pick<OrgMember, 'orgId' | 'tenantId'>): boolean {
  return isWorkspaceRootPair(m.orgId, m.tenantId);
}

/** The workspace-root org for a tenant, or null (a tenant with no recorded
 *  workspace — e.g. a personal tenant the owner has never named). */
export async function getWorkspace(tenantId: string): Promise<Organization | null> {
  // Routed through `getOrg` rather than touching the collection directly. It
  // reads oddly — a tenantId passed to something named `orgId` — and that is
  // the point: a workspace root is keyed `orgId === tenantId`, so this IS an
  // org lookup wearing a confusing argument name. ADR 0513 Phase 2 adds a
  // dual-read inside `getOrg`; before this change that dual-read would have had
  // a hole precisely here, because this path never went through it.
  const org = await getOrg(tenantId);
  return org && org.orgId === org.tenantId ? org : null;
}

/** Create a NEW shared workspace with `ownerSubject` seeded as its explicit
 *  owner member. `orgId === tenantId` marks it a workspace root. */
export async function createWorkspace(input: {
  name: string;
  ownerSubject: string;
  description?: string;
  ownerDisplayName?: string;
  ownerEmail?: string;
}): Promise<Organization> {
  const now = nowIso();
  const tenantId = newWorkspaceTenantId();
  const org: Organization = {
    orgId: tenantId, // workspace root: orgId === tenantId (isWorkspaceRootPair)
    tenantId,
    name: input.name,
    slug: slugify(input.name),
    description: input.description,
    createdBy: input.ownerSubject,
    createdAt: now,
    updatedAt: now,
  };
  await orgs.put(org);
  await createMember({
    tenantId,
    orgId: tenantId,
    subject: input.ownerSubject,
    displayName: input.ownerDisplayName ?? input.ownerEmail ?? 'Owner',
    email: input.ownerEmail,
    roles: ['owner'],
  });
  return org;
}


/** Idempotently ensure a personal workspace record exists for `tenantId`
 *  (the caller's own `user:<hash>` / `anon:<sid>` tenant), seeding `ownerSubject`
 *  as owner. Returns the workspace. Safe under concurrent first-access: BOTH the
 *  org key (`orgId === tenantId`) AND the owner-member key (deterministic from
 *  `tenantId`/`subject`) are stable, so a racing caller upserts the SAME rows
 *  (last-writer-wins on identical content) rather than minting duplicates. */
export async function ensurePersonalWorkspace(input: {
  tenantId: string;
  ownerSubject: string;
  name?: string;
  ownerDisplayName?: string;
  ownerEmail?: string;
}): Promise<Organization> {
  const existing = await getWorkspace(input.tenantId);
  const now = nowIso();
  const workspace: Organization = existing ?? {
    orgId: input.tenantId,
    tenantId: input.tenantId,
    name: input.name ?? 'Personal workspace',
    slug: slugify(input.name ?? 'personal'),
    createdBy: input.ownerSubject,
    createdAt: now,
    updatedAt: now,
  };
  if (!existing) await orgs.put(workspace);
  // Seed the owner member under a DETERMINISTIC id, so concurrent first-access
  // converges to one row (the `mbr-<uuid>` path of createMember would duplicate).
  // Skip if a member with that id already exists (preserve any later role edit).
  const memberId = workspaceRootMemberId(input.tenantId, input.ownerSubject);
  if (!(await members.get(memberId))) {
    const member: OrgMember = {
      memberId,
      orgId: input.tenantId,
      tenantId: input.tenantId,
      subject: input.ownerSubject,
      displayName: input.ownerDisplayName ?? input.ownerEmail ?? 'Owner',
      ...(input.ownerEmail ? { email: input.ownerEmail } : {}),
      roles: ['owner'],
      teamIds: [],
      createdAt: now,
      updatedAt: now,
    };
    await members.put(member);
  }
  return workspace;
}

/** Is `subject` a member of the workspace identified by `workspaceId` (the
 *  workspace-root membership, `orgId === tenantId === workspaceId`)? Fail-closed. */
export async function isWorkspaceMember(subject: string, workspaceId: string): Promise<boolean> {
  const matches = (m: OrgMember): boolean =>
    isWorkspaceRootMembership(m) && m.tenantId === workspaceId && m.subject === subject;

  // ADR 0434 / IDN-7 — this runs on EVERY authenticated request (auth.ts, both
  // the bearer and cookie paths) and, since ADR 0434 P4, at session mint too.
  // It used to be `members.list()` — a full CROSS-TENANT scan whose cost grew
  // with total members across all tenants. That is the same shape as this
  // repo's prior `host_ext_kv` prefix-scan incident, on the hottest path in the
  // app.
  //
  // Fast path: a bounded scan of just this workspace's slice. `listForTenantIndexed`
  // runs a one-time guarded backfill first, so pre-existing rows are covered.
  // ADR 0684 phase 5 — POINT-READ fast path, O(1) and independent of workspace
  // size. Additive only: a HIT returns true; a MISS falls through to exactly the
  // logic that ran before, so a missing entry can never deny a real member. The
  // fast path may say "yes" and never "no" — the one direction an authorization
  // check must not fail.
  try {
    if (await memberIndex.get(memberIndexKey(workspaceId, subject))) return true;
  } catch { /* index unavailable — the paths below are authoritative */ }
  try {
    if ((await members.listForTenantIndexed(workspaceId)).some(matches)) return true;
  } catch {
    // Index unavailable (storage shape older than the marker keyspace) — fall
    // through to the authoritative scan rather than denying.
  }

  // A NEGATIVE from the index is not authoritative enough to deny on: the index
  // tolerates a missing marker ("delayed, not lost" — see hostExtPersistence),
  // and for RETENTION that is harmless, but here a missed marker would be a
  // false negative, i.e. locking a real member out of their own workspace.
  // Confirm every denial against the primary rows. Members — the common case on
  // this path — never reach here, so the hot path stays bounded.
  return (await members.list()).some(matches);
}

/** Every workspace `subject` can act in — the workspace-root orgs where the
 *  subject holds a membership, across all tenants. (A cross-tenant scan, bounded;
 *  the membership store is the source of truth.) Sorted oldest-first. */
export async function listWorkspacesForSubject(
  subject: string,
): Promise<Array<Organization & { roles: string[] }>> {
  const [allMembers, allOrgs] = await Promise.all([members.list(), orgs.list()]);
  const orgById = new Map(allOrgs.map((o) => [o.orgId, o] as const));
  const out: Array<Organization & { roles: string[] }> = [];
  for (const m of allMembers) {
    if (m.subject !== subject) continue;
    if (!isWorkspaceRootMembership(m)) continue; // workspace-root memberships only
    const org = orgById.get(m.orgId);
    if (org) out.push({ ...org, roles: [...m.roles] });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ── Owner invariant + account-delete cascade (ADR 0015 follow-ups) ──────────────
//
// A workspace MUST always retain at least one `owner` member — the ≥1-owner
// invariant. Removing or demoting the last owner would leave the workspace
// unadministrable, so the management routes guard against it and account-deletion
// blocks (rather than orphaning a shared workspace) when the caller is the sole
// owner. These primitives are the single source of truth for the owner count and
// the cross-workspace membership scan; the HTTP shaping lives in the routes
// (routes/accessControl.ts, routes/account.ts).

/** Members holding the built-in `owner` role in a workspace org. */
export async function listOwners(tenantId: string, orgId: string): Promise<OrgMember[]> {
  return (await members.list()).filter(
    (m) => m.tenantId === tenantId && m.orgId === orgId && m.roles.includes('owner'),
  );
}

/** Count of `owner` members in a workspace org (the ≥1-owner invariant). */
export async function countOwners(tenantId: string, orgId: string): Promise<number> {
  return (await listOwners(tenantId, orgId)).length;
}

/** The workspace-root memberships `subject` holds in SHARED workspaces — every
 *  membership whose org is a workspace root (`orgId === tenantId`) OTHER than the
 *  caller's own personal tenant (`excludePersonalTenant`, which is wiped directly
 *  on account delete). Drives the account-delete cascade + its sole-owner block. */
export async function sharedWorkspaceMembershipsForSubject(
  subject: string,
  excludePersonalTenant?: string,
): Promise<OrgMember[]> {
  return (await members.list()).filter(
    (m) => m.subject === subject && isWorkspaceRootMembership(m) && m.tenantId !== excludePersonalTenant,
  );
}

/** Replace `oldMemberId` with `newMemberId` in every group's `memberIds` (within
 *  the tenant) — used when a member's id is re-derived during a subject re-key, so
 *  group membership follows the member instead of dangling on the old id. */
async function repointGroupMembers(tenantId: string, oldMemberId: string, newMemberId: string): Promise<void> {
  for (const g of (await groups.list()).filter((g) => g.tenantId === tenantId && g.memberIds.includes(oldMemberId))) {
    // map old→new, then de-dup in case the group already referenced newMemberId.
    g.memberIds = [...new Set(g.memberIds.map((id) => (id === oldMemberId ? newMemberId : id)))];
    g.updatedAt = nowIso();
    await groups.put(g);
  }
}

/**
 * Re-key every membership held under `fromSubject` to `toSubject` — the
 * subject-migration primitive behind ADR 0003 Phase 4 (canonical
 * `user:<userId>` subject + account linking). Returns the count re-keyed.
 *
 * The hazard this exists to handle (architect Finding 3): a WORKSPACE-ROOT
 * membership uses the DETERMINISTIC id `mbr-<hash(tenantId, subject)>`
 * (`workspaceRootMemberId`), so its key ENCODES the subject. A plain
 * `updateMember(subject)` would leave the row addressable under the OLD derived
 * id, colliding with / shadowing the destination's seeded owner. Those rows are
 * therefore reinserted under the NEW derived id (PUT-before-DELETE, see below);
 * SUB-ORG members (`orgId !== tenantId`, still `mbr-<uuid>`) are updated in
 * place.
 *
 * CORRECTED by ADR 0697 D1 — this paragraph used to say the deterministic branch
 * was for "a personal-workspace owner member" and that "shared workspaces" took
 * the random-id branch. Both halves are now false: every workspace-root
 * membership is derived, so a SHARED workspace membership takes the
 * deterministic branch too. The code needed no change — it keys off the derived
 * id rather than off the workspace being personal — but the comment would have
 * sent the next reader looking for a bug in the branch that is working. The
 * merge-skip semantics noted below therefore now apply to shared workspaces as
 * well, which is the one behavioural consequence worth knowing.
 *
 * Crash-safety: the deterministic-id move writes the NEW row BEFORE deleting the
 * OLD one, so a crash between the two KV writes leaves BOTH (≥1 owner survives —
 * fail-safe) rather than neither (which would strand the user with no owner of
 * their own workspace). The stale old row carries `fromSubject`, which no longer
 * resolves to anyone; a re-run cleans it up. Idempotent, bounded to one subject's
 * memberships.
 *
 * Merge semantics: if an owner is already seeded at the destination id, this is
 * **last-writer-wins-skip** — the existing destination row is kept and roles are
 * NOT unioned (merging two personal workspaces is a deferred ADR 0015 question).
 */
export async function rekeyMemberSubject(
  fromSubject: string,
  toSubject: string,
  scope: { tenantId?: string } = {},
): Promise<number> {
  if (fromSubject === toSubject) return 0;
  // CE-15 — a principal string is NOT a person across tenants: `scim:jsmith` and
  // `saml:jsmith` come from per-tenant IdPs, so tenant A's and tenant B's can be
  // two humans. A caller that resolved the human INSIDE one tenant passes that
  // tenant, and only its rows move. Unscoped stays for the OIDC bind, whose one
  // configured issuer makes `oidc:<sub>` the same person everywhere.
  const mine = (await members.list()).filter(
    (m) => m.subject === fromSubject && (scope.tenantId === undefined || m.tenantId === scope.tenantId),
  );
  let rekeyed = 0;
  for (const m of mine) {
    if (m.memberId === workspaceRootMemberId(m.tenantId, fromSubject)) {
      // Workspace-root membership: its id encodes the subject, so the id is
      // re-derived. PUT-before-DELETE keeps ≥1 owner across a crash.
      const newId = workspaceRootMemberId(m.tenantId, toSubject);
      if (!(await members.get(newId))) {
        await members.put({ ...m, memberId: newId, subject: toSubject, updatedAt: nowIso() });
      }
      await repointGroupMembers(m.tenantId, m.memberId, newId);
      await members.delete(m.memberId);
    } else {
      await updateMember(m.memberId, { subject: toSubject });
    }
    // ADR 0684 phase 5 — MOVE the point-read entry with the subject. Without
    // this the index would keep asserting membership under the OLD subject and
    // know nothing of the new one — lying about precisely the subject that just
    // changed, on the path that runs at every session mint. Re-read the row
    // rather than trusting `m`: the deterministic-owner branch above re-created
    // it under a new memberId.
    await unindexWorkspaceMember(m);
    const moved = (await members.list()).find(
      (x) => x.tenantId === m.tenantId && x.orgId === m.orgId && x.subject === toSubject,
    );
    if (moved) await indexWorkspaceMember(moved);
    rekeyed += 1;
  }
  // ADR 0795 D6 — the keys this person issued are recorded under the OLD
  // spelling; move them, or binding an account orphans its own keys.
  await notifySubjectRekeyed(fromSubject, toSubject, scope);
  return rekeyed;
}

// ── Groups (cross-cutting RBAC units) ──────────────────────────────────────────

export async function createGroup(input: {
  orgId: string;
  tenantId: string;
  name: string;
  description?: string;
  roles?: string[];
  memberIds?: string[];
}): Promise<Group> {
  const now = nowIso();
  const group: Group = {
    groupId: `grp-${randomUUID().slice(0, 8)}`,
    orgId: input.orgId,
    tenantId: input.tenantId,
    name: input.name,
    description: input.description,
    roles: input.roles ? [...input.roles] : [],
    memberIds: input.memberIds ? [...input.memberIds] : [],
    createdAt: now,
    updatedAt: now,
  };
  await groups.put(group);
  return group;
}

export async function listGroups(tenantId: string, orgId: string): Promise<Group[]> {
  return (await groups.list())
    .filter((g) => g.tenantId === tenantId && g.orgId === orgId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getGroup(groupId: string): Promise<Group | null> {
  return groups.get(groupId);
}

export async function updateGroup(
  groupId: string,
  patch: { name?: string; description?: string | null; roles?: string[]; memberIds?: string[] },
): Promise<Group | null> {
  const group = await groups.get(groupId);
  if (!group) return null;
  if (patch.name !== undefined) group.name = patch.name;
  if (patch.description !== undefined) {
    if (patch.description === null) delete group.description;
    else group.description = patch.description;
  }
  if (patch.roles !== undefined) group.roles = [...patch.roles];
  if (patch.memberIds !== undefined) group.memberIds = [...patch.memberIds];
  group.updatedAt = nowIso();
  await groups.put(group);
  return group;
}

export async function deleteGroup(groupId: string): Promise<boolean> {
  return groups.delete(groupId);
}

// ── Approver-routing resolution helpers (ADR 0075 §D7) ──────────────────────────
// Point lookups that expand a group/role ref to the authenticated subjects that
// satisfy it, for HITL approver routing. Tenant/org-scoped (ADR 0075 §D5): a ref
// resolves only within the caller's (tenantId, orgId); a cross-tenant or
// cross-org ref resolves to ∅, never a leak. Members with no bound `subject`
// (descriptive members, no principal yet) contribute nothing — they can't be
// notified or vote.

/** Subjects of every member in a group. Empty if the group is missing or
 *  belongs to another tenant/org (fail-closed). */
export async function getUsersByGroup(tenantId: string, orgId: string, groupId: string): Promise<string[]> {
  const group = await groups.get(groupId);
  if (!group || group.tenantId !== tenantId || group.orgId !== orgId) return [];
  const fetched = await Promise.all(group.memberIds.map((id) => members.get(id)));
  const subjects = fetched
    .filter((m): m is OrgMember => m !== null && m.tenantId === tenantId && m.orgId === orgId)
    .map((m) => m.subject)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  return [...new Set(subjects)];
}

/** Subjects of every member who holds `roleId` as an EFFECTIVE role (direct or
 *  via group membership — mirrors `resolveEffectiveAccess`'s union) within
 *  (tenantId, orgId). Empty if no holder. */
export async function getMembersWithRole(tenantId: string, orgId: string, roleId: string): Promise<string[]> {
  const orgMembers = await listMembers(tenantId, orgId);
  const orgGroups = (await groups.list()).filter((g) => g.tenantId === tenantId && g.orgId === orgId);
  const subjects: string[] = [];
  for (const m of orgMembers) {
    if (typeof m.subject !== 'string' || m.subject.length === 0) continue;
    const groupRoles = orgGroups.filter((g) => g.memberIds.includes(m.memberId)).flatMap((g) => g.roles);
    const effective = new Set([...m.roles, ...groupRoles]);
    if (effective.has(roleId)) subjects.push(m.subject);
  }
  return [...new Set(subjects)];
}

// ── Custom roles ───────────────────────────────────────────────────────────────

export async function createCustomRole(input: {
  orgId: string;
  tenantId: string;
  name: string;
  description?: string;
  scopes: Scope[];
}): Promise<CustomRole> {
  const now = nowIso();
  const role: CustomRole = {
    roleId: `role-${randomUUID().slice(0, 8)}`,
    orgId: input.orgId,
    tenantId: input.tenantId,
    name: input.name,
    description: input.description,
    scopes: [...new Set(input.scopes)],
    createdAt: now,
    updatedAt: now,
  };
  await customRoles.put(role);
  return role;
}

export async function listCustomRoles(tenantId: string, orgId: string): Promise<CustomRole[]> {
  return (await customRoles.list())
    .filter((r) => r.tenantId === tenantId && r.orgId === orgId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getCustomRole(roleId: string): Promise<CustomRole | null> {
  return customRoles.get(roleId);
}

export async function updateCustomRole(
  roleId: string,
  patch: { name?: string; description?: string | null; scopes?: Scope[] },
): Promise<CustomRole | null> {
  const role = await customRoles.get(roleId);
  if (!role) return null;
  if (patch.name !== undefined) role.name = patch.name;
  if (patch.description !== undefined) {
    if (patch.description === null) delete role.description;
    else role.description = patch.description;
  }
  if (patch.scopes !== undefined) role.scopes = [...new Set(patch.scopes)];
  role.updatedAt = nowIso();
  await customRoles.put(role);
  return role;
}

/** Delete a custom role and scrub it from every member's + group's `roles[]`
 *  in the same tenant (no dangling references). */
export async function deleteCustomRole(roleId: string): Promise<boolean> {
  const existed = await customRoles.delete(roleId);
  if (existed) {
    for (const m of (await members.list()).filter((m) => m.roles.includes(roleId))) {
      m.roles = m.roles.filter((r) => r !== roleId);
      m.updatedAt = nowIso();
      await members.put(m);
    }
    for (const g of (await groups.list()).filter((g) => g.roles.includes(roleId))) {
      g.roles = g.roles.filter((r) => r !== roleId);
      g.updatedAt = nowIso();
      await groups.put(g);
    }
  }
  return existed;
}

/** Resolve a set of role ids (built-in or custom) to a union of scopes against
 *  a custom-role lookup. Unknown ids are dropped — fail-closed. */
function unionScopes(roleIds: readonly string[], customById: ReadonlyMap<string, CustomRole>): Scope[] {
  const set = new Set<Scope>();
  for (const id of roleIds) {
    if (isBuiltInRoleId(id)) {
      for (const s of BUILT_IN_ROLES[id].scopes) set.add(s);
    } else {
      const cr = customById.get(id);
      if (cr) for (const s of cr.scopes) set.add(s);
    }
  }
  return [...set];
}

// ── Effective-access resolution ───────────────────────────────────────────────

export interface EffectiveAccess {
  /** Resolved role ids that applied (direct ∪ group-derived; built-in or custom). */
  roles: string[];
  /** Union of scopes granted by those roles. */
  scopes: Scope[];
  /** How the resolution was reached — for the UI + audit clarity. */
  basis: 'tenant-owner' | 'member' | 'none';
  /** The member the resolution matched, when basis === 'member'. */
  memberId?: string;
  /** Roles assigned directly on the member (provenance, when basis === 'member'). */
  directRoles?: string[];
  /** Roles inherited via group membership (provenance, when basis === 'member'). */
  groupRoles?: string[];
  /**
   * The CALLER is a superadmin (`host/superadmin.ts` — env-bound tenant,
   * wildcard bearer, or the explicit dev-open switch). Set by the HTTP route
   * for the caller's own resolution only; never for a member/subject preview,
   * and never by `resolveEffectiveAccess` itself, which knows nothing about
   * the request. Presentation input for the SPA's admin chrome; every admin
   * route still gates on `isSuperadmin(req)` directly.
   */
  superadmin?: boolean;
}

/**
 * Resolve the effective access for a principal acting in a tenant.
 *
 * FAIL-CLOSED (RFC 0049): if a specific member is requested (by memberId or
 * subject) and not found, the result is empty (`none`). Authority is computed
 * ONLY from the member's explicit `roles[]` plus the roles of any GROUP it
 * belongs to — NEVER from org-chart position (RFC 0087 §B). The org-chart is
 * not consulted here at all.
 *
 * Tenant-owner exception: when no member context is supplied, the caller is
 * the tenant's own principal (tenant == principal in this demo host) and is
 * implicitly `owner`. See the file header for the multi-principal caveat.
 */
export async function resolveEffectiveAccess(
  tenantId: string,
  opts: { memberId?: string; subject?: string; orgId?: string } = {},
): Promise<EffectiveAccess> {
  if (opts.memberId === undefined && isDelegatedSubject(opts.subject)) {
    return viaDelegation<EffectiveAccess>('effective-access', tenantId, opts.subject, {
      direct: (subject) => resolveEffectiveAccessDirect(tenantId, { ...opts, subject }),
      owner: () => ({ roles: ['owner'], scopes: [...OWNER_SCOPES], basis: 'tenant-owner' }),
      none: () => ({ roles: [], scopes: [], basis: 'none' }),
      // A delegation holds scopes, not roles: a role-keyed check must not pass for it.
      narrow: (issuer, scopes) => ({ roles: [], scopes, basis: issuer.basis === 'none' ? 'none' : 'member' }),
    });
  }
  return resolveEffectiveAccessDirect(tenantId, opts);
}

/**
 * ADR 0795 D1 — resolve a delegated subject (`apikey:<id>`) through its issuer
 * and its declaration, for whichever resolver is asking. `direct` is that
 * resolver's own answer for a plain subject; the issuer is put through it
 * exactly as if the person had called, so every exit that applies to a person
 * (membership, the single-principal demo sandbox) applies to the ISSUER and
 * none applies to the key id. A personal tenant is single-principal by
 * construction, and an operator env key is the tenant's own principal
 * (ADR 0601 C4), so both resolve as the tenant owner.
 *
 * `OPENWOP_KEY_AUTHORITY=report` computes this answer, logs where it differs
 * from the pre-ADR one, and returns the pre-ADR one.
 */
async function viaDelegation<T extends { scopes: Scope[] }>(
  resolver: string,
  tenantId: string,
  subject: string,
  r: { direct: (subject: string) => Promise<T>; owner: () => T; none: () => T; narrow: (issuer: T, scopes: Scope[]) => T },
): Promise<T> {
  const mode = keyPolicyMode('OPENWOP_KEY_AUTHORITY');
  if (mode === 'off') return r.direct(subject);
  const d = await delegationOf(subject);
  let next: T;
  if (!d || d.tenantId !== tenantId) {
    next = r.none();
  } else {
    // `bearer:<8>` is an operator env key's subject: the tenant's own principal
    // while that key is still configured, nobody once it is rotated out.
    const issuer = d.issuer.startsWith('bearer:')
      ? (isConfiguredOperatorIssuer(d.issuer) ? r.owner() : r.none())
      : isPersonalTenantId(tenantId) ? r.owner() : await r.direct(d.issuer);
    next = isNarrowingDeclaration(d.declaredScopes)
      ? r.narrow(issuer, issuer.scopes.filter((sc) => d.declaredScopes.includes(sc)))
      : issuer;
  }
  if (mode === 'enforce') return next;
  const legacy = await r.direct(subject);
  const lost = legacy.scopes.filter((sc) => !next.scopes.includes(sc));
  const gained = next.scopes.filter((sc) => !legacy.scopes.includes(sc));
  if (lost.length > 0 || gained.length > 0) {
    reportKeyPolicy('authority', d?.id ?? subject, { resolver, tenantId, lost: lost.length, gained: gained.length, live: d !== null });
  }
  return legacy;
}

/** Is membership how one is PRESENT in `tenantId` at all? A shared `ws:`
 *  workspace (ADR 0015 — strictly membership-derived), or any tenant once RFC
 *  0049 enforcement is on. In a deployment-named tenant with enforcement off
 *  nobody is a member, so "no member row" there must not read as "gone" (ADR
 *  0795 D6 MEASURED 30 tests the first time a check asked the wider question).
 *  Shared by the key-issuer check and the ADR 0815 D4 schedule cascade. */
export function membershipDefinesPresence(tenantId: string): boolean {
  return isSharedWorkspaceTenant(String(tenantId)) || process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT === 'true';
}

/**
 * ADR 0795 D6 — does the delegation behind `subject` still have a live issuer
 * in `tenantId`? Asked at AUTHENTICATION, so it holds on every lane whether or
 * not RFC 0049 membership enforcement is on. "Live" is the tenant-level reading
 * (`resolveTenantLevelScopes`): a member, or the one principal of a
 * single-principal tenant. Independent of the `report` switch — the caller
 * decides what to do with the answer.
 */
export async function delegationIssuerIsLive(tenantId: string, subject: string): Promise<boolean> {
  const d = await delegationOf(subject);
  if (!d || d.tenantId !== tenantId) return false;
  if (d.issuer.startsWith('bearer:')) return isConfiguredOperatorIssuer(d.issuer);
  // A DISABLED account (SCIM deprovision, an admin's deactivate) loses its
  // sessions; its keys must not outlive them. Only a row that says disabled
  // counts: "no row" is an issuer this host never registered (a seed actor), and
  // erasure deletes keys outright.
  if (d.issuer.startsWith('user:') && isSessionAuthorityRegistered()) {
    const state = await resolveSessionSubject(d.issuer);
    if (state !== null && state.status !== 'active') return false;
  }
  if (isPersonalTenantId(tenantId)) return true;
  // Membership decides "still here" only where membership is how one is here at
  // all: a shared `ws:` workspace (ADR 0015 — strictly membership-derived), or
  // any tenant once RFC 0049 enforcement is on. In a deployment-named tenant
  // with enforcement off nobody is a member, and reading "no member row" as
  // "gone" would kill every key there (MEASURED: 30 tests, the first time this
  // function asked the wider question).
  if (!membershipDefinesPresence(tenantId)) return true;
  // STRICT read: a store error must surface, never read as "no membership".
  if (await subjectHasMembershipStrict(tenantId, d.issuer)) return true;
  return isSinglePrincipalTenant(tenantId);
}

/**
 * Does `subject` hold ANY membership in `tenantId`? Unlike
 * `resolveSubjectScopesUnion` this THROWS on a store error. That resolver fails
 * closed by answering "none", which is right for an authorization check and
 * wrong for a caller about to act on absence: revoking someone's keys because a
 * list call blipped is not failing closed, it is destroying credentials.
 */
async function subjectHasMembershipStrict(tenantId: string, subject: string): Promise<boolean> {
  // ADR 0815 D4 — in a shared workspace, being here IS holding the root row (the
  // `isWorkspaceMember` reading). Counting any row kept a member removed from the
  // workspace "present" through a leftover sub-org row: keys live, schedules firing.
  const shared = isMembershipRootedWorkspace(tenantId); // ADR 0910 D0
  return (await members.list()).some((m) => m.tenantId === tenantId && m.subject === subject && (!shared || isWorkspaceRootMembership(m)));
}

/** ADR 0795 D6 — tell the delegation store that `subject` holds no membership in `tenantId` any more. */
async function notifyIfLastMembershipGone(tenantId: string, subject: string): Promise<void> {
  let stillMember: boolean;
  try {
    stillMember = await subjectHasMembershipStrict(tenantId, subject);
  } catch (err) {
    accessLog.error('membership read failed after a removal — leaving the subject’s keys alone', { tenantId, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!stillMember) await notifyIssuerRemoved(tenantId, subject);
}

/**
 * ADR 0795 — the scopes a delegation's ISSUER holds at tenant level, for a lane
 * that verifies a key against a scope grammar of its own (the entities API) and
 * must still not grant what the issuer lacks.
 */
export async function delegationIssuerScopes(tenantId: string, issuer: string): Promise<readonly Scope[]> {
  if (issuer.startsWith('bearer:')) return isConfiguredOperatorIssuer(issuer) ? [...OWNER_SCOPES] : [];
  if (isDelegatedSubject(issuer)) return [];
  return (await resolveTenantLevelScopes(tenantId, issuer)).scopes;
}

async function resolveEffectiveAccessDirect(
  tenantId: string,
  opts: { memberId?: string; subject?: string; orgId?: string } = {},
): Promise<EffectiveAccess> {
  if (opts.memberId !== undefined || opts.subject !== undefined) {
    // ADR 0006 Phase 2: when `orgId` is given, resolve the member IN THAT org —
    // a subject can be a member of several orgs with different roles, so authority
    // is per-(subject, org), not "first match in the tenant".
    //
    // ADR 0815 D1b — a subject asked about WITHOUT an org in a shared workspace is
    // asked about the WORKSPACE, which is its root membership. First-match let a
    // root Viewer who had minted a sub-org resolve as that sub-org's owner on
    // every tenant-level reader (developer-key admin, approvals SLA, promotion
    // approval, `/access/effective`).
    const orgId = opts.orgId ?? (opts.memberId === undefined && isMembershipRootedWorkspace(tenantId) ? tenantId : undefined); // ADR 0910 D0
    const isTarget = (m: OrgMember): boolean =>
      m.tenantId === tenantId &&
      (orgId === undefined || m.orgId === orgId) &&
      (opts.memberId !== undefined ? m.memberId === opts.memberId : m.subject === opts.subject);
    // ADR 0866 — a miss from the index is confirmed by the scan: absence here
    // denies, or grants OWNER through the demo bypass below.
    const member = (await indexedTenantMembers(tenantId))?.find(isTarget) ?? (await scanTenantMembers(tenantId)).find(isTarget);
    if (!member) {
      // Demo single-tenant exception: in demo mode the tenant is a one-principal
      // sandbox (tenant == principal — see file header + the tenant-owner branch
      // below), so a subject with no explicit member record IS the de-facto owner
      // of its own ephemeral workspace. Mirror the owner branch instead of 403-ing
      // read surfaces (e.g. /advisors `workspace:read`) for anonymous demo users
      // who never set up RBAC members. OUTSIDE demo mode this stays FAIL-CLOSED
      // (RFC 0049): an unknown subject resolves to zero scopes.
      //
      // GC-6 / ADR 0508 — and ONLY for a genuinely single-principal tenant. The
      // exception's own rationale ("the tenant is a one-principal sandbox") is
      // false for a SHARED `ws:` workspace, which ADR 0015 defines as multi-member:
      // there, "no member row for this org" means the caller is NOT a member, which
      // is exactly the case that must fail closed. Unnarrowed, a workspace VIEWER
      // querying a sub-org they do not belong to resolves to OWNER.
      //
      // Today `requireOrgScope`'s home-vs-active tenant bug (ADR 0508) 404s before
      // reaching here, so the shared-workspace path is unreachable and this narrowing
      // is a no-op in practice. That is precisely why it lands FIRST: fixing that
      // guard (GC-5) without this would open the bypass rather than close it.
      if (demoMode() && isSinglePrincipalTenant(tenantId)) {
        // LEAK-9: this grants anonymous OWNER scope to any unknown subject. It is
        // correctly gated on OPENWOP_DEMO_MODE (fail-closed below when off), but an
        // ACCIDENTAL demo-mode enable in an enterprise deploy would silently hand
        // out owner rights. Alarm it so the misconfiguration is visible, never
        // silent. (Off in production; the demo deploy expects this line.)
        accessLog.warn('demo_owner_bypass_granted', {
          tenantId,
          subject: opts.subject ?? opts.memberId,
          note: 'OPENWOP_DEMO_MODE grants anonymous owner scope — MUST be off in any real deploy',
        });
        return { roles: ['owner'], scopes: [...OWNER_SCOPES], basis: 'tenant-owner' };
      }
      return { roles: [], scopes: [], basis: 'none' };
    }
    // Custom roles defined in this member's org, for scope resolution.
    const orgCustom = (await customRoles.list()).filter((r) => r.tenantId === tenantId && r.orgId === member.orgId);
    const customById = new Map(orgCustom.map((r) => [r.roleId, r]));
    const directRoles = [...member.roles];
    // Roles inherited via group membership (batch permission management).
    const memberGroups = (await groups.list()).filter(
      (g) => g.tenantId === tenantId && g.memberIds.includes(member.memberId),
    );
    const groupRoles = [...new Set(memberGroups.flatMap((g) => g.roles))];
    const roles = [...new Set([...directRoles, ...groupRoles])];
    return { roles, scopes: unionScopes(roles, customById), basis: 'member', memberId: member.memberId, directRoles, groupRoles };
  }
  // No member context → the tenant owner principal, implicitly `owner`.
  return { roles: ['owner'], scopes: [...OWNER_SCOPES], basis: 'tenant-owner' };
}

/**
 * Protocol-surface authority (ADR 0006 Phase 3): the UNION of a subject's scopes
 * across ALL of its org memberships in the tenant.
 *
 * The protocol runs/artifacts surface is NOT org-scoped, so the org-scoped,
 * first-match `resolveEffectiveAccess({ subject })` is the wrong tool — a subject
 * that is `viewer` in org-A and `editor` in org-B would otherwise resolve to
 * whichever membership the store happened to return first (non-deterministic).
 * Here every membership contributes, so `runs:create` is granted iff the subject
 * holds it in ANY org.
 *
 * FAIL-CLOSED (RFC 0049 §C): a subject with no membership ⇒ zero scopes; a
 * resolver error ⇒ zero scopes (logged, never default-allow). Reads each of the
 * three stores exactly once (parallelized), independent of org count.
 */
/**
 * ADR 0731 — tenant-level (NON-org-scoped) authority for a SESSION caller.
 *
 * The union of the subject's scopes across their org memberships, PLUS the one
 * documented exit: a **single-principal tenant is its own owner**. An ADR 0372
 * anonymous sandbox (`anon:`), a personal tenant (`user:`) and `default` each hold
 * exactly one principal by construction, so there is nobody to escalate over —
 * this is the same rationale `resolveEffectiveAccess` states at its demo branch,
 * narrowed the same way GC-6 / ADR 0508 narrowed that one: a SHARED `ws:`
 * workspace is multi-member, so "no member row" there means NOT a member, which
 * must fail closed.
 *
 * Use this for workspace-scoped host surfaces (entities, environments). Do NOT use
 * `resolveEffectiveAccess({ subject })` for them: it is org-scoped first-match and
 * therefore non-deterministic for a subject with memberships in several orgs.
 */
export async function resolveTenantLevelScopes(
  tenantId: string,
  subject: string,
): Promise<{ scopes: Scope[]; basis: 'member' | 'tenant-owner' | 'none' }> {
  type Level = { scopes: Scope[]; basis: 'member' | 'tenant-owner' | 'none' };
  // The single-principal exit below belongs to a PERSON in their own sandbox. A
  // key id handed straight to it would be "nobody's member" and so the owner.
  const direct = async (sub: string): Promise<Level> => {
    const union = await resolveSubjectScopesUnionDirect(tenantId, sub);
    if (union.basis === 'member') return union;
    if (isSinglePrincipalTenant(tenantId)) return { scopes: [...OWNER_SCOPES], basis: 'tenant-owner' };
    return { scopes: [], basis: 'none' };
  };
  if (isDelegatedSubject(subject)) {
    return viaDelegation<Level>('tenant-level', tenantId, subject, {
      direct,
      owner: () => ({ scopes: [...OWNER_SCOPES], basis: 'tenant-owner' }),
      none: () => ({ scopes: [], basis: 'none' }),
      narrow: (issuer, scopes) => ({ scopes, basis: issuer.basis === 'none' ? 'none' : 'member' }),
    });
  }
  return direct(subject);
}

/**
 * ADR 0732 — does ANY member of the tenant OTHER than `excludeSubject` hold
 * `scope`? Separation of duties is only meaningful when a second eligible
 * decider exists: `createWorkspace` mints a single `owner` member, so a
 * one-admin workspace is the DEFAULT state and a distinct-approver rule with no
 * exit would brick it.
 *
 * Reads each store once (like `resolveSubjectScopesUnion`) rather than resolving
 * per member. FAIL-CLOSED on a resolver error means returning `true` here — "a
 * distinct approver exists" is the answer that makes the CALLER refuse, so an
 * unreadable store must not hand out a self-approval exemption.
 */
export async function hasDistinctScopeHolder(
  tenantId: string,
  scope: Scope,
  excludeSubject: string,
  /** ADR 0845 D5 — ask about ONE org (the decide bar of an org-scoped gate). The
   *  member filter is then exactly `m.orgId === orgId`, the match
   *  `resolveEffectiveAccessDirect` uses for an org-scoped resolve, and the
   *  shared-workspace root-only skip below does NOT apply: stacking it on an org
   *  filter would skip every sub-org member and always answer "no distinct holder",
   *  i.e. fail OPEN. Omitted ⇒ the workspace-wide question, unchanged. */
  opts: {
    orgId?: string;
    /** ADR 0859 D4 (code grade CMSA2CD-3) — further subjects that do NOT count as
     *  distinct. A review can have several submitters; asking "is there a holder other
     *  than the decider?" let two submitting admins each be refused for the other,
     *  and the page stuck with nobody able to approve it. */
    alsoExclude?: readonly string[];
  } = {},
): Promise<boolean> {
  try {
    const excluded = new Set<string>([excludeSubject, ...(opts.alsoExclude ?? [])]);
    const [indexed, allGroups, allCustom] = await Promise.all([
      indexedTenantMembers(tenantId),
      groups.list(),
      customRoles.list(),
    ]);
    const holderIn = (rows: readonly OrgMember[]): boolean => {
    for (const m of rows) {
      if (m.tenantId !== tenantId || (m.subject !== undefined && excluded.has(m.subject))) continue;
      if (opts.orgId !== undefined) {
        if (m.orgId !== opts.orgId) continue;
      } else if (isMembershipRootedWorkspace(tenantId) && !isWorkspaceRootMembership(m)) { // ADR 0910 D0
        // ADR 0815 D1b — a sub-org role is not a workspace-wide decider.
        continue;
      }
      const customById = new Map(
        allCustom
          .filter((r) => r.tenantId === tenantId && r.orgId === m.orgId)
          .map((r) => [r.roleId, r] as const),
      );
      const groupRoles = allGroups
        .filter((g) => g.tenantId === tenantId && g.memberIds.includes(m.memberId))
        .flatMap((g) => g.roles);
      const roles = [...new Set([...m.roles, ...groupRoles])];
      if (unionScopes(roles, customById).includes(scope)) return true;
    }
    return false;
    };
    // ADR 0866 — `false` grants the self-approval exemption, so the index may
    // only answer `true`; a `false` is confirmed against the full scan.
    if (indexed !== null && holderIn(indexed)) return true;
    return holderIn(await scanTenantMembers(tenantId));
  } catch (err) {
    accessLog.error('hasDistinctScopeHolder failed — assuming a distinct approver exists', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

export async function resolveSubjectScopesUnion(
  tenantId: string,
  subject: string,
): Promise<{ scopes: Scope[]; basis: 'member' | 'none' }> {
  if (isDelegatedSubject(subject)) {
    return viaDelegation<{ scopes: Scope[]; basis: 'member' | 'none' }>('scopes-union', tenantId, subject, {
      direct: (sub) => resolveSubjectScopesUnionDirect(tenantId, sub),
      owner: () => ({ scopes: [...OWNER_SCOPES], basis: 'member' }),
      none: () => ({ scopes: [], basis: 'none' }),
      narrow: (issuer, scopes) => ({ scopes, basis: issuer.basis }),
    });
  }
  return resolveSubjectScopesUnionDirect(tenantId, subject);
}

async function resolveSubjectScopesUnionDirect(
  tenantId: string,
  subject: string,
): Promise<{ scopes: Scope[]; basis: 'member' | 'none' }> {
  try {
    const [indexed, allGroups, allCustom] = await Promise.all([
      indexedTenantMembers(tenantId),
      groups.list(),
      customRoles.list(),
    ]);
    // ADR 0815 D1b — in a shared workspace only the ROOT membership is
    // tenant-wide; a sub-org row was a door (a Viewer minted a sub-org, owned it,
    // and the union handed them workspace management and `workspace:write`).
    const shared = isMembershipRootedWorkspace(tenantId); // ADR 0910 D0 — default workspaces too
    const isMine = (m: OrgMember): boolean => m.tenantId === tenantId && m.subject === subject && (!shared || isWorkspaceRootMembership(m));
    // ADR 0866 — a partial answer from the index only narrows the union (fails
    // closed); an EMPTY one is confirmed against the full scan before it denies.
    let mine = indexed?.filter(isMine) ?? [];
    if (mine.length === 0) mine = (await scanTenantMembers(tenantId)).filter(isMine);
    if (mine.length === 0) return { scopes: [], basis: 'none' };
    const scopeSet = new Set<Scope>();
    for (const m of mine) {
      // Custom roles are org-scoped, so resolve them per the membership's org.
      const customById = new Map(
        allCustom
          .filter((r) => r.tenantId === tenantId && r.orgId === m.orgId)
          .map((r) => [r.roleId, r] as const),
      );
      const groupRoles = allGroups
        .filter((g) => g.tenantId === tenantId && g.memberIds.includes(m.memberId))
        .flatMap((g) => g.roles);
      const roles = [...new Set([...m.roles, ...groupRoles])];
      for (const s of unionScopes(roles, customById)) scopeSet.add(s);
    }
    return { scopes: [...scopeSet], basis: 'member' };
  } catch (err) {
    // RFC 0049 §C: resolver errors MUST deny (the host advertises
    // `authorization.failClosed: true`). Surface for ops, then fail closed.
    accessLog.error('resolveSubjectScopesUnion failed — failing closed', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { scopes: [], basis: 'none' };
  }
}

/**
 * The TENANT-LEVEL authority decision (USERS-19 / ADR 0617 D2) — the body of
 * `featureRoute.requireTenantScope`, extracted so it is a `(tenantId, subject)`
 * function core + the run lane can share with the HTTP lane (one predicate, two
 * callers — the `assistant/writeAuthority.ts` discipline). Fail-closed, in order:
 *
 *   1. `ctx.wildcardOperator` — the env API key / admin token / conformance
 *      harness acts across tenants (the trusted escape hatch every other gate
 *      honours). The CALLER threads this from `req.principal.tenants` — it is
 *      never inferred here.
 *   2. The implicit PERSONAL OWNER: `ctx.personalTenant === tenantId` AND the
 *      tenant has a personal SHAPE (`isPersonalTenantId`: `user:` / `anon:`). The
 *      shape guard is the USERS-19 fix — the SAML ACS mints `personalTenant` as
 *      the ONE host-global SAML tenant, so before it every SAML member satisfied
 *      "personal === active" and bypassed membership on every route behind this
 *      gate. A `user:` tenant is single-human by construction
 *      (`usersGuards.ts` canonical-user model); an `anon:` tenant is one
 *      session's sandbox; nothing else qualifies (not `default`, not `ws:`).
 *   3. Otherwise the subject's TENANT-WIDE scope union across ALL org
 *      memberships (`resolveSubjectScopesUnion`) MUST include `scope`. No
 *      subject, or a non-member (zero scopes) ⇒ `403 forbidden_scope`.
 *
 * Enforced UNCONDITIONALLY (not behind OPENWOP_AUTHORIZATION_ENFORCEMENT): the
 * callers are NON-normative `/v1/host/openwop-app/*` surfaces, never advertised
 * as an RFC 0049 wire capability, so deferring enforcement would leave the
 * privilege escalation open in the default posture.
 */
export async function assertTenantScope(
  tenantId: string,
  subject: string | undefined,
  scope: Scope,
  ctx: { personalTenant?: string; wildcardOperator?: boolean } = {},
): Promise<void> {
  if (ctx.wildcardOperator === true) return;
  if (ctx.personalTenant === tenantId && isPersonalTenantId(tenantId)) return; // implicit personal owner
  if (!subject) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  }
  const { scopes } = await resolveSubjectScopesUnion(tenantId, subject);
  if (!scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  }
}

// ── ADR 0464 P2 — DSAR subject erasure ───────────────────────────────────────
// An ACL is structure, not a diary: silently DELETING an erased subject's
// membership could change who can administer a workspace (worst case drop its
// last owner) — the ACL must not shift under a DSAR. So a membership row is
// ANONYMIZED, not removed: the person's declared PII (`displayName`, `email`) is
// redacted to the sentinel while the OPAQUE `subject` key and the `roles[]` are
// KEPT, so the authority graph is byte-for-byte unchanged and the subject key
// stays available for the identity-link resolver. Org `createdBy` (the creating
// principal) is likewise anonymized in place. Every other member/org is
// untouched. Direct collection writes (the mutator guards — ≥1-owner, etc. —
// don't apply to a PII redaction that changes no roles). Idempotent; tenant-
// scoped; fail-closed on falsy input.

/** DSAR eraser — redact the subject's membership PII (keep subject + roles) and
 *  anonymize org `createdBy`, tenant-wide. */
export async function eraseSubjectAccessControl(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const m of (await members.list()).filter((m) => m.tenantId === tenantId)) {
    if (m.subject === undefined || !forms.has(m.subject)) continue;
    // KEEP `subject` + `roles` (ACL structure must not change); redact PII only.
    const next: OrgMember = { ...m, displayName: ERASED, updatedAt: nowIso() };
    if (next.email !== undefined) next.email = ERASED;
    await members.put(next);
  }
  // `listOrgs(tenantId)` instead of a hand-rolled `orgs.list()` + filter. Same
  // result today, but this is the ERASURE path: a row missed here leaves a
  // subject's identifier behind after they asked for it to be gone. It should
  // not be reading the collection by a second, private route.
  for (const o of await listOrgs(tenantId)) {
    if (!forms.has(o.createdBy)) continue;
    await orgs.put({ ...o, createdBy: ERASED, updatedAt: nowIso() });
  }
}

/** Register the access-control DSAR eraser (idempotent — the seam dedupes by
 *  reference). Called from the host-erasers boot step (host/hostSubjectErasers.ts). */
export function registerAccessControlErasure(): void {
  registerSubjectEraser(eraseSubjectAccessControl);
}

// ── Test-only resets ───────────────────────────────────────────────────────────
/** Test-only (ADR 0684 phase 5): drop ONE point-read entry, to prove the fast
 *  path is additive — a membership with no entry must still resolve true. */
export async function __dropMemberIndexForTest(workspaceId: string, subject: string): Promise<void> {
  await memberIndex.delete(memberIndexKey(workspaceId, subject));
}


export async function __resetAccessStores(): Promise<void> {
  await orgs.__clear();
  await teams.__clear();
  await members.__clear();
  await groups.__clear();
  await customRoles.__clear();
}
