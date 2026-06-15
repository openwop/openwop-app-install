# ADR 0024 — Connections: a generic per-user / per-org credential broker

**Status:** Accepted — Phase A (Connection store + provider registry + api_key/bearer create + most-specific user→org→workspace resolver) **implemented + tested** (`3aa3567`, `connections-feature.test.ts`); Phase B (OAuth2 PKCE consent round-trip + on-demand + warm-daemon token refresh + `/test` health probe + provenance shape on the resolver) **implemented + tested**; Phase C (write-scope re-consent + org-shared RBAC + inbound provider webhooks) **implemented + tested** (`connections-feature.test.ts` Phase-C cases); Phase D (node-exec credential injection via `ctx.http.safeFetch` — authz→resolve→audience-bind→inject ordering, `run.metadata.connectionUse[]` stamp, SR-1 run-secret registration; MCP leg deferred to the outbound MCP client) **implemented + tested** (`connections-injection.test.ts`, ADR 0023 §12 T1).
**Date:** 2026-06-10 (Phase A/B implemented 2026-06-11; Phase C implemented 2026-06-11)
**Depends on:** ADR 0002/0003 (identity), ADR 0006 (RBAC), ADR 0015 (workspace = tenant). Reuses the BYOK KMS envelope (`byok/secretResolver.ts`, ADR 0002 C3). Rides **RFC 0050** (auth profiles), **RFC 0076** (host `safeFetch` egress), **RFC 0079** (credential provenance) — all Accepted. Mirrors the catalog/compose discipline of ADR 0022 (Marketplace).
**Consumed by:** ADR 0023 (Executive Assistant), ADR 0025 (user/agent orchestration), and any future feature needing a third-party token.
**Surface:** `/v1/host/openwop-app/connections/*` + `/v1/host/openwop-app/providers/*` — host-extension, **NON-NORMATIVE — no RFC**.
**Toggle:** ~~`connections` · category `Access & data` · default OFF · `bucketUnit: 'tenant'`~~ — **removed 2026-06-11**, see § Correction below.

> **§ Correction (2026-06-11) — graduated off the toggle to a permanent admin
> surface.** Connections shipped behind the `connections` feature toggle (default
> OFF, per-tenant). It is now **always-on** and lives in **Admin → Access & data**
> (alongside Organizations · Keys · Demo data), mirroring the Notifications
> graduation (ADR 0010 § Correction). Rationale: a credential broker is platform
> plumbing, not an optional *product* surface to A/B — every host needs somewhere
> to store the tokens its MCP/HTTP/integration nodes pull. It carried no variants,
> so nothing about traffic-splitting is lost. Concretely: `feature.ts` drops its
> `toggleDefault`; `routes.ts` drops the `requireEnabled` 404 guard (all ten
> routes serve unconditionally); the frontend nav moves from `tier: 'workspace'`
> (gated `featureId: 'connections'`) to `tier: 'admin'` with no `featureId`, so it
> renders in the AdminLayout rail; `ConnectionsPage` drops its `useFeatureAccess`
> gate. RBAC on **org-shared** connections (`host:connections:manage` /
> `host:connections:use`, Phase C / D2) is unchanged — that is the real access
> control; the toggle was only an on/off curtain. The original toggle rationale
> below is preserved for the reasoning trail.

> **Scope reframe (×2).** This ADR began as a "Google connector subsystem," then
> shrank (the host already has the I/O nodes — see below), and now **generalizes**:
> the right primitive is **not Google-specific**. Under a user *and* under an org,
> a principal must be able to add and manage auth for **any** app — Google, Slack,
> ServiceNow, Zoom, … — each feeding the **existing** `core.openwop.{mcp,http,
> integration}` nodes. So this ADR owns one concept: **a Connection** (a stored,
> provider-scoped credential) plus a **provider registry** that makes adding the
> next integration a *manifest*, not a code change.

---

## Context — what already exists (compose, do not rebuild)

