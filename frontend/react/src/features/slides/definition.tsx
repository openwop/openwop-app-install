/**
 * The slides CanvasTypeDefinition (ADR 0310 Phase B) — the canvas framework's
 * contract proof: a FIXED-SCHEMA type (no component tree). The frames trait is
 * the `slides` array; the property panel edits the ACTIVE SLIDE's own fields
 * via `frames.propDefs`, keyed by the slide's `layout` discriminator. The ONE
 * deck renderer (`SlidesContentView`, the chat card's renderer) is mounted by
 * the editor preview and the interactive viewer too.
 *
 * Editor-doc note (recorded in ADR 0310): the `host.canvas` working copy is the
 * artifact deck PLUS editor identity fields — `coerceDeck` synthesizes stable
 * per-slide `id`/`name` (the frames trait needs them; the artifact schema is
 * positional). The run artifact itself is never mutated.
 */
import { Button } from '../../ui/Button.js';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { CanvasEditorDefinition } from '../../canvas/CanvasEditorPage.js';
import type { CanvasNode, CanvasPropDef, PropertyWidgetProps } from '../../canvas/types.js';
import { frameOps } from '../../canvas/frameOps.js';
import { treeOps } from '../../canvas/treeOps.js';
import { SlideFrame, SlidesContentView } from '../../chat/artifacts/SlidesPreview.js';
import { useRef, useState } from 'react';
import { Modal, toast } from '../../ui/index.js';
import { DownloadIcon, PlayIcon } from '../../ui/icons/index.js';
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { asJson } from '../../canvas/canvasClient.js';
import { MediaRefWidget } from '../media/MediaRefWidget.js';
import { createLink, sharedPageUrl } from '../sharing/sharingClient.js';
import type { ToolbarExtrasProps } from '../../canvas/types.js';

export type SlideLayout = 'title' | 'title-bullets' | 'section' | 'quote' | 'image' | 'blank' | 'blocks';
export const SLIDE_LAYOUTS: readonly SlideLayout[] = ['title', 'title-bullets', 'section', 'quote', 'image', 'blank', 'blocks'];
/** ADR 0328 P3 — variant = CSS-owned geometry for blocks slides. */
export const SLIDE_VARIANTS = ['full', 'hero', 'split', 'two-col'] as const;

export interface EditorSlide {
  id: string;
  name: string;
  layout: SlideLayout;
  title?: string;
  subtitle?: string;
  bullets?: string[];
  attribution?: string;
  imageUrl?: string;
  background?: string;
  notes?: string;
  /** ADR 0328 P4 — presenter semantics: skipped in present mode. */
  skip?: boolean;
  /** ADR 0328 P5 — motion: entry transition + stepwise block builds. */
  transition?: string;
  build?: boolean;
  /** ADR 0328 P3 — blocks slides only. */
  variant?: string;
  blocks?: CanvasNode[];
}

export interface SlidesDoc {
  title: string;
  theme?: string;
  slides: EditorSlide[];
}

/** Schema cap (artifactTypes.ts caps slides at 100 server-side too). */
export const MAX_SLIDES = 100;

