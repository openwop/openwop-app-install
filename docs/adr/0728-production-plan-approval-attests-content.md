# ADR 0728 — A production plan's approval must attest to the content that was approved

Status: implemented

**Feature:** Production Intelligence (`FEATURES.md` ordinal 221) · ADR 0172 · feature-loop 2026-09 it.53
**Supersedes the premise of:** `PIC-3` (grade-code 2026-08-28, Nice-to-have — "no optimistic concurrency on `savePlan`")

## Context

A production plan carries a lifecycle status (`draft → approved → …`) transitioned by a human through `POST …/plans/:planId/status` (`routes.ts:261`). The plan itself is model-generated: the `feature.production.nodes.plan-generate` node calls `ctx.features.production.savePlan(...)` with the model's output.

`savePlan` writes the whole record and deliberately preserves the existing status:

```ts
status: existing?.status ?? 'draft', // a re-generate never silently un-approves an accepted plan
```

**That comment defends the wrong invariant.** Preserving the status across a full content replacement does not protect the approval — it *detaches* it. Every content field (`strategySummary`, `recommendations`, `totalBudget`, `timeline`, `capabilityAssessment`) is overwritten, `generatedAt` is carried over from the original, and `updatedBy` still names the human who approved. The row then asserts: *approved by Alice*, over content Alice never saw. Since `recommendations` is what routes real work to real contractors with real budgets, that is an integrity claim the data cannot support.

There is no second record of what was approved: `ProductionPlan` has no content hash, no version, and no approved-snapshot (`productionService.ts:342-357`).

### Reachability — latent, and stated honestly

The shipped node cannot choose the id: it derives `planId` from `ctx.runId` (`packs/feature.production.nodes/index.mjs:195`), so a model has no way to name an existing plan. The agent tool (`PRODUCTION_PLAN_TOOL_ID`) takes channels/assets/briefId and no plan id. The surface op *does* accept an arbitrary `args.planId` (`surface.ts:139`), and `ctx.features.production` is reachable from any workflow node, so a tenant-authored chain could target an approved plan directly.

**Every re-entry path was measured, and each writes a DIFFERENT plan id:**

| path | outcome |
|---|---|
| node retry | the shipped chain's `plan-generate` declares `config: {}` — no `config.retry`, so the executor gives it a single attempt (`executor.ts:267`) |
| resume | hydrates already-completed nodes rather than re-executing them (`executor.ts:1334`) |
| fork | mints `newRunId` (`routes/runs.ts:1633`) ⇒ a different `pln:run:<id>` |
| replay | a fork MODE, also under `newRunId` (`routes/runs.ts:1763,1779`) |
| demo seeder | passes an explicit `planId` but guards with `if (existingPlanIds.has(planId)) continue` (`demoProductionSeed.ts:148`) — never re-writes |

So the realistic path is a **tenant-authored chain node** calling the surface with a chosen `planId`; nothing shipped reaches it today. That is why this is an **Improvement**, not a Blocker — and why the refusal is safe: no shipped flow is turned into a failure by it.

> I checked this rather than assuming it, because the previous iteration of this loop (it.50) shipped an ADR whose "one config away" reachability claim was false, and the `/architect` pass falsified it by measurement. The claim here is deliberately the smaller one the evidence supports.

## Decision

### D1 — a content-replacing write to a non-`draft` plan is a typed refusal

`savePlan` refuses when a plan exists, its status is not `draft`, and the CLEANED candidate differs from what is stored. It throws the codebase's established 409 `OpenwopError` (`conflict`, with `details.reason:'plan_not_draft'` as the machine-readable discriminator — a feature-local code would mean widening the shared `OpenwopErrorCode` union for one guard), which the node already catches and turns into an honest `{status:'failed', code:'plan_invalid'}` rather than an uncaught throw (`index.mjs:203`) — so the existing failure path carries it with no new machinery.

**Where the comparison happens is load-bearing, not an implementation detail.** `savePlan` COERCES after reading the existing row: `cleanRecommendations` drops vendors that are not in the directory, `cleanBudget` normalises the currency, `cleanStr` truncates. Comparing the RAW input against the stored record would therefore report a difference for input that cleans to the identical record — and the refusal would fire on an honest idempotent retry, which is the precise case the idempotency leg exists to protect. So the candidate record is built FIRST, and the comparison is cleaned-candidate vs stored over CONTENT fields only, excluding `status`, `updatedBy`, `generatedAt` and `updatedAt` (which legitimately differ on every write).

