/**
 * Review-artifact renderer registry (ADR 0459 grade-fix) — artifactTypeId → a typed
 * inline renderer for a `ReviewAsset` under approval. `AssetPreview` looks a renderer
 * up here by the asset's `artifactTypeId`; a hit renders a humanized card, a miss falls
 * through to the existing markdown/JSON path (untyped assets are unchanged).
 *
 * This is the review-side twin of the workbench `chat/artifacts/rendererRegistry` — that
 * one keys ArtifactProjection previews; this one keys the small `ReviewAsset` the approval
 * card / reviews rail render. Kept separate so a review renderer never has to satisfy the
 * heavier workbench contract.
 *
 * ADR 1031 P2 — the host registers no type of its own: every typed renderer is a
 * feature's (`FrontendFeature.reviewArtifactRenderers`). KickTodo's three
 * (`kicktodo.plan-revision`, `kicktodo.challenge-lesson-batch`,
 * `kicktodo.challenge-plan`) moved to the kicktodo / kicktodo-studio packages.
 */

import type { ComponentType } from 'react';
import type { ReviewAsset } from './reviewClient.js';
import { featureReviewArtifactRenderers } from '../../features/featureExtensions.js';

export interface ReviewArtifactRendererProps {
  asset: ReviewAsset;
}

const registry = new Map<string, ComponentType<ReviewArtifactRendererProps>>();
/** Shape checks for UNTYPED content (P9): a saved envelope is shown in a type's
 *  layout only when that type registered a matcher and the payload passes it. */
const matchers = new Map<string, (content: string) => boolean>();

export function registerReviewArtifactRenderer(
  artifactTypeId: string,
  Component: ComponentType<ReviewArtifactRendererProps>,
  opts?: { matches?: (content: string) => boolean },
): void {
  registry.set(artifactTypeId, Component);
  if (opts?.matches) matchers.set(artifactTypeId, opts.matches);
}

/**
 * ADR 1031 — renderers a feature declares on `FrontendFeature.reviewArtifactRenderers`
 * or its lazy `extensions` (first-party or an adopter's; read through
 * `features/featureExtensions.ts`), registered on the FIRST lookup rather than at
 * load: this module is not in the entry chunk and should not pull the registry
 * into its evaluation order, and by the first lookup every module has loaded. A
 * distribution that excludes the feature drops its renderers with it.
 */
let featureRenderersRegistered = false;
function registerFeatureRenderers(): void {
  if (featureRenderersRegistered) return;
  featureRenderersRegistered = true;
  for (const r of featureReviewArtifactRenderers()) {
    registerReviewArtifactRenderer(r.artifactTypeId, r.component, r.matches ? { matches: r.matches } : undefined);
  }
}

export function getReviewArtifactRenderer(artifactTypeId: string | undefined): ComponentType<ReviewArtifactRendererProps> | null {
  registerFeatureRenderers();
  if (!artifactTypeId) return null;
  return registry.get(artifactTypeId) ?? null;
}

/** The renderer for untyped `content` that claims `artifactTypeId`, or null when
 *  the type has no matcher or the content does not have its shape. */
export function getReviewArtifactMatch(artifactTypeId: string, content: string): ComponentType<ReviewArtifactRendererProps> | null {
  registerFeatureRenderers();
  const matches = matchers.get(artifactTypeId);
  return matches && matches(content) ? registry.get(artifactTypeId) ?? null : null;
}
