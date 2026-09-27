/**
 * Creative Briefs (ADR 0353) — the managed VISUAL-brief entity closing the
 * messaging→production handoff (CS-005). Distinct from the campaign MESSAGING
 * brief (ADR 0156): this is the per-asset production document an external
 * designer executes from — scene, composition, camera, lighting, palette,
 * platform spec, direction variants, and a mood board of library assets.
 */

export type CreativeBriefStatus = 'draft' | 'review' | 'approved';
export const CREATIVE_BRIEF_STATUSES: readonly CreativeBriefStatus[] = ['draft', 'review', 'approved'];

/** Legal transitions (mirrors documents' lifecycle discipline). */
export const STATUS_TRANSITIONS: Record<CreativeBriefStatus, CreativeBriefStatus[]> = {
  draft: ['review'],
  review: ['approved', 'draft'],
  approved: ['draft'], // re-open demotes; share links purge on demotion
};

export interface CreativeDirection {
  label: string;
  rationale?: string;
}

export interface MoodBoardItem {
  mediaAssetId: string;
  note?: string;
}

export interface PlatformSpec {
  platform?: string;
  format?: string;
  /** e.g. Meta's 20%-text guidance — advisory number, not enforced here. */
  textRulePct?: number;
}

export interface CreativeBrief {
  briefId: string;
  tenantId: string;
  orgId: string;
  /** Optional provenance back to the campaign that spawned it. */
  campaignBriefId?: string;
  title: string;
  assetType: string;
  sceneDescription: string;
  composition?: string;
  cameraAngle?: string;
  lighting?: string;
  brandPalette?: string[];
  messagingIntent?: string;
  platformSpec?: PlatformSpec;
  /** 2–3 creative-direction variants, each with a persona-psychology rationale. */
  directions: CreativeDirection[];
  moodBoard: MoodBoardItem[];
  /** The media.select "go shoot this" gap note when selection found nothing. */
  needsAssetNote?: string;
  status: CreativeBriefStatus;
  /** Monotonic content revision (bumped by every content PATCH). */
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** An immutable revision snapshot (the campaign-brief BriefVersion precedent),
 *  stored as the CONTENT fields only so the diff view is field-level. */
export interface CreativeBriefVersion {
  versionId: string; // `${briefId}:${version}`
  briefId: string;
  tenantId: string;
  orgId: string;
  version: number;
  snapshot: Pick<CreativeBrief, 'title' | 'assetType' | 'sceneDescription' | 'composition' | 'cameraAngle' | 'lighting' | 'brandPalette' | 'messagingIntent' | 'platformSpec' | 'directions' | 'moodBoard'>;
  capturedAt: string;
  capturedBy: string;
}
