/**
 * Interactive viewer for a `canvas.app-builder` design (ADR 0305 Phase D; the
 * generic multi-frame engine extracted to the canvas framework in ADR 0310
 * Phase A). A thin binding of `canvas/InteractiveViewer` to the app-builder's
 * renderer + screens trait: one screen at a time through the shared read-mode
 * `AppBuilderContentView` (bound lists unroll their sample rows), `navigateTo`
 * taps switch screens via the renderer's `data-cv-nav` stamps, and the screen
 * tab strip is the keyboard-accessible navigation fallback.
 *
 * Feature-agnostic on purpose: consumed by the app-builder preview page AND the
 * public shared view (`SharedSharePage`) — it lives beside the renderer so
 * neither feature imports the other. Chrome (device frames, theme toggle,
 * fullscreen) is the consumer's job.
 */
import { useTranslation } from 'react-i18next';
import { InteractiveViewer } from '../../canvas/InteractiveViewer.js';
import { AppBuilderContentView } from './AppBuilderPreview.js';
import { appBuilderPreviewRuntime } from '../../features/app-builder/previewRuntime.js';

interface AppDocLike { screens?: unknown[]; theme?: string; [k: string]: unknown }

export function AppBuilderInteractiveViewer({ app, themeOverride }: {
  /** The parsed canvas.app-builder document (already validated server-side). */
  app: AppDocLike;
  /** Client-side theme swap for the preview's light/dark toggle — never persisted. */
  themeOverride?: 'light' | 'dark';
}): JSX.Element {
  const { t } = useTranslation('chat');
  return (
    <InteractiveViewer
      doc={app}
      framesKey="screens"
      homeFlag="isInitial"
      Renderer={AppBuilderContentView}
      runtime={appBuilderPreviewRuntime}
      modalCloseText={t('appBuilderModalClose')}
      {...(themeOverride ? { themeOverride } : {})}
      noFramesText={t('appBuilderNoScreens')}
      framesLabel={t('appBuilderScreensLabel')}
    />
  );
}
