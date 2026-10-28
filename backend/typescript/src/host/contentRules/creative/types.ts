/**
 * ADR 0946 D5 — the input to the creative rule sets. Plain data: the P4
 * `preflight` node builds it from a VariantSet, its media, its renders and the
 * brand, so the rules stay pure and replay-safe (`asOf` is the only clock, and
 * embeddings arrive with their model id rather than being computed here).
 *
 * A fact no producer supplies yet is left undefined, and the rule that needs it
 * says so (needs_review or "not measured"); a missing fact never passes.
 */
import type { ContentFinding } from '../findings.js';

export interface CreativeConcept {
  conceptId: string;
  axes: { angle: string; personaId?: string; hook: string; visual: string; format: string };
}

export interface MediaFacts {
  contentType: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  durationSec?: number;
  altText?: string;
  altTextSource?: 'human' | 'ai' | 'decorative';
  /** Video: whether captions are present. Undefined = not known. */
  hasCaptions?: boolean;
  /** ADR 0945 perceptual hash (hex, 64 bits). Undefined = not measured. */
  perceptualHash?: string;
}

export interface TextLayerFacts {
  layerId: string;
  /** Resolved text colour, `#rgb` or `#rrggbb`. */
  fg: string;
  /** Resolved solid background, or null when the text sits on an image. */
  bg: string | null;
  sizePx: number;
  weight?: number;
}

export interface LockFacts {
  logoPresent: boolean;
  /** The logo's box as percentages of the canvas. */
  logoBox?: { x: number; y: number; w: number; h: number };
  logoPx?: number;
  textColours: string[];
  backgroundColours: string[];
  fonts: string[];
  nudges: Record<string, { scale?: number; dxPct?: number; dyPct?: number }>;
  disclaimerPresent?: boolean;
}

export interface CreativeLocks {
  logo?: { required: boolean; zones: Array<{ x: number; y: number; w: number; h: number }>; minPx: number };
  textColours: string[];
  backgroundColours: string[];
  fonts: string[];
  overrideBounds: { maxScale: number; maxOffsetPct: number };
  requiredDisclaimer?: string;
}

export interface CreativeMemberInput {
  memberId: string;
  conceptId: string;
  channel: string;
  kind: 'copy' | 'image' | 'video' | 'landing' | 'email';
  copy?: Record<string, string>;
  media?: MediaFacts;
  render?: { textLayers: TextLayerFacts[]; lockFacts?: LockFacts };
  productRef?: { productId: string; variantId?: string };
  fidelity?: { verdictId: string; status: 'pass' | 'needs_review' | 'fail'; reason?: string };
  /** Members in the same ad set compete for delivery; defaults to the channel. */
  adSet?: string;
}

export interface CreativeRulesInput {
  asOf: string;
  concepts: CreativeConcept[];
  members: CreativeMemberInput[];
  brandLocks?: CreativeLocks;
  embeddings?: { model: string; vectors: Record<string, number[]> };
}

export interface DiversityReport {
  rulesetVersion: string;
  conceptDistance: { mean: number; min: number; axisCoverage: Record<string, number> };
  clusters: Array<{ adSet: string; memberIds: string[] }>;
  copyMeasure: 'embedding' | 'jaccard' | 'not_measured';
  imageMeasure: 'perceptual_hash' | 'not_measured';
  embeddingModel?: string;
  scoredAt: string;
}

export interface CreativeRulesReport {
  rulesetVersion: string;
  asOf: string;
  findings: ContentFinding[];
  digest: string;
  diversity: DiversityReport;
}
