/**
 * Shared feature-route helpers (ADR 0001). Every feature package gates its
 * host-extension routes on toggle STATE at request time and scopes data to the
 * caller's tenant; these three helpers were copy-pasted into `users`, `orgs`,
 * and `profiles` routes. One definition so toggle/tenant semantics can't drift
 * between features.
 */
import type { Request } from 'express';
import { OpenwopError } from '../types.js';
import { requestOrigin } from '../host/requestOrigin.js';
import { resolveToggle } from '../host/featureToggles/service.js';
import { isListedSuperadmin } from '../host/superadmin.js';
import { isSellableBundleFeature } from '../host/featureBundles.js';
import { checkEntitlement } from '../host/entitlementSeam.js';
import type { ResolvedAssignment, ToggleSubject } from '../host/featureToggles/types.js';
import { assertOrgScope, assertTenantScope, resolveSubjectScopesUnion, type Scope } from '../host/accessControlService.js';
import { callerSubject, isOwnPersonalWorkspace, personalTenantOf } from '../host/requestSubject.js';
import { credentialScopesIn, keyDeclarationPermits } from '../host/protocolAuthorization.js';
import { resolveCallerUser } from './users/usersGuards.js';
import type { User } from './users/usersService.js';
import { VENDOR_ROOT } from '../middleware/protocolVersion.js';

/** The caller's tenant ('default' for the single-principal demo). */
export function tenantOf(req: Request): string {
  return req.tenantId ?? 'default';
}

/** The toggle-bucketing subject: tenant + (when present) the principal id. */
export function toggleSubjectOf(req: Request): ToggleSubject {
  const subject: ToggleSubject = { tenantId: tenantOf(req) };
  if (req.principal?.principalId) subject.userId = req.principal.principalId;
  // ADR 0819 §1 — the listed operator keeps every feature in any workspace they
  // act in (the person-level exemption `requireEntitledFeature` already grants),
  // so a lane resolving through `resolveOne` with this subject does not paywall them.
  if (isListedSuperadmin(req)) subject.planExempt = true;
  return subject;
}

/** ADR 0820 §7 / G6 — the launch subject for the owning-feature run-start gate:
 *  the caller's user + operator plan exemption, WITHOUT the tenant (a launch
 *  names its own target tenant, which may differ from `req.tenantId` for an
 *  operator). */
export function launchSubjectOf(req: Request): Omit<ToggleSubject, 'tenantId'> {
  const { tenantId: _tenant, ...rest } = toggleSubjectOf(req);
  return rest;
}

/**
 * Resolve the caller's assignment for `toggleId`; throw a 404 (the surface does
 * not exist for them) when off — backend authority, ADR 0001 §3.4. `label` names
 * the feature in the error message.
 */
export async function requireFeatureEnabled(req: Request, toggleId: string, label: string): Promise<ResolvedAssignment> {
  // ADR 0819 §1 — the TOGGLE only here: the plan is checked just below through
  // `checkEntitlement`, which keeps this route's distinct 403 (the FE renders it
  // as the upgrade lock) instead of the 404 an access-resolved "off" would give.
  const assignment = await resolveToggle(toggleId, toggleSubjectOf(req));
  if (!assignment || !assignment.enabled) {
    throw new OpenwopError('not_found', `${label} is not enabled for this tenant.`, 404, { feature: toggleId });
  }
  // ADR 0419 — the central paid-bundle paywall. A feature that belongs to a
  // SELLABLE bundle gates on the tenant's plan/bundle entitlement, at this ONE
  // universal choke (every gated route calls this — inline OR via authorizeOrgScope).
  // Scoped so it can't over-gate: ONLY bundle features (core/standalone skip), and
  // ONLY authenticated callers (`req.principal` is absent on public routes → a
  // public booker/signer is never 403'd on the operator's plan — the ADR 0176
  // shopper exemption). The check itself is billing's, via the host seam (no
  // core→feature import); no-op until an operator narrows PLAN_FEATURES.
  if (req.principal?.principalId && isSellableBundleFeature(toggleId)) {
    await checkEntitlement(req, toggleId);
  }
  return assignment;
}

