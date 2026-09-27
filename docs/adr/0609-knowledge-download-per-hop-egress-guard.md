# ADR 0609 — The knowledge-sync download leg guards every redirect hop (closes `KSC-8`)

Status: implemented

## Context

ADR 0605 Tier 7 found that `host/knowledgeSourceFetch.ts fetchGuardedBytes`
**hand-rolls a weaker subset of `guardedEgressFetch`** and recorded the four gaps
verbatim:

> no per-hop scheme check … no `AbortSignal.timeout`, no `maxResponseSize` (the
> cap is applied *post*-buffering), and it skips the ADR 0187 tenant egress
> firewall.

It was **deferred with a stated reason**, and that reason names the debt this ADR
pays:

> A per-hop scheme check changes what `fetchGuardedBytes` accepts from a live
> provider — a behaviour change, which **owes a witness against a real redirect
> chain**. A records tier must not smuggle one in. Filed OPEN as `KSC-8`.

The function is reached by three callers — OneDrive, Dropbox, Box — each fetching
a **pre-authenticated download URL** returned by the provider. No credential
rides the request, so there is no token-leak-on-redirect. What rides it is the
*content*, on its way into a customer's knowledge base.

### What each gap actually costs

1. **Scheme, hop 1 only.** `url.protocol !== 'https:'` was checked on the URL
   passed in, then `undiciFetch` was called with **no `redirect`** — so the
   default `'follow'` applied, up to 20 hops. A `302` to `http://` was followed
   and the body arrived **over cleartext, attacker-modifiable in transit**. The
   pinned dispatcher re-validates the resolved *address* per hop; a `lookup`
   function cannot see a protocol, so nothing re-checked the scheme.
2. **No timeout.** A provider that returns headers and then never finishes the
   body hung the call forever. The sync daemon is a self-rescheduling
   `setTimeout`, so one wedged download stalls that source indefinitely.
3. **Cap applied post-buffering.** `readBytes` does
   `Buffer.from(await res.arrayBuffer())` and checks `length` *afterwards*. A
   body larger than the cap is **fully materialised in memory before being
   rejected** — on a memory-bounded Cloud Run instance a multi-GB response
   OOM-kills the container and the 32 MiB "cap" never runs.
4. **Tenant egress firewall skipped.** The credentialed metadata leg goes through
   `brokeredFetch`, which calls `assertEgressAllowed` (ADR 0187). The download
   leg called neither, so a tenant policy denying a host did not bind on the leg
   that actually fetches the bytes.

## Decision

Replace the single-shot fetch with a **bounded manual redirect loop** that
re-applies every arm on **every hop**:

| arm | before | after |
|---|---|---|
| scheme | hop 1 | every hop, via ADR 0607's `assertEgressSchemeAllowed` |
| denied-host literal | hop 1 | every hop |
| tenant egress policy (ADR 0187) | never | every hop |
| resolved address | every hop (pinned `lookup`) | unchanged |
| timeout | none | `AbortSignal.timeout`, 60 s default |
| size cap | after buffering | **during** the read |
| redirect bound | undici's 20 | 5 |

`redirect: 'manual'` is what makes the arms per-hop; the default `'follow'` hands
the whole chain to undici, where none of them run again.

**The scheme arm delegates to ADR 0607's shared predicate** rather than
re-hand-rolling the comparison — this call site is one of the eleven that ADR
0607 listed as candidates for migration, and it is the one that turned out to
have a defect rather than mere duplication.

**Per-hop, not hop-1, for the tenant policy specifically**: a redirect target is
a *different host* than the one the policy was evaluated against, so a hop-1-only
check is bypassable by any provider that can redirect.

**The cap becomes a bound on what is read** rather than a verdict on what was
already read. `readBytes` is left alone — its other two call sites are on
`brokeredFetch` responses whose size profile is different, and changing them is
not this ADR's warrant.

## The witness ADR 0605 asked for — and what it can and cannot show

Every test drives a **real loopback HTTP server through a real `undiciFetch`**.
No mocked fetch: a mock cannot witness what undici's `redirect: 'follow'` default
does, which is the whole defect.

**The obvious test is not available, and writing it anyway would have been the
defect this repo has spent a week cataloguing.** The production downgrade is
`https:` hop 1 → `http:` hop 2 with the dev flag **off**. Serving hop 1 needs a
real TLS endpoint the pinned dispatcher will dial, which this suite cannot stand
up. With `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` (needed to reach loopback at all),
`http:` is permitted at every hop, so a downgrade is not a violation to observe.

So the property is witnessed in **two halves that together imply it**:

- **(a) the scheme arm runs per hop** — a `302` to `file:///etc/passwd` is
  refused with `unsupported_protocol`, which ADR 0607 deliberately places
  **outside** the dev-flag escape, so it bites on a redirect *target* even with
  the flag on. Hop 1 is really served first, so the refusal is on the target.
- **(b) the scheme arm requires https** — hop 1 over `http:` with the flag off.

Neither half alone is the claim, and the test file says so. **An honest
half-witness beats a test whose name asserts more than its body checks.**

## Sabotage table

| sabotage | result |
|---|---|
| `redirect: 'manual'` removed (the original `'follow'`) | 2 red |
| per-hop scheme arm removed | 2 red |
| tenant egress arm removed | 2 red |
| streaming reader reverted to `readBytes` | **1 red** — see below |
| redirect bound removed | 1 red |
| `AbortSignal.timeout` removed | 1 red (`Test timed out in 15000ms`) |
| all restored | **11 green** |

### The cap test had to be rewritten, because its first version could not fail

The first version asserted *"an over-cap body is rejected"*. **MEASURED: the
streaming sabotage left the suite fully green** — because `readBytes` also
rejects an over-cap body, just after materialising it. The assertion was true of
both implementations, so it named a property (*"WITHOUT buffering it whole"*) it
could not observe.

The discriminator is **how much the server got to write**. A streaming reader
aborts mid-body; a post-buffering reader consumes everything first. Rewritten to
count bytes written server-side: under the fix the server stops well short;
reverted to `readBytes` it wrote **all 16,777,216 bytes** and the test goes red
with that number in the message.

This is the same under-determined shape the ADR 0607 review named — an assertion
with two sufficient causes that reports neither — found here in a test written by
the author who had just written it up.

### Two things the gate caught that isolated runs could not

**1. A pre-existing mock went stale the moment the scheme arm was delegated.**
`test/knowledge-source-list-folder.test.ts` mocks `webhookEgressGuard` with a
three-key object literal. Delegating to ADR 0607's predicate means the module
imports two more symbols, which arrived `undefined`, so every download path threw
a mock error instead of exercising the guard. Repaired with `importOriginal` +
spread rather than by adding stubs: the file's subject is the denied-HOST arm,
which it mocks deliberately, and hand-rolling a scheme stub would have made these
tests assert against a *second* implementation of the thing ADR 0607 exists to
have one of.

**2. The streaming reader silently returned an EMPTY buffer for a response with
no body stream** — and the mocks in that file are exactly such responses. An
empty `Buffer` here is a **success-with-empty**: the sync would ingest a
zero-length document as the file's contents. That is the failure ADR 0605 Tier 1
removed from `readJson`, where "returned nothing" became an empty folder listing
and then a mass delete.

Fixed in the reader, not in the tests: a response exposing no async-iterable body
falls back to the buffered read, and one exposing neither is a typed
`internal_error`. The memory bound therefore holds on the **streaming** path,
which is the one real undici responses take.

**That fallback is exactly the kind of addition that hollows out a guard, so the
sabotage was re-run against it.** Disabling the streaming branch still turns the
cap test red with `server wrote 16777216 of 16777216 bytes` — the bound is
witnessed on the real-socket path, not merely present in the source.

## Consequences

- **A behaviour change on a live provider path**, which is what ADR 0605
  deferred. A provider that redirects a download to plain `http:` now fails the
  sync for that file instead of ingesting it. That is the intended change; the
  alternative is ingesting attacker-modifiable content.
- Redirect chains longer than 5 hops now fail. Provider pre-auth URLs observed in
  this codebase redirect once.
- A tenant egress policy now binds on the download leg. A tenant with an
  allowlist that omits a provider's CDN host will see downloads refused — which
  is the policy being honoured, not a regression.
- No wire change, **no RFC**: this is host-internal egress hardening.

## Implementation record

| Piece | Where |
|---|---|
| Redirect loop + four arms | `src/host/knowledgeSourceFetch.ts fetchGuardedBytes` |
| Streaming cap | same file, `readBytesStreamed` |
| `tenantId` threaded from all three callers | OneDrive / Dropbox / Box |
| Tests (11) | `test/ksc8-download-redirect-guard.test.ts` |
| Mock + store-boot repair (31 tests) | `test/knowledge-source-list-folder.test.ts` |

`KSC-8` is **closed**. Its sibling residuals in ADR 0605 (`KSU-22`, `KSWF-1`) are
untouched and remain open.

## Follow-ups

- `readBytes`'s two remaining call sites still cap post-buffering. Lower risk
  (both are `brokeredFetch` responses from credentialed provider APIs rather than
  redirect-reachable download URLs), but the same shape.
- ADR 0607's other ten hand-rolled egress copies remain candidates for the shared
  predicate. This one is migrated.
