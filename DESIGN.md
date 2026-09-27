# OpenWOP Reference App — Design Standards

> Source of truth for `frontend/react/`'s design system — **self-contained**. Reviewed by `/ux-review`.
>
> Covers the full system: the editorial tokens (§2), app-functional tokens (§3), components (§5), animations (§6), canvas-editor standards (§7, incl. xyflow theming §7.11), and framework-integration rules (Firebase Auth §8). Canonical token *values* live in `frontend/react/src/styles/global.css :root` and are reproduced in §2 so this doc stands alone.
>
> **Lineage (not a dependency):** the editorial palette + type triple originate from the OpenWOP brand, historically shared with the marketing site (now [`openwop/openwop-site`](https://github.com/openwop/openwop-site)). They are reproduced here as the app's stock defaults; there is **no cross-repo sync obligation**. Re-brand through the runtime Appearance editor or `src/brand/brand.css`/`VITE_BRAND_*` fallback seams described in `frontend/react/WHITE-LABEL.md`. Do not edit `global.css` to skin an installation.

---

## 1. Purpose & audience

`frontend/react/` is the reference deployment behind `https://app.openwop.dev/`. It exists so protocol implementers and evaluators can exercise the v1 wire contract without cloning the repo — workflow building, run lifecycle, SSE event streaming, HITL interrupts, capability discovery, BYOK paste-and-run.

Visual register: **the same editorial-technical voice as the marketing site**, applied to an interactive surface. **Heading typography is SANS (2026-06-05, David's directive): every header — page titles, card/section/modal titles, entity names — sets `var(--sans)` at weight 600 (section/entity heads) or 700 (the page-marquee `<h1>`).** *(Correction 2026-06-11: the contract previously read "650–700", but Geist is a STATIC family — it has no 650 instance and the 700 master wasn't loaded, so the browser silently faux-bolded the most prominent type on every page. Fixed: the font now loads `;700`, every `650` snapped to the real `600` master, and weights run on the `--weight-*` ladder — 400 body / 500 emphasis / 600 head / 700 marquee — with `font-synthesis: none` so a future gap fails loud.)* The serif (`var(--serif)`) survives only as deliberate accents: the brand wordmark, ~~the figure-tile numerals~~, the gate product name, and the ledger's italic persona names. Do not reintroduce serif headers. *(Correction 2026-08-08, David's directive from a reference: the **figure-tile numerals are no longer a serif accent**. `<KeyFigureBand>` (§5.1) now sets its numeral in `var(--sans)` at `var(--weight-marquee)`, as part of a redesign that also moved the label above the value, start-aligned the card, and split the joined band into separate cards. The strike-through is kept rather than the line rewritten because "four surviving accents" is cited elsewhere — there are now three.)* Where the marketing site is read once, the app is operated. Editorial discipline applies to chrome, navigation, headings, status, and labels; the workflow canvas is allowed denser geometric tooling.

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
--serif: "Instrument Serif", serif;   /* brand wordmark + gate product name + ledger personas (NOT figure numerals since 2026-08-08) */
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

**Geometry:** `--radius` 8px (controls: buttons/inputs) · `--radius-lg` 14px (containers: cards/queue/tiles/modals) · `--radius-bubble` 16px · `--radius-pill` 24px · `--space-1..6` (4/8/12/16/24/32) + half-steps `--space-1-5` 6px, `--space-2-5` 10px.

**Button color hierarchy.** Primary actions fill with the brand clay; they are **never** an inverted ink slab. The default `<button>` (and the `.primary`/`.btn-primary` aliases) IS the primary — `--clay-strong` fill + `--color-on-scrim` (white) text, AA-safe in both themes, the same treatment as `.btn-accent-solid`. (It previously filled `--ink`, which rendered as a harsh near-black-on-cream slab in light and a near-white-on-dark slab in dark — that is now forbidden.) Hierarchy: **`.btn-accent-solid` / default `button`** (clay solid — page CTA, submit, queue Approve) > `.btn-accent` (clay-soft — in-row primaries) > `.secondary` (outline — neutral/cancel) > `.btn-ghost`/`.ghost` (transparent — recessive/inline/icon-only). A non-primary action MUST opt into `.secondary` or `.btn-ghost`; grouped toggles (`.segmented`, `.tabs`, `.mt-filter`) are styled by their container and override the default fill.

**App-functional tokens** (`--color-success`/`-warning`/`-danger`/`-ai`/`-info`) are defined in §3 — they surface run state, which only this app has. **Legacy aliases are RETIRED** (§4) — canonical names only; `check-legacy-aliases` fails any reference. Status colors are **functional, not brand**.

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

## 4. Token source, retired aliases, breakpoints, archetypes (ADR 0510)

**Token source of truth.** `src/styles/tokens.json` is the DTCG-format token
graph — name, type, light/dark value, CSS name — for every foundation token.
Until Phase 5 generates the CSS from it, `global.css` `:root`/`.theme-dark`
still hold the runtime values and `check-dtcg-parity` keeps the two
byte-identical; edit BOTH in one change. Volatile counts (keyframes,
breakpoints, alias counts, CSS volume) live in the GENERATED
`docs/steward/DESIGN-SYSTEM-INVENTORY.md` (`design-system-inventory --write`),
never in this file.

**Legacy aliases: RETIRED (2026-08-01).** The transitional `--color-*` /
`--font-*` aliases were migrated to canonical names (`paper`/`paper-2`,
`rule`, `ink`/`ink-2`/`ink-3`, `clay-text` (+ `--clay-text-hover`),
`sans`/`mono`) and their definitions deleted. `check-legacy-aliases` fails any
reference — they resolve to NOTHING now. The white-label seam (`brand.css`)
always offered canonical names only.

**Breakpoint vocabulary (DSA-024).** Media queries use the governed set —
intent, not device brands: content `480/600/640`, shell `720/760/860`, rail
`900`, canvas `1024` (max-width uses `B−1`). Pre-vocabulary stragglers are a
shrink-only ledger in `check-breakpoints.mjs`; new ad-hoc widths fail the
build.

**Page archetypes (DSA-029).** Every route declares `archetype:` on its
`FeatureRoute` — a REQUIRED field, so coverage is a compile-time invariant:
`standard-index` · `data-dense-index` · `detail` · `admin` · `hub` · `public`
· `immersive-chat` · `canvas-editor` · `narrow-form`. Each names the page's
heading/action/state/width/responsive obligations (outlier migration is the
ADR 0510 Phase 7 program).

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
11. **Grid + List is ONE toggle, not a per-page reinvention** (the *collection-view
    canon*). Every page that lists homogeneous entities (Agents, Projects,
    Documents, Advisors, Strategy, Priority-matrix, Feature-toggles) offers the SAME two views via
    the SAME control: **Grid** — `.surface-card`s in a `.card-grid` (the
    discovery default); **List** — dense rows in a `.surface-card.list-view` (the
    fleet-scale view, rule 6). The switch is the shared **`<ViewToggle>`**
    (`src/ui/ViewToggle.tsx`) — a `.segmented` control, NEVER a hand-rolled pair
    of buttons — paired with **`useViewMode('<surface>')`** so the choice
    persists per-surface in `localStorage`. A feature supplies only its own
    **Card** (grid cell) + **Row** (list cell), and — per rule 6 — derives both
    from ONE shared helper so the two views never diverge (the `primaryAction`/
    `subLine` precedent on `/agents`). The toggle lives at the end of the page's
    one `.filterbar` row (rule 5), right-aligned (`u-ml-auto`). `.roster-row` is
    the agent-SPECIALIZED instance of `.list-row` (it adds an avatar status-ring
    + an autonomy column); generic collections use the neutral `.list-row*`
    family. Reimplementing the toggle, the row chrome, or the persistence is a
    defect, not a style choice. **Decision record + scoping rule: ADR 0131.**
    `<DataTable>` operate-surfaces (Library, Keys, Runs, …) are the exception —
    the sortable table IS their list view, so they get Grid *alongside* the table
    (`<ViewToggle labels={{ list: 'Table' }}>`, `useViewMode(…, 'list')` so the
    table stays the default); the canon never *replaces* a table. Editor
    nav-rails (CMS, Publishing, Sharing) are out of scope for the
    Grid⇄List toggle — but NOT for rules 12–13 below (search + URL-mirrored
    selection apply to them too). **A page qualifies for that exemption by BEING
    a narrow selector column inside an editor — not by having an editor behind
    the selection.** *Correction 2026-08-03 (ADR 0519): Forms was listed here and
    should not have been. It is a full-width page listing homogeneous entities —
    the Projects/Documents shape — and had been filed under the rail exemption by
    resemblance rather than fit. It is now a standard collection page with a
    `/forms/:formId` detail route. **Email followed (ADR 0520)** — its templates
    lane is a collection with a `/email/templates/:templateId` editor, though
    `/email` itself stays a hub. Re-check the three names above against the same
    question before inheriting this exemption.*
12. **Every opened entity has a URL** (the *routing-correction canon*,
    2026-07-09 — ADR 0079/0058 correction notes; PRs #1539/#1545/#1550).
    Opening an entity must never be invisible in-page state:
    - **Full-page details** get a path route (`/projects/:projectId` is the
      template: `/strategy/:strategyId`, `/priority-matrix/:listId`,
      `/notebooks/:notebookId`, `/boards/:boardId`, `/crm/deals/:dealId`). The
      detail page leads with a `PageHeader` (entity name as the page `h1`) + a
      **"Back to <collection>"** `.btn-ghost` `<Link>`; inner view tabs bind to
      `?tab=` via **`useUrlTab`** (`src/ui/Tabs.tsx`) so reload/share keeps the
      tab. A two-item "<Collection> / <Title>" tab strip is the anti-pattern
      this canon replaced.
    - **Stacked master–detail and builder-selector pages** (Funnels, Documents)
      mirror the selection to **search params**
      (`?org=<orgId>&<entity>=<id>` — the CRM deep-link pattern): write on
      open (`replace`), clear on close/delete/org-switch, consume an inbound
      deep-link **one-shot** after the org's list loads. View filters must feed
      a SEPARATE memo (`visibleRows`) so filtering the list never invalidates
      the URL selection. *Correction 2026-08-03 (ADR 0519): Forms left this lane
      for the path-route lane above. A query-param mirror is for a selector that
      genuinely lives inside its editor; reaching for it because a page HAS an
      editor is how a full-page collection ends up with cells that can't be
      cmd-clicked and a delete button on every row.*
    - **Collection cells are real `<Link>`s** (cmd/middle-click, copyable) —
      never `onClick` buttons; a switcher pill strip whose pills navigate is a
      `<nav>` of links with `aria-current="page"`, not a `role="tablist"`.
      `.list-row-id` anchors carry no underline (handled in `global.css`) and
      no leading glyph unless it carries information (an avatar/status ring —
      `.roster-row`); a decorative type icon on every row is noise.
    - **Destructive actions never live on collection cells** — delete belongs
      to the entity's detail surface (with the shared `confirm()`), navigating
      back to the collection on success.
    - **Blast radius picks the confirm tier** (SET-R2-1): a single-record
      delete uses `confirm({ danger: true })`; a deletion that cascades beyond
      the row under the pointer (an organization, a workspace) adds
      `typeToConfirm: <resource name>` — the affirmative button stays disabled
      until the user types the exact name (the Vercel delete-project /
      LaunchDarkly archive convention). Never add the typed gate to routine
      deletes; friction spent there is stolen from where it matters.
    - A bare collection route that auto-opens a default entity (e.g. `/boards`)
      redirects with `replace` so back/forward never lands on the empty shell.
13. **Search + filters ship with every collection** (the *collection-kit
    canon* — PR #1550). One `.filterbar` row (rule 5): a `type="search"`
    `.ui-input.filterbar-search` name filter — rendered once the collection
    passes ~3 entities, gated on the **unfiltered** total so it can't vanish
    mid-search — plus labelled `<SelectField>` facet filters where real fields
    exist (scope, status, model). Zero matches render a designed `<StateCard>`
    with a **clear-filters action**, never a blank region. Client-side search
    over a *paginated* list must stay honest — say "more pages may match" and
    keep Load-more reachable (the Library posture) rather than implying the
    whole set was searched. Status chips always render **localized labels**
    (`status_*` keys) — a raw enum in a chip is an i18n defect. **Rail
    variant** (grade-ux COLL-UX-4, decided 2026-07-10): inside a narrow editor
    nav-rail (CMS/Email/Forms/Publishing/Dealers) the zero-match state is the
    compact inline form — a muted line + ghost clear-search button — because a
    full `<StateCard>` (icon + title + body) would dominate a ~280px column;
    full-page collections keep the designed `StateCard`. Both satisfy the
    never-blank + clear-action requirement.
14. **"Start from a template" is a GALLERY, never an inline strip** (the
    *template-picker canon*, 2026-08-03 — ADR 0521). A creation surface that
    offers templates renders ONE affordance ("Start from a template") that opens
    the shared **`ui/TemplateGallery`**:
    - **`<TemplateGalleryDialog>`** from a normal surface — a picker is a
      self-contained detour inside a creation flow (you are on the surface you
      are creating into, you pick, you come straight back), which is exactly
      what an overlay is for and what Notion/Figma/Canva ship for this job. A
      full page makes you navigate away and back for a five-second decision.
    - **`<TemplateGalleryBody>`** when the picker is already a STEP inside an
      existing modal (the Documents new-document flow). A modal inside a modal
      is never the answer.
    - The gallery owns **search + a category facet** (both gated on the
      unfiltered total, per rule 13), the card grid, the live result count, the
      `Use template` CTA, and the loading / failed / empty / no-match states. A
      feature supplies `items` + `onUse` and its own empty-state copy — never
      its own grid, search box, or chrome. `renderPreview` is the one escape
      hatch (the canvas gallery previews through the type's real Renderer).
    - **A full PAGE is right only when browsing IS the task**, not a detour —
      the builder's workflow-chain gallery is that, and stays a page.
    - *Why this is a rule and not a preference:* the inline strip
      (`Or start from a template: A · B · C · D`) reads fine at four and is
      unusable at forty — it wraps into a wall, offers nothing to search, and
      leaves no room to say what a template contains. **Template catalogs are
      pack-sourced** (ADR 0516), so an operator or a third party decides how
      many exist; "there will only ever be a handful" was never ours to assume.
      The strip also left a FAILED catalog read nowhere honest to go (rule §4.6).

## 4.6 Failure-state microcopy — the honest-read canon (2026-07-26)

> **If you are here under time pressure, this is the whole section:** a read that
> failed knows NOTHING, so say what failed and what the reader must not conclude,
> never what to do about data you could not see — and pass `announce` so a
> screen-reader user hears it. The rest is why.


A read that fails is not an answer. Roughly twenty screens have now been fixed
because a rejected fetch rendered as a confident claim ("No organizations",
"No payout runs yet", "No audited actions match"), and the fixes introduced
**eleven different bodies under the single key name `orgsFailedBody`**. That
divergence is this document's fault: §1 sets a voice but there was no rule for
the one string every org-scoped page now ships. This section is that rule.

**The three states, and what each may say.**

| State | The screen knows | Copy may |
|---|---|---|
| loading | nothing yet | say only that it is loading |
| empty | the server answered "none" | instruct — "Create your first board" |
| **failed** | **nothing** | **state the failure and its consequence. Never instruct.** |
| **stale** | the last answer, not the current one | say the data is last-known and when |
| **partial** | some panels answered, others didn't | scope the failure to the panel that failed |

The last two rows were missing from the first cut of this table and were added
after `/grade-ux` found the model too small for the app it describes.
`EnvironmentsPage.tsx:434` already ships **stale** (a refresh failed after a good
load, so the cards on screen are last-known rather than live) and
`OperationsHubPage` already ships **partial** (`Promise.allSettled`, one card per
read). Both are failure states, and neither may borrow the full-page failure card:
replacing real data with "couldn't load" when we still hold the previous answer is
dishonest in the opposite direction — it discards something true.

**Rules for the failed state.**

1. **Lead with the failure, not the reassurance.** "Couldn't load your boards"
   before "your boards are still there" — the user needs the fact first.
2. **One clause of consequence, then stop.** Name what the reader must not
   conclude ("this is not an empty account"), or what is now unsafe ("don't
   reconcile from this screen"). Not both.
3. **No shouting.** Emphasis is carried by sentence structure, not capitals.
   What is banned is the ALL-CAPS emphasis — `NOT`, `Do NOT` — never the ordinary
   words; "do not reconcile from this screen" is correct and "Do NOT reconcile" is
   not. (Worth spelling out, because the first cut wrote the rule as "`NOT` and
   `Do NOT` are banned" and I then read my own rule as banning the phrase.)
   **8 failure strings shout and 52 doing
   identical work do not**, so the capitals signal nothing except which day the
   string was written. (Those are counted figures. The first cut of this rule
   said "three strings and five" — numbers I had not measured, in a rule about
   not overstating things.) Where a negation is genuinely load-bearing, restructure the
   sentence so it lands on the verb.
4. **Never a sentence fragment.** A body that begins "So we cannot tell…" only
   parses beside its title; assistive tech and truncation both break it.
5. **No trailing colon** unless a list actually follows.
6. **Hold one register inside a string, and inside a feature.** The first cut of
   this rule declared contractions the house register. The corpus disagrees:
   across the catalogs this section governs, the uncontracted forms lead
   ("could not" ×7, "cannot" ×3, "is not" ×8) against a single "do not". Worse,
   the rule as written was violated by the very strings written to satisfy it —
   `payoutReadFailed` reads "could not be loaded. Don't reconcile…", mixing both
   forms in one sentence. So the rule is consistency, not a house style: §1's
   voice is editorial rather than legal, but a feature that has settled on
   "could not" should not acquire a "don't" because a new string felt friendlier.
7. **Offer the recovery, don't narrate it.** A Retry button beats "try again" in
   prose; keep the prose for what the button cannot say.
8. **Announce it — through the region that already exists.** A failed-read card
   must reach assistive tech: pass `announce` to `StateCard`, or use `<Notice>`,
   which has always announced. A silent swap from skeleton to failure card tells a
   screen-reader user nothing, and "nothing" reads as "nothing to report" — the
   false conclusion this whole section exists to prevent.

   **Do not give the card its own `role="status"`.** The first cut of this rule
   said to, and it was wrong: a live region that is MOUNTED WITH ITS TEXT ALREADY
   INSIDE is not reliably announced, because assistive tech registers the region
   on insertion and announces subsequent mutations. Every failure card here is
   conditionally mounted, so an inline region announces approximately nothing
   while looking perfectly correct in the DOM — and a test asserting the attribute
   passes either way. `StateCard` therefore pushes the title into ADR 0363's
   `GlobalLiveRegion`, which is on the page long before any message.

   Polite, not assertive, and the reason is *who initiated it*: these appear on
   load or on a background poll, so interrupting someone mid-sentence for
   something they did not do is the wrong trade. `<Notice>`'s assertive branch is
   for a failed ACTION the user just took.

   **Only the title is spoken.** The body carries the server's raw error text —
   noise read aloud, and it changes on every retry. The announcement is a
   NOTIFICATION, not the only channel: the full card, its reason and its Retry
   button are all in the DOM for the user to navigate to.

   **Do not move focus to the card.** It appears without user action, so stealing
   focus would violate the expectation WCAG 3.2 protects. A user-initiated retry
   keeps focus on the button that triggered it.

   **Empty and loading cards must NOT announce** — a live region that fires on
   every ordinary first visit is one people turn off.

**The shared case.** `orgsFailedBody` is one concept. It belongs in ONE shared
namespace with one body, not eleven — a feature only overrides it when the
consequence genuinely differs (a money surface warning against reconciling is a
real override; "…and no tickets" is not).

*Shipped 2026-08-05 as `ui/OrgSelectionState`, in the `ui` namespace rather than
`common` as this paragraph first said — `ui/` components already own `ui` copy
(`ColorField`, `ConfirmDialog`), so `common` would have been a second home for
the same class. The correction that matters more: the first attempt took the
"one body, not eleven" instruction literally and deleted twelve per-feature
consequence clauses, which is the ONE thing a failed read can honestly add
("the metric list was never requested"). Both slots exist now — the frame and
noun are shared, the consequence clause stays with the feature.*

## 5. Components — app-specific canonical list

The shared `.btn`-family + chrome primitives are defined in `global.css`. The list below is app-specific.

| Class | Purpose | Notes |
|---|---|---|
| `.app-shell` | top-level flex **row** wrapper | min-height 100vh; `[.app-sidebar][.app-body]` |
| `.app-sidebar` | persistent left navigation rail (`src/chrome/Sidebar.tsx`) | sticky full-height column on `--paper-2` with a `--rule` right border (`--sidebar-w`); brand + workspace/org switcher (top) → grouped `Workspace`/`Author` workspace nav + a single pinned `Admin` entry (the admin tier lives inside `<AdminLayout>`'s embedded rail) with Lucide icons (scroll) → account chrome `.app-sidebar-foot` (bottom). Nav derives from the feature manifest (`src/chrome/features.tsx`) — routes, tiers, groups, and width chrome are declared there once. Collapses to an icon-only strip (`.is-collapsed`, `--sidebar-w-collapsed`, persisted to `localStorage`); becomes an off-canvas drawer ≤860px (`.app-sidebar-launcher` + `.app-sidebar-scrim`). Active item via `.app-nav-link.is-active` (clay-soft tint + clay text + `aria-current`); `:focus-visible` ring added for the anchor links. Replaces the former top-nav + `NavDropdown` |
| `<BrandLockup>` (`src/brand/BrandLockup.tsx`) | the ONE full-brand renderer for public and app chrome | renders a distribution's configured light/dark lockup artwork intact; falls back to the theme-aware mark + product-name pair when no lockup is supplied. Artwork stays decorative (`alt=""`); its enclosing home link owns the accessible product name. The expanded sidebar and public headers use the lockup, while the collapsed rail deliberately uses the standalone mark |
| `.app-body` | content column right of the rail | flex column (`min-width:0` so wide tables/canvas shrink rather than force page scroll); holds `InMemoryHostBanner` + `.app-main` + `.app-footer`. Under `.app-shell--ai` it locks to viewport height so the chat feed owns the scroll |
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
| `.builder-canvas` | xyflow workflow-canvas wrapper | scopes all `--xy-*` token overrides + the run-edge/grid styling (see §7.11); the wrapper class in `src/builder/canvas/BuilderCanvas.tsx` |
| `.builder-collab-chip` + `.builder-node-peers` / `-peer-dot` / `-peers-more` | ADR 0481 builder-multiplayer cluster: the toolbar session chip (Live · N / Connecting… / Not connecting) + the on-node peer presence markers (`BuilderToolbar.tsx` / `canvas/nodes/BaseNode.tsx`) | chip rides the shared `.chip` register — plain for live, `chip--muted` while connecting/reconnecting, **`chip--warning` for the failed state** (a state to leave-and-retry, not a fault — SHORT chip text, full guidance in `title`); `tabular-nums` + `nowrap` so peer counts don't jitter. The chip carries **no `role="status"`** — connection-state TRANSITIONS announce once each through the shell's sr-only polite region (a live-region chip re-announced on every re-render). Peer markers are quiet identity dots at the node's bottom edge — **deliberately NOT a fifth corner badge** (the four corners are spoken for: cap-warn / heat / pin / run status, and presence is ambient, not an alert); ≤3 dots + a muted tabular `+N` overflow run (`-peers-more`). Peer colors index the **FIXED 5-token functional palette** (`--color-{info,success,warning,ai,danger}-text` — never raw hex, the tsx-color-literals gate) **by a NAME hash**, so a person keeps one color on every client and across reconnects; identity here is decorative (the name always rides `title`/`aria-label`, §5.3 never-color-alone). The Go live ⇄ Leave session button is a **label-swapping action pair, not a toggle — no `aria-pressed`** (AT would pair a pressed state with the wrong verb) |
| `.builder-ai-panel` + `<AiAuthorPanel>` (`src/builder/AiAuthorPanel.tsx`) | the "Create with AI" workflow-author panel (ADR 0072) | `.surface-card` labelled `role="region"` (non-modal, opens from the gated toolbar button; focuses its sole input, Esc closes), token-only `.builder-ai-textarea`, errors via `<Notice variant="error">`, `.action-bar` for Cancel/Author. Dispatches the author run and loads the result into the canvas |
| `.interrupt-card` | HITL interrupt surface | matches `.compare-card` register; clay-rule top border to mark "action required" |
| `.byok-wizard` | BYOK step-through | progressive disclosure; `<abbr>`-expand acronyms per step (§9 acronym rule) |
| `.signin-button` (Google / GitHub variants) | auth chrome | wraps vendor brand SVG marks; container is ink-on-paper; **brand marks themselves are never re-colored** (§8) |
| `.demo-host-banner` | "you're on the demo host" banner | clay-wash background, mono marker, dismissible |
| `.fp-run` (+ `__bar` / `__list` / `__row{--waits}` / `__at` / `__event` / `__gloss` / `__waits` / `__foot`) + `.fp-hero__split` | the public front page's **run ledger** — hero `visual: 'run'` (`HeroRunLedger` in `features/cms/SectionRenderer.tsx`): a run typeset as its event log, placed in the hero grid beside the copy (below it at ≤899px, never hidden) | the page's ONE signature element. Event names are real run-event types, kept as untranslated mono wire literals, each with a localized sans gloss. Rows play the one-shot `fp-rise` stagger once, with a deliberate pause before the two post-approval rows. The `--waits` row (clay-wash + clay inset rule) carries a pill that plays `openwop-attention` twice, then stops (§6, human-action states only). `aria-hidden` because it is illustrative; the hero copy carries the claim. Both reduced-motion paths (OS + `data-reduce-motion`) set `animation: none` explicitly because the stagger uses delays |
| `.fp-rows` / `.fp-row` (`__title` / `__text`) | columns `layout: 'rows'` — **statement rows** for parallel promises: a serif claim on the left, a sans explanation on the right, with hairlines between | for items that are not a sequence (no `01/02` numbering) and not a menu (no card chrome). Stacks at ≤759px. The prerender treats it like `cards` (a `<ul>` of `h3`+`p`) |
| `.env-chip` + `.env-chip-{info,warning,danger,muted}` | envelope-events timeline chip (RFC 0030/0031/0032/0033) | left rule-rail tinted with the variant's functional token; mono `.env-chip-tag` color matches; body in ink-2; pill / quote / detail sub-elements stay paper-on-paper to keep the bubble calm when chips stack |
| `.envelope-events` | the in-bubble timeline wrapper holding stacked `.env-chip` rows | column flex with 6px gap; sits between `MessageRenderer` and `AgentEventCards` inside `MessageBubble` |
| `.reasoning-disclosure` | RFC 0030 §A `<details>` for the `envelope.payload.reasoning` string | distinct from `ThoughtsDisclosure` — uses an `ⓘ` info glyph (vs `…` ellipsis), dashed top divider, AI-coloured left-bar on the open body |
| `.think-indicator` / `.think-dots` / `.think-dot` | the shared cadenced "thinking / working" heartbeat (`chat/ThinkingIndicator.tsx`; reused by `ThoughtsDisclosure` in-flight + a running `AgentEventCards` tool-call) | three muted dots + label; dots `aria-hidden`, label from `thinkingLabel`; pulse tempo via `--think-dur` (`useStreamCadence`) on the §6 `openwop-think-dot` keyframe. Replaces the prior bare "Thinking…" text and the disclosure's bespoke `openwop-thoughts-dot` |
| `.msgfeed-skeleton` / `.msgfeed-skel-{line,in,out}` | conversation-load skeleton shown while an earlier page hydrates (`chat/MessageFeed.tsx`) | reuses the §5.1 `.skeleton` shimmer; bubble-shaped rows alternating sides (`-in` left / `-out` right) so it reads as an incoming thread, not a generic bar |
| `.prompt-tier-one-chip` | Tier-1 subset finding on a schema-hint prompt (RFC 0030 §B) | warning-tinted mono chip; appears on the prompt-list-item card; pairs with a banner above the list when `capabilities.envelopes.tierOneSubsetCompliance` is `strict` / `warn` |
| `.inline-link` | bare inline text-`<a>` keyboard focus ring | opts an in-text `<Link>`/`<a>` into the `--clay`/`--clay-text` `:focus-visible` ring (the global ring covers `a.surface-card` but not text links); outline + 2px offset only, no color/weight change |
| `.wf-track` (+ `-node` / `-seg` / `-stop` / `-dot` / `-label`, `--compact`) | the **autonomy track** — the 3-stop trust-journey rail on `/workforces` (Watching → Assisting → Running on its own) | flat selectors, token-only; current stop = `--clay` dot + a `--clay-soft` **halo** (the shared current-glow signature, one declaration grouped with `.auto-meter-dot--current`), done = `--clay-soft`, future = hollow `--rule-2`; the connecting **segment** marks this as a *journey* (earned over time). Rendered by `workforces/AutonomyTrack.tsx`. The page's signature visual |
| `.auto-meter` (+ `-dots` / `-dot{--done,--current}` / `-label`) | the agent **autonomy gauge** — the per-agent `autonomyLevel` on every tile / roster row / drawer (Supervised → Guided → Autonomous) | shares the `.wf-track` tri-tone + current-glow halo, but **three free dots, NO connecting segment** — autonomy is a *setting you choose*, not a journey you complete, so it deliberately drops the segment (line = journey, free dots = setting). One trailing current label (dense-row scale); `role="img"` + localized `aria-label`. Rendered by `agents/AutonomyMeter.tsx` |
| `.wf-outcomes` / `.wf-outcome-n` / `.wf-outcome-l` / `.wf-gate` | business-outcome readout on `/workforces` (the "what it's done for you" block) | `-n` is the Instrument-Serif numeral (`--serif`, tabular-nums), `-l` the `--ink-3` label; `.wf-gate` is the plain next-step sentence under the track |
| `.chatinput-live-pill` / `.chatinput-live-wave` (`chat/voice/VoiceWaveform.tsx`) | the live-conversation voice animation (ADR 0141 RT-8): a scrolling mirrored bar waveform driven by the REAL audio graph — mic level paints `--clay` bars, model speech paints `--color-info` azure, idle slots `--rule` — beside the hot stop button in one clay-wash pill | canvas resolves tokens at draw time via `getComputedStyle` (theme flips apply live); fast-attack/slow-release envelope (pure helpers in `audioLevels.ts`, unit-tested); `prefers-reduced-motion` ⇒ non-scrolling 8 fps level meter; canvas `aria-hidden` (the button carries state); lazy-loaded (entry-budget). `tone="recording"` + `.is-rec` = the clip-recording variant: input-only graph from `useAudioRecorder.inputAnalyser`, mic bars `--color-danger`, pill chrome `--danger-rule`/`--danger-wash` (red = recording a clip, clay = in a conversation)  `.chatinput-live-phase` fills the wave slot with the phase word while the session connects (no analyser graph yet) — same 96px width, shift-free swap; the composer placeholder + an sr-only status region carry the phase for AT (CHAT-7/A11Y-8) |
| `VoiceAgentPicker` (`chat/voice/VoiceAgentPicker.tsx`) | ADR 0199 P3 — modal shown when the mic starts a REALTIME session in an UNSCOPED chat: roster list + an explicit "workspace assistant" option; choice remembered per conversation (`owp.voice.agentFor:<id>`). Rides `ui/Modal` (focus-trap contract); agent-scoped chats never see it |
| `MediaPickerDialog` (`features/media/MediaPickerDialog.tsx`) | ADR 0206 B4 — the ONE browse/search/upload asset selector other features embed to reference a media asset (the CMS editor's `onPickMedia`); media owns media UX, consumers store the returned `serveToken` | Rides `ui/Modal` + the media client (`listAssets`/`uploadAsset` — no second upload path); debounced search; `card-grid` of `surface-card` thumb buttons with `aria-label` per asset; a feature MUST embed this instead of growing its own asset dropdown/fetch |
| `GenerateImageDialog` (`features/media/GenerateImageDialog.tsx`) | ADR 0401 — the ONE AI text-to-image affordance every `mediaRef` surface opens (via `MediaRefWidget`); media owns media UX; BYOK-honest (a `StateCard` when no image provider key exists) | Rides `ui/Modal`; provider/size/model pickers from the host `image-providers` listing; the minted LIBRARY asset's `serveUrl` is what consumers store — never raw bytes |
| `EditImageDialog` (`features/media/EditImageDialog.tsx`) | ADR 0401 — the AI edit-selection flow (edit / generative-fill / background-remove / upscale) on an existing library image; op chips are CAPABILITY-GATED per provider (disabled + hint, never offered-then-failed) | Rides `ui/Modal`; taint-free mask painter (strokes on their own canvas over the `<img>`); result is a NEW `derivedFrom`-lineage asset — the source is never mutated |
| `.dash-grid` / `.dash-tile` (+ `--full` / `__bar` / `__controls` / `__ctrl` / `__body` / `__list` / `__row` / `__stats` / `__stat`) + `.dash-picker` (`features/dashboard/`) | ADR 0375 — the editable dashboard: a per-(user,workspace) 2-col tile grid at `/dashboard` (`--full` spans both columns; 1-col under 720px). Each tile is a **projection** over an existing feature client (owns no data, ADR 0082) rendered in its own `ErrorBoundary` + `Suspense` + `LazyMount` (fan-out guard). Four tile shapes, each with ONE shared renderer: **list** (`<TileList>` rows), **metric** (`<TileStats>` — a stat MAY carry a `delta` rendered as ▲/▼ glyph + number, color only PAIRS with the glyph), **bars** (`<TileBars>` — the `.crm-meter` track+fill generalized; value ALWAYS text beside a decorative aria-hidden bar), and **sparkline** (`<Sparkline>` — one inline-SVG polyline, `role="img"` + tile-supplied label, stroke via currentColor; HOISTED to `src/ui/Sparkline.tsx` by ADR 0480 with a dashboard re-export — consumers pass `className` for styling (tiles: `dash-tile__spark`) and an optional `domain=[min,max]` for BOUNDED series like pass rates, where min-max auto-normalization would misrender a flat 100% week as a bottom-edge flatline; app-wide sparkline color register = `--clay`). No chart library (ADR 0377). ADR 0377 expanded the catalog to 31 tiles over the same shapes (shared fetch hooks `useTileData` caller-scoped / `useOrgResource` org-scoped). `.dash-picker` (a `.surface-card`) is the add-tile list in customize mode | Token-only, flat selectors; the `__bar` icon-only reorder/resize/remove controls are `.btn-ghost.btn-sm` with `aria-label` + `role="group"`, disabled at grid bounds; reorder announced via an `.sr-only` `aria-live="polite"` region; row hover uses `--clay-text`; `__stats` is a semantic `<dl>`. Tiles register in `allTiles.ts` (a separate registry, NOT the nav manifest — avoids the chrome⇄page cycle); resolution is fail-closed (owning-toggle ∩ tier ∩ enabled); org-scoped tiles resolve one shared memoized org via `useDashboardOrg` (Business tiles admin-tier + owning-toggle + default-off) |

### 5.1 Shared UI primitives — the cross-surface cohesion layer (`src/ui/`)

These exist so every surface (Chat, Agents, Workflows, Runs, Kanban, Roster, Org-chart, Registry, Settings, …) reads as **one** product instead of a dozen bolted-together apps. The failure mode they fix: a surface reimplementing a card/chip/notice/page-title with inline styles + hardcoded hex that bypass the token layer. That failure mode is now also a BUILD failure: `scripts/check-tsx-color-literals.mjs` rejects any raw hex/oklch/rgb literal in `.ts/.tsx` outside the sanctioned brand/icon files (white-label PRD §6). Defined once in `global.css`, plus the React primitives in `src/ui/` (`PageHeader`, `StateCard`, `Notice`, `Markdown`, `MarkdownEditor`). **Reach for these before hand-rolling an inline-styled widget.**

| Class / Component | Purpose | Notes |
|---|---|---|
| `a.btn` | navigational `<Link>`/`<a>` opting into the button chrome | selector-LIST arm on the existing `button` rules (base/hover/`.secondary`/`:focus-visible`/`.btn-sm`) — never `:is()`, so the `button` arm stays at (0,0,1) and class-only button resets keep winning. There is deliberately NO `.primary`/`.btn-primary` class: the bare `<button>` (or bare `a.btn`) IS the primary action; `.secondary` composes for the quiet variant. Use for CTA links that read as buttons (empty-state actions, back-to-list); use `.inline-link`/`.linklike` for text links |
| Modal-composed drawers (`.notifpanel-scrim`/`.netpanel-backdrop` + docked box) | edge-docked panels ride `ui/Modal`, not a second dialog system | `ui/Modal` is drawer-capable via its `scrimClassName`/`className` props: pass a scrim class that docks the box (`justify-content:flex-end` or a fixed-position child) and the drawer inherits the ONE focus-trap + Escape + focus-restore + `aria-modal` + scrim-dismiss contract. NotificationPanel and the devtools NetworkPanel are the references. A surface MUST NOT hand-roll a `role=dialog` overlay |
| `ui/Button` (`variant` primary/secondary/quiet/danger/link · `size` md/sm) | the explicit action-intent API (ADR 0510 §4) | maps 1:1 onto the existing button classes (bare = primary, `.secondary`, `.btn-ghost`, `.secondary.u-text-danger`, `.btn-link`; `.btn-sm`), so adoption is a no-visual-change refactor. `type` defaults to `button`; `loading` = `aria-busy` + disabled with the label still visible. New actions use it — `check-unwrapped-buttons` ratchets the raw `<button` count to zero, at which point the bare-element rule becomes reset-only |
| `ui/InlineState` + `EmptyRow` (`.inline-state*`) | the COMPACT designed-state primitives for embedded regions (ADR 0510 §4, DSA-030) | full-page states stay `<StateCard>`; panels/tabs/table bodies use `kind` loading/empty/failed. `failed` announces via the shared live region (or carries `role=alert`) and offers a retry — the honest-read doctrine at every size; `EmptyRow` is the `<td colSpan>` table arm |
| `ui/OrgSelectionState` | the ONE renderer for `useOrgSelection`'s three states (16 adopters; `src/ui/__tests__/orgSelectionEdgeRatchet.test.ts` is the authority — do not restate the number here, a grade pass caught this cell claiming 15) | owns the NOUN (organization — `listOrgs`, NOT the shell's `listMyWorkspaces` "workspace", which is a different collection) and the BRANCH ORDER: failed → empty → children, which is the load-bearing part. A failed read must not borrow the empty state's meaning, and empty must precede loading or the org-gated read never starts and the skeleton never terminates. Takes the content as `children` so the order cannot be skipped; `emptyBody`/`failedBody` keep each feature's own clause — pass a CLAUSE FRAGMENT (capitalised, no trailing stop, and do NOT restate "organization": the shared frame owns the noun, and a clause that names it again reads as a stutter in every Romance locale). `variant` selects `<StateCard>` (page) or `ui/InlineState` (panel) — it composes them, never reimplements. Empty names its next action (§5.1) only when the caller holds `host:org:manage`. |
| `.surface-card` | the one list/dashboard card primitive | clone of `.workflow-card`: `--paper` bg, `--rule` border, `--radius`, `--space-3 --space-4` padding, hover → `--clay` border / `--paper-2`, `:focus-visible` ring. Navigational cards render as `<a>` / `<Link>` so keyboard + semantics come free |
| `.card-grid` | responsive card grid | `repeat(auto-fill, minmax(280px, 1fr))`, `--space-3` gap, single column ≤ 640px. The **Grid** half of the §4.5 collection-view canon (rule 11) |
| `.list-view` + `.list-row` family (`.list-row-id` · `-name{-wrap,-line}` · `-sub` · `-meta` · `-actions`) | the dense **List** half of the collection-view canon (§4.5 rule 11) | one scannable row per entity on a `.surface-card.list-view`; a 3-cell grid (identity · meta · actions) with hairline row dividers, `--paper-2` hover, and a transparent identity button (name turns clay, no slab). Mobile collapses meta/actions below identity. `.roster-row` is the agent-specialized instance (adds avatar ring + autonomy). Token-only; no per-feature CSS — a feature supplies only the cell *content* |
| `.action-bar` | button-cluster wrapper | flex + wrap + `--space-2` gap; the one way to group Open / Run / Delete actions so they read as parallel |
| `.btn-sm` | small button size | 12px / `--space-1 --space-2`; replaces ad-hoc inline `fontSize` on buttons |
| `ui/Avatar` (`.ui-avatar`) | THE circular identity mark for people and agents (ADR 0192) | owns `initials()` (re-exported by `agents/AgentAvatar`, which composes this primitive under its role-badge/edit chrome). Kind by FILL: `--agent` = solid clay; humans = a deterministic hue wash (`--avatar-wash-*`/`--avatar-ink-*` tokens; numeric `--avatar-h` set by the component from a stable `hueKey`, e.g. the subjectRef). Never re-roll a circle-with-initials — compose this |
| `.msgbubble-bot-badge` | marks an agent-authored message + agent roster rows (ADR 0206) | tiny clay-wash pill, `--clay-rule` hairline, 10px uppercase; content is the localized `botBadge` ("Agent"); reuses the chip/pill register |
| `.msgfeed-unread-divider` / `.msgfeed-unread-label` | the "New messages" boundary + summarize action in a channel feed (ADR 0206 D5) | hairline `--clay-rule` rules flanking a clay-text label; hosts the ghost "Summarize what I missed" button; `role=separator` |
| `.chip` + `.chip--{success,warning,danger,accent,ai,muted}` | status / source / label chips | 12px pill; color families are token-driven (no hex); pairs a Lucide icon + text label so color is **never** the sole signal (§11) |
| `ui/InfoTip` (`.info-tip` · `.info-tip-trigger` · `.info-tip-bubble`) | a keyboard-discoverable tooltip that replaces bare `title=` on explanatory chips | the WAI-ARIA tooltip pattern: a focusable `<button>` trigger with an `aria-label`, the bubble linked via `aria-describedby` + `role="tooltip"`, shown on hover **and** focus, dismissed on Escape/blur. Token-only (`--paper-2` bubble, `--rule`, `--radius`, `--clay` focus ring). Holds SHORT non-interactive text only — for links/buttons or rich content use `ui/Modal` (a popover is a different pattern). Adopt where a chip's meaning isn't self-evident to keyboard/touch users |
| `ui/Tooltip` (`.tooltip-anchor` · `.tooltip-bubble`) | augments an existing link or button with a short text tooltip without replacing its native semantics | portalled to `document.body` so navigation rails and other scroll containers cannot clip it; linked with `aria-describedby` only while open; equivalent hover/focus behavior and Escape dismissal. Use `InfoTip` when the explanation needs its own info-button trigger; use `Tooltip` when the interactive control already exists. Short non-interactive text only |
| `.nav-badge` + `.nav-badge--beta` | feature-maturity badge on a nav item (Sidebar · admin rail · ⌘K) | the **nav-scale sibling of the `.chip` warning family** — a smaller 10px uppercase pill that fits the 13px nav row. `--beta` is warning-toned (`color-mix(var(--color-warning) …)`, no hex) and carries the text "Beta" so color is never the sole signal (§5.3, §11). Rendered by `useFeatureBadge()` when a feature-gated nav item's toggle resolves enabled + `status:'beta'`; hidden when the rail is collapsed |
| `.ui-input` | text-input baseline | `--space-2 --space-3` padding, `--rule` border, `--radius`; opt-in class (avoids regressing the many bare `<input>`s elsewhere) |
| `.surface-form` | inline "add" toolbar above a `DataTable` (CRM · CSM · Users) | a wrap-row of `<label>`/`.field` items, each `flex: 1 1 12rem` so the global `input{width:100%}` baseline doesn't stack them into a tall column; submit button trails baseline-aligned. Add `.is-narrow` to a short field (a 0–100 score). Use on a `.surface-card` (the compound selector beats the card's column direction). Replaces the hand-rolled `surface-card u-flex u-wrap u-items-end` add-forms that blew out into a giant empty card |
| `.tabs` + `.tab` | in-page tab strip (CRM Contacts/Companies/Deals/Tasks) | editorial underlined strip: `--rule` baseline, `--clay` active marker on `[aria-selected="true"]`, ink-3 → ink on hover. Replaces hand-rolled `btn-primary`/`btn-ghost` tab rows (which read as heavy paper blocks). `role="tablist"` + `role="tab"` on the buttons |
| `<Tabs>` + `<TabPanel>` + `useUrlTab` (`src/ui/Tabs.tsx`, ADR 0144) | the ONE tablist primitive over the `.tabs`/`.tab` CSS above | wires the a11y each hand-rolled tablist used to reimplement per-surface: tab↔panel `id`/`aria-controls`/`aria-labelledby`, `aria-selected`, roving `tabIndex` (via the shared `rovingTabs.ts` keydown handler) — presentational and routing-agnostic, so the consumer owns `value`/`onChange` and renders the active panel as a conditional sibling inside `<TabPanel idBase tabId>`. `useUrlTab(param, validIds, fallback)` binds the active tab to a `?tab=` search param (replace-history) for the common case. Consumers: Projects, Access Hub, Models Hub, Chat Deployment Hub, Campaign Studio Hub, Profiles, CRM. Zero new tokens/CSS — it rides the existing `.tabs`/`.tab` rules. **A surface MUST NOT hand-roll a second `role="tablist"`** — adopt this |
| `.proj-*` dossier family (`.proj-eyebrow` · `.proj-lead` · `.proj-section` · `.proj-meter` · `.proj-tile{--agent}` · `.proj-row{__main}` · `.proj-grid{--4}` · `.proj-ms-edit` · `.proj-lineup` · `.proj-check{--done}`) | the project tabs' editorial layer (ADR 0054 — Overview/Members/Chat) | a `--mono` uppercase section kicker (`.proj-eyebrow`) + `--serif` goal lead (`.proj-lead`); hairline-delimited `.proj-section`s; a slim clay progress `.proj-meter`; person/agent `.proj-tile`s (`--agent` = clay tint); left-content / right-action `.proj-row`s (fixes the centered-member bug — never reuse `surface-form` for a full multi-field form, that's an *inline add-toolbar*); responsive `.proj-grid--4` for the status/timeline form; tokens only |
| `.state-card` + `<StateCard>` (`src/ui/StateCard.tsx`) | empty / loading / error block | dashed border, optional Lucide `icon`, title, one-line body, and **one** next-action CTA. Every empty state MUST name its single next action. `loading` marks the region `aria-busy`. **`announce` (§4.6 rule 8) speaks the TITLE through ADR 0363's `GlobalLiveRegion`** — set it on FAILED reads only, never on empty or loading; the card does NOT render its own live region, because one mounted with its text already inside is not reliably announced |
| `<Notice variant=success\|error\|info\|warning>` (`src/ui/Notice.tsx`) | transient notice | renders `.alert.{variant}` + a leading Lucide icon + `role="status" aria-live="polite"` — never bare colored text, never a hardcoded hex, never a `⚠`/`✓` emoji prefix |
| `<RunInputsForm>` + `<RunInputsDialog>` (`src/ui/RunInputsForm.tsx`) | the ONE renderer of a workflow's run-input contract (`variables[]`, ADR 0186 / Phase 4) | builds a typed form from the declared inputs using the shared `<TextField>`/`<CheckboxField>` primitives (never a hand-rolled control); required-empty disables Run with a `role="status"` hint; pure `initialRunInputValues`/`toRunInputs`/`missingRequired` helpers coerce + validate. Dialog composes `<Modal>` (error surfaced above the scrim). A surface that runs a workflow with declared inputs MUST use this, not a bespoke input UI |
| `<KanbanBoardView>` (`src/kanban/KanbanBoardView.tsx`) | the ONE Kanban board renderer | shared by `/boards` (KanbanPage) and the embedded agent-workspace Board tab. @dnd-kit drag-and-drop (pointer + keyboard sensor) + rich cards (source chip, workflow name, priority, run link, assignee) + trigger-lane affordance. Accepts an optional `leadingColumn` slot rendered leftmost, outside the droppables (the personal board's "Assigned to me" rail); `onCreateCard` is optional (absent ⇒ no add-card affordance — non-task boards like the CRM deal pipeline create records through their own domain forms) and an optional `columnFooter(column, cards)` slot renders per-column meta (the CRM board's count + amount rollup). Consumers: /boards, agent-workspace Board tab, CRM Deals board. A surface MUST NOT reimplement a second board |
| `<AssignedColumn>` (`src/kanban/AssignedColumn.tsx`) | the ONE "Assigned to me" rail (ADR 0049 correction #3) | the read-only synthetic leftmost column on the personal board: the caller's open assigned cards (cross-board, same records — never droppable, never draggable), each with a `.chip` status + origin-board link + Claim for role-addressed cards. Uses `.kb-col--assigned` (sticky-left, accent-edged). Rendered via `KanbanBoardView`'s `leadingColumn`; collapses away when empty. Replaced the standalone `/my-work` page. A surface MUST NOT reimplement a second assigned-to-me view |
| `<AssigneeControl>` (`src/kanban/AssigneeControl.tsx`) | the ONE card-assignment picker (ADR 0049) | on a board card: shows the assignee (`.kb-person` + `<UserIcon>`) and, on expand, a workspace-member `<select>` + Unassign; POSTs the assign route, which notifies the assignee + surfaces the card on their "Assigned to me" personal-board rail. Members lazy-loaded once per active workspace; pointer events stopped so it never starts a drag; icon-only close carries an `aria-label`. A surface MUST NOT reimplement a second assignee picker |
| `<CollabPresence>` (`src/canvas/CollabPresence.tsx`, ADR 0359 Phase 4) | the ONE live-session presence cluster | the canvas toolbar's status-line identity: a `.chip` Live indicator (success dot, reduced-motion-safe pulse; muted “Reconnecting…” when the socket drops) + an overlapping stack of ≤4 peer `ui/Avatar`s (+N overflow chip). Peers only — never self; identity color is entirely Avatar's deterministic `hueKey` (no palette of its own). Companion `.cv-presence__rowmark` = the tiny peer markers on frame tabs / element-list rows (who is on what). Join/leave announcements are COALESCED (2 s) into the polite live region via `useCollabPresence`; selection changes are never announced. A surface MUST NOT reimplement a second presence cluster |
| `<CommentsPanel>` (`src/features/comments/CommentsPanel.tsx`) | the ONE comment-thread renderer (ADR 0021) | self-loads a `(orgId, resourceType, resourceId)` thread over `commentsClient`; add / reply / resolve-reopen / delete, status as a labelled `.chip` (§5.3), `<Notice>` + `toast` feedback, `<StateCard>` empty. Backs the standalone `/comments` page now; **embeds in the CMS editor + KB collection view next**. A surface MUST NOT reimplement a second comment thread |
| `<MemoryBrowser>` (`src/memory/MemoryBrowser.tsx`) | the ONE subject-memory browser (ADR 0041) | subject-agnostic list/add/delete of curated memories over injected `list`/`add`/`remove` callbacks, so the SAME renderer backs the agent-workspace **Memory** tab (`agent:<id>`) and the My-Profile **Memory** tab (`user:<id>`). `.surface-card` + `<Field>` add box + `<StateCard>` empty/loading + `<Notice>` errors; untrusted entries carry the labelled `chip--warning` "External · unverified" (§5.3); icon-only delete has an `aria-label`. An optional `readOnly` prop (ADR 0063) renders the list with NO add/delete controls for a non-writer (default off — agent/profile surfaces unchanged). A surface MUST NOT reimplement a second memory browser |
| `<SubjectKnowledgePanel>` (`src/knowledge/SubjectKnowledgePanel.tsx`) | the ONE subject-knowledge curation browser (ADR 0046 follow-on / ADR 0042) | subject-agnostic create/bind/unbind a KB collection, ingest/remove a text document, and search the corpus (docs + the subject's memory, via the shared composition) over an injected `client` + subject-flavored `copy`, so the SAME renderer backs the My-Profile **Knowledge** tab (`user:<id>`) and the project **Knowledge** tab (`project:<id>`). `.surface-card` + `<Field>`/`<TextField>`/`<SelectField>` + `<StateCard>` empty/loading + `<Notice>` errors; externally-imported docs carry the labelled `chip--warning` "External · unverified" (§5.3); icon-only delete has an `aria-label`. An optional `readOnly` prop (ADR 0063) suppresses create/bind/ingest/delete (search stays) for a non-writer (default off). A surface MUST NOT reimplement a second knowledge browser |
| `<SubjectSchedulesPanel>` (`src/schedules/SubjectSchedulesPanel.tsx`) | the ONE schedule-curation UI for every subject (ADR 0046 follow-on / ADR 0025) | subject-agnostic list/create/edit/pause/delete (+ optional "Run now") of scheduled workflows from a cadence preset, over an injected `client` (CRUD + optional `trigger`) + the assignable `workflows` portfolio + subject-flavored `copy`, so the SAME renderer backs the My-Profile **Schedules** tab (`user:<id>`), the agent workspace **Schedules** panel (`agent:<id>`), and the project **Schedules** tab (`project:<id>`). `.surface-card` rows + `Active`/`Paused` `chip` (§5.3) + `<StateCard>` empty + `<Notice>` errors; cadence/workflow `<select>`s carry `aria-label`. An optional `readOnly` prop (ADR 0063) hides the per-row edit/pause/delete + the create form for a non-writer (default off). A surface MUST NOT reimplement a fourth schedule renderer |
| `<ConversationsRail>` (`src/chat/conversations/ConversationsRail.tsx`) | the ONE chat-sidebar conversation list (ADR 0043) | the typed persistent-conversation rail — People · Agents · Groups (`conversationGroups.ts`); the sole chat-sidebar IA (it REPLACED the chat-history drawer + the in-chat "Active agents" panel, both deleted along with the `conversations-v2` rollout toggle). The open conversation's live participants fold in at the top (switch/remove); unread rows get an accent dot **+ bold title + `aria-label`** (never colour alone, §5.3); `<Notice>` errors + `<StateCard>` empty; icon-only row actions carry an `aria-label`. A surface MUST NOT reimplement a second chat-conversation list |
| `<ConversationView>` (`src/chat/ConversationView.tsx`) | the ONE reusable conversation body (ADR 0073) — message feed/welcome + error + optional `footerSlot` + composer, **NO header, NO left rail, NO right progress panel** | presentational (owns no chat state; never calls `useChatSession`, so a surface keeps one session/SSE subscription). The full chat surface (`ChatSidebar`) wraps it with chrome; an embed (e.g. the workflow builder) renders it slimmed, scoped to an agent. A surface MUST NOT reimplement a second chat body — embed this |
| `<EmbeddedConversation>` (`src/chat/EmbeddedConversation.tsx`) | the reusable, slimmed chat EMBED for non-chat surfaces (ADR 0073) — the builder's "Create with AI" is the first consumer | owns an EPHEMERAL `useChatSession({persist:false})` (task-scoped; never touches the user's main chat session/index), scopes to an agent via `useScopeToAgent`, renders `<ConversationView>` with a CORE submit subset (command / `/workflow` / `@agent` / send — no convene/board). To put AI in a feature, reuse THIS (or deep-link the main chat); a feature MUST NOT build a new chat. Lazy-import it to avoid a static cycle into `chat/` |
| chat-input pickers (`src/chat/SlashAutocomplete.tsx`, `AgentMentionAutocomplete.tsx`, `BoardMentionAutocomplete.tsx`) | the ONE chat-input affordance family — `/` commands+workflows · `@` agents · `@@` boards | caret-triggered popovers over the chat `<textarea>`, rendered via the shared `.mentionac-*` classes (listbox/option a11y, ↑↓/Enter/Tab/Esc with `stopPropagation` so Enter never submits a half-typed token; loading/empty/error via `.mentionac-empty` tone-by-token). Each trigger is mutually exclusive (single `@` vs `@@`; `/` distinct). A new chat-input affordance MUST join this family, not hand-roll a fourth popover |
| `<WalkthroughOverlayHost>` (`src/walkthroughs/WalkthroughOverlayHost.tsx`, `.walkthrough-*`) | the ONE guided-walkthrough player chrome (ADR 0368 P3 / 0378 / 0489) — mounted once by the chrome; every surface launches through the bus, never its own overlay | scrim-with-cutout (four rects, the cutout stays interactive for HITL) + spotlight + cursor dot (`prefers-reduced-motion` ⇒ the spotlight jumps, no glide) + HITL beacon; a bottom `.walkthrough-caption` (`role="status"`, flips to the top when the target sits in the bottom band) carrying narration + `.chip` position + `.action-bar` verbs; a **non-modal** `.walkthrough-steps` companion panel — the documented carve-out from "drawers ride `ui/Modal`", because Modal's focus trap + `aria-modal` would break HITL, where the user MUST reach the page. Step states are `upcoming / current / done / skipped`; **skipped** (ADR 0489 — a checkpoint found the state already satisfied) is a labelled `.chip--success` + `sr-only` reason, never colour alone, and is also toasted since the caption is overwritten by the next step. Escape pauses; focus returns to the launching control on stop; `.walkthrough-scroll-inset` reserves the caption band for scroll-into-view (WCAG 2.2 §2.4.11) |
| `<InteractiveViewer>` (`src/canvas/InteractiveViewer.tsx`, `.cv-viewer__*`) | the ONE interactive multi-frame walkthrough for canvas documents (ADR 0305 Phase D; framework-owned since ADR 0310 Phase A) | one frame at a time via the type's SHARED renderer; tap-through switches frames (delegated `[data-cv-nav]`, the keyboard path is the frame-tab strip); `<AppBuilderInteractiveViewer>` (`src/chat/artifacts/`) is the app-builder binding, consumed by the preview page (`/app-builder/:canvasId/preview` — device presets, theme override, fullscreen, real `hideOn`) AND the public shared view (lazy). A surface MUST NOT hand-roll a second canvas walkthrough |
| `<CanvasWorkbench>` + `<CanvasWorkbenchStatus>` (`src/canvas/CanvasWorkbench.tsx`, `.cv-workbench__*`) | the shared visual frame for every full-screen canvas composition (ADR 0739) | lifecycle-neutral command → mode → rails/stage → status grammar shared by the document-backed `<CanvasEditorPage>` and engine-backed `<CanvasSurfaceShell>`; it owns only the root marker and an aria-labelled, non-live footer for truthful context/shortcut hints. It never owns documents, engine state, persistence, undo, collaboration, authorization, or type behavior. Types may supply a localized mode-strip label and a narrowly scoped modifier through `CanvasTypeDefinition.workbench`; App Builder is one consumer, never a dependency of the core shell. |
| `<CanvasEditorPage>` (`src/canvas/CanvasEditorPage.tsx`, `.cv-editor__*`) | the ONE visual canvas editor chassis (ADR 0153 Phase 2b + ADR 0305 Phase B; extracted as the canvas framework in ADR 0310) | three-column full-screen surface driven by a typed `CanvasTypeDefinition` (all traits optional — the chassis picks the mode: tree, frames+`propDefs` fixed-schema (Phase-B slides), or flat `elements` collections + `docPropDefs` (Phase-C drawings/cad/campaign)): palette from the type's closed host catalog (click/Enter adds — the keyboard path; drag places precisely), frame-tab strip (drag-reorder + `ui/Menu` actions + inline rename), live preview via the type's SHARED renderer (`editPaths` stamps `data-cv-path` + `draggable`; delegated click-select + native HTML5 drop targets, accent `cv-drop-target` ring cleared on leave/drop/dragend), outline rows (`<OutlineTree>` — buttons: select/drag/insert-before) / an ARIA-multiselectable element list (`role=listbox`, roving `role=option` rows, Space/Shift multi-select — the chassis owns the one `multiSel`, shared with the interactive canvas, ADR 0317), catalog-driven property panel (`<PropertyField>` built-ins + the definition's widget registry) with keyboard-equivalent arrange actions (Move up/down/out/in, Duplicate — every drag has a keyboard twin). DnD idiom: native HTML5 like the builder palette (the canvas/tree case; `@dnd-kit` stays the Kanban idiom). Undo/redo via the shared `useHistoryState` (§5.1). Consumers: app-builder (tree), slides (frames-only), drawings/cad/campaign-studio (elements — `features/<id>/definition.tsx` each), and pack-declared types via the synthesized data definition (`canvas/packDefinition` → the generic `/canvas/:typeId/:canvasId` route, ADR 0310 Phase D). A definition MAY supply a `PreviewPanel` (RFC 0130 / ADR 0310 Phase E) that replaces the Renderer in the center — the pack editor mounts the ui-plugins `PluginFrame` (canvas-preview surface) through it, with `host.documentChanged`/`host.selectionChanged` pushes and `host.announce` into the editor's live regions. A canvas type MUST NOT reimplement a second editor chassis or fork its shared renderer **ADR 0337 — the header is a single NARROW toolbar (`.cv-editor__bar`, ~2.75rem, `flex-nowrap`+`overflow-x:auto`, never wraps tall): identity left (back + inline editable `.cv-editor__name` at `--text-body` 600 with a compact `.cv-editor__status` = `.cv-editor__version` + Unsaved chip) → a `.cv-editor__spacer` (flex:1) → right-anchored action clusters hairline-separated by `.cv-editor__bar-sep` (undo/redo/help · view toggle · Preview/Share/History · Save primary · framework/Export) → the destructive Delete pushed to the far end via `.cv-editor__delete-sep`. All six canvas types inherit it. |
| direct-manipulation canvas (`src/features/{drawings,cad}/Interactive*.tsx`, `.cv-draw-interactive__*`) | the on-canvas editing layer for elements-trait types (ADR 0317) | an OPTIONAL `InteractivePreview` a type supplies to `<CanvasEditorPage>` — replaces the read-only Renderer in the center with a click-to-select + drag SVG. Drawings: move (all kinds) + resize handles (rect/circle/ellipse/line) + per-vertex handles (polyline/polygon) + snap-to-grid + a per-shape rotate knob (in-plane `rotation` field, knob-up = 0°) + multi-select (marquee INTERSECT default / Alt=CONTAIN, Shift-toggle, group-move, group RESIZE (uniform scale from the opposite corner) + group ROTATE (about the group centre), "Delete N"); CAD: drag a solid's footprint to move (X/Y), drag the knob to rotate (in-plane `rotation` field), drag an edge handle to resize (centre-preserving). All mutation flows through the chassis `patchElement`/`patchElements`/`deleteElements` so a whole (group) drag is ONE undo step; multi-select is CHASSIS-OWNED (the one `multiSel` shared with the element list, ADR 0317 — the derived single-select `selEl` drives the panel at N=1, cleared at N≠1 so the panel is never blank); geometry is pure + unit-tested (`shapeGeometry`/`cadGeometry`/`cadProjection` — rotation via `rotatePoint`/`shapeRotatePatch`/`groupRotatePatch`, rotated resize/vertex drags un-rotate the pointer into shape space first), visuals reuse the SHARED safe renderer (`ShapeEl`/`CadSolids`, rotation applied as an in-plane SVG `rotate` about the shared `shapeCenter` pivot) — never a forked render path. The hit layer is `aria-hidden` (the element list + property panel stay the keyboard/a11y path); selection outline = dashed `--clay-text` ring, resize handles = `--clay-text` squares, vertex/rotate handles = surface circles with an accent ring. **ADR 0333 Phase 3 — ink:** pen/highlighter/eraser tools ride the chassis `tools[]` seam (crosshair/cell cursors; hit layer + selection overlays are SELECT-mode-only); the live stroke is a `currentColor` overlay path (`.cv-draw-interactive__live`); commits land via the chassis `addElements` seam (one undo step; pointercancel DISCARDS); strokes store a point+pressure SPINE re-rendered by `chat/artifacts/strokePath.ts` beside the safe renderer (one render path — never a baked outline, never raw markup). Element chrome: lock/hide toggles on the list rows are pointer sugar with stable names + `aria-pressed`; the property panel's Name/Locked/Hidden fields are the canonical keyboard/AT surface; hidden rows dim + line-through (never color alone). Freehand ink itself has no keyboard creation path (WCAG 2.5.7 "dragging is essential" carve-out — recorded in ADR 0333). **ADR 0333 Phase 5:** move drags snap to SIBLING edges/centers via the pure core engine (`src/canvas/snapping.ts` — candidates built once at gesture start; Ctrl/⌘ bypasses; the grid checkbox wins when on; accent dashed `.cv-draw-interactive__snap-guide` lines); Shift snaps rotation to 15°; the chassis panel offers align/distribute over a multi-selection through the `bboxFor`+`movePatchFor` collection seams (pure `canvas/alignOps.ts`, one `patchElements` batch, locked/hidden skipped, text-labeled keyboard-native buttons). **ADR 0333 Phase 8:** export = a stripped CLONE of the live scene svg (`canvas/exportUtils.ts` — classed chrome removed, class-free renderer content survives; SVG/PNG/copy buttons in the type bar); two-finger tap = undo / three-finger = redo on the chassis preview container (a second touch cancels live touch-ink); eraser deletions announce counts; a dismissible pristine-doc hint teaches the tools. Esc cancels a live gesture (grade-pass DRAW-R3): the chassis bumps a `cancelSignal` so the type drops its overlay drag/ink/eraser/draw, and reverts a drag’s pushed history entry. A type MUST NOT fork its renderer or add a second mutation path for this |
| `<ViewportSurface>` (`src/canvas/ViewportSurface.tsx` + `useCanvasViewport`/`viewport.ts`, `.cv-viewport__*`) | the ONE pannable/zoomable wrapper for canvas scenes (ADR 0333 Phase 1) | a canvas type composes it around its own scene element (type chrome — snap toggles, counts — stays OUTSIDE the transform so it never scales); the stage carries a plain CSS transform, so consumer pointer math via `getScreenCTM` is unaffected and SVG stays vector-crisp. Gesture grammar (app-wide, matches the graph surface): plain wheel PANS, Ctrl/⌘+wheel ZOOMS focally (native non-passive listener), Space/middle-drag pans (captured before children), two-pointer pinch on touch; plain left-drag stays the consumer's (marquee/shape drag). Zoom chrome is the shared `<ZoomCluster>` (§7.3 / CV-6 row below) floating bottom-right; it publishes its zoom handle via `ViewportHandleContext` so the chassis ⇧1/⇧2/⇧0 shortcuts reach it; the wrapper is a focusable labeled `role=region` — **arrow keys pan** (Shift ×4, the WCAG drag alternative) and edge scrolling auto-pans consumer drags near the edge (ADR 0333 Phase 2). Supports a CONTROLLED mode (`vp` prop from the consumer's own `useCanvasViewport`). The pan/zoom formulas live in pure `canvas/viewport.ts` (ONE owner — `graph/edgeRouting` delegates, its [0.25,1] fit clamp pinned). Viewport state is ephemeral — never in `useHistoryState`. Consumers: drawings + CAD interactive editors; the graph surface adopts the hook in a recorded follow-up. A surface MUST NOT hand-roll a second pan/zoom wrapper |
| canvas shortcut registry + cheatsheet (`src/canvas/shortcuts.ts` + `ShortcutsOverlay.tsx`, `.cv-shortcuts__*`) | the ONE window-keydown owner per canvas editor (ADR 0333 Phase 2) | declarative `ShortcutDef` table: chassis defaults (⌘Z/⇧⌘Z/⌘Y, Esc back-to-select/clear, ⌘D duplicate, ⌘]/⌘[ overlap-aware z-order step + ⌥⌘]/⌥⌘[ extremes, `?` cheatsheet) merged with the definition's extras — a colliding or reserved combo (⌘K = the global CommandPalette's) is DROPPED with a dev warning; text contexts, IME composition, and open `aria-modal` dialogs never match. The `?` overlay renders through ui/Modal (scrim/Escape/focus-trap), grouped + localized, `<kbd>` combos per platform (⌘ vs Ctrl). A canvas surface MUST NOT add a second window keydown listener — register here |
| document editor surface (`src/features/document-editor/DocumentEditorSurface.tsx` + `SlashMenu.tsx`, `.doc-editor__*`/`.doc-slash__*`) + `<FlowOutline>` (`src/canvas/FlowOutline.tsx`, `.cv-outline__*`) | the `canvas.document` rich-text editor (ADR 0334) — the FIRST `EditorSurface`-seam consumer — plus the chassis heading outline for `flow`-trait types | the TipTap/ProseMirror surface mounted as the chassis center panel: a `role=toolbar` of `IconButton`s (bold/italic/inline-code/H1-H3/lists/quote/code block — every control labeled + `aria-pressed`, actions announced through the chassis live region), the editable region a labeled `role=textbox aria-multiline`, token-only typography on the doc-editor classes. UNDO OWNERSHIP: the surface owns intra-document undo/redo (the engine history — the chassis hides its own undo buttons for EditorSurface types); an external re-seed (version restore) resets the engine history so ⌘Z cannot resurrect the pre-restore doc. The `/` slash menu is an `aria-activedescendant` listbox (options are NOT tab stops; ↑/↓/Enter, Esc/click-away closes; body-mounted `position:fixed` popup clamps to the viewport and tracks scroll/resize). `<FlowOutline>` renders `def.flow.headings(doc)` as level-indented buttons that scroll the preview to the Nth semantic heading. The read path is the type's `DocumentRenderer` (same closed schema, non-editable engine — no `dangerouslySetInnerHTML`; link hrefs protocol-allowlisted at render). A second rich-text engine, a forked toolbar, or a second slash-menu implementation MUST NOT ship — extend this one |
| `<ColorField>` (`src/ui/ColorField.tsx`, `.ui-color-field__*`) | the ONE color input (ADR 0333 Phase 6 — upgrades the ADR 0305 native-picker+hex pair in the canvas `color` built-in) | constrained-palette-first (the Excalidraw/FigJam pattern): a labeled swatch row of THEME-DERIVED colors (token values resolved at runtime — documents store CONCRETE values, `var()` never leaks into a doc), a `none` swatch (diagonal-strike, for SVG fills; `allowNone={false}` for text colors), session recents, then the native picker + free-text escape hatch and the platform EyeDropper (PipetteIcon) when available. Every swatch is a real labeled button with `aria-pressed`; fully keyboard-operable. Consumers: every `type:'color'` canvas prop (drawings paint fields, slides/app-builder/campaign color props) via `PropertyForm` — a surface MUST NOT hand-roll a second color picker |
| Unified Documents list (`src/features/documents/DocumentsPage.tsx` + `CanvasDocCard`/`CanvasDocRow` in `DocumentViews.tsx`) | the ONE "stuff I made" surface — markdown documents AND canvases as peer rows (ADR 0319; the standalone Canvases page is retired, and "Canvases" is gone from the UI) | one newest-first list unioning `DocumentRecord` + `CanvasSourceRow`, `<ViewToggle>` grid/list, client title/name filter (shown >3 items). A canvas is a document row: the shared `canvasTypeIcon` + the `canvas`-ns `type_*` name as the sub-line + a project `chip`; it opens its editor when its single type toggle is on, else shows an "Off" `chip` and isn't openable but stays deletable (`DELETE …/canvases/:canvasId`, the one `deleteCanvasForTenant` cascade owner). Same `.surface-card` grid / `.list-view` cells + `<StateCard>` empty/no-match as documents — never a second inventory or a forked row. A surface MUST NOT reimplement a canvas list |
| `NewDocumentModal` creation gallery (`src/features/documents/NewDocumentModal.tsx`, `.doc-gallery__*`) | the ONE "make something" entry point on the Documents page (ADR 0314) | three labeled groups — Write / Design / Start from existing — of compact `.surface-card` gallery cards (icon + noun + one-line hint, `.doc-gallery__cards` auto-fill grid, 1-col ≤640px). Design cards render one per toggle-ENABLED canvas type (live `useFeatureAccess`; pack types via the canvas-packs types endpoint) — never a dead tile; first-party type metadata comes from the drift-test-pinned `canvas/creatableTypes.ts` registry and the `canvas`-ns `type_*` vocabulary. "From a canvas" is a picker over the tenant's real canvases (`.doc-gallery__picker`, name + type `chip` + updated date; `<StateCard>` empty state) — never a raw-id input. Create steps carry an optional project `<select>` (ownerSubject). A surface adding a creatable kind joins THIS gallery, not a new footer link |
| `<A2uiSurfaceCard>` (`src/chat/a2ui/`) | the ONE renderer for agent-authored A2UI surfaces (`ui.a2ui-surface`, RFC 0102 / ADR 0051) | renders a declarative surface from the **host-pinned closed catalog** (`catalog.ts`, 0.9.1) as a real form using the shared `<TextField>`/`<SelectField>`/`<CheckboxField>` primitives — never agent-supplied markup. Fail-closed via `parseSurface`: an out-of-catalog/malformed/version-mismatch surface renders a `<Notice variant="warning">`, never unknown content (`a2ui-surface-no-code-exec`). Agent `heading` levels are rendered as `role="heading"` with an OFFSET `aria-level` so they can't hijack the chat outline (§11). The single action is confined to `resolve` (interrupt resume) or `exchange` (RFC 0005) — no other host call. Reached from an interrupt via `a2ui/interruptBridge.ts`. **A2UI v0.9 (RFC 0209 / ADR 0749):** a `version: "v0.9"` payload is dispatched inside the SAME card to `a2ui/v09/` — the closed ten-component profile (`profile.ts`, parity-pinned to `schemas/v2`), the pure fold (`fold.ts`), and a renderer that walks from `root` and renders NOTHING (a muted `role="status"` line) until the fold holds one; layout maps to `u-flex`/`u-gap`/`u-justify-*` utilities, `Card` to a `u-border u-radius` inset, `chips` to small `aria-pressed` `<Button>` toggles inside the legend-named fieldset (a `radiogroup` was dropped in #4132: plain buttons do not keep the radio arrow-key contract), a vertical `Divider` rendered unwrapped + `u-self-stretch` so it spans its Row, and the agent's `theme.primaryColor` is deliberately ignored (host tokens only). A surface MUST NOT reimplement a second A2UI renderer |
| `ActionCard` (`src/notifications/ApprovalsInbox.tsx`) | the ONE approval action card (ADR 0023 §12 T4) | renders an assistant-action `PendingApproval` as a `.surface-card`: kind `.chip` + severity chip (`chip--danger/--warning/--muted` with the visible `risk: <level>` label, §5.3) + taint/edited `chip--muted` banners, destination, draft preview with inline-edit `textarea`, recipient diff, why-recommended, source citations (`safeHref` — http(s) only; untrusted URLs render as text), Approve/Reject/Edit `.action-bar`. Lives inside the polymorphic `<ApprovalsInbox>` (run-proposals render a compact row; assistant-actions render this card). A surface MUST NOT reimplement a second approval renderer |
| `<ArtifactWorkbench>` + `ArtifactDiffView` / `RevisionTimeline` / `ProvenancePanel` (`src/chat/artifacts/`) | the ONE durable artifact side-surface over the type-neutral `/artifacts` projection (ADR 0069) | a `ui/Modal` with Preview / Raw / Revisions / Diff / Provenance tabs (`role="tablist"`/`tab`/`tabpanel`, `aria-selected`). Loads by stable `artifactId` so it survives reload + reopens from chat history. Diff is **server-computed** over two IMMUTABLE revisions (line view for text, path/op table for JSON; add/remove tones via token `color-mix`, never hex); the revision timeline drives the (from,to) compare via labelled checkboxes. Provenance is a read-only `dl` (run/node/template/owner — no secret material). `<StateCard>` loading/empty + `<Notice>` errors. Read-only in v1 (promote/publish/export stay on the owning Documents surfaces). `ArtifactPreviewModal` links here when a node output is artifact-backed. A surface MUST NOT reimplement a second artifact viewer. |
| `<ReviewCard>` + `<ReviewInboxPanel>` (`src/chat/reviews/`) | the ONE **unified** human-review card + inbox over the `/reviews` projection (ADR 0068) | the cross-source SUPERSET of `ActionCard`: renders a normalized `ReviewRequest` (runtime interrupt OR pending approval) as a `.surface-card` — source chip (In-flight / Proposal) + kind + risk chip (`chip--danger/--warning/--muted` with the visible "`<level>` risk" label, §5.3) + summary + requester/requested/due metadata + provenance `chip--muted` list + optional reviewer-note `textarea`; **actions are derived from the backend record** (`btn-accent-solid` approve/resolve, `secondary` reject), so an empty action list renders read-only (resolved). Stale-safe: a decided card disables its buttons (`aria-busy`) and the backend 409s a second decision. `<ReviewInboxPanel>` lists pending reviews with `<StateCard>` loading/empty/error + `<Notice>` confirmation. This is the inbox the approval-only `<ApprovalsInbox>` migrates INTO; until then both exist (`<ApprovalsInbox>` keeps the rich assistant-action editor). A surface MUST NOT reimplement a THIRD review renderer. |
| `<AgentTile>` (`src/agents/AgentTile.tsx`) | the agent **profile tile** — the default `/agents` management view (IA refresh 2026-06) | `.surface-card` in a `.card-grid`: avatar + status ring, name + status `.chip`, role, a contextual sub-line, `<AutonomyMeter>`, board counts, and Check-now/Chat/primary `.action-bar`. Shares `primaryAction`/`subLine` (exported from `RosterRow`) with the dense `<RosterRow>` list-toggle so tiles and list never diverge. Composed from existing primitives — no bespoke tile CSS |
| `<WaitingBlockers>` (`src/notifications/WaitingBlockers.tsx`) | the Inbox "waiting on the board" section (IA refresh 2026-06) | lists agents whose board has a card parked in the Waiting lane (`loadAgentViews` → `status==='waiting'`): avatar, blocker note, **"Open board"** — no resume API, so the affordance is honestly just navigation, never an approval action. Sits beside `ActionCard` in the Inbox action portal; display-only, MUST NOT reimplement an approval path |
| Briefing card + `BriefingRow` (`src/features/assistant/AssistantPage.tsx`) | the ONE source-grounded briefing surface (ADR 0023 §12 T3) | `.surface-card` over the batched `/assistant/briefing` read: headline, at-risk lane, top priorities, today's meetings; every line carries its "why surfaced" + a cited source link (`safeHref`) and a `chip--muted` marker for connected-source items. `SkeletonRows` placeholder while loading |
| Assistant-health card (`src/features/assistant/AssistantPage.tsx`) | admin-only operating-metrics card (ADR 0029) | `.surface-card` shown only when `GET /assistant/health` resolves (403 ⇒ hidden — never surface an action that would fail); approval/edit/citation/taint rates + commitment staleness in prose, no bespoke chart machinery |
| `<GovernancePanel>` (`src/features/connections/GovernancePanel.tsx`) | the ONE workspace-policy editor (ADR 0028) | superadmin-only `.surface-card` on the Connections page (hidden on 403): provider-allowlist checkboxes + per-action-kind policy `<select>`s (labels wrap the controls), save via `.action-bar` + `toast` feedback. A surface MUST NOT reimplement a second policy editor |
| `<Markdown>` (`src/ui/Markdown.tsx`) | read-only GFM renderer | `react-markdown` + `remark-gfm` via the shared `chat-md` prose class; XSS-safe (no `rehype-raw`; unsafe link protocols stripped); links open in a new tab, task-list checkboxes disabled. The one way to render agent prose (descriptions, instructions, task details) |
| `<PageHeader>` (`src/ui/PageHeader.tsx`) | the one editorial page-title primitive | mono uppercase `eyebrow` kicker (`--ink-3`) + **sans 700 `title`** (`--text-display`, out-ranks the cards below; *corrected from "Instrument-Serif" per §1's 2026-06-05 sans directive*) + one-line sans `lede` (≤ 64ch) + right-aligned `actions` (`.action-bar`), over a hairline rule. Separated from page content by the `--space-5` band. Every top-level page leads with this instead of a bare `<h1>`/`<h2>` |
| `<KeyFigureBand>` (`src/ui/KeyFigure.tsx`) | the one key-figures surface (§4.5 "stats are filters") | serif tabular `--text` numeral over a mono uppercase label, in a bordered depth-band. Pass `onToggle`+`activeKey` to make tiles **`aria-pressed` filters** of the data below; `tone:'attention'` tints an at-risk numeral amber. Optional `sub`/`subTone` renders a quiet one-line context under the numeral (period deltas — "+12% vs prior 30 days"; `up`/`down` tint success/danger, `neutral` stays muted; added 2026-08-01 for the analytics prior-period comparison). Replaces bespoke `run-stat`/`wf-figure`/`wforce-metric`. |
| `.page-stack` (CSS) | the page major-section band | `display:grid; gap:var(--space-5)` — the documented 24px band rhythm given a class. Wrap a page's major sections in it; reserve `u-gap-4/3` for INTRA-section grouping. |
| `<MarkdownEditor>` (`src/ui/MarkdownEditor.tsx`) | Markdown editing surface | textarea + formatting toolbar (icons from `ui/icons`), Write/Preview toggle (preview via `<Markdown>`), character count, optional `localStorage` draft autosave + recovery; `compact` trims the toolbar for small surfaces (board cards). Backs the structured system-prompt editor (`agents/StructuredPromptEditor`) |
| `<DataTable>` (`src/ui/DataTable.tsx`) | the ONE tabular-data primitive for the operate surfaces (Runs, Memory, Orgs, …) | generic `columns` config + `rows` + `rowKey`; sticky `--paper-2` mono header, click-to-sort columns (opt-in per column via `sortValue`, `aria-sort` + clay caret), `comfortable`/`compact` density axis, optional `onRowClick` (renders rows as `.data-row--clickable`), built-in `empty` slot, and opt-in **bulk-select** (`selectable` + a **controlled** `selected: Set<string>` + `onSelectionChange`): a leading checkbox column with select-all (indeterminate), `.is-selected` row tint, and a `.data-bulkbar` action bar (via `bulkActions(selectedRows)`) above the table when ≥1 selected. Styling under `.data-table` (`global.css`); token-only. A surface MUST NOT hand-roll a second sortable table — adopted on Runs (sortable) + Memory (bulk-delete) |
| `<DensityToggle>` (`src/ui/DataTable.tsx`) | comfortable/compact segmented control | pairs with `<DataTable density>`; reuses `.segmented`. Persist the choice per-surface in `localStorage` |
| `<ViewToggle>` + `useViewMode` (`src/ui/ViewToggle.tsx`) | the ONE grid/list switch for collection pages (§4.5 rule 11) | a `.segmented` control (sibling of `<DensityToggle>`) with two `aria-pressed` buttons — Grid (`BoxesIcon`) / List (`ListIcon`); optional `labels` override (e.g. `/agents` calls Grid "Tiles"). `useViewMode('<surface>', fallback)` persists the choice per-surface in `localStorage` (`openwop:view:<surface>`). Extracted from the former hand-rolled `/agents` toggle. A surface MUST NOT reimplement a second grid/list switch — render this, and conditionally render a `.card-grid` of Cards vs a `.surface-card.list-view` of Rows |
| `<CommandPalette>` (`src/ui/CommandPalette.tsx`) | app-wide ⌘K / Ctrl+K jump-to-anything | mounted once at the app shell; manages its own open state + global hotkey, and also opens on a `window` `openwop:cmdk` event (the rail's `.app-cmdk-trigger` "Search" button dispatches it). Substring-filters across every nav destination + a few quick actions (drawn from `NAV`, derived from the feature manifest `chrome/features.tsx`), full keyboard control (↑↓ + Enter, Esc), clay-tinted active row. Token-only `.cmdk-*` styling. The manifest is the single source of truth for routes + nav, so the palette, rail, and router never drift |
| `<ModalPortal>` (`src/ui/ModalPortal.tsx`) | EVERY full-page scrim (modals, drawers) | renders at `document.body` — `.page-enter`'s filled transform animation makes page sections CONTAINING BLOCKS for `position: fixed`, so an inline scrim centers on the content column instead of the viewport (the create-board bug, 2026-06-05). Scrims carry `backdrop-filter: blur(6px)` per the design reference |
| `<IconButton>` (`src/ui/IconButton.tsx`) | icon-only buttons | the REQUIRED `label` prop becomes `aria-label` + default `title` — the type system makes an unlabeled icon button unrepresentable (white-label PRD §9). Default `.icon-button` chrome (borderless 28px hit target); pass `className` to ride an existing chrome (`.admin-rail-toggle`, `.app-sidebar-collapse`) |
| `<IllustrativeBadge>` (`src/ui/IllustrativeBadge.tsx`) | demo honesty | pin on any panel showing SAMPLE (not store-derived) data so a demo never masquerades fabricated numbers as real. The stock app ships zero (all surfaces derive from live stores); white-label forks add them wherever they stage sample content. Disabled-with-reason is the sibling convention: a dead control is `disabled` + `title="why"`, never a silent no-op click |
| `toast` + `<Toaster>` (`src/ui/toast.tsx`, view lazy-loaded from `ToasterView.tsx`) | ephemeral async-feedback layer | imperative `toast.success/error/info/warning(msg)` from anywhere; `<Toaster>` is mounted once at the app shell as a labelled landmark and stacks bottom-right. success/info/warning auto-dismiss, and **every clock pauses while the pointer is over the stack or focus is in it**, resuming with the time left; an **error persists until dismissed** (it may carry an instruction — WCAG 2.2.1). Every variant is spoken through the shell's primed live region (errors assertive), and the toast node carries no live role (PROF-UX-20 / DS-8); the close control is a 24px target. Reuses the `.alert.*` colour families with `.toast` layout overrides; leads with a Lucide icon (never an emoji). **Distinct from `<Notice>`** — `<Notice>` is inline/persistent/in-flow; toasts are transient and never block |
| `<Skeleton>` + `<SkeletonRows>` (`src/ui/Skeleton.tsx`) | content-shaped loading placeholders | a faint shimmering block in `--rule` tones (shimmer honours `prefers-reduced-motion`); `<SkeletonRows count columns>` fills a `<DataTable>`'s loading state. Replaces bare "Loading…" text on list/detail loads — first adopted on the Runs table |
| `<ThemeToggle>` (`src/ui/ThemeToggle.tsx`) | per-user light/dark/system theme override (§3) | three-way segmented (System/Light/Dark, Lucide `Monitor`/`Sun`/`Moon`), persisted to `localStorage`; toggles `<html class="theme-dark\|theme-light">` (the warm-dark token override keys off it + `@media`). An inline script in `index.html` applies the saved class before first paint (no flash). Lives in the sidebar foot |
| rail geometry (`src/canvas/useRailLayout.ts` + `RailSeparator.tsx`, `.cv-rail-*`) | §7.2 / CV-14+CV-16 — the canvas editor's resizable, independently-collapsible rails | widths ride `--cv-rail-l`/`--cv-rail-r` custom props on `.cv-editor__cols` (dynamic-inline path §10); persisted per canvas type (`owp.cv.rails:<typeId>`). `RailSeparator` is a focusable `role="separator"` window-splitter (pointer drag + ←/→ 16px steps + Home/End, `aria-valuenow`), rendered on the grid (absolute, in the column gap — inside the `overflow:auto` asides it would scroll away). Collapse = a slim strip keeping only the labeled chevron toggle (`.cv-rail-toggle`; content `display:none` — out of the AT/tab order); `[`/`]` registry shortcuts toggle with live-region announcements; both collapsed = focus mode. Desktop-only (≤760px stacks; separators/toggles hidden) |
| `<CanvasSurfaceShell>` (`src/canvas/CanvasSurfaceShell.tsx`) | ADR 0361 Phase 1 — the ONE shell-chrome composition for ENGINE-BACKED editors (a center that owns its own model/undo/persistence, so none of `CanvasEditorPage`'s document lifecycle applies) | the chassis owns the CHROME — rails (collapse/resize/persist via `useRailLayout` + `RailSeparator`, `[`/`]`), the declarative shortcut registry + window-keydown owner, the `?` cheatsheet, ⌘K command projection, the a11y live region, and the §7.3 zoom-handle slot — while the consumer supplies CONTENT only (bar, rail bodies, center, tail) plus its type verbs (`typeShortcuts`) and pre-translated labels. The `storageKey` names BOTH the rail-persistence key and the ⌘K source and MUST stay stable across restructurings. Consumer: the workflow builder (`BuilderShell`, slimmed to content + business logic). **ADR 0365:** the chrome BEHAVIOR blocks live in `canvas/useSurfaceChrome.ts` (dual-channel announcer, registry keydown owner + `?` state, ⌘K projection under a FROZEN source key, zoom-handle slot) and `canvas/RailAside.tsx`, consumed by BOTH this shell and `CanvasEditorPage` — the two compositions are an accepted split (engine vs doc lifecycle); new chrome behavior goes in the blocks, never inline. An engine-backed editor MUST NOT re-compose this chrome by hand |
| `<ZoomCluster>` (`src/canvas/ZoomCluster.tsx`, reuses `.cv-viewport__chrome`) | the ONE §7.3 zoom cluster — `− · %▾ · +` floating bottom-right of every spatial surface (CV-3) | the `%` readout is a `ui/Menu` trigger (APG menu-button contract) carrying 50/100/200%, Zoom to fit ⇧1, Zoom to selection ⇧2 (when the consumer supplies it, dimmed without a selection), 100% ⇧0; localized dynamic `aria-label` carries the current percent. Pure chrome: math lives in `useCanvasViewport` (`zoomToPercent`), fit semantics stay consumer-owned (`onFit`), and it registers NO window listeners — the ⇧-keys live in the chassis shortcut registry, dispatched through `ViewportHandleContext` (`canvas/viewportHandle.tsx`) to whichever surface owns the center viewport. Consumers: `ViewportSurface`, `GraphSurface`; the builder's xyflow `<Controls>` converges in Phase 3 (CV-1). A surface MUST NOT hand-roll a second zoom chrome |
| graph / screen-flow surface (`src/canvas/graph/{GraphSurface,EdgeLayer,edgeRouting}.tsx`, `.cv-graph__*`) | the on-canvas node-graph editor for the `graph` trait (ADR 0323) | an OPTIONAL `graph` trait a type supplies to `<CanvasEditorPage>` — a toolbar toggle (Graph ⇄ Edit) swaps the per-frame preview for a pan/zoom surface of positioned **nodes** connected by SVG **connectors**. Nodes are device-framed screen bodies (the type's `renderNode`); drag to move (pointer + arrow-key nudge, one undo step each), double-click / Enter to open the node's editor. Connectors: pointer drag from an edge handle, OR the aria-labeled **Connect** button (arm source → pick target — the WCAG 2.5.7 keyboard/pointer alternative); a selected edge deletes with Delete. Four routing styles (bezier/orthogonal/straight/step) are pure, unit-tested geometry (`edgeRouting`); every mutation flows through the chassis `useHistoryState` (the trait only projects the doc into nodes/edges + applies mutations to a clone). Selection outline = `--clay-text` ring; edges = `--rule` (selected/animated = accent + dash, never colour alone); nodes are `role=button` (roving tabindex, global focus ring); the surface is a labeled `role=group`. Consumer: app-builder (a node is a screen, ADR 0323 Phase 2). **ADR 0337 P2b — board chrome (zoom bar superseded Phase 1/CV-3):** the shared `<ZoomCluster>` (bottom-right; fit stays graph-owned at the ≤1:1 clamp), a bottom-left **device-frame selector** (`.cv-graph__device-select` — a native labeled `<select>`; the trait's `deviceFrames` override `nodeSize` at render time only, ephemeral, refitting on change), and a decorative `aria-hidden` **ruler** (`.cv-graph__ruler` — top/left tick rails outside the transform, positions from pan/zoom via the pure `rulerTicks`). **ADR 0337 P2c — shared viewport:** pan/zoom is the ADR 0333 `useCanvasViewport` (ONE owner; DRAW-1 closed) — plain-wheel pan / Ctrl-wheel focal zoom, Space+drag & middle-drag & plain-left-drag (`backgroundPan`) pan, two-pointer pinch, edge-scroll while dragging a node, and arrow-key pan on the focused surface; `is-panning`/`is-pan-ready` cursor states. A type MUST NOT fork a second node-graph — a Fit-to-view control frames all nodes (auto-fits once on open so an AI-generated layout is visible), and an empty state shows when there are no nodes. The workflow builder is the recorded future consumer |
| `useHistoryState<T>` (`src/ui/useHistoryState.ts`) | the ONE bounded undo/redo primitive (ADR 0305 Phase B) | generic past/future snapshot stacks (depth 30, one entry per user gesture, `replace()` for text inputs whose keystrokes must not bury structural ops); stacks mutate outside React updaters (StrictMode-safe). First consumer: the canvas framework's `<CanvasEditorPage>` (ADR 0310); the workflow builder's `builderStore` history is the recorded migration follow-up. A surface MUST NOT hand-roll a second undo stack |
| `<LanguageSwitcher>` (`src/i18n/LanguageSwitcher.tsx`) | per-user UI-locale picker (ADR 0065) | Lucide `Globe` + a token-styled `<select>` listing each declared locale by its own endonym (`Intl.DisplayNames`), plus preview locales (e.g. a pt-BR draft) in dev / `?preview=1`. `setLocale()` persists to `localStorage` and re-localizes formatters + flips `<html lang\|dir>` (RTL). Renders nothing at a single declared locale (so English-only ships it invisibly). Controls the INTERFACE language; content language is negotiated server-side (ADR 0064). Lives in the sidebar foot beside `<ThemeToggle>`; `<select>` inherits the global `:focus-visible` ring |
| `.fp-blog` family (`.fp-blog__list` / `.fp-blog-card` / `.fp-tag`) + `<BlogPage>` / `<BlogPostPage>` (`src/features/site/`) | the public blog discovery surface (ADR 0391): index + tag/category/author archives + post view with byline/date/chips | rides the `fp-*` public register (NOT app chrome) on shared tokens; designed empty/error states; RSS `<link rel="alternate">` on the index; post body renders through the ONE `RenderSections mode="public"` |
| `.fp-fields` family + the `fields` section branch (`src/features/cms/SectionRenderer.tsx`) + `FieldsEditor` (`src/features/cms/SectionsEditor.tsx`) | ADR 0748 — a section authored through the RFC 0103 content API: flat named text fields | public: a ruled `<dl>` ledger (mono `--ink-3` label, prose `--ink` value), stacks at ≤599px, every key and value rendered as text, no `SectionHead`; editor: name + value rows with inline `.field-error` (`aria-invalid`/`aria-describedby`), on a locale overlay the base names are read-only and the base value is the placeholder (empty = inherit); not offered in the add-section picker (API-created, like `comparison`) |
| `.fp-pricing` / `.fp-tier` family + the `pricing` section branch (`src/features/cms/SectionRenderer.tsx`) + `<PricingPage>` (`src/features/site/PricingPage.tsx`) | the public pricing surface (ADR 0391): tier grid rendered from the live `/public/pricing` billing read | honest-when-unpriced (feature/limit list + neutral CTA, never a fabricated dollar figure); `display.highlighted` tier gets the clay accent; token-only |
| `<ShowsManager>` (`src/features/podcasts/ShowsManager.tsx`) + `<PublicPodcastPage>` (`src/features/podcasts/PublicPodcastPage.tsx`) | podcast distribution (ADR 0390): studio shows-&-distribution panel (create/publish show, copy feed URL, Apple/Spotify guidance) + the public show/episode pages | studio panel = `.surface-card` + `.action-bar` + `<Notice>` register; public pages ride the `fp-*` register on the bare PublicShell |

Global focus ring: `button`, `button.secondary`, `select`, `input`, `textarea`, `[role=button]`, and `.surface-card` all receive `outline: 2px solid var(--clay-text); outline-offset: 2px` on `:focus-visible` (one block in `global.css`). New interactive elements inherit it.

Half-step spacing tokens: `--space-1-5: 6px` and `--space-2-5: 10px` cover the genuine micro-gaps authors reach for; **all** spacing still comes from the `--space-*` set — never inline a raw rem.

### 5.2 Iconography — the app-wide Lucide icon set (`src/ui/icons`)

- **One icon vocabulary.** Every UI icon is an inline-SVG component adapted from Lucide (Apache-2.0) under `src/ui/icons/`, re-exported from `src/ui/icons/index.ts`. Props: `{ size?: number; strokeWidth?: number; style?: CSSProperties }` (`CircleIcon` adds `filled?`). Icons render `stroke="currentColor"`, so they inherit the surrounding text color — place them in a span with the desired color, or where the color already applies.
- **Icon + label vertical alignment.** An inline SVG sits on the text *baseline* by default, so a raw `<Icon/> {label}` renders the icon a few px low. Icon+label controls MUST therefore be **flex containers** — `display: inline-flex; align-items: center; gap: var(--space-1-5)`. The shared `button` (all variants, since they cascade from the base rule), `.chip`, `.action-bar`, `.btn-accent`/`.btn-accent-solid`, and `.icon-button` already are, so a button rendered `<button><PlusIcon/> {label}</button>` centers automatically (the stray JSX whitespace collapses as a whitespace-only flex item; `gap` supplies the spacing — do NOT also add a literal space). For an icon in an **inline, non-flex** context (a `.status-badge`, `.linklike`, `<label>`, table cell), the global `:is(.status-badge, .linklike, label, .badge, .pill, td, th) > svg { vertical-align: middle }` rule corrects the baseline. Never hand-roll per-button alignment with `position`/`margin` nudges.
- **No emoji as UI icons — anywhere.** An emoji rendered as a decorative/affordance glyph is a bug; use a component from `ui/icons`. Add a new icon by copying an existing `<Name>Icon.tsx`, pasting the Lucide path, and re-exporting from `index.ts`. **Exempt** (these are not icons): prose mentions of a symbol (e.g. "drop a card into a ⚡ trigger lane" describing the column's `ZapIcon`), keyboard-shortcut hints (`⌘`, `⌗`), ASCII-art diagrams, and bullets (`•`).
- **Canonical mappings** (the vocabulary): status `✓`/`✕`/`⏸`/`●`/`○` → `Check`/`X`/`Pause`/`Circle`(`filled` for ●); disclosure `▸`/`▾` → `ChevronRight`/`ChevronDown`; collapse-direction `‹`/`›` → `ChevronLeft`/`ChevronRight`; back-links `←` → `ArrowLeft`; reorder `↑`/`↓` → `ArrowUp`/`ArrowDown`; feedback `👍`/`👎`/`🚩` → `ThumbsUp`/`ThumbsDown`/`Flag`; `🔧`/`🛠` → `Wrench`; `🔒` → `Lock`; `✎` → `Pencil`; `🗑` → `Trash`; `⚙` → `Settings`; `ⓘ` → `Info`; `📎` → `Paperclip`; `📋` → `Clipboard`; `💾` → `Save`; `⚖` → `Scale`; `💭` → `MessageSquare`; `☰` → `Menu`; `↻` → `RotateCw`; `↶`/`↷` → `Undo`/`Redo`; `⚡` → `Zap`; `▶` → `Play`; the workflow glyph → `Workflow`; `🧠` → `Sparkles`.
- **Formatting toolbar vocabulary** (the `MarkdownEditor` toolbar, §5.1): `Bold` / `Italic` / `Heading` / `Link` / `List` / `ListOrdered` / `CheckSquare` / `Quote` / `Code` / `CodeBlock` — all Lucide, re-exported from `index.ts` like the rest. The blocker note on a board card uses `Alert` (never a `⚠` glyph).
- **Brand / vendor marks are exempt and never re-colored** — the OpenWOP robot, the Google `g`, the GitHub octocat (see §8).

### 5.3 Status → chip semantics

Run / agent / node status is rendered as a chip (color **and** label — never color alone, §11), mapped centrally rather than per-component:

- Agent + run status → a `.chip--*` via `agents/agentViewModel.ts` `statusMeta`: active ("Ready") → `chip--success`, working/running → `chip--accent`, waiting ("Waiting on Human") → `chip--warning chip--pulse` (the one action-required state that breathes, §6 `openwop-attention`), paused → `chip--muted`, needs-setup/failed/cancelled → `chip--danger`.
- Node-canvas run status uses the §3 functional tokens on `.builder-node*` badges paired with a Lucide glyph (`CircleIcon filled` / `Check` / `X` / `Pause`), color via `var(--color-warning/success/danger/ai)`.
- The canvas node-badge FAMILY owns one corner each (never stacked): run status top-right (`.basenode-run-badge`), capability warning top-left (`.builder-node-warn-badge`), debug pin bottom-right (`.builder-node-pin-badge`, ADR 0475 — `--color-info` fill + `--color-on-scrim` glyph), failure-heatmap count bottom-left (`.builder-node-heat-badge`, ADR 0476 — TEXT badge, so the status-badge register applies: `--paper` fill + `--color-danger-text` + `--danger-rule` border, never a danger fill behind small text). The cost variant (`.builder-node-heat-badge--cost`, ADR 0482) shares that bottom-left corner (the two heat modes are mutually exclusive) but wears the NEUTRAL register — `--paper` fill, `--color-text-muted` text, `--rule-2` border — because cost is a data dimension the author asked to see, not a fault: it must never borrow the warning/danger tones or it reads as "this node is broken" when it merely spent money.
- **Severity reuses the same functional tokens.** A task's priority is a severity signal, not a run state, but it lives on the same axis: a `High`-priority card uses `chip--danger` (always with the visible "High" label, §11).
- **Feature maturity reuses `--color-warning`.** A nav item for a feature in **beta** wears a warning-toned `.nav-badge--beta` (§5.1) — "beta = experimental, proceed with caution" is a warning-adjacent signal, not an arbitrary category. Always with the visible "Beta" label (§11).

Severity and feature-maturity are the **two** sanctioned reuses of a functional token outside run state — both because they sit on the same caution/severity axis. Do **not** extend functional tokens to arbitrary dimensions (role, source, owner), which differentiate by glyph/label instead (§5.2, §5.4). Do not invent a per-surface status palette; reuse these mappings so a "completed" state looks identical everywhere.

**Canonical autonomy vocabulary.** The host-ext `autonomyLevel` enum (`review` / `guided` / `auto`) reads the SAME to the operator wherever it appears — an agent meter (`agents/AutonomyMeter.tsx`) or a workforce (`workforces/labels.ts`): **Supervised / Guided / Autonomous** (a graduated-independence scale, never the raw wire token). Never leak `review` / `auto`. i18n is namespaced per feature (each catalog carries its own localized copy of these three words — no cross-feature import, ADR 0001), so the words must be kept in lockstep across `agents/i18n/*` and `workforces/i18n/*`; the one-line *gloss* stays context-specific (an agent's is heartbeat-framed, a workforce's is policy-framed). This is distinct from the workforce **journey** labels (Watching → Assisting → Running on its own), which describe the separate `status` axis (§5.1 `.wf-track`).

### 5.4 Role glyphs — differentiate by icon, never by color

A roster of named coworkers must read at a glance, but role is **not** a run-state, so it does not earn a functional/accent color (§3 reserves those for status). Differentiation is therefore by **Lucide glyph only**, mapped centrally in `agents/roleTemplates.ts` (`roleThemeForKey` / `roleThemeForAgent`): `sales-ops → Briefcase`, `support-triage → LifeBuoy`, `finance-ops → Scale`, `engineering-ops → Wrench`, `marketing-ops → Megaphone`, custom/unknown → `Bot`. The glyph rides as a small bordered badge on the otherwise-uniform clay avatar (dashboard card + workspace header) and inline on the create-agent role picker. The role key is derived from the seeded `host:demo-<key>` agentRef, else inferred from the workflow portfolio. Do not give a role its own accent color or avatar tint.

### 5.5 Page architecture & atmosphere

The chrome that makes every page feel like one publication:

- **Every top-level nav page leads with `<PageHeader>`** (§5.1) — `eyebrow` (mono kicker) → **sans 700 `title`** → sans `lede` → `actions`. Do not open a page with a bare `<h1>`/`<h2>`. The sans title is the page's `<h1>`; section headings inside the page are `<h2>` (never skip a level — see §11). Pages on this standard (20): Agents, Agent templates, Workflows, Runs, Run-compare, Mission Control, Inbox, Boards, My Work, Roster, Prompts, Keys, Memory, Capabilities, Organizations, Demo data, CLI, Executive Assistant, Connections, Comments.
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
| `openwop-chanempty-rise` | beginning-of-channel empty state (ADR 0192) — tile + title arrival | opacity + 4px `translateY`, one-shot, single 60ms stagger; explicit reduced-motion guard in addition to the universal rule |
| `openwop-attention` | action-required chip ("Waiting on Human") | gentle opacity dip (1 → 0.6 → 1) that keeps the label legible; reserved for human-action states, never decorative (`.chip--pulse`) |
| `openwop-bubble-breathe` | live workflow-run chat bubble | faint `--clay-wash` inset-shadow tint while streaming; respects bubble radius; never touches the background fill |
| `openwop-spinner-rotate` | per-step "running" arc in the workflow-progress panel (`chat/workflowProgress/StepList.tsx`) | a 1.5px ring with one coloured top edge replacing the `○` glyph; inherits colour from the surrounding chip; frozen (not hidden) under reduced-motion so the affordance survives |
| `openwop-think-dot` | the shared cadenced "thinking / working" heartbeat — pre-token `<ThinkingIndicator>`, the in-flight `ThoughtsDisclosure` dots, and a running tool-call (`chat/AgentEventCards.tsx`) | three dots, opacity + ≤ 2px `translateY`; **tempo is data-cadenced** via `--think-dur` set by `useStreamCadence` from the real token/event arrival rate. Range **0.52s–1.6s** — a deliberately faster band than `openwop-pulse` because the rate *carries meaning* (fast = output pouring in, calm = deliberating); honors `prefers-reduced-motion` (dots hold static at 0.5 opacity) |
| `openwop-caret-pulse` | the streaming "ledger caret" at the end of a streaming assistant bubble (`chat/MessageBubble.tsx`) | a thin 2px mark; opacity only; tempo via `--msg-caret-dur` (same `useStreamCadence` cadence as `openwop-think-dot`) — breathes rather than hard-blinks |
| `openwop-toast-in` | a toast entering the bottom-right stack (`<Toaster>`) | one-shot opacity + ≤ 8px `translateY`; 0.18s; the toast itself does not loop |
| `openwop-shimmer` | `<Skeleton>` loading sweep | a `--paper` highlight sweeping across the `--rule` block; the `::after` overlay is `display:none` under reduced-motion (the static block remains) |

Rules:

1. **All animations MUST honor `prefers-reduced-motion: reduce`.** The universal rule in `global.css` (`*, *::before, *::after`) zeroes durations + iteration counts, so every keyframe above is covered for free.
2. No animation drives a state change (e.g., do not animate a card *into* the success state — set the state, animate the badge once and stop). The `*-stamp-in` / `*-fade-rise` one-shots fire *after* the state is set.
3. New keyframes are app-only.

---

## 7. Canvas editors — the drafting-table standard

The app has full-screen **canvas editors**: the shared chassis (`src/canvas/`,
ADR 0310 — `CanvasEditorPage` + trait-driven `CanvasTypeDefinition`) behind
slides, drawings, CAD, campaign, app-builder, document, and pack canvas types;
and the **workflow builder** (`src/builder/`, xyflow), a sibling stack with the
same job. This section is the ONE design standard for all of them — the canvas
space, both rails, the top bar, the bottom edge, selection, zoom, modes, and
each type's payload. Research base: five-app deep dive (Figma UI3, Canva,
Google editors, VS Code, node-graph editors) in
[`docs/research/canvas-chrome-best-in-class.md`](docs/research/canvas-chrome-best-in-class.md).

**Register.** Every canvas is a **sheet on the same drafting table**: the sheet
(`--paper`) sits on a `--paper-2` pasteboard carrying the letterpress dot-grid
(`--rule-2` — the §5.5 motif), chrome speaks the editorial voice (sans heads,
mono metadata, clay accents), and live work is dramatised only where §6 allows
(the clay marching-dash "data in flight" edge is the canvas signature). A
canvas that reads as a cool-gray SaaS whiteboard is off-brand; a canvas that
reads as a toy — flat, chromeless, zoomless — is a defect this section exists
to eliminate.

### 7.1 The canvas canon

Rules that govern EVERY canvas editor. Violations are defects, not style choices.

1. **One workbench, typed payloads.** All canvas types share ONE fixed shell —
   command bar, optional workspace strip, left rail, sheet, right inspector,
   status edge, and optional type drawer — whose *zones never move* and whose
   *contents* are supplied by the type definition (the Canva / Figma one-engine
   thesis; already the ADR 0310 trait contract — this canon makes the chrome
   contract exactly as fixed as the trait contract). A canvas feature never
   invents another zone or relocates one. The workspace strip is navigation
   between a document's persistent workspaces, never a selection-editing mode;
   when absent, the remaining geometry closes without a gap.
2. **The sheet is sacred.** The center canvas is always the largest region and
   is never occluded by docked chrome. What may float over it: the **zoom
   cluster** (bottom-right), the **minimap** (bottom-left), the
   **near-selection toolbar** (attached above the selection), plus
   edge-docked **board instruments a type declares** (the ADR 0337 device
   selector/ruler, a transient `role=status` connect bar, the present HUD).
   Nothing floats mid-sheet, and no *panel* ever floats (canon 3).
3. **Docked rails, never floating panels.** Both rails are fixed-position,
   resizable (drag inner edge), and **independently collapsible**. Figma
   shipped floating panels in the UI3 beta and reverted before GA — they
   cramped the canvas and *slowed sustained work*. We copy the shipped hybrid,
   not the beta. Rails push the sheet; they do not cover it.
4. **Chrome morphs by selection, never by mode.** There are no "text mode /
   image mode" editors. The top bar's contextual cluster and the right
   inspector rewrite themselves from the current selection (element → its
   props; edge → edge props; nothing → document props). One selection model,
   no modal editing states.
5. **Structure lives left, properties live right.** The left rail owns document
   structure + insertion (filmstrip, screens, outline, palette); the right
   inspector owns the exhaustive typed property set. Never swap these; never
   duplicate one into the other.
6. **Every action is a command.** Toolbar buttons, menus, shortcuts, and the
   palette are thin front-ends over the ONE declarative shortcut/command
   registry (`canvas/shortcuts.ts`). A canvas action reachable only by mouse,
   or only by keyboard, is incomplete.
7. **One viewport grammar** (ADR 0333, `useCanvasViewport`): plain-wheel pan,
   Ctrl/⌘-wheel focal zoom, Space/middle-drag pan, pinch, arrow-key pan,
   edge-scroll during drag. Every spatial surface uses the shared hook — a
   hand-rolled pan/zoom state machine is the DRAW-1 defect class.
8. **Guides are a two-color language.** Alignment snap = `--guide-align`;
   equal-spacing/distribution = `--guide-space` (§7.4). Same two hues on every
   surface; a modifier always suspends snapping.
9. **Run state renders on the canvas.** When a canvas participates in a live
   run, state paints where the work is: per-node status badges + the §6
   marching-dash edge. Payload detail goes to a bottom drawer, never onto the
   sheet (counts on nodes, payloads in the drawer — the n8n/Retool consensus).
10. **Present strips everything.** Present/preview modes remove ALL editing
    chrome; a minimal auto-revealing control bar (bottom-left, on pointer
    move) is the only survivor. Presenter-only data (notes, next frame, timer)
    renders in the presenter window/phone remote, structurally never in the
    audience path (the ADR 0328 posture).
11. **Never a blank sheet.** A new canvas opens seeded (template gallery
    search-first, or a demo seed — the ADR 0337 Aurora precedent) or onto a
    designed empty state with one primary create action. An empty white
    rectangle with no affordance is a defect.
12. **Keyboard-complete or it doesn't ship.** Every pointer gesture has a
    keyboard path (move/nudge, connect, reorder, zoom, mode exit). The
    `GraphSurface` keyboard-connect button is the floor, not the ceiling
    (§7.8).

### 7.2 Zone anatomy

| Zone | Class | Geometry | Owns |
|---|---|---|---|
| Top bar | `.cv-editor__bar` | one row, ~2.75rem, never wraps | identity · doc state · contextual cluster · view + primary actions |
| Workspace strip | `.cv-editor__workspace` | optional one row below the command bar, horizontally scrollable on narrow screens | persistent document workspaces only (Graph · Data · Logic · Contract), never one-shot commands |
| Left rail | `.cv-editor__palette` | 240–280px, resizable, collapsible to icon strip | structure nav + insertion palette |
| Sheet | `.cv-editor__center` | flex-1, the sacred region | the document + frame strip + floating chrome |
| Right inspector | `.cv-editor__props` | 280–320px, resizable, collapsible | selection-driven properties |
| Status edge | `.cv-workbench__status` | persistent, low-noise footer | truthful current context + universal shortcut hints; never a live region or a state store |
| Bottom drawer | type drawers | optional resizable splitter above the status edge | type payload only (notes, run/debug) |

**7.2.1 Top bar.** One `.cv-editor__bar` vocabulary for ALL canvas editors —
including the workflow builder (§7.10; `.builder-toolbar` converges on this
grammar). Left→right: back link · inline-editable name (`.cv-editor__name`) ·
doc state (`.cv-editor__status`: version + "Unsaved" chip, mono `--ink-3`) ·
spacer · **contextual cluster** (morphs per selection — the Slides/Canva
lesson) · view cluster (undo/redo, tool modes, graph/tree toggle, preview,
history, share) · **one primary CTA** (Save, or Run for the builder —
clay-solid per §2's button hierarchy) · `ToolbarExtras` slot · overflow `⋮` ·
Delete isolated at the far end behind `.cv-editor__delete-sep`. On narrow
widths trailing clusters collapse into the `⋮` overflow — the bar NEVER wraps
to a second row and never horizontal-scrolls visibly.

**7.2.2 Left rail.** Structure first, insertion second: frames/screens/outline
list at top (select, inline-rename, drag-reorder, per-row `ui/Menu`), palette
below (search-first, category groups, favorites + recents). Collapsible to a
labeled icon strip; collapsed state persists per surface (`localStorage`, the
§4.5 rule-11 pattern). **Client-pref key style (CVD-1 ruling):** new canvas
preference keys use `owp.cv.<area>:<qualifier>` (`owp.cv.rails:<typeId>`,
`owp.cv.notes:<typeId>`); legacy dash-style keys (`owp-frames-clip:*`) are
grandfathered — never migrate ephemeral prefs. The rail lists what the current view is made of — a
graph view lists screens/nodes, not components (the ADR 0337 Screens-rail
correction).

**7.2.3 The sheet & pasteboard.** Bounded documents (slides, screens, pages,
drawings with a set size) render the sheet as `--paper` on a `--paper-2`
pasteboard that carries the dot-grid; the pasteboard is a real workspace
(parked objects allowed where the type supports it). Unbounded surfaces
(graphs, whiteboard-class canvases) ARE the pasteboard: dot-grid `--rule-2`
directly, **never** a cool-gray vendor grid. The frame strip
(`.cv-editor__screens` tablist) sits at the top of the zone for frames types.

**7.2.4 Right inspector.** Entirely selection-driven (canon 4): section order
is identity (what's selected, as a mono eyebrow) → geometry/arrange (X/Y/W/H,
align, z-order, lock/hide) → type-specific props (`PropertyForm` + widget
registry) → doc-level props when nothing is selected (`docPropDefs`).
Progressive disclosure: sections collapsed until relevant; "+" affordances add
list-valued props. Property edits echo on-canvas immediately; hovering a
geometry field MAY highlight the affected element (Figma's light-outline
pattern) but must not reflow the sheet.

**7.2.5 Status edge, bottom drawer & floating chrome.** Every workbench has a
small, non-live status edge. It reports only already-visible context (current
workspace, saved version, selection summary) and universal shortcut
discoverability; it never becomes a second toolbar, a source of state, or a
substitute for the chassis live regions. The optional bottom drawer belongs to
**type payload** — the slides speaker-notes drawer, the builder's run/inspect
drawer — with a draggable splitter and a collapsed-by-default state. View state
floats on the sheet instead: the **zoom cluster** bottom-right (`− · % · +`,
§ 7.3), the **minimap** bottom-left. Status semantics follow the VS Code rule:
document state lives left (top bar's identity/status region), view state lives
right / bottom-right, and every actionable status item is click-to-act.

### 7.3 Viewport, zoom & navigation

- **The zoom cluster** (bottom-right, floating, `--paper` on `--rule` border,
  `--ink-shadow`): zoom-out · a mono `%` readout · zoom-in. Clicking the `%`
  opens the zoom menu: 50 / 100 / 200%, **Zoom to fit** (`⇧1`), **Zoom to
  selection** (`⇧2`), **100%** (`⇧0`), and a custom % field. Every spatial
  surface — drawings, CAD, graph boards, the builder, AND paged sheets
  (slides) — shows it. An editor with no zoom affordance reads as a toy.
- Interaction clamp stays per-surface (`[0.25, 2.5]` today); the menu's presets
  clamp to it. Fit runs once on open (never re-fits behind the user's back).
- **Minimap** (bottom-left, toggleable): REQUIRED on unbounded surfaces once
  content exceeds ~1.5 viewports (graph boards, the builder, large
  drawings/CAD scenes); themed to the palette (`--paper-2` ground, `--ink-2`
  marks, `--rule` border — the §7.11 minimap tokens). Never load-bearing
  (canon 6: everything it does has another path).
- **Rulers + device frames**: graph boards and device-preview surfaces may show
  a ruler and a device-frame selector (ADR 0337); ONE device abstraction
  serves both the board and the preview page (ledger CV-11).
- **Auto-layout ("tidy")**: graph surfaces offer a tidy action (dagre/elk
  class) that re-flows the graph and then re-fits — always as an explicit
  button, never automatic.

### 7.4 Selection, snapping & direct manipulation

- **One handle grammar** on every direct-manipulation surface: a 1.5px
  `--clay` selection outline; 8-point square handles (`--paper` fill, 1.5px
  `--clay` border); a detached circular **rotate handle above** the selection
  (Shift snaps to 15°); marquee select renders `--clay-wash` fill with a
  `--clay-rule` border. Graph ports stay the 12×12 clay disc with a 2px
  `--paper` ring (§7.11) — ports and handles must not be confusable.
- **Two-color guides** (canon 8), new tokens defined beside the §3 block:
  ```css
  --guide-align: var(--clay);            /* edge/center alignment lines */
  --guide-space: oklch(62% 0.11 195);    /* equal-spacing lines + badges — deliberately the --cat-integration teal (the §3 --cat-data/--color-success raw-duplication precedent); dark lifts to 70% */
  ```
  1px lines; spacing badges are mono 10px pills on `--paper`. Holding ⌘/Ctrl
  suspends snapping mid-drag (the Google/Canva escape hatch). Grid snap is
  default-ON for graph surfaces (20px) and guide-snap default-ON for object
  surfaces.
- **Gesture→history**: one drag = ONE undo entry (the chassis
  `patchElement(s)` start/move/end seam); text editing coalesces via
  `history.replace`. Undo depth per type (`historyDepth`; drawings 200).
- **Near-selection toolbar** (elements/tree surfaces): a floating pill above
  the selection with the spatially-local actions only — duplicate, lock,
  delete, group, comment when comments exist (the Canva/Miro/FigJam pattern).
  Formatting NEVER lives here; it morphs the top bar cluster (canon 4). Must
  reposition to stay on-viewport and yield to the selection (never occlude
  handles).
- **Graph insertion — link-drag-search**: on graph surfaces, dragging a
  connection into empty canvas opens the node/screen picker AT the drop point,
  **filtered to type-valid targets**, and auto-wires the chosen node (the
  Blueprints/Blender/n8n convergent gesture). The palette remains for
  browse-first insertion; the picker is the flow-state path.
- **Typed connections**: incompatible ports refuse visibly during the drag
  (target dims / no-drop cursor), valid targets highlight — already the
  builder's `isPortCompatible` behavior; the standard for every graph surface.

### 7.5 The command layer

- **One registry** (`canvas/shortcuts.ts` + `mergeShortcuts`): chassis defaults
  + type extras; text/IME/modal contexts never match. The builder converges on
  the same registry (ledger CV-2).
- **`?` shortcuts overlay** (exists) lists the merged set — grouped, localized,
  always current because it renders FROM the registry.
- **⌘K command palette** (chassis-level; the ADR 0328 P8 "Cmd+K" follow-up):
  searches the same registry — every command, its shortcut printed beside it
  (discovery for free, the VS Code rule). Type-supplied commands appear
  automatically.
- **Rail toggles**: `[` collapses/expands the left rail, `]` the right
  inspector; both together = **focus mode** (sheet + top bar only — the
  VS Code zen / Figma minimize-UI equivalent). Registry-routed, so text
  contexts are immune.

### 7.6 Modes: edit, preview, present

- **Edit** is the fixed workbench shell above (the workspace strip and type
  drawer are present only when the type declares them).
- **Preview** (`InteractiveViewer` / device presets) keeps the top bar,
  drops rails, and renders the interactive artifact honestly (real navigation,
  real transitions, `preview.transitionFor`).
- **Present** (`CanvasPresentPage`) strips ALL chrome (canon 10): audience
  path renders `renderFrame` only; auto-revealing control bar bottom-left
  (frame counter, prev/next, exit); presenter window carries notes + next +
  timer; the QR phone remote mirrors presenter data. Builds/transitions honor
  `prefers-reduced-motion` (instant swaps — §6 rule 1).

### 7.7 States

- **Empty**: canon 11 — seeded open (template gallery, search-first) or a
  designed `<StateCard>` with one primary create action. Empty FRAMES inside a
  non-empty doc get a quiet inline hint, not a StateCard.
- **Loading**: `.skeleton` shimmer blocks in the zones (rail rows, sheet
  rectangle) — never a blank shell, never a spinner-only page.
- **Conflict** (CAS 409): the chassis `Notice` with reload-latest — never
  silent overwrite, never a browser alert.
- **Offline/error saves**: the "Unsaved" chip escalates (warning tint +
  `openwop-attention` per §6); the Save CTA stays enabled and honest.

### 7.8 Canvas accessibility (extends §11)

- Roving tabindex on frame strips, element lists, outline trees, and graph
  nodes; arrow-key nudge (1px / 10px with Shift) on manipulable elements.
- **Keyboard connect** on EVERY graph surface — the `GraphSurface` Connect
  button pattern; the xyflow builder must reach parity (ledger CV-5).
- Two `sr-only` live regions (polite + assertive) announce selection, move,
  connect, delete, save, and mode changes — via the chassis announcer, never
  ad-hoc.
- Zoom controls are buttons with localized labels; zoom NEVER blocks
  browser-level zoom. All floating chrome remains reachable in focus mode.
- Canvas keyboard nav: `Esc` exits tool → selection → editor (one level per
  press); `Enter` descends into a group/frame, `⇧Enter` ascends (the Figma
  enter/exit model) where nesting exists.

### 7.9 Per-type payloads

The shell is fixed (canon 1); this table is each type's zone payload. Details
in each feature's ADR (0310/0317/0323/0328/0334/0337).

| Type | Surface family | Left rail | Sheet | Inspector focus | Bottom / floating | Modes |
|---|---|---|---|---|---|---|
| **Slides** | paged (frames+tree) | filmstrip w/ live thumbs, skip badge, sections | slide sheet on pasteboard; blocks slides get tree editing | layout/variant + block props; theme in docProps | speaker-notes drawer (CV-12); zoom cluster (CV-3) | present (full: builds, Magic Move, remote), preview |
| **Document** | linear rich-text (`EditorSurface`) | `FlowOutline` heading nav | TipTap page column, slash menu; track-changes + comment marks | typographic/doc props | — (surface scrolls) | read view |
| **Drawings** | freeform 2D (`InteractivePreview`) | element adders + list | direct-manipulation SVG, pen/highlighter/eraser tools | element props + arrange | zoom cluster + minimap at scale | — |
| **CAD** | freeform 2D | element adders + list | footprint move/rotate/resize | element props + units docProps | zoom cluster + minimap at scale | — |
| **Campaign** | elements (NO surface today) | 3 collection adders | read-only renderer — the toy-canvas defect (CV-9) | element + objective props | — | — |
| **App-builder** | graph-first + per-screen tree | Screens rail (graph) / component palette (tree) | `GraphSurface` board: device-framed screens, connectors, ruler | screen/component/edge props | zoom bar → cluster spec (CV-3); minimap (CV-4) | interactive preview, share |
| **Pack types** | elements (data-defined) | synthesized adders | generic data view / RFC 0130 plugin preview | schema-mirror props | — | — |
| **Workflow builder** | DAG (xyflow) | node palette (search, categories, packs) | dot-grid graph, typed ports, run overlay | node/edge/workflow inspector | minimap + Controls → cluster spec; run drawer | validate, live run |

Type-specific chrome beyond the table (a new panel, a new floating affordance)
needs a row here + a §5 component row before it ships.

### 7.10 The workflow builder — convergence contract

The builder is the canvas the rest of the app is being raised to — minimap,
snap, typed ports, live run overlay, pre-flight validation. Two rulings govern
its relationship to the chassis:

1. **No document-model merge** (reaffirming ADR 0310's rejection): the builder
   edits a DAG through xyflow; the chassis edits trait-shaped documents. A
   forced model merge would recreate MyndHyve's render-mode rot.
2. **Full CHROME merge** (new): the builder must be visually and behaviorally
   indistinguishable from a chassis editor — same §7.2 zone grammar and bar
   vocabulary, same zoom cluster/minimap placement, same command registry +
   `?` overlay + ⌘K, same focus mode, same undo primitive
   (`useHistoryState` — the recorded ADR 0310 follow-up), same a11y floor.
   What changed since ADR 0310's rejection: the chassis grew the
   **`EditorSurface` seam** (ADR 0334) — a surface that owns its own engine
   and undo while the shell stays chassis-owned; the document editor proved it
   with TipTap. Mounting `BuilderCanvas` as an `EditorSurface`-class consumer
   (workflow becomes a `CanvasTypeDefinition` whose surface is xyflow) is the
   recorded END STATE — **ADR 0361** rules the design (engine-owned
   persistence; collab reserved not faked). **Phase 1–2 landed:** the shell
   chrome composition the builder used to duplicate now has ONE owner —
   `canvas/CanvasSurfaceShell` (rails chrome + registry/keydown owner + `?`
   overlay + ⌘K projection + live region + zoom-handle slot), consumed by a
   `BuilderShell` slimmed to content + business logic. Per the ADR's Phase-1
   correction note, the composition lives in that dedicated chassis component
   rather than a `persistence: 'surface'` branch inside `CanvasEditorPage`
   (doc-optional threading through the canvas lifecycle was the riskier
   shape). The rail-persistence and ⌘K source keys stay `workflow-builder`.

### 7.11 xyflow (workflow canvas) theming

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

### 7.12 Convergence ledger

Where the code stands vs this section (2026-07-12 inventory —
`docs/research/canvas-chrome-best-in-class.md` §2). Each item is required
work; strike rows as they land (PR link in place of status).

| # | Gap | Surfaces | Canon |
|---|---|---|---|
| ~~CV-1~~ | **Landed (Phase 3)** — `BuilderToolbar` rides `.cv-editor__bar` (identity · history · view cluster w/ ≤920px `⋮` · AI · Run CTA; `.builder-toolbar`/`.tb-btn`/`.tb-group`/`.tb-icon-btn` deleted — `ui/Menu`'s `.tb-menu*` stays); `.builder-body` = the rails grid (`useRailLayout('workflow-builder')` + separators + collapse + `[`/`]` focus mode) | — | 1, 3 |
| ~~CV-2~~ | **Landed (Phases 2+3)** — chassis AND builder run the ONE registry (`mergeShortcuts`/`dispatchShortcut`/`inTextContext`), render `ShortcutsOverlay`, and project into the app ⌘K (`registerCommandSource`). The builder gained KEYBOARD undo (⌘Z — buttons-only before); its ad-hoc c/v/d listener became `nodeClipboard.ts` verbs | — | 6 |
| ~~CV-3~~ | **Landed (Phase 1)** — shared `ZoomCluster` (`canvas/ZoomCluster.tsx`): preset menu + ⇧1/⇧2/⇧0 via the registry + `ViewportHandleContext`; slides/campaign/pack Renderer path wrapped in `ViewportSurface`; `GraphSurface` bar replaced. *Residue:* builder `<Controls>` → cluster rides Phase 3 (CV-1) | slides, app-builder, chassis | 7 |
| ~~CV-4~~ | **Landed (Phase 4)** — pure-SVG `GraphSurface` minimap (node blips + visible-rect frame, click = `centerOn`, Enter = fit) once content exceeds ~1.5 viewports. *Re-ruled:* bounded artboards (drawings/CAD) are exempt — fit always frames the whole sheet, a minimap adds chrome without information | — | §7.3 |
| ~~CV-5~~ | **Landed (Phase 3)** — arm-source → validated-target connect buttons on `BaseNode` (typed first-compatible port pair; port refinement stays in the EdgeInspector) + a `role=status` connect bar with cancel | — | 12 |
| ~~CV-6~~ | **Landed (Phase 1)** — tokens (+dark lift), `snapping.ts` gains equal-spacing (`buildGapCandidates`/`combinedSnapDelta`, align wins per axis), spans + mono badges; drawings + CAD adopted (CAD snaps in model space — the projection auto-fits per render). *Residue:* align/space guides on graph node drags (grid snap only today) → Phase 4 | drawings, CAD | 8 |
| ~~CV-7~~ | **Landed (Phase 4)** — shared `SelectionPill` (`role=toolbar`; duplicate/lock/group/ungroup/delete — spatially-local verbs ONLY, canon 4) + the `elementActions` seam on `InteractivePreviewProps`; drawings + CAD anchor it above the selection's screen bbox. *Residue:* slides blocks (tree trait) ride the per-type morph work on CV-13 | slides blocks | §7.4 |
| ~~CV-8~~ | One undo primitive — **CLOSED (ADR 0361 Phase 2, 2026-07-12) as SURFACE-OWNED BY CONTRACT:** the builder's snapshot undo matches the §7.4 BEHAVIOR standard (depth 30, one entry per gesture — the CT-CV-3 atomic drop-create closed the last two-step gesture; graph-scoped by the deliberate DEF-6 ruling), and the EditorSurface-class ownership is now explicit — the shared `CanvasSurfaceShell` owns the chrome while the builder's engine owns its undo stack | builder (ADR 0361) | §7.4 |
| ~~CV-9~~ | **Landed (ADR 0360)** — campaign funnel BOARD: stored `x/y` on funnel stages (backend validator + artifact schema, host-additive, clamped 0–4000), `graph` trait with `defaultView:'graph'`, chain edges DERIVED from array order (connect rejects / deleteEdge no-ops — the sequence IS the chain), and the new `elementForNode` bridge so board selection drives the ONE elements panel. Inherits zoom cluster/minimap/rails for free | — | 2, 11 |
| ~~CV-10~~ | **Landed (Phase 4, builder)** — xyflow `onConnectEnd` on empty pane opens the drop-point picker filtered to PORT-COMPATIBLE kinds; picking creates + auto-wires. *Re-ruled:* the app-builder board has ONE node kind — drag-to-empty create rides the `addConnectedNode` seam. **Residue landed (residues sweep):** connect-drag drops on empty canvas (≥32-unit travel) spawn a pre-connected screen at the drop point, grid-snapped | — | §7.4 |
| ~~CV-11~~ | **Landed (Phase 5)** — ONE `DeviceFrame` (`{id, label?, width, height?}`): `width` 0 = responsive (preview semantics), a `height` makes it a fixed board frame; `GraphDeviceFrame`/`DevicePreset` are back-compat aliases | — | §7.3 |
| ~~CV-12~~ | **Landed (Phase 5)** — chassis `NotesDrawer`, trait-gated (`frames` + `present`): collapsed summary strip → textarea over the ACTIVE frame's `notesKey`, draft-on-blur commit (DEF-6 — one undo step), open state persisted per type. Slides inherits it; any notes-bearing type gets it free | — | §7.2.5 |
| ~~CV-13~~ | **Landed (Phase 4 chip + ADR 0362 formatting):** the bar's contextual cluster = the identity chip + `quick`-marked prop defs rendered as compact controls (boolean toggle / options menu, 3-cap, wide bars only) — DERIVED from the same `CanvasPropDef` list + write path as the panel (no drift by construction). Consumers: slides (variant/build), campaign (stage). *v2 recorded:* number/color controls; tree-catalog quick props (served-catalog marker question) | per-type v2 | 4 |
| ~~CV-14~~ | **Landed (Phase 2, chassis)** — `useRailLayout` (per-type persistence) + `RailSeparator` (APG window-splitter: drag + arrow-key resize) + collapse-to-strip toggles. *Residue:* builder rails ride Phase 3 (CV-1) | builder | 3 |
| ~~CV-15~~ | **Landed (Phase 2, chassis)** — ≤920px folds Preview/Share/copy-link/History into ONE `⋮` `ui/Menu` (breakpoint-driven, never a measurement loop); `overflow-x:auto` remains only as the documented last-resort fallback. *Residue:* builder bar rides Phase 3 (CV-1) | builder | §7.2.1 |
| ~~CV-16~~ | **Landed (Phase 2, chassis)** — `[` / `]` registry entries toggle the rails (announced); both collapsed = focus mode. *Residue:* builder rides Phase 3 (CV-1) | builder | 6 |
| ~~CV-17~~ | **Landed (Phase 3)** — `RunDrawer` (collapsed summary strip → per-node rows: status chip, transition time, expandable terminal payload); `applyRunEvent` folds `nodeDetail` additively (canvas paint path untouched) | — | 9 |

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
- **Spacing/radius ratchet** (`scripts/check-spacing-literals.mjs`): `gap`/`padding`/`margin`/`border-radius` SHOULD use `--space-*`/`--radius*` tokens, not raw px/rem. A big-bang migration of the existing tail risks unverifiable visual shifts, so this gate **ratchets** against its executable `BASELINE` constant. New code must use tokens; cleanups lower the baseline. Use `.u-button-bare` (§5.1 utilities) to strip native button chrome instead of an inline reset.
- **CI gate:** the canonical `npm run ci` gate (implemented by `scripts/ci.sh`; workflow mirror `.github/workflows/ci.yml`) runs the full frontend `npm run build`, so a type error, a dead prompt-ref, an undefined token, or malformed built CSS fails before merge.
- **Generated facts:** `npm run design:inventory` (or `design:inventory:json`) reports volatile CSS/token/component/keyframe/breakpoint counts. Do not copy those counts into durable prose.
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
- Screen-reader-only text (a state label, an input's accessible name, an async-status announcement) MUST use the shared `.sr-only` / `.visually-hidden` utility (the clip-rect pattern in `global.css`) — NOT `display:none` (hidden from assistive tech too) and never a bare class that isn't defined (which paints the text visible).

---

## 12. Component checklist for any new app addition

Before merging a PR that introduces a new app component:

- [ ] New class added to §5 (app components)
- [ ] Reuses the §5.1 cohesion primitives (`.surface-card` / `.chip` / `.action-bar` / `.btn-sm` / `<StateCard>` / `<Notice>`) instead of a bespoke inline-styled card/chip/notice
- [ ] Icons come from `ui/icons` (§5.2) — **no emoji as icons**
- [ ] Status is shown as a labeled chip, never color alone (§5.3 / §11)
- [ ] Uses only shared tokens (canonical names) + app-functional tokens for color/type/spacing
- [ ] No hard-coded hex / OKLCH literal in component CSS
- [ ] No inline `style={{}}` for static geometry, color, or typography; only measured/data-derived runtime values and documented CSS-variable forwarding are allowed (§10)
- [ ] Has `:focus-visible` keyboard reachability
- [ ] Renders correctly under `prefers-color-scheme: dark` + the `.theme-dark`/`.theme-light` override (§2/§3)
- [ ] Has a documented breakpoint behavior for ≤760px
- [ ] All animations honor `prefers-reduced-motion`
- [ ] Acronyms expand on first appearance per panel

---

## 13. Related files

- Editorial palette + type triple: OpenWOP brand lineage; canonical values in §2 + `global.css :root`
- `frontend/react/src/styles/` + `frontend/react/src/brand/brand.css` — authored stylesheets (tokens, cohesion layer, focus ring, feature/canvas rules, and the final white-label override layer)
- `frontend/react/src/ui/` — shared primitives: `PageHeader.tsx` (§5.5), `StateCard.tsx`, `Notice.tsx`, `Markdown.tsx`, `MarkdownEditor.tsx`, and `icons/` (the §5.2 app-wide Lucide set)
- `frontend/react/src/kanban/KanbanBoardView.tsx` — the one shared drag-and-drop board
- `frontend/react/src/canvas/` — the §7 canvas chassis (`CanvasEditorPage`, `useCanvasViewport`, `GraphSurface`, `shortcuts.ts`); `frontend/react/src/builder/` — the workflow builder converging on §7.2 (ledger §7.12)
- `docs/research/canvas-chrome-best-in-class.md` — the §7 research base (Figma UI3 / Canva / Google editors / VS Code / node-graph editors)
- `frontend/react/scripts/check-css-tokens.mjs` — the §10 CSS-token integrity gate (run in `npm run build` + the `build-app-frontend` CI job)
- `frontend/react/index.html` — Google Fonts link
- `DEPLOY.md`, `DEPLOY-SMOKE.md` — deployment + smoke
- `.claude/skills/ux-review/SKILL.md` — the review skill that enforces this doc (Mode A, app surface)

---

## 14. Open standards we follow

Standards followed: WCAG 2.2 AA, OKLCH, `prefers-reduced-motion` / `prefers-color-scheme` / `prefers-contrast`, RFC 2119 keyword discipline in any normative app prose (e.g., the `/privacy` page).