| Need | Already provided by |
|---|---|
| Call any external API | `core.openwop.http.{fetch, openapi-call}`, `core.openwop.mcp.{invoke-tool, read-resource, subscribe-resource}` (against a registered MCP server), `core.openwop.integration.{email-send, slack-message, sms-send, notification-push}` |
| SSRF-safe egress | `ctx.http.safeFetch` / `assertPublicUrl` (RFC 0076 §B) — already wraps every pack fetch |
| Encrypt a secret at rest | BYOK KMS envelope (AES-256-GCM), `byok/secretResolver.ts` |
| Give an agent these as tools | `core.agents.tool-{mcp,http,workflow}` |
| Provenance on a credential use | RFC 0079 `credential-provenance.schema.json` |
| Catalog of installable things + manifests | ADR 0022 marketplace pattern; messaging `MessagingConnectorRecord` precedent |

**The gaps** (all that's genuinely new): BYOK is keyed `(tenantId, credentialRef)`
— **per-workspace only**, with **no per-user and no per-org axis**, **no credential
*kind*** (OAuth vs API-key vs bearer), and **no OAuth2 user-consent flow** to
acquire a delegated token. There is **no provider registry** describing how each
app authenticates. This ADR adds exactly those.

---

## Decision

**A `connections` host-extension owning a generic `Connection` store (scoped by
`tenant` × optional `user` × optional `org`), a provider registry of
`ProviderManifest`s, the auth flows each provider needs (OAuth2 PKCE / API-key /
bearer / custom), a refresh loop, and a templating hook that injects the live
credential into the existing nodes.** No new I/O surface — the nodes already do
the I/O; this supplies the credential they inject.

### 1. The `Connection` model (one shape, every provider)

```
Connection {                         // key: connectionId; UNIQUE (tenantId,userId,orgId,provider)
  connectionId, tenantId,
  userId?,                           // per-USER isolation (the axis BYOK lacks; e.g. a person's Google)
  orgId?,                            // per-ORG shared connection (e.g. the org's ServiceNow)
  provider,                          // 'google' | 'slack' | 'servicenow' | 'zoom' | …
  kind,                              // 'oauth2' | 'api_key' | 'bearer' | 'basic' | 'custom'
  displayName, scopes?,
  encryptedConfig,                   // KMS-enveloped auth material (refresh token | api key | …) — at rest only
  status,                            // 'active' | 'needs-reconsent' | 'expired' | 'revoked'
  connectedAt, expiresAt?, updatedAt }
```

- **Scoping rule.** `userId` set → a personal connection (isolated from teammates
  in a shared workspace). `orgId` set (no `userId`) → a shared org connection any
  member may *use* but only an admin may *manage*. Neither set → a workspace
  default. A run resolves the **most specific** connection for `(provider, acting
  userId, tenantId)`, falling back user → org → workspace.
- **At rest.** Only `encryptedConfig` is persisted (KMS-enveloped, reusing the
  BYOK envelope); live access tokens stay in an in-memory cache (BYOK's
  lazy-decrypt discipline — never logged, never on a result boundary).
- **Migration.** Carries `tenantId` → `reassignTenant` auto-rekeys on anon→personal
  adoption; `userId` is stable (ADR 0003).

### 2. The provider registry — adding an integration is a manifest, not code

```
ProviderManifest {
  id, label, kind,                   // 'oauth2' | 'api_key' | 'custom'
  authFlow,                          // 'pkce' | 'client_credentials' | 'manual' | 'none'
  reach,                             // 'mcp' | 'openapi'  (D1 — default 'openapi'; 'mcp' for push/OAuth-refresh providers)
  scopes: { read: ScopeGroup[], write?: ScopeGroup[] },   // write = separate re-consent
  endpoints: { authorize?, token?, revoke? },
  refreshable, defaultScopes,
  consumerNodes: string[],           // e.g. ['core.openwop.mcp','core.openwop.http']
  mcpServer?: { url, transport },     // reach==='mcp': the registered MCP server
  openapiRef?: string,                // reach==='openapi': Discovery/OpenAPI doc for openapi-call
  docsUrl }
```

A built-in manifest set ships for Google / Slack / ServiceNow / Zoom; a host (or,
later, the **Marketplace** ADR 0022) can add more by dropping a manifest. The
registry is **projected** (manifests + which connections exist), never a second
store of truth — the ADR 0022 discipline.

### 3. Auth flows (per `kind`)

- **`oauth2` (PKCE + state).** `POST /connections/{provider}/authorize` mints a
  consent URL bound to `(tenantId, userId|orgId)`; `GET /connections/{provider}/
  callback` verifies `state`, exchanges `code`→tokens, stores the refresh token
  KMS-enveloped. **Read scopes first; write scopes are a separate re-consent step.**
- **`api_key` / `bearer` / `basic`.** `POST /connections` with the secret →
  stored KMS-enveloped directly (no consent round-trip). This is the path for
  ServiceNow API keys, Slack bot tokens, Zoom S2S, etc.
- OAuth client secrets are Cloud Run secrets (`--update-secrets`, preserving the
  existing 7), host-side only.

### 4. Refresh loop & credential injection (ties the broker to existing nodes)

- **Refresh:** on-demand mint when `expiresAt` passed, plus an optional
  `claimIdempotency`-guarded warm-refresh daemon (the `scheduleDaemon.ts` pattern).
  Failure → `status:'needs-reconsent'`, surfaced; never a silent stall.
- **Injection (no node changes):**
  - `core.openwop.http`/`openapi-call`: host templating resolves
    `{{connections.<provider>.accessToken}}` / `.apiKey` into `config.headers` for
    the **acting `userId`** of the run.
  - `core.openwop.mcp`: a provider MCP server is registered with an **auth
    reference**, minted per-user at `invoke-tool`/`read-resource` time.
  - `core.openwop.integration`: the `ctx.email`/`ctx.slack` host adapters resolve
    the workspace/org connection (falling back to BYOK for back-compat).
  - Every resolved use stamps **RFC 0079 provenance** (provider, scopes, acting
    userId) onto the run audit trail. A run acts **as the user it was created for**,
    never "as the workspace."

> **Correction / §4 injection status (2026-06-11).** Two facts surfaced when
> wiring the first consumer:
> 1. **The "acting user" the broker keys on now exists on the run.** Runs stamp a
>    host-authoritative `run.metadata.actingUserId` (the authenticated human) at
>    creation, exposed to nodes as `ctx.actingUserId` (distinct from `ctx.userId`,
>    which the sample maps to the tenant for launch-studio). `:fork` **re-stamps**
>    it to the forking caller — a fork acts as the forker, never the source run's
>    owner (D2 confused-deputy guard). System runs (schedule / inbound webhook)
>    carry no `actingUserId` ⇒ org/user connections fail closed. *(Landed; tested
>    in `run-acting-user.test.ts`.)*
> 2. **The §4 "host templating into `config.headers`" mechanism is unworkable as
>    written.** `core.openwop.http` strips `Authorization` via `FORBIDDEN_HEADERS`
>    *after* any templating, and its config schemas are `additionalProperties:
>    false` — so a token templated into `config.headers.Authorization` is stripped,
>    and an explicit `config.provider` opt-in would change a **registry-published
>    core pack's config schema → an `openwop` RFC** (not host-only work). D1 already
>    corrects the intent: credentials are **host-injected after sanitization**, via
>    a host-owned seam (`ctx.http.safeFetch`, RFC 0076), never via author config.
> 3. **Opt-in surface — `/architect` chose Option C (landed).** Among (a) an RFC'd
>    `config.provider` field, (b) host-only implicit URL-host match, and (c) a
>    host-only `run.configurable` allow-list, **(c)** won: it stays non-normative
>    (no `openwop` RFC — (a) would couple the generic wire to a host feature) AND
>    is explicit consent (no surprise attachment — (b)'s flaw). The mechanism:
>    - A run consents by allow-listing providers in `configurable.connections`
>      (`["google", …]`); `ctx.http.safeFetch` is provided **only** for such runs,
>      so all other runs keep the pack's egress fallback untouched.
>    - A **double gate** attaches the token: the provider is allow-listed AND the
>      outbound URL host matches a **host-curated** `ProviderManifest.apiHosts`
>      entry at an eTLD+1 boundary (exact/subdomain, never substring — an author
>      URL can't widen it, so the token only reaches the provider's real hosts).
>    - Resolved as the run's `actingUserId` (the broker's `connections:use` gate
>      applies, fail-closed); injected over https (loopback http only when private
>      egress is explicitly enabled); a token-bearing request **MUST NOT** follow a
>      redirect; SSRF reuses the audited RFC 0093 guard; the token never touches
>      `ctx.config`, an event, the run doc, or a log. v1 auto-injects `oauth2`/
>      `bearer` kinds (`api_key`/`basic` header shapes deferred).
>    - Every injected use stamps `run.metadata.connectionUse[]` (RFC 0079 / D2),
>      replay-safe (read verbatim on `:fork`). *(Landed: `connectionInjection.ts`;
>      tested in `connection-injection.test.ts` incl. the eTLD+1 spoof-reject.)*
>    Per-node selection (two nodes, same host, different/anon auth) remains a
>    future **additive** `config.provider` RFC on top of C — not a rewrite.
> 4. **§4 Phase 3 — Slack integration adapter landed.** The `ctx.email`/`ctx.slack`
>    adapters the §4 bullet assumed **did not exist** (the integration nodes threw
>    `host_capability_missing` at exec; no `requires` capability gates them). So
>    `core.openwop.integration.slack-message` is now made functional by **building**
>    `ctx.slack.postMessage` credentialed by the broker: it resolves the run's
>    acting human's Slack Connection, calls Slack `chat.postMessage` with the token
>    (SSRF via the RFC 0093 dispatcher, no-redirect, 10 s timeout), maps the node
>    args, and stamps `connectionUse[]`. No connection ⇒ graceful `{ok:false}`,
>    never a throw. Always provided (the node is explicitly Slack — no per-run
>    opt-in like the http seam). `OPENWOP_SLACK_API_BASE` overrides the endpoint
>    for tests / a proxy. *(Landed: `slackAdapter.ts`; tested in
>    `slack-adapter.test.ts`.)* **Still unbuilt:** `ctx.sms`, `ctx.notification`,
>    and MCP per-user auth (§4 Phase 2, below).
> 5. **The email/notification provider model + `ctx.email` landed.** Decision:
>    **email / SMS / push providers are `api_key`/`bearer` Connections** (not
>    OAuth) — added as provider manifests with `apiHosts` — and each
>    `ctx.{email,sms,notification}` adapter resolves the connection for the node's
>    `config.provider`, keyed on the acting human (`connections:use` enforced),
>    and POSTs to the provider's REST API over the **shared brokered-egress spine**
>    (`brokeredEgress.ts`: https-only / RFC 0093 SSRF / no-redirect / timeout /
>    stamp-on-success). `slackAdapter` was refactored onto the same spine — one
>    egress path, no duplication. v1 ships **SendGrid** as the concrete `ctx.email`
>    reference (`POST /v3/mail/send`, 202-on-accept); SES / Mailgun / Postmark /
>    SMTP are future manifests + a branch in `emailAdapter.ts`; an unsupported
>    `provider` ⇒ `{sent:false, error:'email_provider_unsupported'}`. *(Landed:
>    `emailAdapter.ts`, `brokeredEgress.ts`, the `sendgrid` manifest; tested in
>    `email-adapter.test.ts`.)*
>    **`ctx.messaging.sendSms` (Twilio) + `ctx.notification.push` (Expo) landed**
>    on the same spine, generalizing it across **auth schemes**: `brokeredPost`
>    gained an `authScheme: 'bearer' | 'basic'` (+ a secret→URL builder for
>    providers like Twilio whose path embeds the public credential half, the
>    `AccountSid`). Twilio is a `basic`-kind connection (`secret =
>    AccountSid:AuthToken`, form-encoded body); Expo is `api_key` Bearer/JSON.
>    *(Landed: `smsAdapter.ts`, `notificationAdapter.ts`, `twilio`/`expo` manifests;
>    tested in `sms-notification-adapter.test.ts`.)* All four integration adapters
>    (slack/email/sms/notification) now share one audited egress path.
> 6. **§4 Phase 2 (MCP per-user auth) — designed, blocked on a missing foundation.**
>    Per-user MCP auth was scoped as injecting a Connection token at
>    `invoke-tool`/`read-resource` time. Discovery: **the host has no OUTBOUND MCP
>    client at all** — it only *exposes itself* as an MCP server (RFC 0020,
>    `routes/mcp.ts`); `ctx.mcp` implements only `expose` (a stub), and there is no
>    provider→MCP-server registration that maps a `reach:'mcp'` manifest's
>    `mcpServer` to a live client. So Phase 2 is **not a thin wire-in** — it rests
>    on building an MCP/JSON-RPC client subsystem (transport + a
>    `serverId`→provider registry + `ctx.mcp.{listTools,invokeTool,readResource,…}`),
>    which is its own feature (likely its own ADR). **The connection slice is
>    small once that exists:** in `ctx.mcp.invokeTool(serverId, …)`, map `serverId`
>    → provider, call `resolveConnectionCredential({tenantId, provider,
>    actingUserId: ctx.actingUserId, orgId})`, inject `Authorization: Bearer` on the
>    outbound MCP request, and stamp `connectionUse[]` — the same pattern as the
>    http/integration adapters. **Deferred** until the MCP client lands; not built
>    here (no half-client).

### 5. REST surface (non-normative)

```
POST   /v1/host/openwop-app/connections/{provider}/authorize     # oauth2 consent URL
GET    /v1/host/openwop-app/connections/{provider}/callback      # oauth2 code exchange
POST   /v1/host/openwop-app/connections                          # api_key/bearer/basic create
GET    /v1/host/openwop-app/connections                          # list caller's connections (status only, never secrets)
DELETE /v1/host/openwop-app/connections/{connectionId}           # revoke at provider + drop
POST   /v1/host/openwop-app/connections/{connectionId}/test      # fire a provider health call
GET    /v1/host/openwop-app/providers                            # the registry (manifests)
GET    /v1/host/openwop-app/providers/{provider}                 # one manifest + consumerNodes

# Host-managed OAuth client config (§7) — SUPERADMIN only; secret never returned
GET    /v1/host/openwop-app/connections-oauth-clients            # list configured providers (clientId + metadata)
PUT    /v1/host/openwop-app/connections-oauth-clients/{provider} # set {clientId, clientSecret}; 204
DELETE /v1/host/openwop-app/connections-oauth-clients/{provider} # remove; falls back to env
```

### 6. Inbound provider events (extensibility, designed-for not built-now)

Provider webhooks (Slack events, Zoom meeting-ended, ServiceNow incident updates)
ride the **existing RFC 0083 trigger bridge** + `routes/webhooks.ts`, keyed by
`connectionId`, delivered as per-tenant triggers — so an inbound integration is a
subscription, not a new ingestion subsystem. (Phase C+.)

### 7. Host-managed OAuth client config — UI-configurable (added 2026-06-11)

**Decision.** A provider's OAuth *client* credentials (client id + secret — the
host's registered OAuth app, distinct from the per-user delegated tokens) are
configurable by a **superadmin operator through the UI**, not only via
`OPENWOP_OAUTH_<PROVIDER>_CLIENT_ID/SECRET` env vars. So enabling Google / Slack
is self-service — no `gcloud run services update`, no redeploy — and a new
provider lights up its Connect button the moment its app is configured.

**Composition (no new primitives).**
- **Resolver:** `oauthClient(provider)` (`oauthFlow.ts`) resolves **store-first →
  env-fallback**, and is the single function `isOAuthConfigured` (the
  `oauthConfigured` honesty flag) flows from. Env remains a valid, unchanged path.
- **Store:** `oauthClientStore.ts` — one `DurableCollection('connections:oauth-client')`
  row per provider holding `{clientId, secret, updatedAt/By}`. The **client secret
  is sealed with the BYOK envelope** via a new host-scoped `sealHostSecret` /
  `openHostSecret` (`byok/secretResolver.ts`) — host-global, *not* the tenant-scoped
  `setSecret`. The envelope stays the single owner of encrypt-at-rest; this feature
  composes it rather than re-deriving the master key.
- **Routes:** a **sibling** prefix `/v1/host/openwop-app/connections-oauth-clients/*`
  (NOT nested under `/connections/:id`, which the param routes own — same discipline
  as `connections-inbound`), gated by the shared `requireSuperadmin` (ADR 0028).
- **UI:** `OAuthClientAdminPanel` on the (admin-tier) Connections page, hidden on a
  403 — same self-gating pattern as `GovernancePanel`.

**Security posture.** The client secret is **write-only** (never returned on any
read — only `clientId` + `configured`), sealed at rest with the *same* envelope
that protects per-user refresh tokens, and `oauthClient` **fails closed** (a
decrypt error reads as absent → falls back to env / unconfigured, never a 500).
Writes are superadmin-only; the redirect URI stays host-computed (no injection).
**Irreducible caveat:** this does not reach zero host secrets — the envelope's
master key (`.byok-master-key`, ideally KMS-wrapped) must still exist. It collapses
*N per-provider secrets* to the *one bootstrap key already present*, which already
guards more sensitive material.

**Architect review (2026-06-11):** four boundary/authz corrections applied before
build — sibling prefix (not `/connections/admin/*`); reuse the shared
`requireSuperadmin` (already extracted in ADR 0028, single dev-open knob); host-seal
API instead of reaching into BYOK internals; resolver fails closed, store-first.

---

## RFC gate

**Host work — no new RFC.** All surfaces under `/v1/host/openwop-app/{connections,
providers}/*` (non-normative), riding Accepted RFCs (0050/0076/0079). Advertise a
provider only under non-normative `hostExtensions.connections` **and only once a
real auth round-trip succeeds** (honesty rule; `OPENWOP_REQUIRE_BEHAVIOR=true`
enforces). A normative top-level `capabilities.connections` field would need an
RFC — deliberately **not** doing that.

## Boundaries audit

| Concept | Single owner |
|---|---|
| External API I/O | existing `core.openwop.{mcp,http,integration}` nodes — compose |
| SSRF egress | `ctx.http.safeFetch` (RFC 0076) — reuse |
| Secret encryption | BYOK KMS envelope — reuse |
| Per-workspace opaque secrets | `byok/secretResolver.ts` — unchanged |
| **Per-user / per-org provider connections + the provider registry** | **NEW — `connections` (this ADR)** — the only new owner |
| Credential provenance | RFC 0079 — reuse |
| Installable provider manifests (future) | Marketplace (ADR 0022) — compose |

Route check: no prior registrant on `/v1/host/openwop-app/connections` or `/providers`.
The messaging `MessagingConnectorRecord` (routing/policy, no credentials) stays its
own concern; it MAY later project as a `kind:'custom'` connection but is not folded
in this ADR.

## Phased plan

- **Phase A** — `Connection` store + provider registry + the `api_key/bearer`
  create path + the templating-injection hook for `http`/`openapi-call`. Ship the
  Google + Slack manifests. (Unblocks ADR 0023 read-path via an MCP server / API key.)
- **Phase B** — OAuth2 PKCE consent + refresh daemon + RFC 0079 provenance +
  `core.agents.tool-*` wiring. Add ServiceNow / Zoom manifests.
- **Phase C** — write-scope re-consent; inbound provider webhooks via the trigger
  bridge; the org-shared connection management UI (admin-gated).
- **Phase D** — the first node-exec consumers (ADR 0023 T1): landed as §4
  **Option C** (run-level `configurable.connections` opt-in + curated
  `apiHosts` matching + the `connectionUse` stamp); see the correction below.

### Phase D — node-exec credential injection (SUPERSEDED 2026-06-11 by §4 Option C)

> **Correction — two parallel sessions implemented this seam the same day.**
> This section originally specced a per-node `config.connection = { provider }`
> annotation feeding a host `ctx.http.safeFetch`. The parallel implementation
> (PR #155/#159, `host/connectionInjection.ts` — **Option C, ratified by
> `/architect`**) is the one that stands: the opt-in is **run-level**
> (`configurable.connections: ["google", …]`, wire-legal free-form run options)
> so node configs stay exactly the packs' published schemas (a per-node config
> key would violate their `additionalProperties: false` and need an openwop
> RFC), and the credential attaches only when the URL host matches the
> host-curated `ProviderManifest.apiHosts` at an eTLD+1 boundary.
>
> What survived from this section's review pins, relocated:
> - **Provider governance at the choke point** — ADR 0028's `isProviderAllowed`
>   is enforced inside `resolveConnectionCredential()` itself, so it covers
>   every consumer (the http egress seam, the Slack adapter, future adapters)
>   with the same predicate as the connect routes.
> - **Scheduler trust boundary** — `ScheduledJob.metadata` is sanitized at the
>   route (reserved keys stripped; `actingUserId` stamped from the
>   authenticated principal) and the daemon refuses to forward attribution
>   blocks; the assistant loops carry their run-level credential opt-in on
>   `ScheduledJob.configurable` → `run.configurable` (additive pass-through).
> - **Send verdict** — `core.openwop.http.fetch` completes on ANY outcome
>   (side-effect-once), so the assistant's execution workflows gate on
>   `feature.assistant.nodes.confirm-action-send` (non-2xx fails the run; the
>   action records `failed`, never a false `sent`).
> - The `redirect:'error'`-when-injected and stamp-dedup behaviors exist in the
>   landed seam; `agent.toolCalled` hook emission and per-node audience lists
>   (`audiences`) were dropped with the superseded design.

