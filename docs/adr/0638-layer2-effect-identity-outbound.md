# ADR 0638 — Layer 2 effect identity reaches the provider

Status: implemented

## Context

The host advertises `idempotency` on the v2 capability root (#3667 removed its
opt-out row). Per `spec/v2/core/idempotency.md`, that advert **binds Layer 2**,
whose Provider-key rule is a MUST:

> When the provider accepts an idempotency key, the host MUST inject **the effect
> identity** (or a documented deterministic derivative), **stable across retries**.

Two things were wrong the moment that advert went out.

### 1. The Stripe path presented a random key

`features/billing/stripeApi.ts` sent `'idempotency-key': idempotencyKey ?? randomUUID()`.
A fresh UUID per call is neither the effect identity nor stable across retries: a
node re-attempt or a fork issues a **new** key, so Stripe cannot dedupe it — on
the money-movement path. The in-file comment said exactly this ("minted per CALL
… cannot dedupe a replay"), which was an honest note about a known gap while the
family was unadvertised, and a violated MUST once it was not.

Worth recording how this was nearly missed: an initial audit concluded "there is
NO outbound `Idempotency-Key` sender anywhere in src/". That was false — the grep
behind it was truncated by `head -8`. The real finding was not a missing
mechanism but an **existing mechanism with an unsafe fallback**, which is a
materially different (and worse) problem.

### 2. The effect ledger put the retry counter in the identity

`routes/runs.ts` derived `effectId` from `runId ‖ nodeId ‖ **attempt** ‖ invocationId`.
Against the same document: the effect is "identified once and stable across every
transport or provider retry", and "the retry counter MUST NOT participate in the
identity". Two attempts of one logical effect received two `effectId`s.

The projection schema is built for the corrected shape — each record carries
`attempt` as its own field and there is no uniqueness constraint on `effectId`,
so N attempt-rows sharing one id is the intended reading. `invocationId` was
already attempt-free by construction, so only this projection re-introduced the
counter.

## Decision

**Keying: the activity recipe, verbatim.** `idempotency.md` names two keyings and
this host declares the second on its own ledger: business-identity is preferred,
and "the activity recipe (tenant, run, node, ordinal, `providerKey`) is the
fallback for a provider with no business key". `logicalInvocationId` IS that
recipe, and is attempt-free by construction.

**One helper, not per-call-site logic.** `host/providerIdempotencyKey.ts` owns the
derivation so every provider path that accepts a key resolves it the same way.
Precedence is explicit: an explicit caller key wins (it names a business
operation the caller knows better — the preferred keying), then the run's effect
identity, then `randomUUID()`.

**Outside a run, return `undefined`.** Layer 2's unit is the effect within a run;
routes and daemons calling a provider directly have no effect to key on, and
Layer 1 already covers the inbound request. Fabricating a stable-looking key
there would be worse than none — it would claim an identity the host cannot
reproduce on a retry it never records. A partial context fails closed the same
way rather than hashing `undefined` into a legitimate-looking key.

**Scope is conditional, not blanket.** The rule says "when the provider accepts an
idempotency key". SMTP, queue and storage seams are out of scope by the rule's own
terms. (`replay.md`'s "completeness outranks driveability" governs the effect-seam
**manifest** — every outbound path must be *listed* — not the keying rule.)

## Alternatives weighed

- **Attach a key to every outbound call.** Rejected: overreads the rule, and adds
  a header to transports with no such convention.
- **Webhook-delivery path only.** Rejected: a subscriber delivery is not "a
  provider that accepts an idempotency key", and it leaves the money-movement
  defect untouched.
- **A seam-only path fabricating two matching attempts.** Rejected as vacuous
  before it is dishonest: `randomUUID()` is computed once per call, so a
  transport retry reusing the same headers object *already* presents an identical
  key. A seam built on that passes the fixture check while the MUST stays
  violated — the same shape as inventing a `branchReFires: false` manifest row.

## Governance

**No RFC.** The header rides the **host→provider** leg, not the OpenWOP wire
between hosts and clients, so `COMPATIBILITY.md` §2.2 is not engaged; and
`idempotency.md` §Layer 2 already mandates it. This is host work implementing an
already-Accepted obligation. An ADR is required because it changes money-movement
behaviour.

## Consequences

- A retried Stripe operation inside a run now presents the same key, so Stripe
  can dedupe it. This is a correctness change on money movement, not only a
  conformance one.
- `GET /runs/{runId}/effects` reports one `effectId` per effect, with attempts as
  separate rows.
- The remaining unserved seam, `forceEffectTransportRetry`, now has a real
  mechanism to witness rather than one built to satisfy it. It still needs a
  generic outbound path that injects the identity (Stripe cannot call an
  arbitrary `providerUrl`); that is the next phase and is NOT claimed here.

## CORRECTION 2026-09-06 — P3 "inject on the generic egress" was framed on a misreading

The Consequences above name a remaining phase: inject the effect identity on the
generic outbound path (`ctx.http.safeFetch`) so the seam drives a production
egress. **That phase should not be built, and the reason is in the second half of
the rule I quoted only the first half of.**

`idempotency.md` §Layer 2, Provider key, in full:

> When the provider accepts an idempotency key, the host MUST inject the effect
> identity (or a documented deterministic derivative), stable across retries.
> **A host that cannot use the provider's convention MUST still persist the
> outcome.**

`safeFetch` carries arbitrary node traffic to arbitrary URLs. The host **cannot
know** whether a given provider accepts an idempotency key or by what name, so
the first clause does not bind — the second does, and it asks for persistence.

**MEASURED: this host already persists.** `src/host/connectionInjection.ts` is a
listed manifest seam (`http.safe-fetch`), it guards through
`assertEffectAllowed('network-egress')`, and every call — *including a blocked
one* — lands a durable, content-free `agent.toolCalled` / `agent.toolReturned`
pair carrying `status: ok | forbidden | error` (RFC 0064 §B, host-capabilities.md
§host.http). The outcome is persisted; the obligation is discharged.

**And injecting anyway would carry real risk for no normative gain.** An
`Idempotency-Key` added to an arbitrary user-controlled request *after*
credential injection can invalidate any signature scheme whose canonical form
covers headers, and the header is meaningless on a GET — this host's own
`middleware/v2Identity.ts` records that `GET`/`HEAD` MUST NOT honour it. A
change that can break a signed request in order to satisfy a clause that does not
apply is the wrong trade.

**Stripe remains different and remains correct.** There the provider's convention
IS known and documented, so the first clause binds and the identity is injected
(the `randomUUID()` fallback this ADR replaced).

The transferable point is the one this ADR already makes about citations: **I
quoted a rule and acted on the half I had read.** The clause that resolved it was
in the same sentence.

## Implementation record

| Change | Site |
| --- | --- |
| Shared derivation + precedence + fail-closed | `src/host/providerIdempotencyKey.ts` |
| Stripe injects the effect identity | `src/features/billing/stripeApi.ts` |
| `effectId` attempt-free | `src/routes/runs.ts` |
| Identity/stability/grammar/outside-a-run tests (5) | `test/provider-idempotency-key.test.ts` |
| Two attempts share one `effectId` | `test/v2-run-effects-projection.test.ts` |

Sabotage-checked both ways. Letting `attempt` reach the identity turns the
stability test red; restoring `attempt` to the `effectId` preimage turns the
projection test red. A first sabotage attempt (randomising the ordinal input) did
**not** go red — the rewind returns ordinal 0 regardless — and is recorded because
it is a reminder that a sabotage proves only the assertion it actually perturbs.
