# ADR 0037 — Connector framework + remaining provider reach

**Status:** Accepted
**Date:** 2026-06-13
**Depends on:** ADR 0024 (Connections broker + provider manifests + brokered
egress), ADR 0028 (connector/provider governance — `isProviderAllowed`), ADR 0033
(day-1 connector-reachability + the honesty matrix), ADR 0030 (outbound MCP
client). Reuses RFC 0093 (egress dispatcher / SSRF guard), RFC 0079 (provenance),
RFC 0095 (connection packs).
**Surface:** Connections / host runtime + `/.well-known/openwop` advertisement +
the `host.connectors` peer-dependency capability.
**NON-NORMATIVE (host runtime).** No new wire shape is introduced; the connector
invoker is an internal host slot that composes already-shipped seams. (Per
CLAUDE.md, a wire change would need an RFC in `openwop` — none is required here.)

## Why this exists

ADR 0033 defined "activated day 1" honestly: the ten work-twins run at
draft/recommend over WIRED surfaces, and every external write is deploy-gated
behind a configured Connection. Its matrix left two threads dangling:

1. **`connectorInvoker` was a throw-on-use stub** (`host/index.ts` —
   `throwOnUse<ConnectorInvoker>('host.connectors')`). A pack declaring
   `peerDependencies: ["host.connectors"]` therefore could not resolve — it would
   surface `host_capability_missing`. The capability was *advertised as absent*,
   which is honest but limiting: nothing could ride a generic connector surface.
2. **ServiceNow had no `apiHosts`** (ADR 0033 §Correction flagged this). With no
   curated hostnames, brokered egress to ServiceNow is not allow-listed, so even a
   configured Connection could not reach it through the http seam or a connector.

This ADR closes both with a **bounded** first cut, keeping ADR 0033's honesty
principle: advertise only what is wired; deploy-gate per-provider reach behind a
configured Connection; fail closed otherwise.

## Decision

**Implement `connectorInvoker` as a thin delegation to the EXISTING Connections
broker + brokered egress — not a new egress path.**

A "connector" in this first cut **is** a registered Connections provider id
(e.g. `servicenow`). `connectorInvoker.invoke(connectorId, args)`:

1. resolves `connectorId` → a `ProviderManifest` (`getProvider`); an unknown id
   throws `not_found` (404);
2. validates `args` (`{ context:{tenantId,runId,actingUserId?,orgId?},
   request:{url,method?,body?,…} }`); malformed args throw `invalid_request`
   (400). The run context rides in `args` because the host factory is built once
   per process, not per run;
3. calls the new `brokeredFetch` (a generic-method sibling of the existing
   `brokeredPost`), which resolves the acting human's Connection through
   `resolveConnectionCredential`, injects the token host-side, and performs the
   call over the **RFC 0093 SSRF dispatcher** with `redirect:'error'` and a bounded
   timeout;
4. **pins the destination to the provider's curated `apiHosts`** (eTLD+1 boundary,
   never substring — the same `hostMatchesApi` predicate the http injection seam
   uses). A connector can therefore never be turned into a generic egress bypass:
   the resolved token only ever reaches the provider's own hosts. A provider with
   no `apiHosts` is **not** connector-reachable (fail closed);
5. **fails closed** — no configured Connection → `{ ok:false,
   error:'connector_no_connection' }`; off-host URL → `connector_host_not_allowed`;
   never a silent no-op, never a 500;
6. **stamps RFC 0079 provenance** on `run.metadata.connectionUse[]` on a transport
   success (reaching the provider is a use of the credential, even if the provider
   returns an HTTP error).

Governance (ADR 0028 `isProviderAllowed`) and the `connections:use` org-grant gate
are inherited for free, because they live inside `resolveConnectionCredential` —
the one choke point every broker consumer flows through. No second evaluator.

**Capability honesty.** Because the slot is now genuinely wired:
- `host.connectors` is advertised `supported:true` in discovery
  (`hostSurfaceRegistry`), with a note that per-provider reach remains
  deploy-gated;
- `host.connectors` is added to the agent-pack peer-dependency satisfied set
  (`agentPackResolver.HOST_SATISFIED_CAPS`), so a pack declaring
  `peerDependencies:["host.connectors"]` resolves instead of
  `host_capability_missing`.

**ServiceNow `apiHosts`.** The `servicenow` manifest gains
`apiHosts: ['service-now.com']` — each customer instance is a subdomain
(`acme.service-now.com`), so the eTLD+1 pin matches any instance without naming a
tenant. This is what makes ServiceNow's DEPLOY-GATED row in ADR 0033's matrix
actually reachable (the row was correct in intent but unenforceable without it).

## What is WIRED vs still DEPLOY-GATED (honesty matrix upkeep)

