# ADR 0336 — Deep-linkable URLs for every list/grid item + honest notification targets

**Status:** implemented (2026-07-10 — Phases 1–4 + guard; net-new detail surfaces sequenced as follow-ons)

> **Renumbered 0334 → 0336 (2026-07-10):** this landed as 0334 but collided with a
> parallel session's `0334-canvas-document-rich-text-editor` (merged first, so
> canonical per `docs/adr/README.md`); `0335` was also taken (realtime canvas).
> Renumbered to the verified next-free slot. The `#1599` commit messages still say
> "ADR 0334" — immutable history; this file is the source of truth.
**Date:** 2026-07-10
**Depends on:** the react-router path/query routing model (`chrome/features.tsx`),
the `NotificationRecord.actionUrl` field (`backend/typescript/src/types.ts`), the
Funnels/Forms query-param deep-link precedent, and the CRM/Projects/Runs detail-route precedent.

## Context

A user report: "Any list or grid item across the app needs to resolve to its own
URL, and every notification 'view' needs to point to that URL. A notification that
an order shipped currently takes you to the commerce **tab**, not to the order.
That happens everywhere — the UX is terrible."

A five-cluster audit (commerce, agents/runs, knowledge/content, GTM + a full
notification emit-site sweep) found the machinery mostly **already existed** but
was unused or half-wired:

- **`NotificationRecord.actionUrl`** is the SPA deep-link a notification clicks
  through to. The bell drawer honored it; the full `/inbox` page **ignored it
  entirely** (only linked via `runId`) — so every comment / order / task / channel
  notification was unclickable there.
- Several emit sites hardcoded a **bare parent tab** (`/commerce`, `/campaigns`)
  even though the entity id was in scope at emit time.
- Some target pages could not resolve an id anyway (`/commerce` never synced its
  tab or org to the URL; `campaign-intel` read no params).
- ~10 list/grid surfaces lost item identity: local `useState` selection or a
  modal with no URL. ~21 surfaces were already URL-first (CRM, Projects, Runs,
  Funnels, Forms) — the app already had **both** correct patterns; the offenders
  simply didn't follow the house style.

## Decision

**One convention, two patterns, matched to the entity's weight.** A list/grid item
becomes URL-addressable by the pattern its surface already implies; a notification
`actionUrl` MUST point at the specific entity, never a bare parent tab.

### 1. Choosing the pattern

| Pattern | When | Reference |
|---|---|---|
| **Dedicated route** `/<feature>/<entity>/:id` | A heavy, standalone entity opened full-screen (rich detail / editing) | CRM `/crm/deals/:dealId?org=`, Runs `/runs/:runId`, and now `/commerce/orders/:orderId?org=` |
| **Query-param** `?item=<id>` (URL owns the selection) | In-page master/detail — the list stays visible beside a panel/filter | Funnels `?funnel=`, Forms `?form=`, and now Territories `?model=`, Dealers `?dealer=`, KB `?collection=`, Media `?collection=`/`?asset=` |
| **Reuse an existing route** | A real detail page already exists for the id | Roster rows → the existing `/agents/:rosterId` workspace (deleted the divergent guardrails modal) |

**Query-param selection is URL-source-of-truth**, not a one-shot hydrate: the
selection state DERIVES from `searchParams.get(...)`; writers mirror to the URL
with `{ replace: true }`; a param naming no loaded row reads as "no selection"
(validity guard). No dual local+URL state to drift. Org context rides a validated
one-shot `?org=` (fail-closed to the first accessible org — no existence leak).

### 2. The notification `actionUrl` contract

- Every notification's `actionUrl` MUST resolve to the **specific entity** (a
  query param or an interpolated id path segment), unless its target is a
  **resolver/landing page** whose context is inherently inline (`/inbox`, where
  the action-needed resolver renders in the row) or a single-purpose page
  (`/assistant/briefing`).
