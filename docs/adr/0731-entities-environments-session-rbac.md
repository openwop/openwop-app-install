# ADR 0731 — Entities and Environments must resolve the SESSION caller's RBAC

Status: implemented

## Context

`features/entities/routes.ts` opens with a normative contract:

> Three-tier RBAC (ADR 0386 matrix row 8, tenant-level ...) the gate composes
> `requireFeatureEnabled` + `resolveEffectiveAccess(tenantId, { subject })`
> (the developer-keys shape) ...
>   read = `workspace:read` · entity write = `workspace:write`
>   type admin = `host:members:manage`
> Fail-closed: toggle off → 404; no principal → 401; **missing scope → 403**

The code does not do that. `requireEntitiesScope` (`routes.ts:144-156`) computes
`subject = callerSubjectOf(req)`, requires it non-null — and then **discards it**:

```ts
const actingMember = req.header(ACT_AS_HEADER);
const access = await resolveEffectiveAccess(tenantId, actingMember ? { memberId: actingMember.trim() } : {});
if (!access.scopes.includes(scope)) { throw ... 403 }
```

For an ordinary session caller there is no `X-Act-As` header, so the second
argument is `{}`. With **neither** `memberId` **nor** `subject`,
`resolveEffectiveAccess` skips the member lookup entirely and returns

```ts
return { roles: ['owner'], scopes: [...OWNER_SCOPES], basis: 'tenant-owner' };
```

(`host/accessControlService.ts:1540`). Every session caller therefore resolves to
**tenant-owner**, `access.scopes.includes(scope)` passes unconditionally, and the
advertised 403 can never fire. The three-tier matrix is documentation only.

`features/environments/routes.ts:44-55` (`requireEnvScope`) has the **identical**
shape, including the same discarded `subject`.

### Measured, not asserted

- **Reachable.** A `viewer` member — `VIEWER_SCOPES` has `workspace:read` and
  neither `workspace:write` nor `host:members:manage` — created an entity **type**
  (`POST /entities/types` → **201**, full record returned) and wrote an entity
  **row** (`POST /entities/types/:name/entities` → **201**). Born-red legs in
  `test/entities-rbac-session-scope.test.ts`.
- **The premise.** `resolveEffectiveAccess(WS, {})` returns `basis: 'tenant-owner'`
  carrying `host:members:manage`. Pinned as its own leg, so the diagnosis cannot
  silently rot.
- **The outlier status.** ~100 `resolveEffectiveAccess` call sites in the repo;
  all but these two pass a caller key (`{ subject }`, usually with `orgId`, or an
  explicit `{ memberId }`). This is a local defect, not a house style, and not a
  deliberate exemption anywhere recorded.
- **The one deliberate subjectless call is NOT an instance.**
  `host/mcpServerRegistry.ts:259-263` calls `resolveEffectiveAccess(tenantId)` with
  no opts, under `auth?.kind === 'env-key'`, and says why in-source: an
  operator-configured env key **is** the tenant's own principal, so "Subjectless
  resolution IS the tenant-owner branch ... Reached through that function rather
  than by writing an OWNER scope list here." It is named here so the D5 ratchet
  below excludes it by construction rather than by accident.
- **No compensating gate.** The helper's only other checks are
  `requireFeatureEnabled` (toggle) and the non-null subject (401). The API-key arm
  above it is separately and correctly tiered; only the session arm is affected.

## Decision

**D1 — Resolve the caller with the TENANT-LEVEL resolver.** The session arm
resolves the caller's scopes as the UNION across their org memberships:

```ts
const access = actingMember
  ? await resolveEffectiveAccess(tenantId, { memberId: actingMember.trim() })
  : await resolveTenantLevelScopes(tenantId, subject);
```

