# ADR 0005 — User Profiles

**Status:** implemented (Phases 1–5 shipped — `src/features/profiles/`, `test/profiles-route.test.ts`)
**Date:** 2026-06-09
**Depends on:** ADR 0002 (Users), ADR 0003 (Canonical identity), ADR 0004 (Org
invitations — email ownership), ADR 0006 (RBAC — read/write authority)
**Owner of profile data:** a NEW feature-package `src/features/profiles/`
(`feature.ts` + `routes.ts` + `profilesService.ts`). NOT the `users` feature and
NOT `accessControl`.
**Surface:** `/v1/host/sample/profiles/*` (host-extension, NON-NORMATIVE — no new
OpenWOP RFC; nothing touches the wire).

> Numbering note: ADR 0005 was reserved in the ADR 0002 roadmap but never
> written; RBAC shipped as ADR 0006 (some older source comments mislabel RBAC as
> "ADR 0005" — corrected in this change). This ADR fills the 0005 slot with the
> Profiles feature it was always meant to hold.

---

## Context (boundaries audit first)

The maintainer chose **full MyndHyve parity**: port MyndHyve's rich
`TeamProfile` (jobTitle, department, bio, skills with endorsements, equipment,
availability, interests, portfolio) plus the `UserProfile` UI affordances
(avatar, completeness score, email-verification status).

Before adding anything, what already exists (so Profiles does NOT duplicate it):

- **Identity is `users` (ADR 0002/0003).** `User { userId, tenantId, principalId,
  email?, displayName?, groups, source, status }`. `displayName` + `email` are
  the *identity* fields and STAY there. Profiles must not fork a second identity.
- **Email *ownership* is already gated (ADR 0004).** `acceptInvitation` rejects an
  email mismatch fail-closed; password signup mints an `emailVerified` flag
  (`credentialsService`). What's missing is *surfacing* that flag (it's buried in
  the credential store, absent for SSO/SCIM users) — ADR 0004:167 explicitly
  deferred "firming up email ownership" to this ADR.
- **Authority is RBAC (ADR 0006).** Profiles must not invent its own permission
  model — read/write/endorse authority composes with the `User.userId` subject
  and (where an admin view is needed) the RFC 0049 scopes.
- **Media is the existing asset surface (RFC 0055).** Avatars and portfolio
  images are stored as `/v1/host/sample/media/upload` tokens and served by
  `/v1/host/sample/assets/{token}` — Profiles stores **references**, never bytes.

So Profiles is a genuinely new surface (none of MyndHyve's profile fields exist
today) that **layers on** identity/RBAC/media rather than re-implementing them.
Its single responsibility: **per-user descriptive profile data + a self-service
edit surface + a team directory.**

A load-bearing invariant carried from RBAC (ADR 0006 / RFC 0087 §B): **a profile
field confers NO authority.** `jobTitle: "Admin"` or `skills: ["security"]` MUST
NOT widen any scope. Profiles are descriptive, exactly like the org-chart.

## Decision

A `profiles` feature-package (toggle `profiles`, default OFF, `bucketUnit:
tenant`) owns one `Profile` per `User.userId`, tenant-scoped. Delivered in five
phases; each is authored + tested with the route harness before the next.

### The model

```
Profile {
  userId, tenantId,                       // 1:1 with User; userId is the key
  jobTitle?, department?, bio?,           // text (bounded)
  contact?: { location?, links?: {label,url}[] },
  avatarAssetToken?,                      // media-asset ref (Phase 2)
  portfolioAssetTokens: string[],         // media-asset refs (Phase 2)
  skills: { name, proficiency: 1..5, endorsements: string[] }[],   // (Phase 3)
  equipment: string[],
  availability?: { timezone?, hoursPerWeek?, status?: 'available'|'busy'|'away' },
  interests: string[],
  emailVerified?: boolean,                // surfaced, not owned (Phase 4)
  completeness: number,                   // 0..100, server-computed (derived)
  createdAt, updatedAt, updatedBy?
}
```

`completeness` is **derived, never stored as truth** — computed from a weighted
field set on every read so it can't drift.

### Authority model (composes with ADR 0006)

- **Read** — any signed-in member of the tenant may read any profile in that
  tenant (the team-directory premise; profiles are descriptive, not secret).
- **Write** — a user edits **only their own** profile (`profile.userId ===
  callerSubject`). No admin-edits-others in v1 (keeps the self-service rule
  clean); an admin override can be added later behind a `host:members:manage`
  scope if a consumer needs it.
- **Endorse** — any signed-in member may endorse **another** member's skill;
  **never their own** (fail-closed), at most one endorsement per (endorser,
  skill).

All authority keys off `User.userId` (ADR 0003), tenant-scoped (the hard
isolation boundary). Cross-tenant reads/writes fail closed with `not_found` (no
existence leak — the same IDOR guard the other host-ext stores use).

### Phase 1 — Core profile CRUD + self-service + directory