/** Narrow one raw slide, keeping only schema fields (+ editor id/name). */
function coerceSlide(raw: unknown, index: number, used: Set<string>): EditorSlide {
  const v = (raw ?? {}) as Record<string, unknown>;
  const layout = typeof v.layout === 'string' && (SLIDE_LAYOUTS as readonly string[]).includes(v.layout)
    ? (v.layout as SlideLayout)
    : 'title-bullets';
  let id = typeof v.id === 'string' && v.id && !used.has(v.id) ? v.id : '';
  if (!id) {
    let n = index + 1;
    while (used.has(`slide-${n}`)) n += 1;
    id = `slide-${n}`;
  }
  used.add(id);
  const fromTitle = typeof v.title === 'string' && v.title.trim() ? v.title.trim().slice(0, 40) : '';
  const name = typeof v.name === 'string' && v.name.trim() ? v.name : (fromTitle || `Slide ${index + 1}`);
  return {
    id,
    name,
    layout,
    ...(typeof v.title === 'string' ? { title: v.title } : {}),
    ...(typeof v.subtitle === 'string' ? { subtitle: v.subtitle } : {}),
    ...(Array.isArray(v.bullets) ? { bullets: v.bullets.filter((b): b is string => typeof b === 'string') } : {}),
    ...(typeof v.attribution === 'string' ? { attribution: v.attribution } : {}),
    ...(typeof v.imageUrl === 'string' ? { imageUrl: v.imageUrl } : {}),
    ...(typeof v.background === 'string' ? { background: v.background } : {}),
    ...(typeof v.notes === 'string' ? { notes: v.notes } : {}),
    ...(typeof v.skip === 'boolean' ? { skip: v.skip } : {}),
    ...(typeof v.transition === 'string' ? { transition: v.transition } : {}),
    ...(typeof v.build === 'boolean' ? { build: v.build } : {}),
    ...(typeof v.variant === 'string' ? { variant: v.variant } : {}),
    ...(Array.isArray(v.blocks) ? { blocks: (v.blocks as unknown[]).filter((b): b is CanvasNode => Boolean(b) && typeof b === 'object' && typeof (b as { type?: unknown }).type === 'string') } : {}),
  };
}

/** ADR 0328 P3 — one-way legacy→blocks conversion, run by the editor when the
 *  user picks the 'blocks' layout (via `transformOnPropChange`; ONE undo step,
 *  never automatic). Content-preserving: each legacy field becomes its block. */
export function legacyToBlocks(slide: EditorSlide): EditorSlide {
  const blocks: CanvasNode[] = [];
  const push = (type: string, props: Record<string, unknown>): void => { blocks.push({ type, props } as CanvasNode); };
  switch (slide.layout) {
    case 'title':
      if (slide.title) push('heading', { text: slide.title, level: '1' });
      if (slide.subtitle) push('text', { text: slide.subtitle, size: 'lg', tone: 'muted' });
      break;
    case 'section':
      if (slide.title) push('heading', { text: slide.title, level: '1' });
      break;
    case 'quote':
      if (slide.title) push('quote', { text: slide.title, ...(slide.attribution ? { attribution: slide.attribution } : {}) });
      break;
    case 'image':
      if (slide.title) push('heading', { text: slide.title, level: '2' });
      if (slide.imageUrl) push('image', { src: slide.imageUrl, fit: 'cover' });
      break;
    case 'blank':
      break;
    case 'title-bullets':
    default:
      if (slide.title) push('heading', { text: slide.title, level: '2' });
      if (slide.bullets?.length) push('bullets', { items: slide.bullets });
      break;
  }
  const variant = slide.layout === 'title' || slide.layout === 'section' ? 'hero' : 'full';
  const next: EditorSlide = { id: slide.id, name: slide.name, layout: 'blocks', variant, blocks };
  if (slide.notes) next.notes = slide.notes;
  if (slide.background) next.background = slide.background;
  if (slide.skip !== undefined) next.skip = slide.skip;
  if (slide.transition !== undefined) next.transition = slide.transition;
  return next;
}

/** Narrow the canvas state into the editable deck (safe fallbacks; a deck
 *  always has at least one slide — the schema's minItems). */
export function coerceDeck(state: Record<string, unknown>): SlidesDoc {
  const used = new Set<string>();
  const raw = Array.isArray(state.slides) ? state.slides : [];
  const slides = raw.map((s, i) => coerceSlide(s, i, used));
  return {
    title: typeof state.title === 'string' ? state.title : 'Untitled deck',
    ...(typeof state.theme === 'string' ? { theme: state.theme } : {}),
    slides: slides.length ? slides : [{ id: 'slide-1', name: 'Slide 1', layout: 'title' }],
  };
}

export const slidesFrameOps = frameOps<SlidesDoc, EditorSlide>({
  key: 'slides',
  max: MAX_SLIDES,
  slugFallback: 'slide',
  makeFrame: (id, name) => ({ id, name, layout: 'title-bullets' }),
});

/** Layout picker — the built-in enum widget offers an empty option, but
 *  `layout` is required by the schema, so this one never clears. Options carry
 *  friendly localized names (UX nit: raw kebab ids read as jargon). */
