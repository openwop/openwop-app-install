# ADR 0508 — Org-scope must resolve against the ACTIVE tenant (and the naive fix is unsafe)

Status: implemented

> **FIXED as of Phase 2.** The banner below is kept for the record: when this ADR
> was written nothing was fixed, the defect was live, and a two-line fix had been
> written, measured, and deliberately NOT shipped — see §"Why the obvious fix must
> not ship", which is still the reason the fix took two phases. The acceptance test
> at `backend/typescript/test/orgscope-shared-workspace.test.ts` is now un-skipped
> and green.

## The defect

`requireOrgScope` (`features/featureRoute.ts:185`) — the single org-scoped RBAC
choke point, which `authorizeOrgScope` composes and **98 feature modules** ride —
validates the path org against `user.tenantId`, the caller's **HOME** tenant:

```ts
const user = await resolveCallerUser(req);
const org  = await getOrg(req.params.orgId);
if (!org || org.tenantId !== user.tenantId) throw 404;
const access = await resolveEffectiveAccess(user.tenantId, { subject: user.userId, orgId });
```

But `POST /orgs` files orgs under `tenantOf(req)` — the **ACTIVE** tenant
(`routes/accessControl.ts:321`) — and `resolveCallerUser` returns the canonical
home-tenant user whenever `req.personalTenant` is `user:`-prefixed
(`features/users/usersGuards.ts:85-93`), which it always is for a real signed-in
user, *including one who has switched into a shared workspace*.

So for any caller inside a shared `ws:` workspace the two never match.

**Reproduced on `origin/main` through the pure production path** — sign in →
`POST /workspaces` → `POST /workspaces/:id/switch` → `POST /orgs` (201) →
`GET /forms/orgs/:orgId/forms` → **404**. The caller is the workspace OWNER reading
an org they created seconds earlier. Instrumented at `featureRoute.ts:188`:

```
orgTenant  = ws:869eeb36-…    <- where the org lives (correct)
reqTenant  = ws:869eeb36-…    <- the caller IS in that workspace (correct)
userTenant = user:72bc387c…   <- the caller's HOME tenant  <-- what the guard compares
```

Both halves are wrong, not just one: `resolveEffectiveAccess` takes the same wrong
tenant, so authority is resolved in the personal workspace too. The 404 merely
fires first.

**Impact: every org-scoped feature route is unreachable inside every shared
workspace, for every member including the owner.** ADR 0015 B2B tenancy and
org-native features do not compose today.

The guard dates to #70/#162 — it predates ADR 0015, when a tenant was one thing,
and was never revisited when personal/active split. `host/requestSubject.ts:21-27`
already documents the contract it violates: *"With ADR 0015 this is the ACTIVE
workspace."*

## Why it was never caught

No test could model a real shared workspace. Every route test used the auth seam
with a non-`ws:` tenantId, and until #2728 (ADR 0506) that seam collapsed
`personalTenant` onto the active tenant — so `resolveCallerUser` took its
`if (req.userId)` branch and `user.tenantId` coincidentally equalled
`org.tenantId`. **The GC-1 seam bug was masking this product defect.** The tests
that do use real `ws:` workspaces (`workspace-tenancy`, `authorization-fail-closed`,
`kanban-assignment-routes`) only hit `/orgs/:id/members`, guarded by
`routes/accessControl.ts:132` — a different code path.

## Why the obvious fix must not ship

The candidate was two lines: compare against `tenantOf(req)`, and pass it to
`resolveEffectiveAccess`. It works, and the full suite stays green
(**1345 files / 9683 tests / 0 failures**). It is still **wrong to ship**, for a
reason the green suite cannot see.

`requireOrgScope` returns `{ user, orgId }`, and **55 of the 98 gated modules key
their reads and writes off `user.tenantId`** — the HOME tenant
(`features/forms/routes.ts:46,63,70,87,98,107` is representative).

