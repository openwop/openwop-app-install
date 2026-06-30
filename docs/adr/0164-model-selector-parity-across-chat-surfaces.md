# ADR 0164 — model-selector parity across chat surfaces (+ MiniMax capability-honesty fix)

**Status:** implemented (P1 + P2 + P3) — 2026-06-27. **P3 update (2026-06-27):** un-deferred and shipped, refined to the cleaner *active-provider* scope (not the original "all credentialed providers"): the per-exchange `ModelSwitcher` now takes a `provider` prop and offers **only the configured provider's models** (label drops the redundant prefix), threaded via `useComposerModifiers({ activeProvider: config.provider })` at both call sites; switching provider in the BYOK wizard clears any stale override (`useEffect` on `activeProvider`). An override can no longer select a provider the user has no key for — the footgun is closed, not merely recoverable. Tests: `ModelSwitcher.test.tsx` +2 (scopes to the active provider, drops prefix; renders nothing for a provider with no advertised models). FE-only; build gate + `/code-review` + `/ux-review` clean. Phase→artifact: **P1** `providers/catalog.ts:listSelectableProviderIds()` (`!hidden && !managed`) + `routes/chatSessions.ts` model-capabilities derives from it (was a hard-coded array leaking `minimax`); tests `provider-catalog-selectable` (3) + a `chat-model-capabilities` regression guard (MiniMax/openwop-free absent). **P2** `TabSession.tabComposerModifiers` renders the shared `ConfiguredProviderCard` in the `chathdr-model` zone beside `{modelSwitcher}` (reuse; `config`/`onReconfigureBYOK` already in scope) — restores BYOK/Try-for-free/key-entry parity to each tab. **P3** (scope the override to credentialed providers) deferred — the reported defects are closed by P1+P2; the cross-provider override is now *recoverable* (the now-present "Change" + the `ErrorCard` reconfigure action). Backend tsc + FE build gate clean; `/code-review` + `/ux-review` clean (no hex literals, reuses the shared component + `.chathdr-model` cohesion zone, inherited a11y).
**Toggle:** **NONE — core functionality.** The model selector + BYOK gate are core chat (like ADR 0102/0117/0150). The multi-tab *surface* stays gated by the existing `multi-tab-chat` toggle (ADR 0140); this ADR adds no new toggle.
**Surface:** host-extension only — a backend filter on the existing `/v1/host/openwop-app/chat/model-capabilities` host route + a frontend reuse of the existing `ConfiguredProviderCard` in the multi-tab composer. **No new wire** (see RFC verdict).
**Composes:** the BYOK config hook (`byok/lib/useBYOKConfig.ts`), the BYOK wizard (`byok/BYOKWizard.tsx` — `TryItFreeCard` + provider/model/key stepper), the compact provider card (`byok/ConfiguredProviderCard.tsx`), the per-exchange model switcher (`chat/ModelSwitcher.tsx`, ADR 0124), the providers catalog (`providers/catalog.ts` ← `providers.json`), and the three-surface chat model (ADR 0140 — standalone `ChatSidebar`/`ChatHeader`, tabbed `TabChatDeck`/`TabSession`, embed `EmbeddedChatPanel`).
**Source plan:** a user-reported parity bug — the standalone chat has a well-crafted **button-based** model control (the `ConfiguredProviderCard` "Change" → BYOK wizard with "Try for free" + key entry), but the multi-tab chat ships only the bare per-exchange `ModelSwitcher` dropdown: no key-entry path, and it **exposes the `hidden` MiniMax provider** that should never be user-selectable.

---

## Why this exists

There is ONE model-selection design in this app and it is good: in the standalone chat, the **`ConfiguredProviderCard`** (`ChatHeader.tsx:121-124`) shows the active `provider · model` with a **"Change"** button that opens the **`BYOKWizard`** — the managed **"Try it free"** on-ramp plus the provider→model→**key-entry** stepper. The `ModelSwitcher` `<select>` (ADR 0124) sits *beside* it as a *secondary per-exchange override*.

