/**
 * ADR 0725 — the ONE approval-action normalisation. This host's quorum path
 * accepts the spellings `approve` (a vote) and `override` (the bypass path);
 * both APPLY `accept`, so that is what the protocol vocabulary
 * (`accept | reject | refine | edit-accept | ask`) says. Shared by
 * `interrupt.resolved` (routes/interrupts.ts `resolvedActionFields`), the
 * `interrupt.requested` projection, and resume validation, so a gate
 * advertises, accepts and records one vocabulary.
 */
export function normalizeApprovalAction(raw: string): string {
  return raw === 'approve' || raw === 'override' ? 'accept' : raw;
}

/**
 * Resume VALIDATION's equivalence, deliberately NARROWER than the recording
 * normalisation above: only `approve` ≡ `accept`, the two spellings of one
 * decision a gate may advertise. `override` also records as `accept`, but it
 * is a privileged BYPASS, not a spelling — a gate that does not list it must
 * keep refusing it, so it is never admitted as an equivalent.
 */
export function resumeActionSpelling(raw: string): string {
  return raw === 'approve' ? 'accept' : raw;
}