### Phase C — what landed (2026-06-11)

| Piece | Where |
|---|---|
| **Write-scope re-consent** — `authorize {write:true}` adds the manifest's WRITE scope groups on top of the read defaults (a separate consent); the callback merges the granted write scopes into the connection. UI offers "Grant write access" when a connection lacks them. | `oauthFlow.ts` (`writeScopesOf`, `includeWrite`), `routes.ts`, `ConnectionsPage.tsx` |
| **Org-shared connections + RBAC (D2)** — new scopes `host:connections:manage` (admin-only management) + `connections:use` (member grant, default-deny); the Phase B blanket org-create 403 is replaced by a `host:connections:manage` check on the target org; revoke/test of an org connection is admin-gated. | `accessControlService.ts` (scope vocab + admin role), `routes.ts` (`requireConnectionsManage`/`authorizeManage`) |
| **`connections:use` enforced at the resolve boundary** — `resolveConnectionCredential` withholds an org-shared credential from an acting human lacking `connections:use` on that org (fail-closed), so the confused-deputy guard holds for EVERY consumer, not just one route. `provenance.scopeChecked` is now a real check. | `connectionsService.ts` (`actingUserHasOrgUse`) |
| **Inbound provider webhooks** — a public, credential-less ingest (`POST /connections-inbound/:id`, auth-allowlisted) verifies the Slack HMAC (constant-time, replay-windowed) + answers `url_verification`, dedups on `event_id`, and fires a configured workflow through the **existing RFC 0083 trigger bridge** keyed by `connectionId`. Per-connection inbound config (workflowId + signing secret KMS-enveloped) is admin-gated under `/connections/:id/inbound`. | `inboundWebhooks.ts`, `routes.ts`, `index.ts` (raw-body parser), `middleware/auth.ts` (public prefix) |

