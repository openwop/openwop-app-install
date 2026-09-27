/**
 * CRM saved segments (ADR 0211 §2) — contacts-only v1.
 *
 * `DurableCollection('crm:segment')` rows carry a fixed filter vocabulary
 * (AND semantics; capped) and are EVALUATED AT READ over the live tenant
 * rolodex (`contactsService.listContacts`, which already excludes tombstoned
 * contacts) — no membership is ever materialized. This extends the email
 * feature's live-resolution audience doctrine instead of standing up a second
 * audience system.
 *
 * @see docs/adr/0211-crm-engagement-and-segments.md §2
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { listContacts, type Contact } from './contactsService.js';
import { assertUnderCap } from './crmEntitiesService.js';
import { contactPropensity } from './propensityService.js';
import { listEngagement } from '../email/engagementService.js';
import { changedFields, crmMutated, emitOptsOf, type CrmEmitOptions } from './emit.js';

const MAX = { name: 160, filters: 20, perTenantSegments: 200, valueLen: 200 } as const;

// ADR 0265 / CDP-C — `daysSince*` (recency) + `identifierCount` are CALCULATED
// traits computed at read from the contact itself (pure; no external store, so
// still replay-free per the ADR 0211 live-resolution doctrine).
// `emailClicks`/`emailOpens` (ADR 0265 / CDP-C) read the email engagement store —
// EVENT-based behavioral traits (async), computed once per resolve when referenced.
const ENGAGEMENT_FIELDS = new Set<string>(['emailClicks', 'emailOpens']);
const CALCULATED_FIELDS = new Set<string>(['daysSinceCreated', 'daysSinceUpdated', 'identifierCount', 'propensity', ...ENGAGEMENT_FIELDS]);
const KNOWN_FIELDS = new Set<string>(['stage', 'owner', 'company', 'lastTriageVariant', ...CALCULATED_FIELDS]);
export type SegmentOp = 'eq' | 'contains' | 'exists' | 'gt' | 'lt' | 'gte' | 'lte';
const OPS: readonly SegmentOp[] = ['eq', 'contains', 'exists', 'gt', 'lt', 'gte', 'lte'];
const NUMERIC_OPS: ReadonlySet<SegmentOp> = new Set(['gt', 'lt', 'gte', 'lte']);

/** `'stage' | 'owner' | 'company' | 'lastTriageVariant' | 'customFields.<key>'`
 *  — kept as a plain `string` (rather than a template-literal union) since the
 *  `<key>` half is tenant-authored and unbounded; `validateFilters` is the
 *  actual gate. */
export type SegmentField = string;

export interface SegmentFilter {
  field: SegmentField;
  op: SegmentOp;
  /** Required for `eq`/`contains`; omitted for `exists`. */
  value?: string;
}

