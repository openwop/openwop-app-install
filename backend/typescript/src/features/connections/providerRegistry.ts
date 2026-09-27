/**
 * Provider registry (ADR 0024 §2 / D1) — adding an integration is a MANIFEST,
 * not code. Each manifest declares how an external app authenticates and how the
 * host reaches it (`reach`): `'mcp'` (a registered MCP server — push subscriptions
 * + self-describing tools) or `'openapi'` (core.openwop.http.openapi-call on a
 * Discovery doc). Default a new provider to `'openapi'`; promote to `'mcp'` only
 * for push/OAuth-refresh providers (D1).
 *
 * This is a PROJECTION (a built-in catalog), not a second store of truth — the
 * Marketplace (ADR 0022) can later add manifests as installable artifacts.
 */

export type CredentialKind = 'oauth2' | 'api_key' | 'bearer' | 'basic' | 'custom' | 'service-account-jwt';
export type ProviderReach = 'mcp' | 'openapi';
export type AuthFlow = 'pkce' | 'client_credentials' | 'manual' | 'none' | 'service-account-jwt';

export interface ScopeGroup {
  key: string;
  label: string;
  scopes: string[];
}

export interface ProviderManifest {
  id: string;
  label: string;
  /** Capability category (connection-pack manifest `category` enum: email-calendar
   *  / communication / crm / ticketing / hr / finance / marketing / …). Lets a
   *  workflow bind "the user's <capability> connection" instead of a hard-coded
   *  provider id — host-only resolution (RFC 0095 `provider.id` stays the wire key). */
  category?: string;
  /** The commercial vendor/ecosystem this connector belongs to ("Microsoft 365",
   *  "Google", "Workday", …). Groups the catalog so a company can pick connectors by
   *  the vendors it does business with (a Google shop connects Google Workspace +
   *  Gmail + BigQuery under one heading). Presentational + host-only — NOT the wire
   *  key (RFC 0095 `provider.id` still resolves auth); other hosts ignore it. */
  vendor?: string;
  kind: CredentialKind;
  authFlow: AuthFlow;
  reach: ProviderReach;
  scopes: { read: ScopeGroup[]; write?: ScopeGroup[] };
  endpoints?: { authorize?: string; token?: string; revoke?: string };
  refreshable: boolean;
  defaultScopes: string[];
  /** The core node packs that consume a credential for this provider. */
  consumerNodes: string[];
  /** HOST-CURATED API hostnames this provider's credential may be injected onto
   *  (ADR 0024 §4 Option C). The connection broker attaches the token ONLY when
   *  an outbound URL's host is one of these (exact or a subdomain — eTLD+1
   *  boundary, never substring) AND the run allow-listed the provider. Author-
   *  supplied URLs cannot widen this set, so a token can only ever reach the
   *  provider's real hosts. Empty/absent ⇒ no http auto-injection. */
  apiHosts?: string[];
  /** ADR 0076 P3 — DEFENSE-IN-DEPTH read-only flag. The PRIMARY read-only control is
   *  a manifest with no `scopes.write` group (the OAuth provider enforces it server-side);
   *  this flag adds a secondary host-side gate that fails closed on unambiguously-mutating
   *  verbs (PUT/PATCH/DELETE) at `connectorInvoker`. It is intentionally PERMISSIVE to
   *  GET/POST — read APIs like BigQuery `jobs.query` are POST-with-a-body — so it cannot
   *  catch a mutating POST; the no-write-scope manifest is the real guard. A `readOnly`
   *  provider MUST NOT declare a write scope group (see `assertReadOnlyConsistent`). */
  readOnly?: boolean;
  /** A WRITE-scoped provider whose write is a GOVERNED action (ADR 0028) and therefore
   *  MUST be reachable ONLY through its host adapter's `brokeredPost` (which host-pins the
   *  URL + funnels through the approval gate), NEVER through the generic `ctx.http.safeFetch`
   *  (`core.openwop.http.fetch`) provider-match — else a run that opts the connection in could
   *  POST the write ungated, defeating the separation-of-duty gate. `matchAllowedProvider`
   *  (connectionInjection.ts) skips `adapterOnly` providers; `brokeredPost` is unaffected
   *  (it resolves by explicit provider id, not host-match). Set on `bigquery-write` (ADR 0292). */
  adapterOnly?: boolean;
  /** H21 — this manifest was SYNTHESIZED from operator config (`host/
   *  mcpOperatorServer.ts`), not consented to by a user. It is the ONLY marker
   *  that lets `mcpClient.resolveTarget` take the operator-credential lane
   *  instead of `resolveConnectionCredential`: a host-global server has no
   *  per-user Connection row by construction. Set in `operatorMcpManifest` and
   *  NOWHERE else — a built-in or packaged provider must never carry it, or a
   *  user-scoped credential gate would be bypassable by manifest data. */
  operatorManaged?: boolean;
  /**
   * reach==='mcp': the MCP server to register; reach==='openapi': the spec ref.
   *
   * ADR 0553 P3 — `profile` and `audience` are the ADR's "provider manifests
   * declare the exact MCP profile and auth audience", and both are HOST-SIDE
   * fields (never on the wire, never in a capability document).
   *
   * `profile` — a named RFC 0153 §A composition profile (`mcp-2026-07-28` /
   * `mcp-2025-06-18-legacy`). When set it is a FLOOR, not a hint: the client
   * opens at that profile's revision and a peer's `-32022` can never lower it,
   * so a peer that self-describes as legacy-only fails
   * `interop_version_unsupported` instead of being talked to over a revision the
   * operator did not sanction. Absent ⇒ the pre-P3 behaviour (open at preferred,
   * an explicit peer-justified downgrade is allowed).
   *
   * `audience` — the audience the credential for this server MUST be minted
   * for. When set, an outbound bearer whose audience is not this value is
   * refused BEFORE the request is issued, which is the confused-deputy guard: a
   * token good for server A must not be spendable at server B. Absent ⇒
   * unchanged. Declaring it is opt-in precisely so the enforcement can be
   * fail-closed (an audience that cannot be READ is also a refusal) without
   * breaking connectors that carry opaque bearers today.
   */
  mcpServer?: { url: string; transport: 'http' | 'sse'; profile?: string; audience?: string };
  /**
   * RFC 0199 §A.4 — the provider's authorization-server issuer identifier
   * (RFC 8414 / RFC 9207). When set, the callback's `iss` MUST equal it by simple
   * string comparison, checked before any token request. Absent ⇒ the provider's
   * redirect URI is unique on this host (`…/connections/<id>/callback`), which is
   * the RFC 9700 §4.4.2.2 mix-up defense for an issuer-less provider.
   */
  issuer?: string;
  /** RFC 9207 §2.4 — the provider's metadata sets
   *  `authorization_response_iss_parameter_supported: true`, so a callback with
   *  NO `iss` is refused too. Only meaningful with `issuer`. */
  issResponseParameter?: boolean;
  /** RFC 0199 §A.1 — `unsupported` omits PKCE for this provider (and is
   *  advertised on its `oauth.providers[]` member). Absent ⇒ `S256`. */
  pkce?: 'S256' | 'unsupported';
  openapiRef?: string;
  docsUrl?: string;
}

