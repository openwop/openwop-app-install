# ADR 0600 — Insights & Drafting: the surfaces it borrows, and the claims they make

Status: implemented

> **Scope.** PR-B of the feature-27 (`insights-suite`) remediation. ADR 0599 (PR-A)
> made the feature honest and then runnable — it closed the fabrication class, built
> the execution witness, repaired the wiring, and fixed a disarm posture that was
> backwards in both directions. This one takes what PR-A named in its §9: the
> **surfaces** and the **observability** rows.
>
> Nothing here weakens PR-A. The never-auto-send guarantee, tenant isolation,
> toggle-OFF gating, PII masking and replay/fork determinism are all still in
> place; §5 STRENGTHENS the PII posture rather than trading it away.
>
> **CORRECTED — see §Correction 2.** That last clause is too strong and is
> wrong as a statement about the PR. §5's narrowing is real and stands, but §2
> moved in the opposite direction on the same chain: `anniversary-draft`'s
> approval notification is still a tenant-wide BROADCAST, and §2 made the card
> it routes to render the gate's upstream input — for that chain, the
> AI-drafted recognition email naming a colleague. One surface narrowed, one
> surface's rendering widened. The honest summary is in §Correction 2, and it
> is not "strengthens".

## 1. `ISU-24` — a positive claim on a failed read

`RunTimeline.tsx` branched on `events.length === 0` and rendered **"No events
yet."** — a claim about the RUN. `RunDetailPage` mounts it unconditionally, and its
`pollEvents` catch sets a separate `error` while leaving `events` at `[]`. So a
transient backend blip told the user their run had produced nothing. For this
feature that lands on top of a chain that (pre-PR-A) reported `on_plan` from no
data, so the honest failure and the dishonest success read identically.

This is the exact shape `ui/StateCard.tsx` is written against: **the empty is not
minted by the catch, it is minted at RENDER**, so no amount of care in the catch
prevents it.

### The enumeration, done by reading the file

The row named one string. The file has five reads, and they are not all the same
shape — stating that is the point, because "fix the other four too" would have been
motion:

| Read | Consumer | Verdict |
|---|---|---|
| `pollEvents` | `RunTimeline` "No events yet"; `EventStreamView` the same claim in a `StateCard`; `RunAnalyticsPanel` `return null` | **FIXED** — the read's outcome now travels with the array |
| `getRun` | skeleton is gated `!snapshot && !error`; failure raises a Notice | already honest — **and it counts as a failed EVENT read**, because it throws before `pollEvents` is called |
| `listOpenInterrupts` | `activeInterrupt = null` ⇒ no approval card | absence of a card is not a claim, and the page-level `error` Notice does show. Enumerated, not changed. |
| `listAnnotations` | `annotationsUnavailable` → an explicit "could not be loaded" line | already correct — and it is the PRECEDENT the events fix mirrors |
| `getRunRevision` | `.catch(() => {})` ⇒ no revision chip | a fail-soft on an OPTIONAL capability, disclosed in-code (`ADR 0474 — fail-soft; absent for legacy runs`). A missing chip says nothing about the run's content. **Residual (§9), not fixed.** |

**One amendment to the finding.** The row ranks `RunAnalyticsPanel`'s
`if (events.length === 0) return null` as *"worse still"*. It is not worse: silence
makes no claim, and a false claim does. It is fixed anyway — the `annotationsUnavailable`
precedent sits four lines away and the asymmetry would have been its own small
dishonesty — but the ranking is wrong and is recorded as wrong.

### The cure

`EventReadState` (`'loading' | 'ready' | 'failed'`) travels with the array, and ONE
shared `EventReadStateCard` serves both event views so the timeline and the log
cannot drift on what "no events" means.

> **CORRECTED — see §Correction 8.** That shared component shipped with its own
> decorative guard (`if (events.length > 0) return null`), unreachable because
> both callers gate on the same condition one frame up — the very class this
> section deletes, in the component this section introduced. Guard and prop
> removed; the witnesses now name the callers' branch as what holds it. `RunComparePage` is unaffected: it mounts
`RunTimeline` only when `events.length > 0`, and the prop defaults to `'ready'`.

### A FIFTH vacuous assertion of mine, exactly as PR-A predicted

The loader's catch was first written `setEventsRead(prev => prev === 'ready' ? prev : 'failed')`,
to stop a LATER read's failure from retroactively unreading a good event log.
**Sabotaging that guard came back GREEN**, and the reason is that the guard is
UNREACHABLE: `refreshInterrupts` and `refreshAnnotations` each own their catch, so
nothing after `pollEvents` resolves can throw to the loader's. The property is real
and is asserted; the guard that appeared to hold it was decoration. Deleted, and the
test relabelled to name `refreshInterrupts`'s own catch as what actually holds it.

*That is one more instance of ADR 0599's stable rule: the assertion existed and
measured a different mechanism than the one it named.*

| Witness (`runs/__tests__/eventReadHonesty.test.tsx`) | Sabotage | Result |
|---|---|---|
| the LOG view's failure card | revert `EventStreamView` to `StateCard{noEventsYet}` | **exactly 1 red** |
| the analytics panel's "could not measure" | drop `!eventsUnavailable` from its null-return | **exactly 1 red** |
| the TIMELINE view's failure card | revert `RunTimeline` to the bare muted `noEventsYet` div | **3 reds — a stated blast radius**, all three timeline-scoped (it is the default tab and hosts the retry CTA) |
| the empty claim is still REACHABLE | make the failure branch unconditional | **5 reds** — the polarity half, stated |
| a later read's failure does not unread the events | `setEventsRead('failed')` unguarded | **GREEN — and that is the finding**, see above |

## 2. `ISU-10` — the approval card the app ROUTES TO rendered no evidence

Two approval cards over the same payload, and they disagreed. The chat card
auto-loaded the gate-preview artifact and rendered it. `interrupts/ApprovalCard`
read `data.prompt` and `data.actions` and **nothing else** — never `options`, never
`artifactId`, never `revisionId`.

**The default route lands on the blind one.** `notifications/notify.ts` sets the
interrupt notification's `actionUrl` to `/inbox`, and `/inbox` renders the
interrupts card. So a finance approver was asked *"Confirm the variance figures
before surfacing."* with no figures, and a manager *"Review the recognition
draft."* with no draft. Approve blind or reject blind were the only two real
options — on the one gate standing between a fabricated verdict and a delivered
insight.

**The evidence was on the wire the whole time.** `executor.ts` persists the gate's
upstream output as a durable run-artifact and binds `artifactId`/`revisionId` onto
the interrupt data; `listOpenInterrupts` returns that data verbatim. The card had it
in hand and dropped it.

### Decision: ONE shared component, and two deliberate asymmetries

> **CORRECTED — see §Correction 1.** Both halves of this section shipped false.
> The component was NOT the only implementation (the chat card kept a private
> copy of the ADR 0193 send-approval envelope), and rendering the block
> unconditionally on the interrupts card turned a card that was blind-and-silent
> into one that was blind-and-WRONG on `core.email.send` — the gate that sends
> email as the user. Fixed; the rationale below is left as written.

`chat/reviews/GateEvidence.tsx`. The report's own prescription — *"one shared
preview component, not a second copy"* — is right, and a second implementation is
how these two drifted apart after ADR 0083 fixed only one of them.

Two things it deliberately does NOT unify, both recorded in its docblock:

- **The ≥2-option PICKER stays chat-only.** It chooses a resume VALUE, which the
  chat card carries via `onAction`; the interrupts card resolves with
  `{action, comment}` and has nothing to pick with. A picker there would be a
  control that does not do what it looks like it does. Multiple options render as
  read-only evidence instead.
- **The interrupts card renders the block UNCONDITIONALLY; the chat card keeps its
  `hasGateEvidence` gate.** So a gate with nothing captured says so on the surface
  approvers are routed to, and the chat card's no-evidence rendering is unchanged.

### Two honesty defects found IN the code while extracting it

1. The artifact read's `catch` set `[]`, with the comment *"surface the empty-state
   inline rather than failing"* — a failed read rendering as **"No preview
   available for this item"** to someone about to sign an approval. "There was
   nothing to review" and "we could not show you what you are signing" are opposite
   instructions. Same shape as §1, carried in a separate flag so it cannot collapse.
2. A gate that captured **nothing** (the `forkMode === 'replay'` lane, where
   `executor.ts` skips artifact persistence) rendered an empty box. It now says so.

| Witness (`interrupts/__tests__/gateEvidence.test.tsx`) | Sabotage | Result |
|---|---|---|
| the inbox card renders evidence at all | remove `<GateEvidence>` from `ApprovalCard` | **5 reds — the whole feature, stated** |
| a failed evidence read ≠ "no preview available" | collapse `setFailed(true)` back into `[]` | **exactly 1 red** |
| "nothing was captured" ≠ the generic empty copy | drop the `nothingCaptured` branch | **exactly 1 red** |

## 3. `ISU-27` — `role="status"` on the "Workflow failed" branch

`CompletionShell` hardcoded `role="status"` for all three tones. **Three separate
defects rode on that one attribute, and only one of them is the role:**

