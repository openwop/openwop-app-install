/**
 * ADR 0137 — Ambient Work Graph types.
 *
 * Mines completed runs for recurring WORK PATTERNS — the agent + the ordered sequence of
 * tool NAMES it used (names only; no args/content → privacy-safe) — and suggests turning
 * a recurring pattern into a workflow (handed to the ADR 0072 workflow-author on accept).
 * Read-only projection over the run store; opt-in, tenant-scoped (no cross-tenant mining).
 *
 * @see docs/adr/0137-ambient-work-graph.md
 */

/** The structural shape P1 reasons over (gathered from the run store + events in P2). */
export interface RunSignatureInput {
  runId: string;
  agentId?: string;
  /** Tool names called by the run, in order (P2 reads them from agent.toolCalled). */
  toolNames: string[];
  goal?: string;
  createdAt: string;
}

export type SuggestionStatus = 'suggested' | 'accepted' | 'dismissed';

export interface WorkflowSuggestion {
  /** Deterministic id (hash of tenantId+signature) so a re-sweep UPSERTS, never dupes. */
  suggestionId: string;
  tenantId: string;
  signature: string;
  /** The deduped ordered tool-name pattern (the workflow skeleton). */
  toolSequence: string[];
  /** How many runs matched this pattern. */
  count: number;
  /** A capped sample of matching run ids (the evidence drawer). */
  exampleRunIds: string[];
  /** A sample goal for display — user content; tenant-scoped, never cross-tenant. */
  sampleGoal?: string;
  status: SuggestionStatus;
  firstSeenAt: string;
  lastSeenAt: string;
}
