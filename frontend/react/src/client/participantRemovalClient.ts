/**
 * ADR 0910 D12 — a live operator removes one participant from a declared default
 * workspace (`host-kicktodo`). Host-local route under `/host/openwop-app/*`.
 * `dryRun` looks the person up without changing anything, so the SPA can ask
 * for confirmation by name first.
 */
import { authedHeaders, config, fetchOpts } from './config.js';
import { ApiError } from './requestJson.js';
import { readErrorMessage } from './errorEnvelope.js';

export interface ParticipantRemoval { memberId: string; displayName: string; removed: boolean }

export async function removeParticipant(
  workspaceId: string,
  body: { member: string; reason: string; dryRun?: boolean },
): Promise<ParticipantRemoval> {
  const url = `${config.baseUrl}/host/openwop-app/workspaces/${encodeURIComponent(workspaceId)}/participant-removals`;
  const res = await fetch(url, fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) }));
  if (!res.ok) {
    let parsed: unknown;
    try { parsed = await res.json(); } catch { parsed = undefined; }
    throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, body: parsed, message: readErrorMessage(parsed) || `removeParticipant returned ${res.status}` });
  }
  return ((await res.json()) as { removal: ParticipantRemoval }).removal;
}
