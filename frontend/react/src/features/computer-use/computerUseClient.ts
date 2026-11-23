/**
 * Computer-use API client (ADR 1136 P3b) — the SPA half of the signed-in
 * `/host/openwop-app/computer-use/orgs/:orgId/*` read surface. The backend's
 * projection is closed: URLs arrive as origin and path only, and step labels are
 * the executor's page-derived labels, never what was typed.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const base = (orgId: string): string => `${config.baseUrl}/host/openwop-app/computer-use/orgs/${encodeURIComponent(orgId)}`;

export class ComputerUseApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function check(res: Response, ctx: string): Promise<void> {
  if (res.ok) return;
  let message = '';
  try { message = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
  throw new ComputerUseApiError(message || `${ctx} returned ${res.status}`, res.status);
}

export type SessionStatus = 'starting' | 'running' | 'awaiting_approval' | 'awaiting_takeover' | 'completed' | 'failed' | 'denied' | 'aborted';
export type ActionKind = 'screenshot' | 'scroll' | 'read' | 'click' | 'type' | 'navigate' | 'download' | 'submit' | 'credential';

export interface SessionSummary {
  sessionId: string;
  status: SessionStatus;
  task: string;
  startUrl: string;
  steps: number;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  error?: string;
}

export interface SessionStep {
  kind: ActionKind;
  tier: 'observe' | 'interact' | 'commit';
  decidedBy: 'auto' | 'human' | 'grant';
  at: string;
  url?: string;
  description: string;
}

export interface SessionDetail {
  sessionId: string;
  orgId: string;
  status: SessionStatus;
  task: string;
  startUrl: string;
  allowedOrigins: string[];
  steps: SessionStep[];
  pendingAction?: { kind: ActionKind; description: string; url?: string };
  takeover?: { n: number; reason: 'credential'; origin: string; label: string; expiresAt: string };
  resultSummary?: string;
  error?: string;
  runId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export async function listSessions(orgId: string): Promise<SessionSummary[]> {
  const res = await fetch(`${base(orgId)}/sessions`, fetchOpts({ headers: authedHeaders() }));
  await check(res, 'listSessions');
  return ((await res.json()) as { sessions: SessionSummary[] }).sessions;
}

export async function getSession(orgId: string, sessionId: string): Promise<SessionDetail> {
  const res = await fetch(`${base(orgId)}/sessions/${encodeURIComponent(sessionId)}`, fetchOpts({ headers: authedHeaders() }));
  await check(res, 'getSession');
  return ((await res.json()) as { session: SessionDetail }).session;
}

export async function stopSession(orgId: string, sessionId: string): Promise<SessionDetail> {
  const res = await fetch(`${base(orgId)}/sessions/${encodeURIComponent(sessionId)}/abort`, fetchOpts({
    method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: '{}',
  }));
  await check(res, 'stopSession');
  return ((await res.json()) as { session: SessionDetail }).session;
}

/** Live statuses: the session still holds a browser and can be stopped. */
export const isLiveStatus = (s: SessionStatus): boolean =>
  s === 'starting' || s === 'running' || s === 'awaiting_approval' || s === 'awaiting_takeover';

/** The host of a shown URL, or '' for anything that is not one. */
export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try { return new URL(url).host; } catch { return ''; }
}