**Notes.** (1) Org connections are **S2S credentials** (api_key/bearer): an OAuth org *service identity* is the D2 tripwire ("per-user attribution needs per-user connections") and stays deferred. (2) Inbound verification is **Slack-only** today (`inboundSupported`); other push providers are a manifest-declared verifier away. (3) The `run.metadata.connectionUse[]` provenance *stamp* still lands with the first node-exec consumer (ADR 0023/0025) — the resolver returns the shape and now enforces the gate; the stamp is the consumer's write.

### Phase B — what landed (2026-06-11)

| Piece | Where |
|---|---|
| OAuth2 PKCE consent round-trip (`authorize` → consent URL; `callback` → code exchange, single-use server-stored `state` + PKCE verifier in a `DurableCollection`, so the callback may land on any fleet instance) | `oauthFlow.ts`, `routes.ts` |
| Token store: refresh + access token KMS-enveloped via the BYOK envelope as one JSON blob; only non-secret metadata in our store; re-consent UPDATES the same identity row | `connectionsService.ts` (`upsertOAuthConnection`) |
| On-demand refresh on resolve (mint when within the skew window; refresh failure → `needs-reconsent`, never a silent stall) | `connectionsService.ts` (`liveSecretFor`) |
| Warm-refresh daemon (proactive pre-expiry refresh; fire-once per `(connectionId, expiresAt)` slot via `claimIdempotency`, the `scheduleDaemon` pattern) | `refreshDaemon.ts`, wired in `index.ts` |
| `/test` health probe (exercises the refresh path; never returns the secret) | `routes.ts`, `connectionsService.ts` (`probeConnection`) |
| Honesty signal `oauthConfigured` on the provider list + frontend "Connect" consent buttons + callback toast | `routes.ts`, `ConnectionsPage.tsx` |

