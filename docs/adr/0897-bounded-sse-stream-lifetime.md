# ADR 0897 — bound every SSE stream server-side; readers resume

Status: implemented

## Context

ADR 0876 stopped host-extension streams from arriving through the Firebase
Hosting `/api` rewrite. It did not touch the bigger cause underneath, which was
measured on prod on 2026-10-15 (revision serving `2c73eda63`, anon tenant):

| probe | result |
| --- | --- |
| a `curl` stream to `*.run.app` ended by the client after 20 s | Cloud Run logged the request at **3601.0 s** |
| the copy Firebase opened through `/api` for a 20 s client | also **3601.0 s** |
| one client on `/host/events` through `/api` | nothing, then `503 first byte timeout` at 185.6 s; about 18 of 20 tenant slots held after 3 min |
| Firebase's upstream retries | about every 60 s, continuing after the client left; a fast complete reply (a `429` at 60.1 s) ended them |
| real-user (`t:user`) cap hits since kanban got its 120 s bound (#4691) | none (511 from 10-08 to 10-10) |

Both mechanisms are documented by Google:

- Cloud Run: "When you use HTTP/1.1 on Cloud Run, client disconnect events are
  not propagated to the Cloud Run container"
  ([troubleshooting](https://docs.cloud.google.com/run/docs/troubleshooting)).
  This service's port is `http1`. So **any** stream the server does not end
  itself holds its cap slot (`host/sseChannel.ts`, 20 per tenant) until the
  3600 s request timeout, however the client left.
- Firebase Hosting has a 60 s request timeout and buffers responses
  ([Hosting + Cloud Run](https://firebase.google.com/docs/hosting/cloud-run)).

Before this ADR only the kanban stream had a server-side bound. Six routes had
none: channel messages and presence, voice transcripts, notifications, present
remote, and the two OpenWOP wire streams `/runs/{id}/events` and `/host/events`.

## Decision

Follow the standard practice for long-lived HTTP streams: never rely on noticing
a disconnect; **bound each stream on the server, end it cleanly with a `retry:`
hint, and have the reader resume.** The WHATWG EventSource model already works
this way (a clean close after `200 text/event-stream` reconnects with
`Last-Event-ID` and honours `retry:`), and Mercure closes every connection by
design (`write_timeout`, 600 s default).

### D1 — a default lifetime for every stream (`host/sseChannel.ts`)

- `openSseChannel` ends a stream after `OPENWOP_SSE_MAX_AGE_MS` (default
  **300 000**, `0` turns the default off). An explicit `maxAgeMs` still wins
  (kanban stays at 120 s).
- The lifetime is jittered down by up to 10%, so a deploy's reconnect wave does
  not come back in step.
- A bounded close runs the route's teardown hooks first (a pending `bufferMs`
  batch flushes), then writes `retry: 1000`, then ends the response. Every
  route writes whole frames per `res.write`, and the timer fires between them,
  so the close is on a frame boundary.
- Cost: one reconnect per open stream every 5 min. Gain: a caller would need
  more than 20 abandoned streams within 5 min to reach the cap, instead of
  within an hour.

### D2 — the wire streams are bounded only for a consumer that opts in

`spec/v2/core/events.md` says that on a live run "the host MUST hold the stream
open for later events". `COMPATIBILITY.md` §2.2 forbids relaxing an existing
MUST within a major, so an unconditional bound would be a v3 change. OpenWOP
**RFC 0247** instead adds an opt-in: a consumer sends `resumable=true` (a query
parameter, because a browser `EventSource` cannot set headers) and in return
must resume on a close that carries no terminal event. Only then may the host
end the stream early.

- RFC 0247 (merged `Active`, openwop `ca6b4ad0`) adds `limits.maxStreamAgeSec`
  (integer ≥ 15). A host MUST NOT end an opted-in stream early unless it
  advertises it, MUST NOT end one before 15 s, and MUST end it by the advertised
  age. `host/streamAgeCapability.ts` is the one source for both the advert
  (`routes/discovery.ts`) and the bound. It is on only when the **vendored** v2
  capabilities schema defines the member, because the closed `limits` record
  rejects an unknown member (the RFC 0244 precedent, `host/evals/evalCapability.ts`).
  Until a corpus release carrying RFC 0247 is pinned and `schemas/` re-synced,
  the wire streams are not bounded at all, exactly as before. The advertised
  value is `ceil(OPENWOP_SSE_MAX_AGE_MS / 1000)` (300); jitter only shortens.
  With the default off (`0`) nothing is advertised and nothing is bounded.
- `/runs/{id}/events` and `/host/events` pass `boundWhen: 'resumable'`. Without
  `resumable=true` they behave exactly as before. Certification (which reads
  `api.openwop.dev` and sends no opt-in) is unaffected.
- On a front-door hop (ADR 0876's `frontDoorHop`) an opted-in wire stream is
  bounded at **50 s** (45–50 s after jitter, never under the 15 s floor), under Firebase's 60 s. The hop
  then delivers a complete response and stops retrying, so `/api` becomes a
  working long poll instead of a 503 plus a dozen held slots. RFC 0247's floor
  is 15 s.
- A stream that did not opt in through `/api` is unchanged (still broken, as it
  was). The MUST leaves no honest alternative, and the cap's 429 still protects
  the instance.

### D3 — every reader resumes, with nothing lost

Audited 2026-10-15:

| reader | on a clean close | change |
| --- | --- | --- |
| `client/streamsClient.ts` (run events) | ended the subscription | sends `resumable=true`; resumes with `Last-Event-ID` unless the terminal event arrived; a stream that lived ≥10 s or delivered resets the reconnect budget, one that ends at once spends it (still gives up after 5) |
| `notifications/notificationsClient.ts` | reconnects; `onOpen` backfills over REST | none |
| `kanban/kanbanClient.ts` | reconnects after 1 s; caller refetches | none |
| `client/channelsClient.ts` messages | reconnected, but a message posted in the gap sent no frame | a REconnect calls `onMessage()` once (a thread reload) |
| `client/channelsClient.ts` presence | reconnected, flashing "disconnected" | a clean end of a healthy stream reconnects without the cue |
| `chat/voice/voiceClient.ts` transcripts | as channel messages | as channel messages |
| `canvas/PresentRemotePage.tsx`, `CanvasPresentPage.tsx` | native `EventSource`, reconnects | none |

Presence is the connection itself, so the presence route now leaves only after
a **5 s grace**. The reconnect joins first and the count never reaches zero, so
other viewers see no blink.

### D4 — `SseChannel.onClose` runs every hook (a defect found here)

`onClose` kept only the **last** callback. The channel presence route registers
`leave` and then its ADR 0879 D5 access watch, so `leave` never ran: a viewer
who disconnected stayed present until the instance recycled. The message route
had the opposite order and leaked the access watch's 15 s interval. `onClose`
now runs every registered hook once, in order. All nine callers register one
teardown each, so none depended on replacement.

## Alternatives weighed

- **End-to-end HTTP/2 (`h2c`)**, Google's documented fix for propagating
  disconnects. Not now: Express 4 is not built for Node's `http2` server, and
  the collaboration and Claude Code terminal WebSockets use `ws`, which does not
  run over HTTP/2. If it is ever done, it complements a server-side bound rather
  than replacing one, since proxies elsewhere still hide disconnects.
- **Closing the older duplicate when Firebase retries.** Rejected: each retry
  has a different trace id and comes from a different Google IP, so "same
  client" would be a guess.
- **Refusing the wire streams through `/api`.** Rejected: it breaks short runs
  that work today and the spec's same-origin `eventsUrl`.
- **An unconditional bound on the wire streams.** Rejected by
  `COMPATIBILITY.md` §2.2 (see D2); that is what RFC 0247 replaces.

## Implementation

| phase | what | where |
| --- | --- | --- |
| P1 | D1, D3 (host-extension readers), D4, presence grace | this PR |
| P2 | D2 host side + SPA run-stream opt-in | this PR (RFC 0247 merged first) |
| P3 | `limits.maxStreamAgeSec` advert, from the same predicate | this PR; LIVE on the wire only after the corpus pin + `schemas/` sync that carries RFC 0247 |
| — | v2 SDKs send `resumable=true` and resume | openwop-sdks #58 (2.6.0, published 2026-10-16) |
| P1–P3 shipped | #4870 (4dc157029) + #4873, slot 101; LIVE on `00980-gl7` (`d601fecae`) | 2026-10-16 |
| P4 | corpus re-pin to v2.46.12 (RFC 0247) + `schemas/` sync: the advert and the opted-in wire bound turn ON | #4880 (aee0febbc, slot 105r); LIVE on `00983-dg2` 2026-10-16 |

Tests: `test/sse-channel.test.ts` (default, opt-in, jitter, front-door 50 s,
every-hook `onClose`), `test/adr0897-bounded-run-stream.test.ts` (real route: an
opted-in stream ends with `retry:`; `Last-Event-ID` resumes with no gap and no
duplicate, including an event appended while disconnected; a stream without
opt-in is held open; a pending batch flushes), and
`test/adr0897-presence-leave-grace.test.ts`. Frontend:
`client/__tests__/v2Clients.test.ts`, `channelsClientPresence.test.ts`,
`chat/voice/__tests__/voiceTranscriptsReconnect.test.ts`.

## Open questions

- [x] Pin a conformance release that carries RFC 0247 and re-sync `schemas/`
  (v2.46.12, tag `91c12ce4`; done in the P4 re-pin PR). Cut prediction for it:
  no result changes. RFC 0247 has no conformance leg (its gap G1), 2.46.12 changes
  no assertion, and 2.46.11 only re-attributes rows whose id two scenario files
  share (`assertions` / `scenario` may move on those, never a result). The new
  member is validated by `adr0670-v2-advert-validates` against the closed schema.
  (`scripts/sync-schemas.sh --tag …`). That one change turns on the advert and
  the wire bound together; check `/.well-known/openwop` → `limits.maxStreamAgeSec: 300`
  and re-cut certification (the new member must not move a row).

- [x] Host-extension half, MEASURED 2026-10-16 03:30Z on `00980-gl7`: a direct anon
  notifications stream was ended by the server at **286.37 s** (Cloud Run request
  latency; the same probe was 3601 s before), its last bytes `retry: 1000`, and
  `sse_bounded_close` logged `maxAgeMs` 286377. Presence is disabled on prod
  (`OPENWOP_CHANNEL_PRESENCE_ENABLED` unset), so the 5 s grace is witnessed only by
  `test/adr0897-presence-leave-grace.test.ts`.
- [x] Wire half, MEASURED 2026-10-16 06:13Z on `00983-dg2` (`aee0febbc`):
  `/.well-known/openwop` → `limits.maxStreamAgeSec: 300`. An opted-in direct
  `/host/events` was ended by the server at **295.84 s** (`retry: 1000` last,
  `sse_bounded_close` maxAgeMs 295862). The same through `app.openwop.dev/api`
  returned a complete `200 text/event-stream` at **46.96 s** (`retry: 1000` last,
  maxAgeMs 46952), and Cloud Run logged exactly **one** upstream for it, from a
  Google front-end IP: no Firebase retry. Before this ADR the same `/api` probe
  opened a new upstream about every 60 s and ended in `503` at 185.6 s. A stream
  without `resumable=true` being held open is pinned by
  `test/adr0897-bounded-run-stream.test.ts` (not re-probed on prod, because a
  held probe would itself hold a slot for an hour).
- [x] RFC 0247 flipped `Active → Accepted` (provisional, pending its §B review) on
  this evidence and cut 105c (bundle `49ba4f222dc8`, 446/0, no result changes):
  openwop #2006, merged `762eb439` 2026-10-16 06:36Z.
- [ ] When the app moves to an SDK version that resumes by itself, drop the
  wrapper loop in `streamsClient.ts` or pass the SDK's opt-out, so the two
  reconnect loops do not stack.