`profilesService` + `DurableCollection<Profile>('profiles:profile', p =>
p.userId)`. Routes: `GET /profiles/me` (lazily materializes the caller's empty
profile), `PATCH /profiles/me` (text/contact/equipment/interests/availability),
`GET /profiles/:userId` (team-visible read), `GET /profiles` (tenant directory).
Server-computed `completeness`. Feature-package wiring + toggle. Self-edit
authority + tenant IDOR guard. Route-harness tests.

### Phase 2 — Avatar + portfolio (media-asset references)

`PUT /profiles/me/avatar` (body: a media-asset `token`), `DELETE
/profiles/me/avatar`; `POST /profiles/me/portfolio` / `DELETE
/profiles/me/portfolio/:token`. Validation: the token MUST resolve in the
caller's tenant AND be an image content-type (reject foreign / non-image / unknown
tokens fail-closed). Stores references only; bytes stay in the media surface.

### Phase 3 — Skills + endorsements

`PUT /profiles/me/skills` (replace the caller's skill list — `{name, proficiency
1..5}`), and `POST /profiles/:userId/skills/:skill/endorse` /
`DELETE …/endorse`. Endorsement rules enforced fail-closed: not your own profile,
the skill exists, one endorsement per endorser. Endorsements store endorser
`userId`s (opaque), surfaced as a count + "did I endorse" boolean.

### Phase 4 — Email-verification surfacing (closes the ADR 0004 deferral)

Surface `emailVerified` on the profile read: lifted from `credentialsService`
for password users, and set `true` for SSO/SCIM users whose IdP asserted a
verified email (the assertion already flows through ADR 0002's SAML/SCIM path).
The flag is **read-only** on the profile (owned by the auth layer, surfaced
here). This makes "is this email proven?" visible to the team directory and to
the invite flow without Profiles owning verification.

### Phase 5 — Frontend self-service page + team directory

`/profile` (lazy route, nav-gated on the `profiles` toggle): the caller edits
their own profile — avatar upload (via the media surface), the text/skills/
availability fields, a **completeness meter**, and the email-verified badge. A
read-only **team directory** lists tenant profiles with avatars + key fields and
a per-skill endorse affordance. Registered in `FRONTEND_FEATURES`; the canonical
`npm run build` gate (tsc + token/CSS checks + vite) must pass.

## Architectural constraints honored

- **Single source of truth / boundaries:** Profiles owns descriptive profile data
  only — identity stays in `users`, authority in `accessControl`, bytes in the
  media surface. No parallel identity/RBAC/storage (the ADR 0004 lesson).
- **No authority from description (RFC 0087 §B):** no profile field — jobTitle,
  skills, endorsements — widens any scope. Endorsements are social proof, not
  permission.
- **Tenant isolation (CTI-1):** every read/write is tenant-scoped; cross-tenant
  access fails closed with `not_found`.
- **No wire surface → no RFC:** entirely under `/v1/host/sample/*`; nothing
  advertised in discovery, no event types, no capability flip (per CLAUDE.md the
  host-extension rule — non-normative, never needs an RFC).
- **Secret hygiene:** free-text fields (bio, links, skill names) are scrubbed for
  secret-shaped tokens before persistence, reusing the existing redaction the
  annotations route uses.

## Alternatives considered

1. **Put profile fields on the `User` record.** Rejected — bloats the identity
   record (ADR 0003 keeps it minimal + stable as the RBAC/session subject) and
   couples the directory/portfolio churn to the auth-critical store. A separate
   1:1 entity keyed on `userId` keeps identity lean.
2. **A new `profile` RFC + `capabilities.profiles`.** Rejected — profiles are
   pure host-extension product surface with no cross-host/wire contract; the
   CLAUDE.md rule is explicit that `/v1/host/sample/*` never needs an RFC.
3. **Own email verification in Profiles.** Rejected — verification is an auth
   concern (token minting, IdP assertions). Profiles *surfaces* the flag
   (Phase 4) but the auth layer owns it; otherwise two systems claim the truth.
4. **Ship minimal (avatar+bio only).** The maintainer chose full parity; the rich
   set (skills/endorsements/availability/portfolio) is built, but each is a
   separate phase so blast radius stays small and the harness stays honest.

## Open questions

- [ ] **Admin-edit-others.** v1 is self-edit only. If a consumer needs an admin to
  fix a profile, add it behind `host:members:manage` (RFC 0049) rather than
  relaxing the self-edit rule.
- [ ] **Portfolio asset TTL.** Uploaded media assets expire (7-day default). A
  durable portfolio needs either a longer-lived asset class or periodic refresh —
  confirm against the media surface's retention before relying on it long-term.
- [ ] **Completeness weights.** The weighted field set is a product judgment;
  start with an even-ish weighting and tune once the directory has real usage.
- [ ] **Endorsement abuse.** One-per-endorser is the only guard; rate-limiting /
  reciprocal-endorsement detection is deferred until there's a consumer.
