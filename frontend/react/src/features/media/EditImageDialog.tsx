/**
 * Edit-image dialog (ADR 0401 P3) — the edit-selection flow every `mediaRef`
 * surface opens on an EXISTING library image: op picker capability-gated per
 * connected provider (an op the provider can't do is disabled with a hint, not
 * offered-then-failed), prompt, a mask painter for inpaint, and 2×/4× upscale.
 * The result is a NEW derived asset (`derivedFrom` lineage — the source is
 * never mutated); the caller swaps the doc's ref.
 *
 * Mask painting is TAINT-FREE by construction: strokes land on their own
 * canvas layered over the <img> (no cross-origin pixels ever enter the
 * canvas), exported at the image's natural size. Convention: white = repaint
 * (the replicate inpaint contract); for OpenAI the painted region exports as
 * TRANSPARENT (its /images/edits contract) — the dialog converts per provider.
 */

import { Button } from '../../ui/Button.js';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Notice } from '../../ui/index.js';
import { KeyIcon, WandIcon, XIcon } from '../../ui/icons/index.js';
import {
  absoluteServeUrl, aiEditAsset, aiUpscaleAsset, listAssets, listImageProviders,
  type ImageEditOp, type ImageProviderOption, type MediaAsset,
} from './mediaClient.js';

type EditAction = ImageEditOp | 'upscale';

const ACTION_ORDER: EditAction[] = ['edit', 'inpaint', 'background-remove', 'upscale'];

