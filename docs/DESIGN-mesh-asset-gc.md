# Mesh-asset GC — design (ENG-1 / CAD-G1 · DATAG-1)

> Status: **Design only — not built.** Written 2026-07-28. The trigger to build is
> stated at the end; until it fires, the per-tenant 100-mesh quota is the control.

## The problem

CAD canvases reference mesh assets by `assetRef`. Deleting a canvas removes the
canvas row; it does **not** remove the meshes that canvas was the only referent
of. Those assets stay in media storage indefinitely, paid for and never served.

This is currently bounded, not solved: the per-tenant **100-mesh quota** caps how
bad it can get per tenant. That is why this is a design doc and not a change.

## Two candidate approaches

### A — Refcount on `assetRef`

Maintain a count per asset; increment when a canvas references it, decrement on
canvas delete or reference removal; delete at zero.

**Why this is the wrong choice here.** A refcount is only correct if *every*
writer of an `assetRef` participates. The moment one path forgets — a new canvas
type, an import, a fork, a template instantiation, a migration that copies rows —
the count is wrong. And it is wrong in the **unsafe direction**: an
under-counted asset is deleted while something still references it, which
presents to the user as a canvas that silently loses its geometry.

This repo has ruled against exactly this shape twice. ADR 0439 named the
hand-kept dependency list an anti-pattern, and ADR 0446 declined an eager
consumer index for the same reason — a second source of truth that must be
maintained by hand drifts, and a drifted one is worse than none because the
delete path *trusts* it. The vault consumer index (`ENG-2`, 2026-07-28) is the
same lesson: the fix was to make the lookup honest about what it does not know,
not to build an index that claims to know.

### B — Sweep on canvas delete (recommended)

On canvas delete, collect the `assetRef`s that canvas held, and for each ask the
authoritative question — *is any live canvas in this tenant still referencing
it?* — then delete the unreferenced ones.

**Why this wins.** It is **idempotent** (running it twice deletes nothing extra),
**recoverable** (a missed sweep is a later sweep, not corruption), and wrong only
**transiently** — an asset can linger until the next sweep, which costs storage,
not correctness. The failure mode is "we paid for a byte too long", against
refcounting's "the user's model lost its mesh".

It also needs no new durable state, so there is nothing to drift.

**The cost, stated honestly:** the "is anything still referencing it" question is
a scan over the tenant's canvases. That is acceptable *because it runs on delete*
— a rare, user-initiated, already-slow operation — and never on a read path. It
must be tenant-scoped (`DurableCollection.list()` is a full cross-tenant scan;
the run-snapshot incident is the precedent for why that matters).

## Shape, if built

1. On canvas delete, extract `assetRef`s from the canvas before deleting the row.
2. Delete the canvas **first**, so a mid-way failure leaves orphaned *assets*
   (invisible, sweepable) rather than a canvas whose meshes are gone (visible,
   broken) — partial-failure ordering must fail toward the recoverable side.
3. For each ref, scan the tenant's remaining canvases; delete the asset only if
   no live canvas references it.
4. Make step 3 resumable: a sweep that dies halfway must be safe to re-run.

A periodic reconciliation sweep is explicitly **not** proposed. It would be a
second owner of the same question, and the delete-time sweep already converges.

## Trigger to build

Do **not** build this speculatively. Build it when either fires:

- a real tenant hits the **100-mesh quota** (the bound stops being theoretical), or
- the **media-sweep cost curve bends** — see `docs/CODEBASE-ASSESSMENT-adr0388-0389-batch.md`
  `DEBT-3`.

Until then the quota is the control, and this document is the answer to "what
would we do" so the decision does not have to be re-derived under pressure.

## Open question

Whether an asset can be referenced by anything **other** than a canvas (an
export, a document embed, a pack fixture). If yes, step 3's scan is incomplete
and the delete becomes unsafe — resolve this *before* writing any code, because
it is the one assumption that turns approach B from safe-but-slow into the same
unsafe-direction failure as approach A.
