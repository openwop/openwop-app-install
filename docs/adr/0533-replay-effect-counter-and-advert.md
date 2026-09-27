# ADR 0533 — counting what the event log cannot see: the replay effect counter, the widened seam set, and the `recorded-outcome` advert

Status: implemented (2026-08-08)

Supersedes nothing. Extends ADR 0341 (classification fast path) and ADR 0531
(default-deny seam guard). Implements the host half of **RFC 0140**
(`spec/v1/replay.md` §"Side-effect suppression in replay").

## Context

RFC 0140 repaired a defect in v1: `replay.md` caveat 1 has always required,
unconditionally, that a replayed run not call an external system twice — but it
discharged that requirement by delegating to `idempotency.md` Layer 2, whose key
includes `runId`. A fork mints a new `runId`, so the named mechanism provably
cannot deliver the guarantee it is named for. An implementer who followed the
spec literally shipped a host that re-sends the email and believes it is
conformant.

RFC 0140 replaced the broken delegation with a mechanism that works, and added
`replay.sideEffectSuppression` so a peer can interrogate it across a federation
boundary. Its rule 5 sets the bar for advertising `"recorded-outcome"`:

- **(a) classification** short-circuits known side-effecting nodes before they
  execute and serves the source run's recorded outcome — this keeps a replay
  **correct** (ADR 0341);
- **(b) a default-deny guard at every host effect seam** fails closed for
  anything the classifier missed — this keeps a replay **safe** (ADR 0531).

Rule 5 is explicit that (a) alone MUST NOT be advertised as `recorded-outcome`.

Three things stood between this host and an honest advert.

**1. The guard was not at "every host effect seam" — it was at three.** ADR 0531
shipped `assertEffectAllowed()` with exactly three call sites: `brokeredEgress`,
`smtpEgress`, and the notification emitter. A seam sweep of the tree found
roughly twenty-five further *node-execution-reachable* outbound paths that
bypassed all three. The largest cluster converges on
`webhookEgressGuard.ts` — `ctx.http.safeFetch` (`connectionInjection.ts`), the
A2A surface, MCP tool invocation, web research, both sandbox adapters, the image
provider adapter, third-party calendar writes, and cross-host peer fan-out all
reach the network through it. Outside that cluster sat the sharpest edges in the
codebase: Stripe charges, UCP merchant purchases, and cross-host sub-run
dispatch, each on a bare `fetch`. Advertising `recorded-outcome` against a
three-seam guard would have been exactly the dishonest claim RFC 0140 rule 5
exists to prevent.

**2. There was no way to *observe* suppression.** This is the crux, and it is
why the RFC ships a conformance seam at all. A replayed side-effecting node that
fires and records its outcome identically to the source produces an event log
**byte-indistinguishable** from one that was correctly suppressed. Every
existing replay scenario — `replay-fork.test.ts`, `replayDeterminism.test.ts`,
`replay-fork-arbitrary.test.ts` — asserts on the event log, so all three pass
green against a host that re-sends the email on every replay. The only way to
tell the two apart is to count effects **outside** the log.

**3. `node.failed` payloads were schema-invalid.** `run-event-payloads.schema.json`
§`nodeFailed` lists `nodeId` as REQUIRED **in the payload**. The executor emitted
it only on the event envelope, at all seven emission sites. Nothing noticed,
because every in-tree consumer reads the envelope. The RFC 0140 scenario reads
payloads — it attributes a failure to a node — so it could not find the
`replay_source_missing` failure it was looking at.

## Decision

**1. Widen the guard to the real chokepoints, narrowest-set-first.**

`assertEffectAllowed()` moves into `webhookEgressDispatcher()` rather than
`guardedEgressFetch()`. That looks like the wrong function — it is a *getter* —
and it is deliberate. `guardedEgressFetch` is the documented chokepoint but not
the only one: six modules call `undiciFetch` directly and reach the same SSRF
posture by passing this dispatcher. Every one of them, and `guardedEgressFetch`
itself, calls the getter **inline in the fetch init, exactly once per outbound
request**. So the getter is where ~20 egress paths actually converge, and one
guard call there covers all of them — including `ctx.http.safeFetch` and MCP
tool invocation, the two a pack node can reach most easily.

The invariant this rests on is that no call site hoists the returned `Agent`
into a module-level constant; a hoist would keep the SSRF posture while silently
losing the replay guard. `test/run-effect-context.test.ts` scans source for that
shape, so the invariant is enforced rather than hoped for.

