/**
 * Access hub summary (ADR 0864) — the client for `GET /access/summary` and the
 * pure projection from it to what the console draws: a status after each section
 * in the side menu, the summary cards, and the reconnect banner.
 *
 * A section the server omitted (the caller may not read it, or its read failed)
 * gets NO status here — never a "0". Absence on the wire stays absence on screen.
 */
import type { TFunction } from 'i18next';
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import type { HubScope } from '../../chrome/hubContext.js';
import type { KeyFigureItem } from '../../ui/KeyFigure.js';

export interface ConnectionCounts {
  count: number;
  needsReconnect: number;
  reconnect: { connectionId: string; displayName: string; provider: string }[];
}

export interface AccessSummary {
  keys?: { count: number };
  connections?: { workspace: ConnectionCounts; personal: ConnectionCounts };
  voice?: { on: boolean };
  apiKeys?: { count: number; expired: number };
  mcpClients?: { count: number };
  orgs?: { count: number; members: number };
  firewall?: { isDefault: boolean; rules: number };
  /** ADR 0866 — summed over the organizations the caller can read. */
  endpoints?: { count: number };
}

/** The summary, or `null` when it could not be read — the console then shows
 *  no statuses, cards or banner, and every section still works. */
export async function getAccessSummary(): Promise<AccessSummary | null> {
  try {
    const res = await fetch(`${config.baseUrl}/host/openwop-app/access/summary`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return body && typeof body === 'object' ? (body as AccessSummary) : null;
  } catch {
    return null;
  }
}

export interface TabStatus { meta: string; metaTone?: 'attention' }

export interface AccessSummaryView {
  /** Keyed by hub tab id. A tab with no entry shows no status. */
  status: Record<string, TabStatus>;
  /** Workspace scope only; each card's `key` is the tab it opens. */
  cards: KeyFigureItem[];
  banner: { title: string; body: string } | null;
}

/**
 * Project the summary for the tabs the caller can see in `scope`. Cards and the
 * banner only name sections whose tab is in `tabIds`, so nothing points at a
 * section the caller cannot open.
 */
export function accessSummaryView(
  summary: AccessSummary | null,
  scope: HubScope,
  tabIds: readonly string[],
  t: TFunction,
): AccessSummaryView {
  const view: AccessSummaryView = { status: {}, cards: [], banner: null };
  if (!summary) return view;
  const has = (id: string): boolean => tabIds.includes(id);
  const conns = summary.connections?.[scope === 'personal' ? 'personal' : 'workspace'];

  if (summary.keys) view.status.keys = { meta: String(summary.keys.count) };
  if (conns) {
    view.status.connections = conns.needsReconnect > 0
      ? { meta: t('access-hub:meta_issues', { count: conns.needsReconnect }), metaTone: 'attention' }
      : { meta: String(conns.count) };
  }
  if (summary.voice) view.status.voice = { meta: summary.voice.on ? t('access-hub:meta_on') : t('access-hub:meta_off') };
  if (summary.mcpClients) view.status.mcp = { meta: String(summary.mcpClients.count) };
  if (summary.apiKeys) {
    view.status['api-keys'] = summary.apiKeys.expired > 0
      ? { meta: t('access-hub:meta_expired', { count: summary.apiKeys.expired }), metaTone: 'attention' }
      : { meta: String(summary.apiKeys.count) };
  }
  if (summary.orgs) view.status.orgs = { meta: String(summary.orgs.count) };
  if (summary.endpoints) view.status.endpoints = { meta: String(summary.endpoints.count) };
  if (summary.firewall) {
    view.status['capability-firewall'] = {
      meta: summary.firewall.isDefault ? t('access-hub:meta_default') : t('access-hub:meta_rules', { count: summary.firewall.rules }),
    };
  }

  if (scope === 'workspace') {
    if (summary.keys && has('keys')) {
      const n = summary.keys.count;
      view.cards.push({ key: 'keys', label: t('access-hub:card_keys'), value: n, sub: n > 0 ? t('access-hub:card_keys_some') : t('access-hub:card_keys_none') });
    }
    if (conns && has('connections')) {
      view.cards.push(conns.needsReconnect > 0
        ? { key: 'connections', label: t('access-hub:card_connections'), value: conns.count, subTone: 'attention', sub: t('access-hub:card_connections_issues', { count: conns.needsReconnect }) }
        : { key: 'connections', label: t('access-hub:card_connections'), value: conns.count, sub: conns.count > 0 ? t('access-hub:card_connections_ok') : t('access-hub:card_connections_none') });
    }
    if (summary.mcpClients && has('mcp')) {
      const n = summary.mcpClients.count;
      view.cards.push({ key: 'mcp', label: t('access-hub:card_mcp'), value: n, sub: n > 0 ? t('access-hub:card_mcp_some') : t('access-hub:card_mcp_none') });
    }
    if (summary.orgs && has('orgs')) {
      view.cards.push({ key: 'orgs', label: t('access-hub:card_members'), value: summary.orgs.members, sub: t('access-hub:card_members_orgs', { count: summary.orgs.count }) });
    }
  }

  if (conns && conns.needsReconnect > 0 && has('connections')) {
    const [first] = conns.reconnect;
    view.banner = conns.needsReconnect === 1 && first
      ? { title: t('access-hub:banner_one_title', { name: first.displayName }), body: t('access-hub:banner_one_body') }
      : { title: t('access-hub:banner_many_title', { count: conns.needsReconnect }), body: t('access-hub:banner_many_body') };
  }
  return view;
}
