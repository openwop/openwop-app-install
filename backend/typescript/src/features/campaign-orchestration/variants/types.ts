/**
 * ADR 0946 D1 — the `VariantSet`: one versioned unit per campaign creative round,
 * tying copy, image, video, email and landing members to the concepts they
 * execute. Every stored row is ONE immutable version; a member/concept change
 * makes version N+1 with a new hash.
 *
 * `superseded` is DERIVED at read (`version < head`), never written onto an old
 * row (ADR 0946 P0 correction): rewriting row N after inserting N+1 is a second
 * write with a crash window, and it would make "immutable" untrue.
 *
 * @see docs/adr/0946-creative-variant-factory.md
 */

/** Stored lifecycle state. `superseded` appears only on the read model. */
export type VariantSetStoredStatus = 'draft' | 'preflight' | 'in_review' | 'approved';
export type VariantSetStatus = VariantSetStoredStatus | 'superseded';

/** Closed concept axes (D2). Concept distance counts differing axes. */
export const HOOK_TYPES = ['problem', 'benefit', 'social_proof', 'curiosity', 'offer', 'story', 'demo', 'urgency'] as const;
export const VISUAL_TREATMENTS = ['product_hero', 'lifestyle', 'ugc', 'illustration', 'typographic', 'before_after', 'data_viz'] as const;
export const FORMAT_FAMILIES = ['static', 'carousel', 'video', 'story', 'text', 'landing', 'email'] as const;
export const MEMBER_KINDS = ['copy', 'image', 'video', 'landing', 'email'] as const;

export type HookType = (typeof HOOK_TYPES)[number];
export type VisualTreatment = (typeof VISUAL_TREATMENTS)[number];
export type FormatFamily = (typeof FORMAT_FAMILIES)[number];
export type VariantMemberKind = (typeof MEMBER_KINDS)[number];

/** D3 channel id, e.g. `meta.feed`, `google.rsa`, `email`, `landing`. P0 checks
 *  the shape only; P1's channel spec table closes the set. */
export type ChannelSpecId = string;

export interface Concept {
  conceptId: string;
  axes: { angle: string; personaId?: string; hook: HookType; visual: VisualTreatment; format: FormatFamily };
  /** The agent's reason, shown in review. */
  rationale: string;
}

export type VariantMemberRef =
  | { mediaAssetId: string }
  | { pageId: string; pageVersion: number }
  | { emailTemplateId: string; version: number }
  | { copy: Record<string, string> };

export interface VariantMember {
  memberId: string;
  conceptId: string;
  channel: ChannelSpecId;
  kind: VariantMemberKind;
  ref: VariantMemberRef;
  /** Server-computed from the referenced content, never caller-supplied. */
  contentHash: string;
  renderId?: string;
  productRef?: { productId: string; variantId?: string };
  fidelityVerdictId?: string;
}

/** D2 — filled by `score-diversity` (P2). Absent until scored. */
export interface DiversityReport {
  conceptDistance: { mean: number; min: number; axisCoverage: Record<string, number> };
  clusters: Array<{ memberIds: string[]; distance: number }>;
  embeddingModel?: string;
  scoredAt: string;
}

/** One immutable stored version. */
export interface VariantSetRow {
  setId: string;
  tenantId: string;
  orgId: string;
  campaignId: string;
  version: number;
  /** sha256 over the canonical concepts + members (status excluded). */
  hash: string;
  status: VariantSetStoredStatus;
  /** ADR 0941 D3 — copied from the campaign once 0941 P1 lands (unset before). */
  productRefs?: Array<{ productId: string; role: 'primary' | 'secondary' }>;
  concepts: Concept[];
  members: VariantMember[];
  diversity?: DiversityReport;
  preflight?: { rulesetVersion: string; digest: string; findings: unknown[] };
  /** The version this one revised (absent on v1). */
  revisedFrom?: number;
  createdByRunId?: string;
  createdAt: string;
  createdBy: string;
}

/** The read model: a stored row with its derived status. */
export interface VariantSet extends Omit<VariantSetRow, 'status'> {
  status: VariantSetStatus;
  /** The current head version of this set. */
  headVersion: number;
}
