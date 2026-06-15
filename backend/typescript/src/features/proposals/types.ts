/**
 * Reviewable-learning proposals (RFC 0096) — host-sample types.
 *
 * Wire shape mirrors `spec/v1/proposal.schema.json` (the floor schema, Active
 * since PR #698 / `2342156e`). A Proposal is an INERT record of a synthesized
 * artifact awaiting human review: `proposal.created` carries no artifact body
 * (`proposal-inert-until-applied`), and the byte image lives only on the stored
 * record's `artifact` field, installed verbatim at `apply` (`proposal-no-
 * resynthesis`).
 */

/** RFC 0096 §A — the four artifact kinds (`rule` was dropped pre-Active). */
export type ProposalKind = 'agent-pack' | 'workflow-chain-pack' | 'prompt-template' | 'automation';

export const PROPOSAL_KINDS: readonly ProposalKind[] = ['agent-pack', 'workflow-chain-pack', 'prompt-template', 'automation'];

/** RFC 0096 §B — lifecycle states. `apply` is the only state→`applied` transition. */
export type ProposalState = 'draft' | 'revised' | 'applied' | 'rejected' | 'archived';

/** RFC 0048 owner triple (inlined per the floor — no standalone identity schema). */
export interface ProposalOwner {
  tenant: string;
  workspace?: string;
  principal?: string;
}

export interface ProposalProvenance {
  sourceRunIds: string[];
  synthesizerModel?: string;
}

/** Present ONLY on an applied proposal (schema `if state===applied then activation required`). */
export interface ProposalActivation {
  /** The RFC 0051 approval that released the apply, when `activation: approval-gate`. */
  approvalId?: string | null;
  /** Opaque ref to the installed artifact — derived from the stored bytes, never re-synthesized. */
  installedArtifactRef: string;
}

export interface Proposal {
  id: string;
  kind: ProposalKind;
  state: ProposalState;
  title?: string;
  rationale?: string;
  /** The byte image last persisted on the proposal — installed verbatim at apply. */
  artifact: Record<string, unknown>;
  provenance: ProposalProvenance;
  duplicateOf?: string | null;
  owner: ProposalOwner;
  activation?: ProposalActivation;
  createdAt: string;
  updatedAt?: string;
}
