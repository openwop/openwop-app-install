/**
 * Unified policy decision log (ADR 0268 / CDP-F) — one `governance.decision.*`
 * audit namespace so consent denials, firewall verdicts, purpose checks, retention
 * tombstones, and masking events become a single queryable stream (the ADR-0028
 * governance VIEW composes over it; NO second audit store). Best-effort: a
 * decision-log failure MUST never break the gate that emitted it.
 */
import { hostExtStorage } from './hostExtPersistence.js';

export type GovernanceDecisionKind = 'consent' | 'purpose' | 'firewall' | 'retention' | 'masking' | 'access';

export interface GovernanceDecision {
  tenantId: string;
  kind: GovernanceDecisionKind;
  outcome: 'allow' | 'deny';
  /**
   * Opaque, PSEUDONYMOUS subject reference — NEVER a raw subject key.
   *
   * WF-CONS-14: this contract was stated here and violated at the highest-fan-in
   * call site for as long as the field existed. It matters more than a usual
   * "don't log PII" note, because rows written here are UNRECOVERABLE: they land
   * in the global `audit_log` table, which has no tenant column, no
   * `registerSubjectEraser`, no `registerRetentionPurger`, and is explicitly
   * excluded from ADR 0284 tenant teardown (`storage.ts` `deleteAllTenantData`:
   * "does NOT touch the audit log"). A subject can be fully erased and still be
   * named in every row the gate ever wrote — and a subject key may, since ADR
   * 0394, be a raw E.164 phone number.
   *
   * Pass a tenant-salted digest (the `hashSubjectKey` pattern in
   * `features/consent/consentService.ts`) or a non-person id. Enforced by
   * `test/governance-decision-subject-pii.test.ts`, which scans every call site
   * rather than trusting this comment.
   */
  subject?: string;
  reason?: string;
  resource?: string;
  principalId?: string;
  detail?: Record<string, unknown>;
}

/** Record one governance decision (fire-and-forget friendly). */
export async function recordGovernanceDecision(d: GovernanceDecision): Promise<void> {
  try {
    await hostExtStorage().appendAudit({
      timestamp: new Date().toISOString(),
      ...(d.principalId ? { principalId: d.principalId } : {}),
      action: `governance.decision.${d.kind}`,
      ...(d.resource ? { resource: d.resource } : {}),
      outcome: d.outcome,
      payload: {
        tenantId: d.tenantId,
        ...(d.subject ? { subject: d.subject } : {}),
        ...(d.reason ? { reason: d.reason } : {}),
        ...(d.detail ?? {}),
      },
    });
  } catch {
    /* best-effort — never break the gate on an audit failure */
  }
}

export interface GovernanceDecisionRow {
  auditId: string;
  timestamp: string;
  action: string;
  outcome?: string;
  resource?: string;
  payload?: unknown;
}

/** Query the decision log for a tenant (newest first). Filters the global audit
 *  stream by the `governance.decision.` prefix + the payload's tenantId. An optional
 *  `kind` narrows to one decision namespace (e.g. `firewall`) by extending the action
 *  prefix — ADR 0397 §Phase 1 wires a firewall-scoped view over this. */
export async function listGovernanceDecisions(tenantId: string, opts: { kind?: GovernanceDecisionKind; sinceIso?: string; limit?: number } = {}): Promise<GovernanceDecisionRow[]> {
  return (await listGovernanceDecisionsWithBound(tenantId, opts)).rows;
}

/** R2 CD-SP-2 — tenant rows can be buried arbitrarily deep in the GLOBAL
 *  audit stream, and both storage adapters CLAMP a single listAudit read to
 *  500 rows (the review caught the first "escalating" fix silently hitting
 *  that clamp and reporting `exhaustive: true` for buried tenants). So: PAGE
 *  newest-first with the `beforeIso` cursor (inclusive — same-timestamp
 *  boundary rows repeat, deduped by auditId) until the tenant's `limit` rows
 *  are found, the stream ends, or the scan budget is spent. `exhaustive` is
 *  false ONLY when we stopped with stream left unread. */
const AUDIT_PAGE = 500; // the adapters' clamp — one page per read
export async function listGovernanceDecisionsWithBound(
  tenantId: string,
  opts: { kind?: GovernanceDecisionKind; sinceIso?: string; limit?: number } = {},
): Promise<{ rows: GovernanceDecisionRow[]; exhaustive: boolean }> {
  const want = opts.limit ?? 200;
  const scanBudget = Math.max(want * 32, AUDIT_PAGE * 8); // rows we are willing to walk
  const filter = {
    actionPrefix: `governance.decision.${opts.kind ?? ''}`,
    ...(opts.sinceIso ? { sinceIso: opts.sinceIso } : {}),
  };
  const seen = new Set<string>();
  const mine: GovernanceDecisionRow[] = [];
  let beforeIso: string | undefined;
  let scanned = 0;
  for (;;) {
    const page = await hostExtStorage().listAudit({ ...filter, ...(beforeIso ? { beforeIso } : {}), limit: AUDIT_PAGE });
    const fresh = page.filter((r) => !seen.has(r.auditId));
    for (const r of fresh) seen.add(r.auditId);
    scanned += fresh.length;
    for (const r of fresh) {
      if ((r.payload as { tenantId?: string } | undefined)?.tenantId === tenantId && mine.length < want) {
        mine.push({ auditId: r.auditId, timestamp: r.timestamp, action: r.action, outcome: r.outcome, resource: r.resource, payload: r.payload });
      }
    }
    const streamEnded = page.length < AUDIT_PAGE || fresh.length === 0;
    if (mine.length >= want || streamEnded) return { rows: mine, exhaustive: true };
    if (scanned >= scanBudget) return { rows: mine, exhaustive: false };
    beforeIso = page[page.length - 1]!.timestamp;
  }
}
