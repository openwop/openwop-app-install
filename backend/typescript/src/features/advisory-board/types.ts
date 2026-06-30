/**
 * Board of Advisors (ADR 0040) — host-extension entity types.
 *
 * An `AdvisoryBoard` is a NEW grouping entity: a named, ordered cohort of advisor
 * roster agents (`rosterId[]`), a moderator, and a visibility. It is explicitly
 * NOT a `host.kanban` board (ADR 0040 § "Boundaries" — no `/boards/*`, no fake
 * board id, no shadowing). Advisors are existing roster agents (ADR 0031/0032);
 * the board stores only their ids — no parallel persona/RAG store.
 *
 * The board is a COHORT DEFINITION only. The boardroom CONVERSATION runs in the AI
 * chat: `@@<handle>` expands the cohort into the chat's active-agents lineup and
 * the discussion uses the existing `chat.turn` multi-agent infra (ADR 0040
 * § Correction 2026-06-15). There is no separate transcript/session entity here.
 *
 * @see docs/adr/0040-board-of-advisors.md
 */

/** Who an advisor persona models — gates the likeness governance (ADR 0040
 *  § "Legal / likeness governance"). `living` requires an explicit ack. */
export type PersonaKind = 'historical' | 'fictional' | 'original' | 'living';

/** A board's visibility within its workspace (ADR 0040 — server-authoritative).
 *  `private` = only the creator may read/convene; `shared` = any workspace member
 *  with `workspace:read`. (A public capability-token link is a deferred follow-on.) */
export type BoardVisibility = 'private' | 'shared';

export type { TurnPolicy } from '../../host/turnPolicy.js';
import type { TurnPolicy } from '../../host/turnPolicy.js';

/**
 * A selected context reference the board carries into its advisors' prompt
 * (ADR 0079 Phase 5). A discriminated union so it ages as more context kinds are
 * added; Phase 5 ships `strategy` (the strategy context packet — which itself
 * resolves the strategy's linked projects/priorities). Resolved LIVE at
 * board-group formation, RBAC-filtered by the convener, snapshotted onto the
 * conversation (ADR 0079 §Correction).
 */
export type AdvisoryContextRef =
  | { kind: 'strategy'; strategyId: string }
  | { kind: 'project'; projectId: string };

export interface AdvisoryBoard {
  boardId: string;            // host:advisory:<slug>
  tenantId: string;           // workspace (ADR 0015)
  orgId: string;              // owning org (RBAC scope)
  name: string;
  /** The `@@` summon token (unique per tenant, lower-kebab). */
  handle: string;
  /** Ordered cohort — advisor roster ids (the grouping). NOT KanbanBoard ids. */
  advisors: string[];
  /** Synthesizer roster id; when absent, the convene picks the workspace
   *  assistant (the `assistant`-capability agent) or falls back to no synthesis. */
  moderatorRosterId?: string;
  /** Selected strategy context the advisors receive (ADR 0079 Phase 5). */
  contextRefs?: AdvisoryContextRef[];
  visibility: BoardVisibility;
  /** Likeness governance: the dominant persona kind in the cohort. When `living`,
   *  `livingPersonaAck` MUST be set before the board can convene. */
  personaKind: PersonaKind;
  /** Explicit acknowledgement that simulating a living individual is understood to
   *  be a non-endorsed simulation (right-of-publicity / defamation guard). */
  livingPersonaAck?: boolean;
  /** Turn policy — bounded for cost (ADR 0040 § Open questions: fan-out caps).
   *  The shared `TurnPolicy` primitive (ADR 0054 D6) — same validator + cadence
   *  planner a project's group chat uses. */
  turnPolicy: TurnPolicy;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

