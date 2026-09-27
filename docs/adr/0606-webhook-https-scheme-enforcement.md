# ADR 0606 — Webhook subscriptions must use `https:`, at registration and at delivery

Status: implemented

## Context

`spec/v1/webhooks.md` is a **Stable v1.1** surface. Two of its normative lines
bear on the subscription `url`:

- `:41` — *"MUST be `https://`. The server SSRF-validates against private-IP /
  metadata-server ranges (see §Security below)."*
- `:161` — §"SSRF protection" lists the shapes registration refuses, and the
  first entry is **"Non-`https://` protocols"**.

This host implemented the second half of that sentence and not the first.
`routes/webhooks.ts assertReachableUrl` accepted `http:` alongside `https:` and
then checked only the hostname against the denied ranges. The delivery worker
(`host/webhookDeliveryWorker.ts sendDelivery`) posts through `undiciFetch`
directly with the egress-guard **dispatcher**, which re-validates the resolved
**address** — a `lookup` function cannot see a protocol, so no scheme check
happened there either.

Note the delivery worker does **not** route through `guardedEgressFetch`, whose
step 2 *is* an https check. Five outbound surfaces that take a caller- or
config-supplied url were checked and each requires https: `sandboxAdapter:156`,
`triggerIngestionService:256`, `webResearchSurface`, `mcpClient:570`,
`smtpEgress:75`.

**That is five of fifteen, and the gap is not unique to webhooks.** Fifteen files
dial through `webhookEgressDispatcher()` without `guardedEgressFetch`. An earlier
draft of this ADR called webhook delivery "the one egress path that had the
address arm without the scheme arm"; that was a universal claim resting on five
measurements, and checking further falsified it. Two siblings, recorded honestly
with the strength of each claim, under Follow-ups below.

### What was measured, not inferred

On `d1771e70c` with `OPENWOP_WEBHOOK_ALLOW_PRIVATE` unset:

| probe | result |
|---|---|
| `assertReachableUrl('http://example.com/hook')` | **ACCEPTED** |
| `assertReachableUrl('https://127.0.0.1/hook')` — control | REJECTED `ssrf_guard` |
| `assertReachableUrl('https://127.0.0.1/hook')`, flag ON | ACCEPTED |
| `assertReachableUrl('http://169.254.169.254/computeMetadata/v1/')` | REJECTED `ssrf_guard` |

and, enqueuing that accepted row against the delivery worker with `undici.fetch`
mocked: `fetches=1 to=http://example.test/hook` — **one plaintext POST**, carrying
the event payload plus `x-openwop-signature` / `openwop-signature`.

The first probe of the registration behaviour was written with
`expect(true).toBe(true)` and `console.log`, and reported **4 passed while
printing nothing** — vitest swallows stdout by default. It was rewritten to force
each disposition into an assertion diff, which is the only reason the numbers
above exist. A probe whose result lives in stdout is a probe that can report
success having observed nothing.

### Severity, stated honestly

**Bounded to public hosts.** The metadata-server case the spec calls out at `:169`
was already refused, by the denied-host arm, plaintext or not. So this was never
a path to the runtime's service-account token.

**What did leak is confidentiality, not the secret.** HMAC authenticates; it does
not encrypt. A plaintext delivery exposes the full event payload to anyone on
path, and the captured request **replays to the receiver** inside the spec's ±5min
freshness window — it is a validly-signed message. The signing secret itself is
never on the wire.

It also made a **false claim to subscribers**: a receiver that follows
`webhooks.md` is entitled to assume deliveries arrive over TLS.

## Decision

Add the missing scheme arm at **both** layers.

1. **Registration** (`assertReachableUrl`) — reject a non-`https:` url with
   `webhook_url_rejected` / `reason: 'insecure_scheme'`.

   Ordering is load-bearing and deliberate:
   - the existing `unsupported_protocol` arm stays **first** and **outside** the
     dev-flag escape, so the flag can never turn this endpoint into a `file:`
     reader;
   - the new arm sits **after** the `OPENWOP_WEBHOOK_ALLOW_PRIVATE` early return,
     so the plaintext loopback receiver the conformance suite registers keeps
     working;
   - it sits **before** the denied-host arm, so a caller retrying `http://` to a
     private host is told the reason that is true of every retry they could make
     with that url, rather than one that changes if they switch hosts.

2. **Delivery** (`sendDelivery`) — re-check the scheme before fetching, gated on
   the same flag. Rows registered *before* this ADR are still in the queue, and
   the delivery layer is what decides what actually leaves the process. It fails
   closed: a plaintext row becomes a delivery failure and rides the existing
   backoff to dead-letter.

This mirrors a decision the codebase already made once. RFC 0093 §A.1 re-validates
the resolved address at delivery time rather than trusting the registration-time
check; the same reasoning applies to the scheme, and for a stronger reason — the
address can change between the two moments, but a stored url that was never
checked stays wrong forever.

