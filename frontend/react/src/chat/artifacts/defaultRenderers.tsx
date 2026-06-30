/**
 * Built-in artifact renderers (ADR 0153 Phase 0) — the interactive.* family that
 * previously lived as a hardcoded type chain inside `ArtifactWorkbench`. Each is
 * registered through the shared `rendererRegistry` seam so canvas features can add
 * their own renderers the same way (cf. `registerDefaultCards`).
 *
 * The components are lazy-split (the PR #804 entry-budget pattern); the workbench
 * wraps the chosen renderer in a single <Suspense>. Trust model is unchanged from
 * ADR 0128: interactive.html/react render in the origin-isolated, no-egress sandbox;
 * interactive.mermaid is sandboxed-diagram source (ADR 0129); interactive.chart is
 * untrusted DATA rendered as inline SVG; interactive.react stays inert (this host
 * bundles no React/Babel runtime — IART-1).
 */

import { lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/index.js';
import { registerArtifactRenderer, type ArtifactRendererProps } from './rendererRegistry.js';
// Canvas renderers are lazy-split off the eager chat/workbench chunk (the entry-budget
// pattern, like the interactive.* renderers below) — the workbench wraps the chosen
// renderer in a single <Suspense>, so a lazy canvas renderer loads on first open.
const SlidesPreview = lazy(() => import('./SlidesPreview.js').then((m) => ({ default: m.SlidesPreview })));
const AppBuilderPreview = lazy(() => import('./AppBuilderPreview.js').then((m) => ({ default: m.AppBuilderPreview })));
const CampaignPreview = lazy(() => import('./CampaignPreview.js').then((m) => ({ default: m.CampaignPreview })));
const DrawingPreview = lazy(() => import('./DrawingPreview.js').then((m) => ({ default: m.DrawingPreview })));
const CadPreview = lazy(() => import('./CadPreview.js').then((m) => ({ default: m.CadPreview })));

const SandboxedArtifactFrame = lazy(() => import('./SandboxedArtifactFrame.js').then((m) => ({ default: m.SandboxedArtifactFrame })));
const MermaidDiagram = lazy(() => import('../MermaidDiagram.js').then((m) => ({ default: m.MermaidDiagram })));
const ChartRenderer = lazy(() => import('./ChartRenderer.js').then((m) => ({ default: m.ChartRenderer })));

function MermaidRenderer({ content }: ArtifactRendererProps): JSX.Element {
  return <MermaidDiagram source={content} />;
}

function ChartArtifactRenderer({ content }: ArtifactRendererProps): JSX.Element {
  return <ChartRenderer content={content} />;
}

function ReactInertRenderer({ content }: ArtifactRendererProps): JSX.Element {
  const { t } = useTranslation('chat');
  return (
    <>
      <Notice variant="info">{t('artifactReactUnsupported')}</Notice>
      <pre className="msgrender-code-pre"><code>{content}</code></pre>
    </>
  );
}

function HtmlSandboxRenderer({ artifact, content }: ArtifactRendererProps): JSX.Element {
  return <SandboxedArtifactFrame body={content} title={artifact.title} />;
}

let registered = false;

/** Register the built-in interactive.* renderers. Idempotent; call once at chat
 *  boot (alongside `registerDefaultCards`). */
export function registerDefaultArtifactRenderers(): void {
  if (registered) return;
  registerArtifactRenderer({ artifactTypeId: 'interactive.mermaid', editable: true, Component: MermaidRenderer });
  registerArtifactRenderer({ artifactTypeId: 'interactive.chart', editable: true, Component: ChartArtifactRenderer });
  registerArtifactRenderer({ artifactTypeId: 'interactive.react', editable: true, Component: ReactInertRenderer });
  // interactive.html and any other interactive.* → origin-isolated sandbox (lowest priority).
  registerArtifactRenderer({ match: (id) => id.startsWith('interactive.'), editable: true, Component: HtmlSandboxRenderer });
  // ADR 0153 Phase 1 — the slides canvas: structured typed JSON, rendered read-only
  // here (full-screen structured editing is Phase 2), so not `editable`.
  registerArtifactRenderer({ artifactTypeId: 'canvas.slides', editable: false, Component: SlidesPreview });
  // ADR 0153 Phase 2 — the app-builder canvas: structured screens/components, rendered
  // read-only inline (drag-and-drop editing is the full-screen editor, Phase 2b).
  registerArtifactRenderer({ artifactTypeId: 'canvas.app-builder', editable: false, Component: AppBuilderPreview });
  // ADR 0153 Phase 3 — campaign-studio canvas (structured marketing campaign).
  registerArtifactRenderer({ artifactTypeId: 'canvas.campaign', editable: false, Component: CampaignPreview });
  // ADR 0153 Phase 4 — drawings canvas (constrained vector scene → safe inline SVG).
  registerArtifactRenderer({ artifactTypeId: 'canvas.drawing', editable: false, Component: DrawingPreview });
  // ADR 0153 Phase 4 — cad canvas (parametric solids → orthographic SVG projection).
  registerArtifactRenderer({ artifactTypeId: 'canvas.cad', editable: false, Component: CadPreview });
  registered = true;
}
