# ADR 0992 — Conversation export / import: render what the person saw, import only words

Status: implemented (branch `feat/fl2-60-chat-export`; see the implementation record)

Feature loop round 2, row 60 (`chat-export`, FEATURES.md "Conversation export").
Amends ADR 0119 (Phases 1, 3, 4) and ADR 0698 (D2, D3 sequencing). Ids are
`CX2WF-` / `CX2UX-` / `CX2CD-`.

## Context

Measured at `origin/main` `dde96ce72`; prod read-only on 2026-10-27.

**Prod:** 58 conversations, 141 messages. **All 141 rows** are the SPA's
JSON-serialised `ChatMessage` envelope (`encodeMessageForStore`,
`frontend/react/src/chat/lib/promoteConversation.ts:32`). 0 imported rows, 0
`conversation-transcript` Documents, 0 conversation share links, 0 stored resume
tokens. So the one defect live today is the unreadable export. The rest are latent,
and no row needs migrating.

The defects, each witnessed RED by `test/chat-export-adr0992.test.ts`:

1. **The renderer never learned the store's shape (CX2CD-1).** `transcriptRenderer.ts`
   calls any JSON content a "structured card" and fences the whole envelope.
   Every SPA row is JSON, so every markdown export is a list of ```json dumps that
   include `thoughts`, tool-call arguments, `workflowRun` state and
   `activeInterrupts[].token`, the resume token the public event log deliberately
   withholds. The same function produces the **public share link**
   (`sharing/sharingService.ts:466`) and **export-as-Document**, so this is a
   share-to-the-internet path for a capability token. The older tests used
   plain-text fixtures, which is why nothing caught it.
2. **Import stores what the file says (CX2CD-2).** An `openwop-v1` row's `content`
   is stored verbatim, and `parsePersistedMessages` spreads a stored envelope into
   a live message. An import file can therefore render interrupt cards, run cards
   and another agent's name and avatar inside the person's own chat. An imported
   `role:'system'` turn is stored as a system row.
3. **Imported words are nobody's (CX2CD-3).** `authorSubject: null`, so
   `chatPostErasure` (which matches by author) never reaches them, while every
   row the SPA writes carries the caller.
4. **"Idempotency-keyed by the caller" was false (CX2CD-4).** There was no key; a
   retry or double click makes a second conversation.
5. **The row is written before the lock (CX2CD-5).** `createChatSession` runs
   before `ensureConversationMeta`, and an owner-less conversation is
   tenant-visible (`conversationVisibility.ts:34`). A failure between them leaves
   the import readable by every member.
6. **Export-as-Document widens who can read (CX2CD-6).** Documents without an
   `ownerSubject` are org-readable. The tool copies channels, groups, DMs and
   project chats (other people's words) into one, and copies a client-bound
   conversation into any org. Its description says "It never publishes or shares".
   Branch refuses channels for exactly this reason (ADR 0879 H3).
7. Smaller: a malformed body is a 500 (a standing `it.fails`); an unparseable
   `createdAt` is stored; the route and the tool each inline the visibility check.

Workflow / UX:

- **ChatGPT import fails on every real file (CX2WF-1).** A ChatGPT data export's
  `conversations.json` is an **array** of every conversation; the SPA sends it as
  `openwop` and the parser 500s. Real files also exceed the global 1 MB body limit.
- **An imported conversation cannot be continued with context (CX2WF-2).** The next
  turn's history is folded from the conversation run's event log
  (`host/exchange/loadTurns.ts`), and an imported conversation's run starts empty.
  The chat shows the history; the model has never seen it; nothing says so.
- **The agent tool is unreachable (CX2WF-3).** No pack allowlists
  `openwop:conversations.export-document`.
- UX (CX2UX-*): one generic error toast; no count of what was imported, skipped or
  truncated; no marker on imported messages; downloads named by UUID; a dead
  `exportAccess = { enabled: true }` constant in `TabSession.tsx`.

## Decision

**D1 — One message projection, used by every exit.** `messageView(row)` in
`transcriptRenderer.ts` reads the store's real shape and returns
`{ role, speaker, text }`:

- an SPA envelope gives its `content` text;
- `ContentPart[]` gives its text parts, with `[image]` / `[audio]` / `[file]`
  placeholders;
- a `workflow_run` row gives its one-line status summary;
- plain text gives itself.

`speaker` is `agentPersona ?? agentId ?? role label`, so a multi-agent export
names who answered. Markdown is built only from these views: no envelope field
other than the text is ever serialised, so thoughts, tool calls, run state and
interrupt tokens cannot reach a download, a Document or a share link. Legacy
non-envelope JSON (a server-written card) keeps its fenced block, with any key
matching `/token|secret|credential|apikey/i` redacted. The JSON export keeps the
envelope (it is the person's own round-trip file), adds `text` and `speaker` per
message, and applies the same key redaction. The share card's description uses
`messageView().text`.

**D2 — Import stores only words, in a closed envelope.** Each imported turn is
projected through D1 and written as `JSON.stringify({ role, content, createdAt })`,
with exactly those three keys. Roles other than `user` / `assistant` (system,
workflow_run, tool, unknown) and empty turns are **skipped and counted**.
`createdAt` must parse, or a monotonic import-time stamp replaces it; ChatGPT's
`create_time` is read. The row keeps `meta: { contentTrust:'untrusted',
source:'import' }` (ADR 0698 D1b: provenance, not a fence). The response reports
`{ sessionId, imported, skipped, truncated }`.

**D3 — Imported words belong to the importer.** Every imported row's
`authorSubject` is the importer's chat-author spelling, the same function the
chat-sessions append route stamps (`userRef(req.userId)`, else the principal).
That function moves to `host/chatAuthorSubject.ts`, and both routes call it. This
is the doubled `user:user:` form for a signed-in user. ADR 0464 §8 chose to fix
the matcher, not the writers, and `subjectKeyForms` matches it, so
`eraseSubjectChatPosts` tombstones an import exactly like a typed chat. Deletion
stays the normal `DELETE /chat/sessions/:id` → `deleteConversationCompletely`.

**D4 — Idempotency is a deterministic id.** `idempotencyKey` is optional,
`[A-Za-z0-9_.:-]{1,128}`. With a key, the session id is
`imp-` + `sha256(tenant | owner | key)[0..32]`. A repeat finds that session owned
by the same owner and returns `200 { replayed: true }`, appending any rows a crash
left out (message ids are `${sessionId}-i${n}`, so a re-append is a no-op). With
no key, behaviour is unchanged (a random id). The SPA sends `sha256(file text)`,
plus the chosen conversation's index for a ChatGPT archive. No new store, so no
new DSAR surface.

> **Correction (architect B2, as built):** the id is
> `imp-` + `sha256(tenant | owner | key | digest(title + normalised turns))[0..32]`, not
> `sha256(tenant | owner | key)`. The digest is what makes resume-append safe: a
> reused key with different content gets a different id.

**D5 — Lock before content.** The owned meta is written first, then the session,
then the rows. A failure leaves an owned, private, resumable conversation.

> **D5 note (code-review CR-6):** the scoped 10 MB parser (D6) is mounted before auth, like every
> scoped parser in `scopedBodyParsers.ts` (document-editor, media). An unauthenticated caller
> can make the server parse up to 10 MB before the 401. That is the existing pattern; it is
> filed (`CX2CD-R4`), not solved here.

**D6 — Size.** A scoped `express.json({ limit: '10mb' })` for
`/host/openwop-app/chat-export/import`, registered before the global 1 MB parser.
The existing caps (2,000 turns, 100,000 chars per turn) stay, but are now
reported. Per-caller quota (CXC-3, ADR 0698 OQ2) stays open; the write tier is
60/min.

**D7 — Typed errors.** Parsers throw `OpenwopError('validation_error', …, 400)`.
An array body answers 400 with `details.reason: 'archive'`. The SPA never sends one
(D9).

**D8 — Export-as-Document copies only a conversation that is the actor's alone.**
One feature helper, `authorizeConversationExport(tenantId, sessionId, actor)`, holds
the visibility check (an absent or invisible conversation is a uniform
`not_found`). The route, the tool and `exportConversationAsDocument` all call it.
The tool then refuses:

- `shared_conversation` when the meta is a channel or group, has an
  `ownerSubject`, or lists any human participant other than the actor
  (`agent:` refs are fine);
- `client_mismatch` when the conversation is client-bound and the target org is
  not that client's org.

The description and result tell the truth: the transcript is a draft "visible to
members of <org>". The download is unaffected: the person can already read what
they download.

> **Correction (as built):** the helper is `authorizeConversationRead` (`access.ts`). Two
> rules were added by the closing grades:
> - only `type:'agent'` conversations qualify, because ADR 0043 `person` is a DM with
>   another human and `workspace` is tenant-wide;
> - `refuseUnlessSoleAuthor` refuses when any STORED message was written by another
>   person. An owner can remove a participant, and that person's messages stay
>   (grade-code CX2CD-1).

**D9 — The SPA says what happened.**

- Import:
  - Parses the file locally. A ChatGPT archive opens a lazy picker listing its
    conversations by title, date and message count, and imports the one chosen.
  - Sends the D4 key.
  - Toasts the result ("Imported 42 messages · 3 skipped").
  - Maps error codes to specific copy: too large, not a supported export, nothing
    to import.
- Imported messages carry `meta.imported`, read from the row meta. The feed shows
  one notice after the imported block: imported messages are for reference, and
  the assistant starts fresh from the next message.
- Downloads are named from the title.
- The dead `exportAccess` constant goes.
- New copy ships in all four locales.

> **Correction (code-review CR-1):** imported text is never part of a turn's context, but
> it is NOT true that it never reaches a model. An agent allowlisted for
> `openwop:conversations.search` can retrieve it, fenced by that tool's
> `contentTrust:'untrusted'` declaration. The notice therefore says "not part of the
> assistant's context", not "the assistant hasn't seen them".

**D10 — Not seeding the model (filed, CX2WF-2 → OQ1).** Making an imported or
branched conversation's history visible to the model means folding stored rows
into the exchange transcript, fenced and role-downgraded. That is the same open
refinement ADR 0117 left for branch. It belongs in the exchange fold, not in this
feature, and the honest notice (D9) is the interim.

> **Lead decision (2026-10-27):** the disclosure variant is ACCEPTED in place of the
> A/B choice (a read-only archive vs seeding the history): an imported conversation
> stays continuable, every imported message carries the "Imported" label, and the feed
> notes the messages are not part of the assistant's context and that it starts fresh.
> No read-only follow-up. Seeding stays OQ1.

## Pre-code `/architect` pass (2026-10-27) — folded in

Two Blockers and three Highs in the decision text above. Each one amends its D:

- **B1 (D8).** "No human participant other than the actor" admits a **legacy,
  owner-less** conversation. It has no participants and is tenant-visible
  (`conversationVisibility.ts:34`), so any member could copy it into an org
  Document. **Amended:** the actor must also be the owner (`meta.ownerUserId` in
  `subjectKeyForms(actor)`); an owner-less meta is `shared_conversation`.
- **B2 (D4).** Resume-append trusted the key alone. A caller reusing a key with
  different content would append foreign rows into an existing conversation.
  **Amended:** the id is `sha256(tenant | owner | key | digest(normalised turns))`,
  so a matching id implies identical content and resume is safe.
- **H1 (D9).** A single notice after the imported block does not say WHICH bubbles
  are imported. An imported assistant bubble carrying a link reads as a genuine
  agent reply. **Amended:** every imported message carries a visible "Imported"
  label; the notice stays.
- **H2 (D1).** Tombstones (`{"deleted":true}`, user deletes and DSAR erasure) are
  neither envelopes nor cards. **Amended:** `messageView` renders them as
  "message deleted".
- **H3 (D4/D5).** Two concurrent first imports race on the session row.
  **Amended:** a primary-key conflict on create is a replay. An existing meta whose
  owner is not the caller (e.g. `ERASED` after a DSAR) is a 409, never a write.
- **Filed, cross-feature:** DSAR leaves every conversation's **title**
  (`eraseSubjectConversations` anonymises the meta only), for every conversation
  type, not only imports (`CX2CD-R1`). A conversation share mint lets the owner
  publish other participants' words (`CX2CD-R2`, sharing).

## Alternatives

- **Strip the envelope at write time in the SPA:** this would change the chat
  store's contract for every consumer and break reopen fidelity. The renderer is
  the reader that was wrong.
- **An idempotency store keyed by caller:** this is a new subject-keyed store with
  its own eraser. A derived id gives the same guarantee with nothing to erase.
- **A `contentTrust` on Document provenance (ADR 0698 D3):** still filed. D8
  removes the cases where another person's words were the problem, and the
  importer's own words are theirs to publish to their org.
- **Accept the ChatGPT archive server-side:** files run to tens of MB and hundreds
  of conversations. Choosing one conversation client-side keeps every request
  small and lets the person pick.

## Implementation plan

| Phase | What |
|---|---|
| P1 | D1 renderer + share card; D7 typed parser errors |
| P2 | D2–D6 import (`host/chatAuthorSubject.ts`, scoped parser) |
| P3 | D8 helper + tool refusals + honest copy |
| P4 | D9 SPA (lazy archive picker, toasts, imported notice, filename, 4 locales) |

## Implementation record

| Phase | Commit | Witness |
|---|---|---|
| ADR + red probes | `9071227ca` | `test/chat-export-adr0992.test.ts` (17 of 18 red on `dde96ce72`) |
| P1–P3 backend | `b1ddba36a` | the same file; `import-parser`, `import-service`, `chat-export-route`, `transcript-renderer` updated |
| P4 SPA | `b9dedcddf` | `chatExportClient.test.ts`, `importedMessages.test.tsx`, `useConversationActionsImport.test.tsx` |
| Closing grades | `5f4001b26`, `301a3dbcd`, `199362ca9` | see below |

**Closing grades.**
- `/grade-ux`: B; CX2UX-1..10, all closed except CX2UX-2's "also next to New chat"
  (filed as R5).
- `/grade-code`: B+; CX2CD-1..9, all closed except CX2CD-8, batched appends (filed as R3).
- `/code-review`: no Blockers; CR-1 High and Mediums closed, CR-6 filed as R4.

**Sabotage witnesses.** 26 guards were each broken in turn, and the named test went
RED every time:
- S1–S20: backend (renderer, redaction, tombstone, closed envelope, role skip, author
  stamp, digest, 409, PK race, 10 MB parser, participant, owner, client, sole author,
  typed tool catch, timestamp clamp, typed parser error, meta-before-session,
  download header, share card);
- F1–F6: SPA.

The first pass found two guards with no witness: S11, the participant rule (it was
shadowed by the type rule), and S20, the share card. Both now have one.

**Entry chunk:** 657 B headroom on `origin/main` vs 651 B on this branch (+6 B). The
picker is lazy, and the copy lives in the per-locale i18n chunks.

**Residue (filed).**
- `CX2CD-R1`: DSAR leaves conversation titles, for every conversation type.
- `CX2CD-R2`: a share mint publishes group participants' words.
- `CX2CD-R3`: up to 2,000 sequential appends per import; add a batched storage append.
- `CX2CD-R4`: the scoped parser runs before auth.
- `CX2UX-R5`: offer Import beside "New chat", not only in a conversation's ⋯ menu.
- `CX2UX-R6`: `CompareView` (ADR 0117) renders raw stored envelopes; it should read
  rows through `parsePersistedMessages`.
- `CX2WF-2` / OQ1: model-context seeding.
- `CX2WF-3` / OQ2: the export-document tool is allowlisted nowhere.
- CXC-3 / OQ3: import quota.

## Post-deploy record

Merged as `af40fa07a` (#5312). It is live on Cloud Run revision `01067-5k8`
(`c743e7410`). The lead ran the read-only verification at 2026-10-28T03:34Z:
- anonymous callers and random conversation ids get the uniform 404;
- `Content-Disposition` is exposed;
- 0 ERROR log lines.

Prod usage at baseline was 0 imports, 0 transcript Documents and 0 conversation share
links, so there was nothing to migrate and the latent paths have no traffic yet. This
is not a usage pass.

The train 122 red came from a fixture that seeded an owner-less conversation, which
D8/B1 refuses by design. The fixture was fixed and the refusal kept (see the PR body
for the coverage rule).

## RFC verdict

No RFC. Host-extension routes under `/v1/host/openwop-app/*` and host-only rendering.
No wire shape, capability or event changes.

## Open questions

1. (CX2WF-2) Seed an imported or branched conversation's history into its first
   exchange, fenced and role-downgraded: the ADR 0117 refinement. This needs an
   exchange-fold owner.
2. (CX2WF-3) Allowlist `conversations.export-document` on a record-keeping persona
   (chief-of-staff). That is a pack decision, filed rather than made here.
3. CXC-3 per-caller import quota (ADR 0698 OQ2).
