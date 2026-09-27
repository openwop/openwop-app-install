/**
 * KickTodo admin Exception Ledger FE client (ADR 0460 Phase 2) — React-free over
 * `/host/openwop-app/kicktodo/admin/exceptions`. The read is the host
 * exception-projection composed over the registered sources; a down source is
 * reported in `sources[]` (ok:false) rather than silently dropped, so the ledger
 * can show "this feed is degraded" instead of a misleading "all clear".
 */
import { authedHeaders, config, fetchOpts } from './config.js';

const BASE = `${config.baseUrl}/host/openwop-app/kicktodo/admin`;

export type ExceptionSeverity = 'blocker' | 'action-required' | 'attention' | 'degraded';

export interface ExceptionOwner {
  kind: 'user' | 'agent' | 'system';
  ref: string;
  label: string;
}

export interface ExceptionAction {
  labelKey: string;
  href: string;
}

export interface ExceptionRow {
  id: string;
  source: string;
  severity: ExceptionSeverity;
  label: string;
  owner: ExceptionOwner;
  action: ExceptionAction;
  audit: { detectedAt: string; tenantId: string };
}

export interface ExceptionSourceResult {
  key: string;
  ok: boolean;
  count: number;
  truncated: boolean;
  error?: string;
}

export interface ExceptionLedger {
  rows: ExceptionRow[];
  sources: ExceptionSourceResult[];
}

async function req<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...fetchOpts(),
    headers: { 'content-type': 'application/json', ...authedHeaders() },
  });
  if (!res.ok) throw new Error(`exceptions request failed: ${res.status}`);
  return (await res.json()) as T;
}

/** The composed exception ledger for the acting tenant. 404/500 → null so the
 *  command center shows an honest error/empty state, never a fabricated list. */
export async function listExceptions(): Promise<ExceptionLedger | null> {
  try {
    return await req<ExceptionLedger>('/exceptions');
  } catch {
    return null;
  }
}

/** One GOVERNANCE_DECISION chain entry for an approval-backed row (ADR 0301
 *  slice). `payload` carries actor/before/outcome/note — actor may be absent
 *  (system/agent decisions are honestly unattributed; entries older than the
 *  enrichment carry no before/actor either). */
export interface ExceptionAuditEntry {
  seq: number;
  at: string;
  payload: {
    approvalId?: string;
    approvalKind?: string;
    outcome?: string;
    before?: string;
    actor?: string;
    note?: string;
  };
}

/** The bounded chain slice for one approvalId. null = the read failed (render a
 *  failure line, never an invented "no history"). */
export async function getExceptionAudit(approvalId: string): Promise<ExceptionAuditEntry[] | null> {
  try {
    return (await req<{ entries: ExceptionAuditEntry[] }>(`/exceptions/audit?approvalId=${encodeURIComponent(approvalId)}`)).entries;
  } catch {
    return null;
  }
}
