/**
 * The generic PACK canvas editor route (ADR 0310 Phase D — Tier-1 FE-less
 * packs). `/canvas/:typeId/:canvasId` serves ANY pack-declared canvas type
 * with zero per-type frontend code: fetch the type's catalog (whose `editor`
 * payload carries the pack's elements-trait hints as data), synthesize a
 * runtime definition, and mount the one shared `CanvasEditorPage`. The
 * backend `canvas-packs` toggle gates the wire (404 when off).
 */
import { Button } from '../../ui/Button.js';
import { CanvasOrgGate } from '../../canvas/CanvasOrgGate.js';
import { resolveCanvasOrg, type CanvasOrgResolution } from '../../canvas/resolveCanvasOrg.js';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard, Notice } from '../../ui/index.js';
import { CanvasEditorPage } from '../../canvas/CanvasEditorPage.js';
import { createCanvasClient, listOrgs } from '../../canvas/canvasClient.js';
import { PACK_CANVAS_TYPE_ID_RE, parsePackEditorHints, usePackDefinition, type PackEditorHints } from '../../canvas/packDefinition.js';
// The RFC 0117/0130 loader boundary is OWNED by ui-plugins — reused here, never
// forked (the DESIGN §5 one-loader rule; the app-builder→sharing import precedent).
import { PluginFrame } from '../ui-plugins/PluginFrame.js';
import { listPlugins, type ServedPlugin } from '../ui-plugins/pluginClient.js';

export function PackCanvasEditorPage(): JSX.Element {
  const { t } = useTranslation('canvas');
  const { t: tp } = useTranslation('canvas-packs');
  const { typeId, canvasId } = useParams();
  const [hints, setHints] = useState<PackEditorHints | null>(null);
  const [orgGate, setOrgGate] = useState<Exclude<CanvasOrgResolution, { kind: 'ok' }> | null>(null);
  const [search] = useSearchParams();
  const [previewPlugin, setPreviewPlugin] = useState<ServedPlugin | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // CP-G2 — a deep-linked route whose only failure state was a dead-end Notice
  // needed a page reload to retry. A nonce is enough to re-run the effect.
  const [attempt, setAttempt] = useState(0);
  // CP-G1 — whether this is worth retrying at all.
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true); setError(null);
      try {
        // The param rides straight into an API path — hold it to the same
        // strict slug the backend loader enforces.
        if (!typeId || !PACK_CANVAS_TYPE_ID_RE.test(typeId)) throw new Error(t('loadError'));
        const client = createCanvasClient({ basePath: `/host/openwop-app/canvas-packs/${typeId}` });
        const orgs = await listOrgs();
        const resolved = resolveCanvasOrg(orgs, search.get('org'));
        if (resolved.kind !== 'ok') { if (live) setOrgGate(resolved); return; }
        const org = resolved.orgId;
        const cat = await client.getCatalog(org);
        const parsed = parsePackEditorHints(cat.editor);
        if (!parsed) throw new Error(t('loadError'));
        if (live) setHints(parsed);
        // RFC 0130 (Tier-2): a matching sandboxed canvas-preview plugin replaces
        // the generic renderer. Discovery failure degrades to the data view.
        try {
          const { plugins } = await listPlugins();
          const match = plugins.find((p) => p.surface === 'canvas-preview' && p.canvasTypes?.includes(typeId)) ?? null;
          if (live) setPreviewPlugin(match);
        } catch { /* ui-plugins off / unreachable — the generic view stands */ }
      } catch (e) {
        // Opaque fetch failures show the localized error, never a
        // developer-facing status string (UX F2); only our own translated
        // messages pass through.
        //
        // CP-G1 — but "this canvas type is not available here" (the 404 the
        // toggle-off and the not-installed pack both produce) and "the request
        // failed" are DIFFERENT user situations: one is install-the-pack, the
        // other is try-again. `asJson` already attaches `status` to the Error
        // and this page threw it away, so both read as the same dead end.
        // Reading the status to CHOOSE a message leaks nothing — the status
        // itself is still never rendered.
        const status = (e as { status?: number } | null)?.status;
        const ours = e instanceof Error && (e.message === t('noOrg') || e.message === t('loadError'));
        if (!live) return;
        if (status === 404) { setUnavailable(true); setError(tp('typeUnavailable')); }
        else setError(ours && e instanceof Error ? e.message : t('loadError'));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [typeId, t, tp, attempt, search]);

  const definition = usePackDefinition(typeId ?? '', hints);

  // RFC 0130 mount: the sandboxed plugin frame as the editor's PreviewPanel.
  // Skipped for the transient `/new` seed URL (no stable artifact id yet) —
  // the generic data view covers that first render.
  const definitionWithPreview = useMemo(() => {
    if (!definition || !previewPlugin || !canvasId || canvasId === 'new') return definition;
    const plugin = previewPlugin;
    const artifactId = canvasId;
    const Panel = ({ content, selection, onAnnounce }: { content: string; selection: unknown; onAnnounce: (message: string, politeness?: 'polite' | 'assertive') => void }): JSX.Element => (
      <PluginFrame
        plugin={plugin}
        artifactId={artifactId}
        title={tp('previewFrameTitle')}
        docContent={content}
        selection={selection}
        onAnnounce={(message, politeness) => onAnnounce(message, politeness)}
        loadingLabel={t('loading')}
        errorLabel={t('loadError')}
      />
    );
    return { ...definition, PreviewPanel: Panel };
  }, [definition, previewPlugin, canvasId, t, tp]);

  if (orgGate) return <div className="cv-editor u-p-4"><CanvasOrgGate resolution={orgGate} /></div>;
  if (loading) return <div className="cv-editor"><StateCard loading title={t('loading')} /></div>;
  if (error || !definitionWithPreview) {
    return (
      <div className="cv-editor">
        <Notice variant="error">{error ?? t('loadError')}</Notice>
        {/* An unavailable TYPE will not become available by asking again — the
            retry belongs only on the failures that can succeed next time. */}
        {unavailable ? null : (
          <div className="action-bar">
            <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>{tp('retry')}</Button>
          </div>
        )}
      </div>
    );
  }
  return <CanvasEditorPage definition={definitionWithPreview} />;
}
