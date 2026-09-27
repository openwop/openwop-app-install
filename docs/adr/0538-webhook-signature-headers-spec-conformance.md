# ADR 0538 — Webhook delivery signature headers: conform to webhooks.md v1.1

Status: **Phase 1 implemented** (`fc18bec6f`, #3105) · Phase 2 **Proposed** (dated legacy-header removal)

> **Status corrected 2026-08-11.** This read `Proposed` for a day after Phase 1 shipped.
> That is not cosmetic: `docs/adr` `Status:` is the documented way to pick up unfinished
> work in this repo (grep the statuses, never the ROADMAP), so a stale `Proposed` invites
> a future session to re-implement a phase that already landed. Caught by noticing the
> implementing commit names this ADR in its subject while the ADR itself claimed nothing
> had been done.

## Context

The host's webhook delivery worker signs each POST with a **Stripe-style
combined header** that matches neither `webhooks.md` v1.1 (the Stable SSoT) nor
the conformance suite (as of `1.68.2`, which was corrected to the spec).

`backend/typescript/src/host/webhookDeliveryWorker.ts` `sendDelivery()` emits:

```
openwop-signature: t=<ts>,v1=<hmacHex>
openwop-event-type: <eventType>
openwop-subscription-id: <subscriptionId>
```

`webhooks.md` §"Headers" mandates **separate** headers, all `X-`-prefixed:

| Header | Value |
|---|---|
| `User-Agent` | `openwop-webhook-dispatcher/{version}` |
| `X-openwop-Webhook-Id` | `{webhookId}` (the subscription id) |
| `X-openwop-Event-Type` | `{eventType}` |
| `X-openwop-Timestamp` | Unix-seconds |
| `X-openwop-Signature` | `sha256={hex}` — HMAC over `{X-openwop-Timestamp}.{rawBody}` |
| `X-openwop-Signature-Algorithm` | `v1` |

### The key reframe: this is a header-ENCODING bug within scheme v1, not a crypto-scheme change

The cryptographic scheme is **already correct**. The host computes
`HMAC-SHA256(secret, `${timestamp}.${rawBody}`)` — byte-identical to the spec's
`v1` recipe (`webhooks.md` §"Verification recipe"). The **only** divergence is
how that value (and the timestamp, event type, id) is *encoded into HTTP
headers*: a combined `openwop-signature: t=,v1=` token instead of the spec's
separate `X-openwop-Timestamp` + `X-openwop-Signature: sha256={hex}` +
`X-openwop-Signature-Algorithm: v1`.

This distinction drives the whole decision:

- `webhooks.md` §"Signature algorithm versioning" — the `X-openwop-Signature-Algorithm`
  ladder and its **dual-*deliver*** guidance ("one delivery per scheme version
  during a per-subscription migration window") exist for **incompatible crypto
  schemes** (v1 HMAC → v2 Ed25519), where the signed bytes / secret / key
  differ. That machinery does **not** apply here: old and new are the *same*
  scheme (v1), signing the *same* bytes with the *same* secret.
- Because the HMAC and body are identical, **both header sets can ride a single
  delivery with zero cryptographic conflict.** A legacy subscriber reads
  `openwop-signature`; a spec-conformant subscriber reads the `X-openwop-*` set;
  both verify the same body. The header *names* differ, so there is no collision.

### Blast radius

This is a **breaking change on the OpenWOP webhook-delivery wire** for any
subscriber currently verifying `openwop-signature: t=,v1=`. Webhook breakage
fails at the *receiver* and is **invisible to this host** (we still get a `2xx`
or a silent drop), so a hard cutover would silently strand every live
subscriber. That invisibility is the dominant risk.

### Scope facts that make this cheap

- **One signer.** `sendDelivery()` is the *only* place a webhook is signed
  (`routes/webhooks.ts:203` `/v1/webhooks/:id/test` and `deliverHostExtEvent`
  both route through `enqueueDelivery` → the same worker). No second signer to
  keep in lockstep. Single source of truth.
- **The delivery record already carries everything the spec headers need**
  (`types.ts:146` `WebhookDeliveryRecord`): `subscriptionId` →
  `X-openwop-Webhook-Id`, `eventType` → `X-openwop-Event-Type`, `secret`,
  `payload`. `version.ts` `APP_VERSION` → the `User-Agent`.
- The conformance scenario (`webhook-signed-delivery`) asserts the `X-openwop-*`
  header **values**; it does **not** forbid additional headers, so emitting the
  legacy set alongside stays green.

### RFC gate: none needed

`webhooks.md` is **Stable v1.1** and already defines the target headers. This
work *conforms the host to an already-Stable spec* — it proposes **no** change
to the wire contract, so **no `openwop` RFC is required** (per `CLAUDE.md` §"A
spec change needs an RFC"). Discovery already advertises
`webhooks.signatureAlgorithms:['v1']`; today that advert is *dishonest* (the
emitted v1 encoding isn't the spec's) — this fix makes it honest without
changing the advert. The spec's registration-time algorithm-negotiation MUST
("registration response carries the algorithm the dispatcher will use"; "honor
the subscriber's advertised supported-algorithms list") is a **latent host gap
that bites only for v2+ schemes** and is explicitly out of scope here (we
introduce no new scheme) — tracked as a follow-up, not an RFC.

## Decision

Adopt **Option B — dual-emit both header sets, then a scheduled removal** (the
phased plan below). Emit the full spec `X-openwop-*` header set on every
delivery *immediately*, keep the legacy three headers for an announced
deprecation window, then remove the legacy set in a dated follow-up phase.

## Options considered

Forces: (1) **blast radius** — no silent breakage of live subscribers; (2)
**single-source-of-truth / no parallel system** — don't build a durable
second "header dialect" concept; (3) **spec conformance now** — turn the
suite red → green; (4) **reversibility**; (5) **honest wire** — advertised v1
must be the emitted v1.

| Option | Cost now | Debt left | Blast radius at cutover | Reversibility | Verdict |
|---|---|---|---|---|---|
| **A — Hard cutover** (replace the 3 legacy headers with the spec set) | ~10 lines | none | **Every live subscriber breaks, silently** (fails at receiver) | trivial revert (but breakage already invisible) | **Rejected** — unacceptable silent breakage on a fail-at-receiver wire |
| **B — Dual-emit both sets, scheduled removal** | ~12 lines (add 5 headers) | legacy headers linger until Phase 2 (a *dated one-liner* removal) | **Zero** — no subscriber breaks; conformance green immediately | trivial | **Chosen** |
| **C — Per-subscription opt-in** (store `headerFormat`/supported-algorithms per subscription; new regs default spec, old stay legacy) | schema migration + registration API change + branch in `sendDelivery` + re-register flow | **Two code paths indefinitely**; a durable "which dialect" field that only encodes "registered before/after date X" | zero | hard (migration + API surface) | **Rejected** — builds a parallel format-negotiation system for a problem dual-emit solves for free; the spec's per-subscription negotiation is for incompatible *schemes*, not header encoding |

**Dominant force: single-source-of-truth + blast radius.** Option C stands up a
second concept ("header dialect per subscription") that Option B makes
unnecessary — the classic parallel-system smell. Option A's silent
live-subscriber breakage is disqualifying for a wire whose failures are
invisible to the sender. **Option B** costs ~12 lines, breaks nobody, goes
conformance-green at once, and — crucially — *degenerates to the clean
spec-only state* after Phase 2, because the legacy removal is a scheduled
one-line deletion, not a per-subscription flag maintained forever.

**Falsifiability.** Switch to Option A if we can prove there are **zero** live
external subscribers (e.g. the surface has never been used outside tests) — then
dual-emit is needless and a hard cutover is simplest. Switch toward Option C
only if a genuine *incompatible crypto scheme* (v2 Ed25519) is introduced, at
which point the spec's per-subscription negotiation becomes the right tool and
gets its **own** RFC + ADR.

## Implementation plan

### Phase 1 — Dual-emit (this ADR, host-only, no RFC)

`sendDelivery()` in `webhookDeliveryWorker.ts` — add the spec headers alongside
the legacy set (single function, single signer):

```ts
const timestamp = Math.floor(Date.now() / 1000).toString();
const hmac = createHmac('sha256', await openWebhookSecret(rec.secret))
  .update(`${timestamp}.${rec.payload}`).digest('hex');
// ...
headers: {
  'content-type': 'application/json',
  'user-agent': `openwop-webhook-dispatcher/${APP_VERSION}`,
  // Spec v1 (webhooks.md §Headers) — the conformant set:
  'x-openwop-webhook-id': rec.subscriptionId,
  'x-openwop-event-type': rec.eventType,
  'x-openwop-timestamp': timestamp,
  'x-openwop-signature': `sha256=${hmac}`,
  'x-openwop-signature-algorithm': 'v1',
  // LEGACY (ADR 0538 Phase 2 removal — deprecation window ends <date>):
  'openwop-signature': `t=${timestamp},v1=${hmac}`,
  'openwop-event-type': rec.eventType,
  'openwop-subscription-id': rec.subscriptionId,
},
```

Tests (`backend/typescript/test/`): assert BOTH sets present, the `X-openwop-Signature`
verifies per the spec recipe (`sha256=` prefix stripped, HMAC over `{ts}.{body}`),
and the legacy combined header still verifies — one delivery, two valid
encodings. Add a sabotage check (dropping the `X-` set) so the test is
non-vacuous. Bump the conformance pin's `webhook-signed-delivery` axis to green
(it will pass once the `X-` headers land).

### Phase 2 — Remove legacy headers (scheduled follow-up, a real gate)

After an **announced deprecation window** (the gate: external-subscriber
communication + a fixed date; recommend ≥ 90 days), delete the three legacy
headers, leaving the spec set only. A dated one-line change + a test flip. This
ADR's §Implementation record will note the removal commit.

### Out of scope (tracked separately, NOT folded in)

- **Body wrapper divergence.** `enqueueDelivery` sets `payload =
  JSON.stringify(event)` (a bare `EventRecord`), while `webhooks.md` §"Body"
  specifies the wrapper `{ runId, workspaceId, event }`. This is a *distinct*
  conformance question from the signature headers and must be verified
  independently — the record has no `workspaceId`, so it needs its own change if
  confirmed. Do NOT couple it to the header fix. (Named here so it is not
  silently dropped.)
- **v2+ scheme negotiation** (registration-time supported-algorithms) — only
  relevant when a second crypto scheme is introduced; would carry its own RFC.

## Consequences

- **Positive:** the host becomes honestly conformant to `webhooks.md` v1.1;
  `webhook-signed-delivery` goes green; the `signatureAlgorithms:['v1']` advert
  becomes truthful; zero subscriber breakage; the end state (post-Phase 2) is a
  single clean header set with no lingering dual-path system.
- **Negative / accepted trade-off:** deliveries carry ~5 extra header bytes-worth
  of duplication during the deprecation window; a dated Phase-2 task must be
  tracked so the legacy set doesn't linger indefinitely.
- **Replay/fork:** unaffected — webhook delivery is a best-effort side effect off
  the event log, not run state; the per-attempt timestamp is already re-signed on
  retry.
- **Security:** unchanged — the signature is a MAC, not the secret; unseal still
  happens only at sign time; no new surface.

## Implementation record

- Phase 1: **DONE** — `fc18bec6f` (#3105). `webhookDeliveryWorker.ts` dual-emits the
  spec header `openwop-signature: t=<ts>,v1=<sig>` alongside the legacy
  `x-openwop-signature` / `x-openwop-signature-algorithm` pair, so existing receivers
  keep verifying while `webhooks.md` v1.1 consumers get the conformant shape.
  `test/webhook-delivery-queue.test.ts` pins the spec recipe and the dual-encoding
  equivalence, sabotage-checked (breaking the canonical signature reds 2 tests).
- Phase 2: _pending_ (dated legacy-header removal after the deprecation window).