> **CORRECTION 2026-08-15 — `ctx.http.safeFetch` was never covered by this
> getter, and the enforcement was not enforcement.** Both halves of the two
> paragraphs above were false about the one path they named as most important.
>
> `connectionInjection.ts` does not pass `webhookEgressDispatcher()`. It builds
> its own Agent via `makeGuardedAgent()` — which shares the **SSRF** posture and
> not the **replay** guard — and hoists it into a module-level `safeFetchAgent`.
> So `ctx.http.safeFetch`, named here and in "Alternatives weighed" as the path
> the design exists to cover, was the one path it did not cover.
>
> The scan did not catch it because it tested a *syntactic proxy* for the
> property: it matched `const x = webhookEgressDispatcher()`, and this site
> hoists an Agent from a different factory. Green throughout. This is the
> recurring shape — a gate pinned to a shape rather than to the property, which
> is indistinguishable from a gate that never ran.
>
> **What was exposed, counted rather than assumed.** Ten `core.openwop.http.*`
> nodes declare `role: "side-effect"` in `packs/core.openwop.http/pack.json`,
> route through `ctx.http.safeFetch`, and were absent from
> `SIDE_EFFECTING_TYPE_PATTERNS` (only `http.fetch` was listed). A replay fork
> re-executed all ten with neither the fast path nor the backstop in the way.
>
> **Of those ten, exactly one ships in a chain**: `openapi-call`, referenced by
> four chain packs (`people-hr`, `data-ops`, `exec-ops`, `marketing`). It issues
> an arbitrary REST call — POST/PUT/DELETE included — against the tenant's own
> API, so the live blast radius is real but is that node. The other nine are
> reachable only through a user-authored workflow; they are in the builder
> catalog, so "not shipped in a chain" is not "unreachable", but it is also not
> a fired effect.
>
> I first wrote this note claiming `graphql-mutation` and `upload-multipart`
> "fired for real, a second time". That was an unverified consequence stated as
> a finding — neither appears in any in-tree chain. Counting the references took
> one command. Recording the error rather than quietly fixing the sentence,
> because it is the same class as the docblock this note corrects: a claim
> asserted at the strength I wanted it to have.
>
> The ADR 0563 blob-put class, on a wider path, with *both* mechanisms absent
> rather than one.
>
> **Fixed** by putting the guard in `connectionInjection.ts`'s own
> `safeFetchDispatcher()` (the getter, called inline per request — the Agent
> stays cached, the guard does not), adding the ten typeIds so replay *serves*
> the recorded outcome rather than throwing, and rewriting the tripwire to bind
> the property: every function supplying a `dispatcher:` in a fetch init must
> reach `assertEffectAllowed`, resolved through imports, with a vacuity
> assertion so a rename cannot make it green-by-inspecting-nothing.
>
> The "Subclass undici's `Agent` and guard inside `dispatch()`" alternative
> below is worth revisiting on this evidence: it is the option that survives a
> hoisted agent structurally, and a hoisted agent is exactly what happened.
>
> Found while deriving the replay.md requirement-4 manifest floor — by reading
> `connectionInjection.ts` instead of the docblock that described it.

Four seams outside that cluster are guarded individually, because they are on
bare `fetch` and have no shared helper: Stripe requests and off-session payment
intents (`payment`), UCP merchant calls (`payment`), and sub-run dispatch
(`dispatch` — RFC 0140 rule 6 makes a peer dispatch an external side effect by
definition). `EffectKind` grows `payment`, `dispatch`, and `blob-write` so a log
line names the seam that refused.

**2. Count at the guard, not near it.**

`host-sample-test-seams.md` §20 requires the counter to sit at the **same** seam
as the rule-5(b) guard: "a counter placed anywhere else measures a different
thing than the guard protects, and a green scenario would prove nothing about
the guard." So the counter is one call on `assertEffectAllowed`'s **allow**
branch, in the same file. Adding a guarded seam therefore also adds it to the
count; there is one call site for both, so they cannot drift.
`GET /v1/host/sample/replay/effect-count?runId=…` is a pure reader holding no
counting logic of its own.

It counts an effect the guard let through — one that actually left. §20's
"counts effects attempted at the seam, not effects that succeeded upstream" is
about the far end: a fired-then-failed outbound call still counts, "because the
observable escape already happened." A guard-**denied** attempt is the opposite
case: nothing escaped, so counting it would report an effect that provably did
not occur and would red the scenario against a host whose backstop worked
exactly as specified.