### Why the dev flag reopens both arms

`OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` already opens every other egress arm on this
host, at both layers, and `routes/webhooks.ts` documents that as intended. That
placement is **required**, not merely conventional: the conformance suite's
operator contract puts a MUST on the guard at `POST /v1/webhooks` specifically
(quoted in full under Open questions). A host whose opt-in reaches delivery only
cannot register the test receiver, so `webhook-signed-delivery` soft-skips and
reports `pass` having observed nothing.

### Ordering at delivery is forced, and it shadowed an existing test

At registration the scheme arm is placed before the denied-host arm as a
*choice* — there is a caller to inform, and the scheme reason is the one true of
every retry they could make with that url.

At delivery there is no caller and both arms fail closed into the same retry
policy, so the placement looked free. It is not. **You cannot check a resolved
address without attempting the connection the scheme arm exists to prevent**, so
scheme-first is forced there rather than chosen.

The cost surfaced immediately, and only because the gate caught it:
`rfc0093-webhook-egress.test.ts` — *"refuses delivery when the hostname resolves
into a denied range"* — used `http://localhost:PORT/ok` and asserted `lastError`
contains `webhook egress denied`. With the new arm, that row short-circuits
before the fetch, so the test **stops exercising the pinned-resolution lookup
guard entirely** while still failing for a different reason. Had it asserted
merely "delivery failed" rather than the specific message, it would have gone on
passing having tested nothing — the same defect class this ADR's own probes hit.

Fixed by repointing that url to `https://`, which keeps the assertion aimed at
RFC 0093 §A.1 and is the more faithful scenario besides: the production shape of
this attack is an https url whose hostname *resolves* privately. The connection
still dies inside `lookup`, before any TLS handshake, so the plain-http receiver
is never contacted.

**Verified the repointed test kept its teeth** rather than assuming it: disabling
the lookup guard turns it red, and the sabotage error is an OpenSSL handshake
failure — i.e. resolution succeeded and the socket reached TLS, proving the path
under test really is the lookup guard.

## Alternatives weighed

- **Registration only.** Cheaper, and the blast radius is nil today (zero stored
  `http:` rows in any fixture or test). Rejected: it leaves the layer that
  performs the egress trusting a check made at a different time by different
  code, which is precisely the pattern RFC 0093 §A.1 exists to refuse.
- **Route delivery through `guardedEgressFetch`.** Architecturally tidier — one
  egress helper, no subset adoption. Rejected *here* as scope, and its
  `redirect: 'error'` / dispatcher wiring is already duplicated correctly in
  `sendDelivery`. Consolidating it is a real follow-up, and is the shape that
  would prevent the next instance of this class rather than fixing this one.

  > **CORRECTED by ADR 0607.** This bullet originally gave the reason as *"that
  > helper does not carry `signal`"*. **False, and measurable in one line:** its
  > second parameter is `Parameters<typeof undiciFetch>[1]`, spread verbatim into
  > the call, so `signal` passes through today. The real obstacle is different and
  > smaller — each remaining call site maps failures onto its own typed error, so
  > adoption is eleven small error-mapping migrations rather than one edit. A
  > wrong reason attached to a right decision is the harder kind to catch,
  > because the decision keeps looking correct.
- **Grandfather existing `http:` rows.** Rejected: there are none, and a
  grandfather clause would be an unfalsifiable exemption with no population.

## Consequences

- `POST /v1/webhooks` now **400s** a request it previously accepted. This is a
  behaviour change on a public endpoint, justified as a **safety fix** against a
  Stable-surface MUST rather than a new restriction. The error names
  `insecure_scheme`, so a caller can act on it.
- No wire-shape change: no new field, no new capability, no new event, and
  `webhook_url_rejected` is the code the spec already assigns to this class.
  **No RFC needed** — this makes the host honour an existing normative MUST it
  was violating, which is the opposite of a spec change.
- Zero test or fixture changes were required: nothing in the repo registered an
  `http:` webhook url.

## Implementation record

| Piece | Where |
|---|---|
| Registration arm | `backend/typescript/src/routes/webhooks.ts` `assertReachableUrl` |
| Delivery arm | `backend/typescript/src/host/webhookDeliveryWorker.ts` `sendDelivery` |
| Registration tests (8) | `backend/typescript/test/adr0606-webhook-https-scheme.test.ts` |
| Delivery tests (3) | `backend/typescript/test/webhook-delivery-queue.test.ts` |
| Repointed egress test | `backend/typescript/test/rfc0093-webhook-egress.test.ts` (see Ordering, above) |

**Sabotage-verified**, since a guard that cannot fail is indistinguishable from
one that never runs:

| sabotage | result |
|---|---|
| registration arm deleted | 2 red |
| delivery arm deleted | 1 red |
| both restored | 16 green |
| RFC 0093 lookup guard disabled (does the repointed test still bite?) | 1 red |

