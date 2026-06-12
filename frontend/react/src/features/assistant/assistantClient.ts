/**
 * Executive Assistant feature client (host-extension, non-normative).
 *
 * Trimmed to the perception-loop API after the standalone /assistant page was
 * removed and the Chief of Staff became a real roster agent (ADR 0023
 * § Correction): the loop manager (RecurringTasksPanel) is the only consumer.
 * The graph/briefing/health/approval client functions the old page used were
 * dead and are gone — approvals live on the single loop (the "Waiting on me"
 * lane), the briefing posts to Notifications, the graph is the loops' substrate.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

// NOTE (merge 2026-06-12): origin/main re-added Project/Commitment/PendingAction
// client interfaces here (incl. #171's `Commitment.driftsFromSource`). They were
// the deleted /assistant page's types and have NO consumer after the
// consolidation (the page is gone; approvals render via approvalsClient's
// AssistantActionView, the drift flag lives on the backend Commitment). Dropped
// to avoid resurrecting the dead EA client surface — the backend behaviour
// (#171 drift/dismiss) is untouched.
const base = `${config.baseUrl}/v1/host/sample/assistant`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

// ── Perception loops (ADR 0023 §12 T2) — the Chief of Staff's recurring tasks ──

export interface AssistantLoop {
  loopId: string;
  label: string;
  description: string;
  enabled: boolean;
  cronExpr?: string;
  lastRunAt?: string;
  lastRunId?: string;
  nextFireAt?: number;
}

export async function listLoops(): Promise<AssistantLoop[]> {
  const res = await fetch(`${base}/loops`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ loops: AssistantLoop[] }>(res, 'listLoops')).loops;
}

export async function setLoopEnabled(loopId: string, enabled: boolean): Promise<void> {
  const res = await fetch(
    `${base}/loops/${encodeURIComponent(loopId)}/${enabled ? 'enable' : 'disable'}`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: '{}' }),
  );
  if (!res.ok) throw new Error(`setLoopEnabled returned ${res.status}`);
}

// ── Health (ADR 0029 / §12 T8) — the Chief of Staff's operating metrics ──
// Surfaced on the agent workspace page (role-gated), reusing the existing
// superadmin-gated endpoint. Resolves null on 403 so the panel stays hidden
// for non-admins rather than erroring.

export interface AssistantHealth {
  generatedAt: string;
  actions: {
    pending: number;
    approved: number;
    rejected: number;
    sent: number;
    failed: number;
    approvalRate: number | null;
    editRate: number | null;
    citationCoverage: number | null;
    taintedShare: number | null;
  };
  commitments: { open: number; stale: number; citationCoverage: number | null };
  loops: { loopId: string; label: string; enabled: boolean }[];
}

export async function getAssistantHealth(): Promise<AssistantHealth | null> {
  const res = await fetch(`${base}/health`, fetchOpts({ headers: authedHeaders() }));
  if (res.status === 403) return null; // admin-only — hide the panel, don't error
  return (await asJson<{ health: AssistantHealth }>(res, 'getAssistantHealth')).health;
}
