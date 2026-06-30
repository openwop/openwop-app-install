/**
 * ADR 0132 Phase 5 — client for the per-conversation capability-scope surface
 * (host-extension, /v1/host/openwop-app/conversation-tools/sessions/:id/*). The
 * backend is authority (toggle + owner gating there); a 404 means the feature is
 * off or the conversation is not visible to the caller.
 */
import { authedHeaders, config, fetchOpts } from '../client/config.js';

export type ScopeMode = 'agent-default' | 'restricted';

export interface CapabilityScope {
  mode: ScopeMode;
  enabled?: string[];
  disabled?: string[];
  requireApproval?: string[];
  setBy?: string;
  setAt?: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied';
export interface ToolApproval {
  toolName: string;
  status: ApprovalStatus;
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface CapabilityScopeView {
  scope: CapabilityScope;
  approvals: ToolApproval[];
}

const base = (sessionId: string): string =>
  `${config.baseUrl}/v1/host/openwop-app/conversation-tools/sessions/${encodeURIComponent(sessionId)}`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getCapabilityScope(sessionId: string): Promise<CapabilityScopeView> {
  const res = await fetch(`${base(sessionId)}/capability-scope`, fetchOpts({ headers: authedHeaders() }));
  return asJson<CapabilityScopeView>(res, 'getCapabilityScope');
}

/** Set (or clear, with `scope: null`) the conversation's scope CONFIG. */
export async function setCapabilityScope(sessionId: string, scope: CapabilityScope | null): Promise<CapabilityScope> {
  const res = await fetch(`${base(sessionId)}/capability-scope`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ scope }) }));
  return (await asJson<{ scope: CapabilityScope }>(res, 'setCapabilityScope')).scope;
}

/** Approve or deny a pending per-tool approval. */
export async function resolveToolApproval(sessionId: string, toolName: string, decision: 'approved' | 'denied'): Promise<ToolApproval> {
  const res = await fetch(`${base(sessionId)}/approvals/${encodeURIComponent(toolName)}`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ decision }) }));
  return (await asJson<{ approval: ToolApproval }>(res, 'resolveToolApproval')).approval;
}
