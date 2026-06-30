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
  /** reach==='mcp': the MCP server to register; reach==='openapi': the spec ref. */
  mcpServer?: { url: string; transport: 'http' | 'sse' };
  openapiRef?: string;
  docsUrl?: string;
}

/**
 * Built-in manifests. Google is `mcp` (push subscriptions for Drive/Gmail change
 * detection + server-side OAuth refresh — D1); ServiceNow/Zoom are `openapi`
 * (static API-key / S2S bearer REST); Slack is `mcp` (Events API + rich tools).
 */
const BUILTIN: ProviderManifest[] = [
  {
    id: 'google',
    label: 'Google Workspace',
    kind: 'oauth2',
    authFlow: 'pkce',
    reach: 'mcp',
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
    apiHosts: ['api.twilio.com'],
    openapiRef: 'https://www.twilio.com/docs/sms/api',
    docsUrl: 'https://www.twilio.com/docs',
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
    // ADR 0076 P2 — Microsoft Graph, for the `core.email.draft` node (creates a
    // DRAFT in Outlook, NEVER sends). A dedicated builtin (not the broad
    // `microsoft365` pack, which carries no `apiHosts` → fails closed at
    // brokeredFetch) — same override-immunity + narrow-identity rationale as
    // `bigquery`. The two coexist intentionally: `microsoft365` (broad pack) vs
    // `microsoft-graph` (narrow, apiHosts-pinned connector identity).
    //
    // Scope honesty: `Mail.ReadWrite` is a WRITE scope (creating a draft mutates
    // the mailbox) — but deliberately NOT `Mail.Send`. The node never calls a
    // send endpoint, so drafting can never become sending.
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
      write: [{ key: 'mail.readwrite', label: 'Outlook mail — create drafts (never send)', scopes: ['https://graph.microsoft.com/Mail.ReadWrite'] }],
    },
    endpoints: {
      authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    },
    refreshable: true,
    defaultScopes: ['https://graph.microsoft.com/Mail.ReadWrite', 'offline_access'],
    consumerNodes: ['core.email.draft'],
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
      write: [{ key: 'gmail.compose', label: 'Gmail — create drafts (node never calls send)', scopes: ['https://www.googleapis.com/auth/gmail.compose'] }],
    },
    endpoints: {
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      revoke: 'https://oauth2.googleapis.com/revoke',
    },
    refreshable: true,
    defaultScopes: ['https://www.googleapis.com/auth/gmail.compose'],
    consumerNodes: ['core.email.draft'],
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
