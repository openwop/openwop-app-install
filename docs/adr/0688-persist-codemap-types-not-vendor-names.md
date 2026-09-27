# ADR 0688 — persist the codemap type, not a vendor spelling of it

Status: Accepted (implemented; see § Implementation record)

## Context

ADR 0682 moved five squatting event types under the registered `openwop-app`
org. The steward (`openwop-1`, crosstalk `f852`) ruled that one of the five was
the wrong destination, and enumerating the class here found a second.

**The ruling, verified against this repo before acting on it:**

| claim | measured |
| --- | --- |
| `output.chunk` is a real codemap type | `{v1: output.chunk, v2: output.chunk, payloadDef: outputChunk}` ✓ |
| it is in the normative `_typeIndex`; `ai.message.chunk` is not | ✓ / ✓ |
| RFC 0094 §D single-sources the `ai.message.chunk` payload to `outputChunk` | the payload's own `description` says so ✓ |
| this host persists the frame name where the type belongs | `grep "output.chunk" backend/typescript/src` → **zero hits** ✓ |

The deciding line is the one neither side had quoted: `spec/v1/run-options.md`
§`stream-text` — a provider REQUIRED for v1.0 conformance — *"Emits `output.chunk`
events one at a time with the configured cadence, then completes the AI activity
with a normal terminal chunk (`isLast: true`)."* There is no reading where the
canonical streaming baseline emits one type and hosts persist another.

So the shape is **one persisted type (`output.chunk`), one SSE frame name
(`ai.message.chunk`), one shared payload (`outputChunk`)**, and this host had
been persisting the frame name.

### The second instance, which the ruling reaches but did not name

Checking all five renamed types against the codemap rather than only the flagged
one: `node.interrupt.resolved` (17 rows) has the same defect. **`interrupt.resolved`
is a codemap type** with `payloadDef: interruptResolved`.

It is worse than the chunk case, because this host was **already emitting the
protocol type thirty lines away in the same function**. `routes/interrupts.ts`,
inside `resolveAndResume`:

| path | type | payload |
| --- | --- | --- |
| reject (`:1108`) | `interrupt.resolved` — *"RFC 0093 §D.1 shape — the standard interrupt.resolved"* | `{interruptId, kind, outcome: 'rejected'}` |
| accept (`:1137`) | `openwop-app.node.interrupt-resolved` | `{interruptId, kind}` |

One fact, two spellings, **split by outcome**. A conformant v2 reader tailing a
run sees every rejection and is blind to every acceptance. Nobody chose that —
the accept branch never got the review the reject branch got, and ADR 0682 then
handed it an org.

### Two reader defects underneath, one of them mine from yesterday

Five SPA call sites matched this event by hand, and all five matched the same
single spelling. That hid two things:

1. **Every REJECTED interrupt was invisible to the SPA, and still is on `main`.**
   The reject path has emitted `interrupt.resolved` all along and no matcher
   named it. `RunAnalyticsPanel` counted accepts and labelled the number
   "interrupts resolved"; `RunDetailPage` never refreshed on a rejection; the
   builder left the node showing suspended. This predates ADR 0682 — the
   split-by-outcome writer is what hid it.
2. **ADR 0682 orphaned the 17 historical rows from those same matchers** by
   renaming the writer without touching them. A run's event list is history;
   dropping a spelling from a matcher is a silent deletion from every view built
   on it. (The 967 chunk rows were unaffected: `streamDeltaFromEvent` drops
   anything with `sequence <= startSeq`, so it never read old rows anyway —
   checked rather than assumed, and it is the only reason that rename was free.)

## Decision

**Persist the codemap type wherever one exists for the fact being recorded.**

- `openwop-app.ai.message-chunk` → **`output.chunk`** (4 emit sites)
- `openwop-app.node.interrupt-resolved` → **`interrupt.resolved`** (1 emit site),
  so both outcomes of `resolveAndResume` now spell the fact the same way
- **One shared reader predicate** (`chat/lib/interruptResolvedEvent.ts`) matching
  the codemap name plus both legacy spellings, used by all five call sites. It
  fixes the invisible rejections and restores the orphaned rows in one place,
  rather than five hand-maintained lists that already drifted once.
- **No in-place rewrite of the 967 or the 17.** The line held for the 376 in
  ADR 0674 and endorsed by the steward: the rows stay as written and refuse at
  contract 2, which `persistence.md` says is correct for a log nobody can
  translate.

