/**
 * ADR 0924 D5 — the client approver's one call: the decision on the change set
 * their link names. Public (no session); the token is the authority. Kept apart
 * from `campaignOpsClient.ts` so the public page's chunk stays small.
 */
import { config } from '../../client/config.js';

export type PortalFailure = 'gone' | 'stale' | 'rate_limited' | 'failed';

export class PortalDecisionError extends Error {
  constructor(readonly kind: PortalFailure) { super(kind); this.name = 'PortalDecisionError'; }
}

export async function decideApproval(token: string, input: { action: 'approve' | 'reject'; expectedChangeSetHash: string; comment?: string }): Promise<'approved' | 'rejected'> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/host/openwop-app/public-campaign-approval/${encodeURIComponent(token)}/decision`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    throw new PortalDecisionError('failed');
  }
  if (res.ok) return ((await res.json()) as { status: 'approved' | 'rejected' }).status;
  if (res.status === 404) throw new PortalDecisionError('gone');
  if (res.status === 409) throw new PortalDecisionError('stale');
  if (res.status === 429) throw new PortalDecisionError('rate_limited');
  throw new PortalDecisionError('failed');
}
