/**
 * ADR 0953 D3 — the social post record. One row per post, per client org.
 *
 * @see docs/adr/0953-social-publishing-and-scheduling.md
 */

export const SOCIAL_PLATFORMS = ['facebook-page', 'instagram', 'linkedin', 'x', 'tiktok', 'youtube'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const SOCIAL_POST_STATUSES = [
  'draft', 'pending_approval', 'scheduled', 'publishing', 'processing', 'published', 'failed', 'canceled',
] as const;
export type SocialPostStatus = (typeof SOCIAL_POST_STATUSES)[number];

export interface SocialMedia { mediaAssetId: string; kind: 'image' | 'video' }

export interface SocialPost {
  postId: string;
  tenantId: string;
  orgId: string;
  /** MarketingCampaign.id (ADR 0941). */
  campaignId?: string;
  /** The generating run (ADR 0953 D6, P3). */
  source?: { runId: string; nodeId: string; itemIx: number };
  platform: SocialPlatform;
  /** The client org's connection (ADR 0921 D4). Checked against the org from P1. */
  connectionId?: string;
  /** Page id, IG user id, org URN, channel id. */
  accountRef: string;
  text: string;
  link?: string;
  media: SocialMedia[];
  /** sha256 over accountRef, platform, text, link and media ids. An approval binds it. */
  contentHash: string;
  aiDisclosure: { aiGenerated: boolean; label?: string };
  /** ISO. Absent = publish when approved. */
  scheduledFor?: string;
  status: SocialPostStatus;
  approval?: { approvalId: string; contentHash: string; decidedBy?: string };
  /** The one-shot scheduler job (P2). */
  jobId?: string;
  platformPostId?: string;
  url?: string;
  publishedAt?: string;
  lastError?: { code: string; at: string };
  /** Bumped on every write; the CAS reads it. */
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
