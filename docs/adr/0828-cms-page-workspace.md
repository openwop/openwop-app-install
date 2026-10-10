# ADR 0828 — the CMS page workspace: one screen, edit on the page

Status: Accepted (implemented, phase 1 of 4)

> **RENUMBERED 2026-10-05: 0822 → 0828.** Merged in #4415 minutes after #4428 merged the workflow-author ADR as 0822; the duplicate red `check-adr-refs` for every branch. The later-merged decision takes the next free number (`check-adr-refs --next`). Commits and the PR body of #4415 still say "ADR 0822" — they mean this file. (Commits in #4424/#4429/#4430 briefly called it 0826 before main settled on 0828; they mean this file too.)

Related: ADR 0009 (CMS), ADR 0204 (shared sections, scheduling, preview links),
ADR 0206 (versions, the media picker), ADR 0592 (localization and the
translator surface), ADR 0813 (the launch post), ADR 0817 (the public site's
media library).

## Context

The page editor split work across three views. Public showed the rendered page
but could not edit it. Editor was one long card holding the page settings,
every field of every section, the schedule controls and Save. Outline showed
rough blocks. History, preview links and experiments were collapsed panels
below the Save bar, in Editor only.

A comparison with MyndHyve's CMS and seventeen page builders (Webflow, Framer,
Sanity, Storyblok, Shopify, Payload, WordPress, Ghost, Prismic and others)
found the gap was the editing model, not features. The leaders put the section
list, the live page and the settings for the current selection on one screen,
and save drafts automatically.

## Decision

Phase 1 replaces the three views with one workspace.

1. **Three regions.** A section list on the left, the live page in the middle,
   and a settings panel on the right with two tabs:
   - **Section**: the selected section's fields only;
   - **Page**: title, tags, blog-post settings, scheduling, preview links,
     History and experiments.
   **Preview** hides the list and the panel. The layout sizes to its own
   width with container queries, because the admin shell's two sidebars take
   a varying share: three columns when wide, the list over the panel beside
   the page when medium, one column when narrow.
2. **One selection.** Selecting a row in the list or a section's Edit button on
   the page selects that section in all three regions. The page outlines it.
   The first section is selected when a page opens. Removing a section selects
   its neighbour.
3. **Structure lives in the list.** Move, remove and add moved from the section
   cards to the list. Add inserts after the selected section. Remove asks
   first, because autosave makes it stick.
4. **Autosave for drafts only.** A draft saves itself 1.5 seconds after the
   last edit, with no toast. A published page does not: saving it changes the
   live site, so it keeps an explicit Save and the status says so. A page in
   review does not either, because a save makes its pending approval stale. A
   failed autosave is not retried until the next edit, and a conflict pauses
   autosave until the person chooses.
5. **One status line.** The header says "All changes saved", "Unsaved changes",
   "Saving…", or, on a live page, that Save updates the live page. Save sits in
   the header next to the workflow actions, shown when there is something to
   save.
6. **Plain names.** Section cards and the list show "Rich text", not `richText`.

The translator surface keeps its narrowing: no Page tab, no structure
controls, base content read-only.

## Consequences

- Every existing capability stays reachable, most of them in fewer clicks.
- **Follow-up (implemented): the Page tab's address and search fields.** The
  address is edited in place, cleaned to the server's slug rules as it is
  typed (the server still trims and de-duplicates), and saved with the page; a
  published page keeps a redirect from the old address. The description and
  social image are the publishing feature's per-page SEO record: loaded with
  the page, saved with it (drafts autosave both), and hidden behind a warning
  when the read fails, so blanks never overwrite it.
- **Phase 2, part 1 (implemented): drag to reorder, and undo.** Rows drag by
  a grip (pointer, or Space/Enter then arrow keys, announced to screen
  readers; `@dnd-kit/sortable` beside the existing `@dnd-kit/core`). Undo and
  Redo (buttons, ⌘Z/⇧⌘Z outside text fields) step through the page's content
  and search record; typing bursts coalesce into one step, and a save is never
  a step (content is compared normalized, without the section ids the server
  mints). A save now maps a new section's `new:` id to its minted `sec:` id, so
  the selection and in-flight edits follow it.
