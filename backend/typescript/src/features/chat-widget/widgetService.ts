/**
 * Public embeddable chat widget (ADR 0127 Phase 1) — config + admin CRUD.
 *
 * A `WidgetConfig` provisions a public widget instance bound to an agent, with a
 * MANDATORY `allowedDomains` allowlist + per-session/day `caps` + an unguessable
 * capability `token`. This phase owns the authed admin config only — the PUBLIC
 * runtime gateway (Origin/Referer allowlist enforcement, cap enforcement, untrusted
 * visitor input) is Phase 2. Default-deny: a widget serves nothing until Phase 2 +
 * an explicit allowlist.
 *
 * @see docs/adr/0127-public-embeddable-chat-widget.md
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';

export interface WidgetCaps { maxTurnsPerSession?: number; maxSessionsPerDay?: number }

export interface WidgetConfig {
  widgetId: string;
  tenantId: string;
  orgId: string;
  agentId: string;
  /** MANDATORY non-empty domain allowlist — a widget with no allowed domains can
   *  never serve (default-deny). Enforced at the public gateway (Phase 2). */
  allowedDomains: string[];
  caps: WidgetCaps;
  /** Unguessable capability token (the public embed credential). Rotatable. */
  token: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const keyOf = (w: Pick<WidgetConfig, 'tenantId' | 'orgId' | 'widgetId'>): string => `${w.tenantId}:${w.orgId}:${w.widgetId}`;
const widgets = new DurableCollection<WidgetConfig>('chatwidget:config', keyOf);

// PUB-6: token → widget-key secondary index, so the UNAUTHENTICATED `resolveWidgetByToken`
// is an O(1) point lookup instead of a full `widgets.list()` scan on every public request
// (a DoS-amplifying load-path on an unauth endpoint). Maintained on mint/rotate/delete;
// existing un-indexed widgets fall back to a one-time scan that lazily backfills the index.
interface TokenIndexEntry { token: string; key: string }
const tokenIndex = new DurableCollection<TokenIndexEntry>('chatwidget:tokenidx', (t) => t.token);

const mintToken = (): string => `wgt_${randomBytes(24).toString('hex')}`;

function cleanDomains(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new OpenwopError('validation_error', '`allowedDomains` MUST be a non-empty array (default-deny).', 400, { field: 'allowedDomains' });
  }
  const out = v
    .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
    .map((d) => d.trim().toLowerCase())
    .slice(0, 50);
  if (out.length === 0) throw new OpenwopError('validation_error', '`allowedDomains` MUST contain at least one domain.', 400, { field: 'allowedDomains' });
  return out;
}

function cleanCaps(v: unknown): WidgetCaps {
  const c = (v ?? {}) as Record<string, unknown>;
  const caps: WidgetCaps = {};
  if (typeof c.maxTurnsPerSession === 'number' && c.maxTurnsPerSession > 0) caps.maxTurnsPerSession = Math.floor(c.maxTurnsPerSession);
  if (typeof c.maxSessionsPerDay === 'number' && c.maxSessionsPerDay > 0) caps.maxSessionsPerDay = Math.floor(c.maxSessionsPerDay);
  return caps;
}

export interface WidgetInput { agentId?: unknown; allowedDomains?: unknown; caps?: unknown }

export async function provisionWidget(tenantId: string, orgId: string, actor: string, input: WidgetInput): Promise<WidgetConfig> {
  if (typeof input.agentId !== 'string' || input.agentId.trim().length === 0) {
    throw new OpenwopError('validation_error', '`agentId` is required.', 400, { field: 'agentId' });
  }
  const now = new Date().toISOString();
  const w: WidgetConfig = {
    widgetId: randomUUID(), tenantId, orgId, agentId: input.agentId.trim(),
    allowedDomains: cleanDomains(input.allowedDomains), caps: cleanCaps(input.caps),
    token: mintToken(), enabled: true, createdBy: actor, createdAt: now, updatedAt: now,
  };
  await widgets.put(w);
  await tokenIndex.put({ token: w.token, key: keyOf(w) }); // PUB-6
  return w;
}

export async function listWidgets(tenantId: string, orgId: string): Promise<WidgetConfig[]> {
  return (await widgets.list()).filter((w) => w.tenantId === tenantId && w.orgId === orgId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getWidget(tenantId: string, orgId: string, widgetId: string): Promise<WidgetConfig | null> {
  return (await widgets.get(`${tenantId}:${orgId}:${widgetId}`)) ?? null;
}

async function mustGet(tenantId: string, orgId: string, widgetId: string): Promise<WidgetConfig> {
  const w = await getWidget(tenantId, orgId, widgetId);
  if (!w) throw new OpenwopError('not_found', 'Widget not found.', 404, { widgetId });
  return w;
}

export async function patchWidget(tenantId: string, orgId: string, widgetId: string, input: WidgetInput & { enabled?: unknown }): Promise<WidgetConfig> {
  const w = await mustGet(tenantId, orgId, widgetId);
  if (input.agentId !== undefined && typeof input.agentId === 'string' && input.agentId.trim()) w.agentId = input.agentId.trim();
  if (input.allowedDomains !== undefined) w.allowedDomains = cleanDomains(input.allowedDomains);
  if (input.caps !== undefined) w.caps = cleanCaps(input.caps);
  if (typeof input.enabled === 'boolean') w.enabled = input.enabled;
  w.updatedAt = new Date().toISOString();
  await widgets.put(w);
  return w;
}

/** ADR 0127 Phase 2b — resolve a widget by its PUBLIC capability token (the embed
 *  credential). Tenant is derived from the stored config, NEVER the request. Returns
 *  null for an unknown token or a disabled widget (the public gateway 404s either).
 *  A scan (no token index) — acceptable for an admin-provisioned, low-cardinality
 *  resource; the per-IP rate limit bounds abuse. */
export async function resolveWidgetByToken(token: string): Promise<WidgetConfig | null> {
  if (!token || !token.startsWith('wgt_')) return null;
  // PUB-6: index-first (O(1)); fall back to a one-time scan for an un-indexed (pre-PUB-6)
  // widget and lazily backfill the index so the scan happens at most once per such token.
  const idx = await tokenIndex.get(token);
  if (idx) {
    const w = await widgets.get(idx.key);
    if (w && w.token === token) return w.enabled ? w : null; // stale index entry → ignore
  }
  const scanned = (await widgets.list()).find((x) => x.token === token);
  if (!scanned) return null;
  await tokenIndex.put({ token, key: keyOf(scanned) }); // backfill
  return scanned.enabled ? scanned : null;
}

/** Rotate the capability token (invalidates every existing embed immediately). */
export async function rotateWidgetToken(tenantId: string, orgId: string, widgetId: string): Promise<WidgetConfig> {
  const w = await mustGet(tenantId, orgId, widgetId);
  const oldToken = w.token;
  w.token = mintToken();
  w.updatedAt = new Date().toISOString();
  await widgets.put(w);
  await tokenIndex.delete(oldToken).catch(() => undefined); // PUB-6: invalidate the old token mapping
  await tokenIndex.put({ token: w.token, key: keyOf(w) });
  return w;
}

export async function deleteWidget(tenantId: string, orgId: string, widgetId: string): Promise<void> {
  const w = await mustGet(tenantId, orgId, widgetId);
  await widgets.delete(keyOf(w));
  await tokenIndex.delete(w.token).catch(() => undefined); // PUB-6
}