Today that mismatch is invisible because the shared-workspace path is DEAD: the 404
makes those handlers unreachable, and in the personal tenant home == active. Fixing
only the guard makes the path live while 55 modules still read and write in the
wrong tenant — converting a **fail-closed 404** into **reachable, writes to the
wrong tenant**. That is strictly worse than the bug.

Measured, with the candidate applied and `OPENWOP_DEMO_MODE=true` (as the live demo
deploy runs — verified on `openwop-app-backend`): a workspace **viewer** POSTed a
form to a sub-org they are not a member of and got **201**, with the row landing in
their own personal tenant:

```
[DEMOLEAK] viewer WRITE to a sub-org they are not in = 201
  {"tenantId":"user:ce6ea8af…","orgId":"org-361853e5", …}
```

Two distinct faults in one response: authority granted (`resolveEffectiveAccess`
finds no member row for that sub-org and the demo branch at
`host/accessControlService.ts:1102` returns **owner** scopes), and the write filed
under the wrong tenant.

The demo-owner bypass is opt-in, default-off and already alarmed as LEAK-9 — but it
is ON in the demo deploy, and today this defect is accidentally shielding it.

## Decision (proposed — not yet implemented)

1. Org-scope resolves against the **ACTIVE** tenant. `tenantOf(req)` is the tenant
   for both the IDOR guard and `resolveEffectiveAccess`.
2. **The gate must hand the handler its tenant.** Change the return to carry an
   explicit tenant and migrate the 55 modules off `user.tenantId`, so the tenant a
   request is authorized in is by construction the tenant it reads and writes in.
   `user.tenantId` must stop being a data-routing key on org-scoped paths.
3. Narrow the demo bypass to personal/`anon:` tenants before (1) lands, so fixing
   the guard cannot widen it.

`user.userId` stays the correct SUBJECT — verified: every production member-creation
path keys by the caller's stable home `User.userId` (`routes/workspaces.ts:132` via
`callerSubject`, `features/orgs/invitationsService.ts:196`,
`routes/accessControl.ts:457`) while filing the row under the ACTIVE tenant. With
the candidate applied the owner gets a real **200**, not a 403 — so subject and
tenant agree once the tenant is right.

## Alternatives considered

- **Ship the two-line guard fix now, migrate the 55 modules later.** Rejected: the
  window between them is a live cross-tenant write path. The 404, however wrong, is
  fail-closed.
- **Make `resolveCallerUser` return an active-tenant-scoped user.** Smaller diff,
  but it changes identity resolution for every consumer, not just org-scoped routes,
  and `user.tenantId` legitimately means "home" elsewhere. Worth weighing against
  (2) when this is implemented; it is the main open question.

## Test-suite honesty

The suite is green **both with and without** the candidate fix. It moved by zero.
That is not evidence of safety — it is evidence that the shared-workspace org path
has **no coverage at all**, which is how a total-unreachability defect survived from
#70 to now. The committed skipped test is the missing coverage.

Its sabotage behaviour is recorded so a later author does not have to re-derive it:
reverting the guard reddens **1 of 4** (the owner case); over-widening the guard to
`if (!org)` reddens the **2 refusal cases** (403 instead of 404 — the existence
leak). The fourth case (personal tenant) passes either way by design: it is a
regression canary, not a discriminating assertion.

## Implementation record

**Phase 1 — the gate hands the handler its tenant (landed).** `requireOrgScope` /
`authorizeOrgScope` / `requireCmsScope` now return `tenantId` alongside
`{ user, orgId }`, and every gate-bound handler consumes it instead of re-deriving
from `user.tenantId`. The guard itself is **unchanged** — it still compares
`user.tenantId` — so Phase 1 is **inert by construction**, which is its safety
property: the path stays 404-fail-closed while the 55 modules become correct.

*Measured:* full suite **1347 files / 9701 tests / 0 failures**, byte-identical to
the pre-change baseline. Zero movement is the REQUIRED outcome here, not a weak one.

*Gate:* gate-bound `user.tenantId` data-routing went **55 → 0**. (55 counts modules that USED it before the change; the merged delta touches **49** `src` files — the two figures are not interchangeable.) The 21 remaining
occurrences in gated files are all justified and were verified individually, not
counted:

| Site | Why it stays |
|---|---|
| `features/featureRoute.ts` (5) | the gate's own definition |
| `features/cms/cmsScope.ts` (1) | the type + the system-site branch, whose data tenant is the reserved `SYSTEM_SITE_TENANT`, not the caller's |
| `features/profile-memory/knowledgeRoutes.ts` (13) | **not gate-bound** — personal-profile reads via `resolveCallerUser`; the home tenant is correct here |
| `features/scheduled-agent-chats/routes.ts` (2) | the `channelCaller` helper — CHANNEL-scoped (ADR 0202 D3), membership-gated by `getChannel`, no gate-supplied tenant exists |

**Correction to §"Is there existing bad data".** The original text said the
shared-workspace path was unreachable. That is true only of the ROUTE half. Write-
capable agent-tool paths key off `scope.tenantId` (the run's tenant) across 10+
features, so rows DO exist in `ws:` tenants — correctly tenanted. The conclusion
stands (no migration: bad data would need a handler writing `user.tenantId` while
authorized in `ws:`, which the 404 prevents), but with a consequence worth stating:
**agent- and workflow-written data in shared workspaces is currently invisible to
the UI.** Phase 2 will make it appear. That is correct, not a leak.

> **SECOND CORRECTION (2026-08-17) — the "no migration" premise was FALSIFIED by
> Phase 2 itself.** The parenthetical above reads *"no migration: bad data would need
> a handler writing `user.tenantId` while authorized in `ws:`, which the 404
> prevents."* Phase 2 **removed that 404**, and CRM's 95 gate-bound handlers were
> still re-deriving `ctx.user.tenantId` for the whole window between the two phases —
> so rows were written in exactly the state the premise called impossible: authorized
> in `ws:`, filed under the caller's HOME tenant, carrying an `orgId` the workspace
> owns. (CRM's re-derivations were invisible to the Phase 1 ratchet, which could not
> see the whole-object gate-binding shape; see that gate's own CRM-1 correction.)
>
> After the CRM fix those rows are **unreachable by every path**: reads go to the
> `ws:` partition, the home-tenant copy fails the org gate, and every reclaim path —
> `ws:` teardown, the CRM retention purger, the `eraseCrmSubject` DSAR eraser —
> enumerates via `listForTenantIndexed(tenantId)`. Undeletable CRM PII in the wrong
> partition is a compliance problem, not a cosmetic one.
>
> **`APP_MIGRATIONS` version 19 (`retenant-misfiled-crm-org-rows`,
> `features/crm/orgScopeRetenant.ts`) closes it.** Narrow by construction — a row
> moves only when it carries both a `tenantId` and an `orgId`, that `orgId` resolves
> to an org that exists, that org is owned by a different tenant, and the row's own
> tenant is not itself a `ws:` workspace (the move is one-directional, so an
> accidental mass-move is impossible). Per-row CAS, idempotent, never fatal to boot,
> and it moves the `hostextidx:` tenant marker with the row — a value-only rewrite
> would leave the OLD tenant still reading the row through a stale marker, since
> `listForTenantIndexed` does not re-filter on the row's tenant.
>
> **Named gap:** companies and deals live in the content kernel, where the primary key
> embeds the tenant, so moving one is a re-key across five collections. Migration 19
> COUNTS them (`kernelResidue`, logged as a warning) rather than moving them; closing
> that needs its own ADR. Left as a number an operator can act on, not a silence.

**Second copy of the guard found.** `features/documents/routes.ts` `/locate/:documentId`
HAND-ROLLS `requireOrgScope`'s logic rather than calling it, so it carries the same
defect and is NOT fixed by the gate change. Its local is renamed `caller` so the
migration could not silently rewrite it. Phase 2 must flip it too — better, reduce it
to the shared guard.

**Phase 2 — flip the guard (landed).** `requireOrgScope` now resolves against
`tenantOf(req)` for both the IDOR guard and `resolveEffectiveAccess`. The second,
hand-rolled copy of the guard (`features/documents/routes.ts` `/locate/:documentId`,
which cannot call the shared helper because it RESOLVES the org from the document
rather than reading `req.params.orgId`) is flipped in lockstep.

*Measured:* full suite **1351 files / 9719 tests / 0 failures**. None of the 55
migrated modules regressed.

*Coverage added*, because zero suite movement in the earlier measurement was
evidence of ABSENT coverage, not safety:
- the acceptance test un-skipped (6 cases);
- **a write round-trip asserting the persisted row's `tenantId` equals the
  WORKSPACE** — the assertion that would have caught the candidate fix, which
  returned a cheerful 201 while filing the row under the caller's personal tenant.
  Status codes alone could not see it;
- **cross-workspace isolation asserted on CONTENT** (workspace B must not see
  workspace A's row), not on a status code;
- a **structural ratchet** (`test/orgscope-tenant-source-ratchet.test.ts`) holding
  gate-bound `user.tenantId` at zero, with comments stripped before counting, an
  anti-vacuity case proving the matcher fires on the real shape, and a check that
  every exemption still names a file that exists.

*Sabotage, both directions:* reverting the guard to the home tenant reddens 3 of the
6 acceptance cases; reintroducing `user.tenantId` in a single gated module trips the
ratchet.

> **Correction note (2026-08-01, GC-8 — the claim above was too strong when written).**
> "A structural ratchet holding gate-bound `user.tenantId` at zero" described the
> spelling it policed, not the invariant it implied. The matcher keyed on the literal
> identifier `user`, so a one-word rename defeated it — **in exactly the two files most
> likely to need it**, because a handler that cannot call the shared guard hand-rolls it
> and names its local something else. Measured: reverting `documents/routes.ts`
> `/locate/:documentId` to `caller.tenantId`, reintroducing this ADR's defect verbatim,
> left the ratchet **3/3 green** and the acceptance suite **6/6 green**. The 98 modules
> that were never the risk were protected; the 2 that were, were not.
>
> Fixed in both dimensions (#2790): the ratchet now collects every identifier bound from
> `resolveCallerUser` (and any `{ user: alias }` gate destructure) and polices
> `<that>.tenantId` — verified to flag the regression it used to miss, with the renamed
> binding added to its anti-vacuity case; and the acceptance suite gained a `/locate/`
> case, verified load-bearing. Source shape and behaviour are held separately because
> neither alone was sufficient. Suite figures above are the Phase-2 measurement; GC-8
> added 4 tests (now 1351 files / 9723 tests).
>
> The original text is left standing per this repo's correct-don't-rewrite convention —
> an overstated guarantee that a later measurement falsified is exactly the reasoning
> trail worth keeping.

## Follow-ups

- ~~`GC-5` — implement decision (1)+(2) above; un-skip the acceptance test.~~ **DONE**
  in two phases (see the implementation record). Phase 2 flipped the guard to
  `tenantOf(req)`, flipped the second hand-rolled copy in `documents/routes.ts`
  `/locate/:documentId` in lockstep, un-skipped the acceptance test, and added a
  structural ratchet. Full suite 1351 files / 9719 tests / 0 failures.
- ~~`GC-6` — narrow the `demoMode()` de-facto-owner branch to personal/`anon:`
  tenants.~~ **DONE.** The branch is now `demoMode() && isSinglePrincipalTenant(tenantId)`,
  with the predicate as an **allowlist** (`default` / `anon:` / `user:`) so an
  unrecognised tenant shape fails closed rather than inheriting the single-principal
  assumption. Proven at the SERVICE level, because the route path is still
  unreachable behind GC-5 — reverting the narrowing turns a workspace viewer's
  sub-org query into 24 owner scopes. GC-5 is now safe to attempt: its guard fix can
  no longer widen this bypass.
- Unverified: SCIM/SAML-provisioned members. `host/auth/scimProvisioningService.ts`
  does not call `createMember` directly; the JIT paths were not traced. If any of
  them key membership by something other than the home `User.userId`, decision (1)
  turns a 404 into a silent 403 for those users.
