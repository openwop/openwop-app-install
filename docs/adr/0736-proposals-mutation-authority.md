# ADR 0736 — Mutating a proposal needs authority; applying one already does

Status: implemented

## Context

`features/proposals/routes.ts` gates exactly one action. `assertCanApply`
(`:38-48`) requires `packs:publish` through `resolveSubjectScopesUnion` — the
correct tenant-level resolver, fail-closed for an unseeded caller — because
"installing the materialized artifact is a pack-publish-class mutation".

Every other route has **no gate at all**. `PATCH /proposals/:id` (`:85-97`)
reads `tenantOf(req)` and the id, then calls `reviseProposal`. Nothing checks a
scope, and nothing checks who proposed it. Same for reject, archive, GET and
list.

`Proposal.artifact` is *"the byte image last persisted on the proposal —
installed verbatim at apply"* (`types.ts:46`). So any member of the tenant can
swap the artifact of a proposal someone else raised, and the thing applied is no
longer the thing reviewed. That is the approve-what-you-see property ADR 0473
protects elsewhere with `expectedDefinitionHash`; here nothing protects it, and
`PROPC-APPLY-REVIEW` records that apply performs no reviewed-hash re-verify.

### Measured, and the bounds stated honestly

- **Reachable**: the mutation routes are registered unconditionally by
  `proposalsFeature.registerRoutes` — no toggle, no env guard at the
  registration site.
- **Two docblocks in this feature disagree, and the reassuring one is wrong.**
  `routes.ts:5-6` says "a production host 404s these unless an env-gate enables
  them". `feature.ts:6-9` says the opposite and is correct: the seam is served
  **"unconditionally (always-on substrate)"**, and `OPENWOP_PROPOSALS_ENABLED`
  gates only the **capability advertisement** in `discovery.ts:1872`. MEASURED:
  **zero** `process.env` reads in `feature.ts` and `routes.ts`.
  So the surface is *unadvertised but reachable* in production — which makes the
  missing mutation gate matter MORE than "conformance-only" suggests, not less.
  (I asserted the opposite in this ADR's first draft, from a grep that failed
  silently on a shell glob error. The env var exists; it just gates a different
  thing.) Recorded as an observation; correcting `routes.ts:5-6` is a doc fix
  this ADR makes, not a behaviour change.
- **Bounded by symbolic install**: `installedArtifactRef` is not wired to a real
  loader, so a swapped artifact is not executed today. This is why the row is
  Medium and not a Blocker — but the invariant is broken now, and the bound is a
  property of an unrelated future change rather than of this gate.
- **`owner.principal` is optional.** It is populated on the real creation path
  (`proposalsService.ts:224`) and absent on the demo seeder (`:256`). An
  ownership-only rule would therefore strand seeded rows: nobody could archive
  them. That is a gate with no exit, which this repo has now shipped twice and
  corrected twice (ADR 0731, ADR 0732).

## Decision

**D1 — A baseline write gate.** Revise, reject and archive require
`workspace:write`, resolved with `resolveSubjectScopesUnion` — the same helper
`assertCanApply` already uses, so the feature keeps ONE resolver.

**D2 — Ownership on top, where ownership exists.** When a proposal carries
`owner.principal` and it is not the caller, the mutation is refused.

**D3 — The exits, both deliberate.**
- A caller holding `host:members:manage` may mutate any proposal: an
  administrator must be able to archive a departed member's row.
- A proposal with **no** `owner.principal` (the demo seed, and any
  system-synthesized row) is mutable by any `workspace:write` holder — there is
  no owner to defer to, and refusing would strand it.

**D4 — Reads stay open.** Listing and fetching a proposal within your own tenant
is not the defect; `PROPC-MUTATE-AUTHZ` names the *swap/archive* hazard. Gating
reads would be scope creep on a conformance surface whose behavioral legs list
proposals. Recorded so the omission is a decision, not an oversight.

## Alternatives weighed

1. **Ownership only, no scope gate.** Rejected: leaves a read-only member able
   to archive nothing but also strands principal-less rows, and it ignores that
   these are writes.
2. **Scope gate only (`workspace:write`).** Rejected as insufficient: it narrows
   the population to writers but still lets any writer swap another's artifact,
   which is the filed defect verbatim.
3. **Require `packs:publish` for mutations too** (match apply). Rejected as
   over-scoping: raising a proposal and editing your own draft should not need
   pack-publish authority; only installing should.
4. **Fix the reviewed-hash re-verify here as well** (`PROPC-APPLY-REVIEW`).
   Deferred deliberately: it is a separate row with its own design (what is
   "reviewed", and where the hash is pinned), and bundling it would make this
   change unreviewable.

## Consequences

- A member without `workspace:write` can no longer revise, reject or archive.
- A writer can no longer mutate a proposal owned by a different principal unless
  they hold `host:members:manage`.
- Seeded/system proposals stay mutable by writers, by D3.
- `PROPC-APPLY-REVIEW` remains open and is now the only half of the
  approve-what-you-see gap left on this surface.

## Implementation record

| Phase | Change | Test |
|---|---|---|
| D1/D2/D3 | `assertCanMutate` in `proposals/routes.ts`, applied to revise/reject/archive | `proposals-mutation-authority.test.ts` — born red |
| D4 | reads unchanged | leg asserting a reader still lists/gets |
