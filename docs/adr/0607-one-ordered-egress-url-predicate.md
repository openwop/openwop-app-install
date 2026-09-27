# ADR 0607 — One ordered egress-URL predicate, and a ratchet for the next call site

Status: implemented

## Context

ADR 0606 fixed webhooks: `assertReachableUrl` accepted plaintext `http://` to a
public host and the delivery worker shipped it. That ADR also made a claim it
should not have — that webhook delivery was *"the one egress path that had the
address arm without the scheme arm"* — on the strength of five measurements out
of fifteen call sites. **Checking the other ten falsified it in minutes.**

### Two more instances, both structurally identical

**1. A2A push config** — `host/a2aTaskStore.ts assertPushUrlAllowed`. Rejected a
non-http(s) scheme, checked `isDeniedWebhookHost`, and **accepted `http:`** — the
exact shape `assertReachableUrl` carried before ADR 0606. Its own docblock states
the premise it violated: *"a push URL is the same SSRF surface as a webhook."*

The sink at `routes/registerAllRoutes.ts` then POSTed the `TaskStatusUpdateEvent`
through the dispatcher with no scheme check, under a comment reading *"the URL was
already SSRF-validated at register time"* — the trust-the-other-layer pattern
ADR 0606's delivery arm exists to refuse.

**2. Priority-matrix federation** — `features/priority-matrix/federationService.ts
validateBaseUrl`. Same shape, and **the worst of the three**: `rawPeerGet` sends
`authorization: Bearer ${token}` to the tenant-configured `peer.baseUrl`. Plaintext
there meant a **peer credential in the clear**, not merely a readable payload.
ADR 0606's severity paragraph — *"confidentiality, not the secret"* — is true of
webhooks and **false of this one**.

Three hand-rolled near-copies of one ordered predicate is precisely the drift
`isDeniedWebhookHost` was extracted to prevent, one arm later. The predicate was
shared; the *order and composition* around it were not.

### Why a regex ratchet was rejected

The first attempt to classify these files grepped for `protocol !== 'https:'`. It
produced **two false negatives and a false positive on code written minutes
earlier**. Pattern-matching source for "does this file have the arm" is not a
check, it is a guess that reports with the confidence of a check.

## Decision

**1. One ordered predicate, two entry points**, in `host/webhookEgressGuard.ts`:

- `assertEgressUrlAllowed(url, { honorDevFlag })` — the full ordered arms, for
  registration/config time.
- `assertEgressSchemeAllowed(url, { honorDevFlag })` — **scheme arms only**, for
  delivery time.

Both throw a typed `EgressUrlRejectedError` carrying a `reason`
(`invalid_url` | `unsupported_protocol` | `insecure_scheme` | `denied_host`), and
each call site keeps only the job that is genuinely local: mapping that reason
onto the error shape its own surface promises.

The order is ADR 0606's, and every clause is load-bearing:

1. unparseable → `invalid_url`
2. not http(s) → `unsupported_protocol`, **outside** the dev-flag escape, so a
   local-development switch can never turn an endpoint into a `file:` reader
3. dev-flag early return, when `honorDevFlag`
4. not https → `insecure_scheme`, **before** the host arm, so a caller retrying
   `http://` to a private host is told the reason true of *every* retry
5. denied host → `denied_host`

**2. `assertEgressSchemeAllowed` deliberately omits the denied-host precheck**,
and the omission is the design rather than an oversight. At delivery the address
is validated at connect time by the dispatcher's pinned-resolution `lookup`,
which is strictly stronger — it catches the DNS rebind a literal string check
cannot see (RFC 0093 §A.1). Adding the string precheck would **shadow** that
guard for every literal hostname, silently converting
`rfc0093-webhook-egress.test.ts`'s pinned-resolution assertion into a string-match
assertion. That is ADR 0606's own shadowing incident, which this ADR would
otherwise have re-created while claiming to consolidate.

A scheme check has no stronger counterpart at connect time — **`lookup` never
sees a protocol** — which is exactly why the scheme arm must run at this layer
and the host arm must not.

**3. `honorDevFlag` is a parameter because the two postures are both required**,
not because callers differ in taste:

| surface | posture | why |
|---|---|---|
| webhook registration + delivery, federation | `true` | the conformance operator contract puts a **MUST** on the guard at `POST /v1/webhooks`; `webhook-signed-delivery` registers a `127.0.0.1` receiver, and a host whose opt-in misses registration soft-skips and reports `pass` having witnessed nothing |
| A2A push config + sink | `false` | `SECURITY/invariants.yaml` `a2a-push-egress-ssrf` has a conformance leg asserting a private push url is **refused** |

Both legs run in the same process. **A single global posture makes them mutually
unsatisfiable** — that is the whole reason this is a parameter, and it is pinned
by a test that asserts the two surfaces disagree under one flag value.

**4. A registry ratchet.** `DISPATCHER_SITES` names every file that dials
`webhookEgressDispatcher()` with the arm that covers it. A new egress site turns
the suite red until someone writes down which arm applies. It does not try to
*verify* the arm — it forces the question to be answered once, by a human, which
is the part the regex got wrong.

