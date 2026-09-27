# ADR 0229 — Planning surfaces on by default (strategy · priority-matrix · advisory-board)

Status: Accepted (implemented)
Date: 2026-07-03
Relates to: ADR 0079/0080 (Strategic Planning), ADR 0058–0061 (Priority Matrix), ADR 0040 (Board of Advisors), ADR 0191 (the default-flip precedent), docs/research/strategy-gap-analysis.md (Phase A2)

## Context

The executive-planning cluster shipped complete — `strategy` (ADR 0079/0080:
portfolio + OKR-compatible objectives/KRs + links + health rollup + the Strategy
Analyst), `priority-matrix` (ADR 0058–0061: weighted scoring, multi-voter,
portfolio + federation), `advisory-board` (ADR 0040) — and a composed
**showcase seeder** (`host/strategyShowcaseSeed.ts`, registered in
`EXAMPLE_DATA_SEEDERS`) that builds one coherent fictional company across all
three: scored priority lists, strategies linked to those priorities, and a
board carrying the strategies as context.

All three toggles shipped `status:'off'` (each "a brand-new product surface" at
the time — the correct initial policy, same as ADR 0191 records for `crm` /
`analytics`). But the seeder is deliberately **all-or-nothing** (`gatesOpen()`
requires all three toggles; the cross-references only line up as a set), so on
every default install — including the public demo — the showcase **silently
skips** (`skipped:'toggle-off'`) and the app's entire executive-planning story
is invisible. The strategy gap analysis (2026-07-03) grades this drift E1:
"a shipped flagship the demo hides."

This is the exact failure class ADR 0191 resolved for the lighthouse templates:
a shipped, composed artifact that fails/no-ops out of the box is a broken
first-run, and the fix is the compiled default, not per-install ceremony.

## Decision

Flip `toggleDefault.status` from `'off'` → `'on'` for **`strategy`**,
**`priority-matrix`**, and **`advisory-board`** (all three — a partial flip
would spend the default-posture cost while the all-or-nothing showcase still
skips). Their `toggleDefault.description` strings and the FEATURES.md rows
update in lockstep ("ON by default").

Unchanged, deliberately:

- **Operator override stays the authority** (ADR 0191 §same): the default is a
  floor, not a lock — a super-admin can still set any of the three `off` (or
  `beta`) globally or per-tenant from the Feature-toggles admin.
- **RBAC + scope are untouched**: all three surfaces stay org/workspace-scoped
  (`workspace:read/write`), strategy `scope` visibility and private-project
  member gating unchanged. The toggle never was the security boundary.
- **The advisory-board persona policy gates are in-feature, not in the toggle**:
  the simulated-persona disclaimer and the living-individual acknowledgement
  bind at board creation regardless of toggle default. Availability ≠ policy.
- **Seeding stays explicit/non-destructive**: nothing auto-seeds outside demo
  mode (`OPENWOP_DEMO_MODE`) or the user-triggered `/demo-data` dashboard; this
  ADR only removes the silent-skip.

## Alternatives weighed

1. **Leave all OFF, document demo-ops activation** — keeps the clean-install
   posture but leaves the broken first-run (the gap analysis's E1 finding) and
   makes the showcase's silent skip a permanent trap. Rejected.
2. **Flip only `strategy` + `priority-matrix`** — dominated: erodes the
   default-off posture *and* the showcase still skips (all-or-nothing gate).
   Rejected.
3. **Loosen the seeder to partial-seed without the board** — breaks the
   deliberate all-or-nothing invariant (dangling contextRefs / links that don't
   line up), trading a config default for a data-integrity risk. Rejected.

## Consequences

- Fresh installs and the demo get the planning cluster in nav; "Load demo
  data" (and demo-mode boot seeding) now actually seeds the strategy showcase.
- White-label installs that want a leaner surface set one-line overrides —
  the same posture every other ON-default feature (crm, analytics, brand)
  already carries.
- This is a host-config decision (a compiled default), **not a wire change —
  no RFC** (ADR 0191 precedent).

## Verification

- `resolveOne('strategy'|'priority-matrix'|'advisory-board', …)` with no stored
  config resolves enabled; existing toggle tests extended.
- `strategyShowcaseSeed` on a fresh demo tenant returns `created > 0` (not
  `skipped:'toggle-off'`).
