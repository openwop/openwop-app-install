/**
 * Territories ← CRM record-lifecycle consumer (ADR 0283; closes TERR-DATA-1).
 *
 * Deal/company deletion previously left `crm:territory-assignment` rows dangling
 * until the next `materializeAssignments` (activation or manual `/reassign`) —
 * bounded-impact orphan ACCUMULATION (attainment + visibility iterate live
 * records, so orphans were harmless-on-read), now pruned at the source event.
 *
 * Registered unconditionally at boot (like `registerTerritoryVisibility`): the
 * pruner only ever deletes this feature's own soft-reference rows, which is safe
 * and correct whether or not the tenant's `territories` toggle is on (a disabled
 * tenant simply has no assignments to prune). Contacts are not assignment
 * targets (`AssignTarget = 'company' | 'deal'`), so contact events no-op.
 */
import { onCrmRecordDeleted } from '../../host/crmRecordLifecycle.js';
import { pruneAssignmentsForRecord } from './entities/assignment.js';

export function registerTerritoryCrmLifecycle(): void {
  onCrmRecordDeleted('territories', async ({ tenantId, orgId, entity, recordId }) => {
    if (!orgId || (entity !== 'deal' && entity !== 'company')) return;
    await pruneAssignmentsForRecord(tenantId, orgId, entity, recordId);
  });
}
