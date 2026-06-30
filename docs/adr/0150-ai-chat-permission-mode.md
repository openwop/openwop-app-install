# ADR 0150 — AI chat permission mode (safe / bypass)

**Status:** implemented — 2026-06-27 (all 4 phases, PR #961). Phase→commit: P1–P4 all in #961 (`feat(chat): ADR 0150 — per-conversation AI permission mode (safe / bypass)`). Tests: `permission-mode-firewall.test.ts` (6) + full firewall suite (33/33). FE build gate + `/architect` + `/code-review` + `/ux-review` clean.
**Toggle:** **NONE — core functionality** (no feature-toggle; core-chat like ADR 0102/0117). _Product decision 2026-06-27:_ permission mode is a first-class chat affordance, not a gated feature.
**Surface:** host-extension — a **per-conversation** `permissionMode` (`safe` | `bypass`, **default `safe`/off**), exposed as a **switch in the chat composer toolbar** (alongside `tools` / the model selector) and carried **per-exchange** on the existing override channel (the way `model`/`provider`/`webSearch` already ride each turn — ADR 0101/0124). A thin policy layer over the **existing** capability-firewall approval mechanism. **No new wire** (see RFC verdict).
**Composes:** the capability-firewall (**ADR 0135** — already provides `require-approval` + `interrupt.approval` cards + the approval ledger), the conversation tool loop (`host/conversationToolLoop.ts`), the code-exec HITL (**ADR 0114** §Phase 3) + the code-exec **builtin agent tool** (ADR 0146 / #957), the interrupt primitive (RFC 0005 / `interrupt.md`), and the model-router first-exchange **run-metadata stamp** (ADR 0130) for replay-safety.
**Source plan:** the recurring "should I restore the *Run code?* approval gate on the chat path?" open loop (code-exec saga, ADR 0146) — generalized, per the user's request, into a user-controlled permission mode rather than a code-exec-specific gate.

---

## Why this exists

Across the code-exec work, the same question kept recurring: *should the agent ask the user before doing something consequential (run code, write a file, send data off-host), or just do it?* It surfaced as a one-off "Run code?" HITL card on the node-pack path (ADR 0114 §Phase 3) and was **dropped on the new builtin agent-tool path** (#957) because the agent-tool loop had no clean suspend — leaving code-exec effectively un-gated in chat today.

That decision shouldn't live per-tool. It's a **user preference about agency**, exactly like Claude Code's own permission modes: some users want a confirm-before-acting **safe** mode; others want the agent to **bypass** prompts and just act (bounded by the underlying safety — sandbox isolation, budgets, RBAC). This ADR gives users that switch and makes "safe" the default — which also **restores** the code-exec approval gate for the default experience.

**Crucially, the asking machinery already exists** (see the audit) — this is a thin policy layer, not a new HITL system.

---

## Boundaries & pre-existing-surface audit (Step 3)

| Check | Finding | Verdict |
|---|---|---|
| **Approval / "ask" mechanism** | The capability-firewall **already** decides `allow / deny / require-approval` (`features/capability-firewall/compositionEvaluator.ts:4`), surfaces `require-approval` as **`interrupt.approval` cards** (`firewallHook.ts:8,41`), and records decisions in an **approval ledger** with an `approvedTools` short-circuit (`conversationToolLoop.ts:227,242`). | **Compose ADR 0135.** Do NOT build a second HITL/approval system. `permissionMode` is a *policy input* to the firewall hook. |
| **Tool-call gate point** | The conversation tool loop already runs the firewall hook + ledger before `onToolUse` (`conversationToolLoop.ts:197,225–242`). | **Hook the mode in here** — the single chokepoint; no new gate site. |
| **Code-exec gate** | Node-pack path has the ADR 0114 §3 `ctx.suspend` HITL (`packs/feature.code-exec.nodes/index.mjs:35`); the **builtin tool** (#957) executes with NO approval (the dropped gate). | This ADR **classifies code-exec `require-approval`** so *safe* mode gates the builtin path too (restores the card); *bypass* auto-runs it within the sound sandbox/budget. |
| **Per-turn override channel** | The exchange already carries per-turn overrides — `model`/`provider`/`webSearch` ride `ConversationResolve` (`conversationExchange.ts:149,158`) sent by `exchange()` each turn (ADR 0101/0124). No `permissionMode` exists today (`grep` → none). | **Reuse this channel** — add `permissionMode` to the resolve value; no new store, no user-prefs entity. |
| **Replay** | Tool execution is a side-effect; the firewall decision must be deterministic on `:fork`. Per-turn overrides are already in the run event log. | The mode rides the **exchange resolve value** ⇒ in the run log ⇒ deterministic on `:fork`, **no separate stamp** (cf. ADR 0130's `modelRoute`, which stamps because it's a once-per-run decision; this is a changeable-per-turn control, so the per-exchange carrier is correct). |

**Single owners (compose, don't fork):** the approval *mechanism* → capability-firewall (0135); the *gate point* → `conversationToolLoop`; the *user setting* → the prefs surface; sensitive-tool *classification* → the firewall's class table (0135).

---

## Decision

Add a **per-conversation `permissionMode`** (`'safe'` default | `'bypass'`) — a **core** chat affordance (no feature-toggle) surfaced as a **composer-toolbar switch**, carried **per-exchange** on the existing override channel and consumed by the **existing** capability-firewall hook in the conversation tool loop:

- **`safe` (default):** the firewall's `require-approval` dispositions **prompt** the user (the existing `interrupt.approval` card); a declined tool is refused, an approved one runs + is remembered in the ledger. *This is essentially today's firewall behavior, made the explicit default.*
- **`bypass` (per chat):** `require-approval` is treated as **`allow`** for that turn (the user has pre-authorized via the toolbar switch) — the agent acts without prompting. `deny` dispositions still **deny** (bypass is "skip the *ask*," not "skip the *firewall*"); RBAC, budgets, and sandbox isolation still bind.

And: **classify the high-blast-radius agent tools as `require-approval`** in the firewall class table — `feature.code-exec.nodes.run` (run code), file-write, and off-host egress — so *safe* mode gates them (restoring the "Run code?" card on the builtin path) and *bypass* runs them.

### Data model — no new store, no toggle
- **Per-exchange flag** (additive on the conversation resolve value, like `model`/`webSearch` — `conversationExchange.ts` `ConversationResolve`): `permissionMode?: 'safe' | 'bypass'` (absent ⇒ `safe`). The firewall hook reads the mode in effect *for that turn*.
- **Per-conversation default:** the toolbar switch's state is a UI preference on the conversation (the FE remembers it per session and sends it each turn); no server entity required for v1 — the authoritative value is the per-exchange flag.
- **Replay/fork:** because the mode rides the **exchange resolve value**, it is already in the run event log → **deterministic on `:fork`** with no separate stamp (the firewall reads the same per-turn value on replay). *(Supersedes the earlier `run.metadata.permissionMode` stamp — the per-exchange channel is the correct carrier for a per-chat, mid-conversation-changeable control.)*

---

## Phased plan

| Phase | Deliverable | Gate |
|---|---|---|
| **1 — per-exchange flag** | Add `permissionMode?: 'safe'\|'bypass'` to `ConversationResolve` (the exchange resolve value) + the FE `exchange()` override params (alongside `model`/`webSearch`); absent ⇒ `safe`. | wire-neutral (host-ext resolve value); **fail-safe** (any error/absent ⇒ `safe`). |
| **2 — firewall integration** | In `conversationToolLoop`, pass the turn's mode into the firewall hook: `bypass` ⇒ `require-approval`→`allow`; `safe` ⇒ unchanged. Reads the per-turn value (in the run log) so replay/`:fork` is deterministic. | `deny` still denies under bypass; existing firewall tests stay green; `:fork` replays the same per-turn mode. |
| **3 — classify the sensitive tools** | Add `feature.code-exec.nodes.run` (+ file-write, egress) to the firewall's `require-approval` class so *safe* gates them — **restoring the code-exec "Run code?" card on the builtin agent-tool path** (closes the #957 gap). | safe mode shows the card for code-exec; bypass runs it; sandbox/budget unchanged. |
| **4 — composer-toolbar control** | A **Safe / Bypass** switch in the chat composer toolbar (the `tools`/model row — `useComposerModifiers`), per-conversation, **default safe**; remembers state per session + sends `permissionMode` each turn; a one-line affordance ("Safe — approve actions" / "Bypass — agent acts directly"). The approval card already exists (ADR 0135). i18n (en/pt-BR/es/fr). | a11y + tokens; default safe; i18n parity; matches the existing toolbar pattern (no new chrome). |

### Core-app extension surface
- **`ctx.<feature>` workflow surface:** **none** (it's a policy over the existing firewall, not a new capability).
- **Node pack / agent pack / envelope:** **none.** It reuses the firewall + interrupt primitives.
- **`/.well-known`:** no advertisement change.

---

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | A thin policy + the `permissionMode` setting; **extends** capability-firewall (0135) at its existing hook — no parallel system, no core route edits beyond the prefs read + the firewall-hook input. |
| 2 | Toggle + admin | **None — core functionality** (no feature-toggle; core-chat like ADR 0102/0117). The control is the **per-conversation composer-toolbar switch**, default `safe`. |
| 3 | Workflow surface (0014) | **None.** |
| 4 | Node pack | **None.** |
| 5 | AI-chat envelopes | **None** (reuses `interrupt.approval`). |
| 6 | Agent pack | **None.** |
| 7 | Public surface | **None.** |
| 8 | RBAC + isolation (0006) | The mode only relaxes the *prompt*, never authority — `deny`/RBAC/budgets/sandbox still bind under bypass; the setting is per-user, the toggle per-tenant; **fail-safe to `safe`**. |
| 9 | Replay / fork | The mode rides the **per-exchange resolve value** (already in the run event log) — deterministic on `:fork` with no separate stamp; the firewall reads the same per-turn value on replay. |
| 10 | Frontend | A **composer-toolbar** Safe/Bypass switch (per conversation) + the existing approval card; tokens/a11y/i18n per `/ux-review`; reuses the toolbar pattern (no new chrome). |

---

## PRD-vs-architecture corrections

1. **"Bypass permissions" framed as a per-LLM/agent behavior** → **Corrected:** it's a **user policy fed into the existing firewall**, not a new agent capability or a per-tool HITL — there is already one approval mechanism (ADR 0135); this layers a mode onto it.
2. **Implicit "bypass = no safety"** → **Corrected:** bypass skips only the *ask*; `deny`, RBAC, per-tenant budgets, and the sandbox boundary still apply. Bypass ≠ unsafe; it's "don't prompt me for the things the firewall would otherwise ask about."
3. **Default direction** → safe is the **default** (and bypass is tenant-gated OFF), so the change *increases* safety out-of-box (it restores the code-exec gate) while giving power users the opt-out they asked for.

---

## Alternatives weighed

- **A code-exec-only "Run code?" toggle.** Rejected — it's the per-tool wart this ADR exists to generalize; the same question applies to file-writes and egress.
- **A brand-new approval/HITL subsystem.** Rejected — ADR 0135 already provides `require-approval` + cards + ledger; building a second is duplication (the exact audit failure this skill guards against).
- **Bypass as a global host env flag, or an account-wide setting.** Rejected — it's a *per-conversation* choice (the user wants it switchable per chat, in the composer toolbar); a global flag/account setting can't express that. Per-exchange carry (like `model`/`webSearch`) is the existing, replay-correct mechanism.
- **Gating it behind a feature-toggle.** Rejected per the product decision — permission mode is core chat functionality, always available (core-chat like ADR 0102/0117). _(A compliance-driven tenant-level "forbid bypass" governance control can be added later as a non-blocking follow-on if a workspace needs it; it is explicitly out of v1.)_

## Open questions / decisions

1. **OQ-1 — Feature-toggle? → DECIDED: NO toggle, core functionality** (product decision 2026-06-27). Permission mode is a first-class chat affordance, not a gated feature.
2. **OQ-2 — Scope: account-wide vs per-conversation? → DECIDED: per-conversation**, via a composer-toolbar switch, **default safe** (off). The user flips it per chat. An optional account-level *default* (e.g. "always start in bypass") is a clean follow-on, not v1.
3. **OQ-3 — Which tools are `require-approval` by default?** Start with code-exec + file-write + off-host egress (the high-blast-radius set); reuse/extend the ADR 0135 class table rather than a new list. *(Lean: that set; revisit as tools grow.)*
4. **OQ-4 — Granular bypass (per-tool allow-list) vs binary?** v1 is binary (safe/bypass). A "always allow this tool" per-user ledger entry already exists in the firewall (`approvedTools`) and could back a future granular mode.
5. **OQ-5 — Surface the mode in the run's audit trail?** The firewall already logs decisions; ensure a `bypass`-mode auto-allow is auditable (logged as `auto-approved (bypass)`), not silently indistinguishable from an explicit approval.

## RFC verdict (Step 5)

**Host-extension — NO new RFC.** The mode is a host-side policy over the existing capability-firewall; it reuses the **already-Accepted RFC 0005** interrupt primitive (`interrupt.approval`) and the host-extension exchange-override channel, adding no run-event field, capability flag, normative MUST, or endpoint contract. The per-exchange `permissionMode` is a host-internal resolve value (non-normative, like the existing `webSearch`/`model` per-turn overrides). No advertisement change ⇒ `OPENWOP_REQUIRE_BEHAVIOR=true` unaffected.

## Consequences

- **Positive:** one coherent answer to the recurring HITL question; **restores** the code-exec approval gate for the default (safe) experience while giving power users a real bypass; reuses the firewall/interrupt/ledger machinery (no new subsystem); replay-deterministic; tenant-governable for compliance.
- **Negative / accepted:** one new per-exchange field + a toolbar control; classifying tools `require-approval` adds an approval prompt to the *default* code-exec chat flow (intended — it was un-gated after #957). Bypass relies on the underlying boundaries (sandbox/RBAC/budget) holding — which they do (ADR 0146 soundness). No compliance "forbid bypass" governance in v1 (a deferred follow-on, OQ).
- **Reversible:** the default is `safe` (today's firewall behavior + the restored code-exec gate); the per-exchange flag is additive and removable without touching the firewall core. No toggle, no store to migrate.