function SlideLayoutWidget({ id, value, onChange }: PropertyWidgetProps): JSX.Element {
  const { t } = useTranslation('slides');
  return (
    <select id={id} className="cv-editor__input" value={typeof value === 'string' ? value : 'title-bullets'} onChange={(e) => onChange(e.target.value)}>
      {SLIDE_LAYOUTS.map((l) => <option key={l} value={l}>{t(`layout_${l}`)}</option>)}
    </select>
  );
}

/** Grade pass 2026-07-10 — enum fields were leaking raw wire tokens ('magic',
 *  'two-col', 'accent') as option labels; this widget localizes them through
 *  the slides namespace (`opt_<field>_<value>`), the SlideLayoutWidget
 *  precedent. Registered for the slides enum FIELD types below. */
function LocalizedEnumWidget({ id, def, value, onChange }: PropertyWidgetProps): JSX.Element {
  const { t } = useTranslation('slides');
  const options = def.options ?? [];
  const fallback = typeof def.default === 'string' ? def.default : options[0] ?? '';
  return (
    <select id={id} className="cv-editor__input" value={typeof value === 'string' ? value : fallback} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o} value={o}>{t(`opt_${def.name}_${o}`)}</option>)}
    </select>
  );
}

/** The per-layout field set — mirrors exactly what `SlideBody` renders. */
function slidePropDefs(slide: EditorSlide): CanvasPropDef[] {
  const layout: CanvasPropDef = { name: 'layout', type: 'slide-layout', label: 'Layout', required: true };
  // SL-G7 — the SAME stored field (`title`) is called "Title" on most layouts,
  // "Quote" on the quote layout and "Section title" on a section, so the derived
  // `prop_title` key could not serve all three and this was the one untranslated
  // field in the panel. An explicit
  // `labelKey` per call site fixes it without renaming the stored field.
  const title = (label: string, labelKey: string): CanvasPropDef => ({ name: 'title', type: 'string', label, labelKey });
  const notes: CanvasPropDef = { name: 'notes', type: 'longtext', label: 'Speaker notes' };
  // ADR 0328 Phase 2 — the closed per-slide background accent.
  const background: CanvasPropDef = { name: 'background', type: 'slide-enum', label: 'Background', options: ['default', 'accent'], default: 'default' };
  // ADR 0328 Phase 4 — presenter semantics: skipped in present mode.
  const skip: CanvasPropDef = { name: 'skip', type: 'boolean', label: 'Skip in present mode' };
  // ADR 0328 Phase 5 — motion.
  const transition: CanvasPropDef = { name: 'transition', type: 'slide-enum', label: 'Transition (entry)', options: ['none', 'fade', 'magic'], default: 'none' };
  switch (slide.layout) {
    case 'blocks':
      // ADR 0328 P3 — content lives in the block tree (palette + outline);
      // the frame form keeps only the slide-level knobs.
      return [layout, { name: 'variant', type: 'slide-enum', label: 'Variant', options: [...SLIDE_VARIANTS], default: 'full', quick: true }, { name: 'build', type: 'boolean', label: 'Build blocks one by one', quick: true }, notes, background, skip, transition];
    case 'title':
      return [layout, title('Title', 'prop_title'), { name: 'subtitle', type: 'string', label: 'Subtitle' }, notes, background, skip, transition];
    case 'section':
      return [layout, title('Section title', 'prop_sectionTitle'), notes, background, skip, transition];
    case 'quote':
      return [layout, title('Quote', 'prop_quoteTitle'), { name: 'attribution', type: 'string', label: 'Attribution' }, notes, background, skip, transition];
    case 'image':
      return [layout, title('Title', 'prop_title'), { name: 'imageUrl', type: 'mediaRef', label: 'Image' }, notes, background, skip, transition];
    case 'blank':
      return [layout, notes, background, skip, transition];
    case 'title-bullets':
    default:
      return [layout, title('Title', 'prop_title'), { name: 'bullets', type: 'stringlist', label: 'Bullets (one per line)' }, notes, background, skip, transition];
  }
}