**Correction / deferred from the original Phase-B bullet.** Two items moved out:
(1) **`core.agents.tool-*` wiring + the `run.metadata.connectionUse[]` provenance
*stamp*** — the resolver already RETURNS the `provenance` object (D2 shape:
`connectionId`/`provider`/`scopeAxis`/`actingUserId`/`scopeChecked`), but **no
node-execution path consumes `resolveConnectionCredential` yet** (grep: zero
callers outside the feature). Stamping `run.metadata.connectionUse[]` happens at
that injection site, so it lands with the first consumer (ADR 0023's read-path /
ADR 0025). The seam is ready; the consumer is not wired here. (2) **Org-shared
RBAC management** (`connections:use` + admin-managed org create) stays
fail-closed (org create still 403s) and moves to **Phase C** with its management
UI — Phase B keeps the per-user OAuth path, which is what the Connections screen
banner promised. OAuth **client secrets** are host-side env (`OPENWOP_OAUTH_<PROVIDER>_CLIENT_{ID,SECRET}`),
never per-connection; the redirect base is `OPENWOP_OAUTH_CALLBACK_BASE_URL`
(falls back to `OPENWOP_PUBLIC_BASE_URL`, then the request origin).

**Operational notes.** (a) **Local dev:** the post-consent redirect goes to
`OPENWOP_PUBLIC_BASE_URL` (→ request origin if unset). With the SPA on a separate
Vite port, set `OPENWOP_PUBLIC_BASE_URL` to the Vite origin (and
`OPENWOP_OAUTH_CALLBACK_BASE_URL` to the backend) or the callback lands on the
backend origin instead of the app. (b) **Hygiene daemons:** abandoned consent
flows are GC'd (`sweepExpiredPendingAuth`, folded into the refresh daemon tick)
so the pending-auth store stays bounded; token-endpoint requests are bounded by a
10 s timeout so a hung provider can't stall the callback or a run.

