# ADR 0684 — a feature declares its default org and workspace; first sign-in joins it

Status: Accepted (implemented; see § Implementation record)

## Context

A fresh deployment of a participant-facing distribution renders five blank
surfaces. Not broken — *empty*, and empty in a way an operator reasonably reads as
a bug. `demoKicktodoSeed.ts`'s own docblock records that misread happening on a
real white-label deploy.

The reason is tenancy, and it is working as designed. The catalog is strictly
caller-tenant (`challengeService.ts:240`, prefix scan `${tenantId}::`), and every
visitor gets a private tenant — `anon:<sid>` for an anonymous session, `user:<hash>`
once signed in (`middleware/auth.ts:84-89`). So every fresh participant opens
Discover onto their own empty catalog, and the seeder fixes exactly one tenant:
the operator's.

Going from "toggles on, engine certified" to "a stranger enrolls" is therefore a
four-step browser runbook per deployment: create workspace → switch into it →
seed → create org. Every operator walks it by hand.

### The measurement that shapes the decision

`enrollmentService.ts:175`:

```ts
const challenge = await getChallenge(input.tenantId, input.challengeId, input.challengeVersion);
if (!challenge) throw new ChallengeNotEnrollableError('not-found');
```

**Enrollment requires the challenge in the ENROLLING tenant.** So the anonymous
public catalog (`/public/:orgId/challenges`, ADR 0641 phase 3, which resolves
org → tenant server-side) can never be the surface a participant enrolls from. It
is an acquisition surface and read-only by construction — correctly so: enrolling
is what signing up is for.

That rules out the two shapes one reaches for first. A cross-tenant enroll bridge
would be a new authorization surface for the sake of a default. Per-tenant seeding
on first touch gives every participant a private COPY of the catalog and no shared
leaderboard, which is not the product.

## Decision

**A feature package may DECLARE a default org and workspace; the host provisions
it idempotently at boot, and a user's first sign-in joins it.**

### 1. The feature declares; core does not learn a product name

The provisioning seam already exists: `createOrg({ orgId })` takes a fixed id "for
reserved host-level orgs that need a deterministic id", and `systemSite.ts:166`
(`ensureSystemSiteOrg`) uses it to lay down `host-site` at boot, idempotently,
documented as "NOT a second reserved-org system".

The obvious move is to add `host-kicktodo` beside it. **We are not doing that.**
`host-site` is reserved because it is the *host's own* marketing site — a host
concept. A product id in core means `accessControlService` knows the name of one
distribution among several, and the next distribution needs another, and core
acquires a registry of products. That is the ADR 0001 boundary: a feature must not
require edits to core.

So the declaration lives with the feature, and core provides only the mechanism.
`kicktodo-core` declares its own default; any distribution gets the same for free.

### 2. Co-location, not bridging

The default workspace tenant IS the declared org's tenant. Catalog, enrollments,
circles and leaderboard are then all same-tenant reads. **No cross-tenant
mechanism is introduced anywhere**, which is the whole point: the shared workspace
is not a new primitive invented for the catalog — circles and leaderboard already
require shared tenancy, so it is one mechanism doing one more job.

### 3. Id form — and this is a real trap

```
systemSite.ts:30   SYSTEM_SITE_TENANT = 'host:site'    // colon — TENANT
systemSite.ts:31   SYSTEM_SITE_ORG    = 'host-site'    // hyphen — ORG
```

Org ids take the **hyphen** form, tenants the colon. A declared default is
therefore org `host-<feature>`, tenant `host:<feature>`. The colon form as an org
id would put a colon in a URL path segment (`/public/host:kicktodo/challenges`),
needing percent-encoding and handing `resolvePublicTenant` an encode/decode
mismatch to get wrong. The id the signed-out SPA hardcodes should be boring.