> **CORRECTED before implementation (adversarial review of this ADR).** The first
> draft of D1 used `resolveEffectiveAccess(tenantId, { subject })`, because the
> entities docblock names that "developer-keys shape". **That is the wrong tool
> here, and the codebase says so in as many words.**
> `resolveSubjectScopesUnion`'s own docblock (`accessControlService.ts:1543-1556`):
>
> > The protocol runs/artifacts surface is NOT org-scoped, so the org-scoped,
> > first-match `resolveEffectiveAccess({ subject })` is the wrong tool — a subject
> > that is `viewer` in org-A and `editor` in org-B would otherwise resolve to
> > whichever membership the store happened to return first (non-deterministic).
>
> Entities and environments are exactly that case: the entities docblock itself
> says they are "workspace-scoped, not org-scoped". Shipping `{ subject }` would
> have replaced an always-open gate with a **non-deterministic** one — a subject's
> effective scopes depending on store iteration order — which is a worse failure
> than the one being fixed, because it is intermittent.
>
> MEASURED: `resolveSubjectScopesUnion` has **7** callers and is the house standard
> for tenant-level surfaces — `features/featureRoute.ts:92` (the generic
> feature-route helper), `features/portability/routes.ts:31`,
> `features/proposals/routes.ts:44`, `host/protocolAuthorization.ts:89`,
> `host/mcpServerRegistry.ts:245`, `host/mcpClient.ts:955`,
> `features/assistant/writeAuthority.ts:61`. The two closest analogues
> (portability, proposals) are tenant-level host-ext route helpers with the same
> shape as these two.

The id space is verified, not assumed: `callerSubjectOf(req)` is
`req.userId ?? req.principal?.principalId` (`entities/routes.ts:74`,
`environments/routes.ts:43`), and a probe confirmed the value a route sees as
`subject` is byte-equal to the `user.userId` a login returns, and that a member
row keyed on it resolves `basis: 'member'`. Had those differed, D1 would have
403'd every caller — an outage, not a fix.

**D2 — Keep the `X-Act-As` arm unchanged.** Delegated access already resolves a
real member and is not part of this defect.

**D3 — Fail closed, deliberately.** With `{ subject }` and no member row,
`resolveEffectiveAccess` returns zero scopes outside demo mode → 403. That is
RFC 0049 fail-closed behaviour and matches every other feature.

**D4 — Fix both instances in one change.** Environments is the same defect in the
same shape; splitting it would leave a known escalation standing behind a row.

## Blast radius

The change makes these two features behave like every other **tenant-level**
route helper. A user it now refuses is a user with **no member row in the tenant**,
who is already refused by `portability`, `proposals`, the generic `featureRoute`
gate and the protocol surface — all of which resolve through
`resolveSubjectScopesUnion` and fail closed on `basis: 'none'`.

> **CORRECTED before implementation.** The first draft compared against CRM,
> Documents, Projects and Connections. Those are **org-scoped**
> (`authorizeOrgScope`, or `resolveEffectiveAccess({ subject, orgId })`), so they
> resolve membership differently and are the wrong comparators — the claim was
> true by luck rather than by construction. The tenant-level helpers above are the
> like-for-like set.

Preserved exits:
- **Workspace owners** get a member row from `createWorkspace` (`:1029`).
- **API keys** are unaffected (separate arm, separately tiered).
- **`X-Act-As`** delegation is unaffected (D2).

**D6 — Keep the single-principal sandbox's exit (ADR 0372), at ONE owner.**

