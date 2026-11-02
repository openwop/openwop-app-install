/**
 * ADR 0127 Phase 4 — chat-widget admin client. Provision / list / rotate-token /
 * delete the org's embeddable widgets (authed admin CRUD; the PUBLIC runtime is the
 * separate origin-gated gateway). Org-scoped, admin (workspace:read/write).
 */
import { authedHeaders, config, fetchOpts } from './config.js';

/** The server's error with the FIELD it named, so the console can say what was wrong in
 *  the user's language instead of splicing the server's English (grade-ux CW68U-19). */
export class WidgetApiError extends Error {
  constructor(message: string, readonly field?: string, readonly entry?: string, readonly code?: string) { super(message); this.name = 'WidgetApiError'; }
}

/** ADR 1018 D8 — the server refused because the workspace has no model key of its own
 *  (the platform's managed key serves superadmin workspaces only). */
export const isWidgetByokRequired = (err: unknown): boolean => err instanceof WidgetApiError && err.code === 'widget_byok_required';

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string; details?: { field?: unknown; entry?: unknown; code?: unknown } };
    throw new WidgetApiError(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`,
      typeof err.details?.field === 'string' ? err.details.field : undefined,
      typeof err.details?.entry === 'string' ? err.details.entry : undefined,
      typeof err.details?.code === 'string' ? err.details.code : undefined);
  }
  return body as T;
}

export interface Org { orgId: string; name: string }
export interface WidgetCaps { maxTurnsPerSession?: number; maxSessionsPerDay?: number; maxWritesPerDay?: number; maxAutoWritesPerSession?: number }
/** RFC 0132 §C — the anonymous-actor tool grant an operator authors per widget. Both
 *  write controls are honored (ADR 0469): `hitl` (held for approval) and
 *  `rate-limit-session-cap` (auto-run under a per-session cap — requires
 *  `caps.maxAutoWritesPerSession`; only for pure tenant-write surfaces). */
export type AnonWriteControl = 'hitl' | 'rate-limit-session-cap';
export interface WidgetAnonToolGrant { read?: string[]; write?: string[]; writeControl?: AnonWriteControl; egressAudiences?: string[] }
export interface Widget { widgetId: string; agentId: string; allowedDomains: string[]; caps: WidgetCaps; anonToolGrant?: WidgetAnonToolGrant; businessName?: string; privacyUrl?: string; token: string; enabled: boolean }

export async function listOrgs(): Promise<Org[]> {
  return (await http<{ orgs: Org[] }>('/host/openwop-app/orgs')).orgs ?? [];
}

const BASE = (orgId: string): string => `/host/openwop-app/chat-widget/orgs/${encodeURIComponent(orgId)}/widgets`;

export async function listWidgets(orgId: string): Promise<Widget[]> {
  return (await http<{ widgets: Widget[] }>(BASE(orgId))).widgets ?? [];
}
export async function provisionWidget(orgId: string, input: { agentId: string; allowedDomains: string[] }): Promise<Widget> {
  return (await http<{ widget: Widget }>(BASE(orgId), { method: 'POST', body: JSON.stringify(input) })).widget;
}
export async function rotateWidgetToken(orgId: string, widgetId: string): Promise<Widget> {
  return (await http<{ widget: Widget }>(`${BASE(orgId)}/${encodeURIComponent(widgetId)}/rotate-token`, { method: 'POST' })).widget;
}
/** ADR 0469 Phase B — save the widget's caps + anon tool grant. `anonToolGrant: null`
 *  clears the grant (returns the widget to the no-tools runless dispatch). */
export async function patchWidget(orgId: string, widgetId: string, patch: { caps?: WidgetCaps; anonToolGrant?: WidgetAnonToolGrant | null; businessName?: string | null; privacyUrl?: string | null; enabled?: boolean }): Promise<Widget> {
  return (await http<{ widget: Widget }>(`${BASE(orgId)}/${encodeURIComponent(widgetId)}`, { method: 'PATCH', body: JSON.stringify(patch) })).widget;
}
/** ADR 0469 Phase B — the workspace-scoped tool catalog (the SAME SSoT the grant
 *  editor offers). `workspace:read`; the SAVE is `workspace:write` via patchWidget. */
export async function getToolCatalog(orgId: string): Promise<string[]> {
  return (await http<{ tools: string[] }>(`/host/openwop-app/chat-widget/orgs/${encodeURIComponent(orgId)}/tool-catalog`)).tools ?? [];
}
/** ADR 1018 D3 — what visitors asked a widget (operator read; `workspace:write`). */
export interface ConversationSummary { threadId: string; startedAt: string; updatedAt: string; messageCount: number; preview: string }
export interface ConversationMessage { role: 'visitor' | 'agent'; text: string; at: string }
export interface Conversation { threadId: string; startedAt: string; updatedAt: string; messages: ConversationMessage[] }
const CONV = (orgId: string, widgetId: string): string => `${BASE(orgId)}/${encodeURIComponent(widgetId)}/conversations`;
export async function listConversations(orgId: string, widgetId: string): Promise<ConversationSummary[]> {
  return (await http<{ conversations: ConversationSummary[] }>(CONV(orgId, widgetId))).conversations ?? [];
}
export async function getConversation(orgId: string, widgetId: string, threadId: string): Promise<Conversation> {
  return (await http<{ conversation: Conversation }>(`${CONV(orgId, widgetId)}/${encodeURIComponent(threadId)}`)).conversation;
}
export async function deleteConversation(orgId: string, widgetId: string, threadId: string): Promise<void> {
  await http(`${CONV(orgId, widgetId)}/${encodeURIComponent(threadId)}`, { method: 'DELETE' });
}

export async function deleteWidget(orgId: string, widgetId: string): Promise<void> {
  await http(`${BASE(orgId)}/${encodeURIComponent(widgetId)}`, { method: 'DELETE' });
}

/** ADR 1018 D1 — the ABSOLUTE public origin + base the embed is served from.
 *
 *  The snippet is pasted on a CUSTOMER's site, so its `src` must name this backend
 *  absolutely. Production's `config.baseUrl` is the relative `/api` (the Hosting
 *  rewrite), and a relative `src` resolves against the customer's origin and 404s:
 *  every snippet the console handed out before this fix was dead (`CW68WF-1`; 0
 *  requests to the public widget routes in 30 days of logs). Resolving the base
 *  against the console's own origin is correct by construction: the console only
 *  loads where its base reaches the backend. An absolute base is unchanged. */
export function embedScriptUrl(baseUrl: string, pageOrigin: string): string {
  const base = new URL(baseUrl, pageOrigin).toString().replace(/\/+$/, '');
  return `${base}/host/openwop-app/public/widget/embed.js`;
}

/** The paste-ready embed snippet for a widget (the public embed.js + the token). */
export function embedSnippet(token: string, pageOrigin: string = window.location.origin): string {
  return `<script src="${embedScriptUrl(config.baseUrl, pageOrigin)}" data-token="${token}"></script>`;
}
