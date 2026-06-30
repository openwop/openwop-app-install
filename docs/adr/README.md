# Architecture Decision Records — index & number registry

ADRs live here as `NNNN-<kebab-slug>.md`, numbered sequentially. Each opens with a
`Status:` line (`Proposed` → `Accepted` → `implemented`, or `Superseded by NNNN`).
Per the project's ADR rule (`CLAUDE.md` §"Tracking architectural changes"), we
**correct, don't rewrite history** — so where parallel sessions reused a number, we
**record the collision here** rather than renumber implemented, widely-referenced
ADRs (which would churn dozens of in-code `ADR NNNN` citations and re-attribute them
incorrectly across two unrelated decisions).

## ⚠️ Next free ADR number: **0165**

Before authoring a new ADR, claim the next free number by checking
`ls docs/adr/ | grep -oE '^[0-9]{4}' | sort -u | tail -1` and incrementing. The
duplicates below happened because parallel sessions each grabbed the same "next"
number off a stale local `main` — always `git fetch` first. (In use up to `0165`:
the Campaign Studio suite `0155–0160`, then `0161` campaign-orchestration-canvas,
`0162` campaign-studio-publish-last-mile, the renumbered standalones `0163`/`0164`,
and `0165` rfc-0118-witness.)

## Duplicate-number registry

Four numbers remain reused by older parallel sessions. Both files under each are
retained (renumbering would rewrite history + break 25–52 in-code references each).
The **canonical owner** is the earlier-created ADR (first-come); the **collider** is
the later one. In-code `ADR NNNN` comments may refer to *either* — read the
surrounding context (the topics are unrelated, so it's unambiguous in practice).

| # | Canonical owner (first-created) | Collider (later) | Notes |
|---|---|---|---|
| **0027** | `connected-content-source-trust` (2026-06-11) | `cms-front-page-and-always-on-content` (2026-06-12) | Both implemented. Refs: taint/untrusted-content vs site-config/front-page. |
| **0079** | `streaming-llm-interactions` (2026-06-19 19:21) | `strategic-planning` (2026-06-19, merged later) | Both implemented. Refs: SSE/streaming posture vs strategy portfolio. |
| **0101** | `provider-native-web-search` (2026-06-22 01:04) | `fold-profile-into-instructions-and-enforce-guardrails` (2026-06-22 02:00) | Both implemented. |
| **0102** | `chat-history-persistence-and-authorship` (2026-06-22 01:16) | `per-tool-permission-enforcement` (2026-06-22 02:00) | Both implemented. |

These four predate the recent parallel-session activity and have coexisted harmlessly
because the slugs disambiguate. They are documented here for honesty; they are
intentionally **not** renumbered (the churn / mis-attribution risk on implemented,
heavily-referenced ADRs outweighs the cosmetic benefit). The `0155`/`0156` collisions
were resolved by a physical renumber — see below.

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
