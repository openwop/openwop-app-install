/**
 * Canvas framework — the interactive device preview page (ADR 0310, extracted
 * from the app-builder's AppBuilderPreviewPage / ADR 0305 Phase D) — the
 * Figma-prototype-style walkthrough: one frame at a time, tap-through switches
 * frames (via the shared `InteractiveViewer`), wrapped in client-side device
 * frames from the type's `preview.devicePresets` (the CMS `DEVICE_MAXW`
 * approach — NO backend preview endpoint), a doc/light/dark theme override
 * (never persisted), and fullscreen.
 *
 * `hideOn` becomes REAL here: under a narrow preset, `hideOn:mobile` components
 * disappear (`.cv-preview--w-mobile`), and wide presets hide `hideOn:desktop` —
 * unlike the editor, which shows them with a dotted outline for editing.
 *
 * Reached at `<editorPath>/:canvasId/preview` (the editor's Preview button).
 */
import { Button } from '../ui/Button.js';
import { CanvasOrgGate } from './CanvasOrgGate.js';
import { resolveCanvasOrg, type CanvasOrgResolution } from './resolveCanvasOrg.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard, Notice } from '../ui/index.js';
import { createCanvasClient, listOrgs } from './canvasClient.js';
import { InteractiveViewer } from './InteractiveViewer.js';
import type { FrameBase } from './frameOps.js';
import type { TreeNodeBase } from './treeOps.js';
import type { CanvasTypeDefinition } from './types.js';

type ThemeMode = 'doc' | 'light' | 'dark';

export function CanvasPreviewPage<Doc extends object, F extends FrameBase, N extends TreeNodeBase>({ definition: def }: {
  definition: CanvasTypeDefinition<Doc, F, N>;
}): JSX.Element {
  const { t } = useTranslation('canvas');
  const { t: tt } = useTranslation(def.i18nNamespace);
  const { canvasId } = useParams();
  const client = useMemo(() => createCanvasClient({ basePath: def.clientBasePath }), [def.clientBasePath]);
  const [doc, setDoc] = useState<Record<string, unknown> | null>(null);
  const [orgGate, setOrgGate] = useState<Exclude<CanvasOrgResolution, { kind: 'ok' }> | null>(null);
  const [search] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const devices = def.preview?.devicePresets ?? [];
  const [device, setDevice] = useState(devices[0]?.id ?? 'full');
  const [theme, setTheme] = useState<ThemeMode>('doc');
  const [fullscreen, setFullscreen] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const orgs = await listOrgs();
        // Read-only does not make it less org-scoped — same lossy link.
        const resolved = resolveCanvasOrg(orgs, search.get('org'));
        if (resolved.kind !== 'ok') { if (live) setOrgGate(resolved); return; }
        const org = resolved.orgId;
        if (!canvasId) throw new Error(t('loadError'));
        const rec = await client.getCanvas(org, canvasId);
        if (live) setDoc(rec.state);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : t('loadError'));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [client, canvasId, t, search]);

  // Track fullscreen exits made via Esc so the button label stays honest.
  useEffect(() => {
    const onChange = (): void => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (stageRef.current) void stageRef.current.requestFullscreen();
  }, []);

  if (orgGate) return <div className="cv-preview u-p-4"><CanvasOrgGate resolution={orgGate} /></div>;
  if (loading) return <div className="cv-preview"><StateCard loading title={t('loading')} /></div>;
  if (error || !doc) return <div className="cv-preview"><Notice variant="error">{error ?? t('loadError')}</Notice></div>;

  const width = devices.find((d) => d.id === device)?.width ?? 0;
  const widthClass = width && width <= 640 ? 'cv-preview--w-mobile' : 'cv-preview--w-desktop';

  return (
    <div className="cv-preview">
      <header className="cv-editor__bar">
        <h1 className="sr-only">{tt('previewHeading')}</h1>
        {canvasId ? <Link className="btn secondary btn-sm" to={`${def.editorPath}/${encodeURIComponent(canvasId)}`}>{t('backToEditor')}</Link> : null}
        <span className="cv-preview__spacer" />
        <span className="action-bar">
          {devices.length > 1 ? (
            <select className="btn-sm" value={device} aria-label={t('device')} onChange={(e) => setDevice(e.target.value)}>
              {devices.map((d) => <option key={d.id} value={d.id}>{t(`device_${d.id}`)}</option>)}
            </select>
          ) : null}
          {def.preview?.themeOverride ? (
            <select className="btn-sm" value={theme} aria-label={t('themePreview')} onChange={(e) => setTheme(e.target.value as ThemeMode)}>
              {(['doc', 'light', 'dark'] as const).map((m) => <option key={m} value={m}>{m === 'doc' ? tt('theme_doc') : t(`theme_${m}`)}</option>)}
            </select>
          ) : null}
          <Button variant="secondary" size="sm" onClick={toggleFullscreen}>
            {fullscreen ? t('exitFullscreen') : t('fullscreen')}
          </Button>
        </span>
      </header>
      <div ref={stageRef} className={`cv-preview__stage ${widthClass}`}>
        {/* Grade pass UX F10: the header lives OUTSIDE the fullscreened element —
            without this floating control, fullscreen had no visible/touch exit. */}
        {fullscreen ? (
          <Button variant="secondary" size="sm" className="cv-preview__fs-exit" onClick={toggleFullscreen}>
            {t('exitFullscreen')}
          </Button>
        ) : null}
        <div className="cv-preview__frame" style={width ? { maxWidth: `${width}px` } : undefined}>
          <InteractiveViewer
            doc={doc}
            framesKey={def.frames?.key ?? 'screens'}
            homeFlag={def.frames?.homeFlag ?? ''}
            Renderer={def.Renderer}
            {...(theme === 'doc' ? {} : { themeOverride: theme })}
            {...(def.preview?.transitionFor ? { transitionFor: (f: string, t2: string) => def.preview!.transitionFor!(doc, f, t2) } : {})}
            {...(def.preview?.runtime ? {
              runtime: def.preview.runtime,
              modalCloseText: t('previewModalClose'),
              diagnostics: {
                label: t('previewDiagnostics'),
                emptyText: t('previewTraceEmpty'),
                modeLabels: { ok: t('simMode_ok'), error: t('simMode_error'), empty: t('simMode_empty') },
              },
            } : {})}
            noFramesText={tt('noFrames')}
            framesLabel={tt('framesLabel')}
            thumbnails
          />
        </div>
      </div>
    </div>
  );
}