An IDENTICAL re-write still succeeds: per-run idempotency (a retried node re-sending the same content) must stay a no-op, and that is what makes the refusal safe to add.

### D2 — the comments that defend the weaker property are corrected where they stand

The line reasoning "a re-generate never silently un-approves an accepted plan" is replaced with the actual invariant: an approval attests to content, so a re-generate may not silently REPLACE an accepted plan either. The surface docstring calling `savePlan` "idempotent per planId" (`surface.ts:29`) becomes conditionally true and is corrected too. Leaving a comment that defends the weaker property is how the next reader re-derives the same mistake.

### D3 — the witness proves the three cases apart

A test that only asserted "the refusal throws" would pass with idempotency broken. The witness asserts: (1) a draft plan is replaced normally; (2) an approved plan with CHANGED content is refused and **nothing is written** (re-read proves the stored content is unchanged); (3) an approved plan with IDENTICAL content still succeeds (idempotent retry preserved).

## Why an ADR for a one-function guard

Because it OVERTURNS a documented decision — the `:463` comment is a deliberate choice with a stated rationale, and reversing it silently would leave the next reader to re-derive the argument — and because it carries the record of four tracker rows that were closed in code and never ticked.

## Implementation record

Landed in one PR. Witness `backend/typescript/test/production-plan-approval-attests-content.test.ts` — 5 cases, **born red on 2** (the guard) against the pre-ADR service.

**The Blocker the review raised was REAL and the witness proved it twice.** Case 3b exists because an input naming a vendor that is not in the directory cleans to `matchingVendors: []` while the otherwise-identical stored record has no such key — both meaning "no matching vendors". A plain `JSON.stringify` comparison called that a CHANGE and refused an honest retry; the first implementation did exactly that and case 3b caught it. The fix is a canonical form (sorted keys, `undefined`/`null` dropped, an EMPTY array treated as absent). Sabotage-proved: replacing `canonicalContent` with a raw compare reds case 3b alone, nothing else.

## Alternatives weighed
- **Demote to `draft` on a content change.** Rejected: it silently discards a human decision and would let a background retry un-approve work someone had signed off; the refusal keeps the human in control.
- **Version/CAS with `expectedVersion` (the `PIC-3` framing).** Not a substitute: the defect here is a *sequential* overwrite, which a CAS on the current version would happily allow. But this is NOT a dismissal of `PIC-3`, and the first draft of this ADR read as one. Both `savePlan` (`:467`) and `transitionPlan` (`:482`) blind-`put` a whole record read-modify-written from their own snapshot, so a save racing an approval transition can still drop the approval or resurrect stale content — **D1 closes the sequential overwrite and leaves that concurrent race open. `PIC-3` stays open, explicitly, and is not claimed as closed by this ADR.**
- **Store an approved-content snapshot and compare on read.** Larger, and it makes the plan row carry a second copy of everything. The refusal prevents the divergence instead of detecting it afterwards.

## RFC verdict

Host-only. `production.plan` is a host-extension artifact; the refusal rides the feature's existing typed error and the node's existing failure status. Nothing on the OpenWOP wire changes. No RFC.

## Tracker corrections recorded with this ADR

Re-verified at `f7aabb6bb`: **four of the six open `PIC-` rows were already closed in code and never ticked** — `PIC-1` (referential integrity) by #3546, `PIC-2` (reject-not-coerce at the durable write) by #3554, and `PIC-4` (KB de-index toggle-gating + the caller-less backfill) by the `KBC-5` work (`245e3f6f7`, `8b70aa96b`). `PIC-5` (free-text vendor `notes` reach the managed KB) and `PIC-6` (pack-local `DEFAULT_MODEL`) remain genuinely open.

## Review record

An adversarial `/architect` pass on this text before implementation returned **1 Blocker and 2 SHOULDs**, all folded in above: the Blocker was that "content differs" was undefined and the obvious reading (raw input vs stored record) would make the refusal fire on an honest idempotent retry, inverting the leg meant to protect it; the SHOULDs were the `PIC-3` dismissal and the unmeasured reachability table. The pass independently verified the fork/replay/resume/retry/seeder paths above.

## Open questions
- [ ] `PIC-5`: vendor `notes` are operator-typed free text indexed into `mgd-production-<org>`. Pricing is already handled (only WHICH capabilities are priced is indexed, never the figures). Decide whether notes deserve the same treatment or an explicit "this is indexed" affordance in the editor.