Each suite carries a **positive control** — an `https:` url that must still be
accepted / still be delivered — so an arm that refused *everything* cannot pass
as an arm that refuses only plaintext.

## Follow-ups — the same class, elsewhere

Found while verifying a universal claim this ADR should not have made. Neither is
fixed here; both are named with the evidence and with how strong the obligation
actually is, which differs.

**1. A2A push sink — `host/a2aTaskStore.ts assertPushUrlAllowed`.** Structurally
identical to `assertReachableUrl` before this ADR: it rejects a non-http(s)
scheme, then checks `isDeniedWebhookHost`, and **accepts `http:`**. The sink at
`routes/registerAllRoutes.ts:308` then POSTs the `TaskStatusUpdateEvent` through
the dispatcher with no scheme check, under a comment reading *"the URL was
already SSRF-validated at register time"* — the trust-the-other-layer pattern
this ADR's delivery arm exists to refuse. Its own docblock already states the
premise: *"a push URL is the same SSRF surface as a webhook."*

**Strength of the obligation: weaker than this ADR's, and worth saying so.**
`a2a-integration.md:461` says the url *"MUST pass the RFC 0093 webhook-egress
SSRF guard before registration"*, and `SECURITY/invariants.yaml`
`a2a-push-egress-ssrf` spells the requirement out as *"no private/loopback/
link-local target"* — the address arm, named; the scheme arm is not. It arrives
only by reference, via "identical to a webhook" plus `webhooks.md:161`. That is a
chain of inference, not a quotable MUST, and this ADR is not going to repeat the
mistake corrected under Open questions by treating the two as equivalent.

**2. Priority-matrix federation — `features/priority-matrix/federationService.ts:308`.**
GETs `${peer.baseUrl}/v1/host/…` with the dispatcher. `peer.baseUrl` is
tenant-configured. Not yet traced to its config-time validation, so no claim is
made about whether a scheme arm exists upstream — this is a lead, not a finding.

The structural fix for the whole class is the second alternative above: give
`guardedEgressFetch` a `signal` and route these call sites through it, so a new
egress site cannot adopt the address arm without the scheme arm. That prevents the
next instance rather than fixing this one, which is why it is the follow-up worth
doing and not a widening of this ADR.

## Open questions

**Which layers should `OPENWOP_WEBHOOK_ALLOW_PRIVATE` reach? — ANSWERED, and the
first version of this section got it wrong.**

This section originally read: *"`webhook-signed-delivery.test.ts:23-24` says a
host with an SSRF guard SHOULD provide an equivalent opt-in and names this flag —
without saying which layer the opt-in must reach. Both readings satisfy the
sentence, so one of the two hosts is non-compliant with a rule nobody has
written."* **That is false, and it was false when written.**

The contract does name the layer. The sentence *before* the SHOULD is a MUST, and
`conformance/src/scenarios/webhook-signed-delivery.test.ts:19-25` reads in full:

> *Operator contract: hosts that implement a SSRF guard on `POST /v1/webhooks`
> (rejecting loopback / RFC1918 / link-local destinations to protect deployer
> infrastructure) **MUST allow the test receiver.** The SQLite reference host
> bypasses the guard when the `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` env var is set
> at boot. Test-only hosts SHOULD provide an equivalent opt-in. When the host
> rejects with `400 webhook_url_rejected`, this scenario skips with a warning.*

The MUST is on the guard **at `POST /v1/webhooks`** — registration, named
explicitly. The SHOULD is about the *mechanism* being equivalent to the reference
host's env var; it is underspecified about **how** a host opts in, not about
**which layer** the opt-in reaches. The layer was settled by the clause before it.

So this host's two-layer reading is the compliant one, and the trailing skip
sentence is **tolerance for a non-compliant host, not permission to be one** — it
is the mechanism by which such a host's violation reports as `pass`.

**How the error was made, because the shape recurs.** A peer quoted lines 23-24
of that docblock; the reasoning here was built on the quoted excerpt without
opening the file. An excerpt is not the clause. The argument that filled the gap —
that the delivery-only reading makes the flag functionally dead, so it cannot be
what the sentence intends — reaches the right conclusion by the wrong route, and
a consequence-argument that lands on the correct answer is indistinguishable from
one that does not until someone reads the text. The peer who *was* running the
non-compliant reading is the one who found the MUST, against their own position.

Nothing in the Decision or Implementation record above depends on this; the
scheme arm is required by `webhooks.md:41` regardless. What changes is that this
host's flag placement is now **contract-backed rather than merely defensible**,
and this ADR no longer claims a corpus gap that does not exist.

**Should webhook delivery adopt `guardedEgressFetch`?** See Alternatives. The
present split — one path with the address arm but not the scheme arm — is exactly
the "weaker subset" that helper's docblock warns a new call site must not adopt.
Webhook delivery predates it.
