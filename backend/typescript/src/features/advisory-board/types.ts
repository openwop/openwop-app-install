/**
 * Board of Advisors (ADR 0040) — host-extension entity types.
 *
 * An `AdvisoryBoard` is a NEW grouping entity: a named, ordered cohort of advisor
 * roster agents (`rosterId[]`), a moderator, and a visibility. It is explicitly
 * NOT a `host.kanban` board (ADR 0040 § "Boundaries" — no `/boards/*`, no fake
 * board id, no shadowing). Advisors are existing roster agents (ADR 0031/0032);
 * the board stores only their ids — no parallel persona/RAG store.
 *
 * A council round is an `AdvisorySession`: a shared transcript of `CouncilTurn`s
 * (user → each advisor → moderator), each turn attributed to its speaker. Stored
 * host-side (non-normative). The resolved cohort is stamped on the session at
 * creation (the host-ext analog of the ADR §9 run.metadata stamp) so a re-read is
 * stable even if the live board is later edited.
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
  visibility: BoardVisibility;
  /** Likeness governance: the dominant persona kind in the cohort. When `living`,
   *  `livingPersonaAck` MUST be set before the board can convene. */
  personaKind: PersonaKind;
  /** Explicit acknowledgement that simulating a living individual is understood to
   *  be a non-endorsed simulation (right-of-publicity / defamation guard). */
  livingPersonaAck?: boolean;
  /** Turn policy — bounded for cost (ADR 0040 § Open questions: fan-out caps). */
  turnPolicy: { rounds: number; order: 'declared' | 'round-robin'; synthesize: boolean };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One attributed turn in a council transcript. */
export interface CouncilTurn {
  turnIndex: number;
  /** Speaker id: a rosterId, the literal `'user'`, or `'moderator:<rosterId>'`. */
  speakerId: string;
  /** Display name (persona/label or the user's name). */
  speakerName: string;
  role: 'user' | 'advisor' | 'moderator';
  content: string;
  /** ISO-8601 — carried through a re-read unchanged. */
  ts: string;
  /** True when an advisor's reply was grounded in its bound knowledge (ADR 0038). */
  grounded?: boolean;
}

export interface AdvisorySession {
  sessionId: string;
  boardId: string;
  tenantId: string;
  createdBy: string;
  /** The cohort resolved AT FIRST CONVENE (advisor rosterIds + moderator), stamped
   *  so the transcript stays stable if the board is later edited (ADR 0040 §9). */
  resolvedCohort: { advisors: string[]; moderatorRosterId?: string };
  turns: CouncilTurn[];
  createdAt: string;
  updatedAt: string;
}
