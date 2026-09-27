# ADR 0396 — Personal settings consolidation (settings shell + panel registry + personal budget)

**Status:** implemented (2026-07-17 — Phases P1–P4; see § Implementation record)
**Date:** 2026-07-17
**Lane:** feature-package (frontend shell + panel registry) + a small core cost-governance extension. No wire change.
**Depends on:** ADR 0001 (feature-package architecture), ADR 0006 (RBAC), ADR 0015 (workspace-as-tenant), ADR 0139 (the ONE nav grouping/ordering primitive — the registry precedent), ADR 0375 (editable dashboard — the shell-owned `allTiles.ts` registration precedent), ADR 0363 (authored-content a11y + `ui/a11yPrefs` preferences store — **extended**), ADR 0178 (BYOK chat spend governance — **composed**, per-org sibling of this ADR's personal budget), ADR 0118 (Usage Analytics — the read-side rollup this composes, does not duplicate), ADR 0030/RFC 0030 (envelope reasoning directive — the escalation setting's backing mechanism), the `consent` feature (privacy opt-outs — composed).
**RFC verdict:** **host-extension, NON-NORMATIVE — no OpenWOP RFC.** (§ RFC verdict.)

> Closes the docs/steward/MYNDHYVE-GAP-ANALYSIS.md P2 "settings shell" cluster (rows at :416–:424): a consolidated `/settings` page, a deeper Accessibility panel, a personal Usage-&-Budget panel with enforce/alerts, an Agent-Escalation panel, and a personal Privacy panel — as ONE ADR. Editor-prefs is a **documented deferral** (§ Open questions).

---

## Context

openwop-app already ships the **hard parts** of personal settings — but scatters them, with no consolidated home and three genuine capability gaps. The gap analysis (verified against the code below) is precise: BYOK is COVERED-BETTER, dashboard prefs COVERED, profile COVERED; what's missing is (1) the connective tissue (a tabbed `/settings` page), (2) preference **depth** (a11y font-size/focus/SR; a General panel), and (3) a **personal** spend budget with hard-block + alerts.

A naïve port would build a monolithic settings page that OWNS theme, keys, seeds, and profile — exactly the parallel-architecture trap ADR 0001 forbids, and the same drift the CLAUDE.md AI-chat rule warns about (the removed `AiAuthorPanel`). The decision below is therefore a **composition shell**: a registry into which existing feature surfaces contribute a panel, moving **no owning feature**.

### Boundaries & pre-existing-surface audit (evidence)

| Pref surface today | Owner + evidence | Ruling |
|---|---|---|
| **Theme** | `ui/ThemeToggle.tsx` (localStorage + `data-theme` pre-paint), mounted in the Sidebar footer | **Re-surface as a General-panel control over the SAME store.** Keep the footer control (quick access). No second store. |
| **Reduce-motion / contrast** | `ui/A11yPrefsControl.tsx` + `ui/a11yPrefs.ts` (localStorage + `data-reduce-motion`/`data-contrast`, ADR 0363 P4), Sidebar footer | **Extend the SAME store** with font-size / focus-style / SR opts; surface it as the Accessibility panel. **Do NOT fork a second prefs store** (the ADR 0363 "reuse, never recreate" ruling). |
| **API keys / BYOK** | `byok/KeysPage.tsx` (+ `ProviderGrid`/`ModelGrid`/`KeyEntry`…), route `/keys` (Access Hub `credentials` tab, `chrome/features.tsx:239`) | **Panel deep-links / embeds; owning feature does not move.** COVERED-BETTER — the panel adds discovery, not machinery. |
| **Example data (seeds)** | `settings/ExampleDataPage.tsx`, route `/example-data` (`chrome/features.tsx:260`) | **Panel deep-links.** Admin-tier surface; stays where it is. |
| **Dashboard customize** | ADR 0375 editable dashboard at `/` (per-(user,workspace) layout) | **Panel deep-links** to the dashboard's own customize affordance. |
| **Profile** | `profiles/ProfilePage.tsx` (ADR 0005) | **Panel deep-links.** |
| **Privacy / consent** | `features/consent/` (`ConsentPage`, `consentClient`, toggle `consent` OFF, `bucketUnit:'tenant'` — `features/consent/feature.ts:19,25`) — analytics/cookie consent at the org/cookie layer | **Compose** the consent client in a Privacy panel; add a thin **per-user** analytics/crash opt-out layer. |
| **Agent escalation / reasoning** | `host/envelopeReasoningConfig.ts` — `getEnvelopeReasoningConfig()` reads the host-wide `OPENWOP_ENVELOPE_REASONING_DIRECTIVE` (`off`/`advisory`/`mandatory`, RFC 0030 §C), read per-dispatch | **Add a per-USER override layer** over this accessor (backing mechanism confirmed to exist; host-wide today). |
| **Personal usage / budget** | `features/usage-analytics/` (ADR 0118 — read-only admin rollup, "a cache of recorded data, never authoritative"); `billing/BillingPage.tsx` (plan/prepaid). **No personal cap / hard-block / alert.** | **Build** — the one genuinely-missing capability; **compose** the ADR 0178 enforcement seam. |

