# ADR 1040 — Agent-scoped, persisted embedded chat; feature-registered focus kinds

Status: Accepted (openwop-app-88 for the requesting sessions, 2026-11-03); PR A in progress

## Context

Book AI (`/books/guide`) and KickTodo (`/guide`) both build an agent "guide" page
on the host's ONE chat (CLAUDE.md "AI chat — reuse, never recreate"; ADR 0073
`EmbeddedChatPanel`) with an agent whose tools are feature tools
(`registerFeatureAgentTool`). Their upstream requests (Book AI
`bookai/docs/upstream-proposals.md` P41 + P46, KickTodo relayed by
openwop-app-88, both 2026-11-03) name four host gaps:

1. **An embed cannot be a saved conversation.** `EmbeddedConversation` runs
   `useChatSession({ persist: false })`. A turn is saved, listed and reopenable
   only after the user clicks "Continue in full chat" (`promoteConversation`).
   The panel cannot open an existing conversation id.
2. **Nothing can list "this agent's conversations".** `GET
   /host/openwop-app/chat/sessions` has no agent filter, and the rows the
   embed's write-through would create (`ensureSessionInBackend`) carry no
   participants. `promoteConversation` stamps `agent:<id>`, and so does agent
   activation in the main chat (`ChatSidebar.tsx:688`, `TabSession.tsx:397`) and
   project membership (roster ids), but an embed never does.
3. **The embed's chrome is console wording.** The composer placeholder ("Type /
   for commands…") and the "Continue in full chat" exit are fixed;
   `renderEmptyState(onPick)` receives only the SEND callback, while the host's
   own welcome gets `fillComposer`, so an adopter cannot offer "fill the box"
   starters; and the turn receipt shows raw tool ids.
4. **A conversation can focus only a canvas.** `ConversationMeta.focus` is
   `{ kind: 'canvas' }` (ADR 0777; a builder workflow's binding is ADR 0773's
   pairing context, not a focus). A feature agent whose tools act on the
   feature's own entity (a book) cannot bind the conversation to it with a
   server-side read check. Book AI keeps a parallel `bookai:guide-binding`
   collection written by `beforeSend`, and wants to delete it.

Plus a full-page form of the same thing (P41 c): a conversation list with
search and "New chat", the conversation, and two adopter slots, scoped to one
agent.

What already exists and is reused, not rebuilt:

- **Backend-keyed sessions** (ADR 0140): `useChatSession({ sessionId,
  onSessionIdChange })` hydrates a known conversation from the backend, never
  touches the singleton localStorage slot, and re-keys on `reset()` and on a
  `not_found` load (`useSessionPersistence.ts` reset + not_found recovery), each
  of which eagerly creates the new row so a remount cannot loop.
- **Participant stamping at create**: `POST /chat/sessions` already accepts
  `participants` (`agent:<id>`), and `promoteConversation` already uses it.
- **Composer overrides**: `ConversationView` already takes
  `composerPlaceholder` and `composerModifiers` (ADR 0192 D8); the embed simply
  does not forward them.
- **The rail**: `ConversationsRail` already has title search, the ADR 0997 D5
  message search, rename, delete and "New chat".

## Wire check (step 3 of the brief)

Searched `../openwop` `schemas/`, `RFCS/`, `spec/` at `aebc4a84`:

- `ConversationMeta`, `focus`, `/chat/sessions`, the session list query and
  conversation participants appear in **no** schema and **no** RFC. Every route
  touched here is under `/v1/host/openwop-app/*` (a host extension, never wire).
  **PRs A, B and C need no RFC.**
- The one wire field this ADR touches is P6's `interrupt.resolved.resolvedBy`
  (`schemas/v2/run-event-payloads.schema.json`), a `$ref` to
  `subject.schema.json`: `kind ∈ {user, agent, anonymous, workload}`,
  `lane` from a closed enum, `additionalProperties: false`. See D6.

## Decision

### D1 — The embed can be a persisted, reopenable conversation (PR A)

`EmbeddedChatPanel` / `EmbeddedConversation` gain three props:

| Prop | Meaning |
| --- | --- |
| `persist?: boolean` | Default `false` (every current consumer is unchanged). `true` saves the conversation through the normal write-through, so it is listed and reopenable. |
| `conversationId?: string` | Open this existing conversation (backend-keyed hydrate, ADR 0140). Implies `persist`. |
| `onConversationId` (existing) | Already reports the session id on mount and on every change. It is THE "session id changed" callback; no second `onSessionIdChange` prop is added (one seam, not two). |

Mechanics, inside `useChatSessionCore` (no second session machine). A new
embed-only option `detached: true` means "persisted, but this hook is not the
singleton main chat and is never remounted by its own re-key":

- **Never the singleton.** `useCurrentCache = false`, the initializer starts from
  `freshSession()` (never `loadSession()`), and the IDN-11 auth-settle reseed
  (`core.ts:172-176`, which calls `loadSession()`) is skipped. Without this a
  detached embed would load the user's main chat when auth settles (review M1).
- **No eager empty rows.** In backend-keyed mode `reset()` and the `not_found`
  recovery eagerly create the new row (`useSessionPersistence.ts` reset +
  not_found), only because the tab deck remounts on re-key. A detached embed does
  not remount on its own re-key, so it skips both eager creates: the first send
  creates the row (the main chat's "an unused New chat never writes a
  messageCount:0 conversation"). Otherwise every "New chat" click or stale link
  would leave an empty agent-stamped row in the agent's list (review M2).
- **The opened id is frozen per mount (review B1).** `core.ts` recomputes
  backend-keyed mode from the `sessionId` prop every render, and the embed
  reports its minted id before any row exists. So a URL-syncing consumer (embed
  mints X → `onConversationId(X)` → consumer passes `conversationId=X`) would flip
  a fresh embed into backend-keyed mode, 404, re-key, and loop.
  `EmbeddedConversation` therefore keeps an outer "opened id" state, keys the
  inner session on it, and passes ONLY that frozen value to the hook:
  - a `conversationId` equal to an id the embed itself reported is ignored (no
    remount, no mode change, a live turn is never torn down);
  - a DIFFERENT `conversationId` becomes the new opened id and remounts;
  - `undefined` after a defined id remounts into a fresh detached session;
  - a different `agentId` remounts too (the stamp and scoping are per agent);
  - the change test compares the previous PROP value, never a first-run flag,
    which StrictMode's double effect run read as a change (grade-code M1);
  - a reopened conversation passes `isHydrating`, so it shows the loading state,
    not a new chat's empty state, while it loads (grade-ux UXG-1).
- `ContinueInFullChat` on a persisted embed still runs `promoteConversation`.
  *Correction during PR A (review minor 7 proposed navigate-only):* the
  write-through is best-effort, so a persisted embed's stored transcript can be
  partial, and the handoff's rule is that it never opens a partly written
  conversation. Promotion is idempotent (create 409 and message conflicts count
  as done), so the cost is one write per message on a click, and only when the
  consumer has not hidden the control.

### D2 — Persisted embed rows name their agent; the list can narrow to one agent (PR A)

- **Stamp.** A persisted embed's `ensureSessionInBackend` sends
  `participants: ['agent:<agentId>']` with the id as the consumer gave it, as
  `promoteConversation` already does.
- **Meta that already exists.** An ADR 0777 focus bind on mount creates the
  conversation's META before the first send, and `ensureConversationMeta` is
  create-or-return, so the stamp would be dropped. And the two writers race:
  `setConversationFocus`'s create branch is a plain `put` that can overwrite a
  row `ensureConversationMeta` just won by CAS (review M3). Decision:
  - `setConversationFocus` and the participant union are CAS retry loops (the
    GRADE-D6 pattern `ensureConversationMeta` already uses);
  - `POST /chat/sessions` on an existing meta: same owner → union the requested
    `agent:` participants (agents only, never users); a DIFFERENT owner → `409
    conflict`, never a 201 that silently adopts someone else's meta (review M4).
- **Filter.** `GET /chat/sessions?agentId=<id>` applies AFTER the existing
  visibility and rail-listing filters (ADR 0043 P6 / 0054 / 0195). It can only
  remove rows. A row matches when one of its `agent:` participants is the same
  agent under any spelling:
  - ADR 0763 spellings: both sides through `agentStorageId` (never raw `===`);
  - roster vs registry id (*corrected in PR A, grade-code M2*): a ROSTER id
    names one persona and matches only conversations stamped with it; its
    sibling personas of the same registry agent are other "Kickbots", and a
    bare registry stamp does not say which persona spoke. A REGISTRY id names
    the agent: its stamps under either spelling plus EVERY roster persona that
    instantiates it, from one roster read per request (not the reverse index's
    first entry or its 30 s cache; review minor 3).
  - An unknown agent id matches nothing: `200 { sessions: [] }`.
  - A non-string or > 200-char value is `400 validation_error`.
  - **Intended:** a main-chat conversation in which the user activated this agent
    is also "this agent's conversation" and is listed (review minor 1).
  - **Not stamped:** a conversation created elsewhere without the agent (e.g. in
    the full chat) and later opened through `conversationId` is not re-stamped,
    so it does not appear under `?agentId=` (grade-code minor 3).
- One predicate, `conversationHasAgent(meta, matchSet)` in
  `host/conversationAgentFilter.ts`. PR C's search narrowing calls the same one.

### D3 — The embed's chrome is the consumer's (PR A)

- `composerPlaceholder?: string` and `composerModifiers?: ReactNode` forward to
  `ConversationView` (which already supports both).
- `hideContinueInFullChat?: boolean` removes the console exit. An agent page that
  IS the full experience for its agent has nowhere better to send the user.
- `renderEmptyState(send, actions)` — the existing first argument stays the SEND
  callback (every existing `renderEmptyState` consumer keeps working), and a
  second argument `actions: { fill(text), send(text) }` adds "fill the composer".
  The full chat's `WelcomeCard` keeps using `fill`.
- `toolLabels?: Readonly<Record<string, string>>` — display names for the turn
  receipt's tool rows, provided through a chat-local React context
  (`ToolLabelsContext`) rather than drilled through
  `ConversationView → MessageFeed → MessageBubble → TurnReceipt`. DISPLAY ONLY:
  `GET /chat/tool-effects` and its `toolName` join key are unchanged, and an
  unlabelled tool still shows its id. A label lives with the embed that asked for
  it; the same tool in the main chat still shows its id. A label on the tool's
  registration is a possible follow-up, not this ADR (review minor 9).
- New strings land in all four locales.

### D4 — Feature-registered conversation focus kinds (PR B)

```ts
registerConversationFocusKind({
  kind: 'bookai.book',     // `<featureId>.<entity>`; 'canvas' is the host's own
  featureId: 'bookai',     // optional: the toggle checked at bind AND per call
  label: 'book',           // a noun for errors, never an id
  authorize: (scope, id) => Promise<boolean>,
});
// scope: { tenantId, actingUserId, personalTenant? }
```

- **Registration.** A kind other than the host's `canvas` must contain a dot
  (`<featureId>.<entity>`); a duplicate kind throws at registration.
- **Bind.** `PUT /chat/sessions/:id/focus` accepts `{ kind, id }` only for a
  registered kind (else `400 validation_error`). Order: acting user → caller may
  see the conversation (an existing META, or else an existing session ROW, so a
  row without meta is not claimed by a stranger: review M4) → caller may MANAGE an
  existing meta (`requireManageAsync`, so a participant cannot re-point the
  owner's tools to another entity: review M5) → not a channel → the owning
  feature is on (`featureAccessRefusal`) → the kind's `authorize`. A refusal of
  the entity is the existing uniform `404` and nothing is stored. DELETE takes the
  same manage gate.
- **Every tool call re-checks, including model-supplied ids (review B2).**
  `resolveAuthorizedFocus(scope, kind, explicit?)` in `host/conversationFocus.ts`
  replaces `resolveFocusedId`, whose `if (explicit) return explicit` let a model's
  id through unchecked. The new helper:
  - takes the candidate id (the explicit one, else `meta.focus` read fresh);
  - returns `undefined` without an `actingUserId` (`orgScopeSubject` turns,
    system turns), when the owning feature is off, or when `authorize` returns
    false or throws;
  - runs every call, with the CALL's scope. A check at bind is never trusted again.
- **Reaching `AgentToolCallScope`.** The scope already carries `conversationId`
  and `actingUserId` through `createScopedAgentToolProvider` (ADR 0324) to every
  transport. The helper takes that scope, so the focus needs no new field that
  could go stale. A precomputed `scope.focus` would be the check-once shape this
  ADR forbids. Voice gets it only where its session has a conversation id, which
  is when a session row exists (`voice/realtime/routes.ts:146-147`); an ephemeral
  embed's voice session has no focus (review minor 4).
- **Whose identity.** Bind and tool calls both see `req.userId ??
  req.principal?.principalId` (`chatSessions.ts:91-93`, the run's actor stamp in
  `runs.ts`). PR B pins that the two spellings agree for a session user AND a
  bearer lane. In a shared conversation, `authorize` runs as the run's acting
  user, not whoever spoke last (review minor 2).
- **Canvas becomes a registration** of the same seam (`authorize =
  getCanvasForCaller(...) !== null`). CAD's tool moves to the helper and keeps its
  own `getCanvasForCaller` (defence in depth).
- **Workflow stays out.** ADR 0773's `PairContext` is a pairing context: it
  carries the builder's live draft state, not just an entity id, and ADR 0777
  §Correction already ruled it is not a focus. It stays separate; merging it is
  not in scope (review minor 11).
- **Model text.** No focus id is added to any prompt.
- **Replay/fork.** Unchanged from ADR 0777: focus is a tool DEFAULT read at call
  time, and a recorded tool result is replayed, not re-executed.
- **Existing, not changed here:** the mount-time focus PUT of an EPHEMERAL embed
  writes a meta for an id that may never get a session row (review minor 10).
  Persisted embeds make that row real; the ephemeral case is left as ADR 0777
  shipped it.
- FE: the `focus` prop widens to `{ kind: string; id: string; label: ReactNode }`.

### D5 — A mountable, agent-scoped full-page chat (PR C)

**Why not deep-link the main chat (`/?agent=`), the CLAUDE.md default (review
M9).** Book AI's `/books/guide` and KickTodo's `/guide` are site-tier pages in
the adopter's own chrome. The console chat is a workspace page with the console
around it, and its list is every conversation the user has. A deep link moves
the user out of the product they are in. What the page needs is the same
conversation, mounted in the adopter's page, listing only its agent's
conversations. So it is built from the existing parts, and it says what it
leaves out: its submit path is the embed's core subset (`runCoreSubmit`: command
→ /workflow → @agent → send), with no project convene and no `@@` board
cadence. That is intended for a single-agent page; a user who needs those uses
the main chat.

`AgentChatPage` is a COMPOSITION, not a third chat surface:

```
<AgentChatPage agentId=… title? leftFooter? rightRail? renderEmptyState?
               onManageProvider? byokFallback? composerPlaceholder? toolLabels? />
  ├─ ConversationsRail     (existing; list = useChatSessions({ agentId }))
  │    └─ leftFooter slot
  ├─ EmbeddedChatPanel     (existing; persist + conversationId, D1)
  └─ rightRail slot
```

- **List.** `useChatSessions` takes an optional `agentId` and forwards
  `?agentId=`. With `agentId` set it never falls back to the local session index
  on an empty or failed list (`useChatSessions.ts:136-140` reads every local
  conversation), so an agent with no conversations shows none (review M6). The
  page refreshes the list after a first send creates a row, as `ChatSidebar.tsx`
  does, because `ensureSessionInBackend` broadcasts nothing.
- **Rail changes are additive only:** `onOpenWorkspace` becomes optional (the
  Workspace button hides). `onClose` stays required and the page supplies it
  (the narrow-screen drawer). Channel affordances are already optional and are
  not passed.
- **Search narrows BEFORE the candidate cap (review M7).** `MessageSearchResults`
  forwards `agentId`; the search route (GET and POST) narrows its visible
  conversation ids with D2's predicate before `searchEngine`'s `CANDIDATE_LIMIT`,
  so agent-scoped results are neither empty nor truncated by other agents'
  conversations.
- **BYOK gate.** The conversation renders through `EmbeddedChatPanel`, so
  `byokFallback` (sign in / activate) replaces it exactly as in the panel,
  distinct from `renderEmptyState` (KickTodo requirement 2). A signed-out caller
  sees the fallback alone, with no rail.
- **Title.** `title?: ReactNode`; the default is the agent's display label from
  the same `useAgentMentions` catalog the composer uses, which for a roster entry
  is the user's label, not the pack persona (KickTodo requirement 1).
- **Reviews.** Feature review cards render through the same
  `ConversationReviewsStrip` / review-card path. **Dependency:** ADR 1031 is not
  on `main` at `17f0acf40` (P1 #5495 open, P2 #5502 draft). PR C tests a
  first-party review renderer in the page and adds the ADR 1031 P2 hook case
  once #5502 is on `main` (KickTodo requirement 3; review M8).
- **Public entry point** (KickTodo requirement 4):
  `frontend/react/src/chat/public.ts` exports `EmbeddedChatPanel`, a LAZY
  `AgentChatPage` wrapper, and their prop types. An adopter feature imports only
  this module. `chat/` is not a `features/<id>` package, so
  `check-feature-import-boundary` does not flag it, and once ADR 1031 P1 lands
  adopter feature code is outside that gate. Adopter `routes.tsx` is eager (ADR
  1031 §P1), so a ratchet pins that `chat/public.ts` reaches the page only
  through `lazy()`, keeping it out of the entry chunk (headroom ~1.3 kB).

If composition proves impossible without forking `ChatSidebar` or
`ConversationView`, PR C stops and reports instead of forking.

### D6 — P6: who resolved an interrupt on the token lanes

The brief recommends `resolvedBy = { kind: 'capability', tokenId, mintedBy }`.
**That value is not a valid wire Subject**: `subject.schema.json` closes `kind`
to `user | agent | anonymous | workload`, requires `issuer`, `tenant` and `lane`
from closed sets, and forbids extra properties, so a schema-validating reader
would reject the event. A `capability` kind is an RFC 0170 change in
`../openwop`, not host work.

Read against the code, "the capability-token lane" is three different callers:

| Caller | Today | Decision |
| --- | --- | --- |
| An env API key (`principalId: bearer:<8>`, `auth.kind: 'env-key'`) on the authenticated resolve route | `deriveReviewer` (`interrupts.ts:1223`) drops the Subject it computed | Carry `requestSubjectV2(req)` (the workload Subject the run-owner stamp uses for this lane) alongside `capabilityToken`, keeping every `capabilityToken` branch (`:1619`, `:1623`, `:1773`) as is. Ships in PR B. |
| A URL resume token whose body carries a `voter` with a verified emailed signature | absent | **Filed, not built.** The voter is the email's `recipientUserId`; a Subject needs an issuer and lane that a request-less mapping would have to invent, and the link can be forwarded. |
| A bare URL resume token, no voter | absent | Stays absent. The token proves possession, not identity (ADR 0932 D2). Recording the minter would name a person who did not act. A `capability` Subject kind is filed as an RFC 0170 proposal. |

"Never null" holds: the field is absent or a valid Subject.

### D7 — P47 chat formats (later phases: PR D = F1 + F2, PR E = F3 + F4)

Book AI's P47 (relayed 2026-11-03; KickTodo may adopt F1 and F2). None starts
before PR A's head is frozen. **Each opens with a wire check** against
`../openwop` (RFC 0064 tool-return, interrupt payloads, the approvalGate config
schema). If a field would ride a wire event, the phase stops and reports; only a
host-only render seam proceeds.

- **F1 — feature wording on the inline approval card (PR D).** The gate config
  gains `actionLabels` (i18n keys) and a prompt, mapped onto the EXISTING verbs
  (accept / refine / reject …); ADR 0600 semantics are unchanged. A gate may mark
  reject as an expected decline, which gets a gentler confirm. Today:
  `chat/registry/defaultCards.tsx` (~:95 the card, ~:140 the reject confirm).
  Wire check: is approvalGate `config` wire-visible?
- **F2 — inline result card for a finished run (PR D).**
  `registerRunResultRenderer({ match: chain origin | output artifact type,
  Component })`, rendered under `WorkflowRunBubble`; no match keeps today's
  one-liner. A renderer reads outputs only through the authorized run-read path
  the side panel uses.
- **F3 — per-call display summary on receipt chips (PR E).** A tool may return an
  optional `display.summary`: plain text, host length cap, never args or results,
  sanitized (no markup). It must NOT ride the RFC 0064 tool-return event (this
  host never sets `outcome`, and adding a payload is an RFC change); PR E finds a
  host-side channel or stops.
- **F4 — feature links in assistant markdown (PR E).**
  `registerChatLinkResolver(scheme, resolve(id, ctx) → in-app route | null)`,
  resolved per viewer with an authorization check. Unknown, unauthorized or
  erroring links render as plain text; no `javascript:`, `data:` or external
  redirect, in-app routes only. Each refusal is sabotage-witnessed.

## Alternatives weighed

- **Deep-link `/?agent=` instead of a page (CLAUDE.md's default).** See D5: it
  leaves the adopter's product and lists every conversation.
- **A new `AgentChat` component with its own session hook.** Rejected: it is the
  second chat CLAUDE.md forbids and the `AiAuthorPanel` precedent removed.
- **Persist every embed by default.** Rejected: ADR 0768 P4 keeps builder, CAD
  and commerce embeds out of the rail; `persist` stays opt-in.
- **Filter by agent on the client.** Rejected: the list is visibility-filtered on
  the server, and a client filter would fetch every conversation to show a few.
- **A per-feature binding table (Book AI's `guideBindings`).** That is what
  exists and is the parallel state P46 retires.
- **Checking focus once at bind, or a precomputed `scope.focus`.** Rejected:
  access can be revoked after bind.

## Phases

| Phase | PR | Content | Sabotage-witnessed tests |
| --- | --- | --- | --- |
| A | PR A | D1, D2, D3 | the agent filter never returns another user's session; a URL-syncing consumer under StrictMode causes no GET on an unminted id, no mode flip, no extra create; no main-chat reseed into a detached embed; concurrent focus bind + create keep the stamp; a foreign-owned meta gets 409 |
| B | PR B | D4 (+ canvas registration, CAD on the helper), D6 row 1 | unregistered kind refused; unauthorized entity refused on bind; a tool call after revocation reads nothing; a model-supplied id the caller cannot read reads nothing; a participant cannot re-point focus; bind and call identity agree |
| C | PR C | D5 + `chat/public.ts` | no local-index fallback when filtering by agent; search narrows before the candidate cap; a review card renders in the page; `chat/public.ts` stays lazy |
| D | PR D | D7 F1 + F2 (after A is frozen; wire check first) | each new renderer reads only through the authorized run-read; label keys never change the decided verb |
| E | PR E | D7 F3 + F4 (wire check first) | a summary carrying markup is stripped; nothing reaches the tool-return event; each link refusal (unknown, unauthorized, throwing, `javascript:`, `data:`, external) renders plain text |

Each PR is branched from `origin/main`; none is stacked.

## Architect review (independent, pre-code)

An independent `/architect` pass (2026-11-03) found 2 Blockers, 9 Majors and 11
Minors in the first draft; every one is folded in above (cited inline as
"review B1/M1/minor N"). It confirmed: `persist:false` in the embed; creates via
`ensureSessionInBackend` carry no participants; `ensureConversationMeta` is
create-or-return; `ConversationView` already supports the composer overrides;
`promoteConversation` is idempotent; the scope composer is shared by chat and
voice; CAD re-checks the canvas; and D6's schema reasoning.

## Decisions (2026-11-03, openwop-app-88)

- [x] D1 reuses `onConversationId`; no `onSessionIdChange` prop. Book AI and
      KickTodo are told.
- [x] D3 `renderEmptyState(send, { fill, send })`.
- [x] D6 accepted as written. **Correction:** the brief's
      `{ kind: 'capability', tokenId, mintedBy }` is not a valid v2 Subject (see
      D6). Row 1 ships in PR B; row 2 is a tracker row; the `capability` Subject
      kind is a steward note only (filing upstream is the user's call).
- [x] D5: PR C is built now and tests a first-party review renderer; the ADR
      1031 P2 hook test is a follow-up once #5502 merges.

## Finding: the explicit focus id is not a live bypass (2026-11-03)

`resolveFocusedId` passes a model-supplied id through unchecked
(`host/conversationFocus.ts:24`), but on `main` `17f0acf40` its only caller,
CAD `get-design`, re-applies `getCanvasForCaller` and the CAD type pin to the
resolved id, and `cad.render` checks `getCanvasForCaller` + `canvasWriteAllowed`
on an explicit id. A witness test (a reader without access passes the id
explicitly, with and without a conversation) passes on unmodified source and
goes red when `get-design` reads through `getCanvasForTenant` instead. The fix
(D4 re-authorizes explicit ids in the helper itself) therefore stays in PR B,
with that test.