/**
 * ADR 0434 (KTFULL-B1/B2/B14/B15/B17) — the ONE KickTodo privileged gate.
 *
 * Every KickTodo authoring, publication, Factory-operation, moderation and
 * metrics-administration route pairs the feature toggle with
 * `host:kicktodo:manage` HERE, in one helper, rather than repeating the pair
 * per route file. The audit found five separate packages that each gated on
 * "feature enabled + identified caller" only, so ANY authenticated co-tenant
 * could publish or retire a challenge, drive the Factory, resolve a moderation
 * flag, or read tenant outcome metrics. A copy-pasted gate is an authorization
 * boundary that drifts; a shared one cannot be forgotten by the next route.
 *
 * Fail-closed via `requireTenantScope`: non-members resolve to zero scopes and
 * are denied. The personal-workspace owner short-circuit inside that helper is
 * what keeps the solo-user and anon-demo flows working.
 */
export const KICKTODO_MANAGE_SCOPE: Scope = 'host:kicktodo:manage';

/**
 * ADR 0458 CRITICAL-3 — the SUBJECT-based manage-authority predicate, shared by
 * the KickTodo authoring ROUTES (`requireKicktodoManage`) and the Challenge
 * Author's agent TOOLS (`kicktodo-creator/agentTools.ts`), so a route and a tool
 * can NEVER drift on who may drive the Factory. Fail-closed:
 *   - no subject (a scheduled/system turn with no acting human) ⇒ false;
 *   - the caller's OWN personal workspace (`tenantId === subject` — the subject
 *     `user:<id>`/`anon:<sid>` IS its own personal-tenant id) ⇒ true, the same
 *     implicit-owner short-circuit `requireTenantScope` grants via the request;
 *   - otherwise the caller's tenant-wide scope union MUST include
 *     `host:kicktodo:manage` (a non-member resolves to zero scopes ⇒ denied).
 * The wildcard-operator request escape stays in `requireKicktodoManage` (it is a
 * transport concept — an env/admin principal — with no tool equivalent).
 */
export async function hasKicktodoManageAuthority(tenantId: string, subject?: string): Promise<boolean> {
  if (!subject) return false;
  if (tenantId === subject) return true; // implicit owner of one's own personal workspace
  const { scopes } = await resolveSubjectScopesUnion(tenantId, subject);
  return scopes.includes(KICKTODO_MANAGE_SCOPE);
}

/**
 * ADR 0459 P1 — the SUBJECT-based ENROLLMENT-authority predicate, shared by the
 * KickTodo participant enrollment ROUTES (`/enrollments/:id`, `/replan`,
 * `/materialize`, `/progress` in `kicktodo-core/routes.ts`) and the participant
 * replan agent TOOL (`openwop:kicktodo.replan`), so a route and a tool can NEVER
 * drift on who may drive an enrollment (the `hasKicktodoManageAuthority`
 * discipline, at participant scope). The authority is the participant's OWN
 * enrollment: the acting subject MUST be the enrollment's `ownerSubject`.
 * Fail-closed: a falsy subject (a scheduled/system turn with no acting human) ⇒
 * false; an absent or foreign enrollment ⇒ false (a uniform 404 at the route —
 * a foreign participant's enrollment is indistinguishable from absent, PRD §10.1).
 *
 * `getEnrollment` is loaded lazily: `featureRoute` is a hub imported by ~110
 * feature files, and `kicktodo-core/enrollmentService` transitively re-imports
 * this module (via `kickbotService` → `agentTools`), so a STATIC import would
 * close an ESM cycle through the hub. A dynamic import defers the binding to
 * call time (module cached after first) and keeps the graph acyclic.
 */
export async function hasKicktodoEnrollmentAuthority(tenantId: string, enrollmentId: string, subject?: string): Promise<boolean> {
  if (!subject || !enrollmentId) return false;
  const { getEnrollment } = await import('./kicktodo-core/enrollmentService.js');
  const e = await getEnrollment(tenantId, enrollmentId);
  return !!e && e.ownerSubject === subject;
}

/**
 * ADR 0434 (KTFULL-B1/B2/B14/B15/B17) — the ONE KickTodo privileged gate; ADR
 * 0458 CRITICAL-3 refactor: the tenant-scope decision now DELEGATES to the
 * shared `hasKicktodoManageAuthority` predicate the agent tools also call, so the
 * two authorization surfaces cannot drift. Behavior is preserved: the
 * wildcard-operator principal and the implicit personal-workspace owner still
 * short-circuit (as `requireTenantScope` did), and a non-member is denied 403.
 */
