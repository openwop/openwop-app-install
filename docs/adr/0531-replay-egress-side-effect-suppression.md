# ADR 0531 — a run-scoped effect guard: the fail-closed backstop for replay side-effect suppression

Status: implemented (2026-08-08)

## Context

ADR 0341 established the invariant that **a replay never creates a new side
effect**: during a `replay`-mode fork, a side-effecting node does not execute —
the executor reproduces the source run's recorded outcome for the same
`(nodeId, attempt)`, and fails CLOSED (`replay_source_missing`) when the source
never reached it.

**Scope note — `replay` mode only, deliberately.** `replayInvocationsFromRunId`
is set exclusively for `mode: 'replay'` (`routes/runs.ts`), so `sourceOutcomes`
is never populated for a `branch` fork and neither the ADR 0341 fast path nor
this guard applies to one. That is the correct boundary, not an oversight: a
`branch` is a genuinely new execution with caller-supplied inputs exploring a
real alternative, so its effects are effects the operator asked for. A `replay`
re-executes fixed history to validate determinism, so its effects are duplicates
by definition. This ADR does not change that boundary in either direction.

The whole guarantee reduces to one boolean at `executor/executor.ts`:

```ts
if (input.sourceOutcomes && isSideEffectingNode(nodeRef.typeId, module))
```

`isSideEffectingNode` is an **allowlist of typeId regexes** (`executor/sideEffects.ts`).
Return `false` and execution falls straight through to a real external call.

**Allowlists drift, and this one already did.** #2871 retargeted 55 chain nodes
off `core.openwop.integration.notification-push` (matched by a family pattern)
onto `feature.notifications.nodes.notify`, which matched **nothing**. All 55
silently left ADR 0341 protection while the node's own docblock claimed the
opposite. Nothing in ~9,600 tests noticed: `isSideEffectingNode` had no test of
its own, and the chain suites only assert that a typeId *resolves*.

The follow-up guard (`test/side-effect-classification.test.ts`) is honest about
its own scope: it scans pack `.mjs` source for the **notification emitter only**,
and it cannot see a node that reaches an effect through a host feature surface
(`feature.kicktodo.nodes.session-reminder` is exactly that case, and is covered
only by an explicit hand-written entry). So the corpus ratchet narrows the gap
for one family of one seam; it does not close the class.

A protection that depends on somebody remembering to enumerate a node is not a
protection. This ADR adds the structural half.

### The correction that shaped the design

The first proposal was "move the guard onto the app's egress chokepoint"
(`host/egressPolicy.ts`, ADR 0187 — which genuinely brokers *all* outbound
network traffic). **That would not have caught #2871.** The notification path
reaches `notifications/emitter.ts`, which writes durable rows; it performs no
network egress at all. "External effect" is broader than "network egress", and
the fix had to be too.

## Decision

Add a **run-scoped effect context** (`host/runEffectContext.ts`) using
`AsyncLocalStorage`, and call a single guard from each host effect seam.

- The executor establishes the context around **every** node execution —
  `runWithEffectContext({ runId, replaying }, () => module.execute(ctx))`.
- Each effect seam calls `assertEffectAllowed(kind, detail)` before the deed.
- During a replay, the guard throws `ReplayEffectError`, which the executor's
  error allowlist converts into a node failure carrying
  `error.code: 'replay_source_missing'` — **the same code the ADR 0341 fast path
  emits**, so one invariant has one code on the event log.

### The two mechanisms are not redundant

This is the load-bearing distinction:

| | typeId fast path (ADR 0341) | effect guard (this ADR) |
|---|---|---|
| When | before the node runs | mid-execution, at the seam |
| Can it serve the recorded outcome? | **Yes** — replay reproduces correct output | **No** — nothing left to serve |
| Result | replay succeeds correctly | replay fails loudly |

So the guard does not replace classification. It converts a **silent
wrong-doing** (a real email sent during a replay) into a **loud typed failure**.
Every backstop firing is therefore a *bug report* meaning "this typeId belongs in
the fast path", and it logs exactly that at `error` level with the node's effect
kind. A steady stream of these is a defect, not a working system.

### Context is established on every execution, not only replays

Deliberate. Were the context set only during replays, an *absent* context would
silently mean "not replaying" — reintroducing the same fail-open shape this ADR
exists to remove. With it always set, absent unambiguously means "not inside a
run" (an HTTP route, a daemon sweep), which is legitimately allowed.
`test/run-effect-context.test.ts` pins that the executor always establishes it,
observing both `replaying: false` and `replaying: true` and never `absent`.

### Seam dispositions

Assessed all five candidate seams; guarded three. The two exclusions are
deliberate and are recorded in the `EffectKind` union's docblock so the union is
exactly the set of guarded seams (a member with no call site would be dead code):

