# ADR 1055 — Document editor: a closed document schema, a decompression budget on import, and an honest AI rewrite

Status: implemented (2026-11-04, P1–P4 on `fl2-87/document-editor`; adversarial /architect pass before code: 1 CRITICAL, 5 HIGH, 7 MEDIUM, 7 LOW folded in; OQ-3 taken as recommended, reversible on the lead's word)

Feature-loop round 2, row 87 (`document-editor`, default OFF). Extends ADR 0334
(the `canvas.document` editor), ADR 0335/0359 (collab), ADR 0328 (the slides
import-DoS lesson) and ADR 0565 (selection→chat). Host-extension only: no wire
change, no RFC.

## Context

Graded on `origin/main` @ `13fb94b5d`. The grade is
`docs/steward/workflows-assessment/2026-11-04-document-editor-row87.md`. Each
finding below was measured on that commit.

### S1 — the server stores a document the editor opens as blank

A `canvas.document` state is `{ title, content }`, where `content` is ProseMirror
JSON. `validateDocumentDoc` (`features/document-editor/validateDocumentDoc.ts`)
is the only server check on it. It is structural: it bounds node count and depth
and checks field types. It accepts any node `type`, any mark `type`, and a text
node whose `text` is `''`.

The editor and the read-only renderer both build TipTap from the one closed
extension set (`documentSchema.ts`). TipTap's `createNodeFromContent`
(`@tiptap/core` 3.31.3) calls `schema.nodeFromJSON`. Any of those three shapes
makes it throw, and TipTap catches the throw and returns an EMPTY document. So
one bad node anywhere in the tree blanks the whole document. MEASURED: the
validator accepts 3 of 3 shapes, and an editor over
`[paragraph "keep me", <bad node>]` returns `getText() === ''` for each.

Who can put such a node in:

| Lane | Site | What it runs |
|---|---|---|
| REST PATCH (any client, not only the SPA) | `canvasEditorRoutes.ts` `cfg.validate` | `validateDocumentDoc` |
| `ctx.canvas.write` from a run (model output lands here) | `canvasSurface.ts:486` `assertCanvasStateValid` | `validateDocumentDoc` |
| version restore | `canvasSurface.ts:243-251` | `validateDocumentDoc` |
| collab derive (a peer's Y.Doc) | `pmFromY.ts` → derive → `validateDocumentDoc` | `nodeName` mapped verbatim |
| a future schema change that drops a type | stored rows | — |

What the user loses:

- The editor opens blank. If they type and save, the blank document is stored.
  Version history still holds the previous content.
- In a collab session it is worse. The first opener wins the seed election and
  calls `setContent(content)` (`DocumentEditorSurface.tsx` seed effect), which
  seeds the room with the EMPTY fallback. The backend derive then writes that
  empty document to `host.canvas` with nobody pressing Save.

This breaks the CLAUDE.md rule that "model output reaches durable state only
through closed-world validation".

### S2 — the DOCX import has no decompression budget

`POST …/document-editor/orgs/:orgId/import` caps the base64 body at 10 MB
(~7.5 MB decoded) and passes the buffer to `mammoth.convertToHtml`. Nothing
bounds what the zip inflates to. MEASURED: a 98 KB `.docx` inflated to a 42 MB
`document.xml`, came back as 41 MB of HTML, and took the test process to 640 MB
RSS. The cap allows about 75 times that upload. It runs in-process on the shared
Cloud Run instance, so one Editor can take the instance down for every tenant on
it. Bounded by `document-editor` (default OFF, per tenant).

`slides/import/pptxImport.ts` already solved this (ADR 0328): a per-entry cap read
from the zip central directory before decompression, plus a whole-file budget.
The guard was never lifted out of slides. `kb/parsers/docx.ts:137` calls mammoth
the same unbounded way (row 18 is closed; this is the same class).

mammoth also inlines every embedded image as a base64 data URI. The editor then
discards them (`Image.configure({ allowBase64: false })`), so they only inflate
the response.

### S3 — "Improve with AI" drives an agent that holds durable-write tools

The editor's AI affordance stages the selection as a composer draft and
deep-links the ONE chat at `DOCUMENT_AUTHOR_AGENT`
(`features/document-editor/documentAgents.ts`). That id is
`vendor.openwop-app.documents.agents.document-author`, the persona of the
markdown Documents store (ADR 0053, row 24). Its allowlist is
`documents.draft`, `generate-from-template` and `revise`, and its prompt says
"for a free-form document (no template), draft and persist with
`openwop:documents.draft`". The staged prompt reads "Please improve the
following text from my document…". For this agent, saving a new markdown draft
is a correct reading of that request. The result is a durable write into a
different store that the user never asked for.

A selection rewrite needs no tool at all. Its human gate is already the Apply
action plus the tracked suggestion the user accepts or rejects.

### S4 — Apply trusts a stale range and fails without a word

The return handoff (`chat/returnTarget.ts`) carries `{canvasId, from, to}`.
`buildApplyAsSuggestion` (`trackChanges.ts`) refuses only an out-of-bounds range.
So:

- After any edit in between (a collab peer, the same user in another tab, a
  version restore), the suggestion strikes whatever text now sits at those
  offsets.
- When it does refuse, the pending apply is already consumed and nothing is
  announced.
- In a collab session the apply effect runs at editor creation, before the room
  syncs. The doc is still empty, so the range is out of bounds and the chosen
  text is silently lost.

### S5 — Apply pastes Markdown syntax

`MessageBubble.tsx` `applyBack` hands back `messageText(message)`, the whole
reply. The Documents author is told to "write in clean Markdown", so `**`, `- `
and any preamble land in the document as literal characters.

### S6 — track-change attribution is false

The tracking plugin is configured `author: orgId`, and an AI apply passes `''`.
`trackChangeMarks.ts` says each mark "carries an opaque `author` id for
attribution". In practice every typed suggestion carries the org's id, an AI
suggestion carries nothing, and nothing renders either.

### S7 — export hygiene (Low)

`pmToMarkdown.ts` writes link hrefs and `pmToDocx.ts` writes hyperlinks
verbatim, so a `javascript:` href stored through the API reaches the exported
file. The editor never renders it (TipTap's `isAllowedUri`), but the file is
the user's to open elsewhere. The Markdown export wraps an embed's HTML in a
three-backtick fence, so HTML containing a backtick run breaks out of it.

## Decision

> **Revised before code (2026-11-04) after an independent adversarial
> `/architect` pass**, which found 1 CRITICAL, 5 HIGH, 7 MEDIUM and 7 LOW. The
> first draft's decision text is not kept. Its claims that the pass falsified are
> listed in § "Corrections to the first draft" so the trail stays readable.

### D1 — one closed document schema, enforced on every server lane

- `validateDocumentDoc` refuses (422 `validation_error`, first errors only, as
  today):
  - any node type or mark type outside the editor's closed set;
  - a mark entry that is not an object with a string `type`;
  - a text node without a non-empty string `text`;
  - a `link` mark whose `href` fails `isDocumentHrefAllowed` (D7).
- The names and the href rule live in one backend module,
  `features/document-editor/documentSchemaNames.ts` (`DOCUMENT_NODE_TYPES`,
  `DOCUMENT_MARK_TYPES`, `DOCUMENT_LINK_PROTOCOLS`, `isDocumentHrefAllowed`).
- The frontend's `documentSchema.ts` stays the engine. An FE test PARSES the
  backend module (the `canvas/__tests__/capParity.test.ts` precedent), and a
  parser miss throws. It checks two things:
  - `getSchema(documentExtensions())` names exactly those nodes and marks;
  - the editor-only extensions (Placeholder, SlashCommand, TrackChanges,
    collab) add none.
- StarterKit's `link` is configured with an `isAllowedUri` over the same
  protocol list, so the editor, the validator and both exporters agree.
- `document-editor/routes.ts` sets `validateSeed: validateDocumentDoc`. On
  `main` it sets only `validate`, so `POST …/from-artifact` seeds a
  `canvas.document` from a run artifact (model output) with no validation at all
  (`canvasEditorRoutes.ts:316-319`).
- After that, every lane that writes `canvas.document` state runs the closed
  validator:

  | Lane | Site |
  |---|---|
  | REST PATCH | `cfg.validate` |
  | from-artifact seed | `cfg.validateSeed` |
  | `ctx.canvas.write` / `ctx.canvas.create` | `assertCanvasStateValid` on the merged result |
  | version restore | `opts.validate` |
  | collab derive | `entry.validate`; a failing derive is skipped and logged at warn |

- Attributes other than `link.href` stay open. prosemirror-model drops unknown
  attributes rather than failing, so they cannot blank a document. `image.src`
  is not pinned, because the media serve URL differs per deployment; the SPA
  CSP `img-src` already blocks a remote beacon.

### D2 — a document that already holds a bad node opens with its good content

- A pure `repairDocumentContent(content)` in the frontend `documentDoc.ts` walks
  the JSON against `getSchema(documentExtensions())`. It drops unknown nodes,
  unknown or malformed marks, and empty text nodes, and returns
  `{ content, dropped }` with counts by type.
- The editor surface (initial content, the re-seed on load or restore, and the
  collab seed) and `DocumentRenderer` pass content through it before TipTap sees
  it. The re-seed guard `emittedRef` keys on the INCOMING (unrepaired) JSON, so a
  repaired document does not re-seed in a loop.
- When `dropped` is non-empty, the surface shows one `Notice`.
  - Solo: "N unsupported elements could not be shown. They will be removed when
    you save."
  - Collab seeder: "N unsupported elements were removed." In collab this is a
    repair-and-persist. The seed writes the repaired content into the room, and
    the room derives it into `host.canvas` without a Save. y-prosemirror also
    deletes misfit elements on bind (`sync-plugin.js:801-810`).
  - Both strings ship in all four locales.
- What D2 does NOT promise: a forced version capture before a collab seed. That
  belongs in the chassis (row 100) and is filed as `DE87CD-F1`.
- Why that is acceptable now:
  - Production holds **0** `canvas.document` rows and **0** versions (lead's
    read-only measurement, 2026-11-04).
  - After D1, a bad node can only come from an older row or a future schema
    change.
  - D1's parity test makes a removed type a visible test change, and this ADR
    records the rule: **removing a node or mark type from the document schema
    ships a stored-row migration**.
- Restore of a snapshot holding a now-unknown type stays a 422 with the
  validator's message, which is the honest state under the same rule.

### D3 — one counted zip budget for OOXML imports (DOCX, PPTX)

- Lift the slides guard into `host/zipBudget.ts`:
  `openZipWithinBudget(buffer, { maxEntryBytes, maxTotalBytes, maxEntries })`,
  which returns a counted `readText` / `measure` per entry.
  - It reads the central directory with JSZip as a fast path: a declared size
    over the cap refuses at once.
  - It then inflates EVERY entry (whatever its name: mammoth reads the main part
    from `_rels/.rels` and always reads `mammoth/style-map`, DE87CD-1) through
    `internalStream('uint8array')` with a
    byte counter, and aborts the moment an entry passes `maxEntryBytes` or the
    total passes `maxTotalBytes`. Abort means `pause()` on JSZip's own worker:
    the first cut used `nodeStream()`, whose Node adapter cannot reach the
    worker, so a refused entry went on inflating in the background after the
    413 (DE87CD-2). A test now waits and asserts the count stops.
  - A header that lies about its size therefore cannot inflate past the cap.
    JSZip checks the declared size only after a full inflate
    (`jszip/lib/compressedObject.js:36-39`), so the central directory alone is
    not a guard.
  - It throws a typed `ZipBudgetError` (`entry_too_large` | `archive_too_large` |
    `too_many_entries` | `unreadable`), and each caller maps that to its own
    response.
- `pptxImport.ts` uses it in place of its own size read. Its post-inflate
  `text.length` check stays. The slides route keeps its 422 and its exact
  message text (`slides-editor-routes.test.ts:536` stays green unchanged).
  This also closes slides' lying-header hole.
- The document-editor import:
  - runs the counted budget before mammoth over every part: 8 MB per part and
    20 MB total. The measured RSS is ~15 times the XML size, so one 8 MB parse
    is near 120 MB against a 1 GiB instance with 2 in flight. Images barely
    compress, so a real document's total stays near its upload size;
  - runs mammoth with images dropped at the source (the KB parser's
    `convertImage` shape);
  - refuses HTML over 5 MB;
  - holds a per-instance limit of 2 imports in flight; a third gets 429 with
    `Retry-After`.
  - Each refusal is a 413 with a user-facing message, and the 413 is already
    surfaced by the toolbar's DOC-G3 error path.
- The 5 MB HTML cap bounds the response, not memory. The counted inflate is the
  memory bound.
- mammoth inflates the archive a second time after the budget pass. That is
  double CPU inside the caps, and it is accepted: mammoth exposes no hook into
  its own unzip.
- **Out of this PR (lead decision pending, OQ-1):** `kb/parsers/docx.ts` and
  KB's `officeparser` lane (pptx/xlsx/odt) inflate the same way. They are another
  feature's files, so they go in their own PR off `main` once the helper lands.

### D4 — a writing assistant with no tools for the document editor

- **One host seam change.** `effectiveToolAllowlist`
  (`host/agentToolAllowlistService.ts`) gives every agent the ADR 0315 default-on
  baseline, and that baseline includes `openwop:documents.draft`. An empty
  manifest allowlist is therefore NOT tool-less; it would still offer the stray
  write S3 names.
- A manifest flag cannot opt out. `schemas/agent-manifest.schema.json` is
  `additionalProperties: false`, so a new field would be a wire change.
- **The opt-out is a CORE capability, activated per agent** (user law: nothing in
  source is unique to a named agent; ADR 0031 `AgentProfile.capabilities`):
  - a new host-internal `AgentCapabilityId`, `text-only` (never advertised on the
    wire; host profile data);
  - `agentOffersToolBaseline(tenantId, agent)` answers `false` when `text-only`
    is activated, either by the agent's OWN pack (below) or on its tenant
    profile. A profile read error is logged and fails OPEN to the baseline,
    since every agent's turn reads it;
  - `effectiveToolAllowlist(manifest, override, offersBaseline)` takes the flag
    as a REQUIRED parameter, so tsc refuses a caller that forgets to ask. All
    five callers (`agentDispatch`, `conversationToolLoop`, campaign-ops binding,
    voice `toolBridge`, the allowlist admin route) derive it from the profile,
    and a source ratchet refuses a hard-coded `true`;
  - **the pack activates it for its own agent by default**, through the node-pack
    manifest's sanctioned vendor-extension point (`patternProperties: ^(x-|vendor\.)`,
    so no wire change):
    `"x-openwop-app": { "agentCapabilities": { "<its agentId>": ["text-only"] } }`.
    The agent loader reads it into the host-internal `hostCapabilities` field.
    It reads the key only for agents of the SAME manifest, so a pack cannot reach
    another pack's agent, and keeps only `PACK_DECLARABLE_AGENT_CAPABILITIES`
    (`['text-only']`), so a pack can only take tools away. Every entry point and
    every workspace gets it with no per-tenant write: the chat picker, an
    @mention, and a tenant where the editor is off;
  - the admin allowlist panel no longer tags baseline tools as "default-on" for
    a `text-only` agent (DE87CD-8).
- An ADR 0104 operator override stays authoritative, as today. This is recorded
  as a correction note on ADR 0315.
  > **Corrected twice on 2026-11-04 (lead review), both before any merge.**
  > (1) The first implementation listed the agent's id in a host constant,
  > `TOOL_BASELINE_EXEMPT_AGENT_IDS`, inside the resolver. That put something
  > unique to a named agent in source, which the architecture forbids.
  > (2) The second activated the capability on a per-tenant profile through an
  > editor route called before each deep-link. Independent grade-code found it
  > wrote to the caller's HOME tenant while chat runs in the active one
  > (DE87CD-15), and that every other way into the agent, and every failed call,
  > kept the baseline (DE87CD-16). The pack-declared default above replaces both.
  > The route, the provisioning call and `writingAssistant.ts` are deleted.
- **The pack.** A new pure-agent pack, `vendor.openwop-app.document-editor.agents`
  1.0.0, holds one agent: `…document-editor.agents.writing-assistant`, with
  `toolAllowlist: []`.
- **Its prompt:**
  - rewrite or answer about only the text it is given;
  - return the result and nothing else: no preamble, no Markdown syntax, no
    code fence;
  - keep the user's meaning and language;
  - never claim to have changed the document.
- `document-editor` declares the pack in `requiredPacks`. It is pinned in
  `packPins.ts`, with its `packs/.steward-manifest.json` entry, and it rides
  `required-packs-pin-parity`.
- **Both entry points move to `DOCUMENT_WRITING_AGENT`.**
  - The selection action keeps its prompt.
  - The toolbar "Ask AI" no longer opens a blank chat with an agent that cannot
    see the document. It stages a composer draft that quotes the SAVED document
    as plain text, the same text the Markdown export serializes, capped at
    12,000 characters with an explicit "(truncated)" marker. The user sees and
    edits the draft before sending. The agent reads what it is asked about and
    writes nothing, so read-before-write holds without a read tool.
- Model output then reaches the document only through Apply, as a tracked
  suggestion the user accepts or rejects.
- Witness: the agent's compiled turn tools are `[]` through
  `effectiveToolAllowlist`, and an ADR 0104 override still replaces them.
- The new agent is listed even while `document-editor` is OFF, because
  `requiredPacks` installs regardless of the toggle. With no tools, that is
  harmless.

### D5 — Apply checks what it is replacing, waits for the document, and always says what happened

- `ReturnTarget` and `PendingApply` gain `expectedText` and `agentId`.
  `MessageBubble`'s `applyBack` copies them across.
- The Apply action shows only on assistant messages whose `agentId` equals the
  target's. A reply from another agent in another conversation cannot be applied.
- One helper, `selectionText(doc, from, to)` (the current
  `textBetween(from, to, '\n', ' ').trim()`), is used at staging and at apply.
- The editor PEEKS at the pending apply. It takes it only when the canvas
  matches, and only once the document is ready: solo after mount; collab after
  `synced` and after the seed claim settles.
- It applies only if `selectionText(doc, from, to) === expectedText`.
- Every outcome is reported. An applied suggestion is announced as today. A
  changed range, an out-of-range position or an empty reply is SHOWN in a
  dismissible warning Notice that announces itself: "The selected text changed,
  so the suggestion was not applied. Select it again and ask once more." The
  string ships in four locales, and a later successful apply or import clears
  it. (Corrected after the UX re-grade, DE87UX-25: the first text said
  "announced assertively"; the Notice announces politely, since the user has
  just navigated back and is not mid-task.)
- The applied text is the reply with one wrapping code fence stripped
  (`plainRewriteText`), then trimmed. It stays a single text run, so the
  existing `to + text.length` arithmetic holds. Newlines show as line breaks.
  Multi-block structured insertion stays the recorded 5b-2 refinement.

### D6 — honest attribution

- Typed suggestions carry `author: ''` instead of the org id, which identified
  nobody.
- An AI apply carries `author: 'ai'`, rendered as `data-author="ai"` with a
  dashed, info-toned underline so it reads apart from a typed suggestion. The
  apply announcement already names it as an AI suggestion.
  > Corrected in implementation: the first text promised an accessible title.
  > A mark's `renderHTML` has no i18n, so the distinction is the style plus the
  > announcement; a localized per-mark label is filed as `DE87UX-F1`.
- Neither value is personal data, so DSAR gains nothing to erase. The
  attribute is display-only and a REST writer can forge it; the
  `trackChangeMarks.ts` comment is corrected to say so.
- Since the `<ins>`/`<del>` parse rules outrank Strike (priority 60, DE87UX-22),
  pasted HTML such as `<ins data-insertion data-author="ai">` becomes a real
  tracked-change mark with whatever author it names (DE87CD-22). That is the same
  display-only, forgeable stance; the mark is still a suggestion the reader
  accepts or rejects, never an applied edit.
- A later pack version that drops `x-openwop-app.agentCapabilities` serves that
  version with the default-on baseline: the capability is per manifest version,
  like the allowlist.

### D7 — export hygiene, in both Markdown serializers

- There are two Markdown serializers, and they already differ.
  `frontend/.../pmToMarkdown.ts` feeds the toolbar Copy/Download and escapes
  parentheses in hrefs; `backend/.../pmToMarkdown.ts` feeds the `.md`/`.pdf`
  export and does not.
- Both, plus `pmToDocx`, export a link only when `isDocumentHrefAllowed` passes.
  The FE uses a copy of the rule pinned by the D1 parity test. A refused href
  exports as plain text.
- Both fence an embed's HTML with one backtick more than the longest backtick
  run inside it.
- The same cases are pinned on each side. Merging the two serializers into one
  is filed as `DE87CD-F2`.

### Corrections to the first draft (kept for the trail)

- "With no tools in the allowlist, the agent's only output is chat text" was
  false. The ADR 0315 baseline applies to an empty allowlist (CRITICAL). D4 now
  carries the exemption.
- "The same validator already runs on all four lanes" was false. The
  from-artifact seed ran none (HIGH). D1 now wires `validateSeed`.
- "Reads uncompressed sizes from the central directory BEFORE inflating" was
  not a guard. A zip can lie (HIGH). D3 now does a counted inflate.
- "Per entry 20 MB, total 40 MB" was unsafe against the measured ~15× RSS on
  1 GiB (HIGH). D3 now uses 5/20 MB plus an in-flight limit.
- "Nothing is written on open" was false in collab (HIGH). D2 now states the
  repair-and-persist.
- "Version history keeps the original" was not guaranteed. Run writes take no
  snapshot (HIGH). D2 now states the migration rule and files the chassis capture.
- "The same scheme allowlist as the editor (http, https, mailto)" was wrong.
  TipTap allows ten schemes. D7 now configures one list for all four users.

## Alternatives weighed

- **Ship the backend validator only (no D2).** Rejected. Stored rows that already
  hold a bad node, and future schema removals, would still open blank. A blank
  doc in a collab room is persisted by the derive with no user action.
- **TipTap `enableContentCheck` + `onContentError`.** It reports the error, but
  TipTap still falls back to an empty document. The user sees a message over a
  blank page instead of their content.
- **Strict FE refusal (render nothing, block editing).** Safer for the stored
  row, worse for the user, who could not even read the good 99%.
- **Reuse the Documents author with a prompt branch.** Rejected. Its allowlist
  is what makes the stray write reachable, and a prompt is not a gate.
- **Relocate a stale range by searching for `expectedText`.** Deferred. It is
  ambiguous when the text repeats, and a refusal with a clear message is honest.
- **A budget inside mammoth's own unzip.** Not exposed by mammoth's API. The
  central-directory pre-check is what slides already does.

## Phases

| Phase | Content | Witness (RED on `13fb94b5d` first) |
|---|---|---|
| P1 | D1 + D2 | BE: validator refuses the 3 blanking shapes + a `javascript:` href; from-artifact seed 422. FE: parity test; editor and renderer keep "keep me" and show the Notice |
| P2 | D3 (helper + document-editor + slides) | 413 on the honest-header bomb AND on a lying-header bomb; 429 on a third concurrent import; slides tests unchanged |
| P3 | D4 + D5 + D6 | turn tools `[]`; Apply refuses changed text, waits for collab sync, announces; Apply hidden for another agent's reply |
| P4 | D7 + docs (FEATURES, tracker row) | export cases on both serializers |

One PR (KB in its own PR, OQ-1). Everything is host-only and sits behind
`document-editor` (stored `beta`, one tenant override `on`, 0 documents in
production).

## Implementation record

| Phase | Commit | Witness (RED on `13fb94b5d` first) |
|---|---|---|
| P1 D1+D2 | `61ca2aa50` | `test/adr1055-document-editor.test.ts` D1 (5 of 7 red on main source); FE `documentRepair`, `DocumentRenderer` (red on main), `documentSchemaParity` (sabotage: an extra BE node type reds it) |
| P2 D3 | `f590305de` | same file, D3: bomb, lying-header bomb, images (3 of 3 red on main: the bomb answered 200 with ~6 MB of HTML); slides suite unchanged |
| P3 D4+D5+D6 | `61025b240` | D4 block (no pack on main; the baseline offered 9 tools to an empty allowlist); FE `aiApply`, `returnTarget`, `DocumentToolbarExtras` |
| grade fixes | `61dee83a6`, `78a3e69a2`, and the slash-menu commit | `DocumentEditorSurface.test.tsx`, `SlashMenu.test.tsx` (DE87UX-7: the focused textbox now carries `aria-activedescendant`/`aria-expanded`/`aria-controls`, and the active option is announced), each sabotage-witnessed |
| P4 D7 + docs | `a639c7095` | both `pmToMarkdown` suites + the `.docx` link case (3 of 3 red on main serializers) |

Not witnessed by a test: the 2-in-flight import limit (a concurrency race is not
deterministic in the suite; it is a defense in depth beside the counted budget).

## Open questions

- OQ-1 (lead, answered): KB's docx and officeparser lanes are another feature's
  files, so they go in their own PR once the helper lands on `main`.
- OQ-2: the D3 numbers are set against a 1 GiB instance (lead's env read). Raising
  instance memory later does not change them; re-measure before raising them.
- OQ-3 (lead, answered): a core, profile-activated capability, never an id list
  in the seam (D4).
- Filed: `DE87CD-F1` forced version capture before a collab seed (chassis, row
  100); `DE87CD-F2` one Markdown serializer instead of two; `DE87CD-14` an Apply
  waits silently if a collab room never syncs; `DE87CD-20` the content rules of
  lists, tables and code blocks are not checked (nothing crashes; a collab peer's
  editor drops content that breaks them); KB's docx and officeparser lanes on the
  shared zip budget (OQ-1); `DE87UX-11` orphan comment
  highlight, `-13` image alt text editing, `-14` look-alike icons, `-17/-18/-20`
  Lows; `DE87UX-27` MEASURED and left: a ~70-page document (1,500 paragraphs,
  ~350k characters) costs 3 to 4 full-document scans and ~3.5 ms of render per
  transaction in jsdom, with up to 200 suggestions. That is linear per keystroke,
  not quadratic. `markRangeAt` is O(k²) in the suggestions it touches, only while
  the cursor sits in one.
