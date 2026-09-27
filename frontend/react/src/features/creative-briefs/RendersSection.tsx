/**
 * Renders section (ADR 0399 P5) — the brief's composed-ad gallery: pick
 * templates (grouped by platform), render one-brief→N-formats, preview each
 * composed PNG with a safe-zone overlay drawn from TEMPLATE GEOMETRY JSON
 * (never a server SVG — the SVG is a server-internal intermediate), read the
 * advisory warnings, nudge layers within the clamped window and re-render
 * (records are immutable — a nudge mints a new deterministic render), and hand
 * the mediaAssetId to the publish-ad-variants dispatch leg.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice, Skeleton } from '../../ui/index.js';
import { Field, TextField, SelectField, CheckboxField } from '../../ui/Field.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { AlertIcon, CopyIcon, EyeIcon, ImageIcon, SparklesIcon, TrashIcon, XIcon } from '../../ui/icons/index.js';
import { formatDateTime, formatNumber } from '../../i18n/format.js';
// REEL-2 — the durable handle that lets a five-minute reel survive leaving the page.
import { getPendingReel, setPendingReel, clearPendingReel } from './pendingReel.js';
import { absoluteServeUrl, listAssets, type MediaAsset } from '../media/mediaClient.js';
import { MediaPickerDialog } from '../media/MediaPickerDialog.js';
import { GenerateImageDialog } from '../media/GenerateImageDialog.js';
import {
  listRenderTemplates, listRenders, createRenders, deleteRender, generateReel,
  type AdLayoutTemplate, type CreativeBrief, type CreativeRender, type LayerNudge, type RenderWarning,
} from './creativeBriefsClient.js';
import { getRun } from '../../client/runsClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];

/** Platform display names — proper nouns, identical in every locale. */
const PLATFORM_LABELS: Record<string, string> = {
  meta: 'Meta', tiktok: 'TikTok', linkedin: 'LinkedIn', 'google-display': 'Google Display',
};
const platformLabel = (p: string): string => PLATFORM_LABELS[p] ?? p;

/** Layers the nudge editor exposes (the clamped ADR 0399 §7 window). */
const NUDGABLE_LAYERS = ['headline', 'body', 'cta', 'logo', 'product'] as const;

