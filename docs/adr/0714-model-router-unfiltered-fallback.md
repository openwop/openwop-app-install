# ADR 0714 — The model router's fallback escapes the capability filter it documents as a MUST

Status: **implemented** (the fix ships in the same PR as this decision)

> Marked `implemented` at merge, not left at `Proposed`/`Accepted`. A peer had to sweep
> SIX stale ADR statuses on 2026-09-17 (#3912), five of them mine from this feature loop
> (0700, 0701, 0703, 0707, 0708). When the decision and its implementation land in one PR,
> the status line is part of that PR — not a follow-up someone else does.

**Feature:** Model router (`FEATURES.md` ordinal 211) · ADR 0130 · feature-loop 2026-09 it.43
**Supersedes nothing.** Extends ADR 0130 Phase 1/3a and reuses the ADR 0610 D4 belt posture.

## Context

`routeTurn` (`features/model-router/routeTurn.ts`) is the pure per-turn selector. It
applies an eligibility filter, `eligible()`, whose own comment states the rule as an
absolute:

> An attachment turn MUST route to a vision-capable target (ADR 0130 invariant).

It applies that filter to **two** of the three lanes that can produce a target:

1. the cooldown/sticky target — filtered (`routeTurn.ts:131`),
2. each candidate rule — filtered (`routeTurn.ts:137`),
3. **the fallback — NOT filtered** (`routeTurn.ts:141`).

The `fallback` field's own docblock downgrades the same rule to a suggestion — "SHOULD
be vision-capable so an attachment turn always has an eligible target" — so the file
states the invariant as MUST in one place and SHOULD in another, and enforces neither
on lane 3.

Nothing else closes it. `configService.asTarget` validates the provider against the
ADR 0610 routable allowlist but says nothing about vision (`configService.ts:44,103`),
and `applyRoute.ts` contains no capability check at all.

### Measured, not inferred

A direct probe against the canonical capability id the production code actually checks:

```
config: rules [always → openai/cheap], fallback minimax/text-only
turn:   { hasAttachment: true, tokenEstimate: 100 }

DECISION: {"target":{"provider":"minimax","model":"text-only"},"reason":"fallback"}
          fallback vision-input? false
CONTROL (same config, no attachment):
          {"target":{"provider":"openai","model":"cheap"},"reason":"rule"}
```

The attachment turn routes to a non-vision target. The control shows the config is
otherwise sane, so the outcome is the fallback lane, not a broken fixture.

This is **durable, not transient.** `maybeStampModelRoute` persists the decision into
`run.metadata.modelRoute` (`dispatchTurn.ts:75-80`), and ADR 0130's "crux" is that the
stamp is written once and read verbatim thereafter, including on `:fork`. A route chosen
in violation of the invariant is therefore frozen onto the run for its whole life.

### Severity: Improvement, not Blocker — downgraded on measurement

I expected a silent wrong answer and checked the consumer instead of assuming. For a
text-only provider the dispatch layer is **fail-closed**: `contentToText`
(`providers/dispatch.ts:1086-1095`) throws `unsupported(providerLabel, part)` on an
image part rather than dropping it. The user gets a typed failure, not a model confidently
answering about an image it never received.

**Every reachable instance lands there.** `minimax` is the ONLY routable provider lacking
`vision-input` — `CHAT_BYOK_PROVIDERS` is `[anthropic, openai, google, minimax]`
(`chatByokConfig.ts:35`) and the first three all advertise it
(`modelCapabilityProbe.ts:18`) — and minimax dispatches through
`dispatchOpenAICompatible` (`dispatch.ts:680`) → `contentToText` (`:588`) → the throw.

The config is nonetheless **reachable through the product's own admin editor**, not
synthetic: `minimax` has no entry in `PROVIDER_CAPABILITIES` at all (probe returns `[]`),
while `asTarget` accepts it because it only checks the routable allowlist.

So what is lost is the invariant and a clean error boundary, not safety. Filed as it
measures.

### Two claims of mine, both falsified before implementation — the reasoning is the point

**First claim: the guarding test is vacuous.** The fixture probe advertises the
non-canonical `'vision'` (`test/model-router-route.test.ts:7`) while `eligible()` checks
`'vision-input'`, so under that fixture *no* provider is vision-eligible.

**Sabotage refuted it.** Deleting the filter outright reds two legs, because the filter is
what rejects the non-vision *rules*. It is load-bearing.

**Second claim (my correction to the first): "the test cannot detect the fallback hole,
because its own fallback is vision-capable." ALSO FALSE, and it understated the finding.**
Under the code's own predicate the fixture's anthropic fallback is *not* vision-capable —
`['vision','tools']` does not contain `'vision-input'`. So in that test every rule is
filtered out, the attachment turn lands on the unfiltered fallback, and **the returned
target IS a non-vision target by the production check**. The assertion passes only because
it checks the stale id (`:34`).

**The existing test therefore already exercises this defect and certifies the result as
correct**, under a name claiming the exact opposite — "NEVER routes an attachment turn to a
non-vision target". This is the "a test pinned the defect" family, and it is the strongest
evidence here. Correcting the fixture id is what makes the test *able to fail at all*.

The same id drift was already found once and fixed **in the production code**
(`routeTurn.ts:108-111` records it: "corrected from the non-canonical `vision` the probe
never advertised … nothing satisfied it, so an attachment turn always fell through to the
fallback"). The fixture was never updated, so the test still encodes the pre-fix world.

### The lane count, corrected

Production has **two** target-producing lanes, not three. `resolveModelRoute` is called at
exactly one site (`dispatchTurn.ts:75`) with **no `state`**, so `routeTurn`'s cooldown
branch can never be true outside tests. See `MRC-6` below.

## Decision

### D1 — Refuse to route rather than route ineligibly

When the selector can only offer a target that fails the attachment/vision invariant,
`resolveModelRoute` returns `null` and logs a named warning. `computeRouteStamp` already
treats a null target as "router off/unconfigured → keep the explicit model"
(`dispatchTurn.ts:52-53`), so no new state or code path is introduced: **the run keeps the
model its caller chose, which is precisely ADR 0130's documented OFF posture.**

The router's job is to improve a turn's target, never to be the thing that breaks it.

**The honest bound, stated because the phrase "keep the explicit model" invites a stronger
reading than is true:** the run's own `inputs.provider/model` may ITSELF be non-vision, so
declining to route does **not** guarantee the turn succeeds. What it guarantees is
narrower: the router stops being the proximate CAUSE — it no longer overrides a possibly
capable caller choice with a known-ineligible one, and no longer freezes that choice into
`run.metadata` where `:fork` replays it forever.

**The shape is not invented — it is the guard three lines above the defect.** ADR 0610 D4
already added exactly this belt for the routable-provider allowlist in the same function:
post-hoc check → `log.warn` with a named event → `return null`. D1 applies the established
posture to the second invariant instead of inventing a second mechanism.

**The filter also moves into `routeTurn` itself**, where the invariant is documented:
the fallback is filtered like the other lanes, and the selector returns
`RouteDecision | null` to express "no eligible target". The belt stays as defence in
depth, so a future second caller of `routeTurn` cannot reinherit the gap.

An earlier draft of this ADR put the fix *only* at the belt and justified that by saying a
selector change "ripples through 15 call sites". **That number measured the wrong
population** — call sites, not call sites that reach the null path. Measured, with the
fixture id corrected (D3) and the selector filtering:

```
Test Files  3 passed (3)      Tests  20 passed (20)
tsc: 3 x "Object is possibly 'null'" in model-router-difficulty.test.ts (test-only)
```

Zero behavioural breakage. The cheap fix and the correct fix are the same fix; the draft
rejected the correct one on a mismeasurement, which is the very error this loop recorded
one iteration earlier (count what a change AFFECTS, not what it TOUCHES).

### D2 — Retire the MUST/SHOULD contradiction in the file

The `fallback` docblock said "SHOULD be vision-capable" while `eligible()` called the same
rule a MUST twelve lines below. One file, two strengths for one invariant, and the weaker
wording sat on the one unenforced lane — that contradiction is *how* lane 3 was missed.
The docblock now states what is true after D1: a non-vision fallback makes the router
decline to route for attachment turns rather than route ineligibly.

### D3 — Fix the test's stale fixture and its over-broad name

The fixture probe advertises `'vision-input'` (the id the code checks), and a new leg pins
the actual invariant: an attachment turn with a **non-vision fallback** must not produce a
non-vision target. The existing test's name is narrowed to what it really proves.

## Alternatives weighed

- **Filter the fallback inside `routeTurn` and return `null`.** Most faithful to where the
  invariant is documented, but changes the pure selector's contract from `RouteDecision` to
  `RouteDecision | null` and ripples through 15 call sites across two suites. Rejected for
  now as a larger blast radius for the same outcome; D2 records the obligation so the
  option stays open.
- **Validate at config-write time** (require a vision-capable fallback). Rejected: it
  cannot bind already-stored configs, and it would refuse a legitimate text-only workspace
  that never sends attachments. The write gate is the wrong instrument for a per-turn
  property.
- **Let the fallback through and rely on dispatch failing closed.** Rejected: it converts a
  routable condition into a user-visible error, and it freezes the bad target into
  `run.metadata` where `:fork` replays it forever.

## Not in scope

- **`MRC-1`** (config WRITE gates on `workspace:write`, an editor scope, rather than admin)
  — ADR 0130 §L82 designed that scope, so changing it is a policy amendment, not a bug fix.
  Re-verified still true at this commit (`routes.ts:19,22`).
- **`MRC-4`** (the managed path drops the routed model) — re-verified still true
  (`dispatchTurn.ts:256`). **The obvious fix is an attack**: `managedProvider.ts:105`
  documents the underlying target as "Never leaks past this module", so passing the routed
  model into `dispatchManagedChat` would breach a stated module invariant. The real defect
  is that a route can be stamped whose model the managed path can never honour, with
  nothing reported — same family as ADR 0708 D1, and it needs its own pass.
- **`MRC-6` (NEW, found during this ADR's review) — the cooldown lane is dead in
  production while its knob is validated and persisted.** `resolveModelRoute` is called at
  one site with no `state` argument (`dispatchTurn.ts:75`), so `routeTurn`'s sticky branch
  can never be true outside tests — yet `configService.ts:105` accepts and stores
  `cooldownMs`. An operator can configure stickiness that provably does nothing: the same
  vacuous-bound family as ADR 0707. Filed, not fixed here — wiring `RouteState` needs a
  per-conversation store and is its own decision.
- **Provider-granular vs model-granular capability.** `eligible()` probes
  `t.provider`, so a vision-capable provider with a text-only model passes the filter.
  Noted, not fixed: the probe is provider-keyed by construction
  (`modelCapabilityProbe.ts:73`) and making it model-aware is a separate change with its
  own catalog dependency.

## Implementation record

| Decision | Change | Witness |
|---|---|---|
| D1 | `routeTurn` filters the fallback and returns `RouteDecision \| null`; `resolveModelRoute` keeps a belt + reports the decline | `model-router-route.test.ts` (3 new legs incl. both control polarities), `model-router-resolve.test.ts` (end-to-end through the real config store) |
| D2 | `fallback` docblock's SHOULD→ the enforced rule; MUST/SHOULD contradiction retired | the docblock itself |
| D3 | fixture probe advertises `vision-input`; over-broad test name narrowed; 3 stale-id assertions corrected | S4 below |
| MRC-6 | filed, not fixed | — |

**Sabotages (each restored after):**

| # | Sabotage | Result |
|---|---|---|
| S1 | remove the fallback filter (the D1 fix) | 1 failed |
| S2 | invert the filter (refuse an ELIGIBLE fallback) | 7 failed |
| S3 | make `eligible()` ignore `hasAttachment` (over-refuse) | 3 failed |
| S4 | revert the fixture to the stale `'vision'` id | 2 failed |
| S5 | keep the refusal but REMOVE its log (correct yet silent) | 1 failed |

S4 is the anti-regression that matters: the fixture drift which hid this defect can no
longer recur silently. S5 exists because of a mistake worth recording — **the belt was
initially UNWITNESSED**: deleting it outright changed nothing detectable, exactly the
ADR 0708 D1 shape (a refusal nobody can observe) reappearing one iteration later in my own
fix. The end-to-end leg was added specifically to make silence detectable.

**A second mistake, recorded because it produced a false green:** the first version of that
witness spied on `console.log`. `createLogger` writes to `process.stdout`/`stderr`
(`logger.ts:81,83`), so the capture was empty — and an empty capture asserted against would
have passed had the assertion been `not.toContain`. The leg was fixed to capture the real
channel before it was trusted.

**Also required, and not caused by this change:** `npm ci` in `backend/typescript`. A peer's
conformance 2.2.0 adoption (`ce8c7d0b9`) moved the lockfile, and the worktree still had
2.1.5 installed, which surfaced as a TS2307 in an unrelated parity test. Reinstalled with
`npm ci` (never `npm install` — it would rewrite the lockfile); lockfile confirmed untouched
afterwards.
