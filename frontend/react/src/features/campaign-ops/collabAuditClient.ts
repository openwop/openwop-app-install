/**
 * ADR 0958 D7 / P5 — the collaboration audit review for one client, under
 * `/host/openwop-app/campaign-ops/clients/:orgId/collaborators/audit`. Failures
 * throw `CampaignOpsError` (a 404 "not enabled" means external collaborators
 * are off; a 403 means the caller does not manage this client).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { asJson } from './campaignOpsClient.js';

export interface CollabAuditEvent {
  seq: number;
  at: string;
  action: string;
  collaboratorId?: string;
  grantId?: string;
  intakeId?: string;
  resource?: { kind: string; id: string };
  /** What a grant was for, joined from the live grant when the event did not record it. */
  resourceKind?: string;
  actions?: string[];
  files?: number;
  assets?: number;
  /** Joined live: `null` once the person is gone (erased or removed). */
  collaborator: { displayName: string; kind: string } | null;
}

export async function listCollabAudit(orgId: string): Promise<{ events: CollabAuditEvent[]; truncated: boolean }> {
  const url = `${config.baseUrl}/host/openwop-app/campaign-ops/clients/${encodeURIComponent(orgId)}/collaborators/audit`;
  return asJson<{ events: CollabAuditEvent[]; truncated: boolean }>(await fetch(url, fetchOpts({ headers: authedHeaders() })));
}
