/**
 * Governance host-extension client (Deferred Phase B.2 / ADM-7; ADR 0028).
 * Read view over the ONE audit store (`storage.appendAudit` rows) — the
 * backend tenant-scopes fail-closed (wildcard superadmin sees all; a
 * tenant-scoped superadmin sees only payload-stamped rows for their tenant).
 */
import { authedHeaders, config, fetchOpts } from './config.js';
import { ApiError } from './requestJson.js';

export interface AuditRecord {
  timestamp: string;
  principalId: string;
  action: string;
  resource: string;
  outcome: string;
  payload?: Record<string, unknown>;
}

export async function listAudit(opts: { actionPrefix?: string; limit?: number; since?: string } = {}): Promise<AuditRecord[]> {
  const qs = new URLSearchParams();
  if (opts.actionPrefix !== undefined) qs.set('actionPrefix', opts.actionPrefix);
  if (opts.limit) qs.set('limit', String(opts.limit));
  if (opts.since) qs.set('since', opts.since);
  const res = await fetch(`${config.baseUrl}/host/openwop-app/governance/audit${qs.toString() ? `?${qs}` : ''}`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) {
    throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, message: `listAudit returned ${res.status}` });
  }
  return ((await res.json()) as { items: AuditRecord[] }).items;
}

/** ADR 0416 P2/P3 — download the caller tenant's tamper-evident audit-chain
 *  export (JSONL: proof first line; CSV: proof in response headers). Tenant-
 *  admin authority (`host:members:manage`) — NOT superadmin-gated, so this is
 *  offered even when the flat-log table above is forbidden. */
export async function downloadAuditChainExport(format: 'jsonl' | 'csv'): Promise<void> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/governance/audit/export?format=${format}`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) {
    throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, message: `audit export returned ${res.status}` });
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-chain.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