export async function requireKicktodoManage(req: Request, toggleId: string, label: string): Promise<void> {
  await requireFeatureEnabled(req, toggleId, label);
  // Wildcard operator principal (env API key / admin token / conformance harness)
  // acts across tenants — the same trusted escape hatch requireTenantScope uses.
  if (req.principal?.tenants?.includes('*')) return;
  // Implicit personal-workspace owner (the req form; preserves the solo-user +
  // anon-demo flows exactly). The predicate ALSO covers this via tenantId===subject,
  // but keeping the req check makes the route a superset that can never regress.
  if (isOwnPersonalWorkspace(req)) return;
  const subject = callerSubject(req);
  if (!(await hasKicktodoManageAuthority(tenantOf(req), subject ?? undefined))) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${KICKTODO_MANAGE_SCOPE}`, 403, { requiredScope: KICKTODO_MANAGE_SCOPE });
  }
}

/** A required non-empty string body field (the validation every feature route
 *  repeats). Throws the canonical `validation_error` envelope on a miss. */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  return value;
}

/** An optional string field: the trimmed value, or undefined when absent/blank. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * The externally-visible base URL for building ABSOLUTE public URLs (sitemap/RSS,
 * OG/social-card images, share links). Prefer a CONFIGURED origin
 * (`OPENWOP_PUBLIC_BASE_URL`) — the trustworthy source of truth. The request
 * `Host`/`X-Forwarded-Host` is client/proxy-influenceable, so the fallback is
 * sanitized to a valid host token (strips CR/LF + anything outside the host
 * charset, defeating header-injection) and the scheme constrained to http(s). A
 * deployment behind a proxy SHOULD set the env var. Shared by every public
 * surface (ADR 0012 publishing, ADR 0013 sharing) so the policy can't drift.
 */
export function configuredPublicBaseUrl(): string | undefined {
  const v = process.env.OPENWOP_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  return v ? v : undefined;
}

/**
 * The request-aware form. A lane with no `req` (a workflow surface, a queued
 * job) calls `configuredPublicBaseUrl()` above and handles `undefined` — it
 * MUST NOT re-read the env var, which is how the "policy can't drift" promise
 * in this docblock gets broken one copy at a time.
 */
export function publicBaseUrl(req: Request): string {
  const configured = configuredPublicBaseUrl();
  if (configured) return configured;
  // Forwarded-aware request origin, sanitized — the shared derivation in
  // host/requestOrigin.ts (one place, so the host-token/scheme policy can't drift).
  return requestOrigin(req);
}

/**
 * ADR 0656 — an ABSOLUTE link into this host's proprietary namespace, in the
 * canonical RFC 0181 form `<base>/host/openwop-app/<path>` (ADR 0652 mounts
 * it). Every URL that leaves the host as a durable artifact — email approval
 * and engagement links, sitemaps, canonical/OG URLs, podcast feeds, share
 * cards, signed certificates — goes through this ONE helper, because the
 * `/v1/host/openwop-app/` twin retires atomically with `/v1` and a link
 * emitted in the twin form dies on that day in every inbox and index that
 * holds it. Provider-REGISTERED URLs (OAuth redirect URIs, inbound webhook
 * addresses) are NOT emitted through here: they change only after the
 * provider console holds the new value (`v1-deprecate-now-retire-on-clock`).
 */
/** `<base>/host/openwop-app` — the prefix form for template literals that already carry the rest of the path. */
export function vendorPublicBase(base: string): string {
  return `${base.replace(/\/+$/, '')}${VENDOR_ROOT}`;
}

export function vendorPublicUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${VENDOR_ROOT}${p}`;
}

/**
 * The org-scoped RBAC core (NO toggle gate) shared by org-native features. Gates
 * on the caller's RFC 0049 `scope` IN THE PATH org (`req.params.orgId`): resolves
 * the caller, verifies the org is in their tenant (404 / IDOR guard), and
 * requires `scope` (403, fail-closed). Returns the caller + orgId for the handler.
 * One definition so the cross-tenant guard can't drift between features
 * (ADR 0006/0007/0008). Always-on features (cms/media/publishing — ADR 0027) call
 * this directly; toggle-gated features go through `authorizeOrgScope` (below),
 * which is this guard preceded by the toggle check.
 */
