/**
 * Campaign playbooks API client (ADR 0959 P5) — the Playbooks tab's reads and rollout actions
 * under `/host/openwop-app/campaign-playbooks/*`. The rollout's ONE decision lives on the shared
 * approvals surface (the Reviews inbox); this page never approves.
 *
 * Every failure throws `PlaybooksError` with the server's own message and `details.reason`,
 * because the page shows those verbatim ("This client changed since the rollout was approved…").
 * A failed read is never returned as an empty list.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type Ring = 'canary' | 'early' | 'general' | 'held';
export type Drift = 'none' | 'edited' | 'missing';
export type TargetClass = 'clean' | 'conflicts' | 'detached';

export interface PlaybookSummary { playbookId: string; latestVersion: string; title: string; publishedAt: string; changelog: string }
export interface PlaybookVersion { playbookId: string; version: string; title: string; changelog: string; publishedAt: string; contentHash: string }
export interface Installation {
  orgId: string; playbookId: string; pinnedVersion: string; ring?: Ring; drift: Drift; workflowId?: string;
  history: Array<{ version: string; at: string }>;
}
export interface ContentItemPlan { slot: string; kind: string; action: 'add' | 'update' | 'unchanged' | 'removed'; fields: string[]; edited: boolean; locked?: string }
export interface TargetPlan {
  orgId: string; fromVersion: string; class: TargetClass; drift: Drift;
  chainDiff: { added: string[]; removed: string[]; changed: string[] };
  configDiff: { changes: Array<{ path: string; kind: 'added' | 'changed' | 'removed' }>; truncated: number };
  conflicts: Array<{ kind: string; key?: string; message: string }>;
  contentDiff: ContentItemPlan[];
}
export type TargetStatus = 'pending' | 'applying' | 'applied' | 'rolled_back';
export interface Rollout {
  rolloutId: string; playbookId: string; toVersion: string; plan: TargetPlan[];
  status: 'awaiting_approval' | 'approved' | 'rejected' | 'closed' | 'halted' | 'completed';
  approvalId: string; createdAt: string; closedReason?: string; haltReason?: string; haltedOrgIds?: string[];
  mode?: 'targets' | 'rings'; rings?: Array<{ name: Ring; orgIds: string[]; soakHours: number; openedAt?: string }>; ringIndex?: number;
  targets: Record<string, { status: TargetStatus; at?: string }>;
}

export class PlaybooksError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
    this.name = 'PlaybooksError';
  }
}

const base = `${config.baseUrl}/host/openwop-app/campaign-playbooks`;
const enc = encodeURIComponent;

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = '';
    let reason: string | undefined;
    try {
      const body = (await res.json()) as { message?: string; details?: { reason?: string; code?: string } };
      message = body?.message ?? '';
      reason = body?.details?.reason ?? body?.details?.code;
    } catch { /* non-JSON body */ }
    throw new PlaybooksError(message, res.status, reason);
  }
  return (await res.json()) as T;
}
const get = async <T>(path: string): Promise<T> => asJson<T>(await fetch(`${base}${path}`, fetchOpts({ headers: authedHeaders() })));
const send = async <T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> =>
  asJson<T>(await fetch(`${base}${path}`, fetchOpts({ method, headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) })));

export async function listPlaybooks(): Promise<PlaybookSummary[]> {
  return (await get<{ playbooks: PlaybookSummary[] }>('/playbooks')).playbooks;
}
export async function listVersions(playbookId: string): Promise<PlaybookVersion[]> {
  return (await get<{ versions: PlaybookVersion[] }>(`/playbooks/${enc(playbookId)}/versions`)).versions;
}
export async function listInstallations(playbookId: string): Promise<Installation[]> {
  return (await get<{ installations: Installation[] }>(`/playbooks/${enc(playbookId)}/installations`)).installations;
}
export async function setRing(orgId: string, playbookId: string, ring: Ring): Promise<void> {
  await send('PUT', `/clients/${enc(orgId)}/installs/${enc(playbookId)}/ring`, { ring });
}
export async function listRollouts(playbookId: string): Promise<Rollout[]> {
  return (await get<{ rollouts: Rollout[] }>(`/playbooks/${enc(playbookId)}/rollouts`)).rollouts;
}
export type RolloutScope = { orgIds: string[] } | { rings: true };
export async function planRollout(playbookId: string, toVersion: string, orgIds: string[]): Promise<TargetPlan[]> {
  return (await send<{ plan: TargetPlan[] }>('POST', `/playbooks/${enc(playbookId)}/rollouts/plan`, { toVersion, orgIds })).plan;
}
export async function requestRollout(playbookId: string, toVersion: string, scope: RolloutScope): Promise<Rollout> {
  return (await send<{ rollout: Rollout }>('POST', `/playbooks/${enc(playbookId)}/rollouts`, { toVersion, ...scope })).rollout;
}
export async function applyTarget(rolloutId: string, orgId: string, overwrite: boolean): Promise<void> {
  const result = await send<{ content?: { failed: Array<{ message: string }> } }>('POST', `/rollouts/${enc(rolloutId)}/targets/${enc(orgId)}/apply`, overwrite ? { overwrite: true } : {});
  if (result.content?.failed.length) throw new PlaybooksError(result.content.failed.map((f) => f.message).join(' '), 409, 'content_partial');
}
export async function rollbackTarget(rolloutId: string, orgId: string): Promise<void> {
  await send('POST', `/rollouts/${enc(rolloutId)}/targets/${enc(orgId)}/rollback`, {});
}
export async function applyRing(rolloutId: string): Promise<{ applied: string[]; manual: Array<{ orgId: string; class: TargetClass }>; failed: Array<{ orgId: string; reason: string }> }> {
  return send('POST', `/rollouts/${enc(rolloutId)}/apply-ring`, {});
}
export async function advanceRollout(rolloutId: string): Promise<void> {
  await send('POST', `/rollouts/${enc(rolloutId)}/advance`, {});
}
