/**
 * ADR 0460 Phase 2 — the kicktodo-commerce PAYOUT-RUNS exception source.
 *
 * A payout run that is still `open` (created but not confirmed with external
 * payment evidence) is money owed that no operator has closed out. This source
 * reads the tenant's payout runs (tenant-scoped) and flags the open ones. The
 * host never moves money — the row deep-links the operator to the commerce
 * surface where they record the evidence and confirm.
 */

import { listPayoutRuns } from './shareLedgerService.js';
import { registerExceptionSource, type ExceptionRow } from '../../host/exceptionProjection.js';

const SOURCE_KEY = 'kicktodo:payouts';

async function payoutExceptionSource(tenantId: string): Promise<ExceptionRow[]> {
  if (!tenantId) return [];
  const runs = await listPayoutRuns(tenantId);
  return runs
    // "Awaiting evidence" = created but not yet confirmed with a payment reference.
    .filter((r) => r.state === 'open' && !r.reference)
    .map((r) => {
      const rows = r.entries.reduce((n, e) => n + e.rowCount, 0);
      return {
        id: `payout:${r.runId}`,
        source: SOURCE_KEY,
        severity: 'action-required' as const,
        label: `Payout run ${r.runId} awaiting evidence (${r.entries.length} recipient${r.entries.length === 1 ? '' : 's'}, ${rows} line${rows === 1 ? '' : 's'})`,
        owner: { kind: 'user' as const, ref: r.createdBy, label: 'operator' },
        action: { labelKey: 'exceptionActionOpen', href: '/admin/kicktodo/commerce' },
        audit: { detectedAt: r.createdAt, tenantId },
      };
    });
}

export function registerKicktodoPayoutExceptionSource(): void {
  registerExceptionSource(SOURCE_KEY, payoutExceptionSource);
}