## Alternatives weighed

- **Route every call site through `guardedEgressFetch`.** ADR 0606 proposed this
  and gave a reason that was **wrong**: "that helper does not carry `signal`."
  Measured — its second parameter is `Parameters<typeof undiciFetch>[1]`, spread
  verbatim, so `signal` passes through today. The real obstacle is different and
  smaller: each of the eleven remaining sites maps failures onto its own typed
  error (`sandbox_transport_error`, `image_provider_blocked`, …), so adopting the
  helper is eleven small error-mapping migrations, not one edit. Rejected **as
  scope**, not as direction, and the correction is recorded rather than the
  original reason quietly repaired.
- **Fix only A2A and leave federation.** Rejected: federation is the instance
  that leaks a credential.
- **A regex ratchet over source.** Rejected on measurement — see Context.
- **Migrate the eleven pre-existing hand-rolled copies now.** Each already
  carries **both** arms (verified by reading each one, not by grepping). They are
  duplication, not defects. Churning them would mix a security fix with a
  refactor of code that is currently correct.

## Consequences

- `POST /v1/host/openwop-app/priority-matrix/peers` and A2A push-config
  registration now reject `http://` urls they previously accepted. Behaviour
  changes on two surfaces, justified as safety fixes.
- The A2A obligation is **weaker than the webhook one and this ADR says so**:
  `a2a-integration.md:461` and the `a2a-push-egress-ssrf` invariant both spell out
  the *address* arm and neither names the scheme; it reaches A2A by inference from
  "identical to a webhook" plus `webhooks.md:161`. Fixed anyway — a bearer-token
  and a payload are worth more than the strength of the citation — but the
  citation is not overstated. (ADR 0606 was corrected for exactly this class of
  error; repeating it here would be worse than the original.)
- No wire change, **no RFC**: no new field, capability, or event.

## Implementation record

| Piece | Where |
|---|---|
| Shared predicate + typed error | `src/host/webhookEgressGuard.ts` |
| Webhook registration (delegates) | `src/routes/webhooks.ts` |
| Webhook delivery (delegates) | `src/host/webhookDeliveryWorker.ts` |
| A2A push config | `src/host/a2aTaskStore.ts` |
| A2A push sink (new arm) | `src/routes/registerAllRoutes.ts` |
| Federation, both layers | `src/features/priority-matrix/federationService.ts` |
| Tests + ratchet (14) | `test/adr0607-egress-url-arms.test.ts` |

**Sabotage-verified**, including the ratchet itself, since a guard that cannot
fail reads exactly like one that passes:

| sabotage | result |
|---|---|
| shared https arm removed | 3 red |
| A2A flipped to honour the dev flag | 1 red |
| federation registration arm removed | 2 red |
| delivery scheme arm removed | 4 red (with the ADR 0606 suite) |
| a new UNCLASSIFIED dispatcher site added | **1 red**, naming the file |
| the ratchet's file walk made to find nothing | **2 red** — the non-vacuity floor bites |
| all restored | 53 green across four suites |

The last two matter most. Without the vacuity floor, a broken walk would make
every registry assertion pass over an empty set — the ratchet would report green
having enumerated nothing, which is the exact failure it exists to catch.

### Arm isolation, proven by sabotage rather than by reading

A guard with two arms invites a third failure mode, distinct from a mirror and
from a vacuous green: an **under-determined** probe. `http://10.0.0.5/push`
violates the scheme arm *and* the address arm, so a test that only asserts "it was
refused" witnesses that *something* refused and never *which guard ran*. A host
with only one arm passes. The assertion is correct; the inference drawn from it is
not, and the gap is not visible in the file.

Every probe here is arm-isolated **by construction** — each scheme probe uses a
*public* host, each address probe uses *https* — but construction is a claim about
intent, so it was measured:

| sabotage | tests that went red |
|---|---|
| **scheme arm only** removed | plaintext-to-public (A2A) · plaintext peer (federation) · plaintext-to-private reports the scheme |
| **address arm only** removed | private address (A2A) · dev flag does not reopen A2A · private peer host |

**Disjoint sets, three and three.** No probe is refused by the arm it is not
testing, so each names the arm it covers. The one probe that *is* deliberately
double-violating — `http://169.254.169.254/…`, which trips both — is determined
anyway, because it asserts `insecure_scheme` specifically: it exists to pin the
ORDER, and asserting the reason is what makes an ordering test possible at all.

The distinction is worth keeping: *"I looked and the shape isn't there"* and
*"I proved the shape isn't there"* are different claims, and only the second
survives someone editing the guard later.

ADR 0606's eight behavioural pins pass **unchanged** through the refactor; that
they were not edited is the evidence the delegation preserved behaviour.

## Follow-ups

- Migrate the eleven hand-rolled copies onto the shared predicate, one error
  mapping at a time. The ratchet makes this visible without forcing it.
- `host/knowledgeSourceFetch.ts` mixes `guardedEgressFetch` with a raw dial in one
  file — worth a look at whether the raw path is deliberate.
