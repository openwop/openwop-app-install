/**
 * Analytics service (host-extension, ADR 0018) — the MEASURE leg. An APPEND-ONLY
 * event store fed by a public beacon + read-time aggregates. Does NOT re-implement
 * A/B — the host toggle/variant engine owns experiments; Analytics only reports.
 * The beacon is consent-gated through `consentService.isAllowed` (ADR 0020) — the
 * one consent rule, never a second copy.
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';

export type EventType = 'pageview' | 'event' | 'conversion';
export const EVENT_TYPES: readonly EventType[] = ['pageview', 'event', 'conversion'];

export interface Utm { source?: string; medium?: string; campaign?: string; term?: string; content?: string }
export interface ClickIds { fbclid?: string; gclid?: string; ttclid?: string; li_fat_id?: string }

export interface AnalyticsEvent {
  eventId: string;
  tenantId: string;
  orgId: string;
  type: EventType;
  path?: string;
  name?: string;
  ts: string;
  sessionKey?: string;
  referrer?: string;
  utm?: Utm;
  clickIds?: ClickIds;
  props?: Record<string, string | number | boolean>;
}

const MAX_STR = 1024;
const MAX_PROPS_CHARS = 4096;
const events = new DurableCollection<AnalyticsEvent>('analytics:event', (e) => e.eventId);

const cap = (v: unknown): string | undefined => (typeof v === 'string' && v ? v.slice(0, MAX_STR) : undefined);

function pick<T extends string>(v: unknown, keys: readonly T[]): Partial<Record<T, string>> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: Partial<Record<T, string>> = {};
  for (const k of keys) { const s = cap(o[k]); if (s) out[k] = s; }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pickProps(v: unknown): Record<string, string | number | boolean> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  if (JSON.stringify(v).length > MAX_PROPS_CHARS) throw new OpenwopError('validation_error', '`props` too large.', 413, {});
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val.slice(0, MAX_STR);
    else if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    else if (typeof val === 'boolean') out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Record one event (APPEND-ONLY); eventId/tenantId/orgId/ts are server-set. */
export async function recordEvent(input: { tenantId: string; orgId: string; raw: Record<string, unknown> }): Promise<AnalyticsEvent> {
  const r = input.raw;
  const e: AnalyticsEvent = {
    eventId: `evt:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    type: EVENT_TYPES.includes(r.type as EventType) ? (r.type as EventType) : 'event',
    ts: new Date().toISOString(),
  };
  const path = cap(r.path); if (path) e.path = path;
  const name = cap(r.name); if (name) e.name = name;
  const sessionKey = cap(r.sessionKey); if (sessionKey) e.sessionKey = sessionKey;
  const referrer = cap(r.referrer); if (referrer) e.referrer = referrer;
  const utm = pick(r.utm, ['source', 'medium', 'campaign', 'term', 'content'] as const); if (utm) e.utm = utm;
  const clickIds = pick(r.clickIds, ['fbclid', 'gclid', 'ttclid', 'li_fat_id'] as const); if (clickIds) e.clickIds = clickIds;
  const props = pickProps(r.props); if (props) e.props = props;
  await events.put(e);
  return e;
}

export async function listEvents(tenantId: string, orgId: string, limit = 100): Promise<AnalyticsEvent[]> {
  const all = await events.list();
  return all.filter((e) => e.tenantId === tenantId && e.orgId === orgId).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
}

export interface AnalyticsSummary {
  total: number;
  byType: Record<EventType, number>;
  sessions: number;
  topPaths: { path: string; count: number }[];
  utmSources: { source: string; count: number }[];
}

export async function summarize(tenantId: string, orgId: string): Promise<AnalyticsSummary> {
  const all = (await events.list()).filter((e) => e.tenantId === tenantId && e.orgId === orgId);
  const byType: Record<EventType, number> = { pageview: 0, event: 0, conversion: 0 };
  const paths = new Map<string, number>();
  const sources = new Map<string, number>();
  const sessions = new Set<string>();
  for (const e of all) {
    byType[e.type] += 1;
    if (e.sessionKey) sessions.add(e.sessionKey);
    if (e.type === 'pageview' && e.path) paths.set(e.path, (paths.get(e.path) ?? 0) + 1);
    const src = e.utm?.source; if (src) sources.set(src, (sources.get(src) ?? 0) + 1);
  }
  const topPaths = [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, count]) => ({ path, count }));
  const utmSources = [...sources.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([source, count]) => ({ source, count }));
  return { total: all.length, byType, sessions: sessions.size, topPaths, utmSources };
}

/** GDPR data-subject erasure: delete every event for a (tenant, sessionKey). The
 *  analytics `sessionKey` IS the consent `subjectKey`, so a consent erasure must
 *  purge these too. Returns the count removed. */
export async function deleteSubjectEvents(tenantId: string, sessionKey: string): Promise<number> {
  if (!sessionKey) return 0;
  const all = await events.list();
  let removed = 0;
  for (const e of all) {
    if (e.tenantId === tenantId && e.sessionKey === sessionKey) { await events.delete(e.eventId); removed += 1; }
  }
  return removed;
}

// Register the analytics purge handler so Consent's data-subject delete cascades
// here (the subject-erasure seam — ADR 0020 / 0018). Module-load once per process.
const analyticsEraser = async (tenantId: string, subjectKey: string): Promise<void> => { await deleteSubjectEvents(tenantId, subjectKey); };
registerSubjectEraser(analyticsEraser);

/** Test-only: clear the event store. */
export async function __resetAnalyticsStore(): Promise<void> { await events.__clear(); }
