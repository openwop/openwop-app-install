/**
 * ADR 0958 P3 — vendor submissions for one client, under
 * `/host/openwop-app/campaign-ops/clients/:orgId/intakes`. Loads with the lazy
 * submissions section. Failures throw `CampaignOpsError` (a 404 "not enabled"
 * means external collaborators are off for the workspace).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { asJson } from './campaignOpsClient.js';

export type IntakeStatus = 'submitted' | 'accepted' | 'rejected' | 'withdrawn';
export interface IntakeFile { fileId: string; name: string; contentType: string; bytes: number; contentHash: string; scan: 'clean' | 'not_configured'; mediaAssetId?: string; bytesPurgedAt?: string }
export interface AgencyIntake {
  intakeId: string; orgId: string; campaignId: string; grantId: string; collaboratorId: string;
  files: IntakeFile[];
  rights: { license: string; termEndsAt?: string; credit?: string; modelReleases: boolean; attestedAt: string };
  note?: string; status: IntakeStatus; submittedAt: string; reviewedAt?: string; reason?: string; accepting: boolean;
  collaborator: { collaboratorId: string; displayName: string; kind: string; status: string } | null;
}

const base = (orgId: string): string => `${config.baseUrl}/host/openwop-app/campaign-ops/clients/${encodeURIComponent(orgId)}/intakes`;

export async function listClientIntakes(orgId: string): Promise<AgencyIntake[]> {
  return (await asJson<{ intakes: AgencyIntake[] }>(await fetch(base(orgId), fetchOpts({ headers: authedHeaders() })))).intakes;
}
export async function acceptClientIntake(orgId: string, intakeId: string): Promise<AgencyIntake> {
  return (await asJson<{ intake: AgencyIntake }>(await fetch(`${base(orgId)}/${encodeURIComponent(intakeId)}/accept`, fetchOpts({ method: 'POST', headers: authedHeaders() })))).intake;
}
export async function rejectClientIntake(orgId: string, intakeId: string, reason: string): Promise<AgencyIntake> {
  return (await asJson<{ intake: AgencyIntake }>(await fetch(`${base(orgId)}/${encodeURIComponent(intakeId)}/reject`, fetchOpts({
    method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ reason }),
  })))).intake;
}
/** The review download: the server always sends it as an attachment. Saved through a blob, never opened in this origin. */
export async function downloadIntakeFile(orgId: string, intakeId: string, file: IntakeFile): Promise<void> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(intakeId)}/files/${encodeURIComponent(file.fileId)}`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) await asJson<unknown>(res);
  const url = URL.createObjectURL(await res.blob());
  try {
    const a = document.createElement('a');
    a.href = url; a.download = file.name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