export async function requireOrgScope(
  req: Request,
  scope: Scope,
): Promise<{ user: User; orgId: string; tenantId: string }> {
  const user = await resolveCallerUser(req);
  const orgId = req.params.orgId;
  // ADR 0508 Phase 2 — the ACTIVE tenant, never the caller's HOME tenant.
  //
  // This guard predates ADR 0015, when a tenant was one thing. After the
  // personal/active split it kept comparing `user.tenantId` (HOME — see
  // `features/users/usersGuards.ts:85-93`, which returns the canonical home-tenant
  // user for every real signed-in caller) while `POST /orgs` files orgs under
  // `tenantOf(req)` (ACTIVE, `routes/accessControl.ts:321`). For anyone inside a
  // shared `ws:` workspace the two never matched, so EVERY org-scoped feature
  // route 404'd for EVERY member — the workspace owner included. Reproduced
  // through the production path; see `test/orgscope-shared-workspace.test.ts`.
  //
  // `user.userId` remains the correct SUBJECT: every production member-creation
  // path keys by the caller's stable home `User.userId` (`routes/workspaces.ts:132`
  // via `callerSubject`, `features/orgs/invitationsService.ts:196`,
  // `routes/accessControl.ts:457`) while filing the row under the ACTIVE tenant.
  // So subject and tenant agree once the tenant is right — verified by the owner
  // case asserting 200 rather than merely not-404.
  const activeTenant = tenantOf(req);
  // CMNT-4 — the org-existence + scope pair is now ONE predicate
  // (`accessControlService.assertOrgScope`), shared with the workflow-surface
  // lane that previously had no membership check at all. Same two errors, same
  // order; this call site keeps the `tenantOf(req)` / `user.userId` derivation
  // above, which is the part that is genuinely HTTP-specific.
  await assertOrgScope(activeTenant, user.userId, orgId, scope);
  // The tenant a handler READS AND WRITES in IS the tenant it was AUTHORIZED in —
  // now the same value by construction. Handlers must take this and never
  // re-derive from `user.tenantId`; a structural gate holds that at zero.
  return { user, orgId, tenantId: activeTenant };
}

/**
 * The toggle-gated org-scoped RBAC gate (the common case): assert the feature
 * toggle is on for the caller, THEN apply `requireOrgScope`. Composed from the
 * two halves so the cross-tenant guard lives in exactly one place.
 */
export async function authorizeOrgScope(
  req: Request,
  feature: { toggleId: string; label: string },
  scope: Scope,
): Promise<{ user: User; orgId: string; tenantId: string }> {
  await requireFeatureEnabled(req, feature.toggleId, feature.label);
  return requireOrgScope(req, scope);
}

/**
 * TENANT-LEVEL authority gate (2026-07 vuln-scan). Sibling to {@link requireOrgScope}
 * for host-extension management routes that are TENANT-scoped (no `:orgId` in the
 * path) yet mutate tenant-wide state — user lifecycle, the capability firewall, the
 * assistant's side-effectful actions. Those routes previously gated only on
 * `requireSignedIn`/`tenantOf`, so in a shared SSO/SCIM tenant (many humans on one
 * tenantId) any member could act with owner authority.
 *
 * Authority (fail-closed, in order):
 *   1. The caller is the implicit OWNER of their OWN personal workspace
 *      (`isOwnPersonalWorkspace`) — the same short-circuit `requireScope`/personal
 *      tenants use; preserves the solo-user + anon-demo flows. USERS-19: the
 *      short-circuit fires ONLY for a `user:`/`anon:`-shaped personal tenant
 *      (`isPersonalTenantId`) — a SAML session's host-global tenant never qualifies.
 *   2. Otherwise the caller's TENANT-WIDE scope union (across ALL their org
 *      memberships — `resolveSubjectScopesUnion`, the same primitive
 *      `requireProtocolScope` uses) MUST include `scope`. A non-member resolves to
 *      zero scopes and is denied.
 *
 * Enforced UNCONDITIONALLY (unlike `requireProtocolScope`, which is gated behind
 * OPENWOP_AUTHORIZATION_ENFORCEMENT): these are NON-normative `/v1/host/openwop-app/*`
 * surfaces, never advertised as an RFC 0049 wire capability, so there is no
 * wire-honesty reason to defer enforcement — and deferring it would leave the
 * privilege escalation open in the default posture.
 */
export async function requireTenantScope(req: Request, scope: Scope): Promise<void> {
  // USERS-19 / ADR 0617 D2 — a thin wrapper: the decision lives in the
  // feature-free `assertTenantScope` (host/accessControlService.ts) so the run
  // lane can call the SAME predicate without a Request. The two request-level
  // facts it needs are threaded explicitly: the wildcard operator principal (env
  // API key / admin token / conformance harness — the SAME trusted escape hatch
  // requireProtocolScope / loadOwnedRun use) and the caller's PERSONAL tenant.
  await assertTenantScope(tenantOf(req), callerSubject(req), scope, {
    personalTenant: personalTenantOf(req),
    wildcardOperator: req.principal?.tenants?.includes('*') === true,
  });
}

