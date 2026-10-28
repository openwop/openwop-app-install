# ADR 0986 — Evals leaderboard: rank what really answered, bind arena verdicts to real runs

Status: implemented (2026-10-27: merged #5282 `b61d48366`, live at `dde96ce72`, rev `01059-z8l`). Accepted 2026-10-26 after the adversarial `/architect` pass: 2 Blockers, 4 High, 6 Medium and 8 Low folded into D1–D7; see § Architect pass.

Feature loop round 2, row 59 (Evals leaderboard: `evals`). Amends ADR 0123 (the leaderboard and
arena), ADR 0071 (message feedback) and ADR 0700 D1 (arena rating CAS). It reads RFC 0005 turns
and leaves them unchanged. It is host-only: no wire change, no new RFC, and nothing new is
advertised. RFC 0109's optional `agent.model` turn provenance is left exactly as it is.

## Context

Round 1 closed this row at B / — / — (workflows only). ADR 0700 fixed the arena's lost updates
(`EVC-7`), and `EVC-1`/`EVC-2` were closed before that. `EVC-3`/`EVC-5` (verdicts not bound to runs)
were left open.

**Prod, read-only, 2026-10-26:**

- 0 `chat:message-feedback` rows ever, 0 arena matches and 0 arena ratings.
- 57 chat sessions, and 397 conversation runs in the last 30 days.
- `chat_messages` holds 62 assistant rows. **None carries `meta.model`, and none has a
  conversation-turn id.** The ONE chat's turns live in the run's event log
  (`conversation.exchanged`). Their ids are `runId:gate:0:N:agent`, and the append route's id
  pattern refuses `:`.
- Only **43 of 634** agent turns carry RFC 0109 `agent.model` provenance. 467 have no `agent` at
  all, because the 1:1 chat resolves no agent, and 124 have an agent but no resolved model (the
  managed tier picks the model inside the dispatch).
- 0 run events in a conversation run carry a model.

Nobody has used the feature, so nothing below migrates a row. But **the feature cannot produce a
single row today** (EV2-1), and its two inputs can be forged (EV2-2, EV2-4).

Ten probes, all red on `f3a80dd9e` (backend `test/adr0986-evals-leaderboard.test.ts`, frontend
`features/evals/__tests__/adr0986-evals-ux.test.tsx`):

1. **EV2-1 — a rating on a real chat turn never reaches the board.** `routes.ts`
   `metaModelResolver` reads `meta.model` from `listChatSessionMessages`, a table the conversation
   transport never writes for a turn (see the prod numbers above). Every rating of the ONE chat is
   "unattributable" and silently dropped. The empty state then tells the admin "No rated turns
   yet", which is false once anyone has rated.
2. **EV2-2 — attribution is client-authored.** `POST …/chat/sessions/:id/messages` stores any
   `meta`. A member appends assistant rows with `meta.model:"forged-model"`, thumbs each one up,
   and that model tops the admin leaderboard. Each new row is one more vote, with no bound.
3. **EV2-3 — the thumbs "Elo" is a function of storage order.** `computeEloRatings` plays every
   vote against a fixed anchor in list order. The list is `listByPrefix` order, which is
   `conversationId` lexical order, not time. The same votes stored under different conversation
   ids produce a different number, and that number is the headline column and the default sort.
4. **EV2-4 — an arena verdict needs no runs.** `POST …/arena/match {modelA, modelB, winner}` is
   accepted with two arbitrary strings.
5. **EV2-5 — verdicts never reach the leaderboard.** Arena Elo lives in `evals:arena-rating`
   and is read only by `GET …/arena/rating`, which has no frontend caller. The page shows the
   result once, in the arena, and it is never seen again.
6. **EV2-6 — the verdict names whatever models the client says.** Nothing ties `modelA`/`modelB`
   to what answered.
7. **EV2-7 — the same comparison counts twice.** The idempotency key is a `randomUUID()` minted
   per request, so it never matches: a retried POST is a second verdict.
8. **EV2-8 — another member's runs can be voted on.** No run is read, so no owner is checked.
9. **EV2-9 — DSAR erasure leaves the rater on every match.** `evals:arena-match.raterSubject`
   has no eraser. The ADR 0464 feature-store gate binds only `userId:` fields, so it cannot see
   this one.
10. **EV2-UX-1/2/3 — the arena is unreachable, not blind, and its results go nowhere.**
    - The Models console is the only nav entry. Embedded there, the page drops its `PageHeader`,
      which held the only arena link (`LeaderboardPage.tsx`, `embedded ? null : …`). The
      standalone `/leaderboard` path belongs to `kicktodo-engagement` (ADR 0718 D1).
    - While you vote, each pane's header names its model, and the vote posts names, not runs.
    - The board has no arena standings and no count of the ratings it could not attribute.

A side finding outside this row: `TurnReceipt` and `chat/lib/cost.ts` read `meta.provider/model` on
assistant bubbles, and the conversation transport never sets them. Per-turn receipts and cost are
dead on the ONE chat for the same reason as EV2-1 (residue R1).

11. **EV2-10 — the arena never dispatched the models it named.** *(Found by the architect pass, B2.)*
    `ArenaPage` opened each pane with `{provider, model}` and no `credentialRef`. `dispatchReply`
    defaults the ref to `managed:openwop-free` (`dispatchTurn.ts:260`), and the managed branch
    ignores the picked target. So both panes were the same managed model under two labels, and
    every verdict compared a model with itself.

> **Correction (architect pass, 2026-10-26).** Finding 1's parenthetical "none has a
> conversation-turn id" describes the prod rows, not the code. The SPA keys a turn's bubble, its
> durable row and its rating on `conversationMessageId(wireId)` (`chat/hooks/chatSession/lib.ts`):
> the wire id with `:` sanitised to `_`, and hashed past 64 characters. That is the id a rating
> carries, so D1 keys on it (B1). Finding 9's "the gate binds only `userId:`" is also too narrow:
> the gate binds a dozen subject signals. `raterSubject` matches none of them, so the conclusion
> stands.

## Decision

### D1 — The host records which model answered each turn, at the exchange

A new core store, `host/turnAttribution.ts`: `DurableCollection<TurnAttribution>('chat:turn-model')`,
keyed `${tenantId}:${canonicalMessageId}`. It has no tenant index (M2): every read is a point get,
and the `${tenantId}:` key prefix still reaches tenant teardown. One row per agent turn that is a
model reply:

```ts
interface TurnAttribution {
  tenantId: string;
  messageId: string;      // the CANONICAL id the SPA rates: conversationMessageId(wireId)
  wireMessageId: string;  // the RFC 0005 turn id
  runId: string;
  chatSessionId?: string; // run.metadata.chatSessionId at exchange time
  provider: string; model: string;
  managed?: true;         // a managed TIER, not a model (H1)
  at: string;
}
```

- **The id is the one the SPA rates (B1).** `conversationMessageId` moves to a backend twin,
  `host/conversationMessageId.ts`. A parity test runs one fixture list, including a >64-character
  id, through both functions.
- **Written only at the main exchange site** (`conversationExchange.ts`, the `role:'agent'` turn
  built from `completion`), after `persistExchangedPair`, on both the sync and the async-flag
  paths. The write is **awaited inside try/catch**: a failure logs `turn_attribution_write_failed`
  and never fails the turn. Turns that have no answering model write nothing and are
  unattributed by design (H2):
  - the deep-investigation pointer (`{kind:'workflow_run'}`);
  - RFC 0239 council turns, which are client-authored;
  - `workflow_run` dispatch turns;
  - no-contribution turns;
  - channel or scheduled `agentRunnerNode` replies;
  - voice-sideband rows.
- **What answered, never what was asked for.** `dispatchReply` and the tool loop return
  `served: {provider, model, managed?}` from the branch that dispatched:
  - BYOK: `dispatchedModel` after the bump fallback.
  - Tool loop: `modelUsed`.
  - Copilot, subscription, compat endpoint: what was sent. The subscription branch uses
    `'subscription'`, its usage label.
  - Managed: `ManagedDispatchResult.provider/model`, which is the user-facing tier id by design
    (`managedProvider.ts:496`). It is recorded with `managed: true`, and the page labels the row
    a tier, not a model (H1).
  - **Mock writes a row only when `mockProviderEnabled()`** (H4). The exchange's mock branch
    does not consult that switch today (residue R4), so the attribution must.

  There is **no fallback to `resolveModelProvenance`**: that names the requested target, which
  for managed is not what answered. No `served` value means no row.
- **Retention:** `registerKvAgeOut` 180 days on `at`. A rating stamps its attribution at write
  (D2), so it does not need the row afterwards. The row holds no subject data (ids, provider,
  model, time), so it is `REVIEWED_EXEMPT` in `subject-erasure-coverage.test.ts`.
- **Replay and fork (H3, corrected):** the row is written only by the live exchange, and replay
  never calls it. **A fork copies event payloads verbatim** (`runs.ts:2107`), so a forked run's
  turns keep the source's message ids, and would resolve to the source's rows. Every consumer
  therefore checks that the row's `runId` is the run it is asking about (D2, D4).
- **No wire change.** RFC 0109 `agent.model` is untouched, and this store is never served on a
  run or turn read.

### D2 — A rating is attributed by the server when it is recorded, and only then

`POST …/chat/messages/:messageId/feedback` keeps its contract: a visibility-gated, per-user rating
that accepts any message id. It now also stamps `attribution: {provider, model, managed?}` and
`runId` on the row, when a `chat:turn-model` row exists for `(tenant, messageId)` and **either**:

- its `chatSessionId` equals the request's `conversationId`, **or**
- it has no `chatSessionId`, and the conversation's bound run (`getConversationMeta(…)
  .conversationRunId`) equals the row's `runId`. This is the M3 path for older SPA builds,
  which bound runs without stamping them.

A rating is never attributed from `chat_messages.meta`, from the body, or from another
conversation's turn. A branched session's copied messages get fresh ids, so they are
unattributed. That is honest: nobody rated what answered there.

The leaderboard reads stamped rows. For an unstamped legacy row it tries the same lookup once,
with bounded concurrency. The old `metaModelResolver` and its N+1 over `chat_messages` are
deleted. Every row that still has no attribution counts in `coverage.unattributed`.

### D3 — The thumbs board ranks by a lower confidence bound, independent of order

- `combineLeaderboard` replaces the anchored Elo with `score`, the Wilson 95% lower bound of
  `up / (up + down)`. It is defined as 0 when there are no decisive votes.
- **Sort order:** score, then `up` (more first), then `down` (fewer first), then the
  `provider/model` key. The `up` and `down` tiebreaks (L1) keep a 0-up/5-down model below an
  unrated one.
- **Per-rater weight (M5):** one rater's decisive votes on one model weigh at most 10 in the
  score (scaled proportionally). The displayed counts stay raw, and every row carries `raters`
  (distinct).
- It is a pure function of the counts, so storage order cannot move it. Rows are keyed
  `provider/model` and carry both fields, plus `managed` and `simulated` (mock). `elo.ts` is
  deleted.

### D4 — An arena verdict is two real runs the rater owns that answered the same prompts

`POST …/arena/match` takes `{runIdA, runIdB, winner}`. `modelA`/`modelB` in the body are ignored,
and a body without both run ids is a 400. The service checks, in order:

1. **Ownership.** Each run exists in the tenant and is an `openwop-app.conversation` run.
   Its `metadata.actingUserId` must equal the caller under the run stamp's own derivation:
   `req.userId ?? principal`, or the canonical `user.userId` (M4). Otherwise the uniform 404,
   so another member's run reads as absent.
2. **Same prompts.** The run's conversation id comes from its `conversation.opened` event, not
   recomputed (H3). Its user turns, read through `loadTurns`, compared as canonical JSON of the
   content (L3, so parts count), are the same non-empty sequence in both runs. Otherwise 409
   `arena_prompt_mismatch`.
3. **Attributed replies.** Each run's model-reply agent turns each have a `chat:turn-model` row
   whose `runId` is that run (H3), and all of a run's rows name one model. Missing → 409
   `arena_unattributed`; mixed → 409 `arena_mixed_models`.
4. **Different models.** The two `provider/model` keys differ. Otherwise 409
   `arena_same_model` (L4).
5. **Rater cap.** The EVC-2 cap of 8 per (rater, model) still holds. Its check-then-act race
   across two concurrent DISTINCT pairs remains. It is bounded, and now each verdict costs two
   real dispatches.
6. **Once per pair.** The match id is `sha256(tenant, sorted runIds)`, written by
   `compareAndSwap(null, match)`. A repeat returns the stored match with `replayed: true` and
   200, and the client shows the stored winner.

The response is `{match, ratingA, ratingB}`. The match names the attributed models, so the
client learns which model was which from the server, after the vote.

### D5 — Arena standings are a Bradley–Terry fit over the ledger

- **What is retired:** the `evals:arena-rating` rows and their CAS loop (ADR 0700 D1, now
  superseded in part). The ledger is the only truth.
- **The fit.** On read, `arenaStandings(tenantId)` fits Bradley–Terry strengths by Hunter's MM
  iteration:
  - Models are iterated in sorted key order, with a fixed tolerance (1e-9) and a cap of 500
    iterations.
  - A tie is half a win to each side.
  - One virtual tie per model against a fixed reference at strength 1 keeps an unbeaten model
    finite, and links a disconnected comparison graph (L5). The reference is never updated.
- **What is reported:** each fit on the Elo scale (`1500 + 400·log10(p)`), with wins, losses,
  ties and matches. At low match counts the ratings shrink toward 1500, and the page shows the
  counts beside them.
- **Properties:** order-independent and deterministic. Concurrent verdicts cannot lose updates,
  because no running total exists.
- `GET …/arena/rating` stays, served from the same fit. The `evals:arena-rating` rows are no
  longer read; prod has 0.

### D6 — Erasure tombstones the rater, keeps the verdict

`eraseArenaRaterSubject` registers on the subject-eraser seam (through the evals feature's boot
path) and rewrites `raterSubject` to `erased` on every match by any of the subject's key forms.
The verdict is workspace data about two models, and the rater is its only personal field.

The ADR 0464 feature-store gate cannot see `raterSubject` (M1): no signal it binds matches. So
the coverage is witnessed by `adr0986-evals-leaderboard.test.ts` EV2-9, not by that gate.
Widening the gate's signal set is residue R5.

An erased member who is still active can vote 8 more times per model. That is accepted (L6).

### D7 — The page: reachable, blind, and honest about coverage

- **One read.** `GET …/leaderboard` returns `{leaderboard, arena, coverage}`. The client adds
  `fetchEvalsBoard`, and `fetchLeaderboard` still returns `leaderboard` for the dashboard tile.
  The tile sorts by `score` and keys rows on `provider/model`.
- **The arena link renders inside the console too**, as a toolbar row when embedded.
- **Two tables:**
  - "From chat ratings": model, up, down, raters, win rate, confidence.
  - "Arena": rating and W–L–T.

  Managed and simulated rows get a chip. A `Notice` says how many ratings could not be
  attributed. Each table has its own designed empty state.
- **The arena dispatches what it names (B2).**
  - Contestants are picked above the panes, not in them (L7).
  - Each contestant's pane opens with the credential the caller holds for that provider: the
    preferred stored ref (`preferredRefForProvider`), or `managed:<id>` for a managed provider.
  - A contestant with no credential is refused inline, with a link to Keys.
- **Blind.** On the first send, the page assigns the contestants to A and B at random. The panes
  are titled "Model A" and "Model B" and show "Hidden until you vote". The vote posts the two
  run ids. The result names both models from the server's `match`, with their new arena
  ratings. The `/runs` body in devtools still names the model; for an admin tool that is
  accepted and stated.
- **Locales.** Every new string goes in the lazy `evals` and `dashboard` feature catalogs (4
  locales), never in the eager `i18n/locales/*`, so the entry chunk is unaffected.

## Alternatives considered

- **Stamp `agent.model` on every turn instead of a sidecar.** The 1:1 chat has no agent, and
  RFC 0109 types `agent` as the answering agent. Stamping a pseudo-agent would make a false wire
  claim to fix a host report. Rejected.
- **Write `meta.model` on the client bubble and keep the join.** The client authors it, and that
  is EV2-2. Rejected.
- **Derive attribution from what the run already records durably, instead of adding a store.**
  This was ruled on explicitly before code, by the architect pass and by measurement:
  - **The run's event log** carries no model on any event in a conversation run (prod
    2026-10-26: 0 model-bearing events across 21 event types).
  - **RFC 0109 `agent.model`** is stamped on 43 of 634 agent turns. The 1:1 chat resolves no
    agent, and on managed turns the provenance resolver names the REQUESTED target, not what
    answered.
  - **The usage rollup** (`recordTurnUsage`) is an aggregate per (tenant, provider, model) with no
    turn key.
  - **Provider spans** are not durable.
  - **`chat/lib/cost.ts`** is a frontend reader of the same unset client meta (residue R1), not a
    ledger.

  No existing durable record names the answering model per turn, so the sidecar is a single
  owner, not a second one. Re-measure before reusing this ruling: if RFC 0109 provenance ever
  covers every agent turn with the served (not requested) model, D1's store becomes derivable
  and should be retired.
- **Resolve the model at rating time from the run's event log.** The log has no model on 591 of
  634 agent turns, and the per-exchange override is not in it. Rejected: the exchange is the only
  place that knows.
- **Keep the incremental Elo for the arena and only bind runs.** It still loses order
  independence, and it keeps a second store that ADR 0700 needed a CAS for. The ledger is small
  (capped per rater and per model). Rejected.
- **Randomly pick the arena models (LMSYS style).** The admin is evaluating models they chose to
  compare. Randomizing the sides and hiding them until the vote removes the label bias without
  taking that choice away. Kept as the smaller step.


## Consequences

- One extra awaited KV write per model-reply turn, after the turn is durable, and one or two KV
  reads per rating.
- Managed traffic ranks as a tier ("openwop-free"), not as the operator's underlying model, which
  the managed provider deliberately never exposes.
- A model that answers through two providers ranks as two rows. That is the honest reading.
- The arena needs two completed runs, on credentials the rater holds.
- **Breaks a client:** the external CLI's `evals arena` command posts `modelA/modelB`, and gets a
  400 now (residue R3).

## Implementation plan

| Phase | Scope |
|---|---|
| P1 | D1: store, canonical-id twin, `served` threading, exchange write |
| P2 | D2 feedback stamp, D3 ranking, the leaderboard route shape |
| P3 | D4 bound arena, D5 Bradley–Terry, D6 eraser |
| P4 | D7 page, client, tile, 4 locales, FE tests; superseded tests rewritten |
| P5 | grades, residue, FEATURES, `manual-tests` EVAL-02, the tracker |

## Architect pass (2026-10-26, pre-code)

An independent adversarial pass verified the Context findings, with two wording corrections
folded in above. It found 2 Blockers, 4 High, 6 Medium and 8 Low:

| # | Sev | Finding | Folded as |
|---|---|---|---|
| B1 | Blocker | the SPA rates `conversationMessageId(wireId)`, not the wire id, so a wire-keyed row never matches | D1 canonical key + backend twin + parity test; EV2-1 rates the canonical id |
| B2 | Blocker | the arena dispatched managed for both panes, whatever was picked | Context 11; D7 per-contestant credential; FE probe |
| H1 | High | the managed "served" model is the tier id | D1 `managed: true`, labelled a tier; no `resolveModelProvenance` fallback |
| H2 | High | the deep-investigation turn has no answering model | D1 writes at the main site only; the unattributed-by-design list |
| H3 | High | a fork copies turn ids verbatim | the `runId` check in D2 and D4; conversation id from `conversation.opened` |
| H4 | High | mock is a free forge channel | D1 no mock row unless `mockProviderEnabled()`; R4 |
| M1 | Med | the feature-store gate cannot see `raterSubject` | D6 witness + R5 |
| M2 | Med | a tenant index doubles the writes, and the KV age-out warns on it | D1 no index, awaited write |
| M3 | Med | older SPA builds bind runs that carry no `chatSessionId` | D2 bound-run arm |
| M4 | Med | the owner key derivation | D4.1 |
| M5 | Med | thumbs stuffing is bounded by cost, not by count | D3 per-rater weight + `raters` |
| M6 | Med | unlisted breakage (CLI, manual tests, superseded tests, ADR 0700) | P4/P5, R3 |
| L1–L8 | Low | tie order, tile key, content equality, status codes and replay, BT determinism, erasure cap, picker placement and locales, subscription label | D3, D4, D5, D6, D7 |

## Implementation record

| Phase | Commit | Witness |
|---|---|---|
| Probes (10, all red on `f3a80dd9e`) | `6726674bd` | `adr0986-evals-leaderboard.test.ts`, `adr0986-evals-ux.test.tsx` |
| P1–P3 backend | `c379ee763` | the same 7 backend probes now green; `evals-arena`, `evals-bradley-terry`, `evals-leaderboard(-service)`, the parity test |
| P4 frontend | `25e2241d3` | the 3 FE probes now green; `ArenaPage.test` off the live-fetch allowlist |
| P5 docs | `7a90549fc` | FEATURES row; ADR 0123 and 0700 correction notes; manual tests EVAL-01..04 |
| Review fold-in | `e2ff2b972`, `e1f5953e5` | `adr0986-served-model.test.ts` and the cases below |

**A finding the probes surfaced (EV2-11).** The feedback route writes
`userRef(actingUserOf(req))`, and a signed-in caller's canonical id is already `user:`-shaped,
so every signed-in rating is stored under `user:user:<id>`. `eraseSubjectFeedback` matched no
such form, so a DSAR left every signed-in rating behind. The pre-0986 arena route had the same
double prefix. Both erasers now match the doubled spelling (`subjectRefFormsWithDoubled`; folded into
`subjectKeyForms` itself by the ADR 0464 DSAR-DBL correction, which covers the other stores too), and
the arena route writes a single prefix. Other stores keyed by `userRef(req.userId)` may share
the shape; that belongs to the chat row (R7).

**Sabotage witnesses (26, each shown red, then restored).** Each guard was broken and its test
went red:
- the conversation predicate;
- the bound-run arm;
- create-only writes;
- the mock gate;
- BYOK served after a bump fallback;
- the managed flag;
- tool-loop served;
- the no-contribution skip;
- the checked-row skip;
- the owner check;
- prompt equality;
- the fork `runId` check;
- the same-model check;
- the tenant in the match id;
- replay orientation;
- both doubled-form erasers;
- run ids required;
- the per-rater weight.

On the frontend:
- the per-contestant credential;
- the blind header;
- refusal reasons;
- the same-pick block;
- the sticky failed match;
- the unmount close;
- the embedded arena link.

## Grading pass (2026-10-26)

`/grade-code` (B+), `/grade-ux` (B−) and `/code-review` (0 Blockers) were run on `cdb1b6c38`.
Folded in:
- **Code review H1, a fork clobbers the source's rows.** A fork restores the source's
  suspended gate, so its new turns reuse the source's wire ids. An overwrite would have
  re-attributed the source's turn. Writes are now create-only, and a fork's turns fail every
  consumer's `runId` check.
- **The owner check accepts the principal stamp (M1).** A bearer caller's runs are stamped with
  the principal.
- **Ratings checked at write are never re-resolved (M4).** A failed lookup stores the rating
  unattributed instead of failing the request.
- **A replayed verdict answers in the request's orientation.** One standings fit per POST. A
  bare model id served by two providers must be read by its `provider/model` key.
- **Logs** for refused verdicts and for leaderboard coverage.
- **Tests (EV2CD-1/2):** every `served` branch (managed, BYOK bump, tool loop), create-only
  writes, mock gating, failure isolation, the no-contribution skip, the bound-run arm, and the
  checked-row skip.
- **UX:**
  - A refusal now says why, via the typed `EvalsHttpError.reason`, instead of "retry". Picking
    the same model twice, or the same managed tier twice, is refused before anything runs.
  - A failed pane, or a verdict, ends the match. The vote bar and further sends stay off
    until "New match".
  - Sends wait for the key read. The result is announced through the global live region.
  - The contestant switchers are labelled "Contestant 1" and "Contestant 2". Runs close on
    unmount through a ref.
  - Confidence is explained in visible text, not only a `title`. The tables reflow at phone
    width (`stack`). The dashboard tile shows the score it sorts by, with the rater count.

**Closing re-grade (27b226b3c, then the fixes below).**

| Grader | Grade |
|---|---|
| `/grade-code` | **A** (was B+) |
| `/grade-ux` | **A−** (was B−): leaderboard A−, arena B+, tile A− |

Closed after the re-grade:
- **EV2CD-11.** A rating could land between the turn becoming durable and its attribution
  write, then be marked checked forever. The attribution is now written BEFORE
  `persistExchangedPair`, witnessed by a persist-time probe, which goes red when the write is
  moved back.
- **EV2CD-10.** The per-model cap's 429 now carries `reason: 'arena_rater_cap'`, with its own
  copy in 4 locales.
- **EV2CD-12.** A lost create logs `turn_attribution_exists`.
- **UX L6.** A terminal refusal ends the match.
- **UX L7.** The managed explainer also shows for arena rows.
- **UX L8.** The tile's rater count is pluralised.
- **The lead's R3 question.** A pre-0986 body (`modelA`/`modelB`) is refused with
  `details.reason: 'arena_contract_changed'` and `required: ['runIdA','runIdB','winner']`.

**Known limit (stated, not fixed).** If a fork is BOUND to the same chat session as its source,
a rating of the fork's turn N stamps the source's turn-N model: same session, same canonical id.
Rebinding a session to a fork has no product path today. Chat branching creates a new session
with fresh ids, so it is unaffected.

## Residue (filed, not closed by this ADR)

- **R1:** `TurnReceipt` and `cost.ts` read a client `meta.model` that the conversation transport
  never sets. This belongs to the chat row, not this one. D1's store is the obvious source, but
  serving it on a turn read is a separate decision.
- **R2 (`EVC-3`):** the org in the route authorizes, while the data is tenant-wide. This is
  unchanged, and correct for a workspace-level model ranking.
- **R3:** the external CLI `@openwop/cli` **1.8.0** (`src/cli/evals.ts:31-32`, `evals match
  --model-a/--model-b`) posts model names and now gets a 400 with
  `details.reason: 'arena_contract_changed'`, `required: ['runIdA','runIdB','winner']` and a
  message that names the new contract. The fix is the next CLI release after 1.8.0: `evals
  match --run-a/--run-b`. Its `rating` command already 400s without `--model`. Filed for
  `/update-cli`.
- **R4:** the exchange's `provider === 'mock'` branch (`dispatchTurn.ts:275`) does not consult
  `mockProviderEnabled()`. This is pre-existing and wider than evals.
- **R5:** widen the ADR 0464 feature-store gate's signals to cover `raterSubject`-shaped fields,
  measured old→new.
- **R6:** no chat tool reads the leaderboard.
- **R1 note (lead question):** D1's store could feed `TurnReceipt` / `cost.ts`, but only by
  serving it on a turn or message read, which is a new read shape for the chat. That is not
  "the same few lines", so it stays out of this PR.
- **R7 (chat row):** other stores keyed `userRef(req.userId)` may hold `user:user:<id>` that
  their erasers miss. EV2-11 fixed the two evals reads. The class needs a census.
- **R8:** `ModelSwitcher` renders nothing when no model is advertised, so the arena then shows
  only "Choose two contestants" with no designed "no models" state.
- **R9:** the arena panes keep their static inline layout styles (`PANES`/`PANE`, DESIGN.md §10),
  as before this ADR. Moving them to a class is polish.
- **R11 (EV2CD-13):** there is no test of `served` for the copilot, subscription and compat
  branches, or for the BYOK tool loop's `modelUsed`. Managed, the BYOK bump and the managed
  tool loop are tested.
- **R10:** there is no route test of a bearer (principal-stamped) caller voting on its own runs.
  M1 is fixed in code but witnessed only by reading.

## Open questions

- None blocking.
