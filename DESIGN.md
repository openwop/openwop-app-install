# OpenWOP Reference App — Design Standards

> Source of truth for `frontend/react/`'s design system — **self-contained**. Reviewed by `/ux-review`.
>
> Covers the full system: the editorial tokens (§2), app-functional tokens (§3), components (§5), animations (§6), and framework-integration rules (xyflow §7, Firebase Auth §8). Canonical token *values* live in `frontend/react/src/styles/global.css :root` and are reproduced in §2 so this doc stands alone.
>
> **Lineage (not a dependency):** the editorial palette + type triple originate from the OpenWOP brand, historically shared with the marketing site (now [`openwop/openwop-site`](https://github.com/openwop/openwop-site)). They are reproduced here as the app's own — there is **no cross-repo sync obligation**. If you re-brand this app (white-label), change the tokens here + in `global.css :root`; nothing else needs to move in lockstep.

---

## 1. Purpose & audience

`frontend/react/` is the reference deployment behind `https://app.openwop.dev/`. It exists so protocol implementers and evaluators can exercise the v1 wire contract without cloning the repo — workflow building, run lifecycle, SSE event streaming, HITL interrupts, capability discovery, BYOK paste-and-run.

Visual register: **the same editorial-technical voice as the marketing site**, applied to an interactive surface. **Heading typography is SANS (2026-06-05, David's directive): every header — page titles, card/section/modal titles, entity names — sets `var(--sans)` at weight 600 (section/entity heads) or 700 (the page-marquee `<h1>`).** *(Correction 2026-06-11: the contract previously read "650–700", but Geist is a STATIC family — it has no 650 instance and the 700 master wasn't loaded, so the browser silently faux-bolded the most prominent type on every page. Fixed: the font now loads `;700`, every `650` snapped to the real `600` master, and weights run on the `--weight-*` ladder — 400 body / 500 emphasis / 600 head / 700 marquee — with `font-synthesis: none` so a future gap fails loud.)* The serif (`var(--serif)`) survives only as deliberate accents: the brand wordmark, the figure-tile numerals (now the shared `<KeyFigureBand>`, §5.1), the gate product name, and the ledger's italic persona names. Do not reintroduce serif headers. Where the marketing site is read once, the app is operated. Editorial discipline applies to chrome, navigation, headings, status, and labels; the workflow canvas is allowed denser geometric tooling.

---

## 2. Editorial tokens (canonical)

The canonical values live in the `:root` block of `src/styles/global.css`; they are reproduced here so this doc is self-contained. These are the app's own tokens (brand lineage per the header) — change them in both places when re-branding; there is no other surface to keep in sync.

**Editorial palette + type triple** (light theme):

```css
--paper:  #f4f1ea;  --paper-2: #ece8de;          /* surfaces */
--rule:   #d9d4c5;  --rule-2:  #c4bfae;          /* hairlines / grid */
--ink:    #1a1a17;  --ink-2:   #4a4842;  --ink-3: #66624f;  /* text (ink-3 = AA muted ≥4.5:1) */
--clay:   oklch(58% 0.13 40);   /* the one brand accent */
--clay-soft/-text/-strong/-rule/-wash/-glow/-bg-hi  /* clay alphas + the AA text/fill variants */
--star-glow: oklch(80% 0.15 80);  --ink-shadow: rgb(26 26 23 / 0.18);
--surface-hi: rgb(255 255 255 / 0.55);  /* the depth-layer inset top-highlight (dark: low-alpha white) */
--serif: "Instrument Serif", serif;   /* brand wordmark + figure numerals only */
--sans:  "Geist", ui-sans-serif, system-ui, sans-serif;   /* headers + body */
--mono:  "Geist Mono", ui-monospace, monospace;   /* eyebrows, metadata, status */
```

**Type scale + weight ladder + leading** (2026-06-11 — the previously un-tokenized axis):

```css
--text-display 28px · --text-title 22px · --text-subtitle 18px · --text-lg 16px
--text-body 14px (base) · --text-sm 13px · --text-eyebrow 11px
--weight-body 400 / --weight-emphasis 500 / --weight-head 600 / --weight-marquee 700
--leading-tight 1.12 (heads) · --leading 1.45 (UI body) · --leading-prose 1.6
```

**Motion tokens** (§6 — the curve + duration vocabulary, one source of truth):

```css
--ease-standard (UI transitions) · --ease-enter (reveals) · --ease-stamp (completion press)
--dur-micro 120ms · --dur-ui 150ms · --dur-stamp 280ms · --dur-enter 380ms
```

**Depth layer (§5.5 r4):** `.surface-card` / `.figure-band` lift off flat paper with a
near-threshold `--paper`→`--paper-2` wash + a 1px `--surface-hi` inset highlight;
interactive cards add a pointer `translateY(-2px)` + soft `--clay-glow` shadow on hover.

**Dark theme** lifts the palette via `@media (prefers-color-scheme: dark)` + a per-user `.theme-dark`/`.theme-light` override (`<ThemeToggle>`, §5.1); functional tokens lift too (§3 rule 2). `color-scheme` is set per theme so native chrome follows (§3 rule 4).

**Geometry:** `--radius` 8px (controls: buttons/inputs) · `--radius-lg` 14px (containers: cards/queue/tiles/modals) · `--radius-bubble` 16px · `--radius-pill` 24px · `--space-1..6` (4/8/12/16/24/32) + half-steps `--space-1-5` 6px, `--space-2-5` 10px. Button accent hierarchy: `.btn-accent-solid` (clay fill, `--paper` text — page CTA + queue Approve) > `.btn-accent` (clay-soft — in-row primaries) > `.secondary` outline.

**App-functional tokens** (`--color-success`/`-warning`/`-danger`/`-ai`/`-info`) are defined in §3 — they surface run state, which only this app has. **Legacy aliases** (`--color-bg`, `--color-surface`, `--font-sans`, …) in §4 are transitional and shrink as references migrate to canonical names. Status colors are **functional, not brand**.

---

## 3. App-functional tokens

```css
--color-success: oklch(62% 0.13 145);   /* desaturated forest, on-paper safe */
--color-warning: oklch(72% 0.14 75);    /* warmer amber, neighbour of --star-glow */
--color-danger:  oklch(55% 0.16 28);    /* muted brick red */
--color-ai:      oklch(60% 0.12 280);   /* indigo for the AI node category and the "pipeline" template badge; distinct from clay (flow) and the success/warning/danger triad */
--color-info:    oklch(58% 0.12 240);   /* azure — informational / dispatch accent (run-handoff "output.harvested", pack "vendor" flag, publish banner); distinct from --color-ai (280) */
--scrim:         rgb(0 0 0 / 0.6);      /* modal backdrop; intentionally neutral on either theme */

/* Node-category accents — five well-spread editorial hues on the same
 * lightness/chroma band, so builder categories + run/handoff maps stay
 * distinguishable while belonging to the system. flow reuses clay; ai reuses
 * the functional indigo. Consumed only via entry.accent (CSS-value contexts). */
--cat-flow:        var(--clay);            /* hue 40  — clay   */
--cat-data:        oklch(62% 0.13 145);    /* hue 145 — forest */
--cat-control:     oklch(72% 0.14 75);     /* hue 75  — amber  */
--cat-ai:          var(--color-ai);        /* hue 280 — indigo */
--cat-integration: oklch(62% 0.11 195);    /* hue 195 — teal   */
```

Rules:

1. **Use functional tokens only for run-state semantics.** A button doesn't get `--color-danger` for emphasis — it gets clay. `--color-danger` is reserved for `RunStatus = failed | cancelled`, error banners, and the destructive secondary state of confirm dialogs.
2. **Status colors lift in dark mode** (rule 2 below): success → `oklch(72% 0.14 145)`, warning → `oklch(80% 0.14 75)`, danger → `oklch(65% 0.16 28)`, ai → `oklch(70% 0.12 280)`, info → `oklch(68% 0.12 240)`. Keep the chroma; lift the luminance. These lifted values are now in the `@media (prefers-color-scheme: dark)` + `:root.theme-dark` blocks in `global.css` (now active).
3. **Never use a status color as a background fill at body weight.** Surface as an icon, a dot, a label, or a hairline. Backgrounds compete with `--paper`.
4. **Native chrome follows the theme via `color-scheme`.** `global.css` sets `color-scheme: light` on `:root` and `color-scheme: dark` in both dark blocks (`@media` + `.theme-dark`) so the browser paints scrollbars, form-control internals, and autofill for the active theme — without it, dark mode shows a glaring light scrollbar track even though every painted pixel is dark. On top of that, a global token-driven scrollbar rule (`scrollbar-color: var(--rule-2) transparent` + matching `::-webkit-scrollbar-*` for Safari) keeps every scrollbar — page and inner panes — on the palette in both modes. Don't restyle scrollbars per-component.

---

## 4. Legacy aliases (transitional)

The app's pre-migration tokens are aliased to the shared palette:

```css
--color-bg:           var(--paper);
--color-surface:      var(--paper);
--color-surface-2:    var(--paper-2);
--color-border:       var(--rule);
--color-text:         var(--ink);
--color-text-muted:   var(--ink-3);
--color-accent:       var(--clay);
--color-accent-hover: oklch(54% 0.13 40);
--font-sans:          var(--sans);
--font-mono:          var(--mono);
```

These exist so the Phase A token swap is atomic — every existing component keeps rendering. **Subsequent phases migrate references off the aliases:** `var(--color-bg)` → `var(--paper)`, `var(--color-text)` → `var(--ink)`, `var(--color-accent)` → `var(--clay)`. When zero references remain to a given alias, delete the alias.

Do not add new references to the alias block. Net new code uses canonical names.

---

## 4.5 Composition principles — the workforce glow-up canon (2026-06-04/05)

Distilled from the agents-page redesign (PRs #585–#592, validated against the
Claude Design prototype crop-by-crop). These govern EVERY surface, not just
`/agents` — a page that violates one of these is a defect, not a style choice.

1. **Decision-first, inventory second.** What needs the HUMAN renders at the
   top (the `/agents` "Needs you" queue); the catalog/list below. A page whose
   first screenful is undifferentiated inventory buries its reason to exist.
   Celebrate the empty queue ("You're all caught up") — don't render nothing.
2. **Stats are filters.** A number worth a tile is worth clicking: key-figure
   tiles both report a count and narrow the list (`aria-pressed`, left clay
   bar when active, amber numeral + glyph for attention states). Never ship a
   static stat band next to a separate dropdown asking the same question.
3. **Radius hierarchy.** `--radius-lg` (14px) for containers — cards, queues,
   tile bands, modals; `--radius` (8px) for controls — buttons, inputs,
   selects; pills stay fully rounded. One flat radius reads as unfinished;
   a 2px input next to a 14px card reads as broken.
4. **Accent CTA hierarchy.** `.btn-accent-solid` (clay fill, `--paper` text —
   the avatar-initials precedent, theme-safe) for THE action on the page
   (page CTA, Approve & resume); `.btn-accent` (clay-soft) for in-row
   primaries; `.secondary` outline for everything else. A paper-white fill is
   never the loudest element — selection states use SOFT accent, not solid.
5. **Toolbars are one row.** Search grows, selects hug content
   (`.filterbar` — the global `input/select { width: 100% }` baseline must be
   scoped away in toolbars). Stacked full-width filter controls are a defect.
6. **Rows at fleet scale, with honest sub-lines.** Past ~5 homogeneous
   entities, dense rows beat card grids. The contextual sub-line composes
   from REAL fields only (the working card's title, the next schedule's
   label) — never fabricated progress, counts, or prose the store can't back.
7. **Status is a system: dot + ring + chip.** Status chips lead with a
   `currentColor` dot; avatars carry a 2px status ring (`statusRingColor`);
   the same family colors drive tiles, chips, and rings so one glance reads
   one way everywhere. Address the operator as "you" ("Waiting on you").
8. **Whitespace does work.** Group repetition instead of padding it (the
   ledger collapses consecutive same-agent/same-workflow runs into "6 runs ·
   4d ago"); major bands separate by `--space-5`; colliding borders between
   sibling containers are a layout bug.
9. **Quick-look before navigation.** Reviewing an entity should not leave the
   list: a right drawer composing the entity's existing panels, deep-linkable
   via URL params (`?agent=&tab=`), Esc/scrim close, with "Open full
   workspace →" always present. The drawer never grows a second copy of a
   full surface (no embedded chat).
10. **Real timestamps, compact form.** Time pills derive from store fields
    (`createdAt`, `updatedAt`) and render compact ("13h", "6 runs · 4d ago").
    If the store can't date it, the UI doesn't claim it.

## 5. Components — app-specific canonical list

The shared `.btn`-family + chrome primitives are defined in `global.css`. The list below is app-specific.

| Class | Purpose | Notes |
|---|---|---|
| `.app-shell` | top-level flex **row** wrapper | min-height 100vh; `[.app-sidebar][.app-body]` |
| `.app-sidebar` | persistent left navigation rail (`src/chrome/Sidebar.tsx`) | sticky full-height column on `--paper-2` with a `--rule` right border (`--sidebar-w`); brand + workspace/org switcher (top) → grouped `Workspace`/`Author` workspace nav + a single pinned `Admin` entry (the admin tier lives inside `<AdminLayout>`'s embedded rail) with Lucide icons (scroll) → account chrome `.app-sidebar-foot` (bottom). Nav derives from the feature manifest (`src/chrome/features.tsx`) — routes, tiers, groups, and width chrome are declared there once. Collapses to an icon-only strip (`.is-collapsed`, `--sidebar-w-collapsed`, persisted to `localStorage`); becomes an off-canvas drawer ≤860px (`.app-sidebar-launcher` + `.app-sidebar-scrim`). Active item via `.app-nav-link.is-active` (clay-soft tint + clay text + `aria-current`); `:focus-visible` ring added for the anchor links. Replaces the former top-nav + `NavDropdown` |
| `.app-body` | content column right of the rail | flex column (`min-width:0` so wide tables/canvas shrink rather than force page scroll); holds `DemoHostBanner` + `.app-main` + `.app-footer`. Under `.app-shell--ai` it locks to viewport height so the chat feed owns the scroll |
| `.app-workspace-switcher` | workspace switcher at the rail head (ADR 0015) | live switcher: mono eyebrow + a native `.app-workspace-select` listing the caller's workspaces (personal + shared) with a `+ New workspace…` option (`src/chrome/WorkspaceSwitcher.tsx`). Switching re-binds the session tenant + reloads. Falls back to a static `/orgs` link (chevron) before the list loads / for anonymous visitors |
| `.app-workspace-block` | column wrapper holding the switcher + the reveal-on-demand create input | flex column; lets `.app-workspace-create` sit directly under the switcher |
| `.app-workspace-select` | borderless native `<select>` for the active workspace | inherits the switcher's `--ink`/transparent surface; own `:focus-visible` ring (`--clay`) |
| `.app-workspace-create` | inline "new workspace" name input revealed under the switcher | Enter to create, Esc to cancel; cancels on blur only when empty (a half-typed name survives accidental focus loss); `--paper` on a `--clay-rule` border, `--ink-3` placeholder, token-only |
| `.app-workspace-manage` | trailing icon-link to `/orgs` (members & roles) in the switcher row | `--ink-3` Lucide `Settings` glyph → `--clay-text` on hover; restores the management path; hidden in the collapsed rail |
| `.app-main` | scrollable content region inside `.app-body` | inherits `--paper`; carries the dot-grid + `.page-enter` (§5.5) |
| `.app-footer` | minimal footer | mono attribution, paper |
| `.card` | generic surface card | border-only via `--rule`; no shadow; hover tint `--clay-wash`; matches `.compare-card` register |
| `.status-badge` + `.completed` / `.failed` / `.cancelled` / `.running` variants | run-state pill | mono label; functional color from §3; no fill — color on `--paper-2` |
| `.muted` | low-emphasis text | `var(--ink-3)`; mono OR sans depending on context |
| `.secondary` | secondary button surface | matches `.btn-ghost` register |
| `.chat-feed` + `.message-bubble.user` / `.message-bubble.assistant` | chat surfaces | bubble: clay for user, paper-2 for assistant; metadata rendered in mono `--ink-3` |
| `.builder-canvas` | xyflow workflow-canvas wrapper | scopes all `--xy-*` token overrides + the run-edge/grid styling (see §7); the wrapper class in `src/builder/canvas/BuilderCanvas.tsx` |
| `.interrupt-card` | HITL interrupt surface | matches `.compare-card` register; clay-rule top border to mark "action required" |
| `.byok-wizard` | BYOK step-through | progressive disclosure; `<abbr>`-expand acronyms per step (§9 acronym rule) |
| `.signin-button` (Google / GitHub variants) | auth chrome | wraps vendor brand SVG marks; container is ink-on-paper; **brand marks themselves are never re-colored** (§8) |
| `.demo-host-banner` | "you're on the demo host" banner | clay-wash background, mono marker, dismissible |
| `.env-chip` + `.env-chip-{info,warning,danger,muted}` | envelope-events timeline chip (RFC 0030/0031/0032/0033) | left rule-rail tinted with the variant's functional token; mono `.env-chip-tag` color matches; body in ink-2; pill / quote / detail sub-elements stay paper-on-paper to keep the bubble calm when chips stack |
| `.envelope-events` | the in-bubble timeline wrapper holding stacked `.env-chip` rows | column flex with 6px gap; sits between `MessageRenderer` and `AgentEventCards` inside `MessageBubble` |
| `.reasoning-disclosure` | RFC 0030 §A `<details>` for the `envelope.payload.reasoning` string | distinct from `ThoughtsDisclosure` — uses an `ⓘ` info glyph (vs `…` ellipsis), dashed top divider, AI-coloured left-bar on the open body |
| `.prompt-tier-one-chip` | Tier-1 subset finding on a schema-hint prompt (RFC 0030 §B) | warning-tinted mono chip; appears on the prompt-list-item card; pairs with a banner above the list when `capabilities.envelopes.tierOneSubsetCompliance` is `strict` / `warn` |
| `.inline-link` | bare inline text-`<a>` keyboard focus ring | opts an in-text `<Link>`/`<a>` into the `--clay`/`--color-accent` `:focus-visible` ring (the global ring covers `a.surface-card` but not text links); outline + 2px offset only, no color/weight change |
| `.wf-track` (+ `-node` / `-seg` / `-stop` / `-dot` / `-label`, `--compact`) | the **autonomy track** — the 3-stop trust-journey rail on `/workforces` (Watching → Assisting → Running on its own) | flat selectors, token-only; current stop = `--clay` dot + `--clay-wash` halo, done = `--clay-soft`, future = hollow `--rule-2`; rendered by `workforces/AutonomyTrack.tsx`. The page's signature visual |
| `.wf-outcomes` / `.wf-outcome-n` / `.wf-outcome-l` / `.wf-gate` | business-outcome readout on `/workforces` (the "what it's done for you" block) | `-n` is the Instrument-Serif numeral (`--serif`, tabular-nums), `-l` the `--ink-3` label; `.wf-gate` is the plain next-step sentence under the track |

### 5.1 Shared UI primitives — the cross-surface cohesion layer (`src/ui/`)

These exist so every surface (Chat, Agents, Workflows, Runs, Kanban, Roster, Org-chart, Registry, Settings, …) reads as **one** product instead of a dozen bolted-together apps. The failure mode they fix: a surface reimplementing a card/chip/notice/page-title with inline styles + hardcoded hex that bypass the token layer. That failure mode is now also a BUILD failure: `scripts/check-tsx-color-literals.mjs` rejects any raw hex/oklch/rgb literal in `.ts/.tsx` outside the sanctioned brand/icon files (white-label PRD §6). Defined once in `global.css`, plus the React primitives in `src/ui/` (`PageHeader`, `StateCard`, `Notice`, `Markdown`, `MarkdownEditor`). **Reach for these before hand-rolling an inline-styled widget.**

| Class / Component | Purpose | Notes |
|---|---|---|
| `.surface-card` | the one list/dashboard card primitive | clone of `.workflow-card`: `--color-surface` bg, `--rule` border, `--radius`, `--space-3 --space-4` padding, hover → `--clay` border / `--paper-2`, `:focus-visible` ring. Navigational cards render as `<a>` / `<Link>` so keyboard + semantics come free |
| `.card-grid` | responsive card grid | `repeat(auto-fill, minmax(280px, 1fr))`, `--space-3` gap, single column ≤ 640px |
| `.action-bar` | button-cluster wrapper | flex + wrap + `--space-2` gap; the one way to group Open / Run / Delete actions so they read as parallel |
| `.btn-sm` | small button size | 12px / `--space-1 --space-2`; replaces ad-hoc inline `fontSize` on buttons |
| `.chip` + `.chip--{success,warning,danger,accent,ai,muted}` | status / source / label chips | 12px pill; color families are token-driven (no hex); pairs a Lucide icon + text label so color is **never** the sole signal (§11) |
| `.nav-badge` + `.nav-badge--beta` | feature-maturity badge on a nav item (Sidebar · admin rail · ⌘K) | the **nav-scale sibling of the `.chip` warning family** — a smaller 10px uppercase pill that fits the 13px nav row. `--beta` is warning-toned (`color-mix(var(--color-warning) …)`, no hex) and carries the text "Beta" so color is never the sole signal (§5.3, §11). Rendered by `useFeatureBadge()` when a feature-gated nav item's toggle resolves enabled + `status:'beta'`; hidden when the rail is collapsed |
| `.ui-input` | text-input baseline | `--space-2 --space-3` padding, `--rule` border, `--radius`; opt-in class (avoids regressing the many bare `<input>`s elsewhere) |
| `.surface-form` | inline "add" toolbar above a `DataTable` (CRM · CSM · Users) | a wrap-row of `<label>`/`.field` items, each `flex: 1 1 12rem` so the global `input{width:100%}` baseline doesn't stack them into a tall column; submit button trails baseline-aligned. Add `.is-narrow` to a short field (a 0–100 score). Use on a `.surface-card` (the compound selector beats the card's column direction). Replaces the hand-rolled `surface-card u-flex u-wrap u-items-end` add-forms that blew out into a giant empty card |
| `.tabs` + `.tab` | in-page tab strip (CRM Contacts/Companies/Deals/Tasks) | editorial underlined strip: `--rule` baseline, `--clay` active marker on `[aria-selected="true"]`, ink-3 → ink on hover. Replaces hand-rolled `btn-primary`/`btn-ghost` tab rows (which read as heavy paper blocks). `role="tablist"` + `role="tab"` on the buttons |
| `.state-card` + `<StateCard>` (`src/ui/StateCard.tsx`) | empty / loading / error block | dashed border, optional Lucide `icon`, title, one-line body, and **one** next-action CTA. Every empty state MUST name its single next action |
| `<Notice variant=success\|error\|info\|warning>` (`src/ui/Notice.tsx`) | transient notice | renders `.alert.{variant}` + a leading Lucide icon + `role="status" aria-live="polite"` — never bare colored text, never a hardcoded hex, never a `⚠`/`✓` emoji prefix |
| `<KanbanBoardView>` (`src/kanban/KanbanBoardView.tsx`) | the ONE Kanban board renderer | shared by `/boards` (KanbanPage) and the embedded agent-workspace Board tab. @dnd-kit drag-and-drop (pointer + keyboard sensor) + rich cards (source chip, workflow name, priority, run link) + trigger-lane affordance. A surface MUST NOT reimplement a second board |
| `<CommentsPanel>` (`src/features/comments/CommentsPanel.tsx`) | the ONE comment-thread renderer (ADR 0021) | self-loads a `(orgId, resourceType, resourceId)` thread over `commentsClient`; add / reply / resolve-reopen / delete, status as a labelled `.chip` (§5.3), `<Notice>` + `toast` feedback, `<StateCard>` empty. Backs the standalone `/comments` page now; **embeds in the CMS editor + KB collection view next**. A surface MUST NOT reimplement a second comment thread |
| `ActionCard` (`src/notifications/ApprovalsInbox.tsx`) | the ONE approval action card (ADR 0023 §12 T4) | renders an assistant-action `PendingApproval` as a `.surface-card`: kind `.chip` + severity chip (`chip--danger/--warning/--muted` with the visible `risk: <level>` label, §5.3) + taint/edited `chip--muted` banners, destination, draft preview with inline-edit `textarea`, recipient diff, why-recommended, source citations (`safeHref` — http(s) only; untrusted URLs render as text), Approve/Reject/Edit `.action-bar`. Lives inside the polymorphic `<ApprovalsInbox>` (run-proposals render a compact row; assistant-actions render this card). A surface MUST NOT reimplement a second approval renderer |
| `<AgentTile>` (`src/agents/AgentTile.tsx`) | the agent **profile tile** — the default `/agents` management view (IA refresh 2026-06) | `.surface-card` in a `.card-grid`: avatar + status ring, name + status `.chip`, role, a contextual sub-line, `<AutonomyMeter>`, board counts, and Check-now/Chat/primary `.action-bar`. Shares `primaryAction`/`subLine` (exported from `RosterRow`) with the dense `<RosterRow>` list-toggle so tiles and list never diverge. Composed from existing primitives — no bespoke tile CSS |
| `<WaitingBlockers>` (`src/notifications/WaitingBlockers.tsx`) | the Inbox "waiting on the board" section (IA refresh 2026-06) | lists agents whose board has a card parked in the Waiting lane (`loadAgentViews` → `status==='waiting'`): avatar, blocker note, **"Open board"** — no resume API, so the affordance is honestly just navigation, never an approval action. Sits beside `ActionCard` in the Inbox action portal; display-only, MUST NOT reimplement an approval path |
| Briefing card + `BriefingRow` (`src/features/assistant/AssistantPage.tsx`) | the ONE source-grounded briefing surface (ADR 0023 §12 T3) | `.surface-card` over the batched `/assistant/briefing` read: headline, at-risk lane, top priorities, today's meetings; every line carries its "why surfaced" + a cited source link (`safeHref`) and a `chip--muted` marker for connected-source items. `SkeletonRows` placeholder while loading |
| Assistant-health card (`src/features/assistant/AssistantPage.tsx`) | admin-only operating-metrics card (ADR 0029) | `.surface-card` shown only when `GET /assistant/health` resolves (403 ⇒ hidden — never surface an action that would fail); approval/edit/citation/taint rates + commitment staleness in prose, no bespoke chart machinery |
| `<GovernancePanel>` (`src/features/connections/GovernancePanel.tsx`) | the ONE workspace-policy editor (ADR 0028) | superadmin-only `.surface-card` on the Connections page (hidden on 403): provider-allowlist checkboxes + per-action-kind policy `<select>`s (labels wrap the controls), save via `.action-bar` + `toast` feedback. A surface MUST NOT reimplement a second policy editor |
| `<Markdown>` (`src/ui/Markdown.tsx`) | read-only GFM renderer | `react-markdown` + `remark-gfm` via the shared `chat-md` prose class; XSS-safe (no `rehype-raw`; unsafe link protocols stripped); links open in a new tab, task-list checkboxes disabled. The one way to render agent prose (descriptions, instructions, task details) |
| `<PageHeader>` (`src/ui/PageHeader.tsx`) | the one editorial page-title primitive | mono uppercase `eyebrow` kicker (`--ink-3`) + **sans 700 `title`** (`--text-display`, out-ranks the cards below; *corrected from "Instrument-Serif" per §1's 2026-06-05 sans directive*) + one-line sans `lede` (≤ 64ch) + right-aligned `actions` (`.action-bar`), over a hairline rule. Separated from page content by the `--space-5` band. Every top-level page leads with this instead of a bare `<h1>`/`<h2>` |
| `<KeyFigureBand>` (`src/ui/KeyFigure.tsx`) | the one key-figures surface (§4.5 "stats are filters") | serif tabular `--text` numeral over a mono uppercase label, in a bordered depth-band. Pass `onToggle`+`activeKey` to make tiles **`aria-pressed` filters** of the data below; `tone:'attention'` tints an at-risk numeral amber. Replaces bespoke `run-stat`/`wf-figure`/`wforce-metric`. |
| `.page-stack` (CSS) | the page major-section band | `display:grid; gap:var(--space-5)` — the documented 24px band rhythm given a class. Wrap a page's major sections in it; reserve `u-gap-4/3` for INTRA-section grouping. |
| `<MarkdownEditor>` (`src/ui/MarkdownEditor.tsx`) | Markdown editing surface | textarea + formatting toolbar (icons from `ui/icons`), Write/Preview toggle (preview via `<Markdown>`), character count, optional `localStorage` draft autosave + recovery; `compact` trims the toolbar for small surfaces (board cards). Backs the structured system-prompt editor (`agents/StructuredPromptEditor`) |
| `<DataTable>` (`src/ui/DataTable.tsx`) | the ONE tabular-data primitive for the operate surfaces (Runs, Memory, Orgs, …) | generic `columns` config + `rows` + `rowKey`; sticky `--paper-2` mono header, click-to-sort columns (opt-in per column via `sortValue`, `aria-sort` + clay caret), `comfortable`/`compact` density axis, optional `onRowClick` (renders rows as `.data-row--clickable`), built-in `empty` slot, and opt-in **bulk-select** (`selectable` + a **controlled** `selected: Set<string>` + `onSelectionChange`): a leading checkbox column with select-all (indeterminate), `.is-selected` row tint, and a `.data-bulkbar` action bar (via `bulkActions(selectedRows)`) above the table when ≥1 selected. Styling under `.data-table` (`global.css`); token-only. A surface MUST NOT hand-roll a second sortable table — adopted on Runs (sortable) + Memory (bulk-delete) |
| `<DensityToggle>` (`src/ui/DataTable.tsx`) | comfortable/compact segmented control | pairs with `<DataTable density>`; reuses `.segmented`. Persist the choice per-surface in `localStorage` |
| `<CommandPalette>` (`src/ui/CommandPalette.tsx`) | app-wide ⌘K / Ctrl+K jump-to-anything | mounted once at the app shell; manages its own open state + global hotkey, and also opens on a `window` `openwop:cmdk` event (the rail's `.app-cmdk-trigger` "Search" button dispatches it). Substring-filters across every nav destination + a few quick actions (drawn from `NAV`, derived from the feature manifest `chrome/features.tsx`), full keyboard control (↑↓ + Enter, Esc), clay-tinted active row. Token-only `.cmdk-*` styling. The manifest is the single source of truth for routes + nav, so the palette, rail, and router never drift |
| `<ModalPortal>` (`src/ui/ModalPortal.tsx`) | EVERY full-page scrim (modals, drawers) | renders at `document.body` — `.page-enter`'s filled transform animation makes page sections CONTAINING BLOCKS for `position: fixed`, so an inline scrim centers on the content column instead of the viewport (the create-board bug, 2026-06-05). Scrims carry `backdrop-filter: blur(6px)` per the design reference |
| `<IconButton>` (`src/ui/IconButton.tsx`) | icon-only buttons | the REQUIRED `label` prop becomes `aria-label` + default `title` — the type system makes an unlabeled icon button unrepresentable (white-label PRD §9). Default `.icon-button` chrome (borderless 28px hit target); pass `className` to ride an existing chrome (`.admin-rail-toggle`, `.app-sidebar-collapse`) |
| `<IllustrativeBadge>` (`src/ui/IllustrativeBadge.tsx`) | demo honesty | pin on any panel showing SAMPLE (not store-derived) data so a demo never masquerades fabricated numbers as real. The stock app ships zero (all surfaces derive from live stores); white-label forks add them wherever they stage sample content. Disabled-with-reason is the sibling convention: a dead control is `disabled` + `title="why"`, never a silent no-op click |
| `toast` + `<Toaster>` (`src/ui/toast.tsx`) | ephemeral async-feedback layer | imperative `toast.success/error/info/warning(msg)` from anywhere; `<Toaster>` is mounted once at the app shell, stacks bottom-right, auto-dismisses (errors linger longer), `role=alert` for errors else `role=status`. Reuses the `.alert.*` colour families with `.toast` layout overrides; leads with a Lucide icon (never an emoji). **Distinct from `<Notice>`** — `<Notice>` is inline/persistent/in-flow; toasts are transient and never block |
| `<Skeleton>` + `<SkeletonRows>` (`src/ui/Skeleton.tsx`) | content-shaped loading placeholders | a faint shimmering block in `--rule` tones (shimmer honours `prefers-reduced-motion`); `<SkeletonRows count columns>` fills a `<DataTable>`'s loading state. Replaces bare "Loading…" text on list/detail loads — first adopted on the Runs table |
| `<ThemeToggle>` (`src/ui/ThemeToggle.tsx`) | per-user light/dark/system theme override (§3) | three-way segmented (System/Light/Dark, Lucide `Monitor`/`Sun`/`Moon`), persisted to `localStorage`; toggles `<html class="theme-dark\|theme-light">` (the warm-dark token override keys off it + `@media`). An inline script in `index.html` applies the saved class before first paint (no flash). Lives in the sidebar foot |

Global focus ring: `button`, `button.secondary`, `select`, `input`, `textarea`, `[role=button]`, and `.surface-card` all receive `outline: 2px solid var(--color-accent); outline-offset: 2px` on `:focus-visible` (one block in `global.css`). New interactive elements inherit it.

Half-step spacing tokens: `--space-1-5: 6px` and `--space-2-5: 10px` cover the genuine micro-gaps authors reach for; **all** spacing still comes from the `--space-*` set — never inline a raw rem.

### 5.2 Iconography — the app-wide Lucide icon set (`src/ui/icons`)

- **One icon vocabulary.** Every UI icon is an inline-SVG component adapted from Lucide (Apache-2.0) under `src/ui/icons/`, re-exported from `src/ui/icons/index.ts`. Props: `{ size?: number; strokeWidth?: number; style?: CSSProperties }` (`CircleIcon` adds `filled?`). Icons render `stroke="currentColor"`, so they inherit the surrounding text color — place them in a span with the desired color, or where the color already applies.
- **No emoji as UI icons — anywhere.** An emoji rendered as a decorative/affordance glyph is a bug; use a component from `ui/icons`. Add a new icon by copying an existing `<Name>Icon.tsx`, pasting the Lucide path, and re-exporting from `index.ts`. **Exempt** (these are not icons): prose mentions of a symbol (e.g. "drop a card into a ⚡ trigger lane" describing the column's `ZapIcon`), keyboard-shortcut hints (`⌘`, `⌗`), ASCII-art diagrams, and bullets (`•`).
- **Canonical mappings** (the vocabulary): status `✓`/`✕`/`⏸`/`●`/`○` → `Check`/`X`/`Pause`/`Circle`(`filled` for ●); disclosure `▸`/`▾` → `ChevronRight`/`ChevronDown`; back-links `←` → `ArrowLeft`; feedback `👍`/`👎`/`🚩` → `ThumbsUp`/`ThumbsDown`/`Flag`; `🔧`/`🛠` → `Wrench`; `🔒` → `Lock`; `✎` → `Pencil`; `🗑` → `Trash`; `⚙` → `Settings`; `ⓘ` → `Info`; `📎` → `Paperclip`; `📋` → `Clipboard`; `💾` → `Save`; `⚖` → `Scale`; `💭` → `MessageSquare`; `☰` → `Menu`; `↻` → `RotateCw`; `↶`/`↷` → `Undo`/`Redo`; `⚡` → `Zap`; `▶` → `Play`; the workflow glyph → `Workflow`; `🧠` → `Sparkles`.
- **Formatting toolbar vocabulary** (the `MarkdownEditor` toolbar, §5.1): `Bold` / `Italic` / `Heading` / `Link` / `List` / `ListOrdered` / `CheckSquare` / `Quote` / `Code` / `CodeBlock` — all Lucide, re-exported from `index.ts` like the rest. The blocker note on a board card uses `Alert` (never a `⚠` glyph).
- **Brand / vendor marks are exempt and never re-colored** — the OpenWOP robot, the Google `g`, the GitHub octocat (see §8).

### 5.3 Status → chip semantics

Run / agent / node status is rendered as a chip (color **and** label — never color alone, §11), mapped centrally rather than per-component:

- Agent + run status → a `.chip--*` via `agents/agentViewModel.ts` `statusMeta`: active ("Ready") → `chip--success`, working/running → `chip--accent`, waiting ("Waiting on Human") → `chip--warning chip--pulse` (the one action-required state that breathes, §6 `openwop-attention`), paused → `chip--muted`, needs-setup/failed/cancelled → `chip--danger`.
- Node-canvas run status uses the §3 functional tokens on `.builder-node*` badges paired with a Lucide glyph (`CircleIcon filled` / `Check` / `X` / `Pause`), color via `var(--color-warning/success/danger/ai)`.
- **Severity reuses the same functional tokens.** A task's priority is a severity signal, not a run state, but it lives on the same axis: a `High`-priority card uses `chip--danger` (always with the visible "High" label, §11).
- **Feature maturity reuses `--color-warning`.** A nav item for a feature in **beta** wears a warning-toned `.nav-badge--beta` (§5.1) — "beta = experimental, proceed with caution" is a warning-adjacent signal, not an arbitrary category. Always with the visible "Beta" label (§11).

Severity and feature-maturity are the **two** sanctioned reuses of a functional token outside run state — both because they sit on the same caution/severity axis. Do **not** extend functional tokens to arbitrary dimensions (role, source, owner), which differentiate by glyph/label instead (§5.2, §5.4). Do not invent a per-surface status palette; reuse these mappings so a "completed" state looks identical everywhere.

### 5.4 Role glyphs — differentiate by icon, never by color

A roster of named coworkers must read at a glance, but role is **not** a run-state, so it does not earn a functional/accent color (§3 reserves those for status). Differentiation is therefore by **Lucide glyph only**, mapped centrally in `agents/roleTemplates.ts` (`roleThemeForKey` / `roleThemeForAgent`): `sales-ops → Briefcase`, `support-triage → LifeBuoy`, `finance-ops → Scale`, `engineering-ops → Wrench`, `marketing-ops → Megaphone`, custom/unknown → `Bot`. The glyph rides as a small bordered badge on the otherwise-uniform clay avatar (dashboard card + workspace header) and inline on the create-agent role picker. The role key is derived from the seeded `host:demo-<key>` agentRef, else inferred from the workflow portfolio. Do not give a role its own accent color or avatar tint.

### 5.5 Page architecture & atmosphere

The chrome that makes every page feel like one publication:

- **Every top-level nav page leads with `<PageHeader>`** (§5.1) — `eyebrow` (mono kicker) → **sans 700 `title`** → sans `lede` → `actions`. Do not open a page with a bare `<h1>`/`<h2>`. The sans title is the page's `<h1>`; section headings inside the page are `<h2>` (never skip a level — see §11). Pages on this standard (19): Agents, Agent templates, Workflows, Runs, Run-compare, Mission Control, Inbox, Boards, Roster, Prompts, Keys, Memory, Capabilities, Organizations, Demo data, CLI, Executive Assistant, Connections, Comments.
  - **Exempt:** (a) the **Chat** surface (`/`) leads with its `WelcomeCard` hero, not a PageHeader — it's the immersive `.app-main--ai` surface; (b) entity-detail and wizard sub-pages (run detail, agent detail / workspace, agent new / install / create) keep a back-link + entity-name header — they are contextual, not flat index pages. Both still use shared tokens + the serif/mono register.
- **Route arrival:** the standard content `.app-main` carries `.page-enter`, which fades-and-rises its children once per route mount (`openwop-fade-rise`, §6). The chat (`.app-main--ai`) and builder (`.app-main-fullbleed`) are exempt — they are persistent/immersive, not document pages.
- **Atmosphere — the letterpress dot-grid.** The content `.app-main` (scoped `:not(.app-main--ai):not(.app-main-fullbleed)`) and empty `<StateCard>`s carry a faint `radial-gradient` dot-grid in `--rule-2` — the same token + motif as the xyflow canvas grid (§7), so the whole app sits on one drafting paper. It shows only in the gutters between cards; surfaces carry their own `--paper` background. **Never** put the grid on the chat or builder surfaces (they have their own register / canvas grid), and `<StateCard>` MUST set an opaque `background-color` so its grid does not moiré against the page grid behind it.

When adding a new app-specific component:

1. Add a row here.
2. Reuse an existing editorial register (`.surface-card`, `.compare-card`, `.card`).
3. Use only shared tokens for color/type/spacing.
4. No shadows heavier than `--ink-shadow`; no gradients that compete with paper.
5. A new top-level page leads with `<PageHeader>` (§5.5); a new sustained animation gets a §6 row + honors reduced-motion.

---

## 6. Animations

The app animates more than the marketing site because it shows live activity. Discipline:

Animation philosophy: **motion equals meaning.** Nothing moves unless something is happening; when it is, the surface dramatises the work; when it completes, it lands like a stamp on paper, never a balloon drop. (No confetti, no spring-bounce chrome, no decorative motion — that would undercut the credibility a protocol reference needs.)

| Keyframe | Purpose | Constraint |
|---|---|---|
| `openwop-pulse` | "live / streaming" indicator (opacity 0.2 → 0.8 → 0.2) | duration 1.6s–2.4s; opacity only |
| `openwop-mic-pulse` | recording / capturing prompt | box-shadow ring using `--color-danger` alpha; ≤ 6px ring radius |
| `openwop-fade-rise` | route arrival — one calm staggered entrance per page mount (applied via `.page-enter > *`, 40ms stagger) | opacity + ≤ 8px `translateY`; runs once per mount, never on re-render; not on the chat surface |
| `openwop-edge-flow` | active run edge — "data in flight" marching dash (canvas) | clay `stroke-dasharray`; only on `.react-flow__edge.edge-running` (target node running) |
| `openwop-stamp-in` | completion "press" on a status badge/pill when a node or run reaches a terminal state | one-shot scale overshoot → settle; **no colour fill** — colour carries the success/failure meaning |
| `openwop-attention` | action-required chip ("Waiting on Human") | gentle opacity dip (1 → 0.6 → 1) that keeps the label legible; reserved for human-action states, never decorative (`.chip--pulse`) |
| `openwop-bubble-breathe` | live workflow-run chat bubble | faint `--clay-wash` inset-shadow tint while streaming; respects bubble radius; never touches the background fill |
| `openwop-spinner-rotate` | per-step "running" arc in the workflow-progress panel (`chat/workflowProgress/StepList.tsx`) | a 1.5px ring with one coloured top edge replacing the `○` glyph; inherits colour from the surrounding chip; frozen (not hidden) under reduced-motion so the affordance survives |
| `openwop-spinup-dot` / `openwop-spinup-breathe` | "thinking" disclosure indicator (`chat/ThoughtsDisclosure.tsx`) | pulsing dot + body fade while the agent reasons; opacity only |
| `openwop-toast-in` | a toast entering the bottom-right stack (`<Toaster>`) | one-shot opacity + ≤ 8px `translateY`; 0.18s; the toast itself does not loop |
| `openwop-shimmer` | `<Skeleton>` loading sweep | a `--paper` highlight sweeping across the `--rule` block; the `::after` overlay is `display:none` under reduced-motion (the static block remains) |

Rules:

1. **All animations MUST honor `prefers-reduced-motion: reduce`.** The universal rule in `global.css` (`*, *::before, *::after`) zeroes durations + iteration counts, so every keyframe above is covered for free.
2. No animation drives a state change (e.g., do not animate a card *into* the success state — set the state, animate the badge once and stop). The `*-stamp-in` / `*-fade-rise` one-shots fire *after* the state is set.
3. New keyframes are app-only.

---

## 7. xyflow (workflow canvas) theming

`@xyflow/react` ships its own CSS. The app scopes overrides to `.builder-canvas` (matches the wrapper class in `src/builder/canvas/BuilderCanvas.tsx`) and uses xyflow's canonical CSS-variable surface plus a few direct selector overrides where the variable surface doesn't reach:

```css
.builder-canvas {
  --xy-background-color-default: var(--paper);
  --xy-background-pattern-color-default: var(--rule-2);
  --xy-edge-stroke-default: var(--ink-2);
  --xy-edge-stroke-selected-default: var(--clay);
  --xy-handle-background-color-default: var(--clay);
  --xy-handle-border-color-default: var(--paper);
  --xy-controls-button-background-color-default: var(--paper);
  --xy-controls-button-background-color-hover-default: var(--clay-wash);
  --xy-controls-button-color-default: var(--ink);
  --xy-controls-button-border-color-default: var(--rule);
}
```

Direct selector overrides cover the rest:

- `.builder-canvas .react-flow__edge-path` — `stroke: var(--ink-2); stroke-width: 1.5;`
- `.builder-canvas .react-flow__edge.selected .react-flow__edge-path` — `stroke: var(--clay); stroke-width: 2;`
- `.builder-canvas .react-flow__edge.edge-running .react-flow__edge-path` — clay marching dash (`openwop-edge-flow`, §6) on edges whose target node is running during a live run ("data in flight")
- `.builder-canvas .react-flow__controls` — paper background, rule border, 2px radius, ink-shadow
- `.builder-canvas .react-flow__handle` — 12×12 clay disc with a 2px paper border (the "port" affordance)
- `.builder-canvas .react-flow__minimap` — themed to the paper palette via `--xy-minimap-*` vars (`--paper-2` bg, `--ink-2` node rects, `--ink-shadow` mask) + a `--rule` border; xyflow's stock `#fff`/`#e2e2e2` defaults render invisibly on the editorial canvas and MUST be overridden

Node-internal styling (the React component each `<Handle>` renders inside) uses app tokens directly via `.builder-node*` classes. Port labels render in `--mono` at 10px / 0.04em. Node body uses `--sans`.

Background: dotted grid using `var(--rule-2)`. **Never** the default cool-gray grid.

---

## 8. Firebase Auth chrome

The Google + GitHub sign-in buttons embed vendor brand SVGs. Vendor brand-mark invariant:

- **Vendor brand SVG marks are never re-colored.** Use the exact Google `g` mark + the GitHub octocat in their canonical fills.
- The surrounding `.signin-button` container chrome (border, label, focus ring) follows the app's editorial register: `border: 1px solid var(--rule)`, `background: var(--paper)`, `color: var(--ink)`, `font-family: var(--sans)`.
- "Continue with Google" / "Continue with GitHub" label uses `--sans` weight 500.

---

## 9. BYOK wizard editorial pass

The BYOK wizard is a credibility moment for the protocol — the user is pasting a model-provider key and trusting the host's session-scoping promise. Visual register:

- One panel per step (paste, validate, confirm, succeed).
- First-occurrence acronyms expand per panel via `<abbr title="…">` (§9 acronym rule): **BYOK**, **KMS**, **HMAC**.
- Status uses functional tokens (§3); the "secret accepted" success state is a single clay accent dot + body confirmation, NOT a green checkmark fill.
- Copy is third-person factual ("Keys live in-session and are redacted from event payloads"), not first-person ("we promise we won't store this").

---

## 10. Inline-style policy

The brand standard bans `style="…"` in HTML. The same rule now applies broadly to React's `style={{}}` prop: **static geometry and typography go through classes, not inline.** (This supersedes the prior carve-outs that allowed geometry/`fontSize`/font inline — those were swept into the `u-*` utility layer; see "Utility layer" in `global.css`.)

- **Static geometry/typography MUST be className-driven.** `display`, `gap`, `padding`, `margin`, `flex`, `grid` alignment, `width`, `font-size` (10–14 scale), `font-weight`, `font-family`, `white-space`, `overflow`, `cursor`, `list-style`, `text-align` → use the token-anchored `u-*` utilities (or a semantic class). Do NOT add new static inline `style={{}}`.
- **Genuinely-dynamic runtime values MAY remain inline** — and only these: values computed at runtime that cannot be a static class — measured pixel sizes, `transform: translate(<runtime>)`, absolute `top`/`left` coordinates, progress-bar widths (`width: ${pct}%`), `gridTemplateAreas`/`gridColumn` driven by data, and per-event tints set as a CSS custom property (`style={{ '--tint': value }}`) consumed by a class.
- **Color / background:** className-driven, OR a **token reference** forwarded inline only in the dynamic-tint path (`style={{ background: entry.accent }}` where `entry.accent` is `var(--color-ai)`). Literal hex / rgb / OKLCH inline are banned (build-enforced).
- **Token-referenced font-family** stays allowed only where forwarded dynamically; the static `var(--mono)` case uses `.u-mono`.

**Two class layers (where static styles live).** The sweep that retired the inline carve-outs produced two complementary layers in `global.css`, both appended after the component primitives:

1. **`u-*` utility layer** — token-anchored single-purpose classes (`.u-flex`, `.u-gap-2`, `.u-fs-12`, `.u-border`, `.u-bg-surface`, …) for static geometry/spacing/type/border/surface-bg/radius. Reach for these first.
2. **Named semantic component classes** — for *bespoke per-component chrome* that doesn't reduce to utilities (color-mix accent washes, box-shadows, absolute-positioned overlays, header `letter-spacing`/`text-transform`, em/half-px type). Each is prefixed by its component (`.wfprog-*`, `.notifpanel-*`, `.agentdetail-*`, …) to avoid collisions, holds declarations **relocated verbatim** from the original inline style (so the relocation is a visual no-op), and references only tokens (no raw hex). When an object mixes static + dynamic, the static half becomes a class and the genuinely-dynamic half stays inline (the dynamic-tint path above). Do not re-inline these, and do not reuse another component's prefix.

Lint gates:

- `grep -rEn "#[0-9a-fA-F]{3,6}" src/` MUST return 0 hits (zero hex literals anywhere in TS/TSX). Post-Phase-E bar: enforced.
- `grep -rEn "style=\{\{[^}]*(color|background)[^}]*[\"'](?!var\()" src/` MUST return 0 hits (no literal color values inline). Post-Phase-E bar: enforced.
- `grep -rEn "style=\{\{[^}]*(color|background|font)" src/` now flags inline `style` carrying color/font — under the post-override policy these should be class-driven (`u-*`) unless they're the dynamic-tint path (a forwarded `var()` token). Reviewed, not hard-blocked (the dynamic-tint path legitimately matches).
- **CSS-token integrity** (`npm run check:css-tokens` → `scripts/check-css-tokens.mjs`): every `var(--token)` reference in `src/` MUST resolve to a custom property defined in `global.css` or set inline (`--xy-*` vendor vars exempt). Catches typos/undefined tokens that `tsc` + `vite` compile happily but render as nothing or a silent fallback. Wired into `npm run build` (after `tsc` + `check-prompt-ref-defaults`, before `vite`).
- **Spacing/radius ratchet** (`scripts/check-spacing-literals.mjs`): `gap`/`padding`/`margin`/`border-radius` SHOULD use `--space-*`/`--radius*` tokens, not raw px/rem. A big-bang migration of the existing tail risks unverifiable visual shifts, so this gate **ratchets** — it fails if the literal count rises above the baseline (currently 748). New code must use tokens; cleanups lower the baseline. Use `.u-button-bare` (§5.1 utilities) to strip native button chrome instead of an inline reset.
- **CI gate:** `.github/workflows/pr-checks.yml` → `build-app-frontend` runs the full `npm run build` (tsc + both checks + vite) on any `frontend/react/**` change, so a type error, a dead prompt-ref, or an undefined CSS token fails the PR rather than surfacing only at deploy-time.
- **No emoji as UI icons (§5.2).** A scan for emoji rendered as icons in JSX (excluding comments, prose, keyboard hints, ASCII art) MUST be empty — use `ui/icons`. Practical scan:
  ```bash
  # rendered decorative glyphs in non-comment lines; expect 0 (prose ⚡ excepted)
  python3 - <<'PY'
  import os,re
  icons=set('👍👎🚩🔒🗑🔧🛠🧠💭📋📎📷💾☰▶▸▾◉●○⏸⚙✋⚖↻↶↷✓✗✕✎ⓘ')
  for r,_,fs in os.walk('src'):
      if 'ui/icons' in r: continue
      for f in fs:
          if not f.endswith(('.tsx','.ts')) or '.test.' in f: continue
          for i,l in enumerate(open(os.path.join(r,f)),1):
              s=l.strip()
              if s.startswith(('//','*','/*')): continue
              for c in l:
                  if c in icons: print(f"{r}/{f}:{i}: {c}")
  PY
  ```

---

## 11. Accessibility (app-specific; WCAG 2.2 AA baseline §14)

App accessibility rules:

- Run-status badges MUST NOT communicate state by color alone. Always pair the color with a text label OR a glyph.
- Chat bubbles MUST have a `role="log"` ancestor and announce new entries via `aria-live="polite"`.
- Interrupt cards MUST trap focus into the response form on render; releasing focus is contingent on submission or dismissal.
- xyflow canvases MUST expose keyboard navigation; if vendor defaults are insufficient, add app-level handlers.
- Firebase popup auth flows MUST surface a visible "still signing in…" status if the popup is closed mid-flow.

---

## 12. Component checklist for any new app addition

Before merging a PR that introduces a new app component:

- [ ] New class added to §5 (app components)
- [ ] Reuses the §5.1 cohesion primitives (`.surface-card` / `.chip` / `.action-bar` / `.btn-sm` / `<StateCard>` / `<Notice>`) instead of a bespoke inline-styled card/chip/notice
- [ ] Icons come from `ui/icons` (§5.2) — **no emoji as icons**
- [ ] Status is shown as a labeled chip, never color alone (§5.3 / §11)
- [ ] Uses only shared tokens (canonical names) + app-functional tokens for color/type/spacing
- [ ] No hard-coded hex / OKLCH literal in component CSS
- [ ] No inline `style={{}}` for color/font (geometry OK)
- [ ] Has `:focus-visible` keyboard reachability
- [ ] Renders correctly under `prefers-color-scheme: dark` + the `.theme-dark`/`.theme-light` override (§2/§3)
- [ ] Has a documented breakpoint behavior for ≤760px
- [ ] All animations honor `prefers-reduced-motion`
- [ ] Acronyms expand on first appearance per panel

---

## 13. Related files

- Editorial palette + type triple: OpenWOP brand lineage; canonical values in §2 + `global.css :root`
- `frontend/react/src/styles/global.css` — the lone stylesheet (tokens, the §5.1 cohesion layer, focus ring, `.alert.*`, `.status-badge`)
- `frontend/react/src/ui/` — shared primitives: `PageHeader.tsx` (§5.5), `StateCard.tsx`, `Notice.tsx`, `Markdown.tsx`, `MarkdownEditor.tsx`, and `icons/` (the §5.2 app-wide Lucide set)
- `frontend/react/src/kanban/KanbanBoardView.tsx` — the one shared drag-and-drop board
- `frontend/react/scripts/check-css-tokens.mjs` — the §10 CSS-token integrity gate (run in `npm run build` + the `build-app-frontend` CI job)
- `frontend/react/index.html` — Google Fonts link
- `DEPLOY.md`, `DEPLOY-SMOKE.md` — deployment + smoke
- `.claude/skills/ux-review/SKILL.md` — the review skill that enforces this doc (Mode A, app surface)

---

## 14. Open standards we follow

Standards followed: WCAG 2.2 AA, OKLCH, `prefers-reduced-motion` / `prefers-color-scheme` / `prefers-contrast`, RFC 2119 keyword discipline in any normative app prose (e.g., the `/privacy` page).
