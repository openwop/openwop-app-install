# Architecture Decision Records — index & number registry

ADRs live here as `NNNN-<kebab-slug>.md`, numbered sequentially. Each opens with a
`Status:` line (`Proposed` → `Accepted` → `implemented`, or `Superseded by NNNN`).
Per the project's ADR rule (`CLAUDE.md` §"Tracking architectural changes"), we
**correct, don't rewrite history** — so where parallel sessions reused a number, we
**record the collision here** rather than renumber implemented, widely-referenced
ADRs (which would churn dozens of in-code `ADR NNNN` citations and re-attribute them
incorrectly across two unrelated decisions).

## ⚠️ Next free ADR number: derive it, never read it

This heading used to hard-code a number; it rotted **175 numbers stale** (it said
`0198` while `origin/main` was at `0372`), which is precisely the collision this
registry exists to prevent. Always derive it:

```
git fetch && git ls-tree -r --name-only origin/main -- docs/adr/ | grep -oE '0[0-9]{3}' | sort -u | tail -1
```

Before authoring a new ADR, claim the next free number by checking
`git fetch` then `git ls-tree -r --name-only origin/main -- docs/adr/ | grep -oE '0[0-9]{3}' | sort -u | tail -1`
and incrementing — check **`origin/main`, not a stale local `main`**. The duplicates
below happened because parallel sessions each grabbed the same "next" number off a
stale local checkout. Note that a fresh `origin/main` is **necessary but not
sufficient**: two sessions that both fetch, both read the same highest number, and
both write within the same hour will still collide (`0250` collided 2 minutes apart,
`0434` one minute apart). Nothing here reserves a number — `npm run ci` is the
backstop that catches the loser before merge. (In use up to `0197` as of 2026-07-03: `0166`–`0197` filled in
by subsequent work — notably `0194` feature-dependency-graph-and-lifecycle,
`0196` enterprise-posture-showcase-and-developer-tools-gating, `0197`
schema-driven-run-input-forms.)

## Duplicate-number registry

Fifteen numbers remain reused by parallel sessions (one of them — 0208 — three ways).

> **Enforced since 2026-07-26.** This registry is no longer prose-only:
> `scripts/check-adr-refs.mjs` (wired into `npm run ci`) fails on any duplicate slot
> that is not in its `KNOWN_DUPLICATES` baseline, and *also* fails if a baselined slot
> gets resolved without being pruned from the list. Keep the two in sync.
>
> This section had drifted in **both** directions before the check existed — it listed
> `0101` (long since resolved) and omitted seven live duplicates. A register that only
> a human updates describes the past, not the tree; the dangling-ref scan above never
> caught them because with two files present an `ADR NNNN` citation still *resolves* —
> just ambiguously, to two unrelated decisions.
Both files under each are retained (renumbering would rewrite history + break
in-code references each).