> **CORRECTED 2026-09-15 — this section was WRONG, and it is the defect that
> shipped. The heading called it "a real trap" and then walked straight into a
> different one.**
>
> The reasoning above is sound about URLs and wrong about workspaces. **This host
> defines a workspace as an org whose id EQUALS its tenant id** —
> `accessControlService.isWorkspaceOrg`, and the predicates on the listing,
> membership and switch paths that now route through it. Mandating org
> `host-<feature>` with tenant `host:<feature>` therefore made a declared default
> org, **by construction, not a workspace**. `assertDeclarationLegal` enforced the
> mismatch: orgId hyphen-only, tenantId must contain a colon. No legal declaration
> could ever produce something a participant could enter.
>
> **MEASURED in production 2026-09-15** (kicktodo-1, a live sign-in with a freshly
> minted subject): bind succeeded, `workspace_auto_joined` was logged, a member row
> was written, the ledger was claimed and the active-workspace preference set —
> and then `/me/workspaces` listed only the personal workspace, `POST
> /workspaces/host:kicktodo/switch` returned **403 "You are not a member of that
> workspace"**, and `resolveActiveWorkspace` re-checked fail-closed, found no
> membership, dropped the preference and returned the user to their personal
> tenant. Every layer behaved correctly. The layers disagreed about what a
> workspace IS.
>
> **Why the `host-site` precedent was unsafe to copy.** `host-site` really does
> pair a hyphen org with a colon tenant. It survives that only because the system
> site is **auth-unreachable by design** — a page nobody joins — so its mismatch
> never meets a membership check. A declared default org is the first one
> participants are meant to *enter*. The precedent was load-bearing for a property
> the new case does not have, and citing it transferred the shape without the
> precondition.
>
> **The decision now:** a declared default org is a **workspace root** — one id,
> used as both. `BackendFeature.defaultOrg` carries a single `id` field, so the
> mismatch is no longer merely asserted-against but *unrepresentable*; the
> assertion is kept, inverted, to guard the derivation. The **hyphen** form wins,
> so §3's URL argument above still stands and `PUBLIC_CATALOG_ORG` is unchanged.
>
> **Why hyphen rather than colon-for-both**, against the reviewing peer's initial
> lean: the join ledger keys on the **tenant** id (`workspaceJoinLedger.ts:54`,
> `keyFor(subject, workspaceId)` with `workspaceId = tenantId`). Making both ids
> the *colon* form leaves the tenant id unchanged, so §7's records for the three
> already-joined production subjects would persist and permanently suppress a
> retry — requiring manual deletion against live data. Making both the *hyphen*
> form **changes** the tenant id, so §7 re-joins those subjects on their next
> sign-in with no migration. The cleanup argument that was offered for the colon
> form actually belongs to this one.
>
> **What was checked before choosing** (non-test source): nothing tests
> `startsWith('host:')` or `'ws:'` on a tenant id. `isSinglePrincipalTenant`
> (`:841`) and `requestSubject.ts:60` are *allowlists* of `default`/`anon:`/`user:`
> that fail closed, so a colonless tenant is correctly non-personal;
> `kvAgeOut`'s prefix walk matches `host-x::<id>` whole; `v2Identity.ts:92` splits
> an operation suffix off a run id, never a tenant. `host:kicktodo:manage` and
> friends are **scope** strings, not tenant ids, and are untouched. The colon
> convention is descriptive, not enforced.
>
> **`host-site` stays asymmetric.** It is inert, and changing a system tenant to
> tidy a convention is unforced risk. What was missing was never the symmetry —
> it was the note that its id mismatch is safe *only* because nothing joins it.
>
> **The part worth carrying to the next ADR.** Three test files covered this
> feature and all were green. Two of them *pinned the inverted rule* — one case
> was literally named "accepts the hyphen/colon pair". The suite was a faithful
> mirror of the defect, so no amount of running it could find this. What was
> missing was a test that asserted **reachability** rather than steps: after
> auto-join, can the participant list, switch, and still be there on the next
> resolve? That test now exists
> (`adr0684-default-org-is-enterable.test.ts`) and the predicate lives in **one**
> named helper instead of five open-coded copies — `isWorkspaceOrg` already
> existed with **zero callers** while five sites hand-rolled `orgId === tenantId`,
> which is precisely how a definition and its assertion drifted into opposition
> without anything noticing.

### 4. Reserved-name validation — narrower than it first appears

The reserved-segment machinery (`assertVendorOrgNotReserved`,
`protocolVersion.ts:281`) checks that the vendor org is not also a `/host/<segment>`
PROTOCOL segment. Derived from `schemas/v2/path-manifest.json` the way the code
does it, those segments are exactly:

```
/host/<seg>:      effect-seams, events
first segments:   .well-known, agents, audit, content, host, interrupts,
                  openapi.json, prompts, runs, tools, trigger-subscriptions,
                  webhooks, workflows
```

