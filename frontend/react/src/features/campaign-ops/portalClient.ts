/**
 * ADR 0924 D5 — the client approver's one call: the decision on the change set
 * their link names. Public (no account); the token is the authority. ADR 0924 P2c:
 * the browser session rides (`fetchOpts`, as the shared viewer does), because a
 * recipient-bound link decides only for the session that verified it. Kept apart
 * from `campaignOpsClient.ts` so the public page's chunk stays small.
 */
import { config, fetchOpts } from '../../client/config.js';

/** ADR 0924 P2c — `verify`: the link is recipient-bound and this browser's
 *  verification lapsed (401 from ADR 1141); a reload asks for a new code.
 *  `locked`: too many wrong codes locked the link (423); a reload does NOT help,
 *  only a new link from the agency does. */
export type PortalFailure = 'gone' | 'stale' | 'rate_limited' | 'verify' | 'locked' | 'failed';

export class PortalDecisionError extends Error {
  constructor(readonly kind: PortalFailure) { super(kind); this.name = 'PortalDecisionError'; }
}

export async function decideApproval(token: string, input: { action: 'approve' | 'reject'; expectedChangeSetHash: string; comment?: string }): Promise<'approved' | 'rejected'> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/host/openwop-app/public-campaign-approval/${encodeURIComponent(token)}/decision`, fetchOpts({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }));
  } catch {
    throw new PortalDecisionError('failed');
  }
  if (res.ok) return ((await res.json()) as { status: 'approved' | 'rejected' }).status;
  if (res.status === 404) throw new PortalDecisionError('gone');
  if (res.status === 401) throw new PortalDecisionError('verify');
  if (res.status === 423) throw new PortalDecisionError('locked');
  if (res.status === 409) throw new PortalDecisionError('stale');
  if (res.status === 429) throw new PortalDecisionError('rate_limited');
  throw new PortalDecisionError('failed');
}