### The registry precedent (import-boundary safe)

The app already has the pattern this ADR mirrors: **`chrome/features.tsx`** — one declarative `FeatureRoute` manifest, `GROUP_ORDER` for section sequence, `navGroups()` as the ONE grouping/ordering primitive (ADR 0139, `chrome/features.tsx:319,379`); feature-owned entries compose via `featureRoutes()` from `features/registry.ts`. **ADR 0375 refined this for panels specifically**: the dashboard chose a **shell-owned `allTiles.ts` registry that lazy-imports each tile**, *rejecting* per-feature `registerDashboardTile()` calls precisely because they would cycle `chrome/features ⇄ Page`. This ADR follows the ADR 0375 ruling: a settings-shell-owned registry, lazy-importing each contributed panel.

### The budget enforcement seam (cite)

ADR 0178 is **implemented and live** (its file's `Status: Proposed` line is **stale** — the code shipped; a correction to that ADR is recommended, out of scope here). The enforcement path:

- **Module:** `aiProviders/byokChatBudget.ts` — `checkByokChatBudget(tenantId, provider)` returns `{ exceeded, used, cap, usedPct, warn }`; `recordByokChatUsage(tenantId, provider, in, out)`; per-`(tenant, provider, UTC-day)` accounting via `storage.getByokChatUsage`/`incrementByokChatUsage`; env `OPENWOP_BYOK_DAILY_TOKEN_CAP` + a per-org superadmin override (DI seam `configureByokChatBudget({resolveOverride})` → `governanceService`/`GovernancePolicy.byokChatBudget`).
- **Call site:** `host/exchange/dispatchTurn.ts:275` — the hard cap is checked **BEFORE** the BYOK dispatch (`byok_budget_exceeded` → 429); real post-dispatch tokens are recorded at `:328`; the soft-warning rides the `ByokBudgetNotice` (`code:'byok_budget_warning'`, `dispatchTurn.ts:147`) threaded onto the sync turn-result (`conversationExchange.ts:471`) — **not a wire/envelope type**.
- **Acting user is available:** `run.metadata['actingUserId']` (`conversationExchange.ts:252`) — the IDOR-safe per-user key for personal accounting (the run's own acting user, never request input).

**Conclusion:** this is a **feature-package (the shell + panels)** plus a **narrow core cost-governance extension** (a per-user lane on the already-live `byokChatBudget.ts`). It composes ADR 0178, does not supersede it — 0178 is the **superadmin org backstop**; this ADR is the **self-service personal lane**, and the two combine as an effective `min()`.

---

## Decision

Ship a toggle-gated **`settings`** feature-package that adds a consolidated `/settings` page built on a **panel registry**, plus five panels (four composing/re-surfacing existing capability, one net-new budget lane), moving no owning feature.

### 1. The panel-registry contract (import-boundary safe)

A settings-shell-owned registry (mirroring ADR 0375's `allTiles.ts`), NOT per-feature registration calls:

```ts
// features/settings/settingsPanels.ts  (shell-owned; lazy-imports each panel component)
interface SettingsPanel {
  id: string;                         // stable key + URL hash (/settings#a11y)
  group: SettingsGroup;               // 'general' | 'accessibility' | 'ai' | 'privacy' | 'account'
  order: number;                      // within-group sequence (ADR 0139 pattern)
  titleKey: string;                   // i18n key (settings ns) — NEVER a literal
  component: React.LazyExoticComponent<React.ComponentType>;
  visibility?: (ctx: SettingsVisibilityCtx) => boolean; // toggle/role/BYOK-configured gate
}
```

`SETTINGS_GROUP_ORDER` (an ADR 0139 twin) orders the tabs; `settingsPanels()` composes them exactly as `navGroups()` does. A panel that re-surfaces another feature (Keys, Example Data, Profile, Dashboard, Consent) **embeds or deep-links** that feature's existing component — the shell owns zero of their data. Import rule: `features/settings/` may static-import sibling feature panel components (feature↔feature is allowed); the registry lazy-imports them so no eager cycle forms and the entry chunk stays lean.

### 2. Panels

- **(b) General** — theme (re-exposes `ThemeToggle`'s store), reduce-motion (re-exposes `a11yPrefs`), **density** (net-new: a `data-density` attribute on `documentElement` + an ADDITIVE CSS block, the ADR 0363-P4 contrast pattern; no ADR 0171 token regeneration), and **autosave interval where a real one exists** (document-editor/canvas autosave; NOT invented where autosave is already automatic — an honest per-surface offering, else omitted). All cosmetic prefs stay **localStorage** (client-authoritative, no-flash pre-paint), the same tier `ThemeToggle`/`a11yPrefs` already use — no new store.
- **(c) Accessibility (depth)** — extends `ui/a11yPrefs.ts` + `ui/A11yPrefsControl.tsx` (ADR 0363 §Reuse-never-recreate) with **font-size multiplier** (`--font-scale` root var), **focus-indicator style** (`data-focus-style` + CSS), and **SR-optimization** toggles, each an additive `data-*`/CSS mirror keyed off the OS media query — **one store**, surfaced BOTH in the Sidebar footer control (quick access, unchanged) and as the settings panel.
- **(d) AI Usage & Budget** — the net-new lane (§3).
- **(e) Agent Escalation** — a per-user override for the RFC 0030 reasoning directive (`off`/`advisory`/`mandatory`) over `envelopeReasoningConfig`. Honest scope: only the **reasoning-directive strength** has a backing mechanism today; a "confidence threshold" (the gap's second sub-item) has **no** implementation to expose and is **omitted**, not faked.
- **(f) Privacy** — composes `consentClient` (analytics/crash opt-outs) + a thin per-user privacy-prefs layer (recent-files, per-user analytics opt-out). Server-authoritative (below).
- **Account** — deep-links Profile, API Keys (`/keys`), Example Data (`/example-data`), Dashboard customize. No relocation.

### 3. Personal AI Usage & Budget — composing ADR 0178

A **per-user** daily token budget for BYOK chat dispatch, on the SAME accounting primitive as ADR 0178's per-org budget, self-service, that can only **lower** effective spend:

1. **Unit = tokens, USD = display only** — the ADR 0178/0106 staleness ruling (a USD figure is a read-only estimate from the `usageEmitter` rate table, never the enforcement comparison).
2. **Scope = BYOK chat dispatch** — the one path 0178 already governs (managed-tier is operator-paid; ADR 0024's tier-split). Managed-tier personal caps are an explicit non-goal for v1 (§ Open questions).
3. **Effective cap = `min(orgCap, personalCap)`** — a personal cap **never raises** the superadmin org backstop; it only tightens it (an over-cap personal value is clamped to the org cap, or ignored). This is the load-bearing RBAC invariant.
4. **Per-user accounting** — a new `(tenant, actingUserId, UTC-day)` counter (storage methods `getByokChatUsageByUser`/`incrementByokChatUsageByUser` mirroring the existing per-provider pair), keyed off `run.metadata.actingUserId` (IDOR-safe).
5. **Hard-block = typed failure** — `byok_personal_budget_exceeded` (429), mirroring `byok_budget_exceeded`. **Never silent-empty, never a placeholder** (the LLM-exchange non-negotiable).
6. **Alert** — the crossing surfaces (a) inline on the existing `ByokBudgetNotice` (add a `scope:'org'|'personal'` discriminant — same shape, not a new envelope) and (b) an out-of-band notification via the existing `getNotificationEmitter` seam when the personal soft threshold is crossed.
7. **Read-out** — a personal usage panel composes ADR 0118's recorded `provider.usage` data (read-only projection; no new store, no parallel rollup).

### 4. Storage — two honest tiers

- **Cosmetic prefs** (theme, motion, contrast, density, font-scale, focus-style): **localStorage**, the existing `ThemeToggle`/`a11yPrefs` tier. A client can render these; they need no server round-trip and must not flash.
- **Server-authoritative prefs** (personal budget cap + threshold, escalation directive, privacy opt-outs): a durable **per-user KV-blob** store over `host_ext_kv` (namespace `settings:user-prefs`, key = `userId`) — the ADR 0383 KV-blob pattern, **no SQL migration**. Route `GET/PUT /v1/host/openwop-app/settings/prefs`, **self-scoped** (keyed by the authenticated user; never a request-supplied id). A budget a user could edit client-side would be no budget at all — enforcement reads the server value.

---

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (ADR 0001) | `frontend/.../features/settings/` (shell + registry + panels) + `backend/.../features/settings/` (the per-user prefs store + `GET/PUT /settings/prefs`). The **budget extension lives in core** `aiProviders/byokChatBudget.ts` (+ two storage methods), not the package — it's a cost-governance extension like ADR 0178/0106, riding the existing dispatch seam. Registry = shell-owned `settingsPanels.ts` (ADR 0375 `allTiles.ts` pattern). |
| 2 | Toggle + admin UI | **ONE new toggle `settings-shell`** (OFF, `bucketUnit:'tenant'` — an operator enables the consolidated experience install-wide; matches `dashboard`/`consent`). Each panel's **capability** keeps its own toggle (`byok`/`consent`/`accessibility` are unaffected). No new admin surface — it appears in the existing `FeatureTogglePanel`. **Budget enforcement is independent of this toggle** (env/prefs-gated, a safety concern, off-by-default per user). |
| 3 | Workflow surface (`ctx.<feature>`, ADR 0014) | **None.** Personal settings are a per-user UI/prefs concern with no orchestration value — a workflow node reading a user's theme or budget is meaningless. Justified omission. |
| 4 | Node pack | **None** — no surface method to expose; nothing a workflow drives. |
| 5 | AI-chat envelopes | **None.** The budget soft-warning rides the EXISTING `ByokBudgetNotice` turn-result shape (ADR 0178) with an added `scope` discriminant — a host-internal field, **not** a new envelope kind. Per the three-lane rule this is a turn-result signal, not in-run structured intent. |
| 6 | Agent pack | **None** — not an AI-authoring surface (a personal-config + platform-safety concern, the same call ADR 0178/0106 made). |
| 7 | Public surface | **None.** Authed self-service only; nothing published. |
| 8 | RBAC + isolation (ADR 0006) | **Self-service only.** Every pref/budget is keyed by the **authenticated user's own id** (`actingUserId`), never request input → IDOR-safe by construction. The personal budget can only **lower** effective spend (`min(orgCap, personalCap)`) — it **cannot raise** or override the superadmin org cap (ADR 0178). Escalation/privacy prefs are self-scoped. Fail-closed on over-budget; fail-soft on a prefs-read outage (0178's proven posture). |
| 9 | Replay / fork | Prefs are UI state (n/a to replay). The budget inherits ADR 0178's proven invariant: usage recorded **post-dispatch** from real token counts, cap **checked before**, `:fork`/replay reads recorded output verbatim and never re-dispatches → no double-charge, no wire field. |
| 10 | Frontend | The `/settings` shell + tabbed panels; **reuse `ui/`** (`Modal`, `segmented`, `Notice`, `StateCard`, the `a11y` i18n ns) — no bespoke widgets. Panels **embed/deep-link** `KeysPage`/`ExampleDataPage`/`ConsentPage`/`A11yPrefsControl` — never reimplement. Full **4-locale i18n** (the `check-i18n` gate is FATAL) + a11y (the settings page is itself an a11y surface). |

---

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **P1 — Shell + registry + migrate-in** | `features/settings/SettingsPage.tsx` at `/settings` (tabbed, `#hash` per panel), the `SettingsPanel` contract + shell-owned `settingsPanels.ts` + `SETTINGS_GROUP_ORDER`, the `settings-shell` toggle, one nav entry. Re-surface the EXISTING surfaces as panels (General[theme/motion], Account[Keys/Example-data/Dashboard/Profile deep-links], Accessibility[current A11yPrefsControl]). i18n×4. | FE build (tsc + token/CSS gates) |
| **P2 — General + Accessibility depth** | General: density + autosave-where-applicable. Accessibility: font-size multiplier, focus-indicator style, SR opts — extending `ui/a11yPrefs.ts` + additive `data-*`/CSS (ADR 0363 P4). One store; footer control reused. | FE build + a11yPrefs unit test |
| **P3 — Personal budget + enforcement** | Backend: per-user prefs KV store + `GET/PUT /settings/prefs`; two per-user usage storage methods; extend `checkByokChatBudget` with the personal lane + `min()`; `byok_personal_budget_exceeded` → 429; notification-emitter alert; `ByokBudgetNotice.scope`. FE: budget panel (set cap/threshold) + a read-only usage read-out over ADR 0118 data. | backend vitest (over-cap fail-closed, `min()` clamp, off-by-default, IDOR) + FE build |
| **P4 — Escalation + Privacy** | Escalation panel: per-user reasoning-directive override threaded over `envelopeReasoningConfig` (a `resolveEnvelopeReasoning(userId)` layer, env fallback). Privacy panel: compose `consentClient` + per-user opt-out prefs. | backend vitest (per-user override precedence) + FE build |
| **Deferred** | **Editor-prefs panel** — documented, not built (§ Open questions). | — |

---

## Implementation record (2026-07-17)

| Phase | Landed as |
|---|---|
| P1 — shell + registry | FE `features/settings-shell/` (see correction 1): `settingsPanels.ts` (shell-owned lazy registry, the ADR 0375 pattern) + `SettingsPage` (`/settings`, group tabs + `#hash`), `settings-shell` toggle (OFF, tenant, Platform; seedCoverage ACK), Account deep-link panel. 4-locale i18n (`settings-shell` ns + nav keys). |
| P2 — depth | `ui/a11yPrefs.ts` extended (ONE store): `fontScale` (`--font-scale` root var + html base multiply), `focusStyle` (`data-focus-style` bold ring), `density` (`data-density` compact spacing) — additive CSS + the index.html pre-paint mirror (CSP hash rotated in firebase.json). `A11yPrefsControl` refactored into `A11yPrefsFields` (footer modal + settings panel render the SAME component). |
| P3 — personal budget | `features/settings/` backend: KV-blob prefs (`settings:user-prefs`) + per-user usage counters (`settings:byok-usage`, CAS increment) + self-scoped `GET/PUT /settings/prefs`; core `byokChatBudget` gains the injected `PersonalByokBudgetLane` (DI — core never imports the feature) with the min()-by-either-lane-blocks semantics; `dispatchTurn` threads the run's acting user into check/record, raises the typed `byok_personal_budget_exceeded` 429, and the `ByokBudgetNotice` gains `scope: 'org'|'personal'`; threshold-crossing fires a `recipientUserId`-addressed notification. |
| P4 — escalation + privacy | `envelopeReasoningConfig` gains `resolveEnvelopeReasoning(tenantId, userId)` + the injected per-user resolver; `AdapterScope` gains optional `actingUserId` (threaded from `run.metadata` in the executor) so the envelope dispatch applies the override; Privacy panel + per-user opt-out prefs (server-authoritative). ADR 0178's stale Status line corrected (as this ADR recommended). |

**Correction notes:**

1. **Package dir is `features/settings-shell/`** (FE) — the ADR's `features/settings/`
   would shadow the pre-existing `src/settings/` area (ExampleDataPage); the backend
   package IS `features/settings/` (no collision there). Toggle id unchanged.
2. **General panel ships theme/motion/density only.** The autosave-interval control is
   OMITTED per the ADR's own honesty rule — no editor models a real per-surface
   autosave interval pref today (autosave is automatic where it exists).
3. **Account panel deep-links** (never embeds) Keys/Example-data/Profile/Dashboard —
   the lighter of the two latitudes the ADR allowed, keeping every gate where it lives.
4. **Notice precedence:** when BOTH lanes warn, the PERSONAL warning wins the single
   `ByokBudgetNotice` slot (the user can act on their own cap; the org warning
   resurfaces once the personal one clears).

## Alternatives weighed

1. **Keep settings scattered (status quo).** Rejected — the capability exists but is undiscoverable across the sidebar footer, `/keys`, `/example-data`, dashboard, and `/profile`; the connective tissue IS the user value the gap identifies.
2. **Per-feature settings pages only, no shell.** Rejected — fragments the surface and re-invites the exact drift the CLAUDE.md single-chat rule warns about (the removed `AiAuthorPanel`); there's no single home and each feature reinvents chrome.
3. **A monolithic settings page that OWNS theme/keys/seeds/profile.** Rejected — a textbook parallel architecture (ADR 0001); relocating owning features breaks their package boundaries. The registry composes; it never owns.
4. **Supersede ADR 0178 with one unified personal+org budget module.** Rejected — 0178's cap is a **superadmin governance backstop** (operator/org authority, always-available); the personal budget is **self-service** (the user's own money, opt-in). They have different owners and default postures — exactly the tier-split ADR 0106/0178 already settled. Composing them as `min(orgCap, personalCap)` on a shared primitive is honest; folding them into one blurs the settled policy split. **This ADR composes 0178; it does not supersede it.**
5. **Server-persist every pref (including theme).** Rejected — cosmetic prefs need no-flash pre-paint and no round-trip; localStorage is the right (and existing) tier. Only enforcement-bearing prefs (budget/escalation/privacy) need server authority.

---

## Open questions

1. **Org-level DEFAULT personal budgets vs personal-only.** Recommend **personal-only for v1** — an org-wide default budget is a governance concern ADR 0178 already owns (the superadmin org cap); a per-user *default* set by an admin is a materially different mechanism with no precedent. Revisit if an operator asks.
2. **Monthly window vs daily-only.** Every existing cap in this codebase is daily-UTC (`dailyTokenCap`, `mediaBudget`, `byokChatBudget`). Recommend **daily for v1**; a monthly cap is a second accounting window (a `(tenant,user,YYYY-MM)` counter) — a clean phase-2 addition, not a v1 blocker.
3. **Editor-prefs panel — DEFER (the honest call).** Document-editor prefs (font/spellcheck/line-numbers/word-wrap/tab-size) are genuinely MISSING and the editors don't model them as user prefs today; demand is small and the surface is one feature, not cross-cutting. Building it means adding a prefs layer to the document-editor first, then a panel — out of proportion to this ADR's consolidation goal. Ship the shell; add an Editor panel only if editor depth becomes a stated goal.
4. **Escalation "confidence threshold."** No backing mechanism exists — `envelopeReasoningConfig` models only directive *strength* (`off`/`advisory`/`mandatory`). Expose strength; **omit** confidence threshold rather than fake a control with nothing behind it.
5. **Managed-tier personal budget.** v1 scopes the personal budget to BYOK (matching ADR 0178's scope and the tier-split). A managed-tier personal cap is a separate, explicitly-scoped change if demanded.

---

## RFC verdict

**Host-extension, NON-NORMATIVE — no OpenWOP RFC.** All routes live under `/v1/host/openwop-app/settings/*`; the personal budget composes ADR 0178's host-internal `byokChatBudget` seam (the enforcement unit is tokens, the warning rides the existing turn-result shape — neither touches the wire); the per-user reasoning-directive override reads the same host accessor the discovery advertisement already reads, but the per-user threading is host-internal (the wire advertisement stays host-level). Prefs are host-side KV/localStorage. **If** a future need exposed a *normative* per-user "budget remaining" or "reasoning posture" field on the run/event wire (so a remote client could observe it), that would need an RFC — out of scope here, consistent with ADR 0178's own closing note.

Cross-references: ADR 0178 (per-org BYOK budget — **status line is stale; correct to `implemented`**), ADR 0118 (usage data), ADR 0363 (a11y prefs store — extended), ADR 0375 (`allTiles.ts` registry precedent), ADR 0139 (nav grouping primitive), docs/steward/MYNDHYVE-GAP-ANALYSIS.md §Personal settings (:416–:424).
</content>
</invoke>
