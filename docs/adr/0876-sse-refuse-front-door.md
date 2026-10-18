# ADR 0876 — refuse host-extension streams that arrive through the front door

Status: implemented

## Context

ADR 0761 recorded that the Firebase Hosting `/api` rewrite **buffers** server-sent
events, and advertised a direct stream origin (`streamBase`) so clients could skip
it. Buffering turned out to be the smaller half of the problem.

MEASURED 2026-10-12 on revision `00940-4nb`, with a throwaway board in an
anonymous tenant (since deleted):

| path | upstream requests seen by Cloud Run | client saw |
| --- | --- | --- |
| direct to `*.run.app` | 1, closed by the server at 120.0 s | `200 text/event-stream`, heartbeat every 15 s |
| through `app.openwop.dev/api` | **12 in 3 min**, from Google front-end IPs (66.102.\*, 74.125.\*, 64.233.\*, 192.178.\*), each held 120 s | nothing, then `503 text/html` at 188 s |

Hosting retries the upstream while it waits, and the retries overlap. Each one
holds one of the tenant's SSE cap slots (`host/sseChannel.ts`, default 20) for
its whole life. So a single misrouted client can take a tenant past its cap in
about two minutes, and the tenant's real streams then fail with `429`.

Nothing in the shipped SPA does this: every stream reader uses
`config.sseBaseUrl` (audited 2026-10-12: kanban, notifications, channels, voice,
present, runs, example-data, roster seed). The exposure is configuration:
`sseBaseUrl` falls back to `VITE_OPENWOP_BASE_URL` when
`VITE_OPENWOP_SSE_BASE_URL` is unset (`frontend/react/src/client/config.ts`). A
CLI user who overrides the advertised stream origin hits the same path.

## Decision

1. `openSseChannel` takes a `frontDoor` option, default **`'refuse'`**. A refused
   stream gets a fast `421 Misdirected Request`
   (`{ error: 'invalid_request', details: { reason: 'stream_via_front_door',
   streamBase } }`). It is thrown before any header is written or cap slot
   taken, and logged once per request as `sse_front_door_refused`.
2. A request counts as "through the front door" (`frontDoorHop`) only when
   **all** of these hold, so no other deployment changes behaviour:
   - `OPENWOP_STREAM_BASE_URL` is configured: the operator has already declared
     that their front door cannot carry streams (ADR 0761);
   - `X-Forwarded-Host` is present. MEASURED: through `/api` the 401 challenge
     origin is `app.openwop.dev`; direct, it is the run.app host;
   - the forwarded host is neither the request's own `Host` (a pass-through
     proxy such as nginx `proxy_set_header Host $host`) nor the stream origin.
3. The OpenWOP **wire** channels pass `frontDoor: 'allow'`: `GET /runs/:id/events`
   (`routes/streams.ts`) and `GET /host/events` (`routes/hostEventStream.ts`).
   `runs.md` requires `eventsUrl` to resolve on the request's origin, and
   certification reads them through the public base URL. Defaulting to
   `'refuse'` means a new host-extension stream is protected without anyone
   remembering to opt in.

Host-extension routes only; no wire change and **no RFC**.

## Alternatives weighed

| option | why not |
| --- | --- |
| detect `X-Fh-Requested-Host` | appears only in Hosting's response `Vary`; whether it reaches the origin is unmeasured. A marker that silently never matches is a no-op guard |
| refuse on any `X-Forwarded-Host` | false positive for adopters behind nginx, where SSE streams fine with `X-Accel-Buffering: no` |
| a new env listing refused hosts | one more knob; `OPENWOP_STREAM_BASE_URL` already expresses the operator's intent |
| fail the frontend build when the SSE base is unset | a relative base is also how a same-origin nginx deploy is configured; it cannot tell the cases apart |
| guard the wire run stream too | breaks certification and `runs.md` same-origin clients |

## Consequences

- A misconfigured deploy now shows a named `421` in the network panel instead of a
  stream that silently never delivers. Every stream reader already backs off on a
  non-OK response (kanban 5 s → 60 s; notifications, channels and voice
  exponential), and native `EventSource` stops on a non-200.
- Wire run streams through `/api` can still fan out when a run outlives Hosting's
  wait. Out of scope here; clients read `streamBase` (ADR 0761).

## Implementation record

| change | witness |
| --- | --- |
| `frontDoorHop` + refusal in `openSseChannel`; `'allow'` on the two wire channels | `test/sse-channel.test.ts` "ADR 0876" block: 421 before headers and without a cap slot; served when direct, pass-through, stream origin, unconfigured, or `'allow'`. Sabotage: default flipped to `'allow'` → the 421 test red |
| production | MET 2026-10-12 on `f838299ce` (rev `00942-dvj`): a stream through `/api` returned `421` in 0.13 s and appeared as ONE upstream request in the Cloud Run log (no front-door retries); the same stream read direct returned `200` and closed at 120.0 s. Re-checked on `9627e75ec` (`00943-n94`): `notifications/stream` via `/api` → `421` |