There is no `host-*` family reservation, so `host-<feature>` is legal.

**A validation against manifest first-segments would be a check that cannot fail,
and we are not adding one.** An org id never appears as a first segment: it sits
at `/v1/host/openwop-app/public/:orgId/…`, four segments deep. A guard against a
collision the path shape makes impossible is the species this repo has spent
considerable effort removing.

What CAN collide is another reserved **org** id. The validation is therefore
against the reserved-org set (`host-site` today), plus ordinary org-id legality —
and it must fail at boot, not at first use.

### 5. Ownership — a new authorization shape, stated as the decision

`host-site` is system-owned and auth-unreachable, which is right for a page nobody
joins. A participant org cannot be that; participants must be members.

**The org is system-owned (`createdBy: SYSTEM_ACTOR`, no human owner member);
participants are membership-derived, added by auto-join.** Consequences, stated
rather than discovered:

- nobody can be locked out of, or delete, the default org — it is re-provisioned
  every boot regardless;
- administration is the operator's superadmin surface, not an org-owner seat;
- **membership of this org means "is a participant", NOT "may administer".**

That last line is the load-bearing one. Elsewhere in this host membership is how
authority is derived (ADR 0006). Here it is a population, not a permission. Anyone
adding an authority check against membership of a default org is reading a
different meaning out of the same shape, and will be wrong. Any such check must
name the capability, never the membership.

### 6. Scale — auto-join makes membership unbounded

Membership of the default org becomes *every user who has ever signed in*.

`listMembers(defaultOrg)` is therefore not a cheap read and must never sit on a
hot path — a member roster that is fine at 20 is a full-tenant scan at 200,000,
and `DurableCollection.list()` is already the documented scan hazard in this
codebase. Any surface that wants "who else is doing this challenge" must page, or
read a purpose-built projection, never the roster. (Raised by kicktodo-1; it is a
data-integrity note, not a nicety.)

## Non-goals

**A group does not get an org.** Raised by kicktodo-1 from a real product question:
should a coach or subscriber creating a challenge for a new group auto-create an
org for it? No — and the seam this ADR introduces must not be read as a per-group
factory.

Group formation already exists, within-tenant, and already covers the case:

```ts
circleService.ts:25   export type CircleType = 'partner' | 'circle' | 'cohort' | 'coach';
circleService.ts:56   (c) => `${c.tenantId}::${c.id}`
```

There is a `coach` type, and circles are keyed inside a tenant. **An org per group
would duplicate that primitive and re-fragment tenancy in the same motion** — a
group in its own org/tenant cannot enroll in a catalog living in the default
workspace, which reintroduces exactly the cross-tenant bridge §2 exists to avoid.
It is the orgs↔accessControl parallel-system mistake arriving as a product
feature, which is the disguise that gets such things built.

**So: the declared default org is SINGULAR and system-provisioned; group formation
is cohorts and circles within its tenant, never a per-group org.**

The legitimate case underneath the question is real and different: a coach who
wants their *own branded* org. That is deliberate onboarding — someone choosing a
tenancy boundary and accepting what it costs — not an org spawned as a side effect
of pressing "create a challenge". It belongs to the onboarding programme, not
here, and the distinction is exactly §5's from the other side: **a population is
not a permission, and a group is not a tenancy.**

### 6a. CORRECTION — the scan §6 forbids was already there, on the hottest path

§6 said "do not put `listMembers(defaultOrg)` on a hot path". That was too weak,
and I found out by writing the violation myself twice: once in the auto-join path
(caught in review), and once structurally, by making a workspace unbounded.

`isWorkspaceMember` (`accessControlService.ts`) answers a POINT question — is THIS
subject a member of THIS workspace — and its own docblock says it runs **on every
authenticated request and at session mint**. It did so with an O(N) scan of the
workspace slice, falling through to a FULL CROSS-TENANT scan to confirm a denial.
That was affordable while every workspace was small. A default workspace holding
every user who has ever signed in makes N unbounded on the hottest path in the app.

**So the accurate statement is not "do not add a scan" but "one is already there,
and this ADR makes it unbounded."**

