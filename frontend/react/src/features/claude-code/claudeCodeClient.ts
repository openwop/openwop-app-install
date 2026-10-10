/**
 * Claude Code API client (ADR 0785 P1) — the SPA half of the signed-in
 * `/host/openwop-app/claude-code/*` host-extension surface. The companion's
 * public device routes are not called from the SPA.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const base = `${config.baseUrl}/host/openwop-app/claude-code`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/** A failed call, carrying the status so a page can tell "expired code" from "broken". */
export class ClaudeCodeApiError extends Error {
  /** `feature` is set when the 404 is the feature gate (the toggle or the operator
   *  gate), not the resource — the backend stamps `details.feature` on those. */
  constructor(message: string, readonly status: number, readonly reason?: string, readonly feature?: string) { super(message); }
}

async function check(res: Response, ctx: string): Promise<void> {
  if (res.ok) return;
  let message = '';
  let reason: string | undefined;
  let feature: string | undefined;
  try {
    const body = (await res.json()) as { message?: string; details?: { reason?: string; feature?: string } };
    message = body?.message ?? '';
    reason = body?.details?.reason;
    feature = body?.details?.feature;
  } catch { /* non-JSON */ }
  throw new ClaudeCodeApiError(message || `${ctx} returned ${res.status}`, res.status, reason, feature);
}

export interface ConsentText {
  version: string;
  quote: string;
  source: string;
  fetchedAt: string;
  acknowledgements: string[];
}

export interface PairRequest {
  userCode: string;
  label: string;
  platform: string;
  /** The address the companion started from, and when (phishing context). */
  requestedFrom: string;
  createdAt: string;
  expiresAt: string;
}

export interface PairRequestView {
  request: PairRequest;
  /** The workspace the approval mints the device's key in (the caller's active one). */
  workspaceId: string;
  consent: ConsentText;
  consentHash: string;
}

export interface DeviceView {
  deviceId: string;
  tenantId: string;
  subject: string;
  label: string;
  platform: string;
  createdAt: string;
  consentVersion: string;
  consentHash: string;
  status: 'active' | 'revoked' | 'expired';
  expiresAt?: string;
  lastUsedAt?: string;
  /** Whether the companion currently holds its device socket (ADR 0785 P2). */
  online?: boolean;
  /** ADR 0785 D7 — the owner's per-device opt-in to workflow tasks. Absent = off. */
  workflowTasks?: { enabledAt: string; enabledBy: string };
}

export interface TerminalSession {
  sessionId: string;
  deviceId: string;
  status: 'opening' | 'running' | 'exited';
  title: string;
  createdAt: string;
  exitCode?: number | null;
}

/** The caller's own terminal sessions in this workspace (newest first). */
export async function listTerminals(): Promise<TerminalSession[]> {
  const res = await fetch(`${base}/terminals`, fetchOpts({ headers: authedHeaders() }));
  await check(res, 'terminals');
  return ((await res.json()) as { terminals: TerminalSession[] }).terminals;
}

export async function openTerminal(input: { deviceId: string; cols: number; rows: number; prompt?: string; title?: string; approveFromAnywhere?: boolean }): Promise<TerminalSession> {
  const res = await fetch(`${base}/terminals`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  await check(res, 'open terminal');
  return ((await res.json()) as { terminal: TerminalSession }).terminal;
}

export async function mintTerminalTicket(sessionId: string): Promise<{ ticket: string; path: string }> {
  const res = await fetch(`${base}/terminals/${encodeURIComponent(sessionId)}/ticket`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  await check(res, 'terminal ticket');
  return (await res.json()) as { ticket: string; path: string };
}

export async function stopTerminal(sessionId: string): Promise<void> {
  const res = await fetch(`${base}/terminals/${encodeURIComponent(sessionId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  await check(res, 'stop terminal');
}

export async function getPairRequest(userCode: string): Promise<PairRequestView> {
  const res = await fetch(`${base}/pair/requests/${encodeURIComponent(userCode)}`, fetchOpts({ headers: authedHeaders() }));
  await check(res, 'pair request');
  return (await res.json()) as PairRequestView;
}

export async function approvePairRequest(userCode: string, consentHash: string): Promise<void> {
  const res = await fetch(`${base}/pair/requests/${encodeURIComponent(userCode)}/approve`, fetchOpts({
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ consentHash }),
  }));
  await check(res, 'approve');
}

export async function denyPairRequest(userCode: string): Promise<void> {
  const res = await fetch(`${base}/pair/requests/${encodeURIComponent(userCode)}/deny`, fetchOpts({
    method: 'POST', headers: jsonHeaders(),
  }));
  await check(res, 'deny');
}

export async function listDevices(): Promise<DeviceView[]> {
  const res = await fetch(`${base}/devices`, fetchOpts({ headers: authedHeaders() }));
  await check(res, 'devices');
  return ((await res.json()) as { devices: DeviceView[] }).devices;
}

/** ADR 0785 D7 — let (or stop letting) workflows send tasks to one of your devices. */
export async function setWorkflowTasks(deviceId: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${base}/devices/${encodeURIComponent(deviceId)}/workflow-tasks`, fetchOpts({
    method: 'PUT', headers: { ...authedHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
  }));
  await check(res, 'workflowTasks');
}

export async function revokeDevice(deviceId: string): Promise<void> {
  const res = await fetch(`${base}/devices/${encodeURIComponent(deviceId)}`, fetchOpts({
    method: 'DELETE', headers: authedHeaders(),
  }));
  await check(res, 'revoke');
}