> **CORRECTED DURING IMPLEMENTATION — the regression suite falsified the
> paragraph below before it shipped.** This ADR argued that losing the demo bypass
> was acceptable because both features are OFF by default. That reasoning was
> under-scoped: `test/entities-feature.test.ts:207` ("RBAC tiers: anon sandbox is
> isolated") pins the **ADR 0372 anonymous sandbox** — a cookie-less visitor is
> minted their own empty workspace and must be able to READ it (200, `types: []`).
> That path is a first-class supported behaviour, **not** demo convenience, and it
> runs with `OPENWOP_DEMO_MODE` unset. A bare union resolver fails it closed with
> 403 — MEASURED: `origin/main` 19/19, this change 18/19, isolated to the entities
> file by reverting each file independently.
>
> The exit is therefore explicit and lives at the concept's owner, not open-coded
> in two route files: **`resolveTenantLevelScopes(tenantId, subject)`** in
> `host/accessControlService.ts` = the membership union, plus "a single-principal
> tenant is its own owner" for `anon:` / `user:` / `default`. A shared `ws:`
> workspace has no such exit and fails closed — which is precisely the escalation
> this ADR exists to remove, and precisely the narrowing GC-6 / ADR 0508 already
> applied to the sibling bypass.
>
> **The general lesson, recorded because it recurs:** a gate with no exit is its
> own defect. The first implementation replaced an always-open gate with an
> always-shut one for anonymous callers, and only a pre-existing test of a
> *different* feature's behaviour caught it.

**Demo mode — a real behaviour change, stated rather than glossed.**

> **CORRECTED before implementation.** The first draft claimed demo mode "keeps
> its documented single-principal owner bypass (unchanged code path)". **That is
> false under D1.** The bypass lives in the `!member` branch of
> `resolveEffectiveAccess` (`:1514`), which today these two helpers never reach —
> `{}` returns tenant-owner before it. `resolveSubjectScopesUnion` has **no**
> demo bypass at all: no membership ⇒ `{ scopes: [], basis: 'none' }` (`:1571`).
> So after D1, a demo visitor with no member row gets **403** on these surfaces.

Accepted, because the exposure is narrow and measured:
- Both features are **OFF by default** (`FEATURES.md` rows for Entities and
  Environments), so a demo deployment only reaches this by explicitly enabling an
  off-by-default feature.
- The two closest analogues, `portability` and `proposals`, already behave exactly
  this way — no demo bypass on a tenant-level host-ext route helper. D1 makes these
  two consistent with that, rather than inventing a third posture.
- The existing bypass is annotated `LEAK-9` in its own source as granting
  "anonymous OWNER scope to any unknown subject". Extending its reach to two more
  surfaces to preserve convenience would widen a hazard the codebase already flags.

## Alternatives weighed

1. **Leave it; treat the docblock as aspirational.** Rejected: a documented,
   test-absent authz contract that cannot fire is the exact "absence is a claim"
   failure this repo keeps paying for, and the escalation is real.
2. **Narrow the fix to entities** (the feature under review). Rejected by D4 —
   the class has two instances and the second is one roster row away.
3. **Pass `{ subject, orgId }`.** Rejected: these surfaces are tenant-level; an
   org-scoped resolution would refuse a legitimate tenant member who is not in the
   resolved org, which is a different (over-blocking) defect.
4. **Add the per-user check to the chat tool instead** — what the filed row
   `ENTC-1` prescribed. Rejected because the premise was inverted: the chat tool
   was being compared against a REST gate that does not gate. Tightening the tool
   alone would have made chat **stricter** than REST while leaving the escalation
   in place.

## Consequences

- A `viewer` can no longer author or delete entity types, write entity rows, or
  act on environments; they retain `workspace:read`.
- The `ENTC-1` row is re-scoped: the chat/REST predicate comparison is only
  meaningful once REST actually enforces, which D1 establishes.
- Deployments relying on the escalation (a non-member or under-scoped user
  administering entity types) will see 403. That is the intended correction, and
  it is stated here rather than discovered.

## Implementation record

| Phase | Change | Test |
|---|---|---|
| D1/D2/D3 | `entities/routes.ts` `requireEntitiesScope` resolves the session caller | `entities-rbac-session-scope.test.ts` (born red: viewer 201→403) |
| D4 | `environments/routes.ts` `requireEnvScope` — same change | same file, environments legs |
| D6 | `host/accessControlService.ts` `resolveTenantLevelScopes` (union + single-principal exit) | same file, D6 legs + `entities-feature.test.ts` 19/19 restored |
| D5 guard | class ratchet: no **route helper** may resolve authz with a literal `{}` second argument; the `env-key` site in `host/mcpServerRegistry.ts` is excluded by path (it is not a route helper and passes no second argument at all), and the ratchet carries a planted-instance positive control so a zero is a measurement | same file |

**D5 — Ratchet the class, not the two instances.** The defect is "a route helper
that computes a caller id and then resolves authz without it". Two instances exist
today; the guard must red on a third.