- **A bare multi-entity parent tab (`/commerce`, `/campaigns`, …) is forbidden**
  as an `actionUrl` — the entity id is dropped and the user re-scans a list.
- The FE guards a server-provided `actionUrl` before rendering it into a
  `<Link to>` (`notifications/isSafeActionUrl` — mirrors backend `isSafeInAppPath`:
  leading `/`, not `//`, no backslash/whitespace/control, bounded). Defense in
  depth across many emit sites.
- Both notification surfaces (bell drawer + full inbox) resolve `actionUrl`
  through the shared `notifications/actionLabels.ts` (per-type "View order /
  View purchase / View campaign …" labels), never a bare-page self-link.

### 3. Shared primitives (single owner)

- `notifications/actionLabels.ts` — `actionLabelKeyFor(type)` + `isSafeActionUrl`.
- `.is-deeplink-focus` (global.css) — the shared focus ring a `?param=<id>` deep
  link scrolls to + highlights; reused across features so the highlight reads the
  same everywhere.
- `features/commerce/commerceShared.tsx` — `OrderActions` (the money actions) is
  the ONE owner shared by the list row and the order detail page.

### 4. The guard (regression prevention)

A backend vitest guard (`test/notification-deeplink-guard.test.ts`) scans every
`getNotificationEmitter().emit(...)` site and fails if an `actionUrl` literal is a
bare, known multi-entity parent tab. New entity notifications must carry the id.
This is the durable enforcement of §2.

## Implementation record

| Phase | Scope | Evidence |
|---|---|---|
| 1 | Deep-link spine | `/inbox` honors `actionUrl` (guarded, never a self-link); shared `actionLabels.ts`; `/commerce` tab+org ride `?tab=`/`?org=`; labels ×4 locales + tests. Commit `1d9181bd`. |
| 2a | Commerce detail | `OrderDetailPage` at `/commerce/orders/:orderId?org=`; `OrderActions` extraction; product `?product=` + quote `?quote=` deep-links; repoint `commerce.order.paid`. Commit `9126f75b`. |
| 3 | Cheap wins + anti-patterns | Roster → reuse `/agents/:rosterId` (modal deleted); Territories/Dealers/Campaign-Brief URL-owned selection; `campaign.pacing` → `&campaign=<id>` + CampaignIntel highlight. Commit `69d5af84`. |
| 4 | Content leaves | KB `?collection=`; Media `?collection=`/`?asset=` (sentinel round-trip + validity). Commit `be3c364a`. |
| 5 | Guard + this ADR | `notification-deeplink-guard.test.ts`; `.is-deeplink-focus` shared ring. |
| 3-fo | Modal deep-links | Campaign Brief personas `?persona=`, Marketplace reviews `?pack=`, Production plans `?plan=` (+ optimistic status). |
| 4-fo | KB document reader | `?doc=` reader (on-demand `getDocument`; plain-text, no innerHTML). |
| 2b | UCP purchases surface | net-new `commerce-ucp-buyer` package (list + detail); repoint both `commerce.ucp-buyer.*`; guard PENDING now **empty**. |

## Follow-ons (all landed 2026-07-10)

> **Update (2026-07-10):** the three deferred implementation items below all
> shipped as follow-on commits; the guard's `PENDING` allowlist is now empty, so
> the convention is enforced with **zero deferred debt**. Only the optional
> `/inbox` scroll-to enhancement remains open (it is not a defect — the inline
> resolver is already the affordance).

- ~~**UCP purchases surface** (Phase 2b)~~ — **DONE**: `features/commerce-ucp-buyer/`
  (read-only list + `/commerce/purchases/:id?org=` detail); both notifications
  repointed; `PENDING` emptied.
- ~~**KB document reader** (`?doc=`)~~ — **DONE**: on-demand `getDocument` fetch
  (the list carries metadata only), rendered as plain text.
- ~~**Modal-based deep-links**~~ — **DONE**: Campaign Brief personas, Marketplace
  reviews, Production plans.
- ~~**`/inbox?notification=<id>` scroll-to**~~ — **DONE** (Rec Phase 3,
  2026-07-10): the assistant-approval + agent-escalation emits now build
  `/inbox?approval=${approvalId}` (the emit knows the approvalId but not its
  not-yet-issued notificationId, so `?approval=` is the resolvable key). The
  `/inbox` page honors `?notification=` (a row by its own id, bookmarkable) and
  `?approval=` (matches `metadata.approvalId`), resolving against the FULL list,
  **auto-switching to the tab that shows the target** (an `agent.escalation` is
  NOT action-needed, so it would otherwise be invisible on the default tab), and
  scroll+focusing the card with the DL-UX-2 ring (`tabIndex=-1`,
  `aria-current="location"`). Pure helpers live in
  `notifications/notificationDeepLink.ts` (unit-tested incl. the FE↔BE URL
  round-trip). **The convention now covers every inbox deep-link — zero deferred
  debt.**
- **Markdown Documents detail surface** — **DONE (2026-07-11, ADR 0350 Phase 1):**
  the KB reader above was a read-only plain-text render; the *authored* markdown
  Documents surface (`documents` feature, ADR 0053) opened only in an inline panel
  addressed by a one-shot `?doc=&org=` query. It now has its own full-screen route
  `/documents/:documentId?org=` with real `<Link>` cells and a legacy-`?doc=`
  redirect. This is the net-new detail surface this ADR sequenced as a follow-on;
  the editor/store follow-ups (markdown-native editor, opt-in promote-to-rich) are
  Phases 2–3 of **ADR 0350**.

## Recommendation-remediation phases (2026-07-10)

The recorded grade-pass gaps were worked to closure as Rec Phases 1–4 (each with
an `/architect` pre-check + `/code-review`/`/ux-review`):

| Rec Phase | Closes | What shipped |
|---|---|---|
| 1 | DL-P-1, DL-UX-7 | KB `DocReader` — 40k-char word-boundary preview + full-document reveal (`key={docId}` resets it); `72vh` reader max-height on ≥920px viewports. |
| 2 | DL-UX-4/5/6 | ONE shared type→glyph map (`notificationIcons.tsx`) for drawer + page; `PurchasesPage` `.filterbar` + status facet + zero-match state; shared `DeepLinkMissNotice` across 6 selection surfaces. |
| 3 | `/inbox` scroll-to | The `?notification=`/`?approval=` inbox deep-link above. |
| 4 | DL-T-1b, DL-C-3 | Render tests for `OrderDetailPage`/`PurchaseDetailPage` (derived-pair fetch, fail-closed on missing `?org=`, 404, access-gate) + inbox derivation + FE↔BE round-trip tests; extracted `notificationDeepLink.ts`; gated both detail-page loads on `access.enabled`. |

## No RFC needed

Pure host/FE work over the existing non-normative `/v1/host/openwop-app/*`
surfaces and the existing `actionUrl`/`runId` notification fields. No wire shape,
capability advertisement, event type, or normative behavior changes. Per
`CLAUDE.md` § "A spec change needs an RFC" this is host work; no `../openwop` RFC.

## Alternatives weighed

- **Full detail pages everywhere** — rejected: the app already proves query-param
  master/detail is the right, lighter UX for in-page surfaces (Funnels/Forms);
  forcing a route on every item is heavier than the layout warrants.
- **Minimal `?item=` deep-links only (no new pages)** — rejected for the flagship
  case: orders/agent-purchases had NO detail to open, so a highlight on a list you
  can't expand isn't "best UX." Orders got a real detail route.
- **One-shot hydrate + local state** (vs URL-source-of-truth) — rejected for the
  query-param surfaces: it re-introduces the dual-state drift the whole program
  removes. Kept URL-as-source-of-truth (Funnels reference).