The multi-tab deck (ADR 0140) shipped with **only the secondary control**: `TabSession.tabComposerModifiers` renders `{modelSwitcher}` and **omits the `ConfiguredProviderCard`** (`TabSession.tsx:214-230`). Two failures result:

1. **No BYOK path in a tab.** A user can pick a model whose provider they have no key for, with no affordance to enter one — the primary gate is simply absent. (`config` + `onReconfigureBYOK` are *already threaded into* `TabSession` at `:57/:85/:99` — the data is in scope, the composer just never renders the card.)
2. **A `hidden` provider leaks into the picker on *every* surface.** The `ModelSwitcher`'s data source — the `/chat/model-capabilities` endpoint — **hard-codes** `['anthropic','openai','google','minimax']` (`chatSessions.ts:235`) and ignores the `hidden`/`managed` flags. `providers.json:67-72` marks `minimax` `hidden: true` precisely because the steward pays for it via the managed `openwop-free` path ("users shouldn't pick MiniMax directly by name"). So `minimax · MiniMax M3` appears in the dropdown. **This is a capability-honesty defect**: the host advertises as user-selectable a provider it intends to keep behind the managed tier.

This is the **three-surface parity rule** (the tabbed deck MUST match the standalone's capabilities) and CLAUDE.md's **"reuse, never recreate"** — the fix renders the *existing* standalone component in the tab composer and consolidates the "user-facing provider" definition onto the *existing* `providers.json` flags.

---

## Boundaries & pre-existing-surface audit (Step 3)

| Check | Finding | Verdict |
|---|---|---|
| **"Visible providers" single source of truth** | TWO encodings of the user-facing set exist: the FE BYOK wizard filters `!p.managed && !p.hidden` (`ProviderGrid.tsx:65` — correct), while the BE `/chat/model-capabilities` hard-codes the array incl. `minimax` (`chatSessions.ts:235` — wrong, ignores flags). | **Consolidate** onto `providers.json` `hidden`/`managed` flags via a catalog helper; delete the hard-coded array. One owner: `providers/catalog.ts`. |
| **Model selector component** | `chat/ModelSwitcher.tsx` is the ONE per-exchange override `<select>`, shared by all surfaces (standalone header + tab composer). | **Compose, don't fork.** No second selector. |
| **BYOK gate component** | `byok/ConfiguredProviderCard.tsx` (compact) is the ONE provider-identity + "Change" control; `byok/BYOKWizard.tsx` is the ONE key-entry flow. | **Reuse verbatim** in the tab composer — `config`/`onReconfigureBYOK` already in `TabSession` scope. |
| **Surface gating** | The multi-tab deck renders behind the SAME `useBYOKConfig` `needsWizard` gate as the standalone (`ChatTab.tsx:74-100` → `TabChatDeck config={config!} onReconfigureBYOK={…}`). | No new gating; `config` is guaranteed valid inside a tab. |
| **Route-prefix collision** | `/v1/host/openwop-app/chat/model-capabilities` is registered once (`chatSessions.ts:233`). | No collision — edit in place. |
| **Capability advertisement honesty** | The endpoint currently advertises `minimax` as selectable; the managed path is the only intended consumer. | The fix **restores honesty** (advertise only the user-selectable BYOK providers). |
| **Replay / fork** | The per-exchange override rides `ConversationResolve` (replay-deterministic, ADR 0124); filtering the *picker* is display-only. An override already stamped on a historical run is read verbatim on `:fork` regardless of current picker contents. | No replay impact. |

**Single owners (compose, don't fork):** the user-facing provider set → `providers/catalog.ts` (from `providers.json` flags); provider identity + "Change" → `ConfiguredProviderCard`; key entry → `BYOKWizard`; per-exchange override → `ModelSwitcher`; BYOK config/`storedRefs` → `useBYOKConfig`.

---

## Decision

Bring the multi-tab model control to **full parity** with the standalone by **reusing the existing components**, and **consolidate the user-facing-provider definition** onto the `providers.json` `hidden`/`managed` flags so no surface can leak a hidden provider.

1. **Honesty (backend, all surfaces).** Add `listSelectableProviderIds()` to `providers/catalog.ts` — `listProviders()` filtered by `!hidden && !managed` (the server-side mirror of `ProviderGrid.tsx:65`). The `/chat/model-capabilities` endpoint derives its provider list from it instead of the hard-coded array. MiniMax (and any future `hidden`/`managed` provider) disappears from the picker everywhere.
2. **Parity (frontend, multi-tab).** Render `<ConfiguredProviderCard config={config} onChange={onReconfigureBYOK} onRemoved={…} compact />` before `{modelSwitcher}` in `TabSession.tabComposerModifiers` — the exact `chathdr-model` composition the standalone uses (`ChatHeader.tsx:121-124`). Each tab gets the active-provider display + "Change" → the BYOK wizard (Try-for-free + key entry).
3. **(Optional, deferred) Footgun removal.** Scope the `ModelSwitcher` override options to providers the user can actually dispatch to — the active config provider + any provider with a stored credential (`useBYOKConfig.storedRefs`) + the managed tier — so a per-exchange override can never select an unusable provider. Applies to both surfaces.

### Data model
**No new entity, no schema change.** P1 is a read-path filter; P2 is component composition; P3 (if taken) reads existing `useBYOKConfig` state. The `credentialRef`/`storedRefs` shapes (ADR 0102 / `useBYOKConfig.ts`) are unchanged.

---

## Phased plan

| Phase | Deliverable | Gate |
|---|---|---|
| **1 — capability honesty (BE)** | `providers/catalog.ts`: `listSelectableProviderIds()` (`!hidden && !managed`). `routes/chatSessions.ts:235`: build the response from it, not the literal array. Unit test: `minimax`/`openwop-free` absent; `anthropic`/`openai`/`google` present. | the model-capabilities response never includes a `hidden`/`managed` provider; both surfaces lose MiniMax. |
| **2 — multi-tab BYOK parity (FE)** | `TabSession.tabComposerModifiers`: render the compact `ConfiguredProviderCard` (reuse) beside `{modelSwitcher}`, wired to the in-scope `config` + `onReconfigureBYOK`. UX: matches the standalone's model zone; tokens/a11y inherited from the shared component. | a tab shows the active provider + "Change" → BYOK wizard; `/ux-review` clean; FE build gate green. |
| **3 — override-scope footgun (FE) ✅ shipped** | `ModelSwitcher` gains a `provider` prop; `useComposerModifiers({ activeProvider: config.provider })` scopes the override to the **configured provider's** models (refined from the original "all credentialed providers" — simpler + matches the BYOK card beside it). Stale override cleared on provider change. Applies to standalone + tab. | an override can't select a provider with no credential; covered by `ModelSwitcher.test.tsx` (+2). |

### Core-app extension surface
- **`ctx.<feature>` workflow surface / node pack / agent pack / envelopes / `/.well-known`:** **none** — this is a chat-UI + capability-advertisement correctness change, not a new capability.

---

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | Not a new package — a correctness fix to the existing chat surfaces + the providers catalog. No registry edits. |
| 2 | Toggle + admin | **None** (core). Multi-tab surface stays under the existing `multi-tab-chat` toggle. |
| 3 | Workflow surface (0014) | None. |
| 4 | Node pack | None. |
| 5 | AI-chat envelopes | None. |
| 6 | Agent pack | None. |
| 7 | Public surface | None — `/chat/model-capabilities` is an authenticated host-ext read. |
| 8 | RBAC + isolation (0006) | Unchanged. The capabilities endpoint returns the non-sensitive static catalog (no per-tenant data); the BYOK card/wizard already enforce per-tenant `storedRefs` (`/byok/secrets`). |
| 9 | Replay / fork | No impact — picker filtering is display-only; the override value rides the run log (ADR 0124) and is read verbatim on `:fork`. |
| 10 | Frontend | Reuse `ConfiguredProviderCard` + `BYOKWizard` + `ModelSwitcher`; no new component; tokens/a11y inherited. |

---

## PRD-vs-architecture corrections

1. **"Replace the dropdown with the button selector."** → **Refined:** the dropdown (`ModelSwitcher`) is the *correct secondary* per-exchange override and stays; what's missing in the tab is the *primary* `ConfiguredProviderCard` gate. The fix **adds** the card, it doesn't replace the dropdown.
2. **"Hide MiniMax in the multi-tab selector."** → **Corrected:** the leak is in the **shared** `/chat/model-capabilities` data source (`chatSessions.ts:235`), so MiniMax shows on *both* surfaces. Fix it once at the source, not per-surface.

---

## Alternatives weighed

- **Filter MiniMax only on the FE (in `ModelSwitcher`).** Rejected — leaves the dishonest advertisement on the wire-adjacent host endpoint (a second consumer would re-leak it) and duplicates the predicate a third time. Fix at the single source (catalog).
- **Build a bespoke tab model selector.** Rejected outright — violates "reuse, never recreate" and the three-surface parity rule; it's exactly how the `AiAuthorPanel` drift happened.
- **Gate the whole tab behind the wizard like the standalone's full-screen `needsWizard`.** Unnecessary — the deck already is (it only renders with a valid `config`); the gap is purely the missing in-composer "Change"/"Try for free" affordance.
- **Do P3 now.** Deferred — P1+P2 fix the *reported* defects (MiniMax hidden; key entry available) and make a bad override *recoverable* (the `ErrorCard` reconfigure action + the now-present "Change"). P3 makes it *unselectable* — a worthwhile refinement, but it touches the shared override semantics on both surfaces and deserves its own review.

## Open questions / decisions

1. **OQ-1 — Should the per-exchange override allow switching *provider*, or only *model* within the active provider?** Deferred to P3. Today (and after P1+P2) it allows cross-provider override among user-facing providers; P3 would scope it to dispatchable ones.
2. **OQ-2 — Managed ("Try it free") users and the override.** A managed user has one model (`auto`); the `ModelSwitcher` already renders nothing when no alternatives are advertised. After P1 the managed provider is filtered from the override list, so a managed user sees just the `ConfiguredProviderCard` ("Server managed" + "Change" to add a BYOK key) — correct.
3. **OQ-3 — Embed surface (`EmbeddedChatPanel`).** It intentionally stays slim (ADR 0073) and already owns its BYOK gate; this ADR doesn't change it. The parity rule here is standalone↔tabbed.

## RFC verdict (Step 5)

**Host-extension — NO new RFC.** `/v1/host/openwop-app/chat/model-capabilities` is a non-normative host-extension route; tightening which providers it advertises (to stop leaking a `hidden` one) is a host correctness fix, not a wire change — no run-event field, capability flag, normative MUST, or endpoint *contract* change (the response shape is unchanged; only the set of advertised providers narrows to the honest set). The FE changes reuse existing components. `OPENWOP_REQUIRE_BEHAVIOR=true` is unaffected (the change makes advertisement *more* honest, never claims an unwired capability).

## Consequences

- **Positive:** the multi-tab chat reaches model-selection parity with the standalone (provider display + Change + Try-for-free + key entry) by reusing existing components; the `hidden` MiniMax leak is closed on **all** surfaces at the single source; the "visible providers" definition stops being triplicated.
- **Negative / accepted:** ~~P1+P2 leave the cross-provider override footgun until P3 lands.~~ **Resolved (P3 shipped):** the override is now scoped to the configured provider's models, so it can't select a provider the user lacks a key for. (A user changes *provider* via the BYOK card "Change" → wizard; the dropdown is a within-provider *model* switch.)
- **Reversible:** P1 is a read-path filter (revert = restore the literal array); P2 is additive composition (revert = remove the card). No data migration, no wire change.
