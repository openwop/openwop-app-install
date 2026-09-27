# ADR 0253 — Image-seam connection-use provenance stamp (+ brokeredPost non-fit)

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| **Status** | implemented (2026-07-04) — the ADR 0244 §"Open items" provenance-stamp follow-on |
| **Deciders** | openwop-app maintainers |
| **Relates** | ADR 0244 (broker-resolved image api_key — the enabling change), RFC 0079 / ADR on `stampConnectionUse` (connection-use provenance), ADR 0187 (tenant egress firewall), ADR 0115 (image seam) |

## Context

ADR 0244 made the image seam broker-resolve its api_key (a workspace Connection
wins over the env key) but **deferred** two items:

> - "RFC 0079 connection-use provenance stamp on a broker-resolved image call
>   (`stampConnectionUse` needs `storage`, not readily threaded into the image
>   seam) — the ads-adapter pattern; a follow-on."
> - "`brokeredPost` egress unification for the image dispatch."

Today an image call served by a broker Connection is invisible in the run's
`connectionUse` provenance (unlike ads/email/sms/notification), so an audit of
"which Connections did this run touch?" misses image generation.

## Decision

**Do the provenance stamp. Reject the brokeredPost egress unification** (a genuine
architectural non-fit, documented below).

### Provenance stamp (done)

- `resolveImageKey` now returns `{ secret, provenance? }` — carrying the
  `resolveConnectionCredential` provenance when a broker Connection (not the env
  key) supplied the secret.
- `dispatchImageGeneration` takes the `runId` (threaded from `callImageGenerator`'s
  `scope.runId`) and, **after a successful call** (`res.ok`), stamps via
  `stampConnectionUse(hostExtStorage(), runId, provenance)` — the ads/sms/smtp
  discipline (a provider-rejected call never reaches the stamp, so a failed send
  isn't recorded as a use). Best-effort (`.catch(log)`) + dedup-by-connectionId.
- **Storage without AdapterScope surgery.** ADR 0244's deferral blocker was "the
  image seam isn't handed `deps.storage`." Rather than thread `storage` through
  `AdapterScope` (a cross-cutting change to every adapter call site), we use the
  existing **public `hostExtStorage()` accessor** — built for exactly this ("host-
  side services that need `Storage` but aren't handed it through a route's deps").
- **Env-key path stamps nothing** — env keys aren't Connections; there is no
  provenance to record.

### brokeredPost egress unification — REJECTED (non-fit)

`brokeredPost` is the wrong tool for the image dispatch, for two structural reasons:

1. **Broker-only, no env fallback.** `brokeredPost` resolves a Connection or
   returns `no_connection`; it has no env-key path. ADR 0244 deliberately keeps the
   env key as the fallback credential source. Routing image egress through
   `brokeredPost` would either drop that fallback (breaking env-configured
   operators) or force an awkward brokeredPost-then-env-fetch two-path split for no
   real gain.
2. **Tenant firewall vs host endpoint.** `brokeredPost` enforces the per-tenant
   egress firewall (ADR 0187) on the destination. The image endpoint is
   **host/operator-configured** (`OPENWOP_IMAGE_PROVIDER_ENDPOINT_*`), not tenant-
   or agent-supplied — applying a per-tenant allow-list to host infrastructure is a
   semantic mismatch and would break image generation for any tenant that hasn't
   allow-listed the operator's endpoint.

The image seam already has a **purpose-built egress guard** appropriate to a host-
configured endpoint: the `webhookEgressGuard` SSRF baseline (deny private/loopback
unless explicitly allowed) + the connect-time-validating `webhookEgressDispatcher`
(closes the DNS-rebind TOCTOU) + `redirect: 'error'` + `§D` endpoint non-disclosure.
The RFC 0079 provenance parity — the actual value of the deferred pair — is
delivered by the stamp alone, independent of the egress mechanism.

## Alternatives weighed

- **Thread `storage` through `AdapterScope`.** Rejected — a cross-cutting change to
  every adapter call site for one stamp, when `hostExtStorage()` already exposes the
  bound storage for precisely this "no deps.storage handed in" case.
- **Force the image seam Connection-only (drop env) to fit brokeredPost.** Rejected
  — overturns ADR 0244's deliberate dual credential source.
- **Stamp on dispatch regardless of success.** Rejected — a provider-rejected call
  must not record a use (the ads/sms/smtp rule); stamp only after `res.ok`.

## Boundaries / wire

- **No wire change, no RFC.** `run.metadata.connectionUse` is the established
  host-side provenance record (RFC 0079); adding image to it is additive and
  matches ads/email/sms/notification.
- **Replay/fork.** The stamp lands in `run.metadata`, which survives `:fork`;
  dedup-by-connectionId makes a replay/re-dispatch idempotent.
- **Security.** The stamp records connectionId/provider/scope (non-secret); no
  credential material touches the run.

## Implementation

| Change | File |
| --- | --- |
| `resolveImageKey` returns `{secret, provenance?}`; `dispatchImageGeneration` takes `runId` + stamps on success via `hostExtStorage()` | `backend/typescript/src/host/imageProviderAdapter.ts` |
| Thread `runId: scope.runId` into the dispatch | `backend/typescript/src/aiProviders/aiProvidersHost.ts` |
| Test — broker call stamps `connectionUse`, dedup on re-dispatch, env-key path stamps nothing | `backend/typescript/test/image-broker-credentials.test.ts` |

## Open items (deferred)

- None material. `brokeredPost` unification is **not deferred — declined** (see
  above); if the image endpoint ever becomes a tenant/connection-supplied URL
  rather than host-configured env, revisit.