**3. Emit `nodeId` in the `node.failed` payload** at all seven sites. Additive;
the envelope field is unchanged.

**4. Advertise `replay.sideEffectSuppression: "recorded-outcome"`** — now that
both halves of rule 5 hold.

## Dispositions — seams deliberately NOT guarded

Each is a decision with a reason, not an omission. The reasons differ.

| Seam | Why not guarded |
|---|---|
| `host/obligationLedger.ts` `accrue()` | Replay-idempotent by a deterministic `rowKey` (first-write-wins). RFC 0140 §"Implementation notes" says this in as many words: deterministic keying is **stronger** than fail-closed, and a guard would turn a correct no-op into a throw. |
| `host/capabilityToken.ts` `mintToken()` | A pure generator, not an effect. Non-deterministic under replay, but the residue is unused rows, not an outward effect. Guarding it would guard the wrong function. |
| `providers/dispatch*.ts` (LLM / image / video / speech), `geminiFileApi.ts` | **Exempt by rule, not by oversight.** RFC 0140 rule 4 *requires* LLM calls to re-execute live, served from the invocation log via the content-addressed key that survives a fork (ADR 0326 P3a/b). Guarding them would fail-close the very nodes the spec requires to stay live and make RFC 0041 divergence detection vacuously green — a broken guarantee that reports success. |
| `routes/webhooks.ts` `deliverToSubscribers` | **RESOLVED 2026-08-18 (H72) — see the correction note below.** Originally: a host-level projection of the replay run's own events, not a node's effect; it fires from `eventLog.append`, there is no node to fail closed, and *"a replay is a distinct run whose events are genuinely new"*. It is also invoked from a best-effort subscriber whose throws `eventLog.ts` catches and discards, so a guard would suppress **silently** rather than fail loudly — the fail-open shape ADR 0531 exists to remove. |
| `host/blob/s3Blob.ts` `put`, `search/openSearchSearch.ts` | Node-reachable and unguarded. Left for a follow-up; recorded here so the gap is visible rather than implied by silence. |
| Route / daemon / startup fetches (webhook delivery worker, OAuth + SAML, JWKS, pack registry installer, messaging bridge, voice realtime) | Not reachable from a node execution, so no ambient context exists and the guard is a no-op by construction. Deferred effects are safe because the guard fires at **enqueue**, inside the run's context. |

## Consequences

**What the witness proves.** Both legs of
`replay-side-effect-suppression.test.ts` run non-vacuously against a booted host
under `OPENWOP_REQUIRE_BEHAVIOR=true`: the source run fires exactly one counted
effect, the `mode:"replay"` fork completes reproducing the source's recorded
outputs with **zero** effects, and a replay reaching a node the source never
recorded fails closed with `replay_source_missing` and still fires nothing.

**What it does not prove, stated because rule 5 turns on it.** The two
mechanisms **mask each other** under this fixture pair. `conformance.effect.emit`
is both classified (rule 5a) and guarded (rule 5b), so removing either one alone
leaves the scenario green — the survivor covers for the casualty. Only removing
both reds it. That is a real limit of the fixture design, not of the
implementation: the guard's independent witness is
`test/run-effect-context.test.ts`, which drives an **unclassified** node into a
replay and asserts it fails closed without notifying a second time.

**Coverage remains a property of the seam set, not of the counter.** The counter
observes the paths the host routes through the guarded seam; a leak through an
unguarded path is invisible to the counter *and* to the suite. That is precisely
why RFC 0140 rule 5 mandates a default-deny guard rather than an enumeration —
and why the dispositions table above is written out in full rather than left to
be rediscovered.

**AsyncLocalStorage limit, inherited from ADR 0531.** The context propagates
through `await` but not across a process/worker boundary. Pack nodes execute
in-process today, so they inherit it. If pack execution moves out-of-process
(RFC 0035 sandbox, RFC 0008 WASM ABI) the guard degrades **silently** to no
guard, and the widened seam set makes that failure larger, not smaller. The
pack-shaped tripwire test in `test/run-effect-context.test.ts` is what goes red.

## Alternatives weighed

- **Guard `guardedEgressFetch` only** — rejected: leaves `ctx.http.safeFetch`
  and MCP tool invocation unguarded, which are the paths a pack node reaches
  most easily. A guard that misses the pack path misses the drift case the
  whole design is about.