export function EditImageDialog({
  orgId,
  imageUrl,
  onSelect,
  onClose,
}: {
  orgId: string;
  /** The mediaRef currently on the doc — resolved back to a library asset. */
  imageUrl: string;
  onSelect: (asset: MediaAsset) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('media');
  const [providers, setProviders] = useState<ImageProviderOption[] | null>(null);
  const [source, setSource] = useState<MediaAsset | null | 'missing'>(null);
  const [provider, setProvider] = useState('');
  const [action, setAction] = useState<EditAction>('edit');
  const [prompt, setPrompt] = useState('');
  const [scale, setScale] = useState<2 | 4>(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<MediaAsset | null>(null);
  /** MED2-B3 — the provider read FAILED, distinct from `[]` (genuinely none). */
  const [providersFailed, setProvidersFailed] = useState(false);
  /** MED2-R1 — the LIBRARY read failed. Distinct from `source === 'missing'`,
   *  which is a positive claim that this image is not one of the user's. */
  const [libraryFailed, setLibraryFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const maskRef = useRef<MaskPainterHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProvidersFailed(false);
    setLibraryFailed(false);
    // MED2-B3 — `allSettled`, not `all`. With `Promise.all` one rejection
    // discarded the OTHER call's success, so a 429 on `listAssets` (the per-IP
    // read budget is a normal state on a fanned-out page) made this dialog
    // claim the workspace has no image provider — while the provider call had
    // in fact succeeded. And the `error` Notice set in the old catch renders
    // inside the else-branch below, so it could never be seen: the real reason
    // was dead code. A failed read is not an answer about the workspace.
    void Promise.allSettled([listImageProviders(orgId), listAssets(orgId)])
      .then(([pRes, aRes]) => {
        if (cancelled) return;
        if (pRes.status === 'fulfilled') {
          const ps = pRes.value;
          setProviders(ps);
          setProvider((cur) => cur || (ps.find((p) => p.ops.includes('edit'))?.provider ?? ps[0]?.provider ?? ''));
        } else {
          setProvidersFailed(true);
        }
        if (aRes.status === 'fulfilled') {
          // Resolve the doc's ref back to its library row by serve token.
          const token = imageUrl.split('/assets/')[1]?.replace(/\/$/, '');
          setSource(aRes.value.find((a) => token && a.serveUrl.includes(token)) ?? 'missing');
        } else if (pRes.status === 'fulfilled') {
          // MED2-R1 — the providers are known; only the library read failed.
          //
          // The first cut of this fix wrote `setSource('missing')` here, under a
          // comment saying "say so rather than reporting the source image as
          // missing" — which is precisely what it then did. `source ===
          // 'missing'` renders "Not a library image", a positive claim about the
          // IMAGE that the failed read never established, on a card with no
          // retry; and the honest string set alongside it lives in a branch
          // reachable only when `source` is a real asset, so it was dead code.
          // One false claim swapped for another, in the fix for that family.
          //
          // `source` stays `null`: a failed read mints no verdict.
          setLibraryFailed(true);
        }
      });
    return () => { cancelled = true; };
  }, [orgId, imageUrl, t, reload]);

  const activeOps = providers?.find((p) => p.provider === provider)?.ops ?? [];

  const run = async (): Promise<void> => {
    if (busy || !source || source === 'missing') return;
    setBusy(true); setError(''); setResult(null);
    try {
      let assets: MediaAsset[];
      if (action === 'upscale') {
        assets = await aiUpscaleAsset(orgId, source.assetId, { scale, provider });
      } else {
        const maskBase64 = action === 'inpaint' ? maskRef.current?.exportMask(provider === 'openai' ? 'mask-alpha' : 'mask-white') : undefined;
        if (action === 'inpaint' && !maskBase64) { setError(t('editMaskRequired')); setBusy(false); return; }
        assets = await aiEditAsset(orgId, source.assetId, {
          op: action,
          ...(action !== 'background-remove' && prompt.trim() ? { prompt: prompt.trim() } : {}),
          ...(maskBase64 ? { maskBase64 } : {}),
          provider,
        });
      }
      setResult(assets[0] ?? null);
    } catch (e) { setError(e instanceof Error && e.message ? e.message : t('editFailed')); }
    finally { setBusy(false); }
  };

  const promptNeeded = action === 'edit' || action === 'inpaint';

  return (
    <Modal onClose={onClose} label={t('editDialogTitle')} showClose>
      <div className="u-grid u-gap-3">
        <h2 className="u-fs-16 u-m-0"><WandIcon size={16} aria-hidden /> {t('editDialogTitle')}</h2>
        {providersFailed || libraryFailed ? (
          /* MED2-B3 — a failed provider read, said plainly and retryable. It
             used to render the "no image provider connected" card, which is a
             claim about the workspace the read never established, with NO exit:
             unlike its sibling this card had no action at all. */
          <StateCard
            announce
            icon={<KeyIcon size={20} />}
            title={providersFailed ? t('generateLoadFailedTitle') : t('editSourceLookupFailedTitle')}
            body={providersFailed ? t('generateLoadFailedBody') : t('editSourceLookupFailed')}
            action={<Button variant="secondary" onClick={() => setReload((n) => n + 1)}>{t('retry')}</Button>}
          />
        ) : providers === null || source === null ? <Skeleton /> : providers.length === 0 ? (
          <StateCard icon={<KeyIcon size={20} />} title={t('generateNoProviderTitle')} body={t('generateNoProviderBody')} />
        ) : source === 'missing' ? (
          <StateCard icon={<WandIcon size={20} />} title={t('editNotLibraryTitle')} body={t('editNotLibraryBody')} />
        ) : (
          <>
            <div className="u-flex u-gap-1 u-wrap" role="group" aria-label={t('editOpPickerLabel')}>
              {ACTION_ORDER.map((op) => {
                const supported = activeOps.includes(op);
                return (
                  <button key={op} type="button"
                    className={`chip chip--muted${action === op ? ' is-selected' : ''}`}
                    aria-pressed={action === op}
                    disabled={!supported}
                    title={supported ? undefined : t('editOpUnsupported', { provider })}
                    onClick={() => setAction(op)}>
                    {t(`editOp_${op}`)}
                  </button>
                );
              })}
              <label className="field u-m-0 u-ml-auto">
                <span className="sr-only">{t('generateProvider')}</span>
                <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label={t('generateProvider')}>
                  {providers.map((p) => <option key={p.provider} value={p.provider}>{p.provider}</option>)}
                </select>
              </label>
            </div>
            {/* UXB-2 — a VISIBLE line of what this provider supports, so the
                disabled-chip reason no longer lives only in a hover title. */}
            <span className="muted u-fs-13">
              {t('editOpsSupported', { provider, ops: ACTION_ORDER.filter((op) => activeOps.includes(op)).map((op) => t(`editOp_${op}`)).join(', ') || t('editOpsNone') })}
            </span>

            {action === 'inpaint' ? (
              <MaskPainter ref={maskRef} imageUrl={absoluteServeUrl(source.serveUrl)} />
            ) : (
              <img src={absoluteServeUrl(source.serveUrl)} alt={source.name} className="media-thumb-img" />
            )}

            {promptNeeded ? (
              <label className="field">
                <span className="field-label">{t('generatePrompt')}</span>
                <textarea rows={2} value={prompt} maxLength={4000}
                  placeholder={action === 'inpaint' ? t('editInpaintPromptPlaceholder') : t('editPromptPlaceholder')}
                  onChange={(e) => setPrompt(e.target.value)} />
              </label>
            ) : null}
            {action === 'upscale' ? (
              <div className="u-flex u-gap-1" role="group" aria-label={t('editScaleLabel')}>
                {([2, 4] as const).map((s) => (
                  <button key={s} type="button" className={`chip chip--muted${scale === s ? ' is-selected' : ''}`}
                    aria-pressed={scale === s} onClick={() => setScale(s)}>{s}×</button>
                ))}
              </div>
            ) : null}

            {error ? <Notice variant="error">{error}</Notice> : null}
            {result ? (
              <figure className="surface-card u-p-2 u-m-0 u-grid u-gap-2">
                <img src={absoluteServeUrl(result.serveUrl)} alt={t('editResultAlt')} className="media-thumb-img" />
                <figcaption className="u-fs-13 muted">{result.name}</figcaption>
              </figure>
            ) : null}

            <div className="action-bar">
              {result ? (
                <>
                  <Button variant="accent-solid" onClick={() => onSelect(result)}>{t('generateUseImage')}</Button>
                  <Button variant="secondary" disabled={busy} onClick={() => void run()}>{t('generateRetry')}</Button>
                </>
              ) : (
                <Button variant="accent-solid" disabled={busy || (promptNeeded && !prompt.trim())} onClick={() => void run()}>
                  {busy ? t('editApplying') : t('editApply')}
                </Button>
              )}
              <Button variant="quiet" onClick={onClose}>{t('common:cancel')}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ── Mask painter ─────────────────────────────────────────────────────────────

/** A mask rectangle in PERCENT of the image (0–100) — percent keeps the
 *  keyboard inputs size-independent; conversion to natural pixels happens at
 *  export. Exported for tests. */
export interface MaskRect { x: number; y: number; w: number; h: number }

/** Clamp a percent rect into the image and convert to natural pixels. Pure;
 *  exported for tests (canvas compositing itself is untestable under jsdom). */
export function maskRectToPixels(r: MaskRect, width: number, height: number): { x: number; y: number; w: number; h: number } | null {
  const clampPct = (v: number): number => Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0));
  const x = clampPct(r.x), y = clampPct(r.y);
  const w = Math.min(clampPct(r.w), 100 - x), h = Math.min(clampPct(r.h), 100 - y);
  if (w <= 0 || h <= 0 || width <= 0 || height <= 0) return null;
  return {
    x: Math.round((x / 100) * width),
    y: Math.round((y / 100) * height),
    w: Math.max(1, Math.round((w / 100) * width)),
    h: Math.max(1, Math.round((h / 100) * height)),
  };
}

interface MaskPainterHandle {
  /** Export the painted mask (brush strokes ∪ rectangles) at the image's
   *  NATURAL size. `mask-white` = white regions on black (the replicate
   *  contract); `mask-alpha` = regions punched transparent out of opaque
   *  black (the OpenAI contract). Returns base64 PNG, or undefined when
   *  nothing was painted. */
  exportMask(mode: 'mask-white' | 'mask-alpha'): string | undefined;
}

/** UXB-1 — masking has TWO modes: the freehand brush (pointer) and a
 *  rectangle mode with BOTH a pointer marquee and a fully keyboard path
 *  (labeled percent inputs + an add button + a removable region list), so a
 *  keyboard-only user can author an inpaint mask. */
const MaskPainter = forwardRef<MaskPainterHandle, { imageUrl: string }>(function MaskPainter({ imageUrl }, ref): JSX.Element {
  const { t } = useTranslation('media');
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paintedRef = useRef(false);
  const drawingRef = useRef(false);
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);
  const [mode, setMode] = useState<'brush' | 'rect'>('brush');
  const [rects, setRects] = useState<MaskRect[]>([]);
  const [marquee, setMarquee] = useState<MaskRect | null>(null);
  const [draft, setDraft] = useState<{ x: string; y: string; w: string; h: string }>({ x: '25', y: '25', w: '50', h: '50' });

  /** Pointer position in PERCENT of the rendered box (== percent of natural). */
  const pctAt = (e: React.PointerEvent<HTMLElement>): { x: number; y: number } => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(100, ((e.clientX - box.left) / box.width) * 100)),
      y: Math.max(0, Math.min(100, ((e.clientY - box.top) / box.height) * 100)),
    };
  };

  const strokeAt = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    const gctx = canvas?.getContext('2d');
    if (!canvas || !gctx) return;
    const p = pctAt(e);
    gctx.fillStyle = 'rgba(255,255,255,0.9)';
    gctx.beginPath();
    gctx.arc((p.x / 100) * canvas.width, (p.y / 100) * canvas.height, Math.max(8, canvas.width / 24), 0, Math.PI * 2);
    gctx.fill();
    paintedRef.current = true;
  };

  const syncSize = (): void => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || !img.naturalWidth) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
  };

  const clear = (): void => {
    const canvas = canvasRef.current;
    const gctx = canvas?.getContext('2d');
    if (canvas && gctx) gctx.clearRect(0, 0, canvas.width, canvas.height);
    paintedRef.current = false;
    setRects([]);
    setMarquee(null);
  };

  const addDraftRect = (): void => {
    const r: MaskRect = { x: Number(draft.x), y: Number(draft.y), w: Number(draft.w), h: Number(draft.h) };
    if (maskRectToPixels(r, 100, 100)) setRects((cur) => [...cur, r]);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    if (mode === 'brush') { drawingRef.current = true; strokeAt(e); return; }
    marqueeStartRef.current = pctAt(e);
    setMarquee(null);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (mode === 'brush') { if (drawingRef.current) strokeAt(e); return; }
    const start = marqueeStartRef.current;
    if (!start) return;
    const p = pctAt(e);
    setMarquee({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
  };
  const onPointerUp = (): void => {
    drawingRef.current = false;
    if (mode === 'rect' && marqueeStartRef.current) {
      marqueeStartRef.current = null;
      setMarquee((m) => {
        if (m && m.w >= 1 && m.h >= 1) setRects((cur) => [...cur, { x: Math.round(m.x), y: Math.round(m.y), w: Math.round(m.w), h: Math.round(m.h) }]);
        return null;
      });
    }
  };

  useImperativeHandle(ref, () => ({
    exportMask(exportMode) {
      const canvas = canvasRef.current;
      if (!canvas || (!paintedRef.current && rects.length === 0)) return undefined;
      // Keyboard-only flow guard: if no stroke ever forced a canvas interaction,
      // the canvas may still carry its 300×150 default — sync to the image's
      // natural size (safe: resizing clears content, and there are no strokes).
      const img = imgRef.current;
      if (!paintedRef.current && img?.naturalWidth && canvas.width !== img.naturalWidth) syncSize();
      // Merge strokes + rectangles onto ONE white-on-transparent paint layer,
      // then compose it onto the black base per the provider contract.
      const painted = document.createElement('canvas');
      painted.width = canvas.width;
      painted.height = canvas.height;
      const pctx = painted.getContext('2d');
      if (!pctx) return undefined;
      pctx.drawImage(canvas, 0, 0);
      pctx.fillStyle = 'rgba(255,255,255,0.95)';
      for (const r of rects) {
        const px = maskRectToPixels(r, painted.width, painted.height);
        if (px) pctx.fillRect(px.x, px.y, px.w, px.h);
      }
      const out = document.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const gctx = out.getContext('2d');
      if (!gctx) return undefined;
      gctx.fillStyle = '#000000';
      gctx.fillRect(0, 0, out.width, out.height);
      if (exportMode === 'mask-white') {
        gctx.drawImage(painted, 0, 0);
      } else {
        gctx.globalCompositeOperation = 'destination-out';
        gctx.drawImage(painted, 0, 0);
      }
      return out.toDataURL('image/png').split(',')[1];
    },
  }), [rects]);

  const draftField = (name: 'x' | 'y' | 'w' | 'h', label: string): JSX.Element => (
    <label className="u-fs-13 u-flex u-items-center u-gap-1">
      {label}
      <input type="number" min={0} max={100} step={1} inputMode="numeric" value={draft[name]}
        className="u-w-4-5r"
        onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.value }))} />
    </label>
  );

  return (
    <div className="u-grid u-gap-1">
      <div className="u-flex u-gap-1 u-items-center u-wrap" role="group" aria-label={t('maskModeLabel')}>
        <button type="button" className={`chip chip--muted${mode === 'brush' ? ' is-selected' : ''}`} aria-pressed={mode === 'brush'} onClick={() => setMode('brush')}>{t('maskModeBrush')}</button>
        <button type="button" className={`chip chip--muted${mode === 'rect' ? ' is-selected' : ''}`} aria-pressed={mode === 'rect'} onClick={() => setMode('rect')}>{t('maskModeRect')}</button>
        <Button variant="quiet" size="sm" className="u-ml-auto" onClick={clear}>{t('editMaskClear')}</Button>
      </div>
      <div className="u-relative">
        {/* The image renders BELOW; strokes land on their own canvas — no
            cross-origin pixels ever enter it (taint-free export). */}
        <img ref={imgRef} src={imageUrl} alt="" aria-hidden className="media-thumb-img u-img-fluid" onLoad={syncSize}
          />
        <canvas ref={canvasRef} aria-label={mode === 'brush' ? t('editMaskHint') : t('editMaskRectHint')}
          className="mediaedit-overlay"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} />
        {[...rects, ...(marquee ? [marquee] : [])].map((r, i) => (
          <div key={i} aria-hidden
            style={{
              position: 'absolute',
              left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%`,
              border: '2px dashed var(--color-warning)',
              background: 'transparent',
              pointerEvents: 'none',
            }} />
        ))}
      </div>
      <span className="muted u-fs-13">{mode === 'brush' ? t('editMaskHint') : t('editMaskRectHint')}</span>
      {mode === 'rect' ? (
        <div className="u-grid u-gap-1">
          {/* The KEYBOARD path (UXB-1): percent inputs + add — no pointer needed. */}
          <div className="u-flex u-gap-2 u-wrap u-items-center">
            {draftField('x', t('maskRectX'))}
            {draftField('y', t('maskRectY'))}
            {draftField('w', t('maskRectW'))}
            {draftField('h', t('maskRectH'))}
            <Button variant="secondary" size="sm" onClick={addDraftRect}>{t('maskRectAdd')}</Button>
          </div>
          {rects.length > 0 ? (
            <ul className="u-m-0 u-p-0 u-list-none" aria-label={t('maskRectListLabel')}>
              {rects.map((r, i) => (
                <li key={i} className="u-flex u-items-center u-gap-2 u-fs-13">
                  <span>{t('maskRectItem', { n: i + 1, x: r.x, y: r.y, w: r.w, h: r.h })}</span>
                  <Button variant="quiet" size="sm" aria-label={t('maskRectRemove', { n: i + 1 })}
                    onClick={() => setRects((cur) => cur.filter((_, j) => j !== i))}>
                    <XIcon size={13} aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/** Test-only alias — the painter is otherwise internal to the dialog. */
export const MaskPainterForTest = MaskPainter;