1. a terminal FAILURE marked polite, where `ui/Notice.tsx` already maps
   `variant === 'error'` → `role="alert" aria-live="assertive"`;
2. a live region NESTED inside `MessageFeed`'s
   `role="log" aria-live="polite" aria-relevant="additions"` — the competing-voices
   defect MessageFeed's own skeleton comment refuses, four hundred lines up;
3. `aria-label` carrying the message, so AT reads the label instead of the row and
   the error code is unreachable.

> **CORRECTED — see §Correction 7.** §2's `GateEvidence`, landed one commit
> later, re-committed exactly the mechanism this section removes: a
> conditionally-mounted inline `role="alert"` region arriving with its text
> inside, carrying *"Don't decide from this card"*, unasserted and invisible to
> all four gates measured below. Fixed with `<Notice announce>`.

### Decision: remove the false region, do not flip its politeness

Changing `status` → `alert` fixes exactly one of the three and leaves the outcome
resting on a **conditionally mounted inline region** — the mechanism
`ui/Notice.tsx:6-28` and `ui/StateCard.tsx` both say must not be treated as
established. So the region is removed (`role="group"` keeps the label legal and the
row navigable as a unit) and the speech moves to the one region this app trusts.

**Only FAILURE announces, and that is deliberate rather than partial:** the ancestor
log announces the card's insertion politely already, which is the right channel for
a completed or cancelled run. Announcing those again here is the double-announce
`ui/announce.tsx`'s boundary exists to prevent. Run detail's terminal-failure
`Notice` gets the same treatment for the same reason (conditionally mounted).

### The gates: MEASURED blind, not assumed blind

The brief asked whether the two accessibility gates extended in the previous feature
now see this shape. **They do not, and neither do the other two.** Measured by
restoring the original defect and running each gate:

| Gate | With the defect restored | Why |
|---|---|---|
| `check-live-regions` | GREEN | judges only the `>{bareVariable}<` child shape backed by a same-file `useState`; this region has `aria-label` + JSX children |
| `check-failure-card-announce` | GREEN | scans `<StateCard>` elements only |
| `check-notice-announce` | GREEN | scans `<Notice variant="success">` only |
| `check-aria-prohibited` | GREEN | flags `aria-label` on a ROLE-LESS div/span; `role="status"` exempts it — legal ARIA, wrong behaviour |

No gate covers a hand-rolled region on a non-`StateCard`, non-`Notice` element whose
role is not variable-backed. **Recorded as a residual (§9), not built here:** a fifth
a11y ratchet is a cross-cutting decision, and this PR has no mandate to add one.

| Witness (`chat/__tests__/completionCardAnnounce.test.tsx`, `runs/__tests__/eventReadHonesty.test.tsx`) | Sabotage | Result |
|---|---|---|
| a failure announces | `failureAnnouncement = ''` | **exactly 1 red** |
| it announces ASSERTIVELY | drop `{ assertive: true }` | **exactly 1 red** |
| the shell is not a nested live region | `role="group"` → `role="status"` | **exactly 2 reds** (both shell-role cases) |
| run detail's failure announces | drop the `announce` prop | **2 reds** |
| the announcement is the CODE, not the raw blob | announce `error.message` | **2 reds** |

## 4. `ISU-23` — the `outputRole` post-processor, measured before it was judged

The row said "curation with no consumer". **Executing the three expanded definitions
found something sharper, in two different directions:**

| chain | `expandChain`'s raw roles | after `withOutputRoles` | graph terminal |
|---|---|---|---|
| `weekly-variance` | `notify=primary` | `notify=primary` | `notify` |
| `anniversary-draft` | `notify=primary` | `emailDraft=primary`, `generate=secondary` | `notify` |
| `talent-prep` | `notify=primary` | `score=primary` | `notify` |

So on `weekly-variance` the post-processor is a **measured no-op** — it re-asserts
exactly what the auto-terminal-primary stamp already produced. On the other two it
**STRIPPED `primary` off the only graph terminal** and put it on a node with
outgoing edges, which `useTerminalNodes` filtered out by construction. The curation
was not merely unread: **for two of three chains it made the completion card
strictly worse than no annotation at all.**

*(Method note worth keeping: the first measurement script was WRONG — it read
`edge.from`, and `EdgeDef` uses `sourceNodeId`, so every node looked terminal. The
table above is from the corrected run. Reasoning would have reached the same
conclusion and I would not have known the instrument was broken.)*

### Decision: make `primary` readable, RETIRE `secondary`

**The intent was right and the consumer was wrong.** `outputRole:'primary'` means
"the canonical deliverable" (RFC 0065) — a claim about what the user should be
handed, not about graph position. `emailDraft` (the drafted email) and `score` (the
9-box result) are exactly right; `notify` (a bell ring) is exactly the wrong thing
to hand someone as "the output". So an explicit role now outranks graph position in
`useTerminalNodes`, with the polarity asserted: an UNTAGGED mid-graph node is still
not a deliverable.

> **CORRECTED — see §Correction 4.** The paragraph below is what was decided
> and it is right. The code shipped `outputRole === 'primary' || outputRole ===
> 'secondary'`, which is the consumer this paragraph says it considered and
> REJECTED. Fixed to `=== 'primary'`; the three statements this section, its
> docblock and §9 make about `secondary` are true again.

**`secondary` is retired, not fixed.** Nothing in the SPA reads it — the only
consumer tests `=== 'primary'`, and when any primary exists the surfaced list
narrows to the primary alone, so a `secondary` tag renders identically present or
absent. That is the documented-mechanism-with-no-reader class ADR 0599 retired
`instanceUrlTemplate`, `rejectionPolicy:"block"` and `VARIABLE_DEFAULTS` for.
Inventing a consumer inside a feature PR — quiet secondary links on every completion
card app-wide — was **considered and rejected**: it is a visible behaviour change
for every workflow in the app, requested by nobody, to make one dead field alive.
The app-wide gap it exposes (`secondary` is AUTHORABLE in the Builder Inspector and
rendered nowhere) is a residual (§9).

### The undisclosed third state

`getSavedWorkflow` is `localStorage`. A cache MISS and "this run produced no
readable outputs" both returned `[]` and rendered the identical bare "Open run". For
a feature with no page — driven from chat, a schedule or a trigger — **the miss is
the common case, not the edge one.** The card now says which happened.

**Resolving terminals from the SERVER was considered and NOT taken.** `loadWorkflow`
exists and `deserialize.ts` preserves `outputRole`, so it is feasible — but it pulls
`loadDynamicCatalog` + `listWorkflowSummaries` into the chat entry chunk, which sits
at 128.5 kB against a 130.0 kB budget, and it belongs with a proper server-side
terminal-resolution seam rather than a lazy import bolted to a card. Residual (§9).

`ISWF-12` (`PROBE-IS-8`) and `ISWF-18` (the suffix-collision guard) close here too —
the matcher took the first `Object.entries` hit, so `re_score` beside `score` would
assign by INSERTION ORDER. Vacuously safe on today's corpus, unsafe by construction;
the parameter un-prefixing path four files over hit this exact bug and was fixed
with longest-first + consume-once, and the role matcher never was.

| Witness | Sabotage | Result |
|---|---|---|
| exactly one primary, on the deliverable (`PROBE-IS-8`) | drop the auto-terminal CLEAR | **exactly 2 reds** |
| `secondary` is gone | restore `generate: 'secondary'` | **exactly 1 red** |
| suffix collision (`ISWF-18`) | revert to the first-hit matcher | **exactly 1 red** |
| an explicit role outranks graph position | restore the terminal-only filter | **exactly 1 red** |
| …but does NOT surface everything | make the filter unconditional | **exactly 1 red** |
| the cache-miss state is disclosed | collapse it back into empty | **exactly 1 red** |

## 5. `ISU-6` / `ISU-7` / `ISU-8` — the notification lane, as ONE decision

PR-A **declined** to bind `talent-prep`'s notification body and said why: at
`audience:'tenant'` the body reads *"A. Person — High Performer"* sent
workspace-wide. That is not two rows, it is one: **narrowing the audience is what
makes a body safe.** Both land together or neither does.

### `ISU-6`, and its SUSPECTED half is now MEASURED

`audience === 'tenant'` becomes `target = {}` in `notifications/surface.ts` — no
recipient filter. The record carries `runId` and the inbox renders it as a
`/runs/:id` link. The report marked "an ordinary member can OPEN it" as SUSPECTED.
It is confirmed by reading the authorization chain:

- `runs:read` is in **`VIEWER_SCOPES`** (`accessControlService.ts`) — the LOWEST
  built-in role;
- `host/runAccess.loadReadableRun` authorizes on the scope seam **+ tenant
  ownership**, with **no per-run owner check**.

So any viewer in the workspace could open the run holding a named colleague's 9-box
score. `talent-prep` and `anniversary-draft` move to `self`.

**`weekly-variance` deliberately KEEPS `tenant`**, stated in the pack, the probe and
here rather than left as a silent inconsistency: `self` resolves from the run's
acting user, and its real lane is the RFC 0052 scheduler, where there is none — it
would return `no_acting_user_on_this_run` on every fire, forever.

