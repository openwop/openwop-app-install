# ADR 1143 — Chain templates in the chat `/` picker

Status: Accepted (2026-11-16; the user's go to write and build, CC-PICK-1). Implementation: #6067 (all phases).

Extends ADR 0163 (workflow pack templates) and ADR 0764 (chat run awareness). Host extension only.

## Context

Campaign Studio acceptance (ledger row CC-PICK-1) found that campaign chains never appear in the chat
`/` picker until the workspace has a copy. The picker reads three sources: the demo sample, the tenant
ownership index (`GET /host/openwop-app/workflows`), and localStorage drafts
(`frontend/react/src/chat/lib/workflowMentions.ts:79-90`). `SlashAutocomplete.tsx` renders two groups,
Commands and Workflows. The chain catalog (`GET /host/openwop-app/workflow-chains`,
`routes/workflows.ts:1075-1113`) is read only by the builder gallery.

**The mechanism is correct.** A run must dispatch a registered workflow the tenant owns. The ownership
index is what makes a workflow visible, editable and safe from cross-tenant reads (IDOR), and a chain id
has no owned definition to run. **What isn't by design is that the user can't tell the template
exists.** No ADR says the picker must hide templates. ADR 0163's zero-config preload already
pre-instantiates templates that need no input. Campaign chains need input, so they stay in the gallery
only.

Constraints:
1. `/` only ever dispatches an owned, frozen definition (the chains-or-stacks doctrine and replay determinism).
2. `from-chain` mints a fresh workflow id on every call (ADR 0163 R2), so instantiating on every pick would pile up duplicates.
3. Required inputs, missing connections and packs, pin gaps and the client picker are collected in one place: `TemplatePreflightModal`.
4. A member without workflow-write must not be offered a pick that ends in a 403.

## Decision

### D1 — A "Templates" group, shown only when the typed query matches

When the typed query matches chain templates, the `/` picker shows a third group, **Templates**, after
Commands and Workflows. It shows at most three rows plus a **Browse all templates…** row. A bare `/`
shows no template rows. The source is the existing chain catalog, cached like the mention cache and
warmed when the picker opens. A row is offered only when:
- the chain is not internal or retired (the server already filters these);
- every feature in its `requirements.requiredFeatures` is enabled for the caller;
- the caller holds workflow-write. Otherwise the row is shown disabled with "Ask an admin to add this template".

### D2 — Picking a template opens the shared preflight; it never runs

A pick opens the shared `TemplatePreflightModal` as an overlay over the chat. It is lazy-imported so the
builder stays out of the chat entry chunk (the same import rule as `EmbeddedChatPanel`). **Browse all…**
opens the shared `TemplateGalleryDialog`. On confirm, the modal calls the existing `instantiateChain`
(`builder/persistence/backendStore.ts:450`). There is no new instantiate path, and ADR 0959 P0's single
instantiate path holds.

After instantiation the chat refreshes the mention cache and inserts `/<new-slug> ` into the composer.
The existing `SlashInputsPanel` collects run inputs, and the user presses Enter. The existing
`fromChainNotices` show in the chat, so incomplete nodes and pin gaps stay visible.

**Invariant (test-pinned): the chat never dispatches a run against a chain id.** A template row's apply
action is an "open preflight" intent, never a run.

### D3 — `fromChainId` on the ownership summary, so a pick doesn't duplicate

The host-extension workflow summary gains an optional `fromChainId`. `instantiateOwnedChain` already
knows the chain, and `metadata.expandedFrom` records it. When the caller already owns an instance, the
template row is replaced by the owned row, which carries a muted "From template" chip. The preflight
keeps an "Add another copy" secondary action, so R2's mint-per-call behaviour is unchanged when someone
really wants a second copy.

## Alternatives weighed

- **Status quo plus a "Browse templates…" pointer:** cheap, but typing "campaign" still answers "no match". Kept as the fallback if product decides discovery is agent-first.
- **Instantiate on pick and run** (the issue's proposal): mints a duplicate every pick, skips the preflight (inputs, connections, client), and adds a second instantiate path. Rejected.
- **Run a chain id directly as a transient definition:** a second run model with no owned id. It breaks `/runs`, builder links, IDOR guards and replay on pack upgrades. Rejected.
- **Pre-instantiate every chain for every tenant:** floods "Your workflows" with unconfigured copies and blank frozen params (the ADR 0504 failure). Rejected.

## Authorization, replay, wire

- Template names are not tenant data. The catalog route is already authed and host-global.
- Instantiation keeps `requireWorkflowWrite` and the ADR 1132 client resolution. The preflight carries the client picker.
- **Replay:** unaffected. Runs still execute the frozen, owned definition, and templates never enter the run path.
- **RFC verdict:** host extension, no RFC. Every route is under `/host/openwop-app/*`, and `fromChainId` is additive.

## Phases

| Phase | Scope |
|---|---|
| P1 | `fromChainId` on the summary (backend + client type) and a route test |
| P2 | Picker Templates group + catalog cache + capability filter; lazy preflight overlay; insert slug after instantiate; i18n ×4 |
| P3 | Tests: picker grouping, query-only display, disabled-without-write, the never-run-a-chain invariant, dedup by `fromChainId` |

## Open questions

1. Should the Campaign Studio agent also offer "set up this template" as a pack-allowlisted chat-time tool, behind the same human-confirmed preflight? That's a separate, later item.

## Implementation record

| Phase | Where |
|---|---|
| All phases | #6067: code, tests, red witness and `ci:quick` evidence in the PR body |