export interface Segment {
  segmentId: string;
  tenantId: string;
  name: string;
  filters: SegmentFilter[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Opt-in (ADR 0267 / CDP-E): when true, the segment-entry daemon diffs this
   *  segment's membership each tick and emits `crm.segment.entered` per newly-
   *  entered contact (a journey trigger). Off by default — watching is O(members)
   *  per tick, so only flagged segments are diffed. */
  watchEntries?: boolean;
}

// CRMGAP-5: tenantOf arms the tenant secondary index — a bounded per-tenant
// scan instead of `list()`'s full-collection scan + in-memory filter.
const segments = new DurableCollection<Segment>('crm:segment', (s) => s.segmentId, undefined, (s) => s.tenantId);

function nowIso(): string {
  return new Date().toISOString();
}

/** `customFields.<key>` → `<key>`, or `null` when `field` isn't that shape. */
function customFieldKey(field: string): string | null {
  return field.startsWith('customFields.') ? field.slice('customFields.'.length) : null;
}

function validateFieldName(field: unknown): SegmentField {
  if (typeof field !== 'string' || field.length === 0) {
    throw new OpenwopError('validation_error', 'filter.field is required.', 400, { field: 'field' });
  }
  if (KNOWN_FIELDS.has(field)) return field;
  const key = customFieldKey(field);
  // A `customFields.<key>` field is allowed freely (ADR 0211 §2 — the def may
  // not even exist yet; `exists`/`eq` still evaluate against whatever a contact
  // actually carries), bounded only by a sane key length.
  if (key !== null && key.length > 0 && key.length <= 60) return field;
  throw new OpenwopError('validation_error', `Unknown segment filter field \`${field}\`.`, 400, { field });
}

function validateOp(op: unknown): SegmentOp {
  if (typeof op === 'string' && (OPS as readonly string[]).includes(op)) return op as SegmentOp;
  throw new OpenwopError('validation_error', `filter.op must be one of: ${OPS.join(', ')}.`, 400, { op });
}

function validateFilters(raw: unknown): SegmentFilter[] {
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', '`filters` must be an array.', 400, { field: 'filters' });
  if (raw.length > MAX.filters) throw new OpenwopError('validation_error', `A segment supports at most ${MAX.filters} filters.`, 400, { max: MAX.filters });
  return raw.map((f) => {
    const o = (f ?? {}) as { field?: unknown; op?: unknown; value?: unknown };
    const field = validateFieldName(o.field);
    const op = validateOp(o.op);
    const filter: SegmentFilter = { field, op };
    if (op !== 'exists') {
      if (typeof o.value !== 'string' || o.value.length === 0) {
        throw new OpenwopError('validation_error', `filter.value is required for op \`${op}\`.`, 400, { field, op });
      }
      filter.value = cleanString(o.value, MAX.valueLen);
      // ADR 0265 — a numeric comparison needs a numeric value.
      if (NUMERIC_OPS.has(op) && !Number.isFinite(Number(filter.value))) {
        throw new OpenwopError('validation_error', `filter.value must be numeric for op \`${op}\`.`, 400, { field, op, value: filter.value });
      }
    }
    return filter;
  });
}

/** The closed-world segment vocabulary (ADR 0265 / CDP-C) — the grounding an NL
 *  segment-author copilot draws its legal fields/ops from (the workflow-author
 *  closed-world pattern), so it can never emit an invalid filter. */
export function segmentVocabulary(): { fields: string[]; calculatedFields: string[]; ops: SegmentOp[]; customFieldPrefix: string } {
  return {
    fields: ['stage', 'owner', 'company', 'lastTriageVariant'],
    calculatedFields: [...CALCULATED_FIELDS],
    ops: [...OPS],
    customFieldPrefix: 'customFields.',
  };
}

/** Non-throwing validation of a drafted filter set — for the copilot draft→validate
 *  loop. Returns the normalized filters on success, or the grounding errors. */
export function validateSegmentDraft(raw: unknown): { valid: boolean; errors: string[]; filters: SegmentFilter[] } {
  try {
    return { valid: true, errors: [], filters: validateFilters(raw) };
  } catch (err) {
    return { valid: false, errors: [err instanceof OpenwopError ? err.message : String(err)], filters: [] };
  }
}

export async function listSegments(tenantId: string): Promise<Segment[]> {
  return (await segments.listForTenantIndexed(tenantId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSegment(tenantId: string, segmentId: string): Promise<Segment | null> {
  const s = await segments.get(segmentId);
  return s && s.tenantId === tenantId ? s : null;
}

export async function createSegment(input: { tenantId: string; name: string; filters: unknown; createdBy: string; segmentId?: string; watchEntries?: boolean } & CrmEmitOptions): Promise<Segment> {
  if (input.segmentId !== undefined) {
    if (!input.segmentId.startsWith('seg:')) {
      throw new OpenwopError('validation_error', 'segmentId must be `seg:`-prefixed.', 400, { segmentId: input.segmentId });
    }
    const existing = await segments.get(input.segmentId);
    if (existing) {
      if (existing.tenantId === input.tenantId) return existing;
      throw new OpenwopError('not_found', 'Segment not found.', 404, { segmentId: input.segmentId });
    }
  }
  // CRMGAP-9: the shared cap primitive (see `crmEntitiesService.assertUnderCap`
  // doc) — same guard shape as companies/deals/tasks/activities, tenant-scoped.
  assertUnderCap((await listSegments(input.tenantId)).length, MAX.perTenantSegments, 'segments', 'tenant');
  const ts = nowIso();
  const s: Segment = {
    segmentId: input.segmentId ?? `seg:${randomUUID()}`,
    tenantId: input.tenantId,
    name: cleanString(input.name, MAX.name, 'Untitled segment'),
    filters: validateFilters(input.filters),
    createdBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
    ...(input.watchEntries ? { watchEntries: true } : {}),
  };
  await segments.put(s);
  // ADR 0627 D2 — the ONE `segment.created` site, NEW row only (the same-id
  // short-circuit above returns the existing row and emits nothing).
  crmMutated({ entity: 'segment', verb: 'created', tenantId: s.tenantId, entityId: s.segmentId, ...emitOptsOf(input) });
  return s;
}

export async function updateSegment(tenantId: string, segmentId: string, patch: { name?: string; filters?: unknown; watchEntries?: boolean }, opts: CrmEmitOptions = {}): Promise<Segment | null> {
  const s = await getSegment(tenantId, segmentId);
  if (!s) return null;
  const next: Segment = { ...s, updatedAt: nowIso() };
  if (patch.name !== undefined) next.name = cleanString(patch.name, MAX.name, s.name);
  if (patch.filters !== undefined) next.filters = validateFilters(patch.filters);
  if (patch.watchEntries !== undefined) {
    if (patch.watchEntries) next.watchEntries = true;
    else delete next.watchEntries;
  }
  await segments.put(next);
  const changed = changedFields(s, next); // ADR 0627 D2 (review S1) — pre-image vs landed (`filters[]` deep-compared)
  if (changed.length > 0) crmMutated({ entity: 'segment', verb: 'updated', tenantId, entityId: segmentId, changed, ...opts });
  return next;
}

/** All segments (across tenants) opted into entry-watching (ADR 0267). A full
 *  scan — the segment-entry daemon calls it on its cadence; the watched set is
 *  small (opt-in). */
export async function listWatchedSegments(): Promise<Segment[]> {
  return (await segments.list()).filter((s) => s.watchEntries === true);
}

export async function deleteSegment(tenantId: string, segmentId: string, opts: CrmEmitOptions = {}): Promise<boolean> {
  const s = await getSegment(tenantId, segmentId);
  if (!s) return false;
  await segments.delete(segmentId);
  crmMutated({ entity: 'segment', verb: 'deleted', tenantId, entityId: segmentId, ...opts });
  return true;
}

/** Per-contact engagement counts (email opens/clicks), keyed by contactId. */
type EngagementCounts = Map<string, { clicks: number; opens: number }>;

/** One filter's field value off a contact — `undefined` when absent. `engagement`
 *  is supplied only when a filter references an event-based trait. */
function fieldValue(contact: Contact, field: SegmentField, engagement?: EngagementCounts): string | undefined {
  const key = customFieldKey(field);
  if (key !== null) {
    const v = contact.customFields?.[key];
    return v === undefined ? undefined : String(v);
  }
  switch (field) {
    case 'stage':
      return contact.stage;
    case 'owner':
      return contact.owner;
    case 'company':
      return contact.company;
    case 'lastTriageVariant':
      return contact.lastTriage?.variant ?? undefined;
    // ADR 0265 / CDP-C — calculated traits (read-time, contact-derived).
    case 'daysSinceCreated':
      return String(daysSince(contact.createdAt));
    case 'daysSinceUpdated':
      return String(daysSince(contact.updatedAt));
    case 'identifierCount':
      return String((contact.identifiers?.length ?? 0) + (contact.email ? 1 : 0));
    case 'propensity':
      return String(contactPropensity(contact)); // ADR 0265 — reuses the weighted-scoring engine
    case 'emailClicks':
      return String(engagement?.get(contact.contactId)?.clicks ?? 0);
    case 'emailOpens':
      return String(engagement?.get(contact.contactId)?.opens ?? 0);
    default:
      return undefined;
  }
}

/** Whole days between an ISO timestamp and now. A live read (segments aren't
 *  run-stamped, so wall-clock here is consistent with the resolve-at-read doctrine). */
function daysSince(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function matchesFilter(contact: Contact, filter: SegmentFilter, engagement?: EngagementCounts): boolean {
  const value = fieldValue(contact, filter.field, engagement);
  if (filter.op === 'exists') return value !== undefined && value !== '';
  if (value === undefined) return false;
  if (NUMERIC_OPS.has(filter.op)) {
    const a = Number(value);
    const b = Number(filter.value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    switch (filter.op) {
      case 'gt': return a > b;
      case 'lt': return a < b;
      case 'gte': return a >= b;
      case 'lte': return a <= b;
      default: return false;
    }
  }
  if (filter.op === 'eq') return value === filter.value;
  // `contains` — case-insensitive substring match.
  return value.toLowerCase().includes((filter.value ?? '').toLowerCase());
}

/** Evaluated at READ (ADR 0211 §2) — filters the live tenant rolodex
 *  (tombstoned contacts already excluded by `listContacts`). AND semantics
 *  across filters; no filters ⇒ every contact matches. */
export async function resolveSegmentMembers(tenantId: string, segmentId: string): Promise<Contact[]> {
  const segment = await getSegment(tenantId, segmentId);
  if (!segment) throw new OpenwopError('not_found', 'Segment not found.', 404, { segmentId });
  const contacts = await listContacts(tenantId);
  if (segment.filters.length === 0) return contacts;
  // ADR 0265 — only pay the engagement-store read when a filter references an
  // event-based trait; attribute-only segments stay a pure in-memory scan.
  const engagement = segment.filters.some((f) => ENGAGEMENT_FIELDS.has(f.field))
    ? await buildEngagementCounts(tenantId)
    : undefined;
  return contacts.filter((c) => segment.filters.every((f) => matchesFilter(c, f, engagement)));
}

/** Aggregate email opens/clicks per contact from the engagement store (ADR 0265). */
async function buildEngagementCounts(tenantId: string): Promise<EngagementCounts> {
  const counts: EngagementCounts = new Map();
  for (const e of await listEngagement(tenantId)) {
    if (e.kind !== 'clicked' && e.kind !== 'opened') continue;
    const cur = counts.get(e.contactId) ?? { clicks: 0, opens: 0 };
    if (e.kind === 'clicked') cur.clicks += 1;
    else cur.opens += 1;
    counts.set(e.contactId, cur);
  }
  return counts;
}

// ── Audience insights (ADR 0265 / CDP-C) — read-time projections over the live
//    membership (no materialization; follows the campaign-intel/attribution
//    read-projection precedent). ────────────────────────────────────────────

/** Estimated size of a segment (count before activation). */
export async function segmentEstimate(tenantId: string, segmentId: string): Promise<{ size: number }> {
  return { size: (await resolveSegmentMembers(tenantId, segmentId)).length };
}

export interface SegmentInsights {
  size: number;
  byStage: Record<string, number>;
  withEmail: number;
  withIdentifiers: number;
  avgPropensity: number;
}

/** Per-segment audience insights (size, stage mix, reachability, avg propensity). */
export async function segmentInsights(tenantId: string, segmentId: string): Promise<SegmentInsights> {
  const members = await resolveSegmentMembers(tenantId, segmentId);
  const byStage: Record<string, number> = {};
  let withEmail = 0;
  let withIdentifiers = 0;
  let propSum = 0;
  for (const c of members) {
    byStage[c.stage] = (byStage[c.stage] ?? 0) + 1;
    if (c.email) withEmail += 1;
    if ((c.identifiers?.length ?? 0) > 0) withIdentifiers += 1;
    propSum += contactPropensity(c);
  }
  return {
    size: members.length,
    byStage,
    withEmail,
    withIdentifiers,
    avgPropensity: members.length ? Math.round((propSum / members.length) * 100) / 100 : 0,
  };
}

/** Overlap between two segments — the intersection size + each segment's size. */
export async function segmentOverlap(tenantId: string, aId: string, bId: string): Promise<{ sizeA: number; sizeB: number; intersection: number }> {
  const a = new Set((await resolveSegmentMembers(tenantId, aId)).map((c) => c.contactId));
  const b = await resolveSegmentMembers(tenantId, bId);
  let intersection = 0;
  for (const c of b) if (a.has(c.contactId)) intersection += 1;
  return { sizeA: a.size, sizeB: b.length, intersection };
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __resetCrmSegments(): Promise<void> {
  await segments.__clear();
}
