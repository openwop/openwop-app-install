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
 */

import type { ComponentType } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewAsset } from './reviewClient.js';

export interface ReviewArtifactRendererProps {
  asset: ReviewAsset;
}

const registry = new Map<string, ComponentType<ReviewArtifactRendererProps>>();

export function registerReviewArtifactRenderer(artifactTypeId: string, Component: ComponentType<ReviewArtifactRendererProps>): void {
  registry.set(artifactTypeId, Component);
}

export function getReviewArtifactRenderer(artifactTypeId: string | undefined): ComponentType<ReviewArtifactRendererProps> | null {
  if (!artifactTypeId) return null;
  return registry.get(artifactTypeId) ?? null;
}

// ── kicktodo.plan-revision ─────────────────────────────────────────────────

interface PlanRevisionArtifact {
  commands?: unknown[];
  rationale?: unknown;
  display?: { summary?: unknown; lines?: unknown };
}

/** Client-side fallback humanization when the server `display` is absent (a degraded
 *  enrich). Lane-only, so it NEVER emits an opaque id — the same guarantee the server
 *  keeps. Used only as a safety net; the enriched path supplies real, title-resolved lines. */
function laneOnlyLine(raw: unknown, t: (k: string) => string): string {
  const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  switch (c.lane) {
    case 'schedule': return t('planRevisionLaneSchedule');
    case 'substitute': return t('planRevisionLaneSubstitute');
    case 'recovery': return t('planRevisionLaneRecovery');
    default: return t('planRevisionLaneOther');
  }
}

/** The typed replan approval card body: the coach/composer rationale as prose, the
 *  humanized change list (server-resolved titles, no ids), and the raw command list
 *  tucked behind a collapsed disclosure for the curious. */
function PlanRevisionReview({ asset }: ReviewArtifactRendererProps): JSX.Element {
  const { t } = useTranslation('chat');
  const parsed = useMemo<PlanRevisionArtifact>(() => {
    try { return JSON.parse(asset.content ?? '{}') as PlanRevisionArtifact; } catch { return {}; }
  }, [asset.content]);
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';
  const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
  const serverLines = Array.isArray(parsed.display?.lines)
    ? parsed.display!.lines!.filter((l): l is string => typeof l === 'string')
    : [];
  const lines = serverLines.length > 0 ? serverLines : commands.map((c) => laneOnlyLine(c, t));

  return (
    <div className="assetpreview-planrevision u-flex u-flex-col u-gap-1-5">
      {rationale ? <p className="u-fs-13 u-m-0">{rationale}</p> : null}
      {lines.length > 0 ? (
        <>
          <p className="u-fs-11 u-text-muted u-m-0">{t('planRevisionChangesHeading')}</p>
          <ul className="u-m-0">
            {lines.map((line, i) => <li key={i} className="u-fs-13">{line}</li>)}
          </ul>
        </>
      ) : (
        <p className="u-fs-12 u-text-muted u-m-0">{t('planRevisionNoChanges')}</p>
      )}
      {commands.length > 0 ? (
        <details className="u-fs-12">
          <summary className="u-text-muted">{t('planRevisionRawSummary')}</summary>
          <pre className="u-fs-11 u-m-0">{JSON.stringify(commands, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

registerReviewArtifactRenderer('kicktodo.plan-revision', PlanRevisionReview);