**It cannot be measured before it is an incident.** By the time a deployment has
enough members to time the crossover, the O(N) scan is already live on every
request in production — the measurement requires exactly the scale that would
already be the outage. So this is fix-before-scale, not measure-then-fix.
(Raised by kicktodo-1, who declined to synthesise a number on the grounds that
"the shape is the finding; the number is theatre". Correct, and I would have
quoted the number.)

**Phase 5 adds a point-read sidecar** keyed `(workspaceId, subject)` — the same
key the §7 join ledger uses, so one key shape does three jobs: join idempotence,
removal-wins, and membership. `DurableCollection` carries exactly ONE secondary
index and it is already spent on `tenantId`; `indexProjection` is not a
substitute, since it lowers the constant and leaves the complexity at O(N).

**The fast path is ADDITIVE and may only answer "yes".** A hit returns true in
O(1); a miss falls through to the pre-existing logic unchanged. A missing entry
therefore cannot deny a real member — the one direction an authorization check
must not fail — and no backfill is required for correctness. Backfill would only
widen the fast path.

## Phases

| phase | content |
|---|---|
| 1 | the declaration seam + boot provisioning (idempotent, mirroring `ensureSystemSiteOrg`), with the reserved-org validation |
| 2 | auto-join on first sign-in: add member, set active workspace |
| 3 | `kicktodo-core` declares its default; the seeder targets it |
| 4 | signed-out Discover reads `/public/host-kicktodo/challenges` |
| 5 | the membership point-read (§6a) — lands BEFORE the default workspace carries real membership |

Phases 1–3 ship together or not at all: a default org nobody lands in is a
mechanism with no consumer, which both sessions on this work have now shipped once
each and would rather not repeat.

## Alternatives considered

- **`host-kicktodo` reserved in core.** Rejected — §1. It is one line cheaper today
  and makes core a product registry.
- **Cross-tenant enroll bridge.** Rejected: a new authorization surface to avoid
  co-locating two things that have no reason to be apart.
- **Per-tenant seed on first touch.** Rejected: private copies, no shared
  leaderboard, and the catalog stops being a shared object.
- **Do nothing; keep the four-step runbook.** Rejected as the default, but it
  remains the opt-out path for an operator who wants their own org.

## Open questions

1. ~~Auto-join on *second* sign-in, and for a user removed from the workspace who
   returns.~~ **RESOLVED — see §7.**
2. An operator who wants no default at all: env opt-out, and what the feature's
   surfaces render when the declaration is suppressed.
3. Whether the declared default should be per-distribution or per-tenant for a
   multi-tenant operator running several participant programmes.

### 7. Auto-join records the ACTION, never checks membership — and this is the ban path

Two questions the code makes look identical:

- *has the auto-join action run for this subject?* — a durable fact about the past;
- *is this subject currently a member?* — a mutable fact about the present.

**Auto-join gates on the first.** A durable join-record keyed `(subject, workspaceId)`
is the idempotency key for the action: auto-join fires **iff that record is absent**,
never iff the subject is a non-member. Winning the insert of that record gates the
`createMember` call (insert-if-absent / CAS), so two concurrent first sign-ins cannot
double-join — the same deterministic-id idempotence `demoKicktodoSeed` already relies
on, one layer over.

**Removal is durable; re-add is explicit.** An operator putting someone back is a
deliberate `createMember`; auto-join never fires again because the record persists. If
they want auto to re-apply they clear the record — a separate, deliberate act.

**WHY THIS IS A SAFETY PROPERTY AND NOT TIDINESS.** Ask why an operator removes someone
from the *default participant workspace* — the one workspace everyone is in. It is not
org hygiene. It is abuse, spam, a banned account. Under that reading, "a removed user
auto-rejoins next morning with no error" is not an awkward edge case: **it is a banned
participant silently walking back in.** Gating on membership would make removal mean
"removed until they next sign in", and nothing anywhere would report it. That is why it
outranks the loud failure modes — those cost a debugging session; this is a safety
control that quietly does not hold. (Reframing from kicktodo-1, and it is what moved
this from an open question to a decision.)

**The same key settles re-provisioning.** An idempotent re-provision that keeps the
deterministic workspace id re-joins nobody — the records still match. A genuinely new
default workspace (new id) re-joins everyone, which is correct: it is a new home. The
key that makes removal a real boundary is the key that makes re-provision safe.

