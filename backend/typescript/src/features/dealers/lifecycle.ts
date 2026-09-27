/**
 * Dealers ← CRM record-lifecycle consumer (ADR 0283; closes DEAL-DATA-2).
 *
 * A Dealer references a CRM `companyId` (validated visible on create). If that
 * company is later deleted, the dealer's reference dangles — silently violating
 * the create-time invariant. Rather than leave it (or destructively delete a
 * dealer that owns outlets/registrations), we SUSPEND the referencing dealers:
 * non-destructive, reversible, and it stops a dangling-company dealer from reading
 * as active. Registered unconditionally at boot (like the territories consumer);
 * safe regardless of toggle state (it only ever touches this feature's own rows).
 */
import { onCrmRecordDeleted } from '../../host/crmRecordLifecycle.js';
import { suspendDealersForCompany } from './entities/dealer.js';

export function registerDealerCrmLifecycle(): void {
  onCrmRecordDeleted('dealers', async ({ tenantId, orgId, entity, recordId }) => {
    if (entity !== 'company' || !orgId) return;
    await suspendDealersForCompany(tenantId, orgId, recordId);
  });
}