/**
 * Built-in manifests. Google is `mcp` (push subscriptions for Drive/Gmail change
 * detection + server-side OAuth refresh — D1); ServiceNow/Zoom are `openapi`
 * (static API-key / S2S bearer REST); Slack is `mcp` (Events API + rich tools).
 */
/**
 * Google's authorization server, shared by every Google-family provider.
 * MEASURED 2026-09-26 at https://accounts.google.com/.well-known/openid-configuration:
 * `issuer: "https://accounts.google.com"` (no trailing slash — the form RFC 0199
 * §B.3(d) and the RFC 9207 `iss` check compare against, per the RFC owner's
 * ruling on Google's slash-suffixed PRM entry) and
 * `authorization_response_iss_parameter_supported: true`.
 */
const GOOGLE_AUTHORIZATION_SERVER = {
  issuer: 'https://accounts.google.com',
  issResponseParameter: true,
} as const;

const BUILTIN: ProviderManifest[] = [
  {
    id: 'google',
    label: 'Google Workspace',
    kind: 'oauth2',
    authFlow: 'pkce',
    reach: 'mcp',
    // ADR 0466 — Google's first-party remote Calendar MCP server (host-curated URL;
    // an author never supplies one). KickTodo calendar-write invokes create/update/
    // delete_event here via the owner's `google` Connection (calendar.events scope).
    // NOTE: `google` is a multi-product provider; this single field currently maps to
    // the CALENDAR server (the only Google MCP product wired). When a second Google
    // MCP product (Gmail/Drive) lands, evolve this to a per-capability `mcpServers`
    // map rather than forking the provider (ADR 0466 §1 evolution note).
    mcpServer: { url: 'https://calendarmcp.googleapis.com/mcp/v1', transport: 'http' },
    scopes: {
      read: [
        { key: 'drive.readonly', label: 'Drive (read)', scopes: ['https://www.googleapis.com/auth/drive.readonly'] },
        { key: 'calendar.readonly', label: 'Calendar (read)', scopes: ['https://www.googleapis.com/auth/calendar.readonly'] },
        { key: 'gmail.readonly', label: 'Gmail (read)', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
      ],
      write: [
        { key: 'gmail.send', label: 'Gmail (send)', scopes: ['https://www.googleapis.com/auth/gmail.send'] },
        { key: 'calendar.events', label: 'Calendar (write)', scopes: ['https://www.googleapis.com/auth/calendar.events'] },
      ],
    },
    ...GOOGLE_AUTHORIZATION_SERVER,
    endpoints: {
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      revoke: 'https://oauth2.googleapis.com/revoke',
    },
    refreshable: true,
    defaultScopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
    consumerNodes: ['core.openwop.mcp', 'core.openwop.http'],
    apiHosts: ['googleapis.com'], // www.googleapis.com, gmail.googleapis.com, … (subdomains)
    docsUrl: 'https://developers.google.com/workspace',
  },
  {
    id: 'slack',
    label: 'Slack',
    kind: 'oauth2',
    authFlow: 'pkce',
    reach: 'mcp',
    scopes: { read: [{ key: 'read', label: 'Channels + messages (read)', scopes: ['channels:read', 'channels:history'] }], write: [{ key: 'write', label: 'Post messages', scopes: ['chat:write'] }] },
    endpoints: { authorize: 'https://slack.com/oauth/v2/authorize', token: 'https://slack.com/api/oauth.v2.access' },
    refreshable: false,
    defaultScopes: ['channels:read', 'channels:history'],
    consumerNodes: ['core.openwop.mcp', 'core.openwop.integration'],
    apiHosts: ['slack.com'], // slack.com/api/* (subdomains incl. www)
    docsUrl: 'https://api.slack.com',
  },
  {
    id: 'servicenow',
    label: 'ServiceNow',
    kind: 'api_key',
    authFlow: 'manual',
    reach: 'openapi',
    scopes: { read: [{ key: 'table.read', label: 'Table API (read)', scopes: [] }], write: [{ key: 'table.write', label: 'Table API (write)', scopes: [] }] },
    refreshable: false,
    defaultScopes: [],
    consumerNodes: ['core.openwop.http'],
    // ADR 0033 correction + ADR 0037: each customer instance is a subdomain of
    // service-now.com (e.g. acme.service-now.com). The eTLD+1 pin matches any
    // instance subdomain without naming a tenant. Without this, brokered egress
    // (the http seam + the connector invoker) is not allow-listed to ServiceNow.
    apiHosts: ['service-now.com'],
    openapiRef: 'https://docs.servicenow.com/api',
    docsUrl: 'https://developer.servicenow.com',
  },
  {
    id: 'zoom',
    label: 'Zoom',
    kind: 'bearer',
    authFlow: 'client_credentials',
    reach: 'openapi',
    scopes: { read: [{ key: 'meeting.read', label: 'Meetings (read)', scopes: ['meeting:read'] }], write: [{ key: 'meeting.write', label: 'Meetings (write)', scopes: ['meeting:write'] }] },
    endpoints: { token: 'https://zoom.us/oauth/token' },
    refreshable: true,
    defaultScopes: ['meeting:read'],
    consumerNodes: ['core.openwop.http'],
    apiHosts: ['zoom.us'], // api.zoom.us (subdomain)
    openapiRef: 'https://developers.zoom.us/docs/api',
    docsUrl: 'https://developers.zoom.us',
  },
  {
    // ADR 0404 — the WEBINAR connector's narrow governed-write identity, distinct
    // from the broad `zoom` builtin above (the same deliberate coexistence as
    // `bigquery` vs `bigquery-write`, ADR 0292). Registrant WRITE (add-a-registrant)
    // spends nothing but MUST be a governed vendor write funneled through the
    // webinar adapter's `brokeredPost`, never the generic `core.openwop.http.fetch`
    // — so `adapterOnly` skips the generic credential injection. Read scopes back
    // the attendance backfill; the webhook lane rides the shared inbound seam.
    id: 'zoom-webinar',
    label: 'Zoom Webinars',
    kind: 'oauth2',
    authFlow: 'pkce',
    reach: 'openapi',
    scopes: {
      read: [{ key: 'webinar.read', label: 'Webinars (read registrants + attendance)', scopes: ['webinar:read', 'report:read:admin'] }],
      write: [{ key: 'webinar.write', label: 'Add webinar registrants', scopes: ['webinar:write'] }],
    },
    endpoints: {
      authorize: 'https://zoom.us/oauth/authorize',
      token: 'https://zoom.us/oauth/token',
      revoke: 'https://zoom.us/oauth/revoke',
    },
    refreshable: true,
    defaultScopes: ['webinar:write', 'webinar:read'],
    apiHosts: ['zoom.us'], // api.zoom.us (subdomain)
    adapterOnly: true,
    consumerNodes: [],
    docsUrl: 'https://developers.zoom.us/docs/api/webinars/',
  },
  {
    // ADR 0404 — the HeyGen-class AI-video (avatar script→MP4) provider. Job
    // submission SPENDS money → a governed vendor write, so `adapterOnly` (like
    // bigquery-write): the video adapter's `brokeredPost` (which host-pins the URL
    // + meters the spend) is the ONLY path — the generic http.fetch can't bypass
    // the ADR 0106 cost meter. API-key auth (X-Api-Key header, set by the broker).
    id: 'heygen',
    label: 'HeyGen (AI video)',
    kind: 'api_key',
    authFlow: 'manual',
    reach: 'openapi',
    scopes: {
      read: [{ key: 'video.read', label: 'Read video job status', scopes: [] }],
      write: [{ key: 'video.write', label: 'Generate avatar videos', scopes: [] }],
    },
    refreshable: false,
    defaultScopes: [],
    apiHosts: ['heygen.com'], // api.heygen.com + resource CDN subdomains
    adapterOnly: true,
    consumerNodes: [],
    docsUrl: 'https://docs.heygen.com/',
  },
  {
    // ADR 0404 §P4 — the frontier text-to-video (Runway/Veo/Sora-class) provider,
    // OFF by default behind the `creative-video.t2v` sub-toggle. Same governed-spend
    // posture as `heygen`: job submission SPENDS money on an expensive model, so
    // `adapterOnly` (the t2v adapter's `brokeredPost` is the ONLY path — the generic
    // http.fetch can't bypass the ADR 0106 `video` meter). Bearer key auth.
    id: 'runway',
    label: 'Runway (text-to-video)',
    kind: 'api_key',
    authFlow: 'manual',
    reach: 'openapi',
    scopes: {
      read: [{ key: 'video.read', label: 'Read video task status', scopes: [] }],
      write: [{ key: 'video.write', label: 'Generate videos from text', scopes: [] }],
    },
    refreshable: false,
    defaultScopes: [],
    apiHosts: ['runwayml.com'], // api.runwayml.com + result CDN subdomains
    adapterOnly: true,
    consumerNodes: [],
    docsUrl: 'https://docs.dev.runwayml.com/',
  },
  {
    // ADR 0024 §4 — email provider (the email/notification model: api_key
    // Connections + a per-provider egress adapter). SendGrid is the v1 reference
    // ctx.email consumer; SES / Mailgun / Postmark / SMTP follow the same shape.
    id: 'sendgrid',
    label: 'SendGrid',
    kind: 'api_key',
    authFlow: 'manual',
    reach: 'openapi',
    scopes: { read: [], write: [{ key: 'mail.send', label: 'Send mail', scopes: ['mail.send'] }] },
    refreshable: false,
    defaultScopes: [],
    consumerNodes: ['core.openwop.integration'],
    apiHosts: ['api.sendgrid.com'],
    openapiRef: 'https://docs.sendgrid.com/api-reference',
    docsUrl: 'https://docs.sendgrid.com',
  },
  {
    // ADR 0193 Phase 1 — Postmark, the second transactional email provider.
    // Same api_key/ctx.email shape as SendGrid, but the token rides a custom
    // header (X-Postmark-Server-Token), not Authorization: Bearer — the email
    // adapter's provider table sets authScheme:'raw' + the header name. Chosen
    // as the Phase-1 exemplar precisely because it exercises the non-bearer
    // path (SES needs SigV4 signing → not a static-header fit → a follow-up).
    id: 'postmark',
    label: 'Postmark',
    kind: 'api_key',
    authFlow: 'manual',
    reach: 'openapi',
    scopes: { read: [], write: [{ key: 'email.send', label: 'Send mail', scopes: ['email.send'] }] },
    refreshable: false,
    defaultScopes: [],
    consumerNodes: ['core.openwop.integration'],
    apiHosts: ['api.postmarkapp.com'],
    openapiRef: 'https://postmarkapp.com/developer/api/email-api',
    docsUrl: 'https://postmarkapp.com/developer',
  },
  {
    // ADR 0201 Phase 3 — raw SMTP transport. A `basic`-kind CUSTOM-SERVER
    // connection: unlike the HTTP providers above, SMTP is raw TCP (465/587), so
    // it never egresses over HTTP — `apiHosts` is empty (no token auto-injection)
    // and `reach:'openapi'` is inert (the email adapter resolves this credential
    // directly by provider id; there is no OpenAPI/MCP consumer). The connection's
    // sealed secret is a JSON `{host,port,secure,user,pass}` blob (host/port are
    // per-connection, not a fixed manifest host); the SMTP dial is governed by the
    // ADR 0201 TCP-egress firewall (`smtpEgress.ts`), not `apiHosts`.
    id: 'smtp',
    label: 'SMTP server',
    kind: 'basic',
    authFlow: 'manual',
    reach: 'openapi',
    scopes: { read: [], write: [{ key: 'mail.send', label: 'Send mail', scopes: [] }] },
    refreshable: false,
    defaultScopes: [],
    consumerNodes: ['core.openwop.integration'],
    apiHosts: [],
    docsUrl: 'https://nodemailer.com/smtp/',
  },
  {
    // ADR 0024 §4 — SMS provider. `basic`-kind: the secret is the
    // `AccountSid:AuthToken` pair (HTTP Basic). The v1 ctx.messaging.sendSms
    // consumer.
    id: 'twilio',
    label: 'Twilio',
    kind: 'basic',
    authFlow: 'manual',
    reach: 'openapi',
    scopes: { read: [], write: [{ key: 'sms.send', label: 'Send SMS', scopes: [] }] },
    refreshable: false,
    defaultScopes: [],
    consumerNodes: ['core.openwop.integration'],
    // messaging.twilio.com (ADR 0394 P3) — the WhatsApp Senders health read
    // (quality rating / messaging tier); same credential, still Twilio-pinned.
    apiHosts: ['api.twilio.com', 'messaging.twilio.com'],
    openapiRef: 'https://www.twilio.com/docs/sms/api',
    docsUrl: 'https://www.twilio.com/docs',
  },
  {
    // ADR 0394 Phase 4 — WhatsApp via the Meta Cloud API DIRECT (the margin
    // path once the channel is proven on Twilio BSP). Bearer = a WABA
    // system-user token. GOVERNED write (ADR 0292): `adapterOnly` + zero
    // consumer nodes — the ONLY reach is the whatsapp feature's gated send
    // service (consent + 24h window + template discipline + idempotency);
    // the generic http node can never carry the token.
    id: 'whatsapp-cloud',
    label: 'WhatsApp Cloud API (Meta)',
    vendor: 'Meta',
    kind: 'bearer',
    authFlow: 'manual',
    reach: 'openapi',
    scopes: { read: [], write: [{ key: 'whatsapp.send', label: 'Send WhatsApp messages', scopes: [] }] },
    refreshable: false,
    defaultScopes: [],
    consumerNodes: [],
    adapterOnly: true,
    apiHosts: ['graph.facebook.com'],
    openapiRef: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
  },
  {
    // ADR 0024 §4 — push-notification provider. api_key sent as Bearer. The v1
    // ctx.notification.push consumer.
    id: 'expo',
    label: 'Expo Push',
    kind: 'api_key',
    authFlow: 'manual',
    reach: 'openapi',
    scopes: { read: [], write: [{ key: 'push.send', label: 'Send push', scopes: [] }] },
    refreshable: false,
    defaultScopes: [],
    consumerNodes: ['core.openwop.integration'],
    apiHosts: ['exp.host'],
    openapiRef: 'https://docs.expo.dev/push-notifications/sending-notifications/',
    docsUrl: 'https://docs.expo.dev',
  },
  {
    // ADR 0076 — BigQuery, READ-ONLY. A dedicated provider (not the `google`
    // provider) for two reasons: (1) `google` is overridable by a connection pack
    // and `registerProvider` REPLACES — a pack override strips `apiHosts`
    // (toProviderManifest never sets it), which would silently break egress; a
    // dedicated `bigquery` id no pack declares is override-immune. (2) A narrow,
    // read-only-scoped connection is a better "read-only service identity" than a
    // broad Google connection. There is deliberately NO write scope group.
    id: 'bigquery',
    label: 'Google BigQuery',
    kind: 'oauth2',
    authFlow: 'pkce',
    reach: 'openapi',
    readOnly: true, // ADR 0076 P3 — read scope only; host gate denies PUT/PATCH/DELETE.
    scopes: {
      read: [{ key: 'query', label: 'Run read-only queries', scopes: ['https://www.googleapis.com/auth/bigquery.readonly'] }],
    },
    ...GOOGLE_AUTHORIZATION_SERVER,
    endpoints: {
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      revoke: 'https://oauth2.googleapis.com/revoke',
    },
    refreshable: true,
    defaultScopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
    consumerNodes: ['core.bigquery.query'],
    apiHosts: ['bigquery.googleapis.com'],
    openapiRef: 'https://cloud.google.com/bigquery/docs/reference/rest',
    docsUrl: 'https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query',
  },
  {
    // ADR 0266 / CDP-D — the WRITE-scoped BigQuery identity for reverse-ETL
    // warehouse LOADS (a warehouse-load node inserts rows). Deliberately a SEPARATE
    // provider id from `bigquery` (which STAYS read-only + override-immune, ADR 0076)
    // — adding this does NOT loosen `bigquery`'s invariant. GOVERNANCE: the write
    // scope is offerable, not granted; the acting human must explicitly consent
    // ("grant write"), and a warehouse-load action rides the connector-action-
    // governance gate (ADR 0028). Not `readOnly` → the host gate permits the POST.
    id: 'bigquery-write',
    label: 'Google BigQuery (write)',
    kind: 'oauth2',
    authFlow: 'pkce',
    reach: 'openapi',
    scopes: {
      read: [{ key: 'query', label: 'Run queries', scopes: ['https://www.googleapis.com/auth/bigquery.readonly'] }],
      write: [{ key: 'insertdata', label: 'Insert rows (reverse-ETL load)', scopes: ['https://www.googleapis.com/auth/bigquery.insertdata'] }],
    },
    ...GOOGLE_AUTHORIZATION_SERVER,
    endpoints: {
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      revoke: 'https://oauth2.googleapis.com/revoke',
    },
    refreshable: true,
    defaultScopes: ['https://www.googleapis.com/auth/bigquery.insertdata'],
    apiHosts: ['bigquery.googleapis.com'],
    openapiRef: 'https://cloud.google.com/bigquery/docs/reference/rest',
    docsUrl: 'https://cloud.google.com/bigquery/docs/reference/rest/v2/tabledata/insertAll',
    // ADR 0292 — GOVERNED write: reachable ONLY via the destination-sync warehouse-load
    // adapter's `brokeredPost` (approval-gated), NEVER the generic `core.openwop.http.fetch`
    // (`ctx.http.safeFetch` skips `adapterOnly` providers). So the ADR 0028 approval gate is
    // un-bypassable — an opted-in run cannot POST `insertAll` ungated through the http node.
    adapterOnly: true,
    consumerNodes: ['core.openwop.integration'],
  },
  {
    // ADR 0306 (ADR 0305 Phase G) — GitHub PUBLISH, for the app-builder publish
    // route (repo-create + create-only content pushes via `brokeredFetch`).
    // A NARROW identity distinct from the broad `github` example connection
    // pack (OAuth2/MCP, examples/connection-packs/github) — the SAME deliberate
    // coexistence as `microsoft365` (broad pack) vs `microsoft-graph` (narrow,
    // apiHosts-pinned): the pack serves MCP tooling; this builtin serves ONE
    // host-pinned write path. Bearer = a fine-grained PAT the user pastes
    // (day-1-honest — an OAuth app would need operator client-id provisioning;
    // PKCE is a recorded ADR 0306 follow-on).
    //
    // GOVERNED write, the ADR 0292 posture: `adapterOnly` means the generic
    // `core.openwop.http.fetch` node can NEVER carry this token (the injection
    // matcher skips adapterOnly manifests — test-pinned), and with NO consumer
    // nodes there is no run-initiated path at all: the ONLY reach is the
    // feature's own publish route, behind the `code-publish` toggle +
    // workspace:write + the user's consented write scope. This supersedes the
    // ADR 0190:95 GitHub-writes deferral gate.
    id: 'github-publish',
    label: 'GitHub (publish)',
    kind: 'bearer',
    authFlow: 'manual',
    reach: 'openapi',
    scopes: {
      read: [],
      write: [{ key: 'repo.push', label: 'Create repositories + push content', scopes: ['contents:write'] }],
    },
    refreshable: false,
    defaultScopes: [],
    consumerNodes: [],
    apiHosts: ['api.github.com'],
    adapterOnly: true,
    openapiRef: 'https://docs.github.com/en/rest',
    docsUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
  },
  {
    // ADR 0076 P2 — Microsoft Graph, for the `core.email.draft` node (creates a
    // DRAFT in Outlook, NEVER sends). A dedicated builtin (not the broad
    // `microsoft365` pack, which carries no `apiHosts` → fails closed at
    // brokeredFetch) — same override-immunity + narrow-identity rationale as
    // `bigquery`. The two coexist intentionally: `microsoft365` (broad pack) vs
    // `microsoft-graph` (narrow, apiHosts-pinned connector identity).
    //
    // Scope honesty: `Mail.ReadWrite` is a draft-only WRITE scope; `Mail.Send`
    // (ADR 0193 Phase 2) is a SEPARATE write-scope group the acting human must
    // grant explicitly ("grant write") to enable `core.email.send`. Drafting
    // (`core.email.draft`) requests only `Mail.ReadWrite` and can never send;
    // sending requires the distinct `Mail.Send` consent + the mandatory approval
    // interrupt. Offerable != granted — the manifest declares the scope; the
    // user consents to it only for a send workflow.
    id: 'microsoft-graph',
    label: 'Microsoft Graph (mail + files)',
    kind: 'oauth2',
    authFlow: 'pkce',
    reach: 'openapi',
    scopes: {
      // ADR 0107 — `Files.Read` (READ-only) lets knowledge-sync list + read OneDrive
      // folders/files via Graph. Read scope, never a write/Files.ReadWrite.
      read: [
        { key: 'files.read', label: 'OneDrive files (read)', scopes: ['https://graph.microsoft.com/Files.Read'] },
        // ADR 0107 — SharePoint document libraries (read-only) for knowledge-sync.
        { key: 'sites.read', label: 'SharePoint sites (read)', scopes: ['https://graph.microsoft.com/Sites.Read.All'] },
      ],
      write: [
        { key: 'mail.readwrite', label: 'Outlook mail — create drafts (never send)', scopes: ['https://graph.microsoft.com/Mail.ReadWrite'] },
        { key: 'mail.send', label: 'Outlook mail — send as you (ADR 0193)', scopes: ['https://graph.microsoft.com/Mail.Send'] },
      ],
    },
    endpoints: {
      authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    },
    refreshable: true,
    defaultScopes: ['https://graph.microsoft.com/Mail.ReadWrite', 'offline_access'],
    consumerNodes: ['core.email.draft', 'core.email.send'],
    apiHosts: ['graph.microsoft.com'],
    openapiRef: 'https://learn.microsoft.com/en-us/graph/api/user-post-messages',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/user-post-messages',
  },
  {
    // ADR 0081 P6 — Gmail, the `core.email.draft` SIBLING of `microsoft-graph`.
    // Creates a DRAFT via the Gmail API (users/me/drafts), NEVER sends. A dedicated
    // narrow builtin pinned to gmail.googleapis.com (not the broad `google` pack,
    // whose googleapis.com pin + read defaults don't fit a draft-write identity) —
    // same override-immunity + narrow-identity rationale as `microsoft-graph`.
    //
    // Never-send honesty (IMPORTANT — differs from Graph): Gmail has NO scope that
    // permits draft creation while forbidding send (`gmail.compose` is the narrowest
    // draft-write scope and technically also allows send; there is no `Mail.ReadWrite`
    // analog). So unlike Graph (scope AND endpoint), Gmail's never-send guarantee is
    // enforced ONLY BY CONSTRUCTION: the node only ever builds the fixed drafts.create
    // URL, never a send endpoint. The scope is the narrowest available, not the guard.
    // Scheduled/unattended Gmail drafting would need SA-JWT generalized to a gmail
    // scope (P2's mint is BigQuery-only) — out of scope; the anniversary draft runs
    // human-acting to an approval gate, so interactive PKCE is the baseline.
    id: 'gmail',
    label: 'Gmail (mail draft)',
    kind: 'oauth2',
    authFlow: 'pkce',
    reach: 'openapi',
    scopes: {
      read: [],
      // Honesty (ADR 0193 Phase 2): `gmail.compose` is the narrowest Gmail draft-write
      // scope AND it technically permits send (Google has no draft-only scope). The
      // `core.email.draft` node never sends BY CONSTRUCTION; the `core.email.send` node
      // (which shares this connector) CAN send with this scope, gated by its mandatory
      // approval interrupt — so the label no longer claims the connector "never sends".
      write: [{ key: 'gmail.compose', label: 'Gmail — create drafts + send (send needs per-message approval)', scopes: ['https://www.googleapis.com/auth/gmail.compose'] }],
    },
    ...GOOGLE_AUTHORIZATION_SERVER,
    endpoints: {
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      revoke: 'https://oauth2.googleapis.com/revoke',
    },
    refreshable: true,
    defaultScopes: ['https://www.googleapis.com/auth/gmail.compose'],
    consumerNodes: ['core.email.draft', 'core.email.send'],
    apiHosts: ['gmail.googleapis.com'],
    openapiRef: 'https://developers.google.com/gmail/api/reference/rest/v1/users.drafts/create',
    docsUrl: 'https://developers.google.com/gmail/api/reference/rest/v1/users.drafts/create',
  },
  {
    // ADR 0082 — Workday, a dedicated narrow BUILTIN for the `core.workday.query` HCM source
    // node. The workday CONNECTION pack carries no `apiHosts` (→ fails closed at
    // brokeredFetch), so a real source needs this pinned builtin — same rationale as
    // bigquery/microsoft-graph/gmail. READ-ONLY: HCM/succession reads only, NO write scope
    // group (so it satisfies assertReadOnlyConsistent + the host gate denies writes).
    //
    // apiHosts pins the eTLD+1 (`workday.com`, `myworkday.com`); the per-tenant REST base +
    // OAuth endpoints (`https://{instance}.workday.com/ccx/...`) are tenant-specific and
    // supplied at connection time via the connection pack's `instanceUrlTemplate` (hence no
    // fixed `endpoints` here, mirroring the tenant-specific ServiceNow builtin). The pin
    // guarantees the node can only ever egress to *.workday.com.
    id: 'workday',
    label: 'Workday (HCM read)',
    kind: 'oauth2',
    authFlow: 'pkce',
    reach: 'openapi',
    readOnly: true, // ADR 0076 P3 pattern — read scope only; host gate denies PUT/PATCH/DELETE.
    scopes: {
      read: [{ key: 'integration', label: 'Integration (read worker/HCM data)', scopes: ['openid', 'offline_access'] }],
    },
    refreshable: true,
    defaultScopes: ['openid', 'offline_access'],
    consumerNodes: ['core.workday.query'],
    apiHosts: ['workday.com', 'myworkday.com'],
    openapiRef: 'https://community.workday.com/rest-api',
    docsUrl: 'https://community.workday.com/rest-api',
  },
  {
    // ADR 0107 — Dropbox as a knowledge-sync drive (read-only). RPC over
    // api.dropboxapi.com; content via a get_temporary_link → un-credentialed
    // SSRF-guarded fetch (its host is *.dropboxusercontent.com, NOT in apiHosts).
    id: 'dropbox',
    label: 'Dropbox',
    kind: 'oauth2',
    authFlow: 'pkce',
    reach: 'openapi',
    scopes: { read: [{ key: 'files.read', label: 'Dropbox files (read)', scopes: ['files.metadata.read', 'files.content.read'] }], write: [] },
    endpoints: { authorize: 'https://www.dropbox.com/oauth2/authorize', token: 'https://api.dropboxapi.com/oauth2/token' },
    refreshable: true,
    defaultScopes: ['files.metadata.read', 'files.content.read'],
    consumerNodes: ['core.openwop.http'],
    apiHosts: ['dropboxapi.com'], // api. + content.dropboxapi.com (subdomains)
    docsUrl: 'https://www.dropbox.com/developers/documentation/http/documentation',
  },
  {
    // ADR 0107 — Box as a knowledge-sync drive (read-only). REST over api.box.com;
    // file content is a 302 to dl.boxcloud.com — read the Location (redirect:'manual',
    // token stays on api.box.com) then fetch it un-credentialed + SSRF-guarded.
    id: 'box',
    label: 'Box',
    kind: 'oauth2',
    authFlow: 'pkce',
    reach: 'openapi',
    // Box grants file access via the app's configured scopes (Developer Console),
    // not granular authorize-URL scopes — so the read scope list is intentionally empty.
    scopes: { read: [{ key: 'files.read', label: 'Box files (read)', scopes: [] }], write: [] },
    endpoints: { authorize: 'https://account.box.com/api/oauth2/authorize', token: 'https://api.box.com/oauth2/token' },
    refreshable: true,
    defaultScopes: [],
    consumerNodes: ['core.openwop.http'],
    apiHosts: ['box.com'], // api.box.com (the boxcloud.com download host is fetched un-credentialed)
    docsUrl: 'https://developer.box.com/reference',
  },
  {
    // RFC 0127 / ADR 0286 — streaming & CDC INGRESS connection. A broker (Kafka /
    // Kinesis / Pub-Sub / EventBridge) or a warehouse change-data-capture feed PUSHES to
    // the signature-verified, admin-gated inbound webhook (inboundWebhooks.ts), which
    // dispatches each message/row to `ingestExternalEvent` → a NEW run (source `stream`/
    // `change`). INGRESS-ONLY: no write scope group + `readOnly` — there is NO outbound
    // publish path here (that is core.openwop.messaging's job, ARCHITECTURE.md:438). The
    // credential brokered is the per-connection push-verification signing secret (held
    // host-side via the BYOK envelope, ADR 0024 §6); `reach:'openapi'` is a no-fetch
    // placeholder (this provider has no outbound binding at all).
    id: 'core.openwop.streams',
    label: 'Streaming & CDC (ingress)',
    kind: 'api_key',
    authFlow: 'manual',
    reach: 'openapi',
    scopes: { read: [{ key: 'ingest', label: 'Consume broker messages / CDC rows (ingress-only)', scopes: [] }] },
    refreshable: false,
    defaultScopes: [],
    consumerNodes: [],
    readOnly: true,
    docsUrl: 'https://openwop.dev/spec/v1/trigger-bridge',
  },
];

/** ADR 0076 P3 — a `readOnly` provider MUST NOT declare a write scope group (that would
 *  defeat the primary control). Pure validator: asserted over BUILTIN at load + in tests.
 *  NOT thrown from `registerProvider` (the marketplace override hook stays permissive). */
export function assertReadOnlyConsistent(m: ProviderManifest): void {
  if (m.readOnly && (m.scopes.write?.length ?? 0) > 0) {
    throw new Error(`provider '${m.id}': readOnly providers MUST NOT declare a write scope group`);
  }
}
BUILTIN.forEach(assertReadOnlyConsistent);

// Capability categories for the built-in providers (mirrors the connection-pack
// manifest `category` enum). Lets a workflow/agent bind by capability
// (email-calendar / communication / hr / …) → the user's configured provider.
const BUILTIN_CATEGORY: Readonly<Record<string, string>> = {
  google: 'email-calendar', gmail: 'email-calendar', 'microsoft-graph': 'email-calendar',
  sendgrid: 'email-calendar', slack: 'communication', zoom: 'communication',
  twilio: 'communication', expo: 'communication', bigquery: 'data-warehouse',
  workday: 'hr', dropbox: 'storage', box: 'storage', servicenow: 'ticketing',
  'core.openwop.streams': 'streaming',
  'zoom-webinar': 'marketing', // ADR 0404 — the webinar connector
  heygen: 'creative', // ADR 0404 — AI avatar video
  runway: 'creative', // ADR 0404 §P4 — frontier text-to-video
};
for (const m of BUILTIN) { const cat = BUILTIN_CATEGORY[m.id]; if (cat) m.category = cat; }

// Commercial vendor/ecosystem for the built-in providers. Groups the catalog so a
// company picks connectors by the vendors it uses (all Google surfaces under
// "Google", Outlook/Graph under "Microsoft 365", …). Presentational + host-only —
// NOT the auth key. A provider with no mapping groups under its own label.
const BUILTIN_VENDOR: Readonly<Record<string, string>> = {
  google: 'Google', gmail: 'Google', bigquery: 'Google', 'bigquery-write': 'Google',
  'microsoft-graph': 'Microsoft 365',
  workday: 'Workday', servicenow: 'ServiceNow', slack: 'Slack', zoom: 'Zoom', 'zoom-webinar': 'Zoom', heygen: 'HeyGen', runway: 'Runway',
  sendgrid: 'SendGrid', twilio: 'Twilio', expo: 'Expo', dropbox: 'Dropbox', box: 'Box',
  postmark: 'Postmark',
  // ADR 0306 GitHub-publish connector — groups under GitHub (added when the ADR
  // 0185 "nothing ungrouped" guard caught it missing after the app-builder program).
  'github-publish': 'GitHub',
  // Vendor-neutral protocol transport (ADR 0201 smtp) — groups under its own
  // label; added when the ADR 0185 "nothing ungrouped" guard caught it missing.
  smtp: 'SMTP',
  // RFC 0127 ingress connection — vendor-neutral protocol transport (Kafka/Kinesis/
  // Pub-Sub/CDC), groups under the OpenWOP core label.
  'core.openwop.streams': 'OpenWOP',
};
for (const m of BUILTIN) { const v = BUILTIN_VENDOR[m.id]; if (v) m.vendor = v; }

const registry = new Map<string, ProviderManifest>(BUILTIN.map((m) => [m.id, m]));

export function listProviders(): ProviderManifest[] {
  return [...registry.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function getProvider(id: string): ProviderManifest | null {
  return registry.get(id) ?? null;
}

/** Register/override a manifest (the Marketplace install hook, ADR 0022). */
export function registerProvider(manifest: ProviderManifest): void {
  registry.set(manifest.id, manifest);
}
