# ADR 0588 — Board of Advisors: assessment remediation (ADVB / ADV-UX / WF-BOA)

Status: Accepted

## Context

Three single-feature assessments landed against the Board of Advisors
(`features/advisory-board` + the `@@`-summon chat lane) in #3397:

| Assessment | Grade | Gap ids | Blockers |
| --- | --- | --- | --- |
| `docs/steward/CODEBASE-ASSESSMENT.md` | **B** | `ADVB-1..9` | 1 |
| `docs/steward/UX-ASSESSMENT.md` | **C** | `ADV-UX-1..20`, `CT-ADV-1..9` | 5 |
| `docs/steward/WORKFLOWS-ASSESSMENT.md` | **C+** | `WF-BOA-1..12` | 3 |

Nine of those findings are one decision each and are recorded here. They divide
into four families, ordered by IRREVERSIBILITY rather than severity — a leak that
has already disclosed and a compliance record that cannot be reconstructed rank
above a missing retry button.

## Decisions

### D1 — The board's planning-context block is resolved PER CALLER, PER TURN (`ADVB-1`, Blocker)

`ConversationMeta.injectedContextBlock` was a rendered snapshot, taken once by
whichever `workspace:write` curator opened a **shared** boardroom, and served
verbatim to every later reader by `host/chatContext.ts`. Its sources are
readability-scoped per user — a `scope:'user'` strategy is creator-only, a
`private` project is member-only — so a `workspace:read` co-member's advisors
were grounded in planning content that co-member cannot see, and answered from
it.

**Decision:** the composer never reads the persisted snapshot. It calls the board
seam with `callerUserId`, which RBAC-filters for that caller, on every turn. This
is the shape the owner-KB leg twelve lines above in the same `Promise.all`
already used (`resolveSubjectAccess` → compose nothing on `'none'`); the fix is
to copy the sibling, not to invent anything.

**Rejected:** narrowing *who may snapshot* further. That is what the `GRADE-8`
comment did, and org `workspace:write` is simply not the same predicate as
`canSubjectReadStrategy` / `resolveProjectAccess` — it misses precisely where
they diverge. A predicate that is *usually* narrower is not an access control.
The comment now says what the narrowing actually buys (only a curator may update
the provenance record) instead of claiming a confidentiality property it never
had.

**Retained:** the snapshot is still written. It is the durable provenance record
of "what this room was told", which `ADV-UX-8/-9` want to surface. Because it is
now write-only from the model's perspective, `advisory-board-context-rbac.test.ts`
carries an **anti-rot arm** that reddens if the snapshot stops being persisted —
otherwise the leak assertion would silently become vacuous.

Cost: one extra resolve per turn, against a model call. Benefit beyond the leak:
revocation now takes effect on the next turn rather than never.

### D2 — Failed and empty are different answers at the board seam (`WF-BOA-2`, Blocker)

`resolveBoardContext` collapsed "the board has no context" and "the resolver
threw" into a bare `null`, and the `@@` lane passed that straight into
`markAsBoardGroup`, whose contract is `null ⇒ CLEAR`. A transient strategy-read
failure therefore **wiped** the room's snapshot — while the sibling canonical
lane 200 lines away passed `block ?? undefined` and its own comment called
`undefined ⇒ keep` "the SAFE direction". The correct answer was already written
down beside the wrong one.

**Decision:** the seam returns `{ block, failed }`. Both lanes now do
`failed ⇒ undefined` (keep) and `!failed ⇒ block` (a string sets, `null`
clears). The second half is the symmetric-pair obligation: `block ?? undefined`
also meant that removing every `contextRef` could never clear the room, so the
"safe" lane kept stale grounding forever. Fixing only the wipe would have
shipped half a pair.

### D3 — The `@@` attach lane gates on the board and derives the speak-set (`WF-BOA-3`, Blocker)

