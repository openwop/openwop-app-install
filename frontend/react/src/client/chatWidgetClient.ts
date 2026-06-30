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
export interface WidgetCaps { maxTurnsPerSession?: number; maxSessionsPerDay?: number }
export interface Widget { widgetId: string; agentId: string; allowedDomains: string[]; caps: WidgetCaps; token: string; enabled: boolean }

export async function listOrgs(): Promise<Org[]> {
  return (await http<{ orgs: Org[] }>('/v1/host/openwop-app/orgs')).orgs ?? [];
}

const BASE = (orgId: string): string => `/v1/host/openwop-app/chat-widget/orgs/${encodeURIComponent(orgId)}/widgets`;

export async function listWidgets(orgId: string): Promise<Widget[]> {
  return (await http<{ widgets: Widget[] }>(BASE(orgId))).widgets ?? [];
}
export async function provisionWidget(orgId: string, input: { agentId: string; allowedDomains: string[] }): Promise<Widget> {
  return (await http<{ widget: Widget }>(BASE(orgId), { method: 'POST', body: JSON.stringify(input) })).widget;
}
export async function rotateWidgetToken(orgId: string, widgetId: string): Promise<Widget> {
  return (await http<{ widget: Widget }>(`${BASE(orgId)}/${encodeURIComponent(widgetId)}/rotate-token`, { method: 'POST' })).widget;
}
export async function deleteWidget(orgId: string, widgetId: string): Promise<void> {
  await http(`${BASE(orgId)}/${encodeURIComponent(widgetId)}`, { method: 'DELETE' });
}

/** The paste-ready embed snippet for a widget (the public embed.js + the token). */
export function embedSnippet(token: string): string {
  return `<script src="${config.baseUrl}/v1/host/openwop-app/public/widget/embed.js" data-token="${token}"></script>`;
}
