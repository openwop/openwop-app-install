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
/** ADR 0924 D4 — who approves this client's changes. */
export type ApprovalPolicyMode = 'agency' | 'client';

/** ADR 0924 D5 — a person at the client who approves through a private link. */
export interface ClientApprover {
  approverId: string; orgId: string; email: string; displayName: string;
  status: 'active' | 'suspended' | 'revoked'; createdAt: string;
}
/** One approver's link to one change set. The URL is shown once. */
export interface SentApprovalLink { approverId: string; displayName: string; email: string; url: string; expiresAt?: string }

/** ADR 0962 D7. */
export type ExternalAgentsAccess = 'off' | 'read' | 'request';

export interface ClientAccount {
  tenantId: string; orgId: string; displayName: string;
  status: ClientStatus; mode: ClientMode; approvalPolicy: ApprovalPolicyMode;
  synthetic?: boolean; createdAt: string; updatedAt: string;
  /** ADR 0962 D7 — what outside agents (MCP) may do for this client. Absent ⇒ off. */
  externalAgents?: ExternalAgentsAccess;
}

export interface CampaignAsset {
  assetId: string; orgId: string; destination: string;
  locator: { pageId: string } | { templateId: string; campaignIds?: string[] }; label: string; editableFields: string[];
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

export async function asJson<T>(res: Response): Promise<T> {
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
export async function updateClient(orgId: string, patch: { mode?: ClientMode; status?: ClientStatus; name?: string; approvalPolicy?: ApprovalPolicyMode; externalAgents?: ExternalAgentsAccess }): Promise<ClientAccount> {
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

// ── ADR 0924 D5 — client approvers ──
export async function listApprovers(orgId: string): Promise<{ approvers: ClientApprover[]; portalEnabled: boolean }> {
  return get(`/clients/${enc(orgId)}/approvers`);
}
export async function addApprover(orgId: string, input: { email: string; displayName: string }): Promise<ClientApprover> {
  return (await send<{ approver: ClientApprover }>('POST', `${base}/clients/${enc(orgId)}/approvers`, input)).approver;
}
export async function removeApprover(orgId: string, approverId: string): Promise<void> {
  await asJson(await fetch(`${base}/clients/${enc(orgId)}/approvers/${enc(approverId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })));
}
/** Mints a fresh link per active approver (replacing earlier ones). */
export async function sendApprovalLinks(orgId: string, changeSetId: string): Promise<SentApprovalLink[]> {
  return (await send<{ links: SentApprovalLink[] }>('POST', `${base}/clients/${enc(orgId)}/change-sets/${enc(changeSetId)}/approval-links`, {})).links;
}

// ── The client's campaign team (ADR 0943 P4) ──

export interface TeamEvalScore {
  suiteRef: string; runId: string; completedAt?: string;
  aggregateScore?: number; passed?: boolean; passedCount?: number; taskCount?: number;
}
export interface TeamAgent { agentId: string; label: string; eval: TeamEvalScore | null }
export interface TeamMember {
  role: TeamAgent & { description?: string; modelClass: string; teamRole: boolean };
  binding: { bindingId: string; agent: TeamAgent; model?: { provider: string; model: string } } | null;
  narrowerBindings: number;
}
export type TeamEvalsState = { available: true } | { available: false; reason: 'feature_disabled' | 'not_entitled' | 'feature_unavailable' };
export interface TeamView { members: TeamMember[]; evals: TeamEvalsState; canEdit: boolean }

export async function getTeam(orgId: string): Promise<TeamView> {
  return get<TeamView>(`/clients/${enc(orgId)}/team`);
}
/** Replace the agent a role runs as for this client (one row per role). */
export async function bindRoleAgent(orgId: string, pinnedAgentId: string, agentId: string): Promise<void> {
  await asJson<unknown>(await fetch(`${base}/clients/${enc(orgId)}/agent-bindings`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ pinnedAgentId, agentId }) })));
}
/** Go back to the role's default agent for this client. */
export async function unbindRoleAgent(orgId: string, bindingId: string): Promise<void> {
  const res = await fetch(`${base}/clients/${enc(orgId)}/agent-bindings/${enc(bindingId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson<unknown>(res);
}

// ── Client memory (ADR 0944) ──

export interface ClientNote { id: string; content: string; contentTrust: 'trusted' | 'untrusted'; authoredBy?: string; createdAt: string }
export interface ClientNoteProposal {
  proposalId: string; content: string; rationale?: string;
  status: 'pending' | 'approved' | 'rejected'; createdAt: string;
}
export interface ClientRecallEntry { id: string; content: string; contentTrust: 'trusted' | 'untrusted'; createdAt: string; expiresAt?: string }
export interface ClientMemorySources { collectionIds: string[]; available: Array<{ collectionId: string; name: string }> }
export interface ClientMemoryPurgeReport {
  notes: number; recallEntries: number; vectors: { purged: number; failed: string[] };
  receipts: number; proposals: number; snapshots: number; sources: number; complete: boolean;
}

const sendRaw = async (method: 'DELETE' | 'PUT' | 'POST', url: string, body?: unknown): Promise<Response> => {
  const res = await fetch(url, fetchOpts({ method, headers: jsonHeaders(), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
  if (!res.ok) await asJson(res);
  return res;
};

export async function listClientNotes(orgId: string): Promise<ClientNote[]> {
  return (await get<{ notes: ClientNote[] }>(`/clients/${enc(orgId)}/memory/notes`)).notes;
}
export async function addClientNote(orgId: string, content: string): Promise<void> {
  await send('POST', `${base}/clients/${enc(orgId)}/memory/notes`, { content });
}
/** `recallCleared:false` = the note is deleted but may still be recalled briefly. */
export async function removeClientNote(orgId: string, noteId: string): Promise<{ recallCleared: boolean }> {
  const res = await sendRaw('DELETE', `${base}/clients/${enc(orgId)}/memory/notes/${enc(noteId)}`);
  if (res.status === 204) return { recallCleared: true };
  const body = (await res.json()) as { recallCleared?: boolean };
  return { recallCleared: body.recallCleared !== false };
}
export async function listClientNoteProposals(orgId: string): Promise<ClientNoteProposal[]> {
  return (await get<{ proposals: ClientNoteProposal[] }>(`/clients/${enc(orgId)}/memory/proposals?status=pending`)).proposals;
}
export async function decideClientNoteProposal(orgId: string, proposalId: string, decision: 'approve' | 'reject'): Promise<void> {
  await send('POST', `${base}/clients/${enc(orgId)}/memory/proposals/${enc(proposalId)}/${decision}`, {});
}
export async function listClientRecall(orgId: string): Promise<ClientRecallEntry[]> {
  return (await get<{ entries: ClientRecallEntry[] }>(`/clients/${enc(orgId)}/memory/recall`)).entries;
}
export async function getClientMemorySources(orgId: string): Promise<ClientMemorySources> {
  return get(`/clients/${enc(orgId)}/memory/sources`);
}
export async function setClientMemorySources(orgId: string, collectionIds: string[]): Promise<string[]> {
  const res = await sendRaw('PUT', `${base}/clients/${enc(orgId)}/memory/sources`, { collectionIds });
  return ((await res.json()) as { collectionIds: string[] }).collectionIds;
}
export async function purgeClientMemory(orgId: string): Promise<ClientMemoryPurgeReport> {
  const res = await sendRaw('DELETE', `${base}/clients/${enc(orgId)}/memory`);
  return ((await res.json()) as { report: ClientMemoryPurgeReport }).report;
}
