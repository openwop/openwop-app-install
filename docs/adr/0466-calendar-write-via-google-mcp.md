# ADR 0466 — KickTodo calendar-write via Google's remote Calendar MCP server (KT-PORT-6a-3)

Status: implemented — 2026-07-21 — P1 `providerRegistry.ts` google `mcpServer.url` = the live Calendar MCP endpoint; P2 `calendarMcpAdapter.ts` (MCP `CalendarTransport` + `kicktodo-calendar-mcp-eventmap` store + own ADR 0381 eraser) + `mcpClient.ts` additively surfaces `structuredContent` (create_event's returned id); P3 `feature.ts` MCP-wins boot selection behind `OPENWOP_CALENDAR_MCP_ENABLED`. Tests: `kicktodo-calendar-mcp.test.ts` (5/5 — create→store, update-on-hit, delete+no-op, create-no-id fail-closed, erasure, through the real mcpClient pipeline) + `outbound-mcp.test.ts` updated (google now carries the endpoint; slack stays the `server_not_found` witness). Ships **gated-off** (`OPENWOP_CALENDAR_MCP_ENABLED` unset); REST adapter stays the generic/self-hosted fallback.

## Context

KickTodo's calendar-write lane (ADR 0421 P2, KT-PORT-6a) syncs a participant's live
challenge occurrences to their calendar as all-day events, replay-safely: every event
carries a deterministic external id `(enrollmentId|dateLocal|stableActivityId)` so a
re-fired sync UPSERTs (never duplicates) and a plan-revision supersession DELETEs the
stale event. The transport is a registered port — the `CalendarTransport` seam
(`calendarWriteService.ts:37`). Production registers a connection-backed transport;
absent one, the lane fails closed as `host_capability_missing`.

The shipped transport (`calendarProviderAdapter.ts`, KT-PORT-6a) is a **bespoke
direct-REST adapter**: it resolves the owner's `google` Connection credential
(ADR 0024), then `PUT`/`DELETE`s Google Calendar API v3 `/events/{id}` over the
SSRF-guarding egress dispatcher, with a **client-supplied** event id
(`kt<sha1(externalId)>`) giving stateless idempotency.

KT-PORT-6a-2/6a-3 always flagged this as the honest **interim**: the built-in `google`
provider is `reach:'mcp'` (`providerRegistry.ts:86`), so the architecturally-correct
path is the registered MCP server (credential injected, governance-gated, provenance-
stamped, no bespoke egress), not a hand-rolled REST client. KT-PORT-6a-3 was
**BLOCKED** on an external premise: "Google ships no official first-party remote
Calendar MCP server."

**That premise is now falsified.** As of 2026-06-05 (post-dating the prior scoping),
Google hosts a first-party remote Calendar MCP server, verified live 2026-07-21:

- **`https://calendarmcp.googleapis.com/mcp/v1`** — HTTP 200 from a Google IP,
  MCP `initialize` → protocol `2025-06-18`, `serverInfo {name:"StatelessServer",
  version:"ESF"}` (Google API Serving Framework).
- Tools (live `tools/list`): `list_events`, `get_event`, `list_calendars`,
  `suggest_time`, `search_events`, and the **write** tools `create_event`,
  `update_event`, `delete_event`, `respond_to_event`.
- Auth: OAuth 2.0 Bearer — the same Google access token the REST adapter Bearers;
  the `google` provider already models the `calendar.events` write scope
  (`providerRegistry.ts:95`).

## Decision

Route calendar-write through Google's remote Calendar MCP server via the existing
host outbound MCP client (`host/mcpClient.ts` `makeMcpClient(...).invokeTool`), as a
**second implementation of the same `CalendarTransport` seam** — selected by an
honesty gate. The REST adapter stays as the generic/self-hosted fallback.

### 1. Provider wiring — extend `google` (NOT a new provider)

Add `mcpServer: { url: 'https://calendarmcp.googleapis.com/mcp/v1', transport: 'http' }`
to the built-in `google` provider (`providerRegistry.ts:82`).

**Why extend, not fork (single-source-of-truth):** `google` already owns the
"Google Calendar connection" concept — it declares `calendar.readonly` +
`calendar.events` write scopes. A dedicated `google-calendar` provider would be a
**second owner** of that concept (the boundaries anti-pattern) and would need a
separate host OAuth-client registration (`oauthFlow.ts:86` binds per provider) plus a
re-consent. Extending `google` reuses its OAuth client and its already-ticked scope,
and collides with nothing — no code invokes `google` as an MCP server today (it threw
`server_not_found`).

**Evolution note (correction guard):** the single `mcpServer.url` field cannot hold
multiple product servers. When a *second* Google MCP product (Gmail/Drive) is wired,
evolve the field to `mcpServers: Record<capability, {url; transport}>` — do **not**
fork the provider then either.

### 2. The MCP transport — `calendarMcpAdapter.ts`

A new `CalendarTransport` implemented over `makeMcpClient` (runless — no `runId`, so
no run-provenance stamp; matches the `ucpBuyerService.ts:206` precedent). The MCP
`call()` pipeline already does everything the REST adapter did by hand: URL from
`getProvider('google').mcpServer.url`, governance `isProviderAllowed` fail-closed,
per-user credential `resolveConnectionCredential({provider:'google', actingUserId:
ownerSubject})` → Bearer, SSRF-guarded egress.

**Stateful id map (unavoidable):** live schema shows `create_event` takes **no client
id** (required `summary`/`startTime`/`endTime`; returns Google's server-assigned
`id`); `update_event`/`delete_event` are keyed by that `eventId`. So the REST
stateless-upsert-by-our-id cannot be reproduced. The transport keeps a durable map:

- Store `kicktodo-calendar-mcp-eventmap`, key `${tenantId}::${ownerSubject}::${externalId}`,
  value `{ tenantId, ownerSubject, externalId, googleEventId }`, `tenantOf = tenantId`.
- `upsert`: map-hit → `update_event({eventId, summary, startTime, endTime, allDay:true})`;
  map-miss → `create_event({summary, startTime, endTime, allDay:true})`, then store the
  returned `id` **immediately** (minimize the create→store window).
- `remove`: map-hit → `delete_event({eventId})` then delete the row; map-miss → no-op
  (idempotent). A `delete_event` on an already-absent event is tolerated.
- All-day mapping: `{dateLocal, title}` → `{summary:title, startTime:dateLocal,
  endTime:dateLocal, allDay:true}`.

### 3. Erasure — the map is subject data (on the ADR 0381 seam)

Unlike the REST `written` ledger (deliberately off-seam — deterministic ids, no
subject key), this map is subject-keyed and references the user's real Google events.
It registers its **own** subject eraser at module load (multi-registrant seam, no
import cycle): erase = delete all rows under the `${tenantId}::${ownerSubject}::`
prefix. It is covered by tenant teardown via `tenantOf`. (Erasure deletes OUR mapping
rows only; the Google events live in the user's own calendar under their control.)

### 4. Transport selection (single global) + honesty gate

New gate `OPENWOP_CALENDAR_MCP_ENABLED`. Boot precedence (explicit — both gates may be
set): MCP-enabled (+ `google.mcpServer` resolvable) → register the MCP transport;
elif `OPENWOP_CALENDAR_PROVIDER_ENABLED` → the REST adapter; else register nothing
(`isCalendarTransportConfigured()` stays honestly false → port "awaiting adapter").
Ships **gated-off**: a live write needs real Google OAuth creds this environment can't
provide, so it's mock-tested and an operator opts in only after confirming against
their tenant.

## Known residual (honest)

**Idempotency downgrade vs REST.** `create_event` is not idempotent by a client id, so
(a) concurrent double-sync for the same `(subject, externalId)` can double-create and
orphan a Google event (the second map-write overwrites the first id, losing it), and
(b) create_event exposes no `extendedProperties`, so there is no recovery marker on the
event itself — the durable map is the only link. This is inherent to the MCP tool.
Mitigations in scope: write the map row immediately after create; user-initiated sync
is effectively serial per enrollment; the lane ships gated-off. **Hardening follow-on
(only if the lane goes live):** a CAS "creating" placeholder row to serialize
first-create across instances, and/or a `list_events` reconcile to adopt orphans.

## Alternatives weighed

- **Keep REST only (do nothing).** Rejected: MCP is the sanctioned path (governance +
  provenance + credential injection + no bespoke SSRF/egress surface), and the external
  blocker is gone. REST stays as the generic/self-hosted fallback, not the Google path.
- **New `google-calendar` provider (Option A).** Rejected: second owner of the
  Google-calendar connection concept + a separate OAuth client + re-consent. See §1.
- **Stateless MCP (no map).** Impossible: `create_event` has no client id.

## RFC verdict

**Host-extension, NO new RFC.** Composes already-Accepted ADR 0024 (Connections) +
ADR 0030 (outbound MCP client) + RFC 0095 (connection packs). It is an outbound client
call to an external server (Google) — ADR 0030's existing lane — and adds nothing to
the OpenWOP wire (no run-event, capability advert, endpoint contract, or normative
MUST).

## Implementation plan

| Phase | Change | Test |
|---|---|---|
| P1 | `providerRegistry.ts`: add `mcpServer` to `google` | provider-registry assertion |
| P2 | `calendarMcpAdapter.ts`: MCP transport + eventmap store + own subject eraser | `kicktodo-calendar-mcp.test.ts` — create→store→update idempotency, delete, map-miss no-op, erasure |
| P3 | boot selection in `registerCalendarProviderAdapter` (MCP-wins precedence) + `OPENWOP_CALENDAR_MCP_ENABLED` | gate/selection test |

## Open questions

- **OQ1** — is a `list_events` reconcile (adopt/repair orphans) worth building before
  the lane goes live, or is the CAS placeholder sufficient? Deferred to the live-enable
  decision.
- **OQ2** — confirm the exact `allDay` start/end shape Google's `create_event` expects
  (date vs datetime) against a live authorized call; the gated-off lane pins the
  documented `allDay:true` contract until then.