### The field that is not there

The accept path's new payload deliberately does **not** carry `outcome`, despite
both sibling emitters doing so. `interruptResolved` is
`additionalProperties: false` and declares **`decision`** (`granted | rejected |
overridden`), not `outcome`. So:

- `routes/interrupts.ts:1109` emits `outcome: 'rejected'` — undeclared
- `executor/approvalGateTimeout.ts:104` emits `outcome: 'rejected'` **and**
  `reason: 'timeout'` — both undeclared

Both cite *"RFC 0093 §D.1 shape — the standard interrupt.resolved"* while
emitting fields the closed schema forbids. **I was one step from copying that
shape onto a third site**, which is how a defect propagates by citation — the
sibling is the documentation.

Not fixed here, deliberately. No reader consumes these fields (measured: every
hit for `interrupt.resolved` outside an emitter is a comment or the unrelated
`interrupt.resolvedAt` record field), so nothing is broken today. But
`reason: 'timeout'` is real information the corpus has no slot for, and dropping
information to satisfy a schema is a loss, not a fix. That is a question for the
steward and possibly an RFC, not something to decide inside a rename. Raised on
the bus; tracked, not silently normalised.

## Alternatives weighed

| option | why not |
| --- | --- |
| **Leave ADR 0682's names** | They are legal under ADR 0687's registration gate, which is exactly the problem: legal means they pass through **uninterpreted by design**, so two protocol facts get a permanent exemption from being understood. |
| **Rewrite the 967 + 17 rows in place** | The event log is the replay substrate; rewriting a `type` column changes what a `:fork` replays. Held the same line as ADR 0674. |
| **Widen each of the five matchers by hand** | That is the arrangement that produced this bug. Five copies of an authorization-shaped predicate drift, and this one already had. |
| **Emit both the codemap name and the vendor name** | A dual-emit doubles the rows and leaves readers to pick; the frame-name/type distinction is exactly what was misunderstood, and dual-emitting enshrines the confusion. |

## Implementation record

| phase | change | witness |
| --- | --- | --- |
| P1 | chunk writers → `output.chunk` (4 sites + comments) | `ai-providers`, `conversation-exchange` |
| P2 | interrupt accept path → `interrupt.resolved` | `approval-gate-reject-blocks`, `parallel-resume-race`, `connection-interrupt` |
| P3 | shared `isInterruptResolvedEvent`, 5 call sites | `interruptResolvedEvent.test.ts` + sabotage |
| P4 | `streamDeltaFromEvent` accepts the skew spellings | `conversationTransport.test.ts` |
| P5 | ADR 0682 correction note; current-state docs | `check-adr-refs` |

**Deploy-skew tolerance, and why it is not history.** Backend and frontend ship
as separate deploys, so there is a window each way where the running backend
emits one spelling and the loaded SPA expects the other — and what is lost in
that window is a live reply's streaming bubble, the one thing a user watches.
`streamDeltaFromEvent` therefore accepts `output.chunk`, `openwop-app.ai.message-chunk`
and `ai.message.chunk`. Those two extras earn their place from the skew window
alone, not from history, and can be deleted once one full deploy has settled.

**A control that would have stopped being a control.** ADR 0687's
discrimination leg seeded `openwop-app.ai.message-chunk` as its *registered
vendor pass-through* example. Moving that type to `output.chunk` would have left
the leg asserting pass-through on a type the codemap **names** — measuring
translation and calling it pass-through, green throughout. Re-pointed at
`openwop-app.node.message`, verified absent from the codemap in both directions.

## The transferable part

**A correct fix shipped beside an incorrect one gets the incorrect one merged.**
ADR 0682's namespace finding was right and acting on it was right; that is what
carried a classification error through review under the same number. The
question the ADR never asked was per-type: *does the protocol already have a name
for this?* It asked only *is this namespace ours?* — and a uniform answer to the
second question looks like thoroughness.

**ADR 0687 is what converted the error from inert to load-bearing.** Before the
registration gate the vendor branch accepted anything, so the choice of vendor
name turned on nothing. Making that branch honest is what gave these two names a
principled exemption from translation. A gate can be correct and still be the
thing that makes a prior mistake permanent — which is an argument for auditing
what a new gate now *admits*, not only what it now *rejects*.