## Resolved decisions (architect review, 2026-06-10)

**D1 — Per-provider reach: hybrid, manifest-declared.** `ProviderManifest` gains a
discriminator `reach: 'mcp' | 'openapi'` (+ `mcpServer?` / `openapiRef?`). **Default
a new provider to `openapi`** (`core.openwop.http.openapi-call` — zero extra runtime
dependency); **promote to `mcp`** only when the provider offers **push
subscriptions** (`core.openwop.mcp.subscribe-resource` — the Drive/Gmail
change-detection win) or a first-party MCP server that manages its own per-user
OAuth refresh. Initial set: Google → `mcp`, Slack → `mcp`|`openapi`, ServiceNow /
Zoom → `openapi`. **Security invariant:** credentials are **always host-injected**
by the broker's resolver (keyed on the run's acting principal) **after** header
sanitization — **never** via workflow `config.headers`. `core.openwop.http` already
strips author-supplied `Authorization` (`FORBIDDEN_HEADERS`), so this forecloses
credential leakage through replayable/forkable/shareable workflow definitions.
*Falsifiable:* if the Google MCP server can't do per-user OAuth, default everything
to `openapi` + host injection and use `core.trigger.*` polling instead of
`subscribe-resource`.

**D2 — Org-shared governance: actor ≠ authority; preserve the actor, gate the use.**
Two identities are kept distinct (the GCP-impersonation / AWS-AssumeRole pattern):
- **Actor = the run owner, always the human** (`user:<id>`, RFC 0048) or the
  assistant agent acting *for* a named human. An `orgId` connection **never**
  re-owns the run and **never** impersonates a different human.
