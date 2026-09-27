/**
 * The app-builder CanvasTypeDefinition (ADR 0310 Phase A) — canvas framework
 * consumer #1. Everything type-specific lives HERE: the doc coercion, the
 * frames/tree trait instances (screens + components), the shared renderer, the
 * screen-reference property widget, the version-history summarizer, the share
 * mint (the sharing feature owns links — the CmsPage precedent), the device
 * presets, and the export/publish toolbar extras (ADR 0173 / ADR 0306). The
 * framework (`src/canvas/`) supplies the whole editor chassis around it.
 */
import { Button } from '../../ui/Button.js';
import { MediaRefWidget } from '../media/MediaRefWidget.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../../ui/toast.js';
import { Modal } from '../../ui/Modal.js';
import { CodeIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { AppBuilderContentView } from '../../chat/artifacts/AppBuilderPreview.js';
import { createLink, sharedPageUrl } from '../sharing/sharingClient.js';
import type { FramesTreeDefinition } from '../../canvas/CanvasEditorPage.js';
import type { PropertyWidgetProps, ToolbarExtrasProps } from '../../canvas/types.js';
import { appBuilderTreeOps, type CompNode, type Screen } from './canvasTree.js';
import { appBuilderFrameOps, insertKitContent, MAX_SCREENS, type AppDoc } from './screenOps.js';
import { appBuilderGraph } from './appBuilderGraph.js';
import { appBuilderPreviewRuntime } from './previewRuntime.js';
import { DataWorkspace } from './DataWorkspace.js';
import { LogicWorkspace } from './LogicWorkspace.js';
import { ContractWorkspace } from './ContractWorkspace.js';
import { summarizeChange } from './historySummary.js';
import { exportCanvasCode, exportDownloadUrl, EXPORT_TARGETS, type ExportTarget } from './canvasEditorClient.js';
import { PublishModal } from './PublishModal.js';
import { SyncModal } from './SyncModal.js';

// ADR 0342 Phase 0 / ADR 0343 (DS-01/DA-01): every recognized document facet
// must survive coercion — the editor loads THROUGH coerceApp and saves the
// result, so a dropped field here is permanent data loss on first save, not
// just a blank picker. The facet unions below are checked for EXHAUSTIVENESS
// against `keyof AppDoc` at compile time: adding a facet to AppDoc without
// carrying it here is a type error, not silent data loss.
type ObjectFacet = 'themeColors' | 'designSystemRef' | 'brandRef' | 'authProfile' | 'sharePolicy';
type ArrayFacet = 'connectors' | 'dataSources' | 'stateVariables' | 'models' | 'operations' | 'envRequirements' | 'componentDefinitions';
type ScalarKeys = 'name' | 'description' | 'theme' | 'schemaVersion' | 'screens';
// If AppDoc gains a key not listed above, this constant fails to typecheck.
const ALL_APP_DOC_KEYS_COVERED: Exclude<keyof AppDoc, ScalarKeys | ObjectFacet | ArrayFacet> extends never ? true : never = true;
void ALL_APP_DOC_KEYS_COVERED;

const OBJECT_FACETS: readonly ObjectFacet[] = ['themeColors', 'designSystemRef', 'brandRef', 'authProfile', 'sharePolicy'];
const ARRAY_FACETS: readonly ArrayFacet[] = ['connectors', 'dataSources', 'stateVariables', 'models', 'operations', 'envRequirements', 'componentDefinitions'];

const pickObj = <K extends ObjectFacet>(state: Record<string, unknown>, key: K): Partial<Pick<AppDoc, K>> => {
  const v = state[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? ({ [key]: v } as Pick<AppDoc, K>) : {};
};
const pickArr = <K extends ArrayFacet>(state: Record<string, unknown>, key: K): Partial<Pick<AppDoc, K>> => {
  const v = state[key];
  return Array.isArray(v) ? ({ [key]: v } as Pick<AppDoc, K>) : {};
};

/** Narrow the canvas state (opaque `Record<string, unknown>`) into the editable App
 *  shape with safe fallbacks — avoids laundering through `as unknown as`. */
export function coerceApp(state: Record<string, unknown>): AppDoc {
  return {
    name: typeof state.name === 'string' ? state.name : 'Untitled app',
    ...(typeof state.description === 'string' ? { description: state.description } : {}),
    ...(typeof state.theme === 'string' ? { theme: state.theme } : {}),
    ...(typeof state.schemaVersion === 'number' ? { schemaVersion: state.schemaVersion } : {}),
    screens: Array.isArray(state.screens) ? (state.screens as Screen[]) : [],
    ...OBJECT_FACETS.reduce((acc, k) => Object.assign(acc, pickObj(state, k)), {}),
    ...ARRAY_FACETS.reduce((acc, k) => Object.assign(acc, pickArr(state, k)), {}),
  };
}

/** ADR 0305 Phase C: screen picker — navigateTo actions reference frames by id. */
function ScreenRefWidget({ id, value, frames, onChange }: PropertyWidgetProps): JSX.Element {
  return (
    <select id={id} className="cv-editor__input" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">—</option>
      {frames.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}

/** ADR 0323 Phase 3: data-source picker — a `list`'s `bind` prop references a doc
 *  dataSource by id (the DataBinding editor, declarative — the value stays a
 *  string id, so export generators + validation are unchanged). Reads the live
 *  doc's `dataSources` via the chassis `docState` context. */
function DataSourceRefWidget({ id, value, docState, onChange }: PropertyWidgetProps): JSX.Element {
  const { t } = useTranslation('app-builder');
  const raw = Array.isArray(docState.dataSources) ? docState.dataSources : [];
  const sources = raw.filter((s): s is { id: string; name?: string } =>
    Boolean(s) && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string');
  return (
    <select id={id} className="cv-editor__input" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{sources.length ? '—' : t('noDataSources')}</option>
      {sources.map((s) => <option key={s.id} value={s.id}>{s.name ?? s.id}</option>)}
    </select>
  );
}

/** Export (ADR 0173) + GitHub publish (ADR 0306) — the app-builder's toolbar
 *  slots, self-gated on their feature toggles. */
function AppBuilderToolbarExtras({ orgId, canvasId, docName, dirty }: ToolbarExtrasProps): JSX.Element {
  const { t } = useTranslation('app-builder');
  const { t: tc } = useTranslation('canvas');
  const codeExport = useFeatureAccess('code-export');
  const codePublish = useFeatureAccess('code-publish');
  // ADR 0393 — two-way GitHub sync rides its own OFF-by-default toggle.
  const codeSync = useFeatureAccess('code-sync');
  const [publishOpen, setPublishOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [exportTarget, setExportTarget] = useState<ExportTarget>('react-tailwind');
  const [exporting, setExporting] = useState(false);
  // AB-G2 — the generator's warnings say what it could NOT express in the chosen
  // target ("component X has no react-native equivalent"), i.e. what is MISSING
  // from the file the user just downloaded. Counting them left the user holding
  // incomplete source with no way to learn which parts.
  const [exportWarnings, setExportWarnings] = useState<string[]>([]);

  const onExport = async (): Promise<void> => {
    setExporting(true);
    setExportWarnings([]);
    try {
      const res = await exportCanvasCode(orgId, canvasId, exportTarget);
      // Trigger the download via the capability-token URL (same-origin → cookies).
      const a = document.createElement('a');
      a.href = exportDownloadUrl(res.serveUrl);
      a.download = res.fileName;
      document.body.appendChild(a); a.click(); a.remove();
      // The server's preflight is the authoritative target-capability review.
      // Keep it beside generator warnings, rather than silently downloading
      // output whose actions/bindings/contract do not survive the target.
      const caveats = [...(res.preflight ?? []).map((note) => note.message), ...res.warnings];
      if (caveats.length) setExportWarnings([...new Set(caveats)]);
      else toast.success(t('exported'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      {codePublish.enabled ? (
        <Button
          variant="secondary" size="sm"
          aria-disabled={dirty}
          onClick={() => {
            if (dirty) { toast.info(tc('previewUnsavedHint')); return; }
            setPublishOpen(true);
          }}
        >
          {t('publish')}
        </Button>
      ) : null}
      {codeExport.enabled ? (
        <span className="action-bar cv-editor__export">
          <select value={exportTarget} onChange={(e) => setExportTarget(e.target.value as ExportTarget)} aria-label={t('exportTarget')} className="btn-sm">
            {EXPORT_TARGETS.map((tg) => <option key={tg} value={tg}>{t(`target_${tg}`)}</option>)}
          </select>
          <Button variant="secondary" size="sm" className="cv-editor__export-btn" disabled={exporting} onClick={() => void onExport()}>
            <CodeIcon size={13} /> {exporting ? t('exporting') : t('exportCode')}
          </Button>
        </span>
      ) : null}
      {codeSync.enabled ? (
        <Button
          variant="secondary" size="sm"
          aria-disabled={dirty}
          onClick={() => {
            if (dirty) { toast.info(tc('previewUnsavedHint')); return; }
            setSyncOpen(true);
          }}
        >
          {t('sync')}
        </Button>
      ) : null}
      {publishOpen ? (
        <PublishModal orgId={orgId} canvasId={canvasId} defaultName={docName} onClose={() => setPublishOpen(false)} />
      ) : null}
      {syncOpen ? (
        <SyncModal orgId={orgId} canvasId={canvasId} onClose={() => setSyncOpen(false)} />
      ) : null}
      {exportWarnings.length ? (
        // The download already happened — this reports what it left out, so
        // dismissing is the only action it needs.
        <Modal label={t('exportWarningsTitle')} onClose={() => setExportWarnings([])} showClose>
          <h2 className="cv-editor__panel-title">{t('exportWarningsTitle')}</h2>
          <p className="cv-editor__empty">{t('exportWarningsIntro', { count: exportWarnings.length, target: t(`target_${exportTarget}`) })}</p>
          <ul className="ab-export-warnings">
            {exportWarnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
          <span className="action-bar">
            <Button variant="secondary" size="sm" onClick={() => setExportWarnings([])}>{t('publishClose')}</Button>
          </span>
        </Modal>
      ) : null}
    </>
  );
}

export const appBuilderDefinition: FramesTreeDefinition<AppDoc, Screen, CompNode> = {
  canvasTypeId: 'canvas.app-builder',
  touchSupport: 'view', // graph authoring needs pointer precision today
  toggleId: 'app-builder',
  clientBasePath: '/host/openwop-app/app-builder',
  editorPath: '/app-builder',
  i18nNamespace: 'app-builder',
  // ADR 0739 — App Builder opts into the generic workbench and contributes
  // only its own vocabulary + a local modifier. The core shell remains free
  // of app-builder imports and every other canvas inherits the same geometry.
  workbench: { workspaceLabelKey: 'workbenchLabel', className: 'cv-editor--app-builder' },
  Renderer: AppBuilderContentView,
  coerceDoc: coerceApp,
  // ADR 0359 Phase 5 — collab via the chassis element binding (mirrors the
  // backend registerCanvasEditorRoutes `collab: true` registration).
  collab: 'elements',
  frames: {
    ops: appBuilderFrameOps,
    key: 'screens',
    homeFlag: 'isInitial',
    max: MAX_SCREENS,
  },
  tree: {
    ops: appBuilderTreeOps,
    rootKey: 'components',
    childrenKey: 'children',
    // ADR 0362 Phase 4 — the bar's quick cluster for common components (the
    // served catalog's enum props; the quick marker never rides the wire).
    quickPropsByType: {
      button: ['variant'],
      heading: ['level'],
      text: ['fontSize', 'tone'],
      stack: ['direction', 'gap'],
    },
  },
  // ADR 0323 — a screen is a node, a connector is an edge; the Graph toggle in
  // the editor opens the screen-flow surface.
  graph: appBuilderGraph,
  summarizeVersions: summarizeChange,
  // ADR 0347 5a — pack-kit instantiation (id remap + connector/nav remap).
  insertKit: insertKitContent,
  // ADR 0737 phase 3 — data and logic are type-owned alternate authoring
  // surfaces. The chassis only supplies the tab shell + history seam.
  workspaceTabs: [
    { id: 'data', labelKey: 'dataTab', Component: DataWorkspace },
    { id: 'logic', labelKey: 'logicTab', Component: LogicWorkspace },
    { id: 'contract', labelKey: 'contractTab', Component: ContractWorkspace },
  ],
  propertyWidgets: { screen: ScreenRefWidget, dataSource: DataSourceRefWidget, mediaRef: MediaRefWidget },
  ToolbarExtras: AppBuilderToolbarExtras,
  preview: {
    // ADR 0345 3b — the closed-action/state runtime (preview + share).
    runtime: appBuilderPreviewRuntime,
    // Audit gap #4 — tap-through plays the matching connector's transition
    // (AI-authored or set in the edge panel); default fade keeps taps legible.
    transitionFor: (doc, from, to) => {
      const cs = Array.isArray(doc.connectors) ? (doc.connectors as { from?: unknown; to?: unknown; transition?: unknown }[]) : [];
      const hit = cs.find((c) => c.from === from && c.to === to);
      return typeof hit?.transition === 'string' ? hit.transition : 'fade';
    },
    devicePresets: [
      { id: 'phone', width: 390 },
      { id: 'phoneLg', width: 430 },
      { id: 'tablet', width: 834 },
      { id: 'tabletLg', width: 1024 },
      { id: 'desktop', width: 1280 },
      { id: 'full', width: 0 },
    ],
    themeOverride: true,
  },
  share: {
    resourceType: 'app_builder_canvas',
    // ADR 0345 3a — what the public page discloses (sample rows redacted by
    // default; the document's sharePolicy can opt sources in).
    disclosureKey: 'shareDisclosure',
    // ADR 0305 Phase D — opaque token, default 7-day TTL per the ADR.
    mint: async (orgId, { resourceId, label }) => {
      const link = await createLink(orgId, { resourceType: 'app_builder_canvas', resourceId, expiresInDays: 7, ...(label ? { label } : {}) });
      return sharedPageUrl(link.token);
    },
  },
};
