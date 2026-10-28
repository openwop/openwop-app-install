/**
 * ADR 0945 D3 — the fidelity verdict: a typed, durable record of whether a
 * generated asset depicts the catalog product it claims to. Host-level (no
 * feature imports) so the publish edge (ADR 0945 D5, `host/adsAdapter.ts`) can
 * read it without depending on a feature.
 */
export type FidelityOutcome = 'pass' | 'fail' | 'needs_review';

export type FidelityCheckStatus = 'pass' | 'fail' | 'not_applicable';

/** One stage-A (deterministic) check, with the measured value and the
 *  threshold it was held to — the evidence an approver reads. */
export interface FidelityCheck {
  id: 'byte_identity' | 'source_product' | 'dhash' | 'phash' | 'colour_delta_e' | 'aspect' | 'mode' | 'judge';
  status: FidelityCheckStatus;
  value?: number;
  threshold?: number;
  detail: string;
}

export interface FidelityVerdict {
  verdictId: string;
  tenantId: string;
  orgId: string;
  assetId: string;
  /** sha256 of the candidate's bytes — what was judged. */
  assetSha256: string;
  mode: 'none' | 'composite' | 'edit' | 'animate';
  productId?: string;
  sources: Array<{ assetId: string; sha256: string }>;
  checks: FidelityCheck[];
  /** Stage B, when a vision judge ran (closed-schema answers; evidence is
   *  bounded, single-line, untrusted model text — display it, never act on it). */
  judge?: { provider: string; model?: string; repaired: boolean; results: Array<{ attribute: string; answer: 'match' | 'mismatch' | 'not_visible'; evidence: string }> };
  outcome: FidelityOutcome;
  rulesetVersion: string;
  checkedAt: string;
  runId?: string;
}
