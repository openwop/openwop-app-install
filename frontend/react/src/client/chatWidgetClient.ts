/**
 * ADR 0127 Phase 4 — chat-widget admin client. Provision / list / rotate-token /
 * delete the org's embeddable widgets (authed admin CRUD; the PUBLIC runtime is the
 * separate origin-gated gateway). Org-scoped, admin (workspace:read/write).
 */
import { authedHeaders, config, fetchOpts } from './config.js';

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
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
export async function patchWidget(orgId: string, widgetId: string, patch: { caps?: WidgetCaps; anonToolGrant?: WidgetAnonToolGrant | null; businessName?: string | null; privacyUrl?: string | null }): Promise<Widget> {
  return (await http<{ widget: Widget }>(`${BASE(orgId)}/${encodeURIComponent(widgetId)}`, { method: 'PATCH', body: JSON.stringify(patch) })).widget;
}
/** ADR 0469 Phase B — the workspace-scoped tool catalog (the SAME SSoT the grant
 *  editor offers). `workspace:read`; the SAVE is `workspace:write` via patchWidget. */
export async function getToolCatalog(orgId: string): Promise<string[]> {
  return (await http<{ tools: string[] }>(`/host/openwop-app/chat-widget/orgs/${encodeURIComponent(orgId)}/tool-catalog`)).tools ?? [];
}
export async function deleteWidget(orgId: string, widgetId: string): Promise<void> {
  await http(`${BASE(orgId)}/${encodeURIComponent(widgetId)}`, { method: 'DELETE' });
}

/** The paste-ready embed snippet for a widget (the public embed.js + the token). */
export function embedSnippet(token: string): string {
  return `<script src="${config.baseUrl}/host/openwop-app/public/widget/embed.js" data-token="${token}"></script>`;
}