> **CORRECTED — see §Correction 6.** That argument applies to
> `anniversary-draft` too and this section does not say so. Its automated
> ignition is the webhook subscription, and `host/triggerIngestionService.ts`
> builds the `RunRecord` with no `actingUserId`, so at `self` it refuses on its
> only automated lane — **PROVED by execution**. The trade is still right; the
> silence was not, and `PROBE-IS-10`'s system-run case covered `talent-prep`
> only. It also declares
no PII entity; only `insights.talentSnapshot` is registered `confidential-pii`, so
**the report's "the two chains carrying `confidential-pii`" over-counts by one.**

The wider cure — a per-run owner check on run reads — is **rejected here**: it is a
cross-feature authorization change that would break deliberate shared-team run
visibility, and it is not feature-27's to make. Named for `/architect` in §9.

### `ISU-7` closes for ONE chain of three, and that is stated

`talent-prep` binds `score.label → notify.message` (port-qualified on BOTH sides —
PR-A §8 #2's amendment). `weekly-variance` and `anniversary-draft` cannot: their
`notify` is fed by a resumed `core.approvalGate`, which completes `{output: …}` with
no top-level string, and PR-A already **rejected** adding a `compute → notify`
sibling edge as the ADR 0582 "unconditional sibling edge into the effect node"
shape. Their honest cure is the additive RFC 0013 produced-variable bag PR-A
recorded. Unchanged residual.

### `ISU-8` closes for EVERY chain, not just this feature's

> **CORRECTED — see §Correction 11.** Written as unqualified good news, and it
> moves **53** `audience:"tenant"` notifiers at once. Not an authorization
> change (`runs:read` was already in `VIEWER_SCOPES` with no per-run owner
> check), but it puts `GEN-RUNREAD-1` one click from four ambient surfaces. The
> trade is still taken; it is now stated.

The notify surface now derives `actionUrl` from `scope.runId`. The inbox open-codes
a `runId` fallback; the bell drawer and the dashboard tile do not, so **every**
workflow notification dead-ended on the two ambient surfaces. Derived from the run,
never from author input — which is why it needs none of the `isSafeInAppPath`
validation the agent tool requires.

| Witness (`PROBE-IS-10`, on the EMITTED RECORD) | Sabotage | Result |
|---|---|---|
| talent notifies ONE user, with a body and a link | audience back to `tenant` | **exactly 2 reds** |
| the body carries the score | the `score.label` edge back to portless | **exactly 1 red** |
| every chain gets a deep link | drop `actionUrl` from the surface | **exactly 2 reds** |

A `config.audience === 'self'` assertion polices a string; `recipientUserId` is what
decides who can read it, so the probe reads the row. The fail-closed direction is
asserted too: a SYSTEM run REFUSES rather than widening back to the broadcast.

## 6. `ISU-11` / `ISC-13` / `ISWF-13` — fix the honesty, not the behaviour

PR-A's review verified `rejectionPolicy:"block"` was **inert** (both readers do
`x === 'majority' ? 'majority' : 'any'`, so anything-not-majority was already the
strictest setting) and PR-A deleted the value. What it did not fix is **why nobody
noticed for months: the value was ACCEPTED.** It read as a deliberate safety choice
in a chain a human opens in the Builder, enforced nothing, and editing it to any
other invented word would have behaved identically.

> **CORRECTED — see §Correction 9.** True of the NODE, false of the FIELD:
> `core.interrupt` forwards `config.data` VERBATIM and both readers pull
> `data.rejectionPolicy` off any approval interrupt, so the defect stayed
> authorable through the PACK lane — the lane `"block"` actually shipped
> through. Both nodes now call one shared refusal.

**The refusal sits on `core.approvalGate` — the ONE choke both authoring lanes pass
through.** `ISWF-13` prescribed pack-load validation; that would gate the CREATION
lane and leave the Builder lane open, which is the shape my own notes call out. The
node is where a chain pack and a Builder-edited workflow both arrive.

**The asymmetry is the design, and both halves are asserted:** the WRITER refuses (a
human can still fix it); the two RESOLVE-time readers keep COERCING, because they
read an already-persisted interrupt and refusing there would strand a live gate with
no exit — the ADR 0599 §6 "a refusal that persists is worse than the bug it
replaced" rule. Those two readers now share one helper, so the vocabulary has a
single definition instead of two copies of the same ternary.

**Accepted is the UNION of the two vocabularies that genuinely exist** —
`single-veto`|`majority` (the wire schema, whose default is `single-veto`) and
`any`|`majority` (this host). They describe identical behaviour; only the spelling
differs, so refusing either would have been the worse bug. Asserted as a polarity.

**Blast radius measured before enforcing.** The Builder already renders this field
as a two-option `select`, so that lane could never author an invalid value. The only
invalid values in the repo were **three fixtures in
`approval-gate-reject-blocks.test.ts`** — `'block'`, copied from the insights chain.
*The probe written to prove the gate works was carrying the drift it sat next to.*
Moved to `single-veto`, which also gives that token end-to-end run coverage.

| Witness | Sabotage | Result |
|---|---|---|
| the writer refuses `block` | `if (false)` on the guard | **2 reds** |
| `normalize` returns null, not the default | return `'any'` for anything | **3 reds** |
| both legal spellings are accepted | drop `single-veto` from the set | **2 reds** |
| the reader still coerces | make it fall back to `'majority'` | **exactly 1 red** |

## 7. Smaller rows, each with what it actually was

