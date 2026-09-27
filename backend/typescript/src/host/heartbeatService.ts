/**
 * Agent heartbeat — shared logic + background daemon (RFC 0086, best-effort).
 *
 * The heartbeat is the agent "pull": pick the first eligible To Do card on the
 * member's board(s) and start its workflow, attributing the run to the named
 * agent. `runHeartbeatOnce` is the single implementation used by BOTH the
 * manual "Check now" route (routes/agentOps.ts) and the background daemon, so
 * the two can never drift.
 *
 * Previously the heartbeat was manual-only (a "Check now" POST). The daemon
 * makes it autonomous for members that opt in via `heartbeatIntervalMs > 0`:
 * each instance polls, and a per-(roster, slot) `claimOnce` guard makes
 * the pull fire once across the max=10 fleet (same posture as scheduleDaemon).
 * Members with no interval set are untouched — manual pull only, as before.
 *
 * ADR 0535 D1a — the pass also RECONCILES before it picks: a card left in
 * Working by a run that died with nobody listening (the P1 fan-out is
 * in-process, so a process that dies mid-terminal-emit notifies no one) is
 * returned to To Do first, using the card list this pass already holds. That is
 * what makes ADR 0535's durability claim true rather than best-effort; without
 * it the residue would be a permanent strand instead of a one-interval lag.
 *
 * @see src/routes/agentOps.ts — the manual "Check now" surface
 * @see src/host/cardRunRecovery.ts — the restore + reconcile it delegates to
 * @see src/host/scheduleDaemon.ts — the sibling time-based daemon
 * @see RFCS/0086-standing-agent-roster-and-workflow-portfolio.md
 */

import type { StartRunDeps } from './runStarter.js';
import { runUnderWorkerContract } from '../storage/eventEraAdapter.js';
import { startWorkflowRun } from './runStarter.js';
import { listRoster, recordHeartbeat, autonomyOf, type RosterEntry } from './rosterService.js';
import { resolveConnectionReadiness } from './connectionReadiness.js';
import { resolveAgentPolicy } from './agentPolicyResolver.js';
import { getAgentProfile } from './agentProfileService.js';
import { listBoardsForSubject, listCards, moveCard, setCardLastRun, notifyBoardChanged, type KanbanCard } from './kanbanService.js';
import { reconcileStrandedCards } from './cardRunRecovery.js';
import { createApproval, hasPendingApprovalForCard } from './approvalService.js';
import { emitEscalationNotifications } from './escalationNotify.js';
import { checkAutonomousRunBudget, runBudgetConfigWithLimit } from './runBudgetService.js';
import { getInstanceId } from './instanceId.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('heartbeatService');

const POLL_INTERVAL_MS = 30_000;
/** Most members auto-checked per pass (backstop against a large fleet flooding
 *  the dispatcher in one tick). */
const CHECK_BATCH = 50;
/** Per-(roster, slot) claim keys are only needed for the concurrent-poll
 *  window; prune older ones each tick so the idempotency table stays bounded. */
const CLAIM_KEY_PREFIX = 'heartbeat:';
const CLAIM_PRUNE_AGE_MS = 10 * 60_000;

export interface HeartbeatResult {
  picked: boolean;
  /**
   * ADR 0534 D6 — why nothing was picked. `no_eligible_tasks` conflated four
   * distinct causes ("the board is empty", "every card is policy-denied", "the
   * run budget is spent", "nothing carries a runnable workflow"), so every
   * consumer had to re-derive the suppression rules. The server names the cause
   * instead. `no_eligible_tasks` is retained as the catch-all so existing
   * consumers keep working.
   */
  reason?:
    | 'paused'
    | 'no_boards'
    | 'empty_board'
    | 'no_runnable_workflow'
    | 'policy_denied'
    | 'awaiting_approval'
    | 'no_eligible_tasks';
  boardId?: string;
  cardId?: string;
  cardTitle?: string;
  runId?: string;
  persona?: string;
  lastHeartbeatAt?: string;
  /** review-mode: the run was NOT started — a pending approval was queued. */
  proposed?: boolean;
  approvalId?: string;
}

/**
 * Run one heartbeat for an already-resolved, enabled roster member: stamp the
 * last-checked time, then claim the first To Do card carrying a runnable
 * workflow, start its run (attributed to the agent), and move it to Working.
 * Returns what was picked (or why nothing was). The caller is responsible for
 * tenant/existence checks and the `enabled` gate.
 */
