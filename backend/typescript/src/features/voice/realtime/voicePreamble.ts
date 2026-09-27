/**
 * Voice preamble digest (ADR 0199 Phase 2) — the agent-context block appended
 * to a realtime session's instructions. Voice legitimately differs from text
 * here: mid-speech tool round-trips are clumsy, so a compact preamble of the
 * agent's standing work makes "what's on my plate?" answerable without a tool
 * call.
 *
 * ADR 0277 P2 — the memory/knowledge digest MOVED OUT of this preamble into
 * `composeChatContext` (the one owner of "what an agent knows"), which now
 * composes the agent's bound KBs + memory for TEXT and VOICE alike with the
 * same seed. Composing it here too would inject the same retrieval twice into
 * one instructions payload. What remains is the voice-specific work snapshot:
 * the roster entry's workflow portfolio (RFC 0086), `listJobsByRoster`
 * schedules, and the rosterId-bound kanban boards' open-card count.
 * Every part is fail-soft: a miss contributes nothing and never blocks voice.
 */
import { resolveAgentIdentity, type AgentIdentity } from '../../../host/agentIdentity.js';
import type { RosterEntry } from '../../../host/rosterService.js';
import { listJobsByRoster } from '../../../host/schedulingService.js';
import { listBoards, listCards, isTerminalColumn } from '../../../host/kanbanService.js';

const MAX_PORTFOLIO_LINES = 5;
const MAX_SCHEDULE_LINES = 3;

export interface VoicePreambleDeps {
  /** Resolve a workflowId to its display name (null ⇒ fall back to the id). */
  getWorkflowName: (workflowId: string) => Promise<string | null>;
}

async function workSnapshotBlock(deps: VoicePreambleDeps, tenantId: string, identity: AgentIdentity): Promise<string> {
  const entry: RosterEntry | null = identity.entry ?? null;
  if (!entry) return '';
  const lines: string[] = [];

  // Standing portfolio — the workflows this member owns (names, capped).
  const workflowIds = (entry.workflows ?? []).slice(0, MAX_PORTFOLIO_LINES);
  if (workflowIds.length > 0) {
    const names = await Promise.all(workflowIds.map(async (id) => (await deps.getWorkflowName(id).catch(() => null)) ?? id));
    lines.push(`Your workflow portfolio: ${names.join('; ')}${(entry.workflows?.length ?? 0) > MAX_PORTFOLIO_LINES ? ` (+${entry.workflows.length - MAX_PORTFOLIO_LINES} more)` : ''}.`);
  }

  // Upcoming schedules (label + next fire, capped).
  try {
    const jobs = await listJobsByRoster(tenantId, entry.rosterId);
    const upcoming = jobs
      .slice(0, MAX_SCHEDULE_LINES)
      .map((j) => `${j.workflowId ?? j.jobId} (${j.cronExpr})`);
    if (upcoming.length > 0) lines.push(`Your schedules: ${upcoming.join('; ')}.`);
  } catch { /* no schedule block */ }

  // Open task count on the boards bound to this roster member.
  try {
    const boards = (await listBoards(tenantId)).filter((b) => b.rosterId === entry.rosterId);
    let open = 0;
    for (const b of boards) {
      const cards = await listCards(b.id);
      open += cards.filter((c) => !isTerminalColumn(b, c.columnId)).length;
    }
    if (open > 0) lines.push(`Open tasks on your board${boards.length > 1 ? 's' : ''}: ${open}.`);
  } catch { /* no task block */ }

  return lines.length > 0 ? `About your current work:\n${lines.join('\n')}` : '';
}

/**
 * Compose the preamble for a scoped agent: the work snapshot (the memory/
 * knowledge digest moved into `composeChatContext`, ADR 0277 P2). Empty
 * string when nothing applies (unscoped session, no roster entry).
 */
export async function composeVoicePreamble(
  deps: VoicePreambleDeps,
  tenantId: string,
  agentId: string | undefined,
): Promise<string> {
  if (!agentId) return '';
  // Session-mint time (once per session) — the reverse roster scan is acceptable here.
  const identity = await resolveAgentIdentity(tenantId, agentId, { allowReverseScan: true });
  return workSnapshotBlock(deps, tenantId, identity);
}
