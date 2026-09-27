# ADR 0495 — Selective promotion (promoting a subset of config domains)

Status: **Proposed** — design only; not implemented. Written to be argued with.

## Context

`docs/steward/UX_UPGRADE-environments.md` DEF-2. ADR 0387 promotes a **whole snapshot**: an
environment pins one content-hash and that hash *is* its config. LaunchDarkly's
comparable surface lets you pick **which settings** to copy
([compare-copy](https://launchdarkly.com/docs/home/flags/compare-copy)) — you can move
one flag without moving the rest.

ADR 0387 § value-level preview (#2571) closed the *visibility* half: you can now see
which entries a promotion changes. DEF-2 is the *control* half — acting on a subset.

**This is the first change in this line that alters what `promote` DOES rather than
what it reports**, on the path that pushes config to production. That is why it is a
Proposed ADR rather than a PR.

### Verified starting facts (checked against the code, not recalled)

| Fact | Where |
|---|---|
| A snapshot is **content-addressed**: `hash = hashDomains(domains)` | `environmentsService.ts:155` |
| `snapshotLive` is **idempotent by hash** — an identical capture returns the existing record | `:156` |
| Drift is a **hash equality test**: `drifted: currentSnapshot !== liveHash` | `:263` |
| The approval gate records exactly `{ toEnv, fromEnv, snapshotHash }` | `promotionApproval.ts:74` |
| Domains split into two restore registers, `exact-match` and `apply-only` | `configDomains.ts` (ADR 0479) |

## The three problems a naïve implementation creates

### 1. A subset promotion produces a pointer to config that does not exist

Today `movePointer` sets `currentSnapshot = <hash>`, and every downstream feature reads
that as *"this environment's config is exactly that snapshot"*. Apply only the
`feature-toggles` half of snapshot `abc…` and the target's real state is
"`abc…`'s toggles + whatever it already had elsewhere" — which corresponds to **no
snapshot**.

Everything keyed on that identity degrades at once:

- **drift** compares `currentSnapshot` to the live hash, so it would report permanent
  drift against a pointer that was never accurate;
- **rollback** re-pins a prior hash and applies it — from a state that no ledger row
  describes;
- **the ledger** records `snapshotHash`, which would now name something other than what
  landed.

### 2. Subsetting shows two different semantics through one control

Excluding an **apply-only** domain (publish-pointers, workflow-pins) is nearly a no-op —
its import never clears anything, so "don't promote it" and "promote it" differ only in
whether present entries are overwritten. Excluding an **exact-match** domain
(feature-toggles) genuinely withholds a clear.

A flat checkbox list renders those identically. This file's own history is a catalogue
of exactly that failure — ADR 0479's two-register work, and #2557 fixing an aggregate
that said "removed" over a breakdown that said "kept".

### 3. The approval gate would approve something other than what lands

`envPromotion` carries `{ toEnv, fromEnv, snapshotHash }`, and on claim the handler
calls `movePointer({ …snapshotHash })`. A subset chosen **before** approval is not in
that payload, so either the subset is lost on claim (the approver's decision is
executed as a *full* promotion) or it is carried out-of-band (the approver signed off on
a description that omits the most important part). Both are worse than today.

## Options

### Option A — pointer + a `promotedDomains` list on the environment

Store which domains the pointer is authoritative for.

*Rejected.* It makes `currentSnapshot` conditionally meaningful, and every reader
(drift, rollback, ledger, the UI) must now consult a second field to know what the first
one means. That is a new invariant for every existing consumer to get right, forever.

### Option B — mint a DERIVED snapshot for the result (recommended)

Compose the target's current domains with the selected domains from the source, hash the
result, and promote **that**:

```
derived.domains = { ...targetSnapshot.domains, ...pick(sourceSnapshot.domains, selected) }
derived.hash    = hashDomains(derived.domains)   // reuses an existing record on match
```

Every invariant survives untouched: the pointer names real content, drift stays a hash
comparison, rollback re-pins a real snapshot, and the ledger row names what landed.

It also **falls out of the existing design rather than fighting it** — snapshots are
already content-addressed and `snapshotLive` already dedupes by hash, so a derived
snapshot that happens to equal an existing one costs nothing and creates no duplicate.

Costs, stated:

- **Snapshot count grows.** Subset promotions mint records full promotions would not.
  `PROMOTION_LEDGER_CAP` bounds the *ledger*, not snapshots — a retention rule for
  derived snapshots is part of this work, not a follow-up.
- **`sourceEnv` becomes ambiguous.** A derived snapshot descends from two. It needs an
  honest provenance field rather than a misleading single parent.

### Option C — leave it whole-snapshot only

*Not absurd.* The value-level preview (#2571) already closed the visibility gap, and
"promote everything you previewed" is a defensible product stance — it is what makes an
environment pointer mean something. If the reviewer's read is that subsetting buys less
than the invariants it costs, **that is a legitimate outcome of this ADR** and I would
rather it be chosen deliberately than avoided by inaction.

## Recommendation

**Option B**, with three conditions that are part of the work, not deferrals:

1. **The UI groups by restore register**, with apply-only domains labelled so that
   excluding one reads honestly. Not a flat checkbox list.
2. **The approval payload carries the selection.** `envPromotion` gains the selected
   domain ids (or the derived hash, computed pre-approval), so the approver approves the
   thing that lands. Without this, do not ship.
3. **A derived-snapshot retention rule** lands with it.

## Open questions for the reviewer

1. Is subsetting worth the derived-snapshot machinery, or is **Option C** the better
   product answer? I lean B but hold this loosely.
2. Should a subset promotion be **blocked entirely** when the target is `protected` or
   under the H2 gate — i.e. is "promote everything or nothing" the right rule for the
   surfaces that matter most?
3. Should the derived snapshot be minted at **preview** time (so the approver sees a
   real hash) or at **promote** time? Minting at preview is cleaner for the gate but
   creates records for promotions that never happen.

## Consequences if adopted

Additive to the wire in no way — `/v1/host/openwop-app/environments/*` is a
host-extension surface, **non-normative, no RFC** (CLAUDE.md). The change is entirely
host behaviour plus UI.

**Not implemented.** No code accompanies this ADR by design: the point is to find the
holes before the code exists, on a path where a wrong answer moves production config.
