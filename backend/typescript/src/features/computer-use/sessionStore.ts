/**
 * ADR 0418 P1 — the durable computer-use session rows. Submit-once discipline
 * mirrors creative-video: a requestHash-keyed CAS claim gates provider
 * submission, so a re-run/fork with identical inputs resolves the EXISTING
 * session and never re-drives a browser. Steps are the recorded trajectory —
 * replay reads them; nothing re-executes.
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import type { CuAction, CuTier } from './adapter.js';

export type CuSessionStatus = 'starting' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'denied';

export interface CuStep {
  action: CuAction;
  tier: CuTier;
  /** `auto` = low-risk tier auto-advance; `human` = a person approved this
   *  commit; `grant` = an ADR 0541 apply grant authorised it. The third value is
   *  NOT cosmetic: collapsing it into `auto` would make a granted submission
   *  indistinguishable from an observe step in the trajectory, and D5 requires a
   *  user to be able to answer "what did it submit, under what authority". */
  decidedBy: 'auto' | 'human' | 'grant';
  at: string;
}

export interface CuSession {
  sessionId: string;
  tenantId: string;
  orgId: string;
  requestHash: string;
  status: CuSessionStatus;
  task: string;
  startUrl: string;
  /** The fail-closed origin allowlist (https origins) fixed at start. */
  allowedOrigins: string[];
  providerSessionId?: string;
  steps: CuStep[];
  /** Set while `awaiting_approval` — the commit-tier action needing a human. */
  pendingAction?: CuAction;
  /**
   * ADR 0541 D2 — the apply-grant context, set ONLY by a job-search campaign.
   *
   * Its absence is what keeps the gate exactly as strong as it was for every
   * other caller: with no context there is nothing to consult, so the commit
   * tier halts for a human as it always has. A session cannot acquire this by
   * accident — a caller has to pass it deliberately.
   */
  applyContext?: {
    subjectId: string;
    campaignId: string;
    /** Which submission tier this session is driving. 'C' is never grantable. */
    tier: 'A' | 'B' | 'C';
    /** Set on a replayed/forked session. The grant refuses outright (D4). */
    isReplay?: boolean;
  };
  resultSummary?: string;
  error?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const sessions = new DurableCollection<CuSession>(
  'computer-use:session',
  (s) => `${s.tenantId}:${s.sessionId}`,
  undefined,
  (s) => s.tenantId,
);

export function requestHashFor(input: { orgId: string; task: string; startUrl: string; allowedOrigins: string[] }): string {
  return createHash('sha256')
    .update(JSON.stringify({ orgId: input.orgId, task: input.task, startUrl: input.startUrl, allowedOrigins: [...input.allowedOrigins].sort() }))
    .digest('hex');
}

export const sessionIdFor = (tenantId: string, requestHash: string): string => `cu:${createHash('sha256').update(`${tenantId}|${requestHash}`).digest('hex').slice(0, 24)}`;

export async function getSession(tenantId: string, sessionId: string): Promise<CuSession | null> {
  const s = await sessions.get(`${tenantId}:${sessionId}`);
  return s && s.tenantId === tenantId ? s : null;
}

/** Insert-if-absent claim (the submit-once CAS). Returns the winner's fresh row
 *  or the pre-existing row. */
export async function claimSession(row: CuSession): Promise<{ outcome: 'claimed' | 'exists'; session: CuSession }> {
  const key = `${row.tenantId}:${row.sessionId}`;
  const existing = await sessions.get(key);
  if (existing) return { outcome: 'exists', session: existing };
  const won = await sessions.compareAndSwap(null, row);
  if (won) return { outcome: 'claimed', session: row };
  const after = await sessions.get(key);
  return after ? { outcome: 'exists', session: after } : { outcome: 'claimed', session: row };
}

export async function putSession(row: CuSession): Promise<void> {
  await sessions.put({ ...row, updatedAt: new Date().toISOString() });
}

export async function listSessions(tenantId: string): Promise<CuSession[]> {
  return sessions.listForTenantIndexed(tenantId);
}
