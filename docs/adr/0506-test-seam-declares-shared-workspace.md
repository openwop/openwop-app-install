# ADR 0506 — The auth test seam DECLARES a shared workspace; it cannot derive one

Status: Accepted

## Context

`CODEBASE-ASSESSMENT.md` `GC-1` (Blocker) recorded that the KickTodo adversarial
authz suite asserts only that the handler **source** contains its gate — it never
proved the gate fires over HTTP. A previous session attempted the HTTP proof,
failed, and reverted, recording:

> this is a genuine identity-model change, not a test rewrite — do not re-attempt
> it as one.

That warning was right about the difficulty and wrong about the cause.

### The defect

`routes/authTestSeam.ts` minted every session with `personalTenant: tenantId` —
the **requested active** tenant passed as the caller's **own** tenant. So
`isOwnPersonalWorkspace` (`host/requestSubject.ts:39-43`) returned true for a
shared workspace, violating its own documented invariant:

> shared workspaces are strictly membership-derived … **Never true for a shared
> `ws:` workspace.**

That predicate short-circuits **six** authorization choke points:
`features/featureRoute.ts:136` (`requireKicktodoManage`) and `:237`
(`requireTenantScope`), `host/protocolAuthorization.ts:113`,
`features/orgs/routes.ts:65`, `routes/accessControl.ts:132`,
`routes/kanban.ts:723`.

A route test in a shared workspace was therefore granted the exact authority it
was trying to deny — which is why GC-1's proof looked impossible.

This never reached production. All three production callers pass a distinct,
correctly-derived personal tenant: `features/users/authRoutes.ts:78`,
`routes/workspaces.ts:173` (which also verifies membership at `:151-153` before
minting), `routes/authSamlSso.ts:93`.

Note `authTestSeam.ts` already carried a comment recording that a *prior* session
fixed the sibling instance of this same bug — auto-seeding an owner member row
"silently promoted every 'viewer' to owner and inverted the 403 assertions". The
`personalTenant` collapse was a second, independent channel for the same
promotion, left standing.

## Decision

**The caller declares co-tenancy; the seam does not infer it.** `test/login`
accepts `sharedWorkspace?: boolean`. When true (and an explicit `tenantId` is
given), the session's personal tenant is derived from the subject
(`user:<shortHash(subject)>`), so authority becomes membership-derived. Otherwise
`personalTenant` stays equal to `tenantId`.

### Why not simply always derive it

Because for most of the suite the collapsed value is **true, not a lie**. Those
harnesses use the pre-ADR-0015 idiom where the tenant is a plain container
(`tenantId: 'default'`, `'org:pk-…'` — not `ws:`-shaped) and the caller's home
tenant genuinely *is* that tenant. The seam cannot distinguish "my home tenant"
from "a workspace I belong to" from the id alone.

Deriving unconditionally is not merely unnecessary there — it is actively wrong.
It flips `resolveCallerUser` (`features/users/usersGuards.ts:85`) onto its
canonical-home branch, which returns a `User` whose `tenantId` is the **home**
tenant; `requireOrgScope` (`features/featureRoute.ts:188-190`) then compares the
org's **active** tenant against it and 404s.

**Measured**, holding parallelism constant over the same 120 files:

| Seam shape | Result |
|---|---|
| baseline (collapsed) | 120 files / 890 tests pass |
| derive unconditionally | 120 files fail, **501 of 890** tests fail |
| derive + found the personal workspace | 120 files fail, **503** fail |
| **declared (`sharedWorkspace`)** | **120 files / 890 tests pass** |

None of those 501 were authority defects. They were identity-resolution
misroutes, confirmed by instrumenting the ADR 0015 membership bounce
(`middleware/auth.ts:868-874`) and observing **zero** bounces in a failing file.

## Blast radius on authz claims

Narrower than the raw failure count suggests. `requireOrgScope` — used by **103**
modules — has no implicit-owner short-circuit, so its refusals were always
genuine. Only the **17** modules behind the short-circuiting gates
(`requireKicktodoManage` ×7, `requireTenantScope` ×10) plus the four other choke
points could assert an unfalsifiable refusal in a shared workspace. GC-1 closes
the KickTodo case; the rest is tracked as `GC-3`.

## Consequences

- GC-1's HTTP proof exists (`test/kicktodo-authz-http.test.ts`, 4 tests), and is
  non-vacuous in **both** directions: removing the opt-in reddens 2 tests;
  removing `await gate(req)` from the GET `/candidates` handler reddens 2 tests.
- `features/users/usersService.ts` exports `userIdFor`, so a test can derive a
  caller's future `userId` and register membership **before** the session exists.
  This is what the GC-1 row believed impossible; it is a pure hash of
  `(tenantId, principalId)`, both of which a test controls.
- Under `sharedWorkspace: true`, a **non-member**'s refusal surfaces as 404, not
  403 — the ADR 0015 bounce lands them in a tenant where the feature toggle does
  not apply, so the feature gate answers first. Assert `>= 400`.
- Not adopted: founding the personal workspace so the bounce has a real landing
  site. It was written, measured to change **no** outcome (the 404 above persists),
  and dropped rather than shipped as unverified code.

## Alternatives considered

- **Migrate all 120 files to provision real membership.** Rejected: it would have
  been 120 files of fixes for a cause — implicit ownership — that the measurement
  shows was not driving the failures.
- **Ratchet the 501 failures at a no-growth baseline.** Rejected. A ratchet holds
  *classified* debt; an a11y baseline of 91 silent cards is a complete statement.
  "501 tests may not prove what they claim" bounds nothing, and would have frozen
  a set that turned out to be almost entirely irrelevant to authorization.
- **Make `personalTenant` a required argument** of `issueUserSession`
  (`middleware/cookieSession.ts:182` defaults it to `opts.tenantId`). Deferred to
  `GC-4`: the default is correct for its documented contract ("at login the active
  tenant IS the personal workspace") but unenforceable, and its failure mode is
  silent privilege escalation across six choke points.

## Follow-ups

- `GC-3` — audit refusal assertions on the 17 modules behind the short-circuiting
  gates; opt each genuinely-shared harness into `sharedWorkspace: true`.
- `GC-4` — make `personalTenant` explicit-or-fail in `issueUserSession`.
- `GC-2` — `CustomRole` stores explicit `scopes[]`, so a custom admin-equivalent
  role silently loses `host:kicktodo:manage` (`host/accessControlService.ts:284`).