- **Phase 2, part 2 (implemented): the add-section picker.** "Add section"
  opens a dialog of cards, one per section type, each with a CSS sketch of its
  layout and one line on what it is for, filtered by category (Text, Media,
  Data and sales, Shared) or search. The sketches are drawn from the type
  alone, so the picker needs no sample content and makes no requests. Shared
  sections appear as cards and insert by reference. The section editor
  outside the workspace keeps its compact dropdown.
- **Phase 3, part 1 (implemented): review before Publish.** Publish, Approve
  and Submit open a checklist (`publishChecks`, a pure function) before the
  action runs. Blockers: an empty title, a `[TODO …]` marker left in any
  section. Suggestions: empty sections, no author on a post, no or an
  over-long search description, no social image on a post, accessibility
  findings, and sections untranslated in a non-withheld locale. Passed checks
  are listed too. Each finding's "Show me" selects the section or opens the
  Page tab. Blockers disable Publish and Approve; Submit stays available,
  because a reviewer can help finish the page.
- **Phase 3, part 2 (implemented): compare and take.** Compare (in History)
  shows each changed section with this version and the draft side by side.
  "Use this version" copies that one section into the draft; "Put this section
  back" restores one the draft removed; "Use the whole version" is the
  existing Restore. The draft autosaves and Undo takes a section back. A
  seeded update's sections carry freshly minted ids, so its compare pairs
  sections by position and type (`diffSections(..., { pairByPosition })`);
  ordinary history keeps id pairing, where a new id really is a new section.
- **Phase 3, part 3 (implemented): AI on the selected section.** The Section
  tab has Improve, Shorten, Expand, Friendlier, More formal, Fix spelling,
  and a short instruction of the author's own (≤ 500 characters). One
  `POST …/rewrite-section` call (write-gated) follows the translate pattern:
  one headless dispatch, JSON in and out, the stored-overlay sanitizer, one
  bounded repair, then `rewrite_invalid` (502); no provider is a 503. The
  model edits TEXT only: links, media tokens, ids and non-string values come
  from the input whatever it returns (`keepNonText`). The result is a
  proposal shown current-beside-proposed; Apply puts it in the draft, Undo
  takes it back. Not offered on the translator surface or on shared-section
  references.
- **Revision (implemented): edit on the page, not in a sidebar.** A design
  review found the settings panel doing three jobs (one section's fields, AI,
  and every page-wide setting) and sorting living in a second list, away from
  the page. Both side columns go:
  - **Edit · Preview · Page tabs.** Edit and Preview show the page at full
    width; Page holds the page-wide settings, grouped (Basics, Blog post,
    Search and social, Publishing, History, Experiments).
  - **Sections edit in place** (`CmsCanvas`, inside the preview frame). Each
    section has a drag handle and a sticky toolbar (Edit, move, duplicate,
    delete); Edit opens that section's editing card where it sits, one at a
    time, focused on its first field, with AI actions below the fields;
    Escape or Done closes it and returns focus to its Edit button.
  - **Sections arrange in place.** "+" between sections opens the picker at
    that spot; the handle drags, or Space, the arrows and Space reorder,
    announced. A Sections menu jumps to a section without opening it.
  - **Shortcuts inside the frame.** The preview frame reports its document
    (`PublicPreviewFrame onDocument`) and Undo/Redo bind there too; before,
    they did nothing with focus in the page.
  - **A save follows a new section to its minted id** for the open editor as
    well as the selection.
  Typing directly into the drawn text (a per-type rich-text mapping) is the
  next step, scoped by where people type most.
- Later phase: comments pinned to a section and presence on the section list
  (phase 4).