**The ledger inherits §6 verbatim.** It has the same cardinality as membership — every
user who ever signed in — so it is **point-read by `(subject, workspaceId)` only, never
scanned**. A "how many have we onboarded" surface reads a counter, not `count()` over
the ledger, or the mechanism added to bound one full-tenant scan becomes another.

## Consequences

Fresh deploy → a stranger sees a catalog → signs up → lands where the catalog is →
enrolls. Zero browser steps for the operator, whose remaining job is publishing
real content rather than assembling tenancy.

The cost is a boot-time side effect per declaring feature and an org whose
membership grows without bound — both named above rather than left to be found.

## Implementation record

| phase | what | landed |
| --- | --- | --- |
| 1 | declaration seam + boot provisioning, reserved-org validation | `db5d915b1` |
| 2 | auto-join on first sign-in: member row, ledger claim, active workspace | `0c6f5343d` |
| 3 | `kicktodo-core` declares its default; seeder targets it | `e4b66d954` |
| 4 | signed-out Discover reads the public catalog | `e4b66d954` |
| 5 | membership point-read sidecar (§6a) | `e4b66d954` |
| **C1** | **§3 correction — one id, workspace-root form** | **#3832 `d54ff50ab`** |
| **C2** | bind passed a double-prefixed subject (`kicktodo-1`) | **#3840 `b844f00c4`** |
| **C3** | already-provisioned orgs were skipped, not repaired | **#3845 `d2c5c1bde`** |
| **C4** | `claimJoin` was a read-check-write, not a lock | **#3839 `143e1b5b0`** |

Tests: `adr0684-feature-default-orgs`, `adr0684-auto-join`,
`adr0684-membership-point-read`, `adr0684-default-org-is-enterable` (C1),
`adr0684-default-org-self-heal` (C3), `join-ledger-claim-is-atomic` (C4),
`oidc-bind` (C2, route-level).

### What production actually showed, 2026-09-15

The feature was green in three test files and **broken end to end** for a day. It
took a live sign-in on kicktodo.com to find it, and the path from that to working
took four corrections, two of which were defects introduced BY a correction.

| claim | evidence |
|---|---|
| declared org is provisioned at boot | `feature_default_org_created`, once per host |
| a stale pre-correction org is repaired | `feature_default_org_repaired host:kicktodo → host-kicktodo`, **exactly once** on each of `app.openwop.dev` (17:20:31Z) and kicktodo.com (17:24:26Z) |
| repair is idempotent | 1 occurrence per host in the boot window — not re-firing |
| a stranded subject re-joins under the canonical subject | yesterday's stranger re-bound: `/me/workspaces` lists the default, `switch` → 200, **no data touched** |
| a fresh stranger joins, sees a catalog, enrols | stranger B: `active=host-kicktodo`, `POST /kicktodo/enrollments` → **201**, zero operator steps |
| public catalog resolves after repair | anonymous `GET /public/host-kicktodo/challenges` → 200, 3 challenges |

### What is NOT evidenced, stated as plainly as the above

- **Removal-wins / the ban path (§7) has NO production evidence.** It needs a
  member removed by a superadmin, then re-signed-in, then confirmed absent — which
  requires the operator's own identity (`host:members:manage`; the env admin token
  is honoured on `/admin/*` only, measured 200 there / 401 on the toggles route).
  Three enrolled test subjects stand ready as instruments. **The unit tests are
  green and that is not the same claim.**
- **§6a's no-index-entry case** is unit-green only. In the words of the session
  that tried to observe it: *"unit-green stands alone here and I am not dressing
  it up."*

### A correction to this ADR's own investigation trail

Two join-ledger records logged a millisecond apart were read here as possible
evidence of a `claimJoin` race. **They were not.** Bind was writing every subject
as `user:user:<hash>` (C2), so those rows sat under a subject no read path
resolves. The `claimJoin` TOCTOU (C4) is real and was fixed on its own merits —
12 of 12 concurrent claims returned true, producing 6 duplicate member rows — but
it explains nothing observed in production. Recorded because the wrong version of
this sentence was believed for several hours.

### The transferable lesson

Three test files covered this feature and all were green. **Two of them pinned the
inverted rule** — one case was named *"accepts the hyphen/colon pair"*. A suite
that mirrors the defect cannot find it however often it runs. What was missing was
never more coverage of the steps; it was one test asking the only question a
participant cares about: after auto-join, can they get **in**? Every correction
above was found by a measurement against a running system, not by a test.