`POST /chat/sessions/:sessionId/board` validated `boardId` as a *string*, then
stamped it plus a caller-supplied participant list onto a durable conversation,
with no `getBoard` anywhere in the handler — falsifying the precondition
`resolveBoardStrategyContext` documents ("the convener already passed board RBAC
at the `@@` summon"). Blast radius, stated honestly: the conversation must
already be the caller's to manage and the block is still convener-filtered, so
this was fabricated board provenance plus a client-chosen RFC 0101 closed
speak-set, not a cross-tenant read.

**Decision:** a second seam registration, `BoardCohortResolver`, is both the
board-read gate (`null` ⇒ 404, no existence leak) and the server-side speak-set.
Core cannot import a feature, so the gate rides the same feature→core seam the
context resolver already uses, and it delegates to `resolveBoardAccess` — the
identical predicate ADR 0278's join gate uses, so the two lanes admit exactly the
same callers by construction rather than by agreement.

Deriving participants server-side also retires `WF-BOA-9`: the FE sent only the
advisors it managed to *activate*, so a truncated council was durably recorded as
the council.

### D4 — Degradation is disclosed, not discarded (`WF-BOA-4`, `ADV-UX-4`, `ADV-UX-9`)

`composeChatContext` computes a `degraded` ledger and `conversationExchange`
never read it, so an advisor whose persona missed or whose planning context
failed spoke **attributed** and the moderator synthesised over it. Three
disclosures, at three layers:

- `chatContext` records `board_context` when the resolve fails (an authz-denied
  compose stays silent — `degraded` is caller-neutral by contract);
- the canonical `…/chat` route reports `contextDegraded` on its response so the
  opener is told their planning context is stale, instead of only a server log;
- the browser cadence emits a system line naming who did not speak and whether
  the synthesis ran, instead of `cancel()`-ing in silence.

The `chatContext` disclosure is folded into the SCAFFOLD — the model is told what
it is missing — plus an `openwop-app.conversation.context-degraded` run event.
That is the XCH-GRP-1 pattern (`applyGroupRoomScaffoldNotice`): the notice is
derived from the ledger and nothing else, so the two cannot disagree.

**Recorded residual, named rather than smuggled:** this makes the ungrounded
voice able to SAY so; it does not put a marker on the durable TURN. The
`role:'system'` turn alternative was considered and rejected for this PR: the FE
transport currently DROPS system turns (`conversationTransport.ts:151`), so
rendering them is a chat-wide change that would also surface pre-existing
"Conversation closed." turns.

> **CORRECTION (M5, 2026-08-20) — the stated REASON was overstated.** This
> paragraph read: *"`ConversationTurn` is the RFC 0005 wire shape, so a per-turn
> `degraded` field is an RFC in `../openwop`, not host work."* Measured against
> the artifacts: `../openwop/schemas/conversation-turn.schema.json:116` declares
> `"additionalProperties": true`, and RFC 0005 §J:182 says turn-taking is *"host
> product policy (non-normative)"*. CLAUDE.md's own rule is that host-extension
> surfaces are non-normative and never need an RFC. So a NAMESPACED host-extension
> property on a turn is permitted by the schema as written; only a NORMATIVE
> field — one other hosts are expected to read, or that the conformance suite
> asserts — needs an RFC. The deferral still stands, but on its real grounds:
> a marker on a durable turn is REPLAYED verbatim on `:fork`, so it would assert
> "this turn was ungrounded" about a fork whose grounding is re-resolved fresh,
> and a value only this host writes and only this host reads is a private
> annotation dressed as provenance. Those are design objections, not a gate.
> Deferred as before; the reason is now the true one.

### D5 — The likeness acknowledgement is attributed, and is never inherited (`ADVB-4`, `ADV-UX-1`, `ADV-UX-2`)

Three compounding defects over the four advisors of the one `living` seeded
board:

> **CORRECTION (L6, 2026-08-20).** This line said "eight named real
> individuals". Verified against `origin/main`:
> `backend/typescript/src/host/seed-data/advisorAgents.json` ships EIGHT advisors
> across TWO boards, and `livingPersonaAck: true` appears on exactly one —
> `titans`, with four advisors (`elon-trask`, `geoff-bezor`, `steve-jobes`,
> `sam-oltman`). The other four are `timeless`, `personaKind: 'historical'`, no
> ack. The names are also deliberate pastiches modeled on real individuals, not
> the real names. Overstating a defect's blast radius costs the same thing as
> understating it: the number stops being checkable, and the next reader has to
> re-derive it. Corrected in all four places it was repeated
> (`advisoryBoardSeed.ts`, `service.ts`, `advisory-board-living-ack.test.ts`,
> here).

1. the seed shipped `livingPersonaAck: true` — an acknowledgement no human made;
2. adoption re-stamps `createdBy` while the ack re-read the existing `true`, so
   renaming a seeded board made you owner-of-record of it;
3. `personaKind` is an unvalidated board-level dropdown and `disclaimerFor`
   returned `null` for `original`/`fictional`, so a board of living-figure
   simulations set to "Original personas" shipped with no disclaimer **and** no
   acknowledgement — and the disclaimer had zero renderers under `chat/` anyway,
   which is the only surface where advice is read (ADR 0040:345 requires it "in
   chat + on the board").

**Decision:**

- `livingPersonaAck` gains `livingPersonaAckBy` / `livingPersonaAckAt`. An
  acknowledgement that cannot say who made it is not a compliance record.
- Adoption **drops** an inherited ack: a PATCH that re-stamps `createdBy` on a
  `living` board must carry an explicit `livingPersonaAck: true`, which the
  adopting user is shown. It is not carried forward from the seed.
- The seed no longer fabricates it. The seeded `titans` board is created
  unacknowledged and is **not convenable** until its owner acknowledges — the
  governance gate demonstrating itself, rather than being bypassed by the only
  cohort in the product that triggers it.
- `disclaimerFor` is total: every persona kind yields a disclaimer, because every
  advisor is a simulation. `original`/`fictional` get the weaker "simulated AI
  persona, not professional advice" line rather than `null`. Removing the null
  arm is what makes the unvalidated dropdown safe to leave unvalidated.
- The disclaimer is re-homed into the chat as a banner on any board conversation.
  It died with `host/advisoryBoardConvene.ts` in the ADR 0040 §Correction of
  2026-06-15 and was never re-homed.

**Un-fabricated, not merely stopped.** The seeder is idempotent by HANDLE, so
"the seed no longer writes the ack" would have helped only tenants seeded after
this change; every existing demo tenant would keep the fabricated record forever.
`clearFabricatedLivingAcks` runs on seed and removes it — narrowly: `living`
only, board still SEED-OWNED, ack unattributed or attributed to a `demo:` actor.
Those boards become unconvenable until their owner acknowledges. That is a
visible, one-checkbox-recoverable break, and the alternative is continuing to
serve a fabricated right-of-publicity record.

> **CORRECTION (H1, 2026-08-20) — "those boards become unconvenable" was FALSE
> for the one population that matters, and it was measured, not reasoned.**
> `assertBoardConvenable` had exactly two call sites (`routes.ts` `POST
> …/boards/:id/chat`, and `service.ts` `resolveBoardCohortForCaller`), and BOTH
> are room-CREATION lanes. Nothing on the TURN path checked it —
> `host/conversationExchange.ts`, `host/chatContext.ts`,
> `features/voice/realtime/routes.ts`. A tenant that had already opened the
> Titans boardroom kept a `type:'group'` conversation in the sidebar, still
> seated with its `agent:` participants, composing turns normally after the
> migration stripped the ack; `chatContext` even re-resolved its board block for
> it. Re-opening 422'd and attaching 422'd, but the room a click away did not
> care. **And that population is exactly the migration's target**: they could
> open the room *because* the seed fabricated the ack.
>
> Fixed by gating where the turn is COMPOSED: a third `BoardConveneGate` seam,
> registered beside the context + cohort resolvers, evaluated in
> `host/chatContext.ts` — the ONE composition owner, so text chat and realtime
> voice are both covered. `composeChatContext` REPORTS the refusal rather than
> throwing, because the exchange has already claimed its idempotency key by that
> point and must release it before refusing.
>
> **Considered and NOT done:** also removing the `agent:` participants from the
> board's canonical conversation, so the room is visibly emptied. The refusal now
> names its exit and the room is inert; mutating a shared conversation's roster
> from a boot migration is a second, riskier write that buys no additional
> safety, and re-acknowledging would have to re-seat it.

**What the migration actually meets in production (L5).** The two guards are each
witnessed (see § Open questions), but the row a pre-0588 demo tenant really
carries is `{personaKind:'living', livingPersonaAck:true, createdBy:'demo:…'}`
with **no `livingPersonaAckBy` at all** — the field did not exist when the seeder
wrote the ack. That shape is constructed by NEITHER guard arm and passes the
second by short-circuit (`b.livingPersonaAckBy &&` is falsy). Correct behaviour,
and it was untested, so nothing would have caught a "fix" that required the field
to be present. Now covered by its own arm in
`test/advisory-board-living-ack.test.ts`.

**Not done, deliberately:** no back-fill. For boards already adopted there is no
record distinguishing "the owner acknowledged" from "the seed did", and no later
change can reconstruct which. Writing `livingPersonaAckBy: <owner>` onto those
rows would manufacture exactly the fiction this ADR exists to stop. They keep a
bare `livingPersonaAck: true` with no attribution, which is *readable as*
unattributed — the honest state. See § Open questions.

### D5b — The chair is not a disputant, and the cohort fits its advertisement (`ADV-UX-7`, `WF-BOA-6`)

`CreateBoardInput.moderatorRosterId` existed; `UpdateBoardInput` omitted it and
no form ever set it, so `convene.ts` made `chairAgentId` the first ACTIVATED
advisor — a disputant writing the recommendation, contradicting both
`boardMentionTip` and the FEATURES.md row. The edit form now picks a chair.

**Where the guarantee actually lives.** "The chair is not a disputant" holds
because `planBoardroomTurns` filters `chairAgentId` out of the advisor rotation —
NOT because the picker restricts the choices. Stating that explicitly because a
reader of the original wording would expect the picker to be the enforcement, and
would then be surprised by a legal out-of-cohort chair.

> **CORRECTION (M3, 2026-08-20).** "drawn only from the picked cohort" was both
> the description and a defect. A board with `moderatorRosterId ∉ advisors` is a
> supported shape — `assertCohortSeats` budgets a seat for "a chair who is not
> one of them", and this ADR's own 9-seat test arm depends on it — but the option
> list was `roster.filter(m => picked.includes(m.rosterId))`, so such a chair had
> no `<option>`, the select displayed "No chair", and every save sent
> `moderatorRosterId: null` ⇒ `delete next.moderatorRosterId`. Renaming the board
> destroyed its chair, after the UI had misrepresented the saved value. The
> current chair is now always offered (labelled as out-of-cohort) and the field is
> sent only when the author moved it.

That constraint also closes `WF-BOA-6` at the source rather than by truncation:
`discovery.ts` advertises `maxParticipants: 8` describing "the advisory-board
cohort cap", but `LIMITS.advisors` capped the advisors ALONE while
`moderatorRosterId` was validated independently, so a board could seat NINE. The
8 was enforced only in `routes/multiPartyConversationSeam.ts` — a separate
in-memory map no board conversation touches, and the only thing the conformance
leg drives. `assertCohortSeats` enforces it where the cohort is actually built.

### D6 — Orchestrator-authored turns are marked as such (`ADV-UX-5`, `WF-BOA-8`)

The cadence's hand-off prompts went through `send()` and were durably persisted
as `role:'user'`, so the transcript recorded **the human** saying "As chair,
synthesize the board's perspectives into a clear recommendation." RFC 0101's
`speakerId` is explicitly meaningless for `role:'user'`, so a later reader, an
auditor, or a `:fork` sees the user's own words.

**Decision:** a non-content `orchestrated` marker on the turn, set by the cadence
and rendered as an orchestration line. It survives the merge (which rebuilds
every message from the wire, so an optimistic flag alone would be erased) via an
id set the transport re-stamps on each rebuild, and it persists because
`useSessionPersistence` serializes the whole message into the stored content
JSON — no backend change and no wire change. `ADV-UX-6` ships alongside: the
synthesis prompt now asks for agreements AND named dissents, per ADR
0040:100-102.

**Recorded residual (M6, 2026-08-20).** `chat/types.ts` documented the marker as
"persisted with the message, so a reopen, an audit, and a `:fork` all see it" —
contradicted by D4 above, in the same ADR. The marker rides
`useTurnTransport.persistTurns` into the CHAT-SESSION message rows and is restored
from them (`hooks/chatSession/lib.ts`), so **reopen** is true. It never touches
the RFC 0005 `ConversationTurn` (`host/conversation.ts`), which is what `:fork`
replays and what a server-side auditor reads, so **those two are not**. The
docstring is narrowed in place; putting the marker on the durable turn is the same
deferral as D4's residual, on the same grounds. Rider: `orchestratedIdsRef` is
never cleared on `/clear` or a session switch — its ids embed the runId so it
cannot mis-attribute across sessions, and it is now BOUNDED rather than growing
for the life of the mount.

### D7 — Dialog failures render inside the dialog (`ADV-UX-3`, Blocker)

Every create/save/**delete** failure routed to the page-level `Notice`, occluded
by the `ModalPortal` scrim and never announced. `ui/Modal.tsx` has shipped an
`error` slot for exactly this and neither call site passed it;
`ui/ConfirmDialog.tsx` did not forward it.

**Decision:** pass `error` at both call sites and forward it through
`ConfirmDialog`. One announcement per paint — `announce()` has a single polite
slot, so the dialog error announces and the page-level notice does not
double-fire.

## Consequences

- The per-turn resolve is one extra read on the chat hot path for board
  conversations only. `ADVB-6` (cap the composed block) becomes more valuable,
  not less; it is deferred, not retired.
- `POST /chat/sessions/:id/board` now 404s when the advisory-board feature is not
  registered. That is fail-closed and correct — there is no board to attach.
- Callers may still send `participants`; it is ignored rather than trusted.

## Deployment

The node pack is `feature.*`, vendored by `Dockerfile:145`, so pack content ships
on the next **backend** redeploy with no registry publish. The frontend changes
(`chat/conversations/*`, `features/advisory-board/*`) ride the **separate**
Firebase Hosting deploy — a backend-only redeploy does not ship them.

## Open questions

- [ ] `ADVB-4` residual: boards adopted before this ADR carry an unattributed
      `livingPersonaAck: true`. Deliberately not back-filled. An operator sweep
      that *re-prompts* those owners (rather than writing a name onto the row) is
      the only honest repair and is not built. An ADOPTED board is explicitly
      NOT un-fabricated: its ack may be fiction, but nothing distinguishes it
      from a genuine one, and deleting a possibly-genuine compliance record is
      the worse error. Adoption re-asks instead.
- [ ] `clearFabricatedLivingAcks`' two guards each needed a row shape that ADR
      0588 D5 makes UNCONSTRUCTABLE through the API, so both arms were vacuous
      until `__putBoardForTest` existed — measured, not assumed: dropping either
      guard left the suite green first time round. Both are now independently
      probed. The seam is test-only and called from no `src/` path.
      **Extended (L5, 2026-08-20):** the second guard's precondition
      (`livingPersonaAckBy && !isSeedActor(…)` — seed-owned AND human-attributed)
      really is unconstructable in-tree, because `updateBoard` re-stamps
      `createdBy` on adoption. But the row this migration MEETS in production is
      neither guard's arm: no `livingPersonaAckBy` at all, passing by
      short-circuit. That shape now has its own arm.
- [ ] `ADVB-2` — the injected block is still UNFENCED in the system prompt while
      its sibling `knowledgeBlock` parameter is BEGIN/END fenced. Unchanged here:
      it needs an explicit `contentTrust` decision on the resolver contract, not
      a blanket fence (a blanket fence is how a 172-site control was made inert
      once before).
- [ ] `ADVB-3` / `ADVB-5` / `ADVB-7` / `ADVB-8`, `WF-BOA-1` / `-5` / `-6` / `-7`,
      and the `ADV-UX-10..20` presentation sweep are recorded and deferred.
- [ ] D6 and D7 ship without automated arms. Both were verified by build +
      type-check + the existing 905-test frontend lane, not by a new assertion.
      D6's is the harder one and is worth writing: it needs the merge→persist
      round-trip, not a render check.
- [ ] The bundle budget is at **133090 B against 133120 B** (30 bytes). The entry
      had EIGHT bytes of headroom before this PR, so the next `ui/` change may
      still trip it. `check-bundle-budget`'s own contract ("when this is tight,
      CODE-SPLIT — do not raise it") is honoured throughout; the script's named
      next candidates are `src/chrome`, `src/notifications`, `src/agents`.

      > **CORRECTION (L1, 2026-08-20) — the JUSTIFICATION for lazy-loading
      > `BoardDisclaimerNotice` was false.** This entry claimed a static import
      > "pushed the entry over its gzip budget". Measured with the same
      > `zlib.gzipSync` the budget script uses: lazy = **133 099 B**, plain static
      > import = **133 108 B**, budget **133 120** — BOTH pass. The split buys
      > **9 bytes**, not compliance, because `advisoryBoardClient` is already
      > statically in the entry graph via `chat/conversations/convene.ts`
      > (`getBoardByHandle`, `ensureBoardChat`). The lazy import is KEPT — it is
      > real (a separate chunk is emitted, no static import anywhere) and
      > harmless — but "it did not fit" was not why. A budget claim that nobody
      > re-measures is how a code-split gets cargo-culted into the next feature.
- [ ] `WF-BOA-12` is cross-cutting orchestration debt, not this feature's: the
      pin-site ratchet resolves CALL SITES, so the in-tree definitions resolved
      by id at `host/index.ts:461-490` are structurally invisible to it. Routed
      to the Cross-Cutting collection; a ratchet leg over catalog-resolver
      returns is the fix.

## Implementation record

| Decision | Where | Witness |
| --- | --- | --- |
| D1 | `host/chatContext.ts`, `features/advisory-board/routes.ts` | `test/advisory-board-context-rbac.test.ts` (leak arm + anti-rot arm, both sabotage-probed) |
| D2 | `host/boardContextResolver.ts`, `routes/chatSessions.ts`, `features/advisory-board/routes.ts` | `test/advisory-board-summon-lane.test.ts` "failed ⇒ keep; honest empty ⇒ clear" |
| D3 | `routes/chatSessions.ts`, `features/advisory-board/service.ts` | `test/advisory-board-summon-lane.test.ts` (404 arm + IMPOSTOR speak-set arm) |
| D4 | `host/chatContext.ts`, `features/advisory-board/routes.ts`, `chat/conversations/useBoardroomCadence.ts` | `test/advisory-board-context-rbac.test.ts`, `chat/conversations/__tests__/cadenceHaltDisclosure.test.tsx` (**corrected 2026-08-20** — this cited `useBoardroomCadence.test.tsx`, which does not exist; the cadence's re-entrancy file is `useBoardroomCadence.reentrancy.test.tsx` and covers a different leg) |
| D4 | `host/chatContext.ts` (`groundingHonestyNotice`), `host/conversationExchange.ts`, `features/advisory-board/routes.ts`, `chat/conversations/useBoardroomCadence.ts` | `test/conversation-injected-context.test.ts` (degraded arm + "a healthy turn carries NO notice" anti-rot arm) |
| D5 | `features/advisory-board/{service,types}.ts`, `host/{advisoryBoardSeed.ts,seed-data/advisorAgents.json}`, `chat/conversations/BoardDisclaimerNotice.tsx` | `test/advisory-board-living-ack.test.ts` (7 arms) |
| D5b | `features/advisory-board/service.ts` (`assertCohortSeats`), `features/advisory-board/AdvisoryBoardPage.tsx` | `test/advisory-board-living-ack.test.ts` "rejects a 9-seat council" (with the 8-seat-succeeds arm) |
| D6 | `chat/types.ts`, `chat/hooks/chatSession/useTurnTransport.ts`, `chat/MessageBubble.tsx`, `chat/conversations/useBoardroomCadence.ts` | manual: no automated arm — see § Open questions |
| D7 | `features/advisory-board/AdvisoryBoardPage.tsx`, `ui/{Modal,ConfirmDialog}.tsx` | manual: no automated arm — see § Open questions |

### Review fold-in (2026-08-20)

| Finding | Where | Witness |
| --- | --- | --- |
| H1 — the likeness gate on the TURN, not just on room-open | `host/boardContextResolver.ts` (`BoardConveneGate`), `host/chatContext.ts`, `host/conversationExchange.ts`, `features/voice/realtime/routes.ts`, `features/advisory-board/{service,routes}.ts` | `test/conversation-injected-context.test.ts` — the already-open room is REFUSED (and the model is never called) + the acknowledge-and-speak exit arm. Sabotage-probed three ways: the gate call, the exchange refusal, the seam registration |
| M4 — a partially-resolved board context is reported | `features/strategy/strategyService.ts`, `features/projects/projectsService.ts`, `features/advisory-board/service.ts`, `host/{boardContextResolver,chatContext}.ts` | `test/advisory-board-context-rbac.test.ts` "names board_context_partial …" + the whole-before arm; the AUTHZ-silence half rides the existing ADVB-1 arm (probed by leaking authz drops into the count, which reddens it) |
| M1 — `contextDegraded` has a consumer | `features/advisory-board/advisoryBoardClient.ts`, `AdvisoryBoardPage.tsx`, `chat/conversations/convene.ts` | manual (both openers render/emit); the flag is now typed, so a silent drop is a type error |
| M3 — an out-of-cohort chair survives an unrelated edit | `features/advisory-board/AdvisoryBoardPage.tsx` | `features/advisory-board/__tests__/chairPreservation.test.tsx` (4 arms; the option-filter and the send-condition probed separately) |
| M2 — no raw i18n key reaches the user | `chat/voiceCtxLabels.ts`, `chat/ChatInput.tsx`, `chat/i18n/{en,es,fr,pt-BR}.ts` | `chat/__tests__/voiceCtxLabels.test.ts` (fallback arm + four-locale parity arm, probed separately) |
| L3 — the halt names the right surface | `chat/conversations/useBoardroomCadence.ts` | `chat/conversations/__tests__/cadenceHaltDisclosure.test.tsx` |
| L4 — the test seam names its seams | `host/boardContextResolver.ts` (`__resetBoardSeams`), `test/{voice-realtime,conversation-injected-context}.test.ts` | the rename is the fix; the leaked-restore is now in a `finally` |
| L5 — the production row has an arm | — | `test/advisory-board-living-ack.test.ts` "clears a seed-owned ack with NO attribution at all" |
| L2 / L6 / M5 / M6 / L1 | `chat/ChatSidebar.tsx`, `chat/types.ts`, this ADR | documentation + dedupe; see the correction notes above |

Three tests had PINNED the D1 defect as expected behaviour and were corrected,
not deleted: `conversation-injected-context.test.ts` (asserted the persisted
snapshot reaches the prompt), `voice-realtime.test.ts` (same, on the voice lane —
which composes through the same owner), and `strategy-board-showcase.test.ts`
(the seam's return shape). The voice pair's fail-closed arm was additionally made
non-vacuous: it now installs a resolver that WOULD serve the block, so the
visibility gate has to be what stops it.
