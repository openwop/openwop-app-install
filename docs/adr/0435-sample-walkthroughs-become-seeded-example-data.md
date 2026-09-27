# ADR 0435 — Sample walkthroughs become seeded example data (not builtins)

Status: **implemented** (2026-07-19; record below)

**Requirements source:** operator report — `/walkthroughs` shows a "Sample walkthroughs" section whose cards can be neither edited nor deleted, and nothing on `/example-data` accounts for them.
**Depends on:** ADR 0368 (the walkthrough engine), ADR 0376 (the tour→walkthrough rename + the legacy-id alias), ADR 0378 P4 (the chat walkthrough + the funnel), ADR 0163 R1 (per-tenant workflow ownership over the global registry).
**Surface:** host-extension + SPA. **NO new RFC** — nothing here touches the wire.

## Why this exists

Every other demo surface in this app follows one contract: demo content is
**seeded**, listed on `/example-data`, idempotent, and clearable. The two sample
walkthroughs broke that contract in both directions.

They were registered as **builtin workflow definitions** (`walkthroughsFeature.builtinWorkflows`)
and rendered from a hard-coded `SAMPLE_TOURS` array in `WalkthroughsPage.tsx`
with a Play button and nothing else. Because a builtin is host-owned rather than
tenant-owned:

- the cards had **no builder link and no remove verb** — a tenant could not edit
  the steps or get rid of the section;
- the content **arrived unasked** — a tenant that deliberately seeded nothing
  still saw a populated "Sample walkthroughs" shelf;
- `/example-data` **could not account for them**, and `seedCoverage.ts` carried an
  acknowledgement claiming walkthroughs had "no tenant demo entity to seed" —
  which was true of the *engine* but false of these two artifacts.

## Boundaries audit (verified against live code)

- **Ownership is the mechanism, not a new one.** "Appears in Your walkthroughs,
  opens in the builder, can be removed" is exactly what `workflowOwnership.ts`
  (ADR 0163 R1) already confers. The seeder records ownership; it invents no
  second listing path and no walkthrough-specific store.
- **The global registry stays the resolver.** The seeder registers the shared
  by-id definition (register-if-missing, the `seedWorkflows.ts` /
  `workflowAuthorSeed.ts` pattern) so run / `:fork` / replay resolve as before.
- **Not every walkthrough is sample content.** The ~25 one-step *page-spotlight*
  walkthroughs are **test infrastructure** — `features/manual-tests/suites.ts`
  launches them by id per P0 render case. They must resolve for every tenant
  whether or not it seeded, so they REMAIN builtins. Only the two sample tours move.
- **Ids are unchanged.** `walkthrough.campaign-studio.first-brief` and
  `walkthrough.chat.first-message` keep their ids, so the existing referrers keep
  resolving once seeded: the `connect-your-ai` + `campaign-studio-first-brief`
  tutorials, manual test CHAT-01, and the `walkthrough-replay` e2e.

## Decision

1. **Definitions move** from `features/walkthroughs/feature.ts` into
   `host/demoWalkthroughsSeed.ts`, which owns `count` / `seed` / `clear`.
   Id constants move to a new LEAF module `features/walkthroughs/walkthroughIds.ts`
   so the host seeder and the feature share them with no host↔feature import cycle.
2. **A `demo-walkthroughs` step** joins `EXAMPLE_DATA_SEEDERS`. Seeding registers
   the def (if absent) and records per-tenant ownership; clearing drops ownership
   and removes the global def **only once no tenant owns it** (another tenant's
   copy and its run history must survive).
3. **The frontend sample shelf is deleted.** Seeded walkthroughs arrive in the
   ordinary owned list with Review / Play — plus a **Remove** verb (archive: the
   workflows dashboard's own lifecycle, reversible, and it preserves the run
   history the funnel reads). The empty state names one next action: load them
   from `/example-data`.
4. **`walkthroughs` joins `DEMO_FEATURE_TOGGLE_IDS`** and its
   `ACKNOWLEDGED_UNSEEDED` entry is removed — the coverage projection now tells
   the truth.

### Trade-off accepted: replay of pre-existing sample runs

A builtin resolves for every tenant forever; a seeded def resolves once **some**
tenant has seeded it. So on a host where no tenant has run the
`demo-walkthroughs` step, `:fork`/replay of a *historical* run of one of the two
sample walkthroughs returns `workflow_not_found` until it is seeded.

Accepted deliberately: `walkthroughs` is a default-OFF toggle, these are demo
artifacts, seeding restores resolution exactly, and the alternative (keeping them
builtin) is precisely the undeletability being fixed. The **pre-rename legacy
alias** (`tour.campaign-studio.first-brief`, ADR 0376) is a different case and
**stays a builtin** — it exists only so pre-rename runs replay, and it is filtered
out of every user-facing listing.

## Alternatives weighed

- **Keep the builtins, add edit/delete affordances.** Rejected: a tenant cannot
  own a host definition, so "delete" would have to mean per-tenant hiding — a
  second, walkthrough-only visibility model layered over ownership.
- **Seed under NEW ids and leave the builtins in place.** Rejected: the samples
  would still ship unasked (just invisibly), and the tutorial/manual-test
  referrers would then point at the un-editable copy — the same bug, hidden.
- **Delete the samples outright.** Rejected: they are the reference content four
  other surfaces launch, and a first-time visitor should still be able to load them.

## Implementation record

| Piece | Where |
| --- | --- |
| Sample definitions + count/seed/clear | `backend/typescript/src/host/demoWalkthroughsSeed.ts` (new) |
| Shared id constants (leaf, cycle-free) | `backend/typescript/src/features/walkthroughs/walkthroughIds.ts` (new) |
| Samples dropped from `builtinWorkflows`; legacy alias retained | `backend/typescript/src/features/walkthroughs/feature.ts` |
| `demo-walkthroughs` registry step | `backend/typescript/src/host/exampleDataSeeders.ts` |
| Coverage projection tells the truth | `seedCoverage.ts` (ack removed) + `demoProvision.ts` (toggle added) |
| Sample shelf removed; Remove verb + seeded empty state | `frontend/react/src/walkthroughs/WalkthroughsPage.tsx` + `i18n/{en,es,fr,pt-BR}.ts` |
| Tests | `backend/typescript/test/demo-walkthroughs-seed.test.ts` (new); `walkthroughs-coverage.test.ts` retargeted |

## Open questions

- Should `clear` also archive a tenant's *edited* copy of a seeded walkthrough,
  or leave edits behind as user-authored content? Current behaviour: ownership is
  dropped (so it leaves the list) but an edited global definition is preserved if
  any other tenant still owns it. Revisit if operators report surprise.
