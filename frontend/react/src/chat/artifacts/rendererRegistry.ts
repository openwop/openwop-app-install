/**
 * Artifact-renderer registry (ADR 0153 Phase 0) — the single source of truth for
 * artifactTypeId → inline-preview component, mirroring the chat `CardRegistry`
 * seam (`chat/registry/CardRegistry.ts`). The `ArtifactWorkbench` preview tab
 * looks renderers up here instead of a hardcoded type chain, so each feature
 * registers its own renderer (the interactive.* built-ins in `defaultRenderers`,
 * canvas.* renderers from the canvas features) without editing core.
 *
 * Lookup precedence: an exact `artifactTypeId` match wins; otherwise the first
 * registered `match(artifactTypeId)` predicate (registration order); otherwise
 * null — the workbench falls back to inert Markdown.
 */

import type { ComponentType } from 'react';
import type { ArtifactProjection } from './artifactClient.js';

export interface ArtifactRendererProps {
  artifact: ArtifactProjection;
  /** Edit-aware body: the debounced draft while the scratch editor is open,
   *  else the persisted revision content. */
  content: string;
}

export interface ArtifactRendererRegistration {
  /** Exact artifactTypeId this renderer claims (e.g. 'interactive.mermaid',
   *  'canvas.slides'). Mutually exclusive with `match`. */
  artifactTypeId?: string;
  /** Predicate fallback when no exact id matches (e.g. any 'interactive.*').
   *  Lower priority than an exact registration. */
  match?: (artifactTypeId: string) => boolean;
  /** When true, the workbench offers the ephemeral source-edit canvas (a
   *  textarea whose debounced draft re-feeds this renderer). Structured canvas
   *  renderers leave this false — they edit in their own full-screen surface. */
  editable?: boolean;
  Component: ComponentType<ArtifactRendererProps>;
}

const exact = new Map<string, ArtifactRendererRegistration>();
const predicates: ArtifactRendererRegistration[] = [];

export function registerArtifactRenderer(reg: ArtifactRendererRegistration): void {
  if (reg.artifactTypeId) {
    if (exact.has(reg.artifactTypeId)) {
      console.warn(`[ArtifactRendererRegistry] overwriting renderer for artifactTypeId=${reg.artifactTypeId}`);
    }
    exact.set(reg.artifactTypeId, reg);
  } else if (reg.match) {
    predicates.push(reg);
  } else {
    console.warn('[ArtifactRendererRegistry] registration ignored: neither artifactTypeId nor match provided');
  }
}

export function getArtifactRenderer(artifactTypeId: string | undefined): ArtifactRendererRegistration | null {
  if (!artifactTypeId) return null;
  return exact.get(artifactTypeId) ?? predicates.find((p) => p.match!(artifactTypeId)) ?? null;
}

export function listArtifactRenderers(): readonly ArtifactRendererRegistration[] {
  return [...exact.values(), ...predicates];
}

export function clearArtifactRenderers(): void {
  exact.clear();
  predicates.length = 0;
}
