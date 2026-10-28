/**
 * Campaign ops subject erasure (ADR 0464 store ledger). Client accounts,
 * assets, agent bindings (ADR 0943), report definitions and reports (ADR 0957) are the agency's configuration for a
 * client, so they are never deleted on a person's erasure. What goes is the
 * person in them: `createdBy` (a binding's `updatedBy`) becomes the erased-user
 * tombstone. Tenant-scoped only: a principal id is not
 * issuer-qualified, so it is never matched in another tenant.
 */
import { registerSubjectEraser, type SubjectEraseReport } from '../../host/subjectErasure.js';
import { subjectKeyForms, ERASED_USER_REF } from '../../host/subjectErasureRedaction.js';
import { eraseClientCreators } from './clientService.js';
import { eraseAssetCreators } from './assetService.js';
import { eraseApproverCreators, purgePortalForOrg } from './portal.js';
import { eraseClientDecisionWriters } from './approval.js';
import { eraseAgentBindingEditors } from './agentBindingService.js';
import { eraseReportActors } from './reports/reportService.js';
import { eraseClientNoteProposalDeciders } from './clientMemory.js';
import { eraseClientContextSourceEditors } from './clientContext.js';
import { purgeCollaboratorsForOrg, registerCollaboratorEraseHook, registerCollaboratorPurgeHook, type ExternalCollaborator } from '../../host/externalCollaborators.js';
import { purgeLinksForResource } from '../sharing/sharingService.js';
import { eraseIntakesOfCollaborator, purgeIntakesForOrg } from './collaboration/intake.js';
import { getRetentionHold } from '../../host/retentionHold.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('campaign-ops.erasure');

export async function eraseCampaignOpsSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey || subjectKey === ERASED_USER_REF) return { rowsTouched: 0 }; // never an unscoped sweep
  const forms = subjectKeyForms(subjectKey).forms;
  const rowsTouched = (await eraseClientCreators(tenantId, forms, ERASED_USER_REF))
    + (await eraseAssetCreators(tenantId, forms, ERASED_USER_REF))
    + (await eraseApproverCreators(tenantId, forms, ERASED_USER_REF))
    + (await eraseClientDecisionWriters(tenantId, forms, ERASED_USER_REF))
    + (await eraseAgentBindingEditors(tenantId, forms, ERASED_USER_REF))
    + (await eraseReportActors(tenantId, forms, ERASED_USER_REF))
    + (await eraseClientNoteProposalDeciders(tenantId, forms, ERASED_USER_REF))
    + (await eraseClientContextSourceEditors(tenantId, forms, ERASED_USER_REF));
  return { rowsTouched };
}

/** ADR 0958 P5 — campaign-ops' rows that name an external collaborator: their
 *  intakes and their single-use invite link. Runs inside the host eraser,
 *  before the collaborator record is deleted, for both the home-tenant and the
 *  agency (email-keyed) erasure. */
export async function eraseCollaboratorRows(c: ExternalCollaborator): Promise<number> {
  const n = await eraseIntakesOfCollaborator(c);
  return n + await purgeLinksForResource(c.tenantId, 'collab_invite', c.collaboratorId);
}

/** ADR 0958 P5 — campaign-ops' rows that name a collaborator, deleted when the
 *  client org is torn down: every intake (accepted ones too) and the invite link. */
export async function purgeCollaboratorRows(c: ExternalCollaborator): Promise<number> {
  const n = await purgeIntakesForOrg(c.tenantId, c.orgId, (r) => r.collaboratorId === c.collaboratorId);
  return n + await purgeLinksForResource(c.tenantId, 'collab_invite', c.collaboratorId);
}

/**
 * ADR 0958 P5 — tear down a client org's external collaboration: the portal's
 * approver links, then every collaborator with its grants and the rows the
 * purge hooks own, then any intake whose collaborator is already gone. After
 * it the org holds no collaboration rows, so the RI-7 refuse-while-populated
 * check no longer counts them. Under a legal hold on the tenant nothing is
 * deleted (the hold keeps the org's records, and its deletion stays refused).
 */
export async function purgeCollaborationForOrg(tenantId: string, orgId: string): Promise<number> {
  if (await getRetentionHold(tenantId)) {
    log.warn('collaboration_teardown_held', { tenantId, orgId });
    return 0;
  }
  let n = await purgePortalForOrg(tenantId, orgId);
  n += await purgeCollaboratorsForOrg(tenantId, orgId);
  return n + await purgeIntakesForOrg(tenantId, orgId);
}

export function registerCampaignOpsErasure(): void {
  registerSubjectEraser(eraseCampaignOpsSubject);
  registerCollaboratorEraseHook(eraseCollaboratorRows);
  registerCollaboratorPurgeHook(purgeCollaboratorRows);
}