/* ── ADR 0328 Phase 0+1 — the REAL deck export (pptx/pdf) ─────────────── */

const SLIDES_ROOT = `${config.baseUrl}/host/openwop-app/slides`;
const EXPORT_FORMATS = ['pptx', 'pdf'] as const;
type SlidesExportFormat = (typeof EXPORT_FORMATS)[number];
interface SlidesExportResult { assetToken: string; serveUrl: string; fileName: string; sizeBytes: number }

async function exportDeck(orgId: string, canvasId: string, format: SlidesExportFormat): Promise<SlidesExportResult> {
  const res = await fetch(
    `${SLIDES_ROOT}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/export`,
    fetchOpts({ method: 'POST', headers: { ...authedHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ format }) }),
  );
  return asJson<SlidesExportResult>(res, 'export deck');
}

/** The Export toolbar slot — pptx/pdf via the capability-token download (the
 *  code-export delivery pattern). A dirty doc exports the SAVED version, so we
 *  hint rather than block (the preview convention). */
function SlidesToolbarExtras({ orgId, canvasId, dirty }: ToolbarExtrasProps): JSX.Element {
  const { t } = useTranslation('slides');
  const { t: tc } = useTranslation('canvas');
  const [format, setFormat] = useState<SlidesExportFormat>('pptx');
  const [exporting, setExporting] = useState(false);

  const onExport = async (): Promise<void> => {
    if (dirty) toast.info(tc('previewUnsavedHint'));
    setExporting(true);
    try {
      const res = await exportDeck(orgId, canvasId, format);
      const a = document.createElement('a');
      a.href = `${config.baseUrl}${res.serveUrl}`;
      a.download = res.fileName;
      document.body.appendChild(a); a.click(); a.remove();
      toast.success(t('exported'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  const navigate = useNavigate();
  const presentPath = `/slides/${encodeURIComponent(canvasId)}/present`;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  // SL-G5 — the import's per-item skip REASONS, held until the user has read
  // them (see `onImportFile`).
  // SL-G8 — coded reasons localize at RENDER time (a locale switch while the
  // modal is open re-words it); the legacy strings are the older-wire fallback.
  type ImportSkip = { code: 'rich-content'; slide: number } | { code: 'truncated'; total: number };
  const [report, setReport] = useState<{ canvasId: string; skipped: string[]; skippedCoded?: ImportSkip[] } | null>(null);

  // SL-G6 — present mode loads the SAVED canvas from the server, exactly like
  // export does, so unsaved edits are silently absent from what the audience
  // sees. Export already hinted; these two did not. Same hazard, same hint.
  const goPresent = (path: string): void => {
    if (dirty) toast.info(tc('previewUnsavedHint'));
    navigate(path);
  };

  const openImported = (id: string): void => {
    setReport(null);
    navigate(`/slides/${encodeURIComponent(id)}`);
  };

  // ADR 0328 P7 — TEXT-FIDELITY .pptx import: creates a NEW deck and opens it.
  const onImportFile = async (file: File): Promise<void> => {
    setImporting(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      const res = await fetch(
        `${SLIDES_ROOT}/orgs/${encodeURIComponent(orgId)}/canvases/import`,
        fetchOpts({ method: 'POST', headers: { ...authedHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ fileBase64: btoa(bin), name: file.name.replace(/\.pptx$/i, '') }) }),
      );
      const created = await asJson<{ canvasId: string; skipped?: string[]; skippedCoded?: { code: string; slide?: number; total?: number }[] }>(res, 'import deck');
      // SL-G5 — `skipped` is a list of per-item REASONS, one of which is
      // "deck truncated to 100 slides (had N)". Counting them and then
      // navigating away destroyed the only report of what the import lost:
      // dropping 37 slides read identically to 37 skipped images. Show the
      // reasons and let the user leave deliberately.
      if (created.skipped?.length) {
        // Keep only coded entries whose shape this client KNOWS — an unknown
        // future code falls back to the derived string lane rather than
        // rendering a half-localized guess.
        const coded = (created.skippedCoded ?? []).filter(
          (sk): sk is ImportSkip =>
            (sk.code === 'rich-content' && typeof sk.slide === 'number') ||
            (sk.code === 'truncated' && typeof sk.total === 'number'),
        );
        setReport({
          canvasId: created.canvasId,
          skipped: created.skipped,
          ...(coded.length === created.skippedCoded?.length ? { skippedCoded: coded } : {}),
        });
        return;
      }
      toast.success(t('imported'));
      navigate(`/slides/${encodeURIComponent(created.canvasId)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('importFailed'));
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <span className="action-bar cv-editor__export">
      {report ? (
        // Dismissing still opens the deck — it WAS created, and leaving the user
        // on the old one with no route to it would be the worse dead end.
        <Modal label={t('importReportTitle')} onClose={() => openImported(report.canvasId)} showClose>
          <h3>{t('importReportTitle')}</h3>
          <p className="muted">{t('importReportIntro', { count: report.skipped.length })}</p>
          <ul className="cv-editor__import-skips">
            {report.skippedCoded
              ? report.skippedCoded.map((sk, i) => (
                  <li key={`${sk.code}-${i}`}>
                    {sk.code === 'rich-content' ? t('skipRichContent', { slide: sk.slide }) : t('skipTruncated', { total: sk.total })}
                  </li>
                ))
              : report.skipped.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
          <div className="action-bar">
            <Button variant="primary" onClick={() => openImported(report.canvasId)}>
              {t('importReportOpen')}
            </Button>
          </div>
        </Modal>
      ) : null}
      <Button variant="secondary" size="sm" onClick={() => goPresent(presentPath)}>
        <PlayIcon size={13} /> {t('present')}
      </Button>
      <Button variant="quiet" size="sm" onClick={() => goPresent(`${presentPath}?presenter=1`)}>
        {t('presenterView')}
      </Button>
      <input ref={fileRef} type="file" accept=".pptx" className="sr-only" aria-hidden="true" tabIndex={-1} onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f); }} />
      <Button variant="quiet" size="sm" disabled={importing} onClick={() => fileRef.current?.click()}>
        {importing ? t('importing') : t('importPptx')}
      </Button>
      <select value={format} onChange={(e) => setFormat(e.target.value as SlidesExportFormat)} aria-label={t('exportFormat')} className="btn-sm cv-editor__export-select" disabled={exporting}>
        {EXPORT_FORMATS.map((f) => <option key={f} value={f}>{t(`format_${f}`)}</option>)}
      </select>
      <Button variant="secondary" size="sm" className="cv-editor__export-btn" disabled={exporting} onClick={() => void onExport()}>
        <DownloadIcon size={13} /> {exporting ? t('exporting') : t('export')}
      </Button>
    </span>
  );
}

/** ADR 0328 Phase 8 — per-element build timing. A block whose `buildTiming` prop is
 *  'with' joins the PREVIOUS step; anything else ('after' or absent — the
 *  default the catalog declares) starts a new one. The first block always
 *  starts step 1. Pure + exported for tests and the PPTX motion export. */
export function buildGroupCount(blocks: readonly CanvasNode[]): number {
  let groups = 0;
  blocks.forEach((b, i) => {
    const timing = (b as { props?: Record<string, unknown> }).props?.buildTiming;
    if (i === 0 || timing !== 'with') groups += 1;
  });
  return groups;
}

/** The number of leading BLOCKS visible when the first `steps` groups have
 *  been revealed (SlideFrame's cap stays block-count-based). */
export function blocksVisibleForSteps(blocks: readonly CanvasNode[], steps: number): number {
  if (steps <= 0) return 0;
  let groups = 0;
  for (let i = 0; i < blocks.length; i++) {
    const timing = (blocks[i] as { props?: Record<string, unknown> }).props?.buildTiming;
    if (i === 0 || timing !== 'with') {
      groups += 1;
      if (groups > steps) return i;
    }
  }
  return blocks.length;
}


export const slidesDefinition: CanvasEditorDefinition<SlidesDoc, EditorSlide, CanvasNode> = {
  canvasTypeId: 'canvas.slides',
  touchSupport: 'present', // present mode is touch-complete; authoring is pointer-precision
  toggleId: 'slides',
  clientBasePath: '/host/openwop-app/slides',
  editorPath: '/slides',
  i18nNamespace: 'slides',
  Renderer: SlidesContentView,
  coerceDoc: coerceDeck,
  // ADR 0359 Phase 5 — collab via the chassis element binding (mirrors the
  // backend registerCanvasEditorRoutes `collab: true` registration).
  collab: 'elements',
  docNameKey: 'title',
  frames: {
    ops: slidesFrameOps,
    key: 'slides',
    max: MAX_SLIDES,
    propDefs: slidePropDefs,
    // ADR 0328 P3 — picking the 'blocks' layout CONVERTS the slide (one undo
    // step); every other prop change is a plain field set.
    transformOnPropChange: (f, name, value) =>
      (name === 'layout' && value === 'blocks' && f.layout !== 'blocks' ? legacyToBlocks(f) : undefined),
  },
  // ADR 0328 P3 — blocks slides get the chassis tree editing (palette +
  // outline + DnD) over `slide.blocks`; legacy slides keep the form panel.
  tree: {
    ops: treeOps<CanvasNode, EditorSlide>({ rootKey: 'blocks' }),
    rootKey: 'blocks',
    childrenKey: 'children',
  },
  treeEnabledFor: (f) => (f as { layout?: string }).layout === 'blocks',
  // 'stringlist' (bullets) is a PropertyField built-in since ADR 0310 Phase C.
  propertyWidgets: { 'slide-layout': SlideLayoutWidget, 'slide-enum': LocalizedEnumWidget, mediaRef: MediaRefWidget },
  // ADR 0328 Phase 0 — the deck theme is finally EDITABLE (the chassis renders
  // doc props when nothing is selected) and the export button ships.
  docPropDefs: [
    { name: 'theme', type: 'slide-enum', label: 'Theme', options: ['default', 'light', 'dark', 'editorial', 'vibrant', 'brand'], default: 'default' },
  ],
  // ADR 0328 P4 — present mode: one slide full-screen; notes never reach this
  // path (the S7 leak fix is structural — SlideFrame renders content only).
  present: {
    renderFrame: (doc, index, visibleSteps) => {
      const deck = coerceDeck(doc);
      const s = deck.slides[index];
      if (!s) return null;
      // P5 builds + P8 per-element timing: `visibleSteps` counts GROUPS
      // (buildStepsOf below); the SlideFrame cap stays a BLOCK count — map
      // the first N groups onto their block prefix.
      const cap = s.layout === 'blocks' && s.build && visibleSteps !== undefined
        ? blocksVisibleForSteps(s.blocks ?? [], visibleSteps)
        : undefined;
      return <SlideFrame slide={s} theme={typeof doc.theme === 'string' ? doc.theme : 'default'} {...(cap !== undefined ? { visibleBlocks: cap } : {})} />;
    },
    transitionOf: (doc, index) => {
      const s = coerceDeck(doc).slides[index];
      return s?.transition;
    },
    buildStepsOf: (doc, index) => {
      const s = coerceDeck(doc).slides[index];
      return s?.layout === 'blocks' && s.build ? buildGroupCount(s.blocks ?? []) : 0;
    },
    // ADR 0328 P7 — sections are DERIVED: a 'section' slide starts one.
    sectionOf: (doc, index) => {
      const s = coerceDeck(doc).slides[index];
      return s?.layout === 'section' ? (s.title || s.name) : undefined;
    },
  },
  // ADR 0328 P7 — public share links (the sharing feature owns links; the
  // shared viewer is the notes-free one-frame pager). 7-day TTL parity.
  share: {
    resourceType: 'slides_canvas',
    mint: async (orgId, { resourceId, label }) => {
      const link = await createLink(orgId, { resourceType: 'slides_canvas', resourceId, expiresInDays: 7, ...(label ? { label } : {}) });
      return sharedPageUrl(link.token);
    },
  },
  ToolbarExtras: SlidesToolbarExtras,
  preview: {
    devicePresets: [{ id: 'full', width: 0 }],
    themeOverride: true,
  },
};