- **Subclass undici's `Agent` and guard inside `dispatch()`** — structurally
  stronger (survives a hoisted agent), rejected for now: `dispatch()` reports
  errors through a handler rather than by throwing, so a synchronous throw there
  has unclear semantics. The source-scan tripwire buys the same protection
  without the risk.
- **Count in the seam route** — rejected by `host-sample-test-seams.md` §20: a
  counter that is not co-located with the guard measures something the guard
  does not protect.
- **Count guard-denied attempts too** — rejected: it would report effects that
  never escaped and red the scenario against a conformant host.
- **Advertise now, widen the seam set later** — rejected as the precise failure
  RFC 0140 rule 5 names. A partial guard advertised as `recorded-outcome` is a
  dishonest capability claim.

## Phase record

| Piece | Landed |
|---|---|
| Effect counter on the guard's allow branch + `effectCountForRun` | `host/runEffectContext.ts` |
| `GET /v1/host/sample/replay/effect-count` (env-gated, dual-mounted) | `routes/replayEffectCountSeam.ts` |
| Guard at `webhookEgressDispatcher()` (~20 egress paths) | `host/webhookEgressGuard.ts` |
| Guards at payment + dispatch seams | `features/billing/stripeApi.ts`, `features/commerce/ucpBuyer/ucpBuyerService.ts`, `subruns/subRunDispatcher.ts` |
| `conformance.effect.emit` node + classification | `bootstrap/nodes.ts`, `executor/sideEffects.ts` |
| `nodeId` in `node.failed` payloads (7 sites) | `executor/executor.ts` |
| `sideEffectSuppression: 'recorded-outcome'` advert | `routes/discovery.ts` |
| Fixtures — **HOST-AUTHORED**, see the correction below | `conformance-fixtures/conformance-replay-effect{,-unreached}.json` |
| Counter + egress-seam + hoist-tripwire tests | `test/run-effect-context.test.ts`, `test/replay-effect-count-seam.test.ts` |

