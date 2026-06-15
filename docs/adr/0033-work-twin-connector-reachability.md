# ADR 0033 — Work-twin connector reachability + day-1 capability-honesty matrix

**Status:** implemented
**Date:** 2026-06-13
**Depends on:** ADR 0024 (Connections broker + provider manifests + `reach`), ADR
0030 (outbound MCP client — **already Accepted+implemented**, incl.
`serverId`→provider resolution + per-user Connection auth), ADR 0028 (connector
governance), ADR 0031 (`agentProfile.requiredConnections`). Reuses RFC 0095
(connection packs), RFC 0093 (egress dispatcher), RFC 0083 (trigger bridge).
**Sibling:** ADR 0031, ADR 0032.
**Surface:** Connections / host runtime + `/.well-known/openwop` advertisement.
**NON-NORMATIVE for day-1 scope** (connection packs + activation gating are host
runtime). Deferred items (external-event triggers, async A2A) would each need an
upstream OpenWOP RFC — explicitly out of scope here.

## Why this exists

The ten twins (`new_agents.md`) name ~25 external systems (Google Workspace,
M365/Teams, Slack, Zoom, Jira, Asana, Notion, Salesforce, Workday, BambooHR,
NetSuite, QuickBooks, ServiceNow, DocuSign, CLM, IdP, CMDB, monitoring, product
analytics, NPS, …). The user wants the suite "activated on day 1." ARCHITECTURE.md
§"advertise only honored behavior" forbids seeding agents that claim action in
systems the host cannot reach. So "day 1" must be defined honestly against what
actually executes.

### Correction to the initiating premise (important)

The Phase-0 brief assumed the **outbound MCP `serverId`→provider wiring is
missing**. That is **stale**: ADR 0030 is **Accepted and implemented** — the host
already has `host/mcpClient.ts` exposing `ctx.mcp.{invokeTool, readResource,
listTools}`, with `serverId`→provider resolution, per-user Connection auth, the
0028 governance gate, Streamable-HTTP responses, and bounded `subscribe-resource`
polling. What remains for a `reach:'mcp'` provider to be usable is **a registered
provider with an MCP server + a configured Connection**, not new client plumbing.
This ADR is therefore framed as *verify/extend + pack + gate*, not *build the MCP
client*.

## Decision

**Define "activated day 1" as: all ten twins EXIST with seeded
prompts/workflows/schedules running at DRAFT/RECOMMEND autonomy over WIRED
surfaces only, with every external write integration deploy-gated behind a
configured Connection and failing closed until configured.**

1. **Wired day-1 surfaces** (twins fully function here): internal features —
   `crm`, `csm`, `kb`, kanban boards, notifications/approvals — plus **Google and
   Slack** via the already-implemented outbound MCP client (ADR 0030) once a
   Connection is configured.
2. **Providers are added as connection packs** (RFC 0095) — no ADR per provider,
   no code per provider. A pack declares the provider + `reach` (`mcp` |
   `openapi`); it carries **no credential material** (loader enforces this).
3. **`requiredConnections` → activation gating** (the contract ADR 0031's profile
   relies on): at agent activation / run creation, each `requiredConnections`
   entry resolves against `connectionsService`. Unconfigured providers leave the
   twin at draft/recommend and the dependent workflow advertised
   `supported:false` — it must **fail closed**, never 500 or silently no-op.
4. **Inter-agent handoffs use in-process `core.subWorkflow` / orchestrator
   dispatch** (already live, replay-safe, shared trace id) for day 1 — NOT the
   external A2A server (which is synchronous-only with no task persistence).

### Day-1 reachability matrix

Tagging: **LIVE** (built-in/wired now) · **DEPLOY-GATED** (needs a connection pack
+ a configured Connection; no host code) · **BUILD** (needs host work).

| System | Used by | reach | Day-1 status |
|---|---|---|---|
| Internal `crm` / `csm` / `kb` / kanban / notifications | Sales, CS, Comms, all | n/a | **LIVE** |
| Google Workspace (Gmail/Cal/Drive/Docs) | Exec, CoS, Recruiting, People, Sales, Comms | mcp | **LIVE** once Connection configured (ADR 0030) |
| Slack | most | mcp | **LIVE** once Connection configured |
| ServiceNow | IT, People, CS | openapi | **DEPLOY-GATED** (built-in provider; brokered egress) |
| Zoom / SendGrid / Twilio / Expo | Exec, Recruiting, Comms | openapi | **DEPLOY-GATED** (built-in providers) |
| M365 / Teams / SharePoint | Exec, CoS, Comms, IT | mcp/openapi | **DEPLOY-GATED** — new connection pack |
| Jira / Asana | CoS, IT | mcp/openapi | **DEPLOY-GATED** — new connection pack |
| Notion / Confluence | CoS, Comms | mcp/openapi | **DEPLOY-GATED** — new connection pack |
| Salesforce | Sales, CS | openapi | **DEPLOY-GATED** — new connection pack |
| Workday / BambooHR | People, Recruiting | openapi | **DEPLOY-GATED** — new connection pack |
| NetSuite / QuickBooks | Finance | openapi | **DEPLOY-GATED** — new connection pack |
| DocuSign / CLM | Contract & Procurement | openapi | **DEPLOY-GATED** — new connection pack |
| Okta/Entra IdP, CMDB, monitoring | IT | openapi | **DEPLOY-GATED** — new connection pack (or `connectorInvoker`) |
| product analytics, NPS/CSAT | CS | openapi | **DEPLOY-GATED** — new connection pack |