/**
 * Every spelling of the caller an authority check must try (ADR 0774 D5, moved
 * here by ADR 0775 D1 so kanban and the agent routes share ONE copy). This app
 * has two spellings of one human in play: an unbound OIDC bearer presents the
 * legacy `oidc:<sub>` principal, and the canonical identity is `user:<userId>`
 * (ADR 0003). MEASURED: BOTH key real memberships — a shared workspace created
 * by an unbound OIDC caller records its OWNER as `oidc:<sub>`, while the
 * personal workspace's owner is keyed `user:<userId>`. So checking only the
 * canonical spelling refuses that owner, and checking only the raw principal
 * refuses an editor added by canonical id. A person (`auth.kind === 'subject'`)
 * is therefore judged by the UNION of both, the canonical one resolved exactly
 * as `requireOrgScope` resolves it. Credentials (env / `owk_` keys) are read by
 * provenance and have one spelling.
 */
export async function callerSubjectSpellings(req: Request): Promise<string[]> {
  const raw = callerSubject(req);
  if (req.principal?.auth?.kind !== 'subject') return raw ? [raw] : [];
  let canonical: string | undefined;
  try {
    canonical = (await resolveCallerUser(req)).userId;
  } catch {
    canonical = undefined;
  }
  return [...new Set([canonical, raw].filter((s): s is string => Boolean(s)))];
}

/**
 * ADR 0787 D4 — every spelling THIS request's person is known by: the canonical
 * `user:<id>`, the raw subject, AND the auth principal (`oidc:<sub>`). The last
 * one is what `callerSubjectSpellings` leaves out for a BOUND session, and it is
 * exactly the spelling a schedule created before the bind carries forever. All
 * three are the same person's own identity — never another person's row, so no
 * cross-tenant or cross-IdP alias can creep in — and they are only ever compared
 * against rows in
 * the caller's PERSONAL tenant (the home tenant that principal was minted in).
 * The one lookup — the caller's own User row — is guarded by that same rule.
 */
export async function callerOwnerSpellings(req: Request): Promise<string[]> {
  const out = new Set(await callerSubjectSpellings(req));
  if (req.principal?.auth?.kind !== 'subject') return [...out];
  if (req.principal.principalId) out.add(req.principal.principalId);
  // A BOUND cookie session presents `user:<id>` as its principal too, so the
  // legacy spelling lives only on the caller's own User row — and is added only
  // when that row's tenant IS the caller's personal tenant (the one place that
  // principal was minted under this person's own IdP; ADR 0780 D2 as corrected).
  try {
    const user = await resolveCallerUser(req);
    if (user.principalId && user.tenantId === personalTenantOf(req)) out.add(user.principalId);
  } catch {
    // No durable User row: the request's own spellings above are all there is.
  }
  return [...out];
}

/**
 * ADR 0775 D1 (from ADR 0774 D5) — does this caller hold `scope` in `tenantId`?
 * Unlike {@link requireTenantScope} it reads a credential by PROVENANCE and a
 * person by BOTH identity spellings. In order:
 *  - the wildcard operator principal: yes;
 *  - an `owk_` key whose declaration excludes `scope`: no, always (a key
 *    narrowing its own delegation can only remove authority);
 *  - the caller's OWN personal workspace (`isOwnPersonalWorkspace`, ownership —
 *    not the tenant's shape): yes;
 *  - otherwise `credentialScopesIn` for some spelling of the caller.
 */
export async function callerHoldsTenantScope(req: Request, tenantId: string, scope: Scope): Promise<boolean> {
  const principal = req.principal;
  if (principal?.tenants?.includes('*')) return true;
  const auth = principal?.auth;
  if (auth?.kind === 'api-key' && !keyDeclarationPermits(auth.scopes, scope)) return false;
  if (isOwnPersonalWorkspace(req) && tenantId === tenantOf(req)) return true;
  if (!principal) return false;
  for (const subject of await callerSubjectSpellings(req)) {
    if ((await credentialScopesIn(principal, tenantId, subject)).includes(scope)) return true;
  }
  return false;
}

/** ADR 0775 D1 — the throwing wrapper every agent-area write calls first: 403
 *  `forbidden_scope` unless the caller holds `workspace:write` in `tenantId`
 *  (default: the caller's active tenant). */
export async function requireTenantWrite(req: Request, tenantId: string = tenantOf(req)): Promise<void> {
  if (await callerHoldsTenantScope(req, tenantId, 'workspace:write')) return;
  throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
}