| Seam | Disposition |
|---|---|
| `host/brokeredEgress.ts` `brokeredPost` / `brokeredFetch` | **Guarded** (`network-egress`). Fires before credential resolution — a replay never touches the secret, let alone dials. |
| `notifications/emitter.ts` `emit` / `emitMany` | **Guarded** (`notification`). The #2871 seam. `emitMany` is gated on the **batch**, because its per-item isolation deliberately swallows individual failures and would swallow a per-item guard too. |
| `host/smtpEgress.ts` `assertSmtpDialAllowed` | **Guarded** (`email`). SMTP is raw TCP and cannot ride the HTTPS chokepoint (ADR 0201). |
| `host/obligationLedger.ts` `accrue` | **Not guarded.** Already replay-idempotent via a deterministic `rowKey` (first-write-wins). Deterministic keying is a *stronger* property than fail-closed: a replay re-accruing is a correct no-op today, and a guard would turn that into a throw. |
| `host/capabilityToken.ts` `mintToken` | **Not guarded.** A pure generator, not an effect — the durable write lives in each calling feature. Its `randomBytes` minting *is* non-deterministic under replay, but the residue is unused rows rather than an outward effect, so guarding the generator would be guarding the wrong function. Recorded as residue below. |

`brokeredFetch` deliberately **throws** rather than returning its usual
`host_not_allowed` outcome: a policy denial is a normal result callers handle,
whereas reaching the seam during a replay is a classification bug that must be
loud.

## Alternatives weighed

- **Thread `runId` through every effect call site** (~72 sites). Rejected: it
  reproduces the original defect one layer down — "forgot to add the typeId"
  becomes "forgot to pass the runId", and both fail open. It also touches 72
  signatures instead of 5 modules.
- **Extend the corpus ratchet only** (no runtime change). Kept as
  defence-in-depth, rejected as the authority: a build-time scan cannot guard a
  path it does not model, and the kicktodo host-surface case is a live example of
  one it cannot see.
- **Invert the default — side-effecting unless proven pure.** Rejected, and the
  reason is worth recording: `spec/v1/replay.md` §`replay` defines the mode as
  re-executing against *current* code and emitting `replay.diverged` on
  mismatch. Serving recorded outcomes by default makes every replay match **by
  construction**, so divergence detection goes vacuously green. That is strictly
  worse than no replay — a broken guarantee that reports success.

## Wire posture

**No wire change.** `replay_source_missing` is a node-failure `error.code` in the
event payload, not a member of the `OpenwopErrorCode` HTTP envelope union, and
the ADR 0341 fast path already emits it. `ReplayEffectError` is a host class that
never travels as an HTTP error.

Making this invariant *portable* — so a federated peer replaying a dispatched
sub-workflow is also bound by it — does require the wire, because
`idempotency.md` Layer 2 keys on `(runId, nodeId, attempt, providerKey)` and a
fork mints a **new** `runId`, so Layer 2 cannot cover a fork by construction.
That is deliberately a separate change: an OpenWOP RFC proposing an additive
`replay.sideEffectSuppression` capability. Specifying a mechanism before it has a
live implementation is how RFCs go stale; this ADR is that implementation.

### Closed — RFC 0140 is `Accepted`, and this host advertises it (2026-08-08)

The separate change landed the same day (openwop#896 filed the RFC, openwop#898
implemented and promoted it). `capabilities.schema.json` gained
`replay.sideEffectSuppression`, `replay.md` gained a normative
§"Side-effect suppression in replay", and this host now advertises
`sideEffectSuppression: "recorded-outcome"` in `routes/discovery.ts`.

**The advert is a WHOLE-RUN claim, and this host can make it only because it has
both halves of the design** — that is not a rhetorical point, it was measured.
The conformance witness was sabotaged twice, once per mechanism:

| Sabotage | Result |
|---|---|
| ADR 0341 classifier entry + the module's `sideEffecting` flag removed, **and** the guarded seam bypassed | **RED** — the scenario's requirement-1 assertion fires |
| Classifier entry + module flag removed, **only this ADR's seam backstop left** | **GREEN** |

The second row is the justification for the advert. RFC 0140 §B.4 forbids
advertising `recorded-outcome` if *any* class of side-effecting node can still
fire, and a host relying on a typeId allowlist alone cannot honestly promise
that — #2871 is the proof. With the backstop, coverage does **not** depend on the
allowlist being complete, so the whole-run claim is honest. A host without one
should advertise `"none"`.

Also added: `bootstrap/conformanceSideEffectNode.ts` implements the
conformance-reserved `core.conformance.side-effect` typeId. It emits a **real**
notification on purpose — a stub returning `{ ok: true }` would satisfy the
fixture's shape while proving nothing, since the scenario asserts the host
*refuses* to run it during a replay.