// R2 CRB-SP-3 — `dirty`/`onSaveFirst` extend the CRB-G1 save-first discipline to
// the COST-BEARING lane: renders and reels acted on the SAVED brief while the
// form above was dirty, so a 30-120s paid video rendered stale text presenting
// as current.
export function RendersSection({ orgId, brief, dirty, onSaveFirst }: { orgId: string; brief: CreativeBrief; dirty: boolean; onSaveFirst: () => Promise<boolean> }): JSX.Element {
  const { t } = useTranslation('creative-briefs');
  const { t: tc } = useTranslation('common');
  const [templates, setTemplates] = useState<AdLayoutTemplate[] | null>(null);
  const [renders, setRenders] = useState<CreativeRender[] | null>(null);
  // "No renders yet — pick one or more formats above and render" instructs the user to
  // redo work that may already exist; renders cost a model call, so the false claim has
  // a price attached.
  const [rendersFailed, setRendersFailed] = useState(false);
  const [assetsById, setAssetsById] = useState<Map<string, MediaAsset>>(new Map());
  const [selectedTemplates, setSelectedTemplates] = useState<Set<string>>(new Set());
  const [directionIndex, setDirectionIndex] = useState<number | ''>('');
  const [ctaText, setCtaText] = useState('');
  const [animate, setAnimate] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [generatingReel, setGeneratingReel] = useState(false);
  // R2 CRB-SP-9 — set when the poll exhausted without observing an outcome.
  const [reelUnresolved, setReelUnresolved] = useState(false);
  // Guard the slow reel poll against unmount — otherwise a still-running loop would
  // setState + toast on a gone component (grade-ux REEL-2).
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const [error, setError] = useState('');
  const [failures, setFailures] = useState<Array<{ templateId: string; error: string }>>([]);
  // Layer overrides (ADR 0399 §a) — a chosen/generated image per layer; unset
  // falls back to the mood board (positions 0/1), the pre-existing default.
  const [layerAssets, setLayerAssets] = useState<{ background?: MediaAsset; product?: MediaAsset }>({});
  const [pickFor, setPickFor] = useState<'background' | 'product' | null>(null);
  const [genFor, setGenFor] = useState<'background' | 'product' | null>(null);

  const templatesById = useMemo(() => new Map((templates ?? []).map((x) => [x.templateId, x])), [templates]);

  const reload = useCallback(async (): Promise<void> => {
    const [rs, assets] = await Promise.all([listRenders(orgId, brief.briefId), listAssets(orgId)]);
    setRenders(rs);
    setAssetsById(new Map(assets.map((a) => [a.assetId, a])));
  }, [orgId, brief.briefId]);

  useEffect(() => {
    let cancelled = false;
    setRenders(null);
    Promise.all([listRenderTemplates(orgId), listRenders(orgId, brief.briefId), listAssets(orgId)])
      .then(([ts, rs, assets]) => {
        if (cancelled) return;
        setTemplates(ts);
        setRenders(rs);
        setAssetsById(new Map(assets.map((a) => [a.assetId, a])));
      })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error && e.message ? e.message : t('rendersLoadFailed')); setTemplates([]); setRenders([]); setRendersFailed(true); } });
    return () => { cancelled = true; };
  }, [orgId, brief.briefId, t]);

  const toggleTemplate = (id: string): void => {
    setSelectedTemplates((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const runRender = async (req?: { templateId: string; overrides?: Record<string, LayerNudge>; base?: CreativeRender }): Promise<void> => {
    const templateIds = req ? [req.templateId] : [...selectedTemplates];
    if (templateIds.length === 0 || rendering) return;
    setRendering(true);
    setFailures([]);
    // CRB-SP-3 — the server renders the STORED brief; a dirty form must save
    // first (and the CTA label says so), or the paid render is of stale text.
    if (dirty && !(await onSaveFirst())) { setRendering(false); return; }
    try {
      // On a nudge re-render (req.base) preserve the ORIGINAL render's layers,
      // so nudging a render that used a generated background doesn't silently
      // swap it for the mood board. On a fresh render, apply the pickers.
      const baseLayers = req?.base?.layerAssets;
      const layers = req?.base
        ? {
            ...(baseLayers?.background ? { background: baseLayers.background.mediaAssetId } : {}),
            ...(baseLayers?.product ? { product: baseLayers.product.mediaAssetId } : {}),
          }
        : {
            ...(layerAssets.background ? { background: layerAssets.background.assetId } : {}),
            ...(layerAssets.product ? { product: layerAssets.product.assetId } : {}),
          };
      const result = await createRenders(orgId, brief.briefId, {
        templateIds,
        ...(req?.base?.directionIndex !== undefined ? { directionIndex: req.base.directionIndex }
          : directionIndex !== '' ? { directionIndex } : {}),
        ...(req?.base ? { copy: req.base.copy } : ctaText.trim() ? { copy: { cta: ctaText.trim() } } : {}),
        ...(req?.overrides ? { overrides: req.overrides } : {}),
        ...(Object.keys(layers).length > 0 ? { layers } : {}),
        ...(req?.base?.animation
          ? { animate: { preset: 'reveal' as const, frames: req.base.animation.frames, fps: req.base.animation.fps } }
          : !req?.base && animate ? { animate: true } : {}),
      });
      setFailures(result.failures);
      if (result.renders.length > 0) toast.success(t('renderDone', { count: result.renders.length }));
      // R2 CRB-SP-8 — the refresh is NOT the operation: its failure used to
      // land in the catch below and toast "Render failed." over a SUCCESSFUL
      // (paid) render, prompting a re-render.
      try { await reload(); }
      catch { toast.error(t('refreshAfterSuccessFailed')); }
    } catch (e) { toast.error(e instanceof Error && e.message ? e.message : t('renderFailed')); }
    finally { setRendering(false); }
  };

  /**
   * REEL-2 — poll a reel run to its outcome and REPORT it.
   *
   * Extracted from `onGenerateReel` so the resume-on-mount effect below runs the exact
   * same loop. Two callers, one implementation: a resumed poll cannot drift from a fresh
   * one, which matters because the resumed path is the one nobody watches.
   *
   * Clears the persisted handle on EVERY terminal outcome — completed, failed, exhausted,
   * or thrown. A handle that outlives its run would resurrect a pending placeholder that
   * can never resolve.
   */
  const pollReel = useCallback(async (runId: string): Promise<void> => {
    try {
      let status = 'pending';
      // R2 CRB-SP-9 — `cancelled` IS a terminal status on the run substrate;
      // treating it as pending kept "Generating reel…" up for the full five
      // minutes and then asserted "failed" about a run the USER cancelled.
      const terminal = (s: string): boolean => s === 'completed' || s === 'failed' || s === 'cancelled';
      for (let i = 0; i < 150 && !terminal(status); i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        // Unmounted: STOP polling, but deliberately do NOT clear the handle. That is the
        // whole point of REEL-2 — the run is still going, and the handle is what lets the
        // next mount pick it up and finally tell the user what happened.
        if (!mountedRef.current) return;
        status = (await getRun(runId)).status;
      }
      if (!mountedRef.current) return;
      if (status === 'completed') {
        clearPendingReel(brief.briefId);
        toast.success(t('reelGenerated'));
        // R2 CRB-SP-8 — a refresh failure must never present a COMPLETED
        // 5-minute video as failed (the handle was already cleared, so there
        // was no retry path either).
        try { await reload(); }
        catch { toast.error(t('refreshAfterSuccessFailed')); }
      } else if (status === 'failed') { clearPendingReel(brief.briefId); toast.error(t('reelFailed')); }
      else if (status === 'cancelled') { clearPendingReel(brief.briefId); toast.info(t('reelCancelled')); }
      // R2 CRB-SP-9 — loop exhaustion: we genuinely do NOT know. Asserting
      // "failed" claimed an observation the client never made. The handle is
      // KEPT so a return visit resumes the poll (the age-out bounds it), and
      // `reelUnresolved` keeps the empty list from claiming "No renders yet"
      // beside a run that may still be live (review fold-in).
      else { setReelUnresolved(true); toast.info(t('reelStillRunning')); }
    } catch (e) {
      clearPendingReel(brief.briefId);
      if (mountedRef.current) toast.error(e instanceof Error && e.message ? e.message : t('reelFailed'));
    } finally {
      if (mountedRef.current) setGeneratingReel(false);
    }
  }, [reload, t, brief.briefId]);

  // ADR 0411 P3b — launch the reel run + poll it (video is slow, 30–120 s); on
  // completion the reel render appears via reload().
  const onGenerateReel = useCallback(async (): Promise<void> => {
    if (generatingReel) return;
    // CRB-SP-3 — same save-first rule as image renders; a reel is the most
    // expensive render of all.
    if (dirty && !(await onSaveFirst())) return;
    setGeneratingReel(true);
    let runId: string;
    try {
      ({ runId } = await generateReel(orgId, brief.briefId, {
        aspectRatio: '9:16',
        ...(typeof directionIndex === 'number' ? { directionIndex } : {}),
      }));
    } catch (e) {
      if (mountedRef.current) {
        toast.error(e instanceof Error && e.message ? e.message : t('reelFailed'));
        setGeneratingReel(false);
      }
      return;
    }
    // Persist BEFORE polling: if the user navigates away one tick later, the handle is
    // already durable. Writing it after the loop would lose exactly the case this fixes.
    setPendingReel(brief.briefId, runId);
    await pollReel(runId);
  }, [generatingReel, orgId, brief.briefId, directionIndex, pollReel, t, dirty, onSaveFirst]);

  // REEL-2 — resume a reel left running by a previous mount. Without this the run
  // completed server-side and the user was never told; now the placeholder returns with
  // them and resolves into the real outcome.
  useEffect(() => {
    const pending = getPendingReel(brief.briefId);
    if (!pending || generatingReel) return;
    setGeneratingReel(true);
    void pollReel(pending.runId);
    // Intentionally keyed on the brief alone: re-running this on `generatingReel` changes
    // would re-enter the poll for a run already being polled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief.briefId]);

  // R2 CRB-SP-13 — in-flight guard: a double-click stacked two DELETEs.
  const [removingRender, setRemovingRender] = useState(false);
  const remove = async (r: CreativeRender): Promise<void> => {
    if (removingRender) return;
    if (!(await confirm({ title: t('renderDeleteConfirm'), danger: true, confirmLabel: t('common:delete') }))) return;
    setRemovingRender(true);
    try { await deleteRender(orgId, brief.briefId, r.renderId); await reload(); }
    catch (e) { toast.error(e instanceof Error && e.message ? e.message : t('actionFailed')); }
    finally { setRemovingRender(false); }
  };

  const copyAssetIdForCampaign = async (r: CreativeRender): Promise<void> => {
    try {
      await navigator.clipboard.writeText(r.mediaAssetId);
      toast.success(t('useInCampaignCopied'));
    } catch { toast.error(t('useInCampaignCopyFailed')); }
  };

  return (
    <section className="surface-card u-p-4 u-grid u-gap-3">
      <h2 className="u-fs-16 u-m-0"><ImageIcon size={16} aria-hidden /> {t('rendersHeading')}</h2>
      <p className="muted u-fs-13 u-m-0">{t('rendersLede')}</p>
      {error ? <Notice variant="error">{error}</Notice> : null}

      {templates === null ? <Skeleton /> : templates.length > 0 ? (
        <div className="u-grid u-gap-2">
          <div className="u-flex u-gap-1 u-wrap" role="group" aria-label={t('templatePickerLabel')}>
            {templates.map((tp) => (
              <button key={tp.templateId} type="button"
                className={`chip chip--muted${selectedTemplates.has(tp.templateId) ? ' is-selected' : ''}`}
                aria-pressed={selectedTemplates.has(tp.templateId)}
                onClick={() => toggleTemplate(tp.templateId)}>
                {platformLabel(tp.platform)} · {tp.width}×{tp.height}
              </button>
            ))}
          </div>
          <div className="u-flex u-gap-2 u-wrap u-items-end">
            {brief.directions.length > 0 ? (
              <SelectField className="u-m-0" label={t('renderDirection')}
                value={directionIndex === '' ? '' : String(directionIndex)}
                onChange={(e) => setDirectionIndex(e.target.value === '' ? '' : Number(e.target.value))}>
                <option value="">{t('renderDirectionTitle')}</option>
                {brief.directions.map((d, i) => <option key={i} value={i}>{d.label}</option>)}
              </SelectField>
            ) : null}
            <TextField className="u-m-0 u-flex-1" label={t('renderCta')} help={t('renderCtaHelp')}
              value={ctaText} onChange={(e) => setCtaText(e.target.value)}
              placeholder={t('renderCtaPlaceholder')} maxLength={60} />
            <CheckboxField className="u-m-0" label={t('renderAnimate')}
              checked={animate} onChange={(e) => setAnimate(e.target.checked)} />
            {/* CRB-SP-3 — the label DISCLOSES the save-first when the form
                above is dirty (the CRB-G1 pattern). */}
            <Button variant="accent-solid" disabled={rendering || selectedTemplates.size === 0}
              onClick={() => void runRender()}>
              {rendering ? t('rendering') : dirty ? t('saveAndRenderSelected', { count: selectedTemplates.size }) : t('renderSelected', { count: selectedTemplates.size })}
            </Button>
            {/* ADR 0411 P3 — generate a text-to-video reel from the brief (async run). */}
            <Button variant="quiet" size="sm" disabled={generatingReel}
              aria-busy={generatingReel} aria-describedby="reel-hint"
              onClick={() => void onGenerateReel()} title={t('generateReelHint')}>
              <SparklesIcon size={13} aria-hidden /> {generatingReel ? t('reelGenerating') : dirty ? t('saveAndGenerateReelCta') : t('generateReelCta')}
            </Button>
          </div>
          {/* REEL-3: the "may take a minute or two" hint, visible (not title-only) and
              wired to the CTA via aria-describedby. REEL-1: an aria-live region so a
              screen-reader user hears the slow poll's progress + terminal state. */}
          <p id="reel-hint" className="u-fs-13 u-text-muted u-mt-1">{t('generateReelHint')}</p>
          <p className="sr-only" role="status" aria-live="polite">{generatingReel ? t('reelGenerating') : ''}</p>
          {/* ADR 0399 §a × ADR 0401 — per-layer imagery: choose from the library
              or GENERATE with AI; unset falls back to the mood board. */}
          <div className="u-flex u-gap-3 u-wrap">
            <LayerSlot t={t} label={t('layerBackground')} asset={layerAssets.background}
              onPick={() => setPickFor('background')} onGenerate={() => setGenFor('background')}
              onClear={() => setLayerAssets(({ background: _drop, ...rest }) => rest)} />
            <LayerSlot t={t} label={t('layerProduct')} asset={layerAssets.product}
              onPick={() => setPickFor('product')} onGenerate={() => setGenFor('product')}
              onClear={() => setLayerAssets(({ product: _drop, ...rest }) => rest)} />
          </div>
        </div>
      ) : null}

      {failures.length > 0 ? (
        <Notice variant="warning">
          {failures.map((f) => `${f.templateId}: ${f.error}`).join(' · ')}
        </Notice>
      ) : null}

      {/* REEL-2 — a reel is running (possibly started on a PREVIOUS mount, resumed above).
          Shown ABOVE the list because it is the newest thing and because an empty list
          under a silent five-minute wait was the defect: the user had no evidence the
          work existed. `aria-live="polite"` so a screen-reader user learns it resumed;
          the button's `aria-busy` covers the in-tab case but not the return-visit one. */}
      {generatingReel ? (
        <p className="muted u-fs-13 u-m-0" aria-live="polite">{t('reelPending')}</p>
      ) : null}

      {renders === null ? <Skeleton /> : rendersFailed ? (
        <span className="muted u-fs-13">{tc('loadFailed')}</span>
      ) : renders.length === 0 ? (
        // Deliberately NOT "no reels yet" while one is generating — the line above already
        // says work is in flight, and claiming emptiness beside it would be the
        // error-beside-empty shape in a new costume. Same rule for an
        // UNRESOLVED poll: the run may still be live (review fold-in).
        <span className="muted u-fs-13">{generatingReel ? '' : reelUnresolved ? t('reelStillRunning') : t('rendersEmpty')}</span>
      ) : (
        <div className="card-grid">
          {renders.map((r) => (
            <RenderCard key={r.renderId} t={t} render={r}
              template={templatesById.get(r.templateId)}
              asset={assetsById.get(r.mediaAssetId)}
              busy={rendering}
              briefVersion={brief.version}
              onRerender={(overrides) => void runRender({ templateId: r.templateId, overrides, base: r })}
              onUse={() => void copyAssetIdForCampaign(r)}
              onRemove={() => void remove(r)} />
          ))}
        </div>
      )}

      {pickFor ? (
        <MediaPickerDialog orgId={orgId}
          onSelect={(a) => { setLayerAssets((c) => ({ ...c, [pickFor]: a })); setPickFor(null); }}
          onClose={() => setPickFor(null)} />
      ) : null}
      {genFor ? (
        <GenerateImageDialog orgId={orgId}
          onSelect={(a) => { setLayerAssets((c) => ({ ...c, [genFor]: a })); setGenFor(null); }}
          onClose={() => setGenFor(null)} />
      ) : null}
    </section>
  );
}

/** One layer image slot (background / product): a thumbnail when chosen, else a
 *  Choose / Generate pair; unset falls back to the mood board. */
function LayerSlot({ t, label, asset, onPick, onGenerate, onClear }: {
  t: TFn; label: string; asset: MediaAsset | undefined;
  onPick: () => void; onGenerate: () => void; onClear: () => void;
}): JSX.Element {
  return (
    <div className="u-grid u-gap-1">
      <span className="field-label">{label}</span>
      {asset ? (
        <div className="u-flex u-items-center u-gap-2">
          <img src={absoluteServeUrl(asset.serveUrl)} alt={asset.name} className="media-thumb-img rendersec-thumb" />
          <span className="u-fs-13 muted">{asset.name}</span>
          <Button variant="quiet" size="sm" aria-label={t('layerClear', { label })} onClick={onClear}><XIcon size={13} aria-hidden /></Button>
        </div>
      ) : (
        <div className="action-bar">
          <Button variant="secondary" size="sm" onClick={onPick}><ImageIcon size={13} aria-hidden /> {t('layerChoose')}</Button>
          <Button variant="quiet" size="sm" onClick={onGenerate}><SparklesIcon size={13} aria-hidden /> {t('layerGenerate')}</Button>
        </div>
      )}
      <span className="muted u-fs-13">{asset ? ' ' : t('layerDefaultHint')}</span>
    </div>
  );
}

function RenderCard({ t, render: r, template, asset, busy, briefVersion, onRerender, onUse, onRemove }: {
  t: TFn; render: CreativeRender; template: AdLayoutTemplate | undefined; asset: MediaAsset | undefined;
  busy: boolean; briefVersion: number; onRerender: (overrides: Record<string, LayerNudge>) => void; onUse: () => void; onRemove: () => void;
}): JSX.Element {
  // R2 CRB-SP-4 — `briefVersion` is stamped at render time and edits bump the
  // brief version, so inequality ⇒ the brief's content changed since this was
  // rendered. It was fetched and discarded: a render of v2 presented as
  // current at v9, and "Use in campaign" handed over the stale asset silently.
  const stale = r.briefVersion !== undefined && r.briefVersion !== briefVersion;
  const [showZones, setShowZones] = useState(false);
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [nudges, setNudges] = useState<Record<string, LayerNudge>>(r.overrides ?? {});
  const zones = template?.safeZones ?? [];
  const w = template?.width ?? 1;
  const h = template?.height ?? 1;
  const nudgeLimit = Math.round(Math.min(w, h) * 0.1);

  const setNudge = (layerId: string, patch: LayerNudge): void => {
    setNudges((cur) => ({ ...cur, [layerId]: { ...cur[layerId], ...patch } }));
  };

  const overlapWarnings = r.warnings.filter((x) => x.code === 'safe-zone-overlap');
  const otherWarnings = r.warnings.filter((x) => x.code !== 'safe-zone-overlap');

  return (
    <figure className="surface-card u-flex u-flex-col u-gap-2 u-p-2 u-m-0">
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        <strong className="u-fs-13">{template ? `${platformLabel(template.platform)} · ${template.format}` : r.templateId}</strong>
        {zones.length > 0 ? (
          <button type="button" className={`chip chip--muted${showZones ? ' is-selected' : ''}`} aria-pressed={showZones}
            onClick={() => setShowZones((v) => !v)}>
            <EyeIcon size={12} aria-hidden /> {t('safeZoneToggle')}
          </button>
        ) : null}
      </div>

      <div className="u-relative">
        {asset && r.reel ? (
          // ADR 0411 P3 — a reel render is a video; play it inline (controls,
          // keyboard-operable; safe-zone overlays are image-only, skipped).
          // R3 CRB-SP-15 remainder — the reel's configured facts were fetched
          // and dropped; absent facts render nothing (no fabricated defaults).
          <video src={absoluteServeUrl(asset.serveUrl)} controls preload="metadata"
            aria-label={t('reelPreviewAlt')}
            className="media-thumb-img u-img-fluid" />
        ) : asset ? (
          <img src={absoluteServeUrl(asset.serveUrl)} alt={t('renderPreviewAlt', { template: r.templateId })}
            className="media-thumb-img u-img-fluid" />
        ) : (
          <div className="media-thumb"><ImageIcon aria-hidden /></div>
        )}
        {r.reel && (r.reel.durationSeconds !== undefined || r.reel.aspectRatio || r.reel.provider) ? (
          // R3 CRB-SP-15 remainder — the reel's configured facts were fetched
          // and dropped; shown whether or not the asset resolved (they are the
          // RENDER's facts). Absent facts render nothing.
          <p className="muted u-fs-12 u-m-0">
            {[
              r.reel.durationSeconds !== undefined ? t('reelFactDuration', { seconds: r.reel.durationSeconds }) : null,
              r.reel.aspectRatio ?? null,
              r.reel.provider ?? null,
            ].filter(Boolean).join(' · ')}
          </p>
        ) : null}
        {showZones && asset ? zones.map((z) => (
          <div key={z.id} title={z.label} aria-hidden
            style={{
              position: 'absolute',
              left: `${(z.x / w) * 100}%`,
              top: `${(z.y / h) * 100}%`,
              width: `${(z.w / w) * 100}%`,
              height: `${(z.h / h) * 100}%`,
              border: '2px dashed var(--color-warning)',
              background: 'transparent',
              pointerEvents: 'none',
            }} />
        )) : null}
      </div>

      <figcaption className="u-fs-13 muted">
        {r.copy.headline}{r.copy.cta ? ` · ${r.copy.cta}` : ''} · {formatDateTime(r.createdAt)}
        {stale ? <> <span className="chip chip--warning">{t('staleRenderChip', { version: r.briefVersion })}</span></> : null}
      </figcaption>

      {overlapWarnings.length > 0 ? (
        <Notice variant="warning">
          {overlapWarnings.map((x) => warningText(t, x)).join(' · ')}
        </Notice>
      ) : null}
      {otherWarnings.length > 0 ? (
        <div className="u-flex u-gap-1 u-wrap">
          {otherWarnings.map((x, i) => (
            <span key={i} className="chip chip--warning" title={x.message}><AlertIcon size={12} aria-hidden /> {warningText(t, x)}</span>
          ))}
        </div>
      ) : null}

      <div className="action-bar">
        {/* CRB-SP-4 — the handoff action carries the staleness disclosure the
            hardest: this is where the stale asset would leave the feature. */}
        <Button variant="secondary" size="sm" onClick={onUse} title={stale ? t('useInCampaignStaleHint', { version: r.briefVersion }) : undefined}>
          <CopyIcon size={14} aria-hidden /> {stale ? t('useInCampaignStale') : t('useInCampaign')}
        </Button>
        <Button variant="quiet" size="sm" aria-expanded={nudgeOpen} onClick={() => setNudgeOpen((v) => !v)}>{t('nudgeToggle')}</Button>
        <Button variant="quiet" aria-label={t('common:delete')} onClick={onRemove}><TrashIcon aria-hidden /></Button>
      </div>

      {nudgeOpen ? (
        <div className="u-grid u-gap-2">
          {NUDGABLE_LAYERS.map((layerId) => (
            <fieldset key={layerId} className="u-m-0 u-p-0 u-border-none">
              <legend className="u-label-sm">{t(`layer_${layerId}`)}</legend>
              <div className="u-flex u-gap-2 u-wrap u-items-center">
                {/* The three nudge sliders keep their live readout, now returned
                    alongside the control from `Field`'s render prop. This is the
                    ONE place in the sweep where layout changes: the label moves
                    from inline to above, which is the primitive's standard and
                    what every other field on these screens already does. */}
                <Field className="u-m-0 u-fs-13" label={t('nudgeDx')}>
                  {(w) => (<>
                    <input {...w} type="range" min={-nudgeLimit} max={nudgeLimit} step={1}
                      value={nudges[layerId]?.dx ?? 0}
                      onChange={(e) => setNudge(layerId, { dx: Number(e.target.value) })} />
                    <span className="u-label-sm">{nudges[layerId]?.dx ?? 0}</span>
                  </>)}
                </Field>
                <Field className="u-m-0 u-fs-13" label={t('nudgeDy')}>
                  {(w) => (<>
                    <input {...w} type="range" min={-nudgeLimit} max={nudgeLimit} step={1}
                      value={nudges[layerId]?.dy ?? 0}
                      onChange={(e) => setNudge(layerId, { dy: Number(e.target.value) })} />
                    <span className="u-label-sm">{nudges[layerId]?.dy ?? 0}</span>
                  </>)}
                </Field>
                <Field className="u-m-0 u-fs-13" label={t('nudgeScale')}>
                  {(w) => (<>
                    <input {...w} type="range" min={0.8} max={1.25} step={0.05}
                      value={nudges[layerId]?.scale ?? 1}
                      onChange={(e) => setNudge(layerId, { scale: Number(e.target.value) })} />
                    <span className="u-label-sm">{formatNumber(nudges[layerId]?.scale ?? 1, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×</span>
                  </>)}
                </Field>
              </div>
            </fieldset>
          ))}
          <div className="action-bar">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => onRerender(nudges)}>{t('nudgeRerender')}</Button>
            <Button variant="quiet" size="sm" onClick={() => setNudges({})}>{t('nudgeReset')}</Button>
          </div>
        </div>
      ) : null}
    </figure>
  );
}

/** Localized warning line — falls back to the server message for unknown codes. */
function warningText(t: TFn, x: RenderWarning): string {
  switch (x.code) {
    case 'safe-zone-overlap': return t('warnSafeZone', { layer: x.layerId ?? '', pct: x.overlapPct ?? 0 });
    case 'text-truncated': return t('warnTruncated', { layer: x.layerId ?? '' });
    case 'text-rule-exceeded': return t('warnTextRule');
    case 'missing-layer-image': return t('warnMissingImage', { layer: x.layerId ?? '' });
    case 'layer-asset-missing': return t('warnMissingImage', { layer: x.layerId ?? '' });
    case 'layer-asset-format': return t('warnAssetFormat', { layer: x.layerId ?? '' });
    case 'no-brand-kit': return t('warnNoBrand');
    case 'brand-font-not-bundled': return t('warnFont');
    case 'logo-not-embeddable': return t('warnLogo');
    default: return x.message;
  }
}