> **The one slot resolved by RENUMBERING, and why (0519, 2026-08-05).**
> `0519` was claimed by `forms-is-a-standard-collection-page` (2026-08-03, canonical)
> and `builder-round-trip-preserves-the-node-contract` (2026-08-04). The later one was
> renumbered to **0523** rather than recorded here, so `0519` is NOT in the table above.
>
> That was a deviation from the rule at the top of this file, and it happened because
> `scripts/check-adr-refs.mjs` used to print *"renumber the later one"* with no
> qualification — the gate and this README disagreed, and the gate is what a red build
> puts in front of you. The message now names both paths and the discriminator
> (open PR → renumber; merged + referenced → record here).
>
> It was left renumbered rather than churned back because the collider was **one day
> old with 12 citations, all in one feature area, all updated and verified by subject**
> — not the "implemented, widely-referenced" case this rule protects. Treat it as the
> narrow exception, not the precedent: **for anything older or more widely cited,
> record it above.**
The **canonical owner** is the earlier-created ADR (first-come); the **collider** is
the later one. In-code `ADR NNNN` comments may refer to *either* — read the
surrounding context (the topics are unrelated, so it's unambiguous in practice).

| # | Canonical owner (first-created) | Collider (later) | Notes |
|---|---|---|---|
| **0027** | `connected-content-source-trust` (2026-06-11) | `cms-front-page-and-always-on-content` (2026-06-12) | Both implemented. Refs: taint/untrusted-content vs site-config/front-page. |
| **0079** | `streaming-llm-interactions` (2026-06-19 19:21) | `strategic-planning` (2026-06-19, merged later) | Both implemented. Refs: SSE/streaming posture vs strategy portfolio. |
| **0102** | `chat-history-persistence-and-authorship` (2026-06-22 01:16) | `per-tool-permission-enforcement` (2026-06-22 02:00) | Both implemented. |
| **0178** | `ucp-universal-commerce-protocol` (2026-07-01 11:29) | `byok-llm-spend-governance` (2026-07-01 11:44) | Both implemented. Refs: UCP commerce server vs BYOK spend-governance. |
| **0188** | `ucp-buyer-client` (2026-07-02 13:18) | `first-run-vendor-setup` (2026-07-02 13:37) | Canonical is **Proposed** (zero code); collider implemented. Refs: UCP outbound buyer vs first-run vendor setup. |
| **0195** | `message-affordances-conversation-primitive` (2026-07-02 23:05) | `fail-closed-production-posture` (2026-07-03 00:39) | Both Accepted (posture work shipped via #1139). Refs: chat message affordances vs enterprise-posture hardening (the "ADR 0195 enterprise posture" shorthand means the collider). |
| **0200** | `feature-chain-consolidation` (2026-07-03 08:19) | `data-ops-templates` (2026-07-03 11:27) | Both implemented. Refs: hub-console consolidation vs data-ops workflow templates. |
| **0208** | `edge-condition-control-flow` (2026-07-03 12:45) | `crm-orchestration-wiring` (2026-07-03 12:48) | Both implemented. Refs: engine edge conditions vs CRM events/`emitHostEvent` (the "ADR 0208 host event dispatcher" shorthand means the collider). A third claimant, `channel-activity-notifications`, was renumbered 0208→0214 while still fresh (#1198) per the open-PR rule. |
| **0229** | `planning-surfaces-on-by-default` (2026-07-03 15:25) | `campaign-creative-asset-operations` (2026-07-03 16:31) | Both implemented. Refs: the "floor not lock" toggle doctrine vs campaign creative assets. |
| **0250** | `deferred-parameter-mode` (2026-07-04 08:38) | `commerce-carrier-rates-and-multi-provider-tax` (2026-07-04 08:40) | Both implemented — **2 minutes apart**. Refs: RFC 0124 deferred params vs carrier rates/tax. |
| **0292** | `resilient-example-data-seeding` (2026-07-06 17:37) | `cdp-d-warehouse-reverse-etl-write` (2026-07-06 17:45) | Both implemented. Refs: seeding resilience vs CDP reverse-ETL. |
| **0419** | `kicktodo-accountability` (2026-07-18 20:40) | `paid-feature-bundles` (2026-07-18 21:36) | Both implemented. Refs: KickTodo accountability vs the priced-bundle paywall (the "ADR 0419 §Correction" shorthand means the collider). |
| **0434** | `identity-sync-honesty` (2026-07-19 11:10) | `graduate-substrate-toggles` (2026-07-19 11:11) | Both implemented — **1 minute apart**. Refs: identity sync-honesty vs the four graduated substrate toggles. |
| **0490** | `user-facing-tutorials` (2026-07-25 11:46) | `lazy-feature-i18n-namespaces` (2026-07-25 14:52) | Both implemented. The canonical file had **itself** been renumbered off a duplicate `0303` earlier that day — straight into a fresh collision three hours later. The clearest evidence that "take the next free number" is only safe when something *keeps* it free. |
| **0493** | `plugin-isolation-self-test` (2026-07-25 16:07) | `fold-profile-into-instructions-and-enforce-guardrails` (2026-07-25 17:59) | Both implemented. The collider is the **former 0101 collider**, renumbered out of that slot and into this one — which is why `0101` no longer appears above. A renumber that resolves one duplicate can create another. |
| **0688** | `persist-codemap-types-not-vendor-names` (2026-09-15 11:22) | `prompt-library-visibility-unreachable` (2026-09-15 13:53) | Both implemented, merged ~2h apart (#3835 / #3848). Refs: the event codemap's persisted TYPE vs the prompt-library `visibility` ACL (`PLC-6`/`PLC-7`). Disambiguate by file: `routes/interrupts.ts` + the v2-era2 test cite the canonical; `features/prompts/**` + `features/portability/**` cite the collider. |
| **0739** | `rfc0158-durability-kill-seam-and-supervised-lane` (2026-09-20 22:29) | `canvas-workbench-layout` (2026-09-21 07:22) | Both implemented and merged ~9h apart (#4065 / `1d60fbcef`), by two sessions that each reserved from a ref list the other's branch was not yet on. Refs: the RFC 0158 kill/bound conformance seam (`routes/durabilitySeam.ts`, `conformance/durabilityLane.ts`, `WHD-5`/`WHD-12`, and cited from the `openwop` corpus's RFC 0158 note) vs the shared `<CanvasWorkbench>` layout (`src/canvas/CanvasWorkbench.tsx`, `DESIGN.md`, the app-builder assessments). A bare `ADR 0739` in **backend/conformance** code means the canonical; in **canvas/frontend/DESIGN** it means the collider. |

These predate/accompany the recent parallel-session activity and have coexisted
harmlessly because the slugs disambiguate. They are documented here for honesty; they
are intentionally **not** renumbered (the churn / mis-attribution risk on implemented,
heavily-referenced ADRs — where a bare `ADR NNNN` grep can't tell the two decisions
apart — outweighs the cosmetic benefit). Renumbering is only worthwhile for a collider
still in an **open PR** (not yet merged / referenced), as with `0155`/`0156`/`0162` — see below.

## Recently reconciled

- **0155 → 0163** (`workflow-pack-templates`) and **0156 → 0164**
  (`model-selector-parity-across-chat-surfaces`) — the two standalones that had
  collided with the Campaign Studio suite were renumbered to the next free slots
  (`0161`/`0162` were already taken by `campaign-orchestration-canvas` /
  `campaign-studio-publish-last-mile`, so the standalones landed at `0163`/`0164`; 46 + 12 in-code
  `ADR NNNN` citations updated, surgically — campaign/brand refs untouched), leaving
  **Campaign Studio its intact `0155–0160` block**. `0155` now belongs solely to
  `campaign-studio-brand-guardrails`, `0156` solely to `campaign-studio-personas-brief`.
- **0162 → 0165** (`rfc-0118-parallel-fan-out-witness`) — created first (2026-06-28 09:33,
  #984), but `campaign-studio-publish-last-mile` (#995, 11:26) later collided on `0162`. Rather
  than disturb the merged, sibling-referenced Campaign Studio `0155–0162` block, the lower-churn
  standalone (still in open PR #994) was renumbered to the next free slot `0165`; its ~7 in-code/
  doc `ADR 0162` citations were updated surgically (campaign refs untouched). `0162` now belongs
  solely to `campaign-studio-publish-last-mile`.
- **0150 → 0152** (`workflow-chain-pack-loader`) — its number was reconciled in an
  earlier sweep, but the file's title heading, `Status:` line, and in-code `ADR 0150`
  citations (`workflowChainPackLoader.ts`, `index.ts`, the loader test) were left
  stale at `0150`. Fixed: heading + refs now read `0152`, and the status is corrected
  `Accepted → implemented` (the loader + install route + tests landed via
  #960/#967/#974). The permission-mode ADR is the real **0150**.
