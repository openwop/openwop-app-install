/**
 * ADR 0831 — team intent ledger types (P1: project scope).
 *
 * For a project, `goal`/`objectives` live in the project CHARTER (ADR 0054) and
 * nowhere else; the ledger versions them and adds what the charter lacks.
 *
 * @see docs/adr/0831-team-intent-ledger.md
 */

export interface ToolPolicy { forbidden: string[]; requireApproval: string[] }

/** The ledger-relevant state at one version: the charter's goal/objectives plus the ledger's own fields. */
export interface LedgerState {
  goal?: string;
  objectives: string[];
  openQuestions: string[];
  inScope: string[];
  outOfScope: string[];
  decisionDocumentIds: string[];
  /** ADR 0856 — tools agents may not use / must ask for, in the project's chats. Narrow only. */
  toolPolicy?: ToolPolicy;
}

export interface TeamLedger {
  ledgerId: string;
  tenantId: string;
  scope: { kind: 'project'; id: string };
  /** The one subject who accepts or rejects deltas. */
  ownerSubject: string;
  /** +1 per accepted delta; version 1 is the ledger's creation. */
  version: number;
  openQuestions: string[];
  inScope: string[];
  outOfScope: string[];
  decisionDocumentIds: string[];
  /** ADR 0856 — tools agents may not use / must ask for, in the project's chats. Narrow only. */
  toolPolicy?: ToolPolicy;
  createdAt: string;
  updatedAt: string;
}

export type LedgerPatch = Partial<LedgerState>;

export interface TeamLedgerDelta {
  deltaId: string;
  ledgerId: string;
  tenantId: string;
  status: 'proposed' | 'accepted' | 'rejected';
  patch: LedgerPatch;
  why: string;
  author: { kind: 'user' | 'agent'; id: string };
  source?: { kind: 'run' | 'approval' | 'message' | 'handoff' | 'charter-edit' | 'inbound' | 'meeting' | 'drift' | 'decision'; ref: string };
  /** The version the author was looking at. */
  baseVersion: number;
  /** Set on accept: the version this delta produced, and the full state after it. */
  resultVersion?: number;
  resultState?: LedgerState;
  /** Accepted although `baseVersion` was behind (the owner saw what changed since). */
  rebased?: boolean;
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
}