| Thing | Status after this ADR |
|---|---|
| `connectorInvoker` host slot | **WIRED** — broker-delegating, fail-closed |
| `host.connectors` capability advertisement + peerDep resolution | **WIRED** (`supported:true`) |
| ServiceNow brokered egress allow-list (`apiHosts`) | **WIRED** (pin present) |
| Any specific provider actually *reaching* its system | **DEPLOY-GATED** — needs a configured Connection (else `connector_no_connection`) |
| Providers still lacking a manifest/`apiHosts` (M365/Jira/Notion/Salesforce/Workday/…) | **DEPLOY-GATED via connection packs** (RFC 0095) — no host code, no ADR each (ADR 0033 §Decision rule still holds) |

The day-1 honesty principle is unchanged: advertising `host.connectors:supported`
is honest precisely because the slot executes and fails closed; advertising a
*provider* as reachable still requires its Connection to be configured.

## Deferred (scoped down deliberately — recorded per CLAUDE.md ADR discipline)

A richer "connector framework" would add **named connector descriptors** (a
catalog of operations with request/response schemas, default endpoints, pagination,
retry/backoff, and a typed result envelope) on top of the raw provider id +
caller-supplied URL. That is **deferred**: the bounded cut here is honest and
useful (a pack can resolve `host.connectors` and make audited, host-pinned,
fail-closed calls), and a descriptor catalog is additive — it can layer on the same
`brokeredFetch` spine later without changing this contract. Deferring it avoids
shipping a half-built descriptor schema we'd have to migrate. When a concrete twin
action needs a named operation (ADR 0033 §Open-questions item 4), add the
descriptor layer in a follow-on; nothing here blocks it.

Also still deferred (each needs an upstream RFC, per ADR 0033 §Deferrals and
ROADMAP 0034/0035): external-event trigger ingestion and async/durable A2A — out
of scope here.

## Alternatives weighed

1. **Build a full connector-descriptor catalog now** — rejected: large scope, a new
   schema to design + migrate, and not required for honest `host.connectors`
   resolution. Deferred (above).
2. **Add a new, connector-specific egress path** — rejected: it would duplicate the
   RFC 0093 SSRF guard + the `apiHosts` pin + the `connections:use` gate + the RFC
   0079 provenance stamp, inviting drift. The whole security value of the broker is
   that there is ONE egress spine; the connector composes it (the same reuse
   decision ADR 0024 made for the Slack/SendGrid/Twilio adapters).
3. **Leave `connectorInvoker` a stub and route everything through connection
   packs + http/MCP nodes** (ADR 0033's day-1 stance) — fine for day-1, but it
   leaves `host.connectors` permanently unadvertisable and any pack that declares
   the peer dependency dead-on-arrival. This ADR is the post-day-1 follow-up that
   ADR 0033 explicitly anticipated (ROADMAP row 0037).
4. **Let a connector reach any URL the caller supplies** — rejected outright: that
   turns a credentialed connector into an SSRF/egress bypass. The `apiHosts` pin is
   non-negotiable.

## Implementation

| Phase | Work | Tests |
|---|---|---|
| 37.1 | `brokeredFetch` (generic-method egress + `apiHosts` pin + SSRF) in `host/brokeredEgress.ts` | `connector-invoker.test.ts` (host-pin + off-host fail-closed) |
| 37.2 | `createConnectorInvoker` (`host/connectorInvoker.ts`) delegating to the broker; wire into `host/index.ts` (replace throw-on-use stub) | resolves+calls through; fails closed on no Connection; unknown id 404; bad args 400; provider HTTP error → `ok:false` (no throw); provenance stamped |
| 37.3 | Advertise honestly: `host.connectors` in `hostSurfaceRegistry` (`supported:true`) + `agentPackResolver.HOST_SATISFIED_CAPS` | discovery surface assertion |
| 37.4 | ServiceNow `apiHosts: ['service-now.com']` in `providerRegistry.ts` | `getProvider('servicenow').apiHosts` present |

Files: `backend/typescript/src/host/connectorInvoker.ts` (new),
`host/brokeredEgress.ts`, `host/index.ts`, `bootstrap/hostSurfaceRegistry.ts`,
`bootstrap/agentPackResolver.ts`, `features/connections/providerRegistry.ts`,
`test/connector-invoker.test.ts` (new).

## Open questions / decisions checklist

- [ ] When does the descriptor layer (named operations + schemas) become worth
      building? — when a concrete twin action needs it (ADR 0033 §OQ4); add then.
- [ ] Should `connectorId` ever diverge from a provider id (a connector that fans
      out across several providers)? — not for the first cut; revisit with the
      descriptor layer.
- [x] Does the connector need a separate egress path? — **No.** It composes
      `brokeredFetch`, inheriting the one RFC 0093 spine.
- [x] How is a connector prevented from becoming an egress bypass? — the provider
      `apiHosts` pin (eTLD+1), enforced in `brokeredFetch` before the secret is even
      resolved.