## Known limit — the tripwire

`AsyncLocalStorage` propagates through `await` but **not across a process or
worker boundary**. Pack nodes execute in-process today
(`packs/tarballLoader.ts`, dynamic `import()`), so they inherit the context — but
if pack execution ever moves out-of-process (RFC 0035 sandbox execution, RFC 0008
WASM ABI), this backstop degrades **silently** to no guard.

That is why `test/run-effect-context.test.ts` asserts the guard fires for a node
whose `execute` lives in a **dynamically imported module**, mirroring the pack
loader. That single assertion is the tripwire for the entire design: if it ever
reads `absent`, the guard is gone for every pack-shaped node and the host side of
the new boundary must re-establish the context.

## Observability of a firing (2026-08-08)

A backstop firing is a bug report, so it has to be findable. Two channels, and
deliberately **not** a third:

- **Structured log** — `error`, `component: "replay.effectGuard"`, carrying
  `runId` + `effectKind` + the literal remediation. The component name is stable
  and unique, so it is the alert key: a Cloud Logging log-based metric on
  `jsonPayload.component="replay.effectGuard"` fires on every occurrence.
- **Trace** — the active per-node span gets
  `openwop.replay_effect_blocked=<kind>`, so the firing is visible beside the
  node that caused it instead of needing correlation from a log line.
  `trace.getActiveSpan()` is the existing idiom (`observability/llmSpans.ts`,
  `costEmitter.ts`) and the executor's node span is active at the seam.
- **NOT an OTel counter.** This host wires traces and logs and has **no metrics
  pipeline at all** — no `MeterProvider`, no `@opentelemetry/sdk-metrics`
  dependency. Standing one up for a single signal is disproportionate and is its
  own architectural decision, not a footnote to this one. The grade-code gap
  "greppable but not alertable" is closed by the stable component key above,
  which is genuinely alertable; if a metrics pipeline lands later, this is an
  obvious first counter.

## Residue

- `mintToken`'s non-deterministic minting under replay (unused rows, no outward
  effect). Needs a per-feature deterministic-id pass, not a guard.
- The corpus ratchet still scans only the notification-emitter family. Now
  lower-stakes — the runtime backstop covers the class — but broadening it would
  restore the *fast path*'s coverage, which is the half that keeps replays
  succeeding correctly rather than merely failing safely.

### Deferred: a pack-manifest effect declaration (and the trigger to build it)

A `nodes[]` effect declaration was considered and is **deferred, with a named
trigger** rather than dropped.

The distinction that decides it: this ADR closes the **safety** gap completely —
an unclassified side-effecting node can no longer fire twice. It does **not**
close the **correctness** gap — such a node now makes the replay *fail* rather
than resolve to the recorded outcome. Only the fast path (the typeId
classifier) can do the latter, and only the host can edit that list.

For a first-party pack corpus, a host-maintained list is maintainable. For a
real third-party pack ecosystem it is not: the host cannot enumerate nodes it
did not write. So the trigger is **the first third-party pack shipping a
side-effecting node, or the backstop firing in production** — the guard logs at
`error` with the offending effect kind and the literal remediation ("add this
node to sideEffects.ts"), so the trigger is observable rather than theoretical.

Deferring is safe precisely because of what P1 built: the cost of being wrong is
now a loud, typed failure, not a duplicate charge.

Design constraints for whoever builds it (recorded in RFC 0140 §Alternatives so
they survive outside this repo):

1. **Monotonic opt-in only.** `sideEffecting: true` is safe; the *absence* of a
   declaration must NEVER be read as "pure", or an out-of-date pack silently
   loses protection — the #2871 failure with extra steps.
2. **State its relationship to `actions[].idempotent`**, which already exists in
   `node-pack-manifest.schema.json`. They are orthogonal — "safe to retry" vs
   "has an effect at all" — and shipping both without saying so invites hosts to
   conflate them.
3. It is a pack-format change, so it needs an RFC (0117/0119 territory), not an
   ADR alone.

## Phase record

| Phase | Work | Test |
|---|---|---|
| A | `host/runEffectContext.ts` — ALS context, `assertEffectAllowed`, `ReplayEffectError` | `test/run-effect-context.test.ts` §"the guard contract" |
| B | Executor wraps every node execution; `ReplayEffectError` joins the error-code allowlist | §"the executor establishes the context on EVERY node execution" |
| C | Guards at the three seams | §"every declared effect seam actually installs the guard" (behavioral — each seam is called and must refuse) |
| D | End-to-end: an unclassified node notifies once live, fails closed on replay, never notifies twice | §"end-to-end: a replay fork cannot re-notify" |
| E | Pack-shaped tripwire | §"TRIPWIRE — the backstop reaches dynamically-imported nodes" |
