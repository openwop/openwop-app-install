/**
 * ADR 0820 §7 — Job search's READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 * Attestations come without their `tokenHash` (`listAttestations` strips it);
 * applications are read without provisioning a pipeline.
 */
import { listListings } from './boards/listing.js';
import { listAttestations } from './attestation/token.js';
import { listApplicationsReadOnly } from './domain/applications.js';
import { collectPerOrg, type FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportJobSearchData(tenantId: string): Promise<FeatureDataSections> {
  return {
    applications: await collectPerOrg(tenantId, (orgId) => listApplicationsReadOnly(tenantId, orgId)),
    listings: await listListings(tenantId),
    attestations: await listAttestations(tenantId),
  };
}