> **CORRECTION 2026-08-17 (H48).** The fixtures row above read *"Fixtures
> (verbatim from the corpus)"*. **That is false.** `git log --all
> --diff-filter=A -- 'conformance/fixtures/conformance-replay-effect*.json'` in
> `openwop/openwop` returns nothing — no file by either name has ever existed in
> the corpus, at any revision. The corpus's own RFC 0140 fixture is
> `conformance-replay-side-effect.json`, a *different* file which is separately
> vendored and genuinely is canonical; the similar name is probably how the
> claim arose.
>
> The rationale is left standing rather than rewritten, per the correct-don't-
> rewrite rule — but the provenance claim was load-bearing, not cosmetic:
> `scripts/sync-fixtures.sh` opened with `rm -rf` of the vendored dir, so
> "verbatim from the corpus" implied these files would be re-created by a sync
> that in fact **deleted** them. Measured on a scratch copy against
> `origin/main`'s script with the corpus at the pinned version: 2 → 0.
>
> Both files are now allowlisted as repo-owned in
> `scripts/check-vendored-fixtures.mjs` and preserved across a sync. See ADR 0550
> § "Vendored `conformance-fixtures/` parity — decided 2026-08-17 (H48)".
>
> **Deletion evaluated and REJECTED — 2026-08-17 (H48).** The pair is
> unexercised: the corpus never names these ids (`git grep
> conformance-replay-effect origin/main -- conformance/` is empty), no host test
> drives either, and `replay-side-effect-suppression.test.ts` drives
> `conformance-replay-side-effect` instead. On that evidence deleting them was
> the obvious move. It is the wrong one, for two measured reasons:
>
> 1. **They are the only in-tree exercise of `conformance.effect.emit`** — the
>    node THIS ADR registers and classifies (`bootstrap/nodes.ts`,
>    `executor/sideEffects.ts`) and which ADR 0572's side-effect floor names.
>    Deleting the fixtures orphans that node rather than merely removing two JSON
>    files, and the cascade (node + classification + floor entry + this ADR's
>    phase record) is a replay-semantics change, not a vendoring cleanup.
> 2. **`conformance/witness-boot-rfc0140.ts` names them**, justifying an env
>    default by their existence. That comment was itself imprecise and is
>    corrected there in the same change.
>
> **The concern that motivated the question is fixed at its root instead.** The
> objection was "an unexercised host fixture wearing the corpus `conformance-*`
> prefix is a dishonest advert by prefix". The real dishonesty was not the
> prefix — `capabilities.schema.json` §`fixtures` explicitly permits
> host-supplied ids and requires clients to tolerate unknown ones — it was that
> **both fixtures were advertised unconditionally while their only node is
> registered only when `conformanceNodesEnabled()` is true.** H48 found that
> `fixtureNeedsConformanceNodes` matched only `core.conformance.*`, while
> `registerConformanceNodes()` has always registered five typeIds under the BARE
> `conformance.` prefix. **Six** vendored fixtures were affected, four of them
> CANONICAL corpus fixtures (`conformance-capability-missing`,
> `conformance-model-capability-insufficient`, `openwop-smoke-byok-roundtrip`,
> `openwop-smoke-cost-emit`) — so this was never a host-fixture nit but a
> live advertise-and-spuriously-fail bug against any production/auth host. The
> predicate now covers both prefixes and the pair is advertised only when it can
> actually run, which is the honest state. Both files stay, allowlisted in
> `scripts/check-vendored-fixtures.mjs` with their referencing file named.
>
> **Still open for this ADR's owner** (narrowed, and no longer an advert-honesty
> question): the pair remains unexercised by any scenario, and this ADR's
> "the two mechanisms mask each other under this fixture pair" reasoning in
> § Consequences describes a witness the corpus scenario does not actually drive.
> Either wire them into a host test that exercises `conformance.effect.emit`
> directly, or retire the pair together with the node.
>
> **Note for H49 (the `memoryAction` seam), inherited from the H48 finding.**
> H48 hit the same class one layer over: this host implements none of the
> corpus's `core.identity` + `config.memoryAction` probes, so those fixtures run
> as pass-throughs with an empty variable bag, and five of them were advertised
> anyway. The fix was `IMPLEMENTED_MEMORY_ACTIONS` in `host/index.ts`, a set that
> is **deliberately empty**. Implement an action by adding its `MemoryAdapter`
> driver plus run-variable projection AND its action string to that set **in the
> same commit** — the set exists so a fixture cannot become advertised before it
> has a real witness. Do not add the string ahead of the driver to "unblock" a
> scenario; that recreates exactly the advertise-and-spuriously-fail state both
> predicates in that file exist to prevent.
>
> **Superseded in part by H49 — see the section immediately below.** The
> "deliberately empty" instruction above was correct for H48 and is now
> discharged: H49 landed the driver, and replaced the hand-kept set the
> paragraph describes with one DERIVED from the handler map, so the
> add-both-in-the-same-commit rule it states is now enforced by construction
> rather than by instruction.

## CORRECTION / follow-up — the `config.memoryAction` advert gate, RESOLVED BY H49 (2026-08-17)

This ADR's advert predicate (`fixtureNeedsConformanceNodes`) exists to stop the
**advertise-and-spuriously-fail** defect: a host advertising a fixture whose node it has
not registered, so `isFixtureAdvertised` passes, the run fails at dispatch, and a
correctly-configured host is reported non-conformant for a fixture it never offered.

H48 found the same defect reachable by a **quieter** route. The corpus expresses its
memory scenarios as a `core.identity` node carrying `config.memoryAction`, not as a
dedicated typeId — so an unimplemented action does not fail to RESOLVE. The node runs as
a pass-through, the run reaches `completed`, and the variable bag stays empty. H48 closed
the advert with an `IMPLEMENTED_MEMORY_ACTIONS` set that was deliberately EMPTY, and
recorded the constraint that the driver and the action string must land in the SAME
commit — never the string ahead of the driver.

**H49 is that commit, and it strengthened the mechanism rather than just populating it.**
The action set is now DERIVED from the handler map
(`bootstrap/conformanceMemoryProbe.ts` exports `new Set(Object.keys(HANDLERS))`) instead
of being a hand-kept list, and both consumers — the `core.identity` dispatch branch and
the fixture advert here — read one gated accessor, `implementedMemoryActions()`, which
consults the same `conformanceNodesEnabled()` switch. So "advertised ⟺ executable" is
**structural** rather than a convention someone must remember, in both deploy postures.
That closes the residual risk this constraint was written to manage: a hand-kept list
fails asymmetrically and silently — keeping a string whose handler was lost re-creates
exactly the dishonest advert above, and nothing would have caught it.

Full record, including the three independent honesty fixes the seam exposed (a live
RFC 0113 over-claim, SR-1 having no implementation, CTI-1(1) having no implementation)
and the measured vacuity of two corpus scenarios: **ADR 0041 § H49**.


## Correction — 2026-08-18: the webhook fan-out exemption's middle premise was overturned (H72)

The dispositions table above exempted `routes/webhooks.ts` `deliverToSubscribers`
on **three** grounds. One of them has since been falsified by the corpus, and the
other two still hold — which is why this is a correction note rather than an edit
to the original row.

**What died.** The row's middle ground was *"a replay is a distinct run whose
events are genuinely new."* `spec/v1/replay.md` §"Host-initiated fan-out is an
external effect" (landed 2026-08-18) says the opposite and makes it normative:
outbound delivery MUST be suppressed for events a `replay` fork re-emits, the
rule is **unconditional** (not gated on `sideEffectSuppression`), and replay-ness
MUST be read from the **run**, not the event type. A `mode:'replay'` fork re-emits
recorded history because caveat 5 *requires* it, so delivering those events
outward asserts to a subscriber that something happened in this run which did not.

Dedup does not save us: re-emission correctly mints a fresh envelope `eventId`
and the delivery key is `(subscriptionId, eventId)`, so a **more** correct host is
**more** exposed. That is why the corpus states the rule separately from caveat 1
rather than folding it in.

**What survived, and why it determined the fix.** The row's other two grounds are
still true: there is no node to fail closed, and a throw inside the best-effort
subscriber is swallowed by `eventLog.ts`, so a guard routed through
`runEffectContext` would suppress **silently** — precisely the fail-open shape
ADR 0531 exists to remove. So H72 does **not** add an `EffectKind`. It suppresses
at the **boundary** inside `deliverToSubscribers` (Fowler's Gateway pattern:
check replay mode before passing the call to the outside world), keyed on
`run.forkMode === 'replay'`, with `branch` untouched — a branch fork is new
execution, not a re-run of recorded history.

**Provenance, because it matters more than the fix.** This was not an oversight.
The question was asked, reasoned about, and answered in writing — here and in
`host/runEffectContext.ts`'s docblock — and the answer was correct until the
corpus moved. It was found because myndhyve-1 hit the same defect in an unrelated
host and predicted it would generalise to *any* host projecting its event log
outward; it did, on first contact, in a codebase that had already cleared the
seam. A hole in two trees is a coincidence; a hole in a third where someone had
already written down the wrong answer is the argument for a normative rule.

Pinned by `test/replay-fork-fanout-suppression.test.ts` — four legs including a
positive control (an original run still delivers) and a `branch` leg, so the
guard cannot be satisfied by suppressing everything. Sabotage-verified: removing
the one-line predicate fails two legs with
`expected [ 'sub-1' ] to deeply equal []` while both controls stay green.

## Correction — 2026-09-24 (WS0): the prefix predicate was never the whole rule

The H47/H48 predicate derives "needs conformance nodes" from a typeId PREFIX and
trusts that every such node is registered whenever `conformanceNodesEnabled()`.
That second half was false. MEASURED at `bfd8b8545`: `conformance-artifact-emit`
(`conformance.artifact.emit`), `conformance-credential` (`conformance.oauth.use`)
and `conformance-mcp-client` (`core.conformance.mcp-client`) name nodes this host
has never registered in either posture, so with conformance nodes ON all three
sat in `fixtures[]`; `conformance-wasm-pack-{roundtrip,memory-cap-breach}` name
pack nodes no installed pack declares; and in the enterprise posture
`conformance-prompt-*` name `local.sample.demo.mock-ai`, which LEAK-3 leaves
unregistered. Each would fail at dispatch with `node module not registered`.

**Decision (architect pass, WS0):** add the general rule the two predicates are
instances of — a fixture is advertised only if EVERY node typeId in its graph is
resolvable by the executor's registry (`NodeRegistry.isResolvable`: in-process
registration OR an installed pack's manifest, the same two lanes `resolve()`
walks), and every child fixture it runs (`config.workflowId`) passes the same
test. The env/prefix and memoryAction predicates are KEPT — registration is a
boot snapshot, the posture switch is re-read per call. An empty registry
advertises nothing (fail-closed). Ratchet:
`test/conformance-fixture-advert-gating.test.ts` §"WS0 ratchet", sabotage-proven
(dropping the clause reds it with 15 offenders listed).
