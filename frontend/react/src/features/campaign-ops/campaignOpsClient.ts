/**
 * Campaign operations API client (ADR 0926 P0) — the operator inbox's reads and
 * actions under `/host/openwop-app/campaign-ops/*`, plus the two decisions on the
 * ONE approvals surface (`/host/openwop-app/approvals/:id/claim|reject`).
 *
 * Every failure throws `CampaignOpsError` carrying the server's own message and
 * `details.reason`, because the page surfaces those verbatim (a 409
 * `asset_changed` already reads "Someone edited X after this change was
 * prepared…"). A failed read is never returned as an empty list.
 *
 * @see docs/adr/0926-campaign-ops-operator-inbox-and-preview-onboarding.md
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type ClientStatus = 'active' | 'paused' | 'archived';
export type ClientMode = 'preview' | 'live';

export interface ClientAccount {
  tenantId: string; orgId: string; displayName: string;
  status: ClientStatus; mode: ClientMode; approvalPolicy: string;
  synthetic?: boolean; createdAt: string; updatedAt: string;
}

export interface CampaignAsset {
  assetId: string; orgId: string; destination: string;
  locator: { pageId: string }; label: string; editableFields: string[];
  lastKnown?: { version: number; contentHash: string; readAt: string };
}

export interface Question { id: string; slot: string; prompt: string; options?: string[] }
export type RequestStatus =
  | 'interpreting' | 'needs_facts' | 'proposing' | 'proposed'
  | 'no_changes' | 'failed' | 'superseded' | 'duplicate';

export interface ChangeRequest {
  requestId: string; orgId: string; version: number; text: string; assetIds: string[];
  answers: Array<{ questionId: string; value: string }>;
  interpretation?: { intents: unknown[]; questions: Question[] };
  status: RequestStatus;
  failure?: { code: string; message: string };
  duplicateOf?: string; changeSetId?: string;
  createdAt: string; updatedAt: string;
}

export type ChangeSetStatus = 'proposed' | 'in_review' | 'approved' | 'rejected' | 'stale' | 'executing' | 'finished';
export interface ChangeSetEntry { assetId: string; label: string; destination: string; sourceVersion: number; edits: unknown[]; targetContentHash: string }
export interface ChangeSet {
  changeSetId: string; requestId: string; requestVersion: number;
  entries: ChangeSetEntry[];
  /** Sent back verbatim in the approve body; never displayed. */
  hash: string;
  status: ChangeSetStatus;
  staleReason?: 'request_changed' | 'asset_changed';
  createdAt: string;
}
export interface DiffField { field: string; before: unknown; after: unknown }
export interface DiffEntry { assetId: string; label: string; fields: DiffField[] }

export type StepState = 'pending' | 'checking' | 'writing' | 'written' | 'unknown' | 'confirmed' | 'conflicted' | 'incomplete';
export interface JobStep { assetId: string; label: string; state: StepState; reason?: string; attempts: number }
export interface Job {
  jobId: string; changeSetId: string; approvalId: string;
  status: 'running' | 'finished' | 'needs_attention';
  steps: JobStep[];
  outcome?: { confirmed: number; conflicted: number; incomplete: number; unknown: number; total: number };
  finishedAt?: string;
}

/** A failed call: HTTP status, the server's message, and `details.reason`. */
export class CampaignOpsError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string, readonly code?: string) {
    super(message);
    this.name = 'CampaignOpsError';
  }
}

const base = `${config.baseUrl}/host/openwop-app/campaign-ops`;
const approvalsBase = `${config.baseUrl}/host/openwop-app/approvals`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });
const enc = encodeURIComponent;

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = '';
    let reason: string | undefined;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; message?: string; details?: { reason?: string } };
      message = body?.message ?? '';
      reason = body?.details?.reason;
      code = body?.error;
    } catch { /* non-JSON body */ }
    throw new CampaignOpsError(message, res.status, reason, code);
  }
  return (await res.json()) as T;
}

const get = async <T>(path: string): Promise<T> => asJson<T>(await fetch(`${base}${path}`, fetchOpts({ headers: authedHeaders() })));
const send = async <T>(method: 'POST' | 'PATCH', url: string, body: unknown): Promise<T> =>
  asJson<T>(await fetch(url, fetchOpts({ method, headers: jsonHeaders(), body: JSON.stringify(body) })));

export async function listClients(): Promise<{ clients: ClientAccount[]; agencyAdmin: boolean }> {
  return get('/clients');
}
export async function updateClient(orgId: string, patch: { mode?: ClientMode; status?: ClientStatus; name?: string }): Promise<ClientAccount> {
  return (await send<{ client: ClientAccount }>('PATCH', `${base}/clients/${enc(orgId)}`, patch)).client;
}
export async function listAssets(orgId: string): Promise<CampaignAsset[]> {
  return (await get<{ assets: CampaignAsset[] }>(`/clients/${enc(orgId)}/assets`)).assets;
}
export async function listRequests(orgId: string): Promise<ChangeRequest[]> {
  return (await get<{ requests: ChangeRequest[] }>(`/clients/${enc(orgId)}/requests`)).requests;
}
export type SubmitResult = { request: ChangeRequest; duplicate: boolean };
export async function submitRequest(orgId: string, input: { text: string; assetIds: string[]; overrideDuplicate?: { reason: string } }): Promise<SubmitResult> {
  const out = await send<{ request: ChangeRequest; duplicate?: boolean }>('POST', `${base}/clients/${enc(orgId)}/requests`, input);
  return { request: out.request, duplicate: out.duplicate === true };
}
export async function answerQuestions(orgId: string, requestId: string, answers: Array<{ questionId: string; value: string }>): Promise<ChangeRequest> {
  return (await send<{ request: ChangeRequest }>('POST', `${base}/clients/${enc(orgId)}/requests/${enc(requestId)}/answers`, { answers })).request;
}
export async function reviseRequest(orgId: string, requestId: string, text: string): Promise<ChangeRequest> {
  return (await send<{ request: ChangeRequest }>('PATCH', `${base}/clients/${enc(orgId)}/requests/${enc(requestId)}`, { text })).request;
}
export async function listChangeSets(orgId: string): Promise<ChangeSet[]> {
  return (await get<{ changeSets: ChangeSet[] }>(`/clients/${enc(orgId)}/change-sets`)).changeSets;
}
export async function getChangeSetDiff(orgId: string, changeSetId: string): Promise<{ changeSet: ChangeSet; diff: DiffEntry[] }> {
  return get(`/clients/${enc(orgId)}/change-sets/${enc(changeSetId)}`);
}
/** Idempotent for a change set already in review: returns the same approval id. */
export async function requestApproval(orgId: string, changeSetId: string): Promise<{ changeSet: ChangeSet; approvalId: string }> {
  return send('POST', `${base}/clients/${enc(orgId)}/change-sets/${enc(changeSetId)}/request-approval`, {});
}
export async function listJobs(orgId: string): Promise<Job[]> {
  return (await get<{ jobs: Job[] }>(`/clients/${enc(orgId)}/jobs`)).jobs;
}
export async function approveChangeSet(approvalId: string, expectedChangeSetHash: string): Promise<void> {
  await send('POST', `${approvalsBase}/${enc(approvalId)}/claim`, { expectedChangeSetHash });
}
export async function rejectChangeSet(approvalId: string, note?: string): Promise<void> {
  await send('POST', `${approvalsBase}/${enc(approvalId)}/reject`, note ? { note } : {});
}