Nothing in the suite is **BUILD**-blocked for day-1 *draft/recommend* operation:
internal owners are live, google/slack ride the existing MCP client, and every
other provider is reachable the moment a deployer configures its Connection.
`connectorInvoker` (a throw-on-use stub) is **not** on the day-1 path — providers
go through connection packs + the http/MCP nodes, not a generic connector surface.

### Explicit deferrals (each needs an upstream OpenWOP RFC — OUT of day-1 scope)

- **External-event trigger ingestion** (webhook/email/form → run). Today only
  cron + kanban-card moves dispatch runs; `TriggerSubscription` models other
  sources but they are unwired. A new external-trigger wire shape belongs in an
  RFC against **RFC 0083**, not this ADR. Day-1 event behavior = cron + kanban.
- **Async / durable A2A tasks** (the A2A server is sync-only, no task
  persistence). Cross-host async handoffs need an RFC; day-1 uses in-process
  dispatch.

An ADR for this host cannot change those wire surfaces (CLAUDE.md "a spec change
needs an RFC in openwop, not just an ADR here").

## Alternatives weighed

1. **Claim full integration on day 1** — rejected: dishonest capability
   advertisement; violates ARCHITECTURE.md and `OPENWOP_REQUIRE_BEHAVIOR`.
2. **Build `connectorInvoker` now** — rejected: large scope; connection packs +
   existing http/MCP nodes already cover the providers without it.
3. **MCP-only or OpenAPI-only** — rejected: providers differ; `reach` per provider
   (already in the manifest) selects the right path.
4. **Wire external-event triggers now** — rejected: requires an upstream RFC; out
   of day-1 scope.

## Implementation plan

| Phase | Work | Gate |
|---|---|---|
| 3.1 | verify outbound-MCP path end-to-end for google/slack; add provider-pack glue as needed (NOT rebuild — ADR 0030 exists) | — |
| 3.2 | connection packs (RFC 0095) for the high-value providers above | — |
| 3.3 | `requiredConnections` → activation gating: resolve at activation, fail closed, advertise `supported:false`; FE connection-status surface | 3.1, ADR 0031 T1.1 |

## Implementation (landed 2026-06-13)

| Phase | PR | Key file |
|---|---|---|
| 3.1 — lock work-twin `reach:'mcp'` reachability for google/slack (verify outbound-MCP path) | [#223](https://github.com/openwop/openwop-app/pull/223) | `backend/typescript/src/features/connections/` (provider reachability tests) |
| 3.2 — RFC 0095 connection packs for work-twin providers | [#222](https://github.com/openwop/openwop-app/pull/222) | `backend/typescript/src/features/connections/providerRegistry.ts` |
| 3.3 — `requiredConnections` activation gating + connection-status surface | [#228](https://github.com/openwop/openwop-app/pull/228) | `backend/typescript/src/features/connections/`, `frontend/react/src/` |
| Correction — google/slack transport + servicenow `apiHosts` (see §Correction) | [#221](https://github.com/openwop/openwop-app/pull/221) | `docs/adr/0033-work-twin-connector-reachability.md` |

## Open questions / decisions checklist

- [ ] Per-provider `reach` choice (MCP vs OpenAPI) for M365/Jira/Notion/Salesforce
      — owned by each 3.2 pack, based on the provider's available MCP server.
- [ ] Does activation gating live in the run-creation path, the roster heartbeat
      pick, or both? (Recommend both: heartbeat skips gated workflows; run-create
      fails closed.)
- [ ] Which deferred items get an RFC first (triggers vs async A2A) — sequence in
      a follow-on once day-1 lands.
- [ ] Do any IT-twin actions justify `connectorInvoker` rather than per-provider
      packs? (Defer until a concrete need appears.)

## Correction (2026-06-13) — google/slack transport + servicenow apiHosts

During Phase-0 reconciliation, a parallel review (crosstalk worker, PR #217) plus a
direct check of `backend/typescript/src/features/connections/providerRegistry.ts`
corrected two claims in the day-1 matrix above. Recorded here rather than editing
the matrix in place (ADR discipline: correct, don't rewrite):

- **Google and Slack** are declared `reach:'mcp'` but their manifests carry **no
  `mcpServer.url`** (only `apiHosts`: `googleapis.com`, `slack.com`). The outbound
  MCP client (ADR 0030) resolves a server via `serverId`→provider→`mcpServer`;
  with no `mcpServer.url`, these providers are **not** reachable through the MCP
  client today — they reach via **brokered HTTP egress** (`connectionInjection`
  over `apiHosts`, RFC 0093). So those matrix rows should read "LIVE via brokered
  HTTP once a Connection is configured," not "via the existing MCP client." To make
  them MCP-reachable, a connection pack (T3.2) must add `mcpServer.url`.
- **ServiceNow** is `reach:'openapi'` but has **no `apiHosts`**, so brokered egress
  to it is not yet allow-listed; T3.2 must add `apiHosts` before it is
  deploy-gated-ready.

Therefore **T3.1** is "verify the outbound-MCP path end-to-end + confirm google/slack
currently use brokered HTTP," not "make google/slack invoke via MCP." The day-1
honesty principle is unchanged — only the per-provider transport is corrected.
