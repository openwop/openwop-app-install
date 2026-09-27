# ADR 0461 — Studio embeds the Challenge Author chat (EmbeddedChatPanel + honest workflow portfolio)

Status: implemented (P1+P2 #2328, P3 candidate embed #2349, OQ1 trust cue #2357; status advanced from "Accepted (implemented with this ADR)" in the 2026-07-22 cleanup — every phase shipped)

## 1. Why this exists

ADR 0458 made the ONE chat the challenge-authoring interface and demolished the
Studio's bespoke intake form — but the Studio still reaches the chat only by
**navigating away** (`/?agent=feature.kicktodo.agents.challenge-author`). A
creator lands on `/kicktodo/studio`, is told "the chat is the interface," and is
then sent to a different surface to use it. This ADR completes 0458's intent:
the Challenge Author conversation is embedded **in place** on the Studio index,
pre-scoped to the agent, with a creator-specific welcome screen that shows the
workflows the agent actually has (its roster portfolio) — read from the same
rows the ignition path uses, so the welcome can never claim a capability the
agent does not hold.

## 2. Decision

Composition of two accepted decisions — no new architecture:

- **ADR 0073 `chat/EmbeddedChatPanel`** is the embed (BYOK gate + agent scoping
  + ephemeral session owned by the panel). `chat/` does not import
  `kicktodo-studio/`, so the Studio **static-imports** it (the commerce
  precedent; only `builder/` must lazy-import). The panel is scoped to
  `feature.kicktodo.agents.challenge-author` — the same id the deep-link used.
  The deep-link survives as an "open in full chat" escape hatch (continuity +
  a durable-thread option).
- **The `renderEmptyState` slot** carries the creator welcome
  (`ChallengeAuthorWelcome`, modeled on `builder/WorkflowAuthorWelcome`):
  what the Author does, example intents that seed real turns via `onPick`, and
  the agent's **workflow portfolio**.
- **The portfolio is the roster truth** (RFC 0086 `workflows[]`, assigned at
  provisioning by `challengeAuthorService.ts`). A new creator-gated read —
  `GET /v1/host/openwop-app/kicktodo/creator/author` — awaits the idempotent
  `ensureChallengeAuthor(tenantId)` (so a fresh tenant is provisioned eagerly,
  not on first factory run) and returns `{ agentId, rosterId, label,
  workflows: [{ workflowId, available, nodeCount }] }`, with `available`
  verified against the live workflow catalog (builtins resolve there).

### What was deliberately rejected

- **`listWorkflowSummaries` as the portfolio source** — that route returns only
  tenant-OWNED workflows; the challenge-factory is a host builtin with no
  ownership row, so the list would be dishonestly empty.
- **The ADR 0104 allowlist read** for the welcome — superadmin-only; wrong
  altitude for a creator surface. The roster portfolio is the non-privileged
  truth.
- **A second chat surface / bespoke composer** — forbidden (CLAUDE.md "one AI
  chat"); `EmbeddedChatPanel` IS the sanctioned mechanism.
- **Hardcoding the workflow list in the SPA** — it must come from the roster
  row so an operator who edits the portfolio sees the welcome change with it.

## 3. Invariants preserved

- **Authz**: route rides the shared `requireKicktodoManage` gate (route + agent
  tools share the predicate); both agent tools re-check it server-side, so the
  embed adds no new reach. Route/nav stay behind the `kicktodo-creator` toggle.
- **No new model-facing exchange lane**: same agent, same two allowlisted tools
  (`openwop:kicktodo.candidates`, `openwop:kicktodo.factory.run`); no
  LLM-EXCHANGE-AUDIT row. The author read is app→human.
- **No wire change**: roster `workflows[]`, the builtin registry, and
  `/v1/host/openwop-app/*` host-extension routes are existing surface — no RFC.
- **Ephemeral embed honesty** (ADR 0073): the embedded conversation is
  task-scoped and unpersisted; the welcome footnote says so. Runs, candidates,
  approvals, and the outline canvas remain the durable record regardless.

## 4. Phases

| Phase | Scope | Status |
|---|---|---|
| P1 | Backend author read: `GET …/kicktodo/creator/author` (gate → await `ensureChallengeAuthor` → catalog-verified portfolio) + route tests | implemented with this ADR |
| P2 | Frontend: Studio intake section becomes the embedded panel + `ChallengeAuthorWelcome` (portfolio cards, example intents, i18n ×4); pinned demolition test updated | implemented with this ADR |
| P3 | Candidate-scoped embed on the candidate workspace (seeded with the candidate context) | implemented (2026-07-21, second pass) — see §6 |

## 5. Open questions

- OQ1: ~~should the welcome surface the Author's autonomy level (`review`) as a
  trust cue? Deferred until the agent-profile read has a non-admin projection.~~
  **Resolved (2026-07-21, residue batch): yes.** The `/creator/author` read now
  carries `autonomyLevel` — no new projection was needed; the provisioning
  saga's return already held the roster truth. The welcome maps ALL KNOWN levels
  to localized copy (`review`/`guided`/`auto` — the cue must not vanish when
  an operator RAISES autonomy) and renders nothing for unknown values (a raw
  enum in a chip is the KTUX-9 defect).

## 6. P3 implementation record (2026-07-21)

The candidate workspace's "Drive with AI" section embeds the same
`EmbeddedChatPanel`, **collapsed by default** (the page is a dense provenance
shell; the chat stack mounts only when the `aria-expanded` toggle opens it —
a `<details>` wrapper would have mounted it on every view). The full-chat
deep-link stays beside the toggle as the durable-thread escape hatch.

Candidate context rides the **visible seeded turn**: `CandidateChatWelcome`'s
example intents interpolate the candidate id + topic verbatim, and the id is
shown in the mono provenance register before any click — one scoping mechanism
(the pack persona), no hidden system-prompt injection (architect-review
decision; the alternatives — `?conversation=` persistence, per-candidate agent
instances, envelope injection — were each rejected as a second mechanism).
No portfolio fetch here: the workflow portfolio lives on the Studio index
welcome; this welcome is candidate-focused. No new backend, no new toggle, no
LLM-EXCHANGE row (same agent, same two tools).
