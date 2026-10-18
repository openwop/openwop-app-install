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

/** `aborted` (ADR 0894 D4/D8) — ended by the host or a person, not by the
 *  provider: the opener lost authority, the toggle went off, the wall-clock
 *  ceiling passed, or someone pressed stop. `error` names which. */
export type CuSessionStatus = 'starting' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'denied' | 'aborted';

export interface CuStep {
  action: CuAction;
  tier: CuTier;
  /** `auto` = low-risk tier auto-advance; `human` = a person approved this
   *  commit; `grant` = an ADR 0541 apply grant authorised it. The third value is
   *  NOT cosmetic: collapsing it into `auto` would make a granted submission
   *  indistinguishable from an observe step in the trajectory, and D5 requires a
   *  user to be able to answer "what did it submit, under what authority". */
  decidedBy: 'auto' | 'human' | 'grant';
  /** ADR 0894 D3 — on a `human` step, the approval interrupt whose recorded
   *  resolution authorised it (the run's `interrupt.resolved` event names the
   *  same id). Absent on `auto`/`grant` steps. */
  approvalInterruptId?: string;
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
  /** ADR 0894 D3 — approval interrupts already spent on this session. An
   *  approval authorises ONE action once; a provider that re-issues an action id
   *  cannot ride an old approval. */
  consumedApprovals?: string[];
  /** The person who opened the session (`scope.actingUserId`, ADR 0894 D1) —
   *  the only subject who may decide it, and whose authority every advance
   *  rechecks. */
  createdBy: string;
  /** ADR 0894 (grade-ux CU2UX-2) — the run that opened the session. A session
   *  lives inside its run: when that run ends (completed, failed, cancelled),
   *  a still-live session is ended with it, so cancelling the run IS stop. */
  runId?: string;
  /** Polls that found the provider still working (no action yet). The decide
   *  node waits between them on a timer keyed by this count, so each wait has a
   *  fresh, durable key (grade-code CU2CD-1). */
  idleRounds?: number;
  /** Write revision — every service write is a compare-and-swap on it, so an
   *  abort is never overwritten by an in-flight advance, and one approval
   *  cannot be spent twice by two concurrent decides (grade-code CU2CD-3/4). */
  rev?: number;
  createdAt: string;
  updatedAt: string;
}

export const sessions = new DurableCollection<CuSession>(
  'computer-use:session',
  (s) => `${s.tenantId}:${s.sessionId}`,
  undefined,
  (s) => s.tenantId,
);

/** The submit-once key. ADR 0894 D2 — it includes the OPENER and the apply
 *  context: without them two people's identical tasks resolved to one session,
 *  and the second person advanced the first person's browser under the first
 *  person's grant. */
export function requestHashFor(input: {
  orgId: string; task: string; startUrl: string; allowedOrigins: string[]; createdBy: string; applyContext?: CuSession['applyContext'];
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      orgId: input.orgId, task: input.task, startUrl: input.startUrl, allowedOrigins: [...input.allowedOrigins].sort(),
      createdBy: input.createdBy,
      applyContext: input.applyContext ? [input.applyContext.subjectId, input.applyContext.campaignId, input.applyContext.tier] : null,
    }))
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

/**
 * The compare-and-swap write every lifecycle transition uses. Applies `next`
 * only if the stored row is still at `prev`'s revision; returns the written row,
 * or null when another writer moved it first (the caller must stop and re-read,
 * never retry blindly: the other writer may have ended the session).
 */
export async function writeSession(prev: CuSession, next: CuSession): Promise<CuSession | null> {
  const current = await sessions.get(`${prev.tenantId}:${prev.sessionId}`);
  if (!current || (current.rev ?? 0) !== (prev.rev ?? 0)) return null;
  const written: CuSession = { ...next, rev: (prev.rev ?? 0) + 1, updatedAt: new Date().toISOString() };
  return (await sessions.compareAndSwap(current, written)) ? written : null;
}

/** Unconditional write — for the eraser only, which rewrites content and must
 *  land whatever state the row is in. Lifecycle code uses `writeSession`. */
export async function putSession(row: CuSession): Promise<void> {
  await sessions.put({ ...row, updatedAt: new Date().toISOString() });
}

export async function listSessions(tenantId: string): Promise<CuSession[]> {
  return sessions.listForTenantIndexed(tenantId);
}