export async function runHeartbeatOnce(deps: StartRunDeps, entry: RosterEntry): Promise<HeartbeatResult> {
  // The heartbeat ran — stamp "last checked" regardless of whether a card gets
  // picked up, so the UI can show how recently the agent looked.
  const heartbeatEntry = await recordHeartbeat(entry.tenantId, entry.rosterId);
  const lastHeartbeatAt = heartbeatEntry?.lastHeartbeatAt;

  const boards = await listBoardsForSubject(entry.tenantId, { kind: 'agent', id: entry.rosterId });
  // CS-XC-3 — readiness + profile are per-ENTRY (tenant, rosterId), not
  // per-card; they were re-resolved inside the card loop (2 reads × N cards).
  const readiness = await resolveConnectionReadiness(entry.tenantId, entry.rosterId);
  const profile = await getAgentProfile(entry.tenantId, entry.rosterId);
  // One clock for the whole pass: the reconcile and the ranking below must not
  // disagree about "now", or a card could be restored and then ranked against a
  // marginally different instant.
  const passNow = Date.now();
  // ADR 0534 D6 — remember the most specific reason a candidate was passed over,
  // so an empty result can NAME its cause instead of returning the catch-all.
  // Ordered by how actionable each is to a human reading it.
  let skipCause: HeartbeatResult['reason'] | undefined;
  const noteCause = (cause: NonNullable<HeartbeatResult['reason']>): void => {
    const rank: Record<string, number> = {
      awaiting_approval: 4, policy_denied: 3, no_runnable_workflow: 2, empty_board: 1,
    };
    if (!skipCause || (rank[cause] ?? 0) > (rank[skipCause] ?? 0)) skipCause = cause;
  };
  if (boards.length === 0) return { picked: false, reason: 'no_boards', lastHeartbeatAt };
  for (const board of boards) {
    const todoColumn = board.columns.find((c) => c.id === 'todo' || c.name.toLowerCase() === 'to do');
    if (!todoColumn) continue;
    const allCards = await listCards(board.id);
    // ADR 0535 D1a — reconcile BEFORE filtering to To Do. The P1 run-terminal
    // fan-out is in-process, so a run whose process died mid-terminal-emit
    // strands its card with nobody to hear it. This pass already holds every
    // card on the board, so restoring the stranded ones costs no extra scan —
    // only a point `getRun` per card actually sitting in Working. Doing it
    // first means a card freed this tick is eligible for THIS pick, not the
    // next one. Best-effort: a reconcile failure must never stop the pick.
    let restored = 0;
    try {
      restored = await reconcileStrandedCards(deps.storage, board, allCards);
    } catch (err) {
      log.warn('stranded-card reconcile failed; continuing to pick', {
        boardId: board.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Re-read ONLY when a restore actually moved something. Re-listing
    // unconditionally would double the full-collection scan on every tick of
    // every board — the hot-path cost ADR 0534 D5 budgets against — to refresh
    // a list that is unchanged in the overwhelmingly common case.
    const boardCards = restored > 0 ? await listCards(board.id) : allCards;
    const candidates = boardCards.filter((c) => c.columnId === todoColumn.id);
    // ADR 0534 P2 — rank the candidates when a compiler is registered. Absent,
    // throwing, or misbehaving ⇒ the literal pre-0534 order (insertion order),
    // never a degraded ranking.
    const cards = await orderWorkCandidates(candidates, passNow, entry.tenantId);
    if (cards.length === 0) noteCause('empty_board');
    for (const card of cards) {
      // ADR 0313 D2 — a BARE card (no card/column workflow) on an agent-owned
      // board falls back to the registered agent-turn workflow, but ALWAYS
      // through the propose gate below (a stale backlog must never
      // surprise-execute; explicit workflows keep their autonomy).
      const explicitWorkflowId = card.workflowId ?? todoColumn.triggerWorkflowId;
      const fallback = explicitWorkflowId ? null : agentTurnFallback();
      const workflowId = explicitWorkflowId ?? fallback?.workflowId;
      if (!workflowId) { noteCause('no_runnable_workflow'); continue; }
      const isBareFallback = fallback !== null;

      // "Agents propose, humans dispose": a review-mode member doesn't start the
      // run — it queues a pending approval for a human to claim. Skip cards that
      // already have one so a re-poll (or the daemon) doesn't duplicate the
      // proposal (it sits in To Do until the approval is resolved). This lives in
      // the SHARED helper so the autonomous daemon honors review mode too, not
      // just the manual "Check now" route.
      // `review` proposes EVERY pick; `guided` proposes only HIGH-priority
      // picks (routine work runs itself, high-stakes work asks first —
      // architect memo 2026-06-05; the only middle level composable from
      // real fields: card.priority + the existing approval path).
      // ADR 0036 — agentProfile policy enforcement, composed with the ADR 0033
      // §3.3 `requiredConnections` activation gate (most-restrictive wins):
      //   - `permissions.never` ⊇ workflowId → hard-deny (skip the card; the
      //     twin neither runs NOR proposes a forbidden action class);
      //   - `hitl` ⊇ workflowId → force an approval regardless of level;
      //   - un-ready required connections → force review (ADR 0033 fail-closed);
      //   - `auto` + `withinPolicyActions` allowlist → run only listed workflow
      //     ids; off-list (or empty/absent allowlist) → propose.
      // The verdict's `auto` means "permitted to auto-run"; this layer then
      // applies the existing `guided` middle-rule (run routine, propose only
      // HIGH-priority picks) on top. The action class is the card's workflowId;
      // profileId = rosterId (a profile-less / requirement-less agent is ungated
      // and behaves exactly as before).
      const policy = resolveAgentPolicy({
        profile,
        actionClass: workflowId,
        level: autonomyOf(entry),
        readiness,
      });
      // permissions.never — fail-closed: this workflow is a forbidden action
      // class for this agent. Never run it, never even queue a proposal; skip
      // the card so a human (or another agent) handles it.
      if (policy.verdict === 'deny') { noteCause('policy_denied'); continue; }
      // `review` (hitl / un-ready connection / off-allowlist) always proposes;
      // `guided` proposes only HIGH-priority picks (routine work runs itself);
      // `auto` runs immediately. The guided priority split is the heartbeat's
      // own middle-rule, layered on the resolver's per-action-class verdict.
      const mustPropose = isBareFallback // ADR 0313 D2 — fallback picks always propose
        || policy.verdict === 'review'
        || (policy.verdict === 'guided' && card.priority === 'high');
      if (mustPropose) {
        if (await hasPendingApprovalForCard(entry.tenantId, card.id)) { noteCause('awaiting_approval'); continue; }
        const approval = await createApproval({
          tenantId: entry.tenantId,
          rosterId: entry.rosterId,
          persona: entry.persona,
          workflowId,
          boardId: board.id,
          cardId: card.id,
          cardTitle: card.title,
          // ADR 0311 P2 — a chat-filed todo's approval surfaces back in its chat.
          ...(card.sourceConversationId ? { conversationId: card.sourceConversationId } : {}),
          // ADR 0313 P2 — freeze the agent-turn inputs onto the proposal so the
          // APPROVED dispatch carries them (agent-runner reads these variables;
          // the reply posts into the originating conversation when one exists).
          ...(fallback ? { configurable: {
            agentId: entry.agentRef.agentId,
            task: [card.title, card.description ?? ''].filter(Boolean).join('\n\n').slice(0, 4_000),
            credentialRef: fallback.credentialRef,
            ...(card.sourceConversationId ? { conversationId: card.sourceConversationId } : {}),
          } } : {}),
          proposal: readiness.allConfigured
            ? `Run ${workflowId} on “${card.title}”`
            : `Run ${workflowId} on “${card.title}” (held for review — missing connection${readiness.missing.length > 1 ? 's' : ''}: ${readiness.missing.join(', ')})`,
        });
        // ADR 0493 Phase 2 — ping the agent's escalation contacts that a proposal
        // needs review (best-effort; never blocks the proposal). Fires once per
        // proposal (the hasPendingApprovalForCard guard above prevents re-propose).
        if (profile?.escalation?.contacts?.length) {
          await emitEscalationNotifications({
            tenantId: entry.tenantId,
            rosterId: entry.rosterId,
            persona: entry.persona,
            contacts: profile.escalation.contacts,
            cardTitle: card.title,
            approvalId: approval.approvalId,
          });
        }
        return {
          picked: true,
          proposed: true,
          approvalId: approval.approvalId,
          boardId: board.id,
          cardId: card.id,
          cardTitle: card.title,
          persona: entry.persona,
          lastHeartbeatAt,
        };
      }

      const runId = await startWorkflowRun(deps, {
        tenantId: entry.tenantId,
        workflowId,
        metadata: {
          heartbeat: {
            rosterId: entry.rosterId,
            persona: entry.persona,
            agentId: entry.agentRef.agentId,
            boardId: board.id,
            cardId: card.id,
            source: 'heartbeat',
          },
          // ADR 0534 D3 — freeze WHY this card won at creation. `run.metadata` is
          // replayed verbatim on `:fork`, so a forked run reproduces the original
          // pick instead of re-ranking against a board that has since changed —
          // re-ranking on fork would let a replay execute a DIFFERENT card, which
          // breaks replay determinism outright. Absent when no compiler ranked
          // (toggle off, or a fail-open), so the stamp never claims a decision
          // that did not happen.
          ...(workSelectionDecisionFor(card.id)
            ? { workSelection: workSelectionStamp(card.id) }
            : {}),
        },
      });
      if (!runId) continue;
      await setCardLastRun(card.id, runId);
      // Move the picked card to Working (no re-trigger — Working has no trigger
      // workflow). Best-effort: a missing Working lane leaves the card in To Do
      // with its run already started.
      const working = board.columns.find((c) => c.id === 'working' || c.name.toLowerCase() === 'working');
      if (working) await moveCard(card.id, working.id);
      notifyBoardChanged(board.id);
      return {
        picked: true,
        boardId: board.id,
        cardId: card.id,
        cardTitle: card.title,
        runId,
        persona: entry.persona,
        lastHeartbeatAt,
      };
    }
  }
  return { picked: false, reason: skipCause ?? 'no_eligible_tasks', lastHeartbeatAt };
}

/** Whether a member is due for an autonomous heartbeat at `now`. Opt-in only
 *  (interval > 0); fires when it has never been checked or the interval elapsed
 *  since the last check. */
/* ─── ADR 0534 — work-selection seam ──────────────────────────────────────────
 *
 * Which To Do card the loop takes next is POLICY, and policy lives in a feature
 * (toggled, bucketed, variant-able) — but `heartbeatService` is core and core
 * must not import a feature. So the feature registers its compiler here at boot,
 * exactly as ADR 0318's `registerHeartbeatConfigProvider` does for cadence.
 *
 * One deliberate difference from that precedent, and it matters: 0318's provider
 * returns CONFIG, so falling open to `null` restores prior behaviour exactly.
 * This returns a DECISION, so "fail open" has to mean **the literal pre-0534
 * order** — insertion order, first runnable match — and not a degraded ranking.
 * Otherwise a broken compiler quietly becomes "rank badly", which is worse than
 * not ranking at all and far harder to notice.
 */

/** One ranked candidate. `scores` is carried verbatim for the ADR 0534 D3 run
 *  stamp and the "why this card?" affordance; core never interprets it. */
export interface WorkSelectionPick {
  card: KanbanCard;
  /** 1-based position in the ranking. */
  rank: number;
  /** The aggregate priority the ranking engine computed. */
  score: number;
  /** Per-criterion inputs behind `score`. */
  scores: Record<string, number>;
}

/**
 * Orders (never filters) the To Do candidates for one board.
 *
 * Async and tenant-aware because the policy is behind a per-tenant TOGGLE and
 * toggle resolution is async (`featureToggles/service.getEffectiveConfig`). P2
 * shipped this synchronous and tenant-less, which could not carry the feature at
 * all — corrected here rather than reading the toggle synchronously somewhere.
 *
 * Returning `null` means "not applicable" (the toggle is off for this tenant) and
 * is distinct from throwing, which means "broken". Both fall back to insertion
 * order; only the second is logged as a fault.
 */
export type WorkSelectionCompiler = (
  cards: KanbanCard[],
  now: number,
  ctx: { tenantId: string },
) => Promise<WorkSelectionPick[] | null> | WorkSelectionPick[] | null;

let workSelectionCompiler: WorkSelectionCompiler | null = null;

/** ADR 0534 fill-a-seam — the `work-selection` feature registers at boot.
 *  Unregistered ⇒ byte-identical to pre-0534. */
export function registerWorkSelectionCompiler(fn: WorkSelectionCompiler | null): void {
  workSelectionCompiler = fn;
}

/** The last ranking decision, keyed by card id, for the pass in flight. Read by
 *  the run stamp in P3; absent when no compiler ran. */
let lastPicks: Map<string, WorkSelectionPick> = new Map();

/** The ranking decision for a card in the current pass, if one was computed. */
export function workSelectionDecisionFor(cardId: string): WorkSelectionPick | undefined {
  return lastPicks.get(cardId);
}

/**
 * Rank the candidates, or return them untouched. Every failure mode — no
 * compiler, a throw, or a result that is not a permutation of the input — falls
 * back to the input order.
 *
 * The permutation check is not paranoia: the contract is ORDER, not filter, so a
 * compiler that drops a card would silently make work unreachable, which is the
 * same class of bug as the strand ADR 0535 fixes.
 */
export async function orderWorkCandidates(
  cards: KanbanCard[],
  now: number,
  tenantId: string,
): Promise<KanbanCard[]> {
  lastPicks = new Map();
  if (!workSelectionCompiler || cards.length === 0) return cards;
  try {
    const picks = await workSelectionCompiler(cards, now, { tenantId });
    if (picks === null) return cards; // toggle off for this tenant — not a fault
    if (picks.length !== cards.length) {
      log.warn('work-selection compiler did not return a permutation; using insertion order', {
        got: picks.length, expected: cards.length,
      });
      return cards;
    }
    const seen = new Set(picks.map((p) => p.card.id));
    if (seen.size !== cards.length || !cards.every((c) => seen.has(c.id))) {
      log.warn('work-selection compiler returned unknown or duplicate cards; using insertion order');
      return cards;
    }
    for (const pick of picks) lastPicks.set(pick.card.id, pick);
    return picks.map((p) => p.card);
  } catch (err) {
    log.warn('work-selection compiler threw; using insertion order', {
      error: err instanceof Error ? err.message : String(err),
    });
    return cards;
  }
}

/** The policy identifier stamped beside a decision. Set by the registering
 *  feature so core carries no policy vocabulary of its own; absent ⇒ unstamped. */
let workSelectionPolicyId: string | null = null;

/** ADR 0534 D3 — the feature declares which policy version is ranking. */
export function setWorkSelectionPolicyId(id: string | null): void {
  workSelectionPolicyId = id;
}

/** The replay-frozen form of a ranking decision. Plain JSON — `run.metadata` is
 *  read verbatim on `:fork`, so nothing here may be a live reference. */
export function workSelectionStamp(cardId: string): Record<string, unknown> | null {
  const pick = lastPicks.get(cardId);
  if (!pick) return null;
  return {
    ...(workSelectionPolicyId ? { policy: workSelectionPolicyId } : {}),
    rank: pick.rank,
    score: pick.score,
    scores: { ...pick.scores },
    /** How many candidates it was ranked against — a rank of 1 of 1 says much
     *  less than 1 of 40, and the difference is invisible without this. */
    candidates: lastPicks.size,
  };
}

/** ADR 0313 D1 — the host default cadence for members that never configured a
 *  heartbeat. Env-tunable; `0` disables the host default (opt-in only, the
 *  pre-0313 behavior). Read per call so tests can vary it. */
export const HEARTBEAT_DEFAULT_MS_ENV = 'OPENWOP_HEARTBEAT_DEFAULT_MS';
const FALLBACK_DEFAULT_MS = 600_000; // 10 minutes

/** The heartbeat sentinel meaning "deliberately OFF". ADR 0313 correction:
 *  stored `0` is NOT deliberate — the details editor always sent the field
 *  initialized to 0, so a saved-but-untouched form left 0 behind. `0` and
 *  absent therefore both mean "not configured" (the host default applies);
 *  explicit opt-out is `-1`, which the editor's "Off" option now writes. */
export const HEARTBEAT_OFF = -1;

/** ADR 0313 D2 — the agent-turn workflow the bare-card fallback dispatches.
 *  REGISTERED by the owning feature at init (scheduled-agent-chats seeds the
 *  workflow and calls this — the fill-a-seam pattern; core never imports the
 *  feature). Unregistered ⇒ no fallback: bare cards are skipped exactly as
 *  before (honest degradation when the feature is absent). */
export interface AgentTurnFallback {
  workflowId: string;
  /** The host-owned managed credential the turn runs under (the registering
   *  feature owns this constant — no cross-module literal to drift). */
  credentialRef: string;
}
let agentTurnFallbackRef: AgentTurnFallback | null = null;
export function registerAgentTurnFallback(fallback: AgentTurnFallback | null): void { agentTurnFallbackRef = fallback; }
export function agentTurnFallback(): AgentTurnFallback | null { return agentTurnFallbackRef; }

/** ADR 0318 — the resolved host-wide heartbeat admin override (the runtime-editable
 *  layer ABOVE the `OPENWOP_HEARTBEAT_DEFAULT_MS` env default). The owning feature
 *  (`features/heartbeat-admin`) computes this from its durable config, already
 *  applying the auto-disable window, and registers a provider via the fill-a-seam
 *  pattern (core never imports the feature). Unregistered / null ⇒ inherit the env
 *  exactly as before (byte-identical to pre-0318). */
export interface ResolvedHeartbeatConfig {
  /** Global kill switch: master off, OR an enabled window that has elapsed. When
   *  true, the resolver returns 0 for EVERY member (overrides per-agent cadence). */
  masterOff: boolean;
  /** Runtime override of the host-default cadence for members without an explicit
   *  per-agent cadence. `null` ⇒ fall through to the env default. Ignored when
   *  `masterOff`. */
  hostDefaultIntervalMs: number | null;
  /** Optional runtime override of the per-tenant autonomous-run budget (runs/hour);
   *  `null` ⇒ use the env/default cap. `<= 0` ⇒ unlimited (matches the env rule). */
  runBudgetPerHour: number | null;
}
type HeartbeatConfigProvider = () => Promise<ResolvedHeartbeatConfig | null>;
let heartbeatConfigProvider: HeartbeatConfigProvider | null = null;
/** ADR 0318 fill-a-seam — the heartbeat-admin feature registers its resolver here
 *  at boot. Core never imports the feature; unregistered ⇒ env-only behavior. */
export function registerHeartbeatConfigProvider(fn: HeartbeatConfigProvider | null): void { heartbeatConfigProvider = fn; }
/** Resolve the host-wide admin override for one pass. Fail-OPEN to null (env
 *  behavior) — a config-store hiccup must never wedge or silently kill the loop. */
export async function resolveHeartbeatAdminConfig(): Promise<ResolvedHeartbeatConfig | null> {
  if (!heartbeatConfigProvider) return null;
  try {
    return await heartbeatConfigProvider();
  } catch (err) {
    log.warn('heartbeat admin config provider failed — inheriting env default', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** ADR 0313 D1 / ADR 0318 — ONE resolver for a member's effective autonomous
 *  cadence (used by BOTH the due check and the fleet slot quantization, so they
 *  can never disagree). Returns 0 when autonomous heartbeats are off for this
 *  member. `admin` (ADR 0318) is the host-wide override resolved once per pass:
 *  `masterOff` hard-kills every member; otherwise `hostDefaultIntervalMs` overrides
 *  the env host default. Omitted/undefined ⇒ env-only behavior (backward compatible). */
export function effectiveHeartbeatIntervalMs(entry: RosterEntry, admin?: ResolvedHeartbeatConfig | null): number {
  if (admin?.masterOff) return 0; // ADR 0318 global kill switch (overrides per-agent cadence)
  const configured = entry.heartbeatIntervalMs ?? 0;
  if (configured > 0) return configured;
  if (configured === HEARTBEAT_OFF) return 0;
  if (admin && admin.hostDefaultIntervalMs != null) return admin.hostDefaultIntervalMs; // ADR 0318 host-default override
  const raw = Number(process.env[HEARTBEAT_DEFAULT_MS_ENV]);
  const hostDefault = Number.isFinite(raw) && raw >= 0 ? raw : FALLBACK_DEFAULT_MS;
  return hostDefault;
}

function isHeartbeatDue(entry: RosterEntry, now: number, admin?: ResolvedHeartbeatConfig | null): boolean {
  if (!entry.enabled) return false;
  const interval = effectiveHeartbeatIntervalMs(entry, admin);
  if (interval <= 0) return false;
  if (!entry.lastHeartbeatAt) return true;
  const last = Date.parse(entry.lastHeartbeatAt);
  if (Number.isNaN(last)) return true;
  return now - last >= interval;
}

/**
 * Run one autonomous-heartbeat pass across all tenants: every enabled member
 * with a positive `heartbeatIntervalMs` that is due gets its "Check now" run
 * once across the fleet (per-(roster, slot) claim). Returns the number this
 * instance ran. Exported for deterministic tests — pass a fixed `now`.
 *
 * `listTenants` enumerates tenant ids to scan (the roster store lists per
 * tenant). Injected so tests can scope it; the daemon derives it from the
 * roster store.
 */
export async function processDueHeartbeats(
  deps: StartRunDeps,
  listTenants: () => Promise<string[]>,
  now: number = Date.now(),
): Promise<number> {
  // ADR 0318 — resolve the host-wide admin override ONCE per pass (fail-open to
  // env). Threaded into every due-check + slot calc so the whole pass agrees.
  const admin = await resolveHeartbeatAdminConfig();
  const tenants = await listTenants();
  const dueEntries: RosterEntry[] = [];
  for (const tenantId of tenants) {
    for (const entry of await listRoster(tenantId)) {
      if (isHeartbeatDue(entry, now, admin)) dueEntries.push(entry);
    }
  }

  let ran = 0;
  for (const entry of dueEntries.slice(0, CHECK_BATCH)) {
    // Quantize to the interval so concurrent instances claim the same slot key.
    // ADR 0313 — the SAME effective cadence as the due check (never disagree).
    const interval = effectiveHeartbeatIntervalMs(entry, admin) || POLL_INTERVAL_MS;
    const slot = Math.floor(now / interval);
    const claimKey = `${CLAIM_KEY_PREFIX}${entry.rosterId}:${slot}`;
    const claim = await deps.storage.claimOnce(claimKey, new Date(now).toISOString());
    if (!claim.claimed) continue; // another instance is running this slot
    // Autonomous-run budget: skip an auto-heartbeat that would exceed the
    // tenant's ceiling (manual "Check now" is never throttled). lastHeartbeatAt
    // isn't stamped, so it retries next window once budget frees. ADR 0318 — the
    // admin override (runs/hour) supersedes the env cap when set.
    const budget = await checkAutonomousRunBudget(
      deps.storage,
      entry.tenantId,
      now,
      admin?.runBudgetPerHour != null ? runBudgetConfigWithLimit(admin.runBudgetPerHour) : undefined,
    );
    if (!budget.allowed) {
      log.warn('autonomous heartbeat skipped — tenant over run budget', {
        rosterId: entry.rosterId, tenantId: entry.tenantId, current: budget.current, limit: budget.limit,
      });
      continue;
    }
    try {
      const result = await runHeartbeatOnce(deps, entry);
      if (result.picked) {
        ran++;
        log.info('autonomous heartbeat picked a task', {
          rosterId: entry.rosterId,
          cardId: result.cardId,
          runId: result.runId,
        });
      }
    } catch (err) {
      log.error('autonomous heartbeat failed', {
        rosterId: entry.rosterId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return ran;
}

/** Delete this daemon's stale per-(roster, slot) claim keys so the idempotency
 *  table stays bounded. Best-effort. */
export async function pruneStaleHeartbeatClaims(deps: StartRunDeps, now: number = Date.now()): Promise<number> {
  try {
    return await deps.storage.pruneOnceByPrefix(CLAIM_KEY_PREFIX, new Date(now - CLAIM_PRUNE_AGE_MS).toISOString());
  } catch (err) {
    log.warn('heartbeat claim prune failed', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

export interface HeartbeatDaemon {
  stop(): void;
}

/**
 * Start the polling heartbeat daemon. `listTenants` enumerates tenants with
 * roster members to scan. One pass at a time; `stop()` clears the timer.
 */
export function startHeartbeatDaemon(deps: StartRunDeps, listTenants: () => Promise<string[]>): HeartbeatDaemon {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await processDueHeartbeats(deps, listTenants);
      await pruneStaleHeartbeatClaims(deps);
    } catch (err) {
      log.warn('heartbeat daemon tick error', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void runUnderWorkerContract(tick), POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('heartbeat daemon started', { pollIntervalMs: POLL_INTERVAL_MS, instanceId: getInstanceId() });
  return { stop: () => clearInterval(timer) };
}
