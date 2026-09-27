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

export interface WidgetCaps { maxTurnsPerSession?: number; maxSessionsPerDay?: number; maxWritesPerDay?: number; maxAutoWritesPerSession?: number }

/** RFC 0132 §C — the per-surface anonymous-actor tool grant. Absent/empty ⇒ the
 *  widget runs today's runless, NO-tools single-turn dispatch. Present + non-empty
 *  (AND `OPENWOP_ANON_ACTOR_ENABLED`) ⇒ the widget dispatches an anonymous tool turn
 *  over EXACTLY these tools (default-deny — never the ADR 0315 baseline). `read`
 *  tools are tenant-scoped/no-secret; `write` tools are bounded-write-egress and run
 *  ONLY behind `writeControl` (this host wires `hitl`) — an uncontrolled write is
 *  denied. `egressAudiences` binds any egress destination (§C.3). */
export interface WidgetAnonToolGrant {
  read?: string[];
  write?: string[];
  writeControl?: 'hitl' | 'rate-limit-session-cap';
  egressAudiences?: string[];
}

export interface WidgetConfig {
  widgetId: string;
  tenantId: string;
  orgId: string;
  agentId: string;
  /** MANDATORY non-empty domain allowlist — a widget with no allowed domains can
   *  never serve (default-deny). Enforced at the public gateway (Phase 2). */
  allowedDomains: string[];
  caps: WidgetCaps;
  /** RFC 0132 §C — the optional anonymous-actor read-tier tool grant (default-deny). */
  anonToolGrant?: WidgetAnonToolGrant;
  /** ADR 0470 OQ5 — the operator's display name, shown in the public widget's
   *  disclosure line ("<businessName> AI assistant …"). Plain text (rendered via
   *  textContent — XSS-safe). */
  businessName?: string;
  /** ADR 0470 OQ5 — the operator's privacy-policy URL, rendered as the notice-at-
   *  collection LINK in the PUBLIC widget on visitors' browsers. VALIDATED http/https
   *  ONLY (`cleanUrl`) — a `javascript:`/`data:` URL here is a stored-XSS vector. */
  privacyUrl?: string;
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

/** ADR 0470 OQ5 — validate an operator-set privacy URL that will be rendered as an
 *  `<a href>` in the PUBLIC widget. HTTP/HTTPS ONLY — reject `javascript:`/`data:`/any
 *  other scheme (stored-XSS defense; the client re-checks defensively). Empty/invalid
 *  ⇒ undefined (no link rendered). `null` ⇒ undefined (explicit clear). */
function cleanUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new OpenwopError('validation_error', '`privacyUrl` must be an http(s) URL.', 400, { field: 'privacyUrl' });
    }
    return u.toString();
  } catch (err) {
    if (err instanceof OpenwopError) throw err;
    throw new OpenwopError('validation_error', '`privacyUrl` must be a valid http(s) URL.', 400, { field: 'privacyUrl' });
  }
}

/** ADR 0470 OQ5 — the operator display name (plain text, textContent-rendered). */
function cleanName(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : undefined;
}

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
  // ADR 0469 A3 — anon write/egress cap: the per-day ceiling on HELD writes a
  // widget's visitors can queue for operator review (anti-flood — gates approval
  // CREATION). Unset ⇒ uncapped (but the tier is off by default anyway).
  if (typeof c.maxWritesPerDay === 'number' && c.maxWritesPerDay > 0) caps.maxWritesPerDay = Math.floor(c.maxWritesPerDay);
  // ADR 0469 Phase D — the per-session cap that bounds the `rate-limit-session-cap`
  // auto-write control. Required by that control (a bound-less auto control is the
  // fail-open shape the RFC forbids); enforced cross-field below.
  if (typeof c.maxAutoWritesPerSession === 'number' && c.maxAutoWritesPerSession > 0) caps.maxAutoWritesPerSession = Math.floor(c.maxAutoWritesPerSession);
  return caps;
}

/** Normalize a tool-id list from operator input: trimmed, non-empty, deduped, capped. */
function cleanGrantTools(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    throw new OpenwopError('validation_error', `\`anonToolGrant.${field}\` must be an array of tool ids.`, 400, { field: `anonToolGrant.${field}` });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== 'string') continue;
    const id = t.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(0, 50);
}

/** RFC 0132 §C — validate + normalize the optional anon grant. A grant with NO tools
 *  is DROPPED (returns undefined ⇒ default-deny, no anon tool path). A `write` grant
 *  MUST carry a `writeControl` (the mandatory §C.3 control) — an uncontrolled write
 *  grant is rejected at config time (a control-less write tier is the fail-open shape
 *  the RFC forbids). */
function cleanAnonGrant(v: unknown): WidgetAnonToolGrant | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const g = v as { read?: unknown; write?: unknown; writeControl?: unknown; egressAudiences?: unknown };
  const read = cleanGrantTools(g.read, 'read');
  const write = cleanGrantTools(g.write, 'write');
  if (read.length === 0 && write.length === 0) return undefined;
  const grant: WidgetAnonToolGrant = {};
  if (read.length > 0) grant.read = read;
  if (write.length > 0) {
    if (g.writeControl !== 'hitl' && g.writeControl !== 'rate-limit-session-cap') {
      throw new OpenwopError('validation_error', '`anonToolGrant.write` requires a `writeControl` ("hitl" or "rate-limit-session-cap") — an uncontrolled anon write is forbidden (RFC 0132 §C.3).', 400, { field: 'anonToolGrant.writeControl' });
    }
    grant.write = write;
    grant.writeControl = g.writeControl;
    const audiences = cleanGrantTools(g.egressAudiences, 'egressAudiences');
    if (audiences.length > 0) grant.egressAudiences = audiences;
  }
  return grant;
}