- **`ISC-15`** *(**CORRECTED — see §Correction 10**: the closed world was closed
  over NODES and driven from a HARDCODED three-chain array, so a fourth chain was
  never walked and the `> 9` node floor tolerated losing a whole chain. The chain
  set is derived from the pack now, and the count is asserted.)* — TOOK FINDING, **REJECTED CURE, with the measurement.** The guard
  was `/send|sendmail/i.test(n.typeId)`: it polices a NAME. Demonstrated: a
  `core.openwop.integration.email-dispatch` node added to a chain is invisible to
  it. The prescribed cure ("re-express it against `sideEffectFloor.generated.ts`,
  which lists both insights nodes") is **not implementable for the node the
  guarantee is about**: that file is DERIVED FROM PACK MANIFESTS, and
  `core.email.draft` / `core.email.send` — like `core.bigquery.query`,
  `core.workday.query` and `core.approvalGate` — are code-registered with no
  manifest (`ISU-4`'s root cause). Grepped: **zero** occurrences of
  `core.email.draft` in the generated floor. What IS available is a **closed
  world**: every node typeId in the three chains must be on a reviewed allowlist,
  with an anti-vacuity floor. Strictly stronger in the direction that matters — a
  new node, however spelled, fails until someone puts it on the list and thereby
  looks at what it can do. The regex is kept BESIDE it: one line, and it fires
  fastest on the obvious wrong node. *Sabotage: add a send-capable node with no
  "send" in its id → **exactly 1 red**, and the old guard measurably green.*
- **`ISC-14.3`** — the tautology is **exhibited**, not deleted and not left
  implicit. `classificationOf('insights.varianceReport') === 'internal'` reads as a
  guarantee and is not one: `classificationOf` returns `'internal'` for any entity
  with no declared PII fields, and that entity is never declared. PR-A kept it
  because deleting it would erase the only trace of that. It now sits beside the
  same assertion over a name that certainly does not exist — so neither line can be
  mistaken for coverage, and the demonstration itself goes red if the default ever
  stops being `internal`. *Sabotage: make `classificationOf` stop defaulting →
  **exactly 1 red**.*
- **`ISU-12`** *(**CORRECTED — see §Correction 5**: this landed on
  `interrupts/ApprovalCard` only, one card of the pair §2 had just unified, and
  the rewritten `INS-03` then told a tester to expect a confirm on the chat
  surface that had none. The chat card has it now.)* — REJECT was one unconfirmed click straight to the network, on the
  verb that FAILS the run and discards what it already spent. Run DELETION on the
  next surface over already confirms. **APPROVE is deliberately NOT gated**, and
  that polarity is asserted: a confirm on the common path is exactly the friction
  people learn to click through. *(Note: `ISU-12`'s stated severity rested on
  `ISU-10` — "one click away from discarding work they were never shown". §2 means
  they ARE shown now, so the finding survives on destructiveness alone.)*
- **`ISU-16`** *(**CORRECTED — see §Correction 5**: the replacement cases put
  TWO fresh instances of this very family into `INS-01` and `INS-03`.)* — `offVia()`'s step 3 claimed "the feature appears in the nav and its
  route is reachable" **unconditionally**, and a tester following it would file the
  missing nav entry as THE bug. `hasPage` makes the claim conditional rather than
  dropping it. `INS-01` — one step, "a drafted insight artifact is produced and
  readable" — could not pass and has never been run against a working feature;
  replaced with three cases that name what each chain NEEDS and carry the assertion
  its defect exists for (the empty read must FAIL, not say `on_plan`; a second
  user's inbox must stay EMPTY; the Sent folder must stay empty).
- **`ISU-20`** — the 8 `.insights-*` selectors styling the dashboard ADR 0082
  deleted had ZERO consumers and shipped in the built CSS for months.
  `check-orphan-classes` runs TSX→CSS and does not register the `insights-` prefix,
  so it is structurally unable to see an unused SELECTOR — noted where the block
  was, so the next reader does not assume the gate covers it.
- **`ISU-21` / `ISU-22`** — already closed by ADR 0599 §7 (`ISC-14`). Verified
  against the merged tree, not assumed.

## 8. `ISC-12` — the model was being lied to, twice

Pack `description` fields and prompt bodies reach the model's system prompt, so
drift there is drift in what the model believes about the world. Two claims no code
backed, both in the direction that produces confident output:

1. *"Carry the 'data as-of' timestamp and any query reference forward so the human
   can verify. Never present a number you cannot trace."* `variance-compute` emits
   `businessUnit`, `variances`, `flagged`, `thresholdPct`, `metricsEvaluated`,
   `metricsMissing`, `metricsUncomparable`, `verdict` — no timestamp, no query
   reference, no source id. **An instruction to cite a structurally absent thing
   does not produce silence; it produces an unfalsifiable traceability story.**
2. The prompt said the actuals *"ride a scheduled/workflow run that hands you the
   figures"*, and the pack description advertised *"the exact SQL for 'Verify
   Source'"* — a surface ADR 0082 deleted. There is no path from a scheduled run
   into a conversation: that chain notifies an inbox.

The prompt now ENUMERATES the node's real output keys and tells the model to state
the absence. Corrections are inline notes, not rewrites.

> **CORRECTED — see §Correction 3.** This section fixed the two places it
> looked at and left TWO PROSE SURVIVORS making the same promise, one of them
> the prompt's closing sentence. `PROBE-IS-11` could not see either — its
> reverse direction matches only backtick-delimited identifiers — so the
> tripwire reported green over the live defect and `XCH-IS-1` was recorded
> CLOSED. Fixed; the instrument is replaced, not extended.

`PROBE-IS-11` is the parity tripwire, in **both** directions: every key the node
emits must be enumerated in the prompt, and the prompt must name no output key the
node does not emit — plus the two exact phrasings that shipped, so a revert is loud.
Tracked as **`XCH-IS-1`** in `docs/steward/LLM-EXCHANGE-AUDIT.md` (UPDATED, not
restarted), graded **B**: still prompt-mediated, with no runtime schema-request path
and no app-state read. Reaching A− means a catalog tool on this agent — a new
model-facing surface, and its own decision.

| Witness | Sabotage | Result |
|---|---|---|
| the prompt promises no SQL provenance | restore the instruction | **exactly 1 red** |
| the pack description does not either | restore "the exact SQL for 'Verify Source'" | **exactly 1 red** |
| the enumeration tracks the node | add a `dataAsOf` output | **exactly 1 red** |

## 9. Residuals — every one, and where it goes

### Named for `/architect` (cross-feature or seam-level)

- **`GEN-RUNREAD-1` (new).** `runs:read` is in `VIEWER_SCOPES` and
  `loadReadableRun` has NO per-run owner check, so any tenant viewer can open any
  run in the tenant — including one holding `confidential-pii`. §5 narrows who is
  TOLD; it does not narrow who can READ. A per-run owner check is a cross-feature
  authorization change that would break deliberate shared-team visibility, and it
  is not feature-27's to make.
- **`GEN-APPROVENOTIFY-1` (new — §Correction 2).** An approval interrupt whose
  gate names no approvers broadcasts to every tenant member, and §2 made the
  card that notification routes to render the gate's upstream inputs.
  **MEASURED: 14 of 14 `core.approvalGate` nodes across 6 shipped packs declare
  no approver refs**, so this is every gate in the app, not a feature-27 row.
  Not an authorization change — `runs:read` / `artifacts:read` /
  `workspace:read` are all in `VIEWER_SCOPES` already (`GEN-RUNREAD-1`) — but a
  real increase in ambient exposure. The cheap cure is on the shared seam:
  `routes/notifications.ts` already filters on `recipientRole` and nothing on
  this path sets it, so addressing interrupt notifications to
  `approvals:respond` holders needs no new mechanism. Declaring
  `approverRoleRefs` on the gates instead is rejected in §Correction 2 (it is
  §6's `rejectionPolicy:"block"` shape at `requiredApprovals: 1`).
- **`GEN-A11Y-5` (new).** No gate sees a hand-rolled live region on a
  non-`StateCard`, non-`Notice` element whose role is not variable-backed —
  measured against all four in §3. A fifth ratchet is cross-cutting.
- **`GEN-OUTPUTROLE-1` (new).** `outputRole:'secondary'` is AUTHORABLE in the
  Builder Inspector and rendered NOWHERE in the SPA. §4 retired this feature's use
  of it; the authoring surface still offers it.
- **`ISC-9` — NOT FIXED, and it is the largest thing left open.** The anniversary
  subscription registers `verificationMode:'none'` at a fully deterministic id
  (`insights-anniversary:<tenant>:<principal>`) and the ingest route enforces tenant
  ownership with **no RBAC scope**, so an enabled tenant's low-privilege member can
  guess it and start BYOK-billed LLM runs. **Why it is not fixed here:** the honest
  cure is `verificationMode:'required'` + a signing secret on the BYOK rail + a
  scope on `routes/triggerBridge.ts`. The first two require a per-subscription
  secret-storage decision that does not exist yet, and the third is a change to a
  SHARED route every trigger-using feature passes through — exactly the
  "cross-feature edit smuggled into a scoped PR" ADR 0599 refuses. PR-A's fire-time
  feature gate already narrowed the window (a disabled tenant is now immune).
  Carried forward unchanged, and it is the top row for whoever takes the seam.
- **`GEN-SCHED-1`**, **`ISWF-6`**, **`ISWF-9` (other half)**, **`ISU-4`**,
  **`ISWF-14`** — unchanged from ADR 0599 §9. None is feature-27-local.

### PR-B rows deliberately left open, with the reason

- **`GEN-TRIGGER-SELF-1` (new — §Correction 6).** A chain at
  `audience:'self'` has NO completion surface on the trigger/scheduler lane:
  `host/triggerIngestionService.ts` builds the `RunRecord` with no
  `actingUserId`, so the notify node refuses fail-closed. `talent-prep` and
  `anniversary-draft` both accept that trade rather than broadcast a named
  colleague's score or recognition draft, and `PROBE-IS-10` now asserts the
  refusal on both. The honest cure is the same additive RFC 0013
  produced-variable bag §5 names for `ISU-7`: let the chain CARRY a recipient
  instead of resolving one from the session. Masked today by `ISWF-6`.
- **`ISU-9`** — the arrival announcement is count-only
  (`'{{count}} unread notification(s)'`). Correct as generic infrastructure;
  announcing the TITLE is a shared-notifications product decision, and with `ISU-7`
  bound for talent-prep the body now exists for whoever makes it.
- **`ISU-13`** — chain packs are boot-loaded before features register, so all three
  templates show in the Builder gallery with the feature OFF.
  `listChainTemplates()` is host-global by design ("host-global, authed").
  Filtering it by toggle is a **gallery-wide** semantic change affecting all 58
  chain packs; badging is a design decision. Neither belongs in a feature PR, and
  PR-A already removed the real harm (a template used from the gallery no longer
  fabricates).
- **`ISU-14` / `ISWF-17`** — the config route still has no client, so
  `principalUserId` (required), the cron and the anniversary trigger remain settable
  only by hand-crafted HTTP. This is a genuine gap and the honest cure is a small
  form; it is a NEW SURFACE for a feature whose defining decision is "no page", and
  building one as a side effect of a fix batch would be exactly the kind of
  unrequested scope this ADR refuses elsewhere. **The most valuable open row for a
  follow-on.**
- **`ISU-15`** — every user-visible string is English-only (chain labels,
  notification titles, gate prompts, toggle copy). There is no pack-string
  localization mechanism in this repo, and inventing one is a cross-cutting
  decision. NOT an orphan-key defect: there are no keys at all.
- **`ISU-18` / `ISU-19`** — approval OUTCOME is never announced on the two surfaces
  this feature uses, and `HitlDecisionCard` is the mount-with-content anti-pattern.
  Both are shared chat infrastructure and the report itself could not confirm
  membership in the repo-wide 192-across-153-files cohort. §3 fixed the one
  instance this feature OWNS (the completion card); folding the cohort in belongs
  with the cohort.
- **`ISU-25`** — run detail never renders artifacts; node outputs are raw
  `JSON.stringify` dumps, and `ArtifactPreviewModal`'s key-sniffer matches none of
  the insights output keys. §2's `GateEvidence` is the same renderer registry and
  could be reused, but "put an artifacts panel on run detail" is a new surface on a
  shared page. Unfixed, and now the largest remaining presentation gap.
- **`ISU-26`** — `{}` outputs render identically to no output (`StepList`,
  `RunTimeline`, `RunProvenancePanel` all gate on `Object.keys(...).length > 0`).
  Same family as §1 and genuinely cheap; it is three shared surfaces and it did not
  fit. Named so it is not lost.
- **`ISU-23` server-side terminals** — `WorkflowCompletionCard` still resolves
  terminals from `localStorage`. §4 made the miss HONEST rather than silent;
  resolving from the server needs a proper seam and would pull
  `loadDynamicCatalog` into a 128.5-of-130.0 kB entry chunk.
- **`ISU-24` revision chip** — `getRunRevision`'s `.catch(() => {})` leaves a
  missing chip indistinguishable from a legacy run. Disclosed in-code; the chip's
  absence says nothing about the run's CONTENT, which is why it is ranked below the
  event log and left.
- **`ISWF-19`** — the live registry still serves the chain pack at `1.0.1` against
  repo `1.3.1`. Needs a registry republish, tracked corpus-wide as
  `WF-EM-5`/`WF-EM-18`.
- **`ISC-7` residual**, **`ISC-2` residuals (scale, narrow verdict)**,
  **`GEN-IS-1`**, **`ISU-4` sibling**, **harness fidelity**,
  **`instanceUrlTemplate` declarations**, **`PROBE-IS-9`** — unchanged from
  ADR 0599 §9.

### A note on the tracker's own arithmetic

The UX report's Blocker count is internally inconsistent — the grade table sums to
**7**, the body marks **8** (`ISU-1,-2,-3,-6,-7,-10,-23,-24`). The steward tracker
records both, unreconciled. **This PR does not reconcile it either**, and that is
deliberate: the disagreement is a fact about how the report was written, and
picking a number now would erase it. All eight named rows are dispositioned — five
in ADR 0599, three here (`ISU-6`, `ISU-10`, `ISU-23`) plus `ISU-24` and `ISU-7`.
Ids are non-monotonic (`ISU-23`–`ISU-27` sit inside §6–§7 of the report) and three
rows carry no severity; both are recorded as written rather than renumbered.

## 10. Corrections — the adversarial review found the family INSIDE the fixes

§1's thesis is *"silence makes no claim; a false claim does."* The review found
**four places where a fix in this PR committed a fresh instance of the family it
was closing**, two of them on the highest-stakes surfaces in the app. They are
recorded here as numbered corrections rather than by editing the sections above,
because the reasoning trail is the point.

### §Correction 1 — §2's card made a FALSE claim on the gate that sends email AS the user

`interrupts/ApprovalCard` renders `<GateEvidence>` unconditionally (§2's
deliberate asymmetry). `GateEvidence` read `options` / `artifactId` /
`revisionId` and, finding none, rendered *"Nothing was captured for this gate, so
there is no preview of what you're approving."*

`core.email.send` (`bootstrap/nodes.ts`, ADR 0193) raises `kind:'approval'`,
`profile:'openwop-send-approval'`, with **`data.message = {to, subject,
bodyPreview, html, provider}`** — the exact bytes about to leave the user's
mailbox. None of the three fields. **REPRODUCED before fixing**, rendered text
captured verbatim from the DOM: the sentence above, over a payload holding the
message. Before §2 that card was blind and SILENT. §2 made it blind and WRONG, on
the one gate where the app acts irreversibly as the human.

It also falsified §2's own stated rationale — *"ONE shared component… a second
implementation is how these two drifted apart"* — because the chat card kept a
**private, open-coded copy** of the send-envelope block that `GateEvidence` knew
nothing about. §2 unified the artifact/options lanes and left the highest-stakes
lane duplicated.

**The finding is taken and the reviewer's suggested cure is taken only in part.**
The suggestion was neutral copy whenever `data` carries keys the component does
not understand, with rendering `data.message` flagged as "the fuller fix but a
second surface and a second decision". Both are done, because they close
different halves and only one of them is structural:

1. **The envelope is evidence and it RENDERS.** `gateEvidenceOf` extracts it
   (discriminated on `profile`, exactly as the chat card did — a bare `message`
   on some other gate is not this shape), `hasGateEvidence` counts it, and the
   block renders `to` / `subject` / `bodyPreview` + the provider chip. It wins
   over the gate-preview artifact, which closes the **second shape the reviewer
   named**: `executor.ts` mints a `gate-preview` artifact from `inputsByPort` for
   *every* suspend, not only `core.approvalGate`, so a send gate with upstream
   inputs rendered that JSON under "Under review" while the message stayed
   hidden. The artifact is the node's PORT INPUTS; the envelope is what is
   actually about to be sent. The chat card's private copy is deleted, so §2's
   claim is now true rather than aspirational.
2. **The claim is conditioned on RECOGNITION, not on three fields.** A
   `RECOGNIZED_GATE_KEYS` set names every `data` key the component knows (the
   evidence lanes + the approval envelope's chrome). Any key outside it means
   there IS a payload here that this card cannot render — neutral copy, never
   *"nothing was captured"*. This matters beyond `core.email.send`: **LOW-1's
   mechanism cuts both ways** — `core.interrupt` forwards `config.data`
   **verbatim**, so a pack author can put any payload on an approval interrupt,
   and without this the next one produces the same false claim.

Rendering `data.message` alone would have fixed the instance. The recognition
guard is what stops the class, and it is the half that answers "treat your own
changes with the suspicion you applied to the originals".

*Residual, stated:* `data.message.html` is carried on the wire and is still not
rendered — only `bodyPreview` (the node slices the plain-text body to 4000 chars
for exactly this purpose). Rendering approver-facing HTML from a model-drafted
body is a sanitization decision, not a rendering one. Neither card rendered it
before; neither does now; the difference is that the card no longer claims
nothing was captured while it sits there.

| Witness (`interrupts/__tests__/gateEvidence.test.tsx`) | Sabotage | Result |
|---|---|---|
| a SEND gate renders the envelope and claims nothing was captured | disable the `profile === 'openwop-send-approval'` extraction | **2 reds — the stated blast radius**: one per CARD, which is the point of the witness pair |
| the CHAT card did not lose the envelope in the move (resolved through the real card registry) | same | *(the second of the two above)* |
| an UNRECOGNIZED payload ≠ "nothing was captured" | drop `&& !hasUnrecognizedGatePayload(data)` | **exactly 1 red** |
| a gate that captured NOTHING still says so | *(the polarity half — §2's existing witness, unchanged and still green)* | — |

### §Correction 2 — "§5 strengthens the PII posture" is false as a claim about the PR

**TOOK THE FINDING. REJECTED BOTH CURES, with the mechanism. Corrected the claim.**

The review's chain is right and every link was re-verified here by reading it,
not by agreeing with it:

| Link | Verified |
|---|---|
| `notifications/notify.ts` — a gate naming no approvers keeps the tenant-wide broadcast | the `else { emit(base) }` arm; `recipients` is `null`/empty ⇒ no `recipientUserId` |
| `routes/notifications.ts` — such a row reaches every member | `if (n.recipientUserId && recipient && n.recipientUserId !== recipient) return;` — absent field, no filter |
| `/inbox` → `RenderInterrupt` → `interrupts/ApprovalCard` → `<GateEvidence>` unconditionally | §2's own decision |
| the artifact read needs only `workspace:read` | `features/documents/artifactRoutes.ts` gates on the projection's per-record `workspace:read`, which is in `VIEWER_SCOPES` |
| the gate-preview artifact IS the gate node's upstream inputs | `executor.ts` `persistRunArtifact({ role: 'gate-preview', output: inputsByPort })` |
| for `anniversary-draft` that is the AI-drafted recognition email naming a colleague | the pack: `emailDraft (core.email.draft) → approve (core.approvalGate)` |
| **all 14 `core.approvalGate` nodes across shipped packs declare no approver refs** | **RE-MEASURED: 14 gates in 6 packs, `withRefs = 0`** |

**The claim in the scope note is corrected.** §5 narrowed the two chains'
COMPLETION notifications `tenant → self`; that is a strict narrowing and it
stands. §2 widened what the still-broadcast APPROVAL notification renders. On
`anniversary-draft` the net is not "strengthens".

**One thing the finding leaves implicit, and it matters for ranking:** §2 did
not change REACHABILITY, only DISCOVERY. `runs:read` **and** `artifacts:read`
**and** `workspace:read` are all in `VIEWER_SCOPES`, `loadReadableRun` has no
per-run owner check, and `RunTimeline` already dumps every `node.completed`
payload — which carries `outputs` verbatim (`executor.ts`) — as
`<pre>{JSON.stringify(...)}</pre>`. So any tenant viewer could already read the
draft by opening the run. What §2 changed is that the evidence is now pushed
into every member's inbox one click away instead of waiting behind a JSON dump.
That is a real increase in ambient exposure, and it is not a new authorization
hole. The authorization hole is `GEN-RUNREAD-1`, filed in §9 and unchanged.

### Why gating `GateEvidence` is rejected

It recreates the blind card `ISU-10` closed, on the surface approvers are
routed to. The reviewer says so and is right.

### Why declaring `approverRoleRefs` on the insights gates is rejected

This one looked in-scope — it is this feature's own chain pack, and `notify.ts`
already resolves `approverRoleRefs` through `resolveNotificationRecipients`.
**Measuring it is what killed it:**

- `routes/interrupts.ts assertEligibleApprover` returns `undefined` immediately
  when `requiredApprovals <= 1` — *"not a quorum gate — no eligibility gate"*.
  Both insights gates declare `requiredApprovals: 1`. So `approverRoleRefs`
  there would narrow **who is told** and grant **nobody** the exclusive right to
  decide: any authenticated reviewer could still approve.
- That is **exactly the shape §6 of this same ADR refuses.** `rejectionPolicy:
  "block"` was accepted, read as a deliberate safety choice in a chain a human
  opens in the Builder, enforced nothing at the decision point, and would have
  behaved identically as any other invented word. `approverRoleRefs: ['admin']`
  on a `requiredApprovals: 1` gate is the same sentence with a different noun.
  Shipping it as the cure for the second false claim would author a fifth one.
- And it is **fail-open** besides: `notify.ts` broadcasts when the resolved
  recipient set is empty, and role refs resolve from tenant member rows, which
  the demo / anon / solo-cookie workspaces do not have. The mitigation would be
  absent precisely where it would be measured.

**So the disposition is a statement, not a patch — which is what the review
allowed for if the cures did not hold.** Recorded as a residual below. The two
honest cures both live outside this feature: address interrupt notifications to
`approvals:respond` holders (a shared-notifications change affecting all 14
gates in 6 packs), or close `GEN-RUNREAD-1`. The `recipientRole` filter already
exists in `routes/notifications.ts` and is unused on this path, so the first is
cheaper than it looks — for whoever owns that seam.

**No new witness is claimed for this correction**, because nothing changed in
the code. Asserting a `withRefs === 0` floor would pin the defect rather than
the fix (`docs/steward` "tests that PIN defects"), and asserting the broadcast
would assert the bug. The measurement is recorded above and is re-runnable.

### §Correction 3 — `ISC-12` was not closed, and its tripwire could not see the survivors

**FIXED.** §8 removed the two claims it went looking for. Two more, making the
same promise, were still in the prompt when it shipped:

- `prompts/financial.md` *"If the data is missing or stale, say so plainly **and
  give the 'data as-of' timestamp**"* — the identical promise §8 had just
  removed from the bullet **directly above it**;
- *"…and what to ask about it — **with the source query attached**."* — the
  prompt's **closing sentence**, the last instruction the model reads.

Both ask for something §8 itself establishes the pipeline cannot supply:
`variance-compute` emits eight keys and none of them is a timestamp, a query
reference or a source id.

**The more useful half of the finding is WHY the tripwire was green.**
`PROBE-IS-11`'s reverse direction is
``!new RegExp('`' + claimed + '`').test(prompt)`` — it matches only
**backtick-delimited identifiers**. Neither survivor is one. Its companion
assertion pins three exact historical phrasings, which by construction cannot
see a fourth. So a probe written to close `ISC-12` reported green over a prompt
that still carried it, and `docs/steward/LLM-EXCHANGE-AUDIT.md` recorded
`XCH-IS-1` **CLOSED at grade B** on that evidence. *A ratchet that polices a
spelling is not policing the invariant* — the same lesson `ISC-15` produced in
§7 of this ADR, re-learned one section later on my own probe.

### The instrument is replaced, not widened

The obvious fix — pin the two new phrasings — reproduces the defect exactly: a
fourth pin cannot see a fifth phrasing. And it would not even work here, because
**the corrected prompt QUOTES the phrases it removed** (§8's "corrections are
inline notes, not rewrites" style), so `not.toContain('with the source query
attached')` is now FALSE over an honest prompt. That is the *"assertion window
delimited by a token the content can contain"* vacuity shape this feature has
already produced five times.

So `PROBE-IS-11` gains the **closed world** §7 chose for `ISC-15`: every LINE of
the prompt mentioning a provenance term must be on a reviewed list. A new
occurrence — however phrased — fails until a human reads it and either deletes
it or records why it is a statement of ABSENCE. Reviewing a line is not
window-delimited. Two guards ride with it:

- an **anti-vacuity floor** (≥8 lines must match, or the term list has gone
  inert and the probe would pass by measuring nothing — the "a probe that RAN
  NOTHING reports green" shape);
- a **staleness check in reverse** (a reviewed entry the prompt no longer
  contains is a dead approval, and a list that outlives what it approved is not
  a review).

Its honest bound, stated as §7 stated `ISC-15`'s: the world is closed over a
term list, so a directive phrased with none of those terms is invisible.

`XCH-IS-1` in `docs/steward/LLM-EXCHANGE-AUDIT.md` is **amended in place**
(UPDATED, not restarted): the row is marked wrong-when-written, the two
survivors are added as claims 3 and 4, and the tripwire's blindness is recorded
as the finding. **The grade B stands and was never the disputed part** — the gap
to A− (no runtime schema-request path, no app-state read) is unchanged. What was
wrong was CLOSED.

| Witness (`test/insights-agent-tools.test.ts`) | Sabotage | Result |
|---|---|---|
| every provenance mention is on the reviewed list | append a NEW prose directive (*"Always attach the source query…"*) — a phrasing no pin knows | **exactly 1 red** — and this is the case the old tripwire was structurally blind to |
| the two named survivors are gone as instructions | restore the exact closing sentence | **2 reds — stated**: the closed world AND the named-defect pin, which is the correct pair |
| the instrument is not inert | neuter `PROVENANCE_TERMS` so it matches nothing | **exactly 1 red** (the floor) |

Agents pack `1.1.0 → 1.1.1`; `packs/.steward-manifest.json` regenerated
(ADR 0555 P0 — an unattested pack does not dispatch).

### §Correction 4 — the `secondary` retirement was falsified by this PR's own code

**FIXED.** `chat/WorkflowCompletionCard.tsx` shipped

```ts
const declared = n.outputRole === 'primary' || n.outputRole === 'secondary';
```

so a mid-graph node tagged `secondary` entered `terminals`, and with no
`primary` anywhere it fell through to the "show every terminal" branch and
surfaced as a **"View output" button** — on every workflow in the app, not just
this feature's.

That is precisely the consumer §4 above says it **considered and rejected**:
*"quiet secondary links on every completion card app-wide… a visible behaviour
change for every workflow in the app, requested by nobody, to make one dead
field alive."* It shipped anyway, as a side effect of widening the filter, and
made **three statements false on merge**:

| Statement | Where |
|---|---|
| *"the only consumer tests `=== 'primary'`… a `secondary` tag renders identically present or absent"* | §4 above |
| the retirement docblock | `features/insights-suite/metaWorkflows.ts` |
| *"`outputRole:'secondary'` is AUTHORABLE in the Builder Inspector and rendered NOWHERE in the SPA"* | §9, `GEN-OUTPUTROLE-1` |

It was also an **untested app-wide behaviour change**: §4's four new frontend
cases cover `'primary'` and `undefined` only, so nothing measured the third
value of a three-valued field.

**Cure: `declared = n.outputRole === 'primary'`.** The rule this filter exists
for is "an explicit `primary` outranks graph position" (RFC 0065's canonical
deliverable). `secondary` was never part of that rule, and the reviewer's read
of the intent is correct. The alternative — keep it readable and correct §4/§9
instead — is rejected on §4's own reasoning, which has not changed: it is a
visible app-wide behaviour change nobody asked for, and a feature PR is not
where it belongs. `GEN-OUTPUTROLE-1` stays open, and is now true again.

Re-verified after the fix: `secondary` is authorable (`builder/inspector/
Inspector.tsx`) and round-trips (`schema/serialize.ts`, `deserialize.ts`,
`builderStore` fidelity), and has **no rendering consumer anywhere in the SPA**.

| Witness (`chat/__tests__/terminalOutputRole.test.tsx`) | Sabotage | Result |
|---|---|---|
| a mid-graph node tagged `secondary` is not surfaced, and the graph terminal still wins | restore `\|\| n.outputRole === 'secondary'` | **exactly 1 red** |

The existing `'primary'` and `undefined` cases are the two polarity halves and
stayed green throughout — the fix narrows the filter without re-breaking the
defect §4 closed.

### §Correction 5 — the rewritten manual script claims two things the code cannot do

**FIXED, both.** `ISU-16` exists because a script that states a result the code
does not produce makes a tester file the script's error as a product bug. §7
rewrote `INS-01`–`INS-03` and put two of them in.

**1. `INS-01` step 2 — "a tenant notification arrives with a body".**
**MEASURED by execution**, on the emitted record: `weekly-variance`'s
notification is `message: ""`, `title: "Weekly variance (Actual vs Plan)"`. §5
of this same ADR says so two sections earlier — *"`weekly-variance` and
`anniversary-draft` cannot [bind a body]: their `notify` is fed by a resumed
`core.approvalGate`, which completes `{output: …}` with no top-level string"* —
and `PROBE-IS-10`'s `weekly-variance` case asserts the recipient and the
`actionUrl` and deliberately does not assert a body. The step now says the body
IS empty, why, that it is expected, and that a missing LINK is the defect the
step exists for.

**2. `INS-03` step 2 — "a confirm dialog asks first".** True on
`interrupts/ApprovalCard` and false on `chat/registry/defaultCards.tsx`, which
had no `confirm` import at all — and step 1 puts the tester on chat.

Here the finding is taken and **the script is not the only thing fixed**,
because the script was describing the right behaviour on the wrong number of
surfaces. §7 put the confirm on one card of the pair §2 had *just finished
unifying* — the identical shape as `ISU-10`, one section apart, in the same PR.
The verb is the same on both: a rejected `core.approvalGate` appends
`run.failed` with `approval_rejected` and never resolves the suspend. **A
confirm on one of two surfaces is not a confirm.** So the chat card gets it too,
with §7's polarity preserved verbatim (APPROVE ungated; the ≥2-option "Pick
this" is an approve, so ungated as well), and the script now sends the tester
through BOTH surfaces rather than naming one.

| Witness | Sabotage | Result |
|---|---|---|
| a REJECT on the CHAT card asks first, and a cancelled confirm dispatches nothing | `if (false && action === 'reject' …)` | **exactly 1 red** |
| APPROVE on the chat card is NOT gated (the polarity) | — *(the half that must stay green; §7's stated reason is that friction on the common path is what teaches people to click through)* | — |
| `INS-01`'s empty body | — *(a script correction; the mechanism it now describes is `PROBE-IS-10`'s `weekly-variance` case, unchanged)* | — |

### §Correction 6 — `anniversary-draft` at `self` refuses on its only automated lane, and §5 did not say so

**TOOK THE FINDING. THE TRADE STANDS; THE SILENCE DOES NOT.**

**PROVED by execution** (`PROBE-IS-10`, new case): on a system run
`anniversary-draft`'s notify returns
`{ emitted: false, audience: 'self', reason: 'no_acting_user_on_this_run' }`
and writes no row for anyone.

§5 uses precisely this argument to KEEP `tenant` on `weekly-variance` — *"`self`
resolves from the run's acting user, and its real lane is the RFC 0052
scheduler, where there is none"* — and then applies the opposite conclusion to
`anniversary-draft` in the same section without a word. Its automated ignition
is the ADR 0599 webhook subscription (`ISC-9`), and
`host/triggerIngestionService.ts` builds the `RunRecord` with **no
`actingUserId`** — verified by reading the literal. So on that lane the chain
silently loses its only completion surface. It is masked today by `ISWF-6` (the
trigger lane does not deliver the per-event values the chain needs, so it does
not complete anyway); once `ISWF-6` lands, the notification just never arrives.

**The trade is not reversed.** The alternative is broadcasting a named
colleague's AI-drafted recognition message workspace-wide, which is the exact
harm §5 exists to close, and — per §Correction 2 — a broadcast row now also
routes a card that renders the draft. `tenant` is worse than silence here. What
was missing is the STATEMENT and the probe case, and the honest cure is the same
one §5 already names for `ISU-7`: the additive RFC 0013 produced-variable bag,
which would let the chain carry a recipient rather than resolve one from the
session. Recorded as a residual.

The asymmetry between the three chains is now stated in one place — the pack
description, which is the artifact an operator reads.

| Witness (`PROBE-IS-10`) | Sabotage | Result |
|---|---|---|
| `anniversary-draft` refuses on a system run, fail-CLOSED (no row for anyone) | pack `anniversary-draft.notify.audience: 'self' → 'tenant'` | **exactly 1 red** |

*(The existing `talent-prep` system-run case stayed green under that sabotage,
which is the point: it could not have caught this — it names a different chain.)*

### §Correction 7 — §3's own mechanism, re-committed one section over

**FIXED.** `GateEvidence`'s failed-read branch shipped as

```tsx
<p className="alert error" role="alert">{t('gateEvidenceUnreadable')}</p>
```

a **conditionally-mounted inline live region arriving with its text already
inside** — the exact mechanism §3 spends eleven lines removing from
`CompletionShell`, and which `ui/Notice.tsx` refuses to treat as established in
so many words: *"`role='alert'` … is NOT verified here and MUST NOT be treated
as established — assuming it is exactly the mistake that shipped #2615."*

It carried this PR's most consequential sentence — *"Don't decide from this
card"* — in front of someone about to sign an approval, and **no test asserted
it announced.** Per §3's own measured table, **all four a11y gates are blind to
this shape**, which is why nothing caught it: that table is in this document,
three sections above the line that reproduces it.

The reviewer's suggested cure is the right one and is taken verbatim:
`<Notice variant="error" announce={…}>` — the house primitive already on this
surface, which delegates to ADR 0363's `GlobalLiveRegion` (mounted once at
`App.tsx`, so it exists long before any message) and drops its own region, so
the DS-8 double-announce is impossible by construction rather than by rule.

| Witness (`interrupts/__tests__/gateEvidence.test.tsx`) | Sabotage | Result |
|---|---|---|
| a failed evidence read ANNOUNCES, assertively, through the global region | revert to the hand-rolled `<p role="alert">` | **exactly 1 red** |
| a SUCCESSFUL read announces NOTHING (the polarity — no double-announce) | — *(the half that must stay green)* | — |

`GEN-A11Y-5` (§9) is unchanged and is now better evidenced: a fifth ratchet
would have caught this one, and none of the four did.

### §Correction 8 — a decorative guard, in the component §1 built to delete them

**FIXED.** `streams/EventReadState.tsx` shipped
`if (events.length > 0) return null;` — **unreachable**, because both callers
(`streams/EventStreamView`, `runs/RunTimeline`) branch on `events.length === 0`
one frame up before mounting it. Same class as the `prev === 'ready'` catch
guard §1 deletes and makes a point of, in the component §1 introduced.

The `events` prop goes with the guard: a parameter whose only use was an
unreachable branch is not an input, and leaving it would keep the guard looking
like the thing that holds the property. The property is real; **the CALLERS hold
it**, and the witnesses say so and measure it through the views.

| Witness (`runs/__tests__/eventReadHonesty.test.tsx`) | Sabotage | Result |
|---|---|---|
| TIMELINE: events in hand outrank the read flag | remove `RunTimeline`'s own `events.length === 0` branch | **exactly 1 red** |
| LOG: the same on the other view (they must not drift) | remove both callers' branches | **2 reds, one per view — the stated pair** |

### §Correction 9 — `core.approvalGate` is not the only WRITER of `rejectionPolicy`

**FIXED.** §6 said the refusal sits on *"the ONE choke both authoring lanes pass
through"*. **That is true of the NODE and false of the FIELD.**
`bootstrap/nodes.ts`'s `core.interrupt` forwards `config.data` **verbatim**, and
both readers (`reviewDecisionLedger.tallyVote`, `host/reviewProjection`) pull
`data.rejectionPolicy` off an approval interrupt without asking which node
raised it. So the exact defect §6 closed stayed authorable — **through the pack
lane, which is the lane `rejectionPolicy:"block"` actually shipped through.**

**Blast radius measured before enforcing**, as §6 itself did: **zero**
`core.interrupt` nodes carry a `rejectionPolicy` anywhere in the repo; the one
fixture that uses the node
(`conformance-fixtures/conformance-interrupt-external-event.json`) is
`kind:"external-event"` and has none.

**One rule, not two copies.** The refusal moved into
`refuseUnknownRejectionPolicy(typeId, value)` in `reviewDecisionLedger.ts` and
both nodes call it — §6 already collapsed the two READERS into one helper for
exactly this reason, and hand-copying the writer guard would have set up the
same drift on the other side. The message names the refusing node.

**Not gated on `kind === 'approval'`, deliberately:** `reviewProjection` reads
the field without consulting the kind, and the field is meaningless on the other
kinds anyway — so refusing there costs a pack author nothing and closes the lane
completely rather than for one value of a discriminator.

| Witness (`test/approval-rejection-policy-vocabulary.test.ts`) | Sabotage | Result |
|---|---|---|
| `"block"` through `core.interrupt`'s verbatim `data` lane is a typed failure | drop the guard from `interruptNode` | **2 reds — the stated pair**: the approval-kind case AND the not-gated-on-kind case, which are two distinct claims |
| every legal token still suspends; so does an interrupt with no policy, a non-object `data`, and an absent `data` | — *(the polarity — a refusal that also refuses the legal values is not a fix)* | — |

### §Correction 10 — `ISC-15`'s closed world was closed over NODES and open over CHAINS

**FIXED.** §7 built the never-send guarantee as a closed world over node typeIds
— *"a new node, however spelled, fails until someone puts it on the list"* — and
drove it from a **hardcoded three-element array of chain definitions**. A fourth
chain added to the pack would never be walked, so a send-capable node inside it
would clear the gate unseen. The anti-vacuity floor did not help: it is
`checked > 9`, and 3 chains carry 13 nodes while **2 still carry 10**, so the
gate tolerated silently LOSING a whole chain.

The chain set is now **derived from the loaded pack registry** (`listChains()`
filtered to `core.openwop.workflows.insights-suite`), and the chain COUNT is
asserted exactly, so adding a chain is a red that makes the author confirm its
nodes are reviewed rather than discovering later that they never were.

| Witness (`test/insights-suite-governance.test.ts`) | Sabotage | Result |
|---|---|---|
| every node in every chain is on the reviewed allowlist | add a FOURTH chain to the pack carrying `core.openwop.integration.email-dispatch` | **exactly 1 red**, naming the node — **and the hardcoded three-element version is measurably GREEN over the same pack**, which is the finding |
| the pack declares exactly `EXPECTED_INSIGHTS_CHAINS` | *(the losing-a-chain direction the node floor could not see)* | — |

### §Correction 11 — `ISU-8`'s deep link is app-wide, and that trade was not stated

**TOOK THE FINDING. NO CODE CHANGE — the statement is the fix.**

§5 says *"`ISU-8` closes for EVERY chain, not just this feature's"* as a
benefit, and it is one: before it, every workflow notification dead-ended on the
bell drawer and the dashboard tile. **RE-MEASURED: 53 `audience:"tenant"`
notifier declarations across the shipped packs**, matching the review's count.
All 53 now carry `actionUrl: /runs/<id>` into the bell, the tile, the OS toast
and web push.

**This is not an authorization change** — `runs:read` was already in
`VIEWER_SCOPES` and `loadReadableRun` already had no per-run owner check, so
every one of those runs was already openable by every tenant viewer. What
changed is that a latent hole is now one click from four ambient surfaces
instead of behind a URL nobody had. `GEN-RUNREAD-1` (§9) is where that gets
closed, and it is correctly out of feature-27's scope.

**The trade is still taken**, for the reason §5 gives: a notification that
cannot reach what it is about is not a notification, and withholding the link
would not withhold the access. But "closes for EVERY chain" was written as
unqualified good news, and it moved 53 notifiers at once. Both halves belong in
the record, and now are.

## 11. Implementation record

| § | Row(s) | Commit | Verification |
|---|---|---|---|
| Reservation | — | `25c24262f` | `check-adr-refs --reserve` |
| §1 | `ISU-24` | `f76231ccd` | 9 witnesses; 5 sabotages (2×1 red, 1×3, 1×5, **1 GREEN and stated**); `npm run build` green |
| §3 | `ISU-27` | `3013fc67e` | 6+3 witnesses; 5 sabotages; **all four a11y gates measured blind** |
| §2 | `ISU-10` | `911928e9d` | 6 witnesses; 3 sabotages (5/1/1 reds); build green |
| §4 | `ISU-23`, `ISWF-12`, `ISWF-18` | `84ca3285b` | `PROBE-IS-8` + 4 FE witnesses; 6 sabotages, all 1–2 reds; `check-test-types` 172 |
| §6 | `ISU-11`, `ISC-13`, `ISWF-13` | `9cf91c8e2` | 7 witnesses; 4 sabotages; 46 approvalGate suites / 581 tests green |
| §5 | `ISU-6`, `ISU-7`, `ISU-8` | `fd7919793` | `PROBE-IS-10` (3); 3 sabotages; 40 notification suites / 546 tests green; pack `1.2.0→1.3.0` |
| §7 | `ISC-15`, `ISC-14.3` | `a0878d3bd` | 3 sabotages, 1 red each; the old guard measurably green on the same case |
| §7 | `ISU-12`, `ISU-20` | `00735595c` | 3 witnesses; 2 sabotages, 1 red each; build green |
| §8 | `ISC-12` | `9be23e499` | `PROBE-IS-11` (2); 3 sabotages, 1 red each; agents pack `1.0.1→1.1.0`; `XCH-IS-1` filed |
| §7 | `ISU-16` | `b9fb5fd44` | `tsc` 0; manual-tests suite green; build green |
| §9 + record | — | `117be4967` | `check-adr-refs` 0 |

### The corrections round (adversarial review of the eleven commits above)

The review found **four places where a fix committed a fresh instance of the
family it was closing**, two of them on the highest-stakes surfaces in the app,
plus four smaller rows. Every one was reproduced before it was touched.

| § | Row | Commit | Disposition | Verification |
|---|---|---|---|---|
| §Correction 1 | HIGH-1 — the card claimed "nothing was captured" over an email about to be sent AS the user | `530647340` | **FIXED**, cure taken in full + extended | reproduced RED first (rendered text captured verbatim); 3 witnesses; 2 sabotages (**2 reds — one per card**; **exactly 1 red**); build green |
| §Correction 2 | HIGH-2 — "§5 strengthens the PII posture" is false; the approval notification is still a broadcast | `84e8e3301` | **TOOK FINDING, REJECTED BOTH CURES**, claim corrected | every link re-verified by reading; **14/14 gates re-measured with zero approver refs**; no witness claimed, and why |
| §Correction 3 | HIGH-3 — `ISC-12` not closed; the tripwire cannot see prose | `0f1e96929` | **FIXED**, instrument REPLACED not widened | 2 witnesses (closed world + floor); 3 sabotages (**1 / 2 stated / 1**); agents pack `1.1.0→1.1.1`; `XCH-IS-1` amended in place |
| §Correction 4 | MEDIUM-1 — the `secondary` retirement falsified by this PR's own code | `07c1b2e80` | **FIXED** | reproduced RED first; 1 witness; **exactly 1 red**; the two polarity halves green |
| §Correction 5 | MEDIUM-2 — the manual script promised an empty body and a confirm on one card of two | `03fc82e84` | **FIXED**, script AND the missing surface | `weekly-variance` `message: ""` MEASURED by execution; 2 witnesses; **exactly 1 red** |
| §Correction 6 | MEDIUM-3 — `anniversary-draft` at `self` refuses on its only automated lane | `9f23eea51` | **TOOK FINDING**, trade kept, silence fixed | PROVED by execution; 1 witness; **exactly 1 red** (the `talent-prep` case green — it names a different chain); chain pack `1.3.0→1.3.1` |
| §Correction 7 | MEDIUM-4 — §3's own live-region mechanism, re-committed by §2 | `48d74dc81` | **FIXED**, reviewer's cure taken verbatim | 2 witnesses; **exactly 1 red**; the no-double-announce polarity green |
| §Correction 8 | LOW-4 — a decorative guard in the component §1 built to delete them | `48d74dc81` | **FIXED** | 2 witnesses; **exactly 1 red** per caller guard, **2 reds** for both |
| §Correction 9 | LOW-1 — `core.interrupt` is a second `rejectionPolicy` writer | `885ba3a68` | **FIXED**, one shared rule | blast radius **zero** measured first; 2 witnesses; **2 reds — the stated pair** |
| §Correction 10 | LOW-2 — the `ISC-15` closed world was open over CHAINS | `885ba3a68` | **FIXED** | **exactly 1 red** on a synthetic fourth chain, **and the hardcoded version measurably GREEN over the same pack** |
| §Correction 11 | LOW-3 — `ISU-8`'s deep link is app-wide | `885ba3a68` | **TOOK FINDING, statement is the fix** | **53** tenant-audience notifiers re-measured; no code change, and why |

**Nothing was found green that the review called red.** The one place the
finding needed amending is recorded in §Correction 2: §2 changed DISCOVERY, not
REACHABILITY, because `runs:read` / `artifacts:read` / `workspace:read` are all
already in `VIEWER_SCOPES` and `RunTimeline` already dumps every
`node.completed` payload as raw JSON. That ranks the row; it does not retire it.

**Gates run:** frontend `npm run build` (the canonical gate — `tsc --noEmit` + all
25 token/CSS/a11y/i18n integrity checks + `vite build` + the built-CSS, bundle-budget
and CSP checks), `scripts/check-test-types.mjs` (172, ratchet holds), backend
`tsc --noEmit`, `scripts/check-pack-version-bump.mjs`,
`scripts/gen-steward-manifest.mjs --check`, `scripts/check-adr-refs.mjs`, and
targeted vitest across the insights, approval/interrupt, notification, chain, pack,
runs, streams, chat, interrupts and builder suites (the largest single selection was
46 files / 581 tests over every suite mentioning `approvalGate`).

**Gates run in the corrections round:** frontend `npm run build` (EXIT=0,
checked explicitly — the canonical gate), `scripts/check-test-types.mjs` (172,
ratchet holds — it caught two new type errors in my own tests and both were
fixed rather than baselined), backend `tsc --noEmit` (0),
`scripts/check-pack-version-bump.mjs`, `scripts/gen-steward-manifest.mjs
--check` (regenerated for the agents-pack bump), `scripts/check-adr-refs.mjs`,
and targeted vitest: 102 frontend files / 655 tests across `src/runs`,
`src/streams`, `src/interrupts`, `src/chat`; 122 files / 851 tests across
`src/chat` + `src/builder`; and 46 backend files / 589 tests across every suite
mentioning `approvalGate` or `core.interrupt`.

**Gates NOT run (and not claimed):** `npm run ci` (the parent session owns that
fleet; a second one starves both — CLAUDE.md's measured worker-starvation note),
the FULL backend vitest suite (started once, **deliberately stopped** for the same
reason — targeted selections were used instead), backend lint, Playwright e2e, the
live testcontainer adapters, and any live browser check.
