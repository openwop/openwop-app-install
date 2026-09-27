/**
 * CDP FE client (ADR 0263 / CDP-A) — customer identity resolution.
 *
 * Resolve a customer's golden record by any identifier. A miss is a normal
 * outcome (404 → null), not an error; other non-2xx throw.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

export const IDENTIFIER_TYPES = ['email', 'phone', 'loyalty', 'device', 'cookie', 'external'] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

export interface ContactIdentifier {
  type: string;
  value: string;
  source: string;
  verifiedAt?: string;
}

export interface GoldenContact {
  contactId: string;
  name: string;
  email?: string;
  company?: string;
  stage: string;
  /** R2 CD-SP-3 — the console renders these now (they always rode the wire). */
  phone?: string;
  title?: string;
  owner?: string;
  leadSource?: string;
  customFields?: Record<string, string>;
  identifiers?: ContactIdentifier[];
  mergedInto?: string;
}

export interface GoldenRecord {
  contact: GoldenContact;
  identifiers: ContactIdentifier[];
  resolvedBy: { type: string; value: string };
  /** R2 CDP-G5 — true when label-based access pseudonymized PII fields for
   *  this caller (the value renders AS masked, never silently). */
  masked?: boolean;
  /** CDP-G2 — present when the identifier you searched was filed under a contact
   *  that has since been merged away, so `contact` is the SURVIVING record and
   *  not the one the identifier belonged to. Absent on a direct hit. */
  mergedFrom?: { contactId: string };
}

/** Resolve a customer by identifier; null when nothing resolves (404). */
export async function resolveIdentity(type: string, value: string): Promise<GoldenRecord | null> {
  const q = `type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`;
  const res = await fetch(`${config.baseUrl}/host/openwop-app/cdp/identity/resolve?${q}`, {
    ...fetchOpts({}),
    headers: authedHeaders({ 'content-type': 'application/json' }),
  });
  if (res.status === 404) return null;
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
  return body as GoldenRecord;
}

// ── Compliance reads (ADR 0268 / 0269 / 0301) ─────────────────────────────────
// The governance decision log, tamper-evident audit-chain verify, event-schema
// registry, and collected-event stream — read-only surfaces the CDP console's
// Compliance section renders. All ride the same toggle gate as `resolveIdentity`.

const CDP_BASE = `${config.baseUrl}/host/openwop-app/cdp`;

async function cdpGet<T>(path: string): Promise<T> {
  const res = await fetch(`${CDP_BASE}${path}`, { ...fetchOpts({}), headers: authedHeaders() });
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
  return body as T;
}

/** One row of the unified governance decision log (ADR 0268 / CDP-F). */
export interface GovernanceDecisionRow {
  auditId: string;
  timestamp: string;
  action: string;
  outcome?: string;
  resource?: string;
  payload?: unknown;
}

/** R2 CDP-G4 — the read is BOUNDED and says so: `limit` is the requested cap
 *  and `exhaustive` is false when older tenant rows may exist beyond the
 *  escalating scan (the UI must disclose, never present a bounded read as
 *  complete). Older backends omit the fields (treated as exhaustive). */
export async function listGovernanceDecisions(limit = 200): Promise<{ decisions: GovernanceDecisionRow[]; exhaustive: boolean }> {
  const body = await cdpGet<{ decisions: GovernanceDecisionRow[]; exhaustive?: boolean }>(`/governance-decisions?limit=${limit}`);
  return { decisions: body.decisions, exhaustive: body.exhaustive ?? true };
}

/** Audit-chain verification (ADR 0301 / CDP-F) — admin-gated: a 403 is a normal
 *  outcome for a non-admin caller, surfaced as `forbidden` rather than an error. */
export type AuditChainResult =
  | { state: 'verified'; ok: boolean; brokenAt?: number; length: number }
  | { state: 'forbidden' };

export async function verifyAuditChain(): Promise<AuditChainResult> {
  const res = await fetch(`${CDP_BASE}/audit-chain/verify`, { ...fetchOpts({}), headers: authedHeaders() });
  if (res.status === 403) return { state: 'forbidden' };
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
  const b = body as { ok: boolean; brokenAt?: number; length?: number };
  return { state: 'verified', ok: b.ok, ...(b.brokenAt !== undefined ? { brokenAt: b.brokenAt } : {}), length: b.length ?? 0 };
}

/** A registered event schema (latest version per type) — ADR 0269 / CDP-G. */
export interface EventSchemaRecord {
  key: string;
  eventType: string;
  version: number;
  schema: Record<string, unknown>;
  createdAt: string;
}

export async function listEventSchemas(): Promise<EventSchemaRecord[]> {
  return (await cdpGet<{ schemas: EventSchemaRecord[] }>('/event-schemas')).schemas;
}

/** A collected event with ingest-time PII tagging (ADR 0269 / CDP-G). */
export interface CollectedEventRow {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  piiFields: string[];
  schemaVersion?: number;
  at: string;
}

export async function listCollectedEvents(limit = 100): Promise<CollectedEventRow[]> {
  return (await cdpGet<{ events: CollectedEventRow[] }>(`/collected-events?limit=${limit}`)).events;
}

/** R3 — the merge-history audit read (ADR 0264 recorded it all along). */
export interface MergeEventRow {
  mergeEventId: string;
  survivorId: string;
  sourceId: string;
  filledFields: Record<string, string>;
  absorbedIdentifiers: Array<{ type: string; value: string; source?: string }>;
  actor: string;
  mergedAt: string;
  unmergedAt?: string;
}
export async function listMergeEvents(limit = 100): Promise<MergeEventRow[]> {
  return (await cdpGet<{ events: MergeEventRow[] }>(`/merge-events?limit=${limit}`)).events;
}
