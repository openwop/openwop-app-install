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

export type CredentialKind = 'oauth2' | 'api_key' | 'bearer' | 'basic' | 'custom';
export type ProviderReach = 'mcp' | 'openapi';
export type AuthFlow = 'pkce' | 'client_credentials' | 'manual' | 'none';

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
];

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
