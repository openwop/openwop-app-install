# ADR 0134 — Graduate the AI-chat feature set to always-on (remove their toggles)

**Status:** implemented — 2026-06-24.
**Date:** 2026-06-24
**Decision type:** Cross-cutting feature-toggle posture (operator request).
**Depends on / composes:** ADR 0001 (feature-package + toggle model), ADR 0010 §Correction
(Notifications graduation precedent), ADR 0024 §Correction (Connections graduation
precedent — the canonical "drop `toggleDefault`, open the gates" recipe).

## Why this exists

The operator asked to **enable every AI-chat feature that was toggle-OFF, remove the
toggle, and make it always-on**. Per the established graduation pattern (a feature that
is platform plumbing rather than an A/B surface drops its toggle and serves
unconditionally), the following **14** features were graduated:

`conversation-search`, `conversation-tools` (ADR 0132), `model-router` (ADR 0130),
`interactive-artifacts` (ADR 0128), `prompts`, `chat-export`, `memory-auto-extract`,
`scheduled-agent-chats`, `task-deck` (ADR 0133), `evals`, `kb`, `channels`,
`chat-widget`, `code-exec`.

## Decision

For each of the 14, apply the ADR 0010/0024 graduation recipe:

1. **`feature.ts`** — drop `toggleDefault` (the feature no longer registers a toggle,
   so it never appears in `FeatureTogglePanel`). `registerRoutes`/packs/surface stay;
   the BackendFeature still mounts unconditionally.
2. **Backend gates open** — `requireFeatureEnabled(...)` calls removed; `authorizeOrgScope(req, FEATURE, scope)`
   → `requireOrgScope(req, scope)` (keeps the RBAC scope check, drops the toggle gate);
   `resolveOne('<id>')` enablement checks removed / treated as always-true.
3. **Frontend gates open** — `useFeatureAccess('<id>')` page/button gates replaced with
   always-enabled (pages render; the `CapabilityScopeButton`/`TaskDeckButton`/
   `SandboxedArtifactFrame` always render); `featureId` removed from the nav routes so
   the nav entry always shows.

### Cross-feature `kb` readers (the load-bearing subtlety)

`kb` is consumed by features that are **not** graduated (`priority-matrix`, `strategy`,
`advisory-board`). They read `resolveOne('kb')` / `useFeatureAccess('kb').enabled` to
decide whether to index/show KB. Once the `kb` toggle is removed those reads would go
**false** and silently disable KB-grounding in those features. Each was updated to treat
KB as always-on (the planning-knowledge `gatesOpen` now checks only the owning feature's
toggle; the FE `kbEnabled` reads are `true`).

## Risk acknowledged (operator-confirmed scope)

Two of the 14 carry a larger blast radius now that they are unconditional for **every
tenant** with **no off switch**:

- **`chat-widget`** — a public, domain-allowlisted, capability-token-gated embeddable
  gateway. Still default-deny until a widget is provisioned + an origin allowlisted; the
  graduation only removes the per-tenant *feature* curtain, not the per-widget gates.
- **`code-exec`** — a sandboxed code interpreter. Still **honest-off** with no
  `ctx.runSandboxedCode` adapter wired (returns `capability_not_provided`) and HITL-gated
  when wired; the graduation removes the toggle, not the adapter requirement or the
  approval gate.

`memory-auto-extract` remains **opt-in per user** via its consent grant (the graduation
removes the tenant toggle, not the user consent gate). `channels` v1 stays local-host;
presence is a separate env gate (`OPENWOP_CHANNEL_PRESENCE_ENABLED`), unchanged.

## RFC verdict

**No new RFC.** Toggle state is a host-local operational concern; removing toggles
changes no wire shape, capability advertisement, event, or endpoint contract. The
underlying features are host-extension (or already-Accepted RFC 0064/0078 surfaces).

## Verification

- Backend `tsc --noEmit` clean; toggle-adjacent + feature route tests updated (the
  obsolete "404 when toggle off" / "does not index when kb off" assertions became
  "serves without a toggle (always-on)") and green.
- Frontend `npm run build` gate green (tsc + css-tokens + tsx-color-literals + i18n +
  built-css + bundle-budget + csp); entry chunk unchanged.
- The 2 pre-existing `example-data-seeder-registry` (`features-page`) failures are from
  the CMS features-page seeder merged to `main` (#849–851), not this change.
