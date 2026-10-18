# ADR 0761 — advertise a stream origin for clients the front door buffers

Status: implemented

## Context

MEASURED 2026-09-27: a server-sent events (SSE) stream read through the public front door
`https://app.openwop.dev/api` (the Firebase Hosting rewrite to Cloud Run)
delivered **zero bytes in 25 s** — not even response headers — for
`/v1/host/openwop-app/notifications/stream`. The same request against the Cloud
Run origin answered headers in 291 ms and a keep-alive at 15 s. Hosting buffers
rewritten responses; that is not configurable.

The SPA already knows (`VITE_OPENWOP_SSE_BASE_URL`, `frontend/react/.env.production`
— "the CDN buffers SSE", CDN being the content delivery network in front of `/api`). No other client can: `@openwop/cli`'s `runs watch`,
`chat`, `notifications stream` and `kanban watch` all showed nothing live through
the public base URL.

The protocol cannot fix this: `spec/v2/core/runs.md` requires `eventsUrl` /
`statusUrl` to resolve on the origin the request was made to.

> **CORRECTED 2026-10-12 (ADR 0876) — "buffers" understates it.** MEASURED on
> `00940-4nb`: one stream through `/api` became **12 upstream streams in 3 min**
> (Hosting retries the upstream; each retry held a per-tenant SSE cap slot for
> 120 s) and the client got `503 text/html` at 188 s. Read direct, the same
> stream was one request. Advertising `streamBase` stays correct; ADR 0876 adds
> the server-side half and refuses host-extension streams that still arrive
> through the front door.

## Decision

1. **Env** `OPENWOP_STREAM_BASE_URL` (optional). Validated by
   `host/streamBase.ts`: `https:` only, no credentials, query or fragment. Unset
   → nothing advertised. Invalid → dropped with one warning (`stream_base_ignored`)
   rather than failing the boot: a missing hint costs latency, a bad one would
   hand clients an origin to send their bearer to.
2. **Advertisement** `extensions["openwop-app.host"].streamBase` in the v2
   discovery document — the host's own registered extension record
   (`versioning.md` §5 permits host-proprietary values under
   `extensions.<org>.<name>`). Non-normative; **no RFC**.
3. **Clients** (the CLI, openwop-cli#58) read streams from it, and nothing else:
   every non-stream request stays on the base URL. The CLI accepts an advertised
   value only under the same rules as (1), and a user setting always wins.

It is the same service with the same auth, rate limits and tenancy — only the
CDN hop is skipped, exactly as the SPA already does. Anonymous cookie sessions
do not cross origins; that affects no protocol client (the SPA does not read
this field, and the CLI sends no cookies).

## Alternatives weighed

| option | why not |
| --- | --- |
| make the CDN stream | Firebase Hosting buffers Cloud Run rewrites; not configurable |
| an RFC for a stream-origin capability | contradicts `runs.md`'s same-origin rule; a deployment quirk, not a protocol need |
| CLI flag/config only | every user must discover the run.app URL; `runs watch` stays broken by default — kept as the override |
| derive the URL from `K_SERVICE` | Cloud Run does not expose the service URL to the instance; an env binding is explicit |

## Ops

Set once, merge-style (never `--set-*`):

```
gcloud run services update openwop-app-backend \
  --update-env-vars OPENWOP_STREAM_BASE_URL=https://openwop-app-backend-89896419173.us-central1.run.app \
  --region us-central1 --project openwop-dev
```

## Implementation record

| change | witness |
| --- | --- |
| `host/streamBase.ts` validation | `test/adr0761-stream-base.test.ts` — accepts https (+prefix), refuses http / credentials / query / fragment / garbage |
| discovery advertisement | same file, over HTTP: absent when unset, normalised when valid, absent on a downgrade |
| client resolution + live resume | openwop-cli `test/stream-base.test.mjs`; `scripts/live-sse-resume.mjs` PASS drop + stall against production |
