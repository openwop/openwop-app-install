# ADR 0708 — A typed artifact fails validation silently, next to a branch that logs

Status: **implemented** (status corrected 2026-09-17 — see § Status correction)

Feature loop 2026-09, iteration 42 — Interactive artifacts (`FEATURES.md` ordinal 210,
ADR 0128/0069/0055). Graded at `origin/main` `025d9a3ab`. Ids continue the 2026-08-27
passes (`IAC-`/`IAU-`).

## Context

Graded **A / A− / A−**, and the code pass calls the isolation *"the strongest
untrusted-content isolation in the app"* — opaque-origin `allow-scripts`-only sandbox
with a no-egress CSP, inert React, strict no-script Mermaid, React-escaped charts. That
holds up: **nothing below is a security finding.**

Both open rows are instances of `CLAUDE.md`'s own AI-exchange non-negotiables — *"invalid
model output is a typed failure, never success-with-empty"* and *"closed-world
validation"* — on a surface that renders model output.

## D1 (`IAC-1`) — the failure is silent, and the neighbouring branch proves it needn't be

`host/runArtifactStore.ts:145`:

```ts
if (!validateArtifact(e.artifactTypeId, e.payload).valid) return null;
```

`null` makes the typed path fail, and the caller falls through to the untyped inline blob.
The *design* is defensible — the comment says "rather than minting a typed artifact that
can't render" — but **nothing is emitted**: not to the model, not to the operator, not to
the logs. A typed emission the model believed in becomes an anonymous blob.

**Two facts make this a defect rather than a preference:**

1. **The same function already logs the sibling failure.** At `:405`, a typed artifact
   that is too large emits `run_artifact_typed_too_large` before returning `null`. Same
   class — "a typed artifact we decline to mint" — one branch observable, one not. The
   file already decided this kind of thing is worth logging.
2. **The errors already exist and are thrown away.** `validateArtifact`
   (`host/artifactTypes.ts:122-127`) returns `errors: string[]`, Ajv messages formatted
   `"<path> <message>"` and capped at 10 — computed on the failing path and discarded by
   the `.valid` check at the call site.

- **D1a** — log `run_artifact_typed_invalid` with `artifactTypeId` and the (already
  computed) `errors`, mirroring `:405`'s shape. The downgrade behaviour is unchanged;
  only its silence is.

## D2 (`IAC-2`) — the schema is open where the renderer is closed

`features/interactive-artifacts/artifactTypes.ts:34` declares
`chartType: { type: 'string' }`, while `ChartRenderer.tsx:66` closes the world to
`SUPPORTED_CHART_TYPES`. Any emitter can persist `chartType: "pie"` as a valid typed
`interactive.chart`.

**Severity downgraded on measurement.** I expected a broken render; the renderer handles
it properly — `if (!chart || !SUPPORTED_CHART_TYPES.includes(...)) return <pre>` shows the
raw spec, inert and React-escaped. **No crash, no XSS.** What is lost is honesty: the
model cannot learn its chart type was unrenderable, and the user gets JSON where a chart
was promised. Improvement, as filed — not inflated.

- **D2a** — put the closed world in the schema (`chartType: { enum: [...] }`), sourced
  from the same constant the renderer uses so the two cannot drift.

## The two are COUPLED — D2 alone makes the outcome worse

This is the part worth recording. Today `chartType:"pie"` persists as a **typed** chart
and renders as raw JSON. With D2 alone it would fail schema validation, hit the `return
null` at `:145`, and become an **untyped blob** — still silent, and now type-less as well.
Strictly worse than before.

D2 only improves things once D1 has made the rejection observable. That is why the prior
pass's "Path to A" names both, and why this ADR ships them together rather than as two
independently-mergeable improvements.

## Deliberately NOT done

- **`IAC-3`** (the interactive types are host-pinned in-tree rather than shipped as a
  `kind:'artifact-type'` pack). The row itself calls the current state
  "doctrine-compliant but not the pack-distribution end-state". It is a distribution
  migration, not a correctness fix, and it is the same *shape* as the ADR 0701/0703
  pin-site drains — which taught (ADR 0703 D4/D5) that moving a definition between
  registries moves every predicate keyed on membership. That deserves its own pass with
  that sweep, not a tail-end change here.
- **`IAU-2`** (no loading/empty affordance on the sandbox frame). Nice-to-have, untouched.

## RFC verdict

**No RFC.** Host-ext throughout: one log line and one schema enum on host-registered
artifact types. No wire shape, no capability advertisement, no conformance claim — the
artifact-type registry is host-side and the schema tightens *within* an already-registered
type.

## Open questions

1. Whether a rejected typed artifact should also surface to the MODEL (a tool-result
   note) rather than only to logs. That is a live AI-exchange design question —
   `LLM-EXCHANGE-AUDIT.md` territory — and larger than this row.

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was **already implemented and
merged**. Evidence: `fb40d56ca` — *a typed artifact failed validation silently, next to a branch that logs*, with `test/artifact-typed-invalid-observable.test.ts` in the tree.

Corrected as part of an ADR-status sweep that found **five** such records (0700, 0701,
0703, 0707, 0708). The failure mode is not cosmetic: `Status:` is the field a planner
reads to pick work, so a stale `Proposed` either sends someone to redo finished work
or tells them a closed defect is still open. `docs/adr/adr-status-not-stale.test.ts`
now fails when an ADR with a merged implementing commit still reads `Proposed`.

Verified per-ADR against the code (`host/runArtifactStore.ts`), not by counting commits — an early pass
of this sweep matched commit BODIES and produced contaminated counts, and ADR 0700's
own citation belongs to a decision that was renumbered away from it.