- **Authority = the connection's token at the provider.** A `userId` connection →
  user-delegated token (provider sees the human; no escalation). An `orgId`
  connection → the org **service identity** at the provider (for S2S-only or
  genuinely shared org systems).
- **Confused-deputy guard:** using an `orgId` connection requires the RBAC scope
  **`connections:use`** on that `connectionId`/provider, checked at run-creation /
  node-exec; the connection is **admin-managed** (create/rotate/revoke = admin),
  **member-usable only by grant**, **fail-closed**.
- **Provenance (within RFC 0079 as-is):** stamp `credentialId` = the connection,
  `issuer`/`scopes` from the credential, `auditCorrelationId` = the run/owner
  correlation; **additionally** write a non-wire, replay-safe
  `run.metadata.connectionUse[] = {connectionId, provider, actingUserId,
  scopeChecked:true}` (read verbatim on `:fork`, like the variant stamp) so "which
  human used the org credential, for what" is always answerable.
- **Least-privilege default:** the resolver prefers **user → org → workspace**; the
  org connection is the fallback, not the default.
- *Tripwire:* a provider that issues only one org service identity **cannot** give
  per-user attribution *at the provider* — for those, require per-user connections.
  Cross-host actor propagation, if ever needed, is an **additive** RFC adding
  `actor`/`onBehalfOf` to credential-provenance (non-breaking); host-local needs
  none.

## Open questions (ranked)

1. **(Medium) Manifest distribution** — built-in only, or installable via
   Marketplace (ADR 0022) with signing? *Built-in v1; marketplace later.*
2. **(Medium) Key custody / rotation** for `encryptedConfig`.
