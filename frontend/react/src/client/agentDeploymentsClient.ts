/**
 * ADR 1005 P3c / ADR 1014 P4b — the agent deployment console's client.
 *
 * `GET`/`POST /agents/{agentId}/deployments` (RFC 0082, RFC 0254) and the
 * operator promotion policy (`/host/openwop-app/agent-deployments/:agentId/policy`,
 * ADR 1005 D12). A host that does not advertise `agents.deployment` answers the
 * list `404`; `listDeployments` returns `null` for that, so the console can hide.
 */
import { ApiError, requestJson } from './requestJson.js';

export type DeploymentState = 'draft' | 'test' | 'staged' | 'active' | 'paused' | 'deprecated' | 'rolled-back';
export type DeploymentTransition = 'promote' | 'pause' | 'deprecate' | 'rollback' | 'adjust-canary';

export interface DeploymentRecord {
  agentId: string;
  version: string;
  state: DeploymentState;
  canaryPercent?: number;
  rollbackPointer?: string;
  channels?: string[];
  evalRunId?: string;
  transitionRunId?: string;
}

export interface PromotionPolicy {
  requiredEval?: { requiredPassScore?: number };
  approval?: { onActivate: true };
}

export interface PolicyView {
  agentId: string;
  fixed: boolean;
  revision: number;
  policy: PromotionPolicy;
}

const dep = (agentId: string): string => `/agents/${encodeURIComponent(agentId)}/deployments`;
const pol = (agentId: string): string => `/host/openwop-app/agent-deployments/${encodeURIComponent(agentId)}/policy`;

/** The agent's records, or `null` when this host does not serve deployments. */
export async function listDeployments(agentId: string): Promise<DeploymentRecord[] | null> {
  try {
    return await requestJson<DeploymentRecord[]>(dep(agentId));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Apply one transition. RFC 0254 §D: a transition an approval gate holds answers
 * `202` with the record UNCHANGED apart from `transitionRunId`, so `pending` is
 * exactly "the returned record equals the one we sent it from, ignoring that id".
 */
export async function transitionDeployment(
  agentId: string,
  prior: DeploymentRecord,
  body: { transition: DeploymentTransition; toState?: DeploymentState; channel?: string; canaryPercent?: number; evalRunId?: string; reason?: string },
): Promise<{ record: DeploymentRecord; pending: boolean }> {
  const record = await requestJson<DeploymentRecord>(dep(agentId), { method: 'POST', json: { version: prior.version, ...body } });
  return { record, pending: sameExceptRun(prior, record) };
}

function sameExceptRun(a: DeploymentRecord, b: DeploymentRecord): boolean {
  const strip = ({ transitionRunId: _ignored, ...rest }: DeploymentRecord): string => JSON.stringify(rest, Object.keys(rest).sort());
  return strip(a) === strip(b);
}

export function getPolicy(agentId: string): Promise<PolicyView> {
  return requestJson<PolicyView>(pol(agentId));
}

export function putPolicy(agentId: string, policy: PromotionPolicy, revision: number): Promise<PolicyView> {
  return requestJson<PolicyView>(pol(agentId), { method: 'PUT', json: policy, headers: { 'If-Match': `"${revision}"` } });
}
