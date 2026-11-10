/**
 * ADR 1031 P2 — FEATURE-owned approval kinds.
 *
 * An approval kind needs two per-kind answers from the core: WHO may see the row
 * (`approvalAudience.ts`, ADR 0672) and HOW a decision on it is dispatched
 * (`approvalDecision.ts`, APPR-1). Both were closed tables keyed by the
 * compile-time `APPROVAL_KINDS` tuple, so a feature that lives outside this repo
 * (an adopter's `src/adopter/features/<id>/`) could not add a kind without
 * editing three host files. This registry is the missing door: the owning
 * feature registers its kind ONCE with both answers, and the host tables consult
 * it for any kind they do not list.
 *
 * The two answers are one registration on purpose. A kind registered with a
 * decision but no audience would fall to the host default — a tenant-wide row —
 * which is exactly the leak ADR 0672 closed; requiring both makes that state
 * unrepresentable. The other per-kind seams were already registries and stay
 * where they are: decider eligibility (`registerApprovalEligibility`) and the
 * subject-erasure field map (`registerApprovalRedactor`).
 *
 * Typing: a feature declares its kind into `FeatureApprovalKinds` (and any
 * payload field into `PendingApproval`) by module augmentation of
 * `approvalService.ts`, so `ApprovalKind` covers it and the host tables can
 * still demand completeness over the host's own kinds.
 *
 * A host kind can never be re-registered (a boot error), and a registration
 * replaces the previous one for the same feature kind (hot reload).
 */
import { APPROVAL_KINDS } from './approvalService.js';
import type { Audience } from './approvalAudience.js';
import type { FeatureKindDispatch } from './approvalDecision.js';
import type { PendingApproval } from './approvalService.js';
import type { ReviewRequest } from './reviewProjection.js';

export interface FeatureApprovalKindDef {
  /** Who may learn the row exists (the `APPROVAL_AUDIENCE` value for this kind). */
  audience: Audience;
  /** The decision recipe the shared dispatcher runs for claim AND reject. */
  decision: FeatureKindDispatch;
  /** ADR 1031 P3 — extra review-card fields for this kind's projection (ids only;
   *  declare their types by augmenting `FeatureReviewFields` in reviewProjection.ts). */
  reviewFields?: (row: PendingApproval) => Partial<ReviewRequest>;
}

const HOST_KINDS: ReadonlySet<string> = new Set(APPROVAL_KINDS);
const registered = new Map<string, FeatureApprovalKindDef>();

export function registerFeatureApprovalKind(kind: string, def: FeatureApprovalKindDef): void {
  if (HOST_KINDS.has(kind)) {
    throw new Error(`approval kind '${kind}' is a host kind (APPROVAL_KINDS) and cannot be registered by a feature (ADR 1031 P2)`);
  }
  registered.set(kind, def);
}

/** The registration for a feature-owned kind, or `undefined` (a host kind, or unknown). */
export function featureApprovalKind(kind: string | undefined): FeatureApprovalKindDef | undefined {
  return kind === undefined ? undefined : registered.get(kind);
}

/** Every registered feature-owned kind, in registration order. */
export function featureApprovalKinds(): string[] {
  return [...registered.keys()];
}