/** ADR 0469 Phase D — a `rate-limit-session-cap` write grant AUTO-EXECUTES writes
 *  under a per-session bound; a control with no bound is the fail-open shape the RFC
 *  forbids, so `caps.maxAutoWritesPerSession` is MANDATORY for that control. Cross-field
 *  (grant.writeControl × caps) — validated on the assembled widget in both write paths. */
function assertControlCapsCoherent(caps: WidgetCaps, grant: WidgetAnonToolGrant | undefined): void {
  if (grant?.writeControl === 'rate-limit-session-cap' && !(typeof caps.maxAutoWritesPerSession === 'number' && caps.maxAutoWritesPerSession > 0)) {
    throw new OpenwopError('validation_error', 'The "rate-limit-session-cap" write control requires `caps.maxAutoWritesPerSession` (a positive per-session limit) — an unbounded auto-run control is forbidden (RFC 0132 §C.3).', 400, { field: 'caps.maxAutoWritesPerSession' });
  }
}

export interface WidgetInput { agentId?: unknown; allowedDomains?: unknown; caps?: unknown; anonToolGrant?: unknown; businessName?: unknown; privacyUrl?: unknown }

export async function provisionWidget(tenantId: string, orgId: string, actor: string, input: WidgetInput): Promise<WidgetConfig> {
  if (typeof input.agentId !== 'string' || input.agentId.trim().length === 0) {
    throw new OpenwopError('validation_error', '`agentId` is required.', 400, { field: 'agentId' });
  }
  const now = new Date().toISOString();
  const anonToolGrant = cleanAnonGrant(input.anonToolGrant);
  const caps = cleanCaps(input.caps);
  assertControlCapsCoherent(caps, anonToolGrant);
  const businessName = cleanName(input.businessName);
  const privacyUrl = cleanUrl(input.privacyUrl);
  const w: WidgetConfig = {
    widgetId: randomUUID(), tenantId, orgId, agentId: input.agentId.trim(),
    allowedDomains: cleanDomains(input.allowedDomains), caps,
    ...(anonToolGrant ? { anonToolGrant } : {}),
    ...(businessName ? { businessName } : {}),
    ...(privacyUrl ? { privacyUrl } : {}),
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
  // RFC 0132 §C — `null` explicitly CLEARS the grant (back to default-deny); an
  // object re-validates; absent leaves it untouched.
  if (input.anonToolGrant === null) delete w.anonToolGrant;
  else if (input.anonToolGrant !== undefined) {
    const grant = cleanAnonGrant(input.anonToolGrant);
    if (grant) w.anonToolGrant = grant; else delete w.anonToolGrant;
  }
  // ADR 0470 OQ5 — `null` clears; a string re-validates (privacyUrl scheme-checked);
  // absent leaves untouched.
  if (input.businessName === null) delete w.businessName;
  else if (input.businessName !== undefined) { const n = cleanName(input.businessName); if (n) w.businessName = n; else delete w.businessName; }
  if (input.privacyUrl === null) delete w.privacyUrl;
  else if (input.privacyUrl !== undefined) { const u = cleanUrl(input.privacyUrl); if (u) w.privacyUrl = u; else delete w.privacyUrl; }
  if (typeof input.enabled === 'boolean') w.enabled = input.enabled;
  assertControlCapsCoherent(w.caps, w.anonToolGrant); // Phase D — cross-field on the merged widget
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

/**
 * ADR 0288 roster-lifecycle consumer (grade-data AGT-1) — DISABLE (never delete)
 * every public widget bound to a deleted roster member: a widget is a live
 * public credential, so serving must stop immediately, but the authored config
 * (domains/caps/token) survives visibly disabled for re-assignment. Matches
 * both id forms. Idempotent; bounded tenant-prefixed scan.
 */
export async function disableWidgetsForDeletedAgent(tenantId: string, ids: { rosterId: string; agentId?: string }): Promise<number> {
  let disabled = 0;
  for (const w of await widgets.listByPrefix(`${tenantId}:`)) {
    if (!w.enabled) continue;
    if (w.agentId !== ids.rosterId && w.agentId !== ids.agentId) continue;
    await widgets.put({ ...w, enabled: false, updatedAt: new Date().toISOString() });
    disabled += 1;
  }
  return disabled;
}

export async function deleteWidget(tenantId: string, orgId: string, widgetId: string): Promise<void> {
  const w = await mustGet(tenantId, orgId, widgetId);
  await widgets.delete(keyOf(w));
  await tokenIndex.delete(w.token).catch(() => undefined); // PUB-6
}

/**
 * ADR 0590 tenant-teardown pre-hook. The generic `purgeTenantHostExt` walk deletes
 * `chatwidget:config` (its key is `${tenantId}:…` and the row carries `tenantId`)
 * but cannot reach `chatwidget:tokenidx` — that pointer keys by the opaque
 * capability token with no tenant, so it orphaned on account deletion. This
 * pre-hook runs FIRST — while the tenant's widgets still resolve — and drops each
 * widget's token-index entry. `deleteWidget`/`rotateWidgetToken` already keep the
 * index in step on the normal paths, so this reaches only the tokens of widgets
 * that survive to account deletion. The `${tenantId}:` prefix (trailing colon)
 * is collision-safe: `org:foo` cannot match `org:foobar`.
 */
export async function purgeTenantWidgetTokens(tenantId: string): Promise<number> {
  let removed = 0;
  for (const w of await widgets.listByPrefix(`${tenantId}:`)) {
    if (await tokenIndex.delete(w.token)) removed += 1;
  }
  return removed;
}
