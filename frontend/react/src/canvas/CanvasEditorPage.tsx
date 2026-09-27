/**
 * Canvas framework — the full-screen canvas editor shell (ADR 0310, extracted
 * behavior-frozen from the app-builder editor / ADR 0153 Phase 2b + ADR 0305
 * Phase B). Edits a `host.canvas` working copy of a canvas document — outside
 * the chat — with a component palette (from the type's host catalog), frame
 * management (add/rename/duplicate/delete/reorder/home), drag-and-drop onto the
 * live preview, a component-tree outline, a catalog-driven property panel, and
 * bounded undo/redo. Saves with optimistic concurrency (the run artifact is
 * never mutated — the editor edits the seeded copy).
 *
 * Interaction model (ADR 0305 Phase B):
 * - The type's shared renderer stamps `data-cv-path` + `draggable` in edit mode
 *   (`Renderer editPaths`); this page uses DELEGATED pointer/drag events on the
 *   preview — the renderer is never forked.
 * - Every drag has a keyboard equivalent (the PR-457 a11y pattern): palette items
 *   add on Enter/click; the property panel has Move up/down/out/in + Duplicate;
 *   frame tabs have Move left/right menu actions.
 * - Undo/redo is `useHistoryState` (one entry per gesture; the doc-name input
 *   uses `replace` so keystrokes never bury structural ops — builder DEF-6).
 *
 * Reached at `<editorPath>/:canvasId`, or `<editorPath>/new?fromArtifact=<key>`
 * to seed an editable copy from a chat artifact and edit it. Everything here is
 * PER-INSTANCE hook state — no module-level stores (the MyndHyve god-store lesson).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { StateCard, Notice, useHistoryState, useUnsavedChangesWarning } from '../ui/index.js';
import { Menu, type MenuEntry } from '../ui/Menu.js';
import { Modal } from '../ui/Modal.js';
import { confirm } from '../ui/confirm.js';
import {
  ArrowLeftIcon, UndoIcon, RedoIcon, PlusIcon, MoreHorizontalIcon,
  ArrowUpIcon, ArrowDownIcon, CopyIcon, StarIcon,
  ArrowUpToLineIcon, ArrowDownToLineIcon, MousePointerIcon, HelpCircleIcon,
  LockIcon, UnlockIcon, EyeIcon, EyeOffIcon, ChevronDownIcon, ChevronUpIcon,
} from '../ui/icons/index.js';
import { toast } from '../ui/toast.js';
import { copyToClipboard } from '../ui/copyToClipboard.js';
import { GraphSurface } from './graph/GraphSurface.js';
import { usePaletteFavorites } from './usePaletteFavorites.js';
import { getStyleClip, getTreeClip, setStyleClip, setTreeClip } from './treeClipboard.js';
import type { VersionDiffEntry, VersionSummary } from './versionSummary.js';
import { canAdopt } from './childConstraints.js';
import { CanvasOrgGate } from './CanvasOrgGate.js';
import { resolveCanvasOrg, type CanvasOrgResolution } from './resolveCanvasOrg.js';
import { createCanvasClient, listOrgs, type CanvasKitDto, type CanvasRecord, type CatalogResponse, type ComponentDef, type FrameTemplateDto } from './canvasClient.js';
import { addElement, duplicateElement, moveElement, nextGroupId, readElements, removeElement, reorderElements, structuralClone, type ReorderOp } from './elementOps.js';
import { clampDocForSave } from './propBounds.js';
import { tapDown, tapMove, tapUp, type TapState } from './touchTap.js';
import { changedTopLevelKeys } from './versionSummary.js';
import { mergeShortcuts, type ShortcutDef } from './shortcuts.js';
import { ViewportSurface } from './ViewportSurface.js';
import { QuickPropsCluster, quickDefs } from './QuickPropsCluster.js';
import { ViewportHandleContext } from './viewportHandle.js';
import { useRailLayout, RAIL_COLLAPSED_W, type RailSide } from './useRailLayout.js';
import { RailSeparator } from './RailSeparator.js';
import { RailAside } from './RailAside.js';
import { useSurfaceChrome } from './useSurfaceChrome.js';
import { useMediaQuery } from '../ui/useMediaQuery.js';
import { computeAlignPatches, type AlignItem, type AlignOp } from './alignOps.js';
import { ShortcutsOverlay } from './ShortcutsOverlay.js';
import { recallStyle, rememberStyle } from './styleMemory.js';
import { useCollab } from './useCollab.js';
import { useCollabDoc } from './useCollabDoc.js';
import { collabConnectionAnnouncement, collabGuestSuffix, presenceSelfName, useCollabPresence, collabUserColor } from './useCollabPresence.js';
import { CollabPresence } from './CollabPresence.js';
import { Avatar } from '../ui/Avatar.js';
import { useAuth } from '../auth/useAuth.js';
import type { CollabDocShape, CollabIndexRemap } from './collabDocBinding.js';
import type { HistoryState } from '../ui/useHistoryState.js';
import { useFeatureAccess } from '../featureToggles/FeatureAccessContext.js';
import { MIME_ADD, MIME_FRAME, MIME_MOVE, PATH_ATTR, parsePath } from './dnd.js';
import { CanvasHistoryModal } from './HistoryModal.js';
import { TemplateGallery } from './TemplateGallery.js';
import { OutlineTree } from './OutlineTree.js';
import { FlowOutline } from './FlowOutline.js';
import { PropertyField } from './PropertyForm.js';
import { CanvasWorkbench, CanvasWorkbenchStatus } from './CanvasWorkbench.js';
import type { FrameBase } from './frameOps.js';
import type { TreeNodeBase } from './treeOps.js';
import type { CanvasPropDef, CanvasSelectionInfo, CanvasTypeDefinition, ElementActions, ElementsCollectionDef, FramesTraitDef, TreeTraitDef } from './types.js';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** An editor definition — every trait is optional (ADR 0310 Phase C); the
 *  chassis picks the mode: tree (app-builder), frames-only fixed-schema
 *  (slides, `frames.propDefs`), or flat element collections (`elements` +
 *  `docPropDefs` — drawing/cad/campaign). */
export type CanvasEditorDefinition<
  Doc extends object,
  F extends FrameBase,
  N extends TreeNodeBase,
> = CanvasTypeDefinition<Doc, F, N>;

/** The Phase-A name (tree-trait consumers, e.g. the app-builder). */
export type FramesTreeDefinition<
  Doc extends object,
  F extends FrameBase,
  N extends TreeNodeBase,
> = CanvasEditorDefinition<Doc, F, N> & {
  frames: FramesTraitDef<Doc, F>;
  tree: TreeTraitDef<N, F>;
};

/** ADR 0328 P7 — the cross-deck frames clipboard (per canvas type). */
interface FrameClip { name: string; content: Record<string, unknown> }
function readFrameClipboard(canvasTypeId: string): FrameClip | null {
  try {
    const raw = localStorage.getItem(`owp-frames-clip:${canvasTypeId}`);
    const v = raw ? (JSON.parse(raw) as FrameClip) : null;
    return v && typeof v === 'object' && v.content && typeof v.content === 'object' ? v : null;
  } catch { return null; }
}
function hasFrameClipboard(canvasTypeId: string): boolean { return readFrameClipboard(canvasTypeId) !== null; }

/** Default props for a freshly-added component, from its catalog prop defaults. */
function defaultProps(def: ComponentDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of def.props ?? []) if (p.default !== undefined) out[p.name] = p.default;
  return out;
}

/** Dynamic trait-key reads confined here (the concrete doc types stay
 *  index-signature-free; the ops factories own the writes). */
const dict = (o: object): Record<string, unknown> => o as Record<string, unknown>;

/** Set/clear one field on an already-cloned object (frame, element, or doc). */
function setFieldOn(o: object, name: string, value: unknown): void {
  if (value === undefined || value === '') delete dict(o)[name];
  else dict(o)[name] = value;
}

export function CanvasEditorPage<
  Doc extends object,
  F extends FrameBase,
  N extends TreeNodeBase,
>({ definition: def }: { definition: CanvasEditorDefinition<Doc, F, N> }): JSX.Element {
  const { t } = useTranslation('canvas');
  const { t: tt } = useTranslation(def.i18nNamespace);
  const navigate = useNavigate();
  const { canvasId: routeCanvasId } = useParams();
  const [search, setSearch] = useSearchParams();
  const [orgGate, setOrgGate] = useState<Exclude<CanvasOrgResolution, { kind: 'ok' }> | null>(null);
  const fromArtifact = search.get('fromArtifact');

  const client = useMemo(() => createCanvasClient({ basePath: def.clientBasePath }), [def.clientBasePath]);
  const framesDef = def.frames;
  const frameOps = framesDef?.ops;
  const tree = def.tree;
  const treeOps = tree?.ops;
  const elementsDef = def.elements;

  const [orgId, setOrgId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [canvasId, setCanvasId] = useState<string | null>(null);
  // ADR 0359 D2 — chassis-owned collab provisioning. Only when the definition
  // opts in AND the toggle is DEFINITELY on (not merely still resolving) AND the
  // canvas is persisted; the solo path (the norm) never gates or changes.
  // Resolve-once: the surface render below gates while a definitely-on session
  // provisions, so the mounted editor's binding/undo owner never swaps mid-session.
  const collabToggle = useFeatureAccess('realtime-collab');
  const collabEnabled = !!def.collab && collabToggle.enabled === true && !!canvasId;
  // UX-B2 — the explicit Retry re-provisions the session (a bumped attempt).
  const [collabAttempt, setCollabAttempt] = useState(0);
  const collab = useCollab({ canvasId: canvasId ?? undefined, enabled: collabEnabled, attempt: collabAttempt });
  const soloHistory = useHistoryState<Doc | null>(null, def.historyDepth ? { depth: def.historyDepth } : undefined);
  // ADR 0359 Phase 3 — the elements binding. When live, `history` below swaps to
  // a useHistoryState-COMPATIBLE facade backed by the shared Y.Doc: every
  // existing mutation call site (apply/replace/patchElement/name input) commits
  // through the binding's reconciler; undo/redo become per-user Y.UndoManager.
  const collabShape = useMemo<CollabDocShape>(() => ({
    collections: [
      ...(framesDef ? [{ key: framesDef.key, ...(tree ? { nested: { field: tree.rootKey, childrenKey: tree.childrenKey } } : {}) }] : []),
      ...(elementsDef ?? []).map((c) => ({ key: c.key })),
    ],
  }), [framesDef, tree, elementsDef]);
  const seedDocRef = useRef<Doc | null>(null);
  // Selection remap lands via a ref (the selection state is declared below;
  // remote transactions call this asynchronously, in the same commit as the
  // rebuilt doc — ADR 0359 D4).
  const collabRemapRef = useRef<(remap: CollabIndexRemap) => void>(() => {});
  const collabDocFacade = useCollabDoc<Doc>({
    active: def.collab === 'elements' && collabEnabled,
    collab,
    shape: collabShape,
    initialDocRef: seedDocRef,
    coerce: def.coerceDoc,
    onRemote: (remap) => collabRemapRef.current(remap),
  });
  const collabLive = collabDocFacade.live && collabDocFacade.doc !== null;
  const { doc: cDoc, set: cSet, replace: cReplace, undo: cUndo, redo: cRedo, canUndo: cCanUndo, canRedo: cCanRedo } = collabDocFacade;
  const soloReset = soloHistory.reset;
  const history: HistoryState<Doc | null> = useMemo(() => (collabLive
    ? {
      state: cDoc,
      set: (next: Doc | null) => { if (next !== null) cSet(next); },
      replace: (next: Doc | null) => { if (next !== null) cReplace(next); },
      undo: cUndo,
      redo: cRedo,
      canUndo: cCanUndo,
      canRedo: cCanRedo,
      reset: soloReset,
    }
    : soloHistory), [collabLive, cDoc, cSet, cReplace, cUndo, cRedo, cCanUndo, cCanRedo, soloReset, soloHistory]);
  const doc = history.state;
  const [version, setVersion] = useState(0);
  const [frameIdx, setFrameIdx] = useState(0);
  const [selPath, setSelPath] = useState<number[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // R2 CS-SP-7 follow-up — a load 404 is PERMANENT (deleted / foreign org /
  // toggle off), so the full-screen error must not offer a Retry that reloads
  // into the same 404.
  const [errorPermanent, setErrorPermanent] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [renamingIdx, setRenamingIdx] = useState<number | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [outlineDrop, setOutlineDrop] = useState<string | null>(null);
  const [paletteFilter, setPaletteFilter] = useState('');
  // Imperative drop-target highlight (amendment 4): one element at a time,
  // cleared on leave/drop/dragend — never left stuck.
  const highlightRef = useRef<HTMLElement | null>(null);
  // ADR 0365 — the shared chrome-behavior blocks (one owner with the
  // CanvasSurfaceShell composition): dual-channel announcer (UX F2 polite +
  // the RFC 0130 assertive plugin channel), the registry keydown owner + `?`
  // state, ⌘K projection under the FROZEN 'canvas-editor' source/'cv-' ids,
  // and the §7.3 zoom-handle slot.
  const chrome = useSurfaceChrome({
    commandSourceKey: 'canvas-editor',
    commandIdPrefix: 'cv',
    commandsGroupLabel: t('editorCommandsGroup'),
    typeT: (k) => tt(k),
    canvasT: t,
  });
  const { announce, announceAssertive, setAnnounce, dispatchAnnounce, shortcutsOpen, setShortcutsOpen, viewportSlot, viewportSlotApi } = chrome;
  // Grade pass (code F9): edits made WHILE a save is in flight must not be
  // marked clean by that save's resolution.
  const editGen = useRef(0);
  // Grade pass (UX F8): focus target after destructive ops (the outline panel).
  const outlineRef = useRef<HTMLDivElement | null>(null);
  // ADR 0458 a11y — bump on a KEYBOARD reorder so focus follows the moved row
  // (ARIA APG). Gated so it fires ONLY on reorder, never on click-select.
  const [reorderTick, setReorderTick] = useState(0);
  // ADR 0334 — the rendered-content container, for the flow-outline scroll target.
  const previewRef = useRef<HTMLDivElement | null>(null);
  // Frames-mode counterpart (grade pass UX-CV-3): frame deletes land here.
  const framesNavRef = useRef<HTMLElement | null>(null);

  // While a collab room is live the CRDT is durable (snapshot-persisted) — the
  // CAS dirty flag is meaningless and must not trap navigation (ADR 0359).
  useUnsavedChangesWarning(dirty && !collab.enabled);

  /** Read-only frame/tree accessors (render path — never create-on-read). */
  const framesKey = framesDef?.key;
  const homeFlag = framesDef?.homeFlag;
  const readFrames = useCallback((d: Doc): F[] => {
    if (!framesKey) return [];
    const v = dict(d)[framesKey];
    return Array.isArray(v) ? (v as F[]) : [];
  }, [framesKey]);
  const isHome = useCallback((f: F): boolean => (homeFlag ? dict(f)[homeFlag] === true : false), [homeFlag]);
  const rootKey = tree?.rootKey;
  const childrenKey = tree?.childrenKey;
  const rootChildren = useCallback((f: F): N[] => {
    if (!rootKey) return [];
    const v = dict(f)[rootKey];
    return Array.isArray(v) ? (v as N[]) : [];
  }, [rootKey]);
  const childrenOf = useCallback((n: N): N[] | undefined => {
    if (!childrenKey) return undefined;
    const v = dict(n)[childrenKey];
    return Array.isArray(v) ? (v as N[]) : undefined;
  }, [childrenKey]);
  /** The doc field the toolbar's name input edits (slides: 'title'). */
  const nameKey = def.docNameKey ?? 'name';

  // Grade pass GC-CV-10: `tree` and `elements` are MUTUALLY EXCLUSIVE chassis
  // modes (tree wins the render branch); a definition declaring both is a
  // developer error the chassis would otherwise swallow. Warn once in dev.
  useEffect(() => {
    if (import.meta.env.DEV && tree && elementsDef) {
      console.error(`CanvasEditorDefinition '${def.canvasTypeId}' declares BOTH \`tree\` and \`elements\` — these are mutually exclusive modes; \`tree\` wins and \`elements\` is ignored.`);
    }
  }, [tree, elementsDef, def.canvasTypeId]);

  // Load: org → catalog → (seed-from-artifact | get) the canvas.
  const { reset } = soloHistory;
  const coerceDoc = def.coerceDoc;
  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true); setError(null);
      try {
        const orgs = await listOrgs();
        // The route carries only :canvasId, but the API is org-scoped, so the
        // org must come from the link (`?org=`) — not from a guess. `orgs[0]`
        // opened the wrong workspace for anyone in more than one, and the
        // canvas they actually clicked came back as a generic load error.
        const resolved = resolveCanvasOrg(orgs, search.get('org'));
        if (resolved.kind !== 'ok') { if (live) setOrgGate(resolved); return; }
        const org = resolved.orgId;
        if (live) setOrgGate(null);
        const cat = await client.getCatalog(org);
        let rec: CanvasRecord;
        if (routeCanvasId === 'new' && fromArtifact) {
          rec = await client.seedFromArtifact(org, fromArtifact);
        } else if (routeCanvasId) {
          rec = await client.getCanvas(org, routeCanvasId);
        } else {
          throw new Error(t('loadError'));
        }
        if (!live) return;
        setOrgId(org); setCatalog(cat); setCanvasId(rec.canvasId);
        const coerced = coerceDoc(rec.state);
        // ADR 0359 Phase 3 — the seeder election reads the loaded copy.
        seedDocRef.current = coerced;
        reset(coerced); setVersion(rec.version); setDirty(false);
      } catch (e) {
        // R2 (campaign-studio CS-SP-7, chassis-wide) — a 404 is a DESIGNED
        // outcome, not a raw error string: the canvas doesn't exist for this
        // caller (deleted, wrong org, or its feature toggle is off — the
        // server fails those closed uniformly). Distinguish it from transport
        // failures so a disabled feature's deep-link reads intentional.
        if (live) {
          const status = (e as { status?: number }).status;
          setErrorPermanent(status === 404);
          setError(status === 404 ? t('notAvailable') : e instanceof Error ? e.message : t('loadError'));
        }
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [routeCanvasId, fromArtifact, t, reset, client, coerceDoc, search]);

  // Audit polish P2 — per-device favorites + recently-used (localStorage, the
  // useViewMode precedent), surfaced as pinned pseudo-groups above categories.
  const palettePrefs = usePaletteFavorites(def.canvasTypeId);

  // Category-grouped, filter-narrowed palette (insertion order preserved), with
  // Favorites + Recent pinned first (filter-aware; stale types — removed from
  // the catalog — are silently skipped).
  const paletteGroups = useMemo(() => {
    const q = paletteFilter.trim().toLowerCase();
    const match = (c: ComponentDef): boolean => !q || c.label.toLowerCase().includes(q) || c.type.toLowerCase().includes(q);
    const byType = new Map((catalog?.components ?? []).map((c) => [c.type, c]));
    const resolve = (types: readonly string[]): ComponentDef[] =>
      types.map((t2) => byType.get(t2)).filter((c): c is ComponentDef => Boolean(c) && match(c!));
    const groups = new Map<string, ComponentDef[]>();
    const favs = resolve(palettePrefs.favorites);
    if (favs.length) groups.set('__favorites', favs);
    const recents = resolve(palettePrefs.recents).filter((c) => !palettePrefs.favorites.includes(c.type));
    if (recents.length) groups.set('__recent', recents);
    for (const c of catalog?.components ?? []) {
      if (!match(c)) continue;
      const list = groups.get(c.category) ?? [];
      list.push(c);
      groups.set(c.category, list);
    }
    return [...groups.entries()];
  }, [catalog, paletteFilter, palettePrefs.favorites, palettePrefs.recents]);

  const frames = useMemo(() => (doc ? readFrames(doc) : []), [doc, readFrames]);

  // ADR 0328 (C6) / ADR 0334 (C9) — a chassis-level History-Compare default.
  // Frames-trait types with no custom summarizer get an added/removed/renamed
  // frame diff; every OTHER type (elements/flow/none) with no custom summarizer
  // gets a generic top-level field diff — so no type ships a blank Compare.
  // NOTE: the summarize contract passes the TYPE-namespace t; the chassis
  // default deliberately uses the CANVAS namespace instead (chassis strings
  // exist for every type; per-type catalogs don't carry these keys).
  const defaultVersionSummarizer = useMemo(() => {
    if (def.summarizeVersions) return def.summarizeVersions;
    if (framesDef) {
      // ADR 0344 2d — the default frames-differ emits the STRUCTURED shape
      // (the domain-neutral proof of the VersionDiff contract).
      return (snapshot: Doc, current: Doc, _t2: (k: string, o?: Record<string, unknown>) => string): VersionSummary => {
        const snap = readFrames(snapshot);
        const cur = readFrames(current);
        const snapById = new Map(snap.map((f) => [f.id, f]));
        const curById = new Map(cur.map((f) => [f.id, f]));
        const entries: VersionDiffEntry[] = [];
        for (const f of cur) if (!snapById.has(f.id)) entries.push({ path: `frames[${f.id}]`, kind: 'added', label: t('versionFrameAddedSince', { name: f.name || f.id }) });
        for (const f of snap) {
          const now = curById.get(f.id);
          if (!now) entries.push({ path: `frames[${f.id}]`, kind: 'removed', label: t('versionFrameRemovedSince', { name: f.name || f.id }) });
          else if ((now.name || '') !== (f.name || '')) entries.push({ path: `frames[${f.id}]`, kind: 'changed', label: t('versionFrameRenamed', { from: f.name || f.id, to: now.name || now.id }) });
        }
        const lines = entries.length ? [] : (snap.length !== cur.length ? [t('versionFrameCount', { from: snap.length, to: cur.length })] : [t('versionNoFrameChanges')]);
        return { lines, entries };
      };
    }
    // Generic fallback (ADR 0334) — which top-level doc keys changed. A shallow
    // structural diff is deliberately coarse (a rich-text doc reports "content
    // changed"); a type wanting finer detail supplies `summarizeVersions`.
    return (snapshot: Doc, current: Doc, _t2: (k: string, o?: Record<string, unknown>) => string): VersionSummary => {
      const changed = changedTopLevelKeys(snapshot as Record<string, unknown>, current as Record<string, unknown>);
      return {
        lines: changed.length ? [] : [t('versionNoChanges')],
        entries: changed.map((k) => ({ path: k, kind: 'changed' as const, label: t('versionFieldChanged', { field: k }) })),
      };
    };
  }, [framesDef, def.summarizeVersions, readFrames, t]);
  const frame = frames[frameIdx] ?? null;
  // ADR 0328 P3 — tree editing can be gated per-FRAME (`treeEnabledFor`):
  // slides enable the palette/outline only on blocks-based slides; legacy
  // slides keep the fixed-schema form panel. Absent predicate = all frames.
  const treeActive = Boolean(tree && frame && (def.treeEnabledFor?.(frame) ?? true));
  const docName = doc ? String(dict(doc)[nameKey] ?? '') : '';
  const selNode = useMemo(() => (treeOps && frame && selPath ? treeOps.nodeAt(frame, selPath) : null), [frame, selPath, treeOps]);
  const selDef = useMemo(() => (selNode && catalog ? catalog.components.find((c) => c.type === selNode.type) ?? null : null), [selNode, catalog]);
  // ADR 0344 2b — the selection's authoring traits (declared beside the
  // selection so every later callback can list it as a dependency).
  const selLocked = Boolean(selNode?.locked);


  // Amendment 5: after undo/redo (or any structural change) clamp the frame
  // index and drop a selection whose path no longer resolves.
  useEffect(() => {
    if (!doc) return;
    const list = readFrames(doc);
    if (frameIdx >= list.length) setFrameIdx(Math.max(0, list.length - 1));
    else if (selPath) {
      const f = list[frameIdx];
      if (!f || !treeOps || !treeOps.nodeAt(f, selPath)) setSelPath(null);
    }
  }, [doc, frameIdx, selPath, readFrames, treeOps]);

  /** Apply one user gesture to a cloned doc → one history entry. */
  const editDoc = useCallback((fn: (d: Doc) => void) => {
    if (!doc) return;
    const next = clone(doc);
    fn(next);
    history.set(next);
    editGen.current += 1;
    setDirty(true);
  }, [doc, history]);

  /** Gesture on the ACTIVE frame. */
  const editFrame = useCallback((fn: (f: F) => void) => {
    if (!frameOps) return;
    editDoc((d) => { const f = frameOps.frames(d)[frameIdx]; if (f) fn(f); });
  }, [editDoc, frameOps, frameIdx]);

  // (dispatchAnnounce comes from useSurfaceChrome — stable across renders,
  // preserving the GC-CV-3 PluginFrame re-subscribe fix.)

  // ADR 0323 — the graph surface's a11y strings (canvas ns).
  const graphLabels = useMemo(() => ({
    // Same type-vocabulary override as `empty` below: an elements-backed board
    // is not a "Screen-flow graph" (CT-CV-6 — campaign words it "Funnel board").
    surface: tt('graphSurface', { defaultValue: t('graphSurface') }),
    connectFrom: t('graphConnectFrom'),
    connectTo: t('graphConnectTo'),
    cancelConnect: t('graphCancelConnect'),
    connectArmed: t('graphConnectArmed'),
    connected: t('graphConnected'),
    deletedEdge: t('graphDeletedEdge'),
    home: t('graphHome'),
    // Type-vocabulary override (the §7 fixed type-key contract): a type may
    // word its own board empty state ('No funnel stages yet' vs screens);
    // absent, the canvas-ns default applies (ADR 0360 ux-review finding).
    empty: tt('graphEmpty', { defaultValue: t('graphEmpty') }),
    addConnected: t('graphAddConnected'),
    edgeSelected: t('graphEdgeSelected'),
    deviceFrame: t('graphDeviceFrame'),
    minimap: t('graphMinimap'),
  }), [t, tt]);

  const undo = useCallback(() => { if (history.canUndo) { history.undo(); editGen.current += 1; setDirty(true); setAnnounce(t('annUndid')); } }, [history, t, setAnnounce]);
  const redo = useCallback(() => { if (history.canRedo) { history.redo(); editGen.current += 1; setDirty(true); setAnnounce(t('annRedid')); } }, [history, t, setAnnounce]);
  // ADR 0334 — an EditorSurface (rich-text engine) owns its OWN undo/redo; its
  // edits update the working copy via `history.replace` (NO new chassis undo
  // step, like the name field) and mark dirty. The chassis undo/redo buttons are
  // hidden for EditorSurface types so the two undo stacks never fight.
  const onEditorDocChange = useCallback((next: Doc) => { history.replace(next); editGen.current += 1; setDirty(true); }, [history]);

  // ADR 0333 Phase 8 — touch tap-undo: a clean multi-finger TAP on the preview
  // maps 2→undo, 3→redo (the verified Procreate convention). The detection is a
  // PURE state machine (`canvas/touchTap.ts`, DRAW-R2) so the DRAW-D3 bug (a
  // cross-finger distance check) stays unit-tested; the component holds the ref
  // and dispatches the `fire` result.
  const tapRef = useRef<TapState | null>(null);
  const onPreviewTouchDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'touch') tapRef.current = tapDown(tapRef.current, e.pointerId, e.clientX, e.clientY, performance.now());
  }, []);
  const onPreviewTouchMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'touch') tapMove(tapRef.current, e.pointerId, e.clientX, e.clientY);
  }, []);
  const onPreviewTouchUp = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const { state, fire } = tapUp(tapRef.current, e.pointerId, performance.now());
    tapRef.current = state;
    if (fire === 2) { undo(); setAnnounce(t('annUndid')); }
    else if (fire === 3) { redo(); setAnnounce(t('annRedid')); }
  }, [undo, redo, t, setAnnounce]);

  // ONE window-keydown owner: the declarative shortcut registry (ADR 0333
  // Phase 2) — chassis defaults (undo/redo/Esc/arrange/`?`) merged with the
  // definition's extras; text contexts + IME + open dialogs never match. The
  // registry is rebuilt per render into a ref (cheap), the listener binds once.
  // §7.3 / CV-3 — the zoom-handle slot (from the shared chrome hook); the view
  // shortcuts (⇧1/⇧2/⇧0) dispatch against it; null = no zoomable center.
  // §7.2 / CV-14+CV-16 — rail geometry: resizable + independently collapsible,
  // persisted per canvas type; both collapsed = focus mode (`[` / `]`).
  const rails = useRailLayout(def.canvasTypeId);
  const railVars = {
    '--cv-rail-l': `${rails.l.collapsed ? RAIL_COLLAPSED_W : rails.l.w}px`,
    '--cv-rail-r': `${rails.r.collapsed ? RAIL_COLLAPSED_W : rails.r.w}px`,
  } as React.CSSProperties;
  // §7.2.1 / CV-15 — the breakpoint-driven `⋮` overflow (deterministic; never
  // a measurement loop). Below 920px the view cluster folds into one Menu.
  const narrowBar = useMediaQuery('(max-width: 920px)');
  const toggleRail = useCallback((side: RailSide) => {
    const willCollapse = !(side === 'l' ? rails.l.collapsed : rails.r.collapsed);
    rails.toggle(side);
    setAnnounce(t(side === 'l'
      ? (willCollapse ? 'annPaletteCollapsed' : 'annPaletteExpanded')
      : (willCollapse ? 'annPropsCollapsed' : 'annPropsExpanded')));
  }, [rails, t, setAnnounce]);
  // (The window-keydown registry owner lives in useSurfaceChrome.)

  // ---- component add / edit / arrange -------------------------------------

  const makeNode = useCallback((cdef: ComponentDef): N => ({ type: cdef.type, props: defaultProps(cdef) } as N), []);

  const addComponent = useCallback((cdef: ComponentDef) => {
    if (!treeOps) return;
    palettePrefs.noteUsed(cdef.type); // audit polish P2 — feeds the Recent group
    const node = makeNode(cdef);
    // Add into the selected container if it accepts children (and is not
    // locked — ADR 0344 2b — and adopts this type — 2c), else at frame root.
    const selCount = selNode ? (childrenOf(selNode) ?? []).length : 0;
    const parent = selPath && selDef?.acceptsChildren && !selLocked && canAdopt(selDef, cdef.type, selCount) ? selPath : null;
    editFrame((f) => treeOps.addChild(f, parent, node));
    setAnnounce(t(parent ? 'annAddedInto' : 'annAdded', { type: cdef.label }));
  }, [editFrame, treeOps, makeNode, selPath, selNode, selDef, selLocked, childrenOf, t, palettePrefs, setAnnounce]);

  // ADR 0344 2b — the flag writer. Locked gates every mutating gesture BUT
  // the flag writer itself (you must be able to unlock a locked node).
  const setNodeFlag = useCallback((flag: 'hidden' | 'locked', value: boolean) => {
    if (!treeOps || !selPath || selPath.length === 0) return;
    editFrame((f) => {
      const n = treeOps.nodeAt(f, selPath);
      if (!n) return;
      if (value) n[flag] = true;
      else delete n[flag];
    });
    setAnnounce(t(value ? (flag === 'hidden' ? 'annNodeHidden' : 'annNodeLocked') : (flag === 'hidden' ? 'annNodeShown' : 'annNodeUnlocked')));
  }, [editFrame, treeOps, selPath, t, setAnnounce]);
  /** Is the node at `path` (on the active frame) locked? Drag-move guard. */
  const isLockedAt = useCallback((path: number[]): boolean => {
    if (!treeOps || !frame) return false;
    return Boolean(treeOps.nodeAt(frame, path)?.locked);
  }, [treeOps, frame]);
  /** The catalog def + current child count of the container at `path` (null =
   *  the frame root, unconstrained) — the ADR 0344 2c adoption inputs. */
  const containerAt = useCallback((path: number[] | null): { def: ComponentDef | null; count: number } => {
    if (!frame) return { def: null, count: 0 };
    if (path === null) return { def: null, count: rootChildren(frame).length };
    const node = treeOps?.nodeAt(frame, path);
    const cdef = node && catalog ? catalog.components.find((c) => c.type === node.type) ?? null : null;
    return { def: cdef, count: node ? (childrenOf(node) ?? []).length : 0 };
  }, [frame, treeOps, catalog, rootChildren, childrenOf]);
  /** Shared 2c refusal: false + an announcement when the slot can't adopt. */
  const adoptOrAnnounce = useCallback((parent: number[] | null, childType: string, opts?: { sameParent?: boolean }): boolean => {
    const { def: pdef, count } = containerAt(parent);
    // A same-parent MOVE doesn't change the count — only the type rule applies.
    const ok = canAdopt(pdef, childType, opts?.sameParent ? 0 : count);
    if (!ok) setAnnounce(t('annChildNotAllowed', { container: pdef?.label ?? '' }));
    return ok;
  }, [containerAt, t, setAnnounce]);

  const setProp = useCallback((name: string, value: unknown) => {
    if (!treeOps || !selPath || selLocked) return;
    editFrame((f) => treeOps.setPropAt(f, selPath, name, value));
  }, [editFrame, treeOps, selPath, selLocked]);

  // Grade pass (code F10): TEXT-family prop edits ride `history.replace` — the
  // DEF-6 contract (structural ops undo; keystrokes use the field's native
  // undo). Per-keystroke `set` calls were wiping the whole 30-deep stack.
  const setPropText = useCallback((name: string, value: unknown) => {
    if (!treeOps || !frameOps || !doc || !selPath || selLocked) return;
    const next = clone(doc);
    const f = frameOps.frames(next)[frameIdx];
    if (f) treeOps.setPropAt(f, selPath, name, value);
    history.replace(next);
    editGen.current += 1;
    setDirty(true);
  }, [doc, history, frameOps, treeOps, selPath, selLocked, frameIdx]);

  // Fixed-schema field editing (ADR 0310 Phases B/C): the property panel edits
  // an object's own fields (the active frame, a flat element, or the doc).
  // `undefined`/'' clears the field (constrained editor docs mirror
  // `additionalProperties: false`).
  const setFrameField = useCallback((f: F, name: string, value: unknown) => {
    setFieldOn(f, name, value);
  }, []);

  const setFrameProp = useCallback((name: string, value: unknown) => {
    if (!frameOps) return;
    editDoc((d) => {
      const list = frameOps.frames(d);
      const f = list[frameIdx];
      if (!f) return;
      // ADR 0328 P3 — a definition may intercept a frame prop change with a
      // WHOLE-frame transform (slides: picking layout 'blocks' converts the
      // legacy fields). One undo step, same as a plain field set.
      const transformed = framesDef?.transformOnPropChange?.(f, name, value);
      if (transformed) { list[frameIdx] = transformed; return; }
      setFrameField(f, name, value);
    });
  }, [editDoc, frameOps, frameIdx, setFrameField, framesDef]);

  const setFramePropText = useCallback((name: string, value: unknown) => {
    if (!frameOps || !doc) return;
    const next = clone(doc);
    const f = frameOps.frames(next)[frameIdx];
    if (f) setFrameField(f, name, value);
    history.replace(next);
    editGen.current += 1;
    setDirty(true);
  }, [doc, history, frameOps, frameIdx, setFrameField]);

  // ---- flat element collections (ADR 0310 Phase C — the elements trait) -----

  /** The element MULTI-selection (a collection key + positional indices) — the
   *  single source of truth, shared by the list and the interactive canvas
   *  (ADR 0317). `selEl` (the property-panel single target + arrange/delete
   *  scope) is DERIVED: it exists only when exactly one element is selected. */
  const [multiSel, setMultiSel] = useState<{ col: string; idxs: number[] } | null>(null);
  // ADR 0359 Phase 4 / D5 — presence. Publishes this client's identity +
  // selection over awareness (throttled) and mirrors the peers; join/leave
  // lands COALESCED in the polite live region (never a per-edit firehose).
  const { user: authUser } = useAuth();
  // Live-CT finding: anonymous/cookie sessions all fell back to the SAME
  // "Guest" label — which also hash-derives the SAME hue, so anonymous peers
  // were indistinguishable by name AND color. A stable per-mount suffix gives
  // each guest a distinct identity (and therefore a distinct hue).
  const guestIdRef = useRef('');
  if (!guestIdRef.current) guestIdRef.current = collabGuestSuffix();
  const presence = useCollabPresence({
    collab,
    // RTCC-4 — never fall back to email here: `selfName` is broadcast to all
    // room peers via Yjs awareness. A no-displayName user gets the non-PII guest
    // label, never their email address.
    selfName: presenceSelfName(authUser, t('guestN', { id: guestIdRef.current })),
    sel: multiSel && multiSel.idxs.length > 0 ? { col: multiSel.col, idx: multiSel.idxs[0]! } : null,
    frame: framesDef ? frameIdx : null,
    onPeersChanged: ({ joined, left }) => {
      // UX-I4 — ONE composed message: a join and a leave in the same coalesce
      // window must both be announced (two setAnnounce calls = last write wins).
      const parts: string[] = [];
      if (joined.length === 1) parts.push(t('annPeerJoined', { name: joined[0] }));
      else if (joined.length > 1) parts.push(t('annPeersJoined', { n: joined.length }));
      if (left.length === 1) parts.push(t('annPeerLeft', { name: left[0] }));
      else if (left.length > 1) parts.push(t('annPeersLeft', { n: left.length }));
      // Ambient, not a user verb: a flapping connection can emit the same
      // join/leave repeatedly, and a polite region QUEUES — re-announcing each
      // one would back the queue up behind churn the user never caused.
      if (parts.length > 0) setAnnounce(parts.join(' — '), { collapseRepeats: true });
    },
  });
  // RTCU-1 — the Live<->Reconnecting chip was a VISUAL-only state change: the chip
  // text swapped and the dot greyed, but nothing reached a screen reader, so a SR
  // user kept editing with no signal that their edits had stopped being shared.
  // Announce TRANSITIONS only: the first observed value is the expected state and
  // announcing it would chatter on every open. Polite + collapseRepeats, matching
  // the peer join/leave treatment above — a flapping socket must not back up the
  // queue with churn the user never caused.
  const collabConnected = collab.enabled ? collab.connected : null;
  const prevConnectedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (collabConnected === null) { prevConnectedRef.current = null; return; }
    const verdict = collabConnectionAnnouncement(prevConnectedRef.current, collabConnected);
    prevConnectedRef.current = collabConnected;
    if (!verdict) return;
    setAnnounce(verdict === 'reconnected' ? t('annCollabReconnected') : t('annCollabDropped'), { collapseRepeats: true });
  }, [collabConnected, setAnnounce, t]);
  /** Peers on an element/frame — the quiet rail markers (D5). */
  const peersOnElement = (col: string, idx: number) => presence.peers.filter((p) => p.sel && p.sel.col === col && p.sel.idx === idx);
  const peersOnFrame = (idx: number) => presence.peers.filter((p) => p.frame === idx);
  /** ADR 0359 residuals — peers' selections for the SCENE overlays (dashed hue
   *  outline + name flag in the interactive previews). Hue = the identity hue
   *  (toolbar avatar / caret) via the one shared source. */
  const peerSelectionsFor = useCallback((col: string) => presence.peers.flatMap((p) => (
    p.sel && p.sel.col === col ? [{ idx: p.sel.idx, name: p.name, color: collabUserColor(p.name) }] : []
  )), [presence.peers]);
  // ADR 0359 D4 — remote/undo transactions remap the positional selection in
  // the SAME React commit as the rebuilt doc (React 18 batches both setState
  // calls): a remote insert above your selection shifts it; a remote delete of
  // a selected element drops it from the set. Tree `selPath` self-sanitizes
  // via the existing unresolvable-path guard.
  collabRemapRef.current = (remap: CollabIndexRemap) => {
    setMultiSel((m) => {
      if (!m) return m;
      const idxs = m.idxs.map((i) => remap(m.col, i)).filter((v): v is number => v !== null);
      return idxs.length > 0 ? { col: m.col, idxs } : null;
    });
    if (framesKey) setFrameIdx((i) => remap(framesKey, i) ?? 0);
  };
  const selEl = useMemo(() => (multiSel && multiSel.idxs.length === 1 ? { col: multiSel.col, idx: multiSel.idxs[0]! } : null), [multiSel]);
  const selCol = useMemo(() => (selEl && elementsDef ? elementsDef.find((c) => c.key === selEl.col) : undefined), [selEl, elementsDef]);
  const selElData = useMemo(() => (selEl && doc ? readElements(doc, selEl.col)[selEl.idx] : undefined), [selEl, doc]);
  /** labelFor/t adapter (TFunction's options arg is non-optional in strict mode). */
  const ttFn = useCallback((k: string, o?: Record<string, unknown>) => tt(k, o ?? {}), [tt]);

  // Select helpers (one source of truth). `selectEl` = single; `setMulti` = a
  // set (empty clears); `toggleEl` = add/remove one (the Shift/Space path).
  const selectEl = useCallback((col: string, idx: number) => setMultiSel({ col, idxs: [idx] }), []);
  const setMulti = useCallback((col: string, idxs: number[]) => setMultiSel(idxs.length ? { col, idxs: [...new Set(idxs)].sort((a, b) => a - b) } : null), []);
  const clearSel = useCallback(() => setMultiSel(null), []);
  const toggleEl = useCallback((col: string, idx: number) => setMultiSel((cur) => {
    if (!cur || cur.col !== col) return { col, idxs: [idx] };
    const has = cur.idxs.includes(idx);
    const idxs = has ? cur.idxs.filter((i) => i !== idx) : [...cur.idxs, idx].sort((a, b) => a - b);
    return idxs.length ? { col, idxs } : null;
  }), []);
  const isSelected = (col: string, idx: number): boolean => !!multiSel && multiSel.col === col && multiSel.idxs.includes(idx);

  // Clamp the element selection after undo/redo or structural changes — drop any
  // index that no longer resolves; drop the whole set if the collection is gone.
  useEffect(() => {
    if (!multiSel || !doc) return;
    if (!elementsDef?.some((c) => c.key === multiSel.col)) { setMultiSel(null); return; }
    const len = readElements(doc, multiSel.col).length;
    const valid = multiSel.idxs.filter((i) => i < len);
    if (valid.length !== multiSel.idxs.length) setMultiSel(valid.length ? { col: multiSel.col, idxs: valid } : null);
  }, [multiSel, doc, elementsDef]);
  // RFC 0130 selection projection (advisory — highlighting only). Memoized by
  // the SELECTION identity, not render identity, so `host.selectionChanged`
  // fires on real selection changes only (code-review M1 — a fresh object per
  // render re-triggered the frame event on every keystroke).
  const frameId = framesDef ? frame?.id : undefined;
  const selectionInfo: CanvasSelectionInfo | null = useMemo(() => (
    selEl
      ? { kind: 'element', collection: selEl.col, index: selEl.idx }
      : selPath
        ? { kind: 'node', path: selPath }
        : frameId !== undefined
          ? { kind: 'frame', frameId }
          : { kind: 'none' }
  ), [selEl, selPath, frameId]);

  // ---- tools (ADR 0333 Phase 2 — minimal seam) -----------------------------
  // The chassis owns the active tool; `select` is implicit and always first.
  // Esc returns to select (or clears the selection when already there). The
  // pointer-session API for create/draw tools ships with the first such tool
  // (Phase 3's pen — the proving-phase rule).
  const [activeTool, setActiveTool] = useState('select');
  // ADR 0333 grade pass DRAW-R3 — Esc cancels a live gesture. The chassis knows
  // a DRAG is mid-flight (a patch 'start' pushed a history entry without an
  // 'end') via `gesturePushed`; `cancelSignal` tells the type to drop ALL its
  // transient overlay state (drag/ink/eraser/draw — the non-drag overlays carry
  // no history side-effect, so cancelling them is purely type-local).
  const gesturePushed = useRef(false);
  const [cancelSignal, setCancelSignal] = useState(0);
  const escAction = useCallback(() => {
    if (shortcutsOpen) { setShortcutsOpen(false); return; }
    setCancelSignal((n) => n + 1); // the type drops any live overlay
    if (gesturePushed.current) {
      // A drag committed a history 'start' — revert the whole gesture.
      gesturePushed.current = false;
      history.undo();
      editGen.current += 1;
      setDirty(true);
      setAnnounce(t('annGestureCancelled'));
      return;
    }
    if (activeTool !== 'select') { setActiveTool('select'); setAnnounce(t('annToolSelect')); return; }
    clearSel();
  }, [shortcutsOpen, activeTool, clearSel, history, t, setAnnounce, setShortcutsOpen]);

  const addElementOf = useCallback((col: ElementsCollectionDef, adder: { id: string; label?: string; make: () => Record<string, unknown> }) => {
    let idx = -1;
    // Style memory (ADR 0333 Phase 2): the last style used for this kind rides
    // over the adder's defaults — tldraw's "style follows you" convention.
    const el = { ...adder.make(), ...(col.styleKeys ? recallStyle(def.canvasTypeId, col.key, adder.id) : {}) };
    editDoc((d) => { idx = addElement(d, col.key, el, col.max); });
    if (idx >= 0) { selectEl(col.key, idx); setAnnounce(t('annAdded', { type: adder.label ?? ttFn(`add_${adder.id}`) })); }
  }, [editDoc, t, ttFn, selectEl, def.canvasTypeId, setAnnounce]);

  const moveElementSel = useCallback((dir: -1 | 1) => {
    if (!selEl) return;
    const sel = selEl;
    let landed = sel.idx;
    editDoc((d) => { landed = moveElement(d, sel.col, sel.idx, sel.idx + dir); });
    selectEl(sel.col, landed);
    setAnnounce(t(dir < 0 ? 'annMoved_up' : 'annMoved_down', { container: '' }));
  }, [selEl, editDoc, t, selectEl, setAnnounce]);

  /** Z-order (ADR 0333 Phase 2): array order = paint order; overlap-aware
   *  stepping via the collection's `bboxFor`. Applies to the whole
   *  multi-selection (relative order preserved), ONE undo step; a no-op
   *  (already at the extreme / nothing overlapping) pushes NO history entry. */
  const reorderSel = useCallback((op: ReorderOp) => {
    if (!multiSel || !doc) return;
    const col = elementsDef?.find((c) => c.key === multiSel.col);
    if (!col) return;
    // DRAW-R1 — reorder rearranges array references only (no element mutated).
    const next = structuralClone(doc, multiSel.col);
    const landed = reorderElements(next, multiSel.col, multiSel.idxs, op, col.bboxFor);
    if (!landed) return;
    history.set(next);
    editGen.current += 1;
    setDirty(true);
    setMulti(multiSel.col, landed);
    setAnnounce(t(`annReordered_${op}`));
  }, [multiSel, doc, elementsDef, history, setMulti, t, setAnnounce]);

  const duplicateElementSel = useCallback(() => {
    if (!selEl || !selCol) return;
    const sel = selEl;
    const max = selCol.max;
    let landed = -1;
    editDoc((d) => { landed = duplicateElement(d, sel.col, sel.idx, max); });
    if (landed >= 0) { selectEl(sel.col, landed); setAnnounce(t('annDuplicated')); }
  }, [selEl, selCol, editDoc, t, selectEl, setAnnounce]);

  const deleteElementSel = useCallback(() => {
    if (!selEl || !selCol || !selElData) return;
    const sel = selEl;
    const min = selCol.min ?? 0;
    const label = selCol.labelFor(selElData, ttFn);
    let removed = false;
    editDoc((d) => { removed = removeElement(d, sel.col, sel.idx, min); });
    if (removed) {
      clearSel();
      setAnnounce(t('annDeleted', { type: label }));
      outlineRef.current?.focus(); // UX F8 — never strand focus on the unmounted form
    }
  }, [selEl, selCol, selElData, editDoc, t, ttFn, clearSel, setAnnounce]);

  const setElField = useCallback((name: string, value: unknown) => {
    if (!selEl) return;
    const sel = selEl;
    editDoc((d) => {
      const list = readElements(d, sel.col);
      const el = list[sel.idx];
      if (!el) return;
      const col = elementsDef?.find((c) => c.key === sel.col);
      // CAD-G4 — a definition may intercept an element prop change with a
      // WHOLE-element transform, mirroring the frames trait's hook (cad: a
      // tolerance change drops the tol fields the new type does not take, so a
      // field the panel stops showing cannot linger and fail the save).
      const transformed = col?.transformOnPropChange?.(el, name, value);
      if (transformed) { list[sel.idx] = transformed; return; }
      setFieldOn(el, name, value);
      // Style memory (ADR 0333 Phase 2): a style-field edit becomes the next
      // add's default for this kind.
      if (col?.styleKeys?.includes(name) && typeof el.kind === 'string') {
        rememberStyle(def.canvasTypeId, sel.col, el.kind, el, col.styleKeys);
      }
    });
  }, [selEl, editDoc, elementsDef, def.canvasTypeId]);

  const setElFieldText = useCallback((name: string, value: unknown) => {
    if (!selEl || !doc) return;
    // DRAW-R1 — per-keystroke text edit touches one element; structural clone.
    const next = structuralClone(doc, selEl.col, [selEl.idx]);
    const el = readElements(next, selEl.col)[selEl.idx];
    if (el) setFieldOn(el, name, value);
    history.replace(next);
    editGen.current += 1;
    setDirty(true);
  }, [selEl, doc, history]);

  const setDocProp = useCallback((name: string, value: unknown) => {
    editDoc((d) => setFieldOn(d, name, value));
  }, [editDoc]);

  // ---- group / ungroup (ADR 0333 Phase 3) ----------------------------------
  // Pure field mutation over the multi-selection: one editDoc step tags every
  // member with a fresh groupId (next free numeric suffix — deterministic from
  // the doc, no clock/random) or clears it. Chrome-gated per collection.
  const chromeCol = multiSel ? elementsDef?.find((c) => c.key === multiSel.col && c.chrome) : undefined;
  const groupSel = useCallback(() => {
    if (!multiSel || multiSel.idxs.length < 2 || !doc) return;
    const sel = multiSel;
    const gid = nextGroupId(readElements(doc, sel.col));
    editDoc((d) => {
      const list = readElements(d, sel.col);
      for (const i of sel.idxs) { const el = list[i]; if (el) el.groupId = gid; }
    });
    setAnnounce(t('annGrouped', { count: sel.idxs.length }));
  }, [multiSel, doc, editDoc, t, setAnnounce]);
  const ungroupSel = useCallback(() => {
    if (!multiSel || !doc) return;
    const sel = multiSel;
    editDoc((d) => {
      const list = readElements(d, sel.col);
      for (const i of sel.idxs) { const el = list[i]; if (el) delete el.groupId; }
    });
    setAnnounce(t('annUngrouped'));
  }, [multiSel, doc, editDoc, t, setAnnounce]);



  // §7.2.1 / CV-13 v1 — the bar's selection-context chip (identity only; the
  // full per-class formatting morph is the recorded ledger residue).
  const selectionSummary = useMemo((): string | null => {
    if (multiSel && multiSel.idxs.length > 1) return t('selChipCount', { count: multiSel.idxs.length });
    if (selEl && doc) {
      const el = readElements(dict(doc), selEl.col)[selEl.idx];
      return typeof el?.kind === 'string' ? el.kind : t('selChipOne');
    }
    if (selNode && catalog) return catalog.components.find((c) => c.type === selNode.type)?.label ?? selNode.type;
    return null;
  }, [multiSel, selEl, selNode, doc, catalog, t]);

  // ADR 0362 / CV-13 — the bar's quick-prop cluster context: a single
  // ELEMENT selection wins, else the ACTIVE FRAME (both FE-owned def lists);
  // writes ride the SAME setters the panel uses (no drift by construction).
  const quickCtx = useMemo((): { defs: CanvasPropDef[]; valueOf: (n: string) => unknown; onSet: (n: string, v: unknown) => void } | null => {
    if (selEl && doc && elementsDef) {
      const col = elementsDef.find((c) => c.key === selEl.col);
      const el = readElements(dict(doc), selEl.col)[selEl.idx];
      if (col && el) {
        const defs = quickDefs(col.propDefs(el));
        if (defs.length) return { defs, valueOf: (n) => el[n], onSet: setElField };
      }
      return null;
    }
    // ADR 0362 Phase 4 — a selected TREE node's quick props come from the
    // SERVED catalog, filtered through the definition's quickPropsByType map
    // (the marker never rides the wire). Writes via the lock-guarded setProp.
    if (selNode && selDef && def.tree?.quickPropsByType) {
      // A LOCKED node's setProp no-ops — hide the cluster rather than render
      // controls that silently do nothing (post-merge review of #1771).
      if (selLocked) return null;
      const names = def.tree.quickPropsByType[selNode.type];
      if (names?.length) {
        // The MAP is the quick marking for served (unmarked) catalog props.
        const defs = quickDefs((selDef.props ?? []).filter((p) => names.includes(p.name)).map((p) => ({ ...p, quick: true })));
        if (defs.length) return { defs, valueOf: (n) => selNode.props?.[n], onSet: setProp };
      }
      // Unmapped node type: NO fallback to frame props — the chip names the
      // node; a cluster editing the FRAME under it would mislead.
      return null;
    }
    // Frame quick props show when NO node is selected. The former !treeActive
    // guard made the slides v1 consumer DEAD ON ARRIVAL (post-merge review of
    // #1771): variant/build live on BLOCKS frames, which are exactly the
    // treeActive ones — the guard could never pass where the marks existed.
    if (frame && framesDef?.propDefs && !selNode) {
      const defs = quickDefs(framesDef.propDefs(frame));
      if (defs.length) return { defs, valueOf: (n) => dict(frame)[n], onSet: setFrameProp };
    }
    return null;
  }, [selEl, doc, elementsDef, setElField, selNode, selDef, selLocked, def.tree, setProp, frame, framesDef, setFrameProp]);

  // ---- the shortcut registry (ADR 0333 Phase 2) ----------------------------
  // Rebuilt after EVERY COMMIT into the dispatch ref (the listener bound once
  // above). Post-commit, not during render: a ref write during render is
  // impure under concurrent React — a keydown landing mid-render could
  // dispatch closures over state the user never saw.
  const hasElementSel = Boolean(multiSel && elementsDef);
  const committedShortcuts = mergeShortcuts([
    { combo: 'mod+z', labelKey: 'undo', group: 'general', run: () => undo() },
    { combo: 'mod+shift+z', labelKey: 'redo', group: 'general', run: () => redo() },
    { combo: 'mod+y', labelKey: 'redo', group: 'general', run: () => redo() },
    { combo: 'escape', labelKey: 'shortcutEsc', group: 'general', run: () => escAction() },
    { combo: '?', labelKey: 'shortcutsTitle', group: 'general', run: () => setShortcutsOpen((v) => !v) },
    // §7.3 / CV-3 — view shortcuts, dispatched to whichever surface published
    // the zoom handle (chassis Renderer wrap, InteractivePreview, or graph).
    { combo: 'shift+1', labelKey: 'zoomToFit', group: 'view', enabled: () => viewportSlot.current != null, run: () => viewportSlot.current?.fit() },
    { combo: 'shift+2', labelKey: 'zoomToSelection', group: 'view', enabled: () => viewportSlot.current?.zoomToSelection != null, run: () => viewportSlot.current?.zoomToSelection?.() },
    { combo: 'shift+0', labelKey: 'zoom100', group: 'view', enabled: () => viewportSlot.current != null, run: () => viewportSlot.current?.zoomToPercent(100) },
    // §7.5 / CV-16 — rail toggles; both collapsed = focus mode.
    { combo: '[', labelKey: 'shortcutToggleLeftRail', group: 'view', run: () => toggleRail('l') },
    { combo: ']', labelKey: 'shortcutToggleRightRail', group: 'view', run: () => toggleRail('r') },
    ...(elementsDef ? [
      { combo: 'mod+d', labelKey: 'shortcutDuplicate', group: 'arrange', enabled: () => Boolean(selEl), run: () => duplicateElementSel() } satisfies ShortcutDef,
      // ADR 0333 grade pass UX-D8 — Delete/Backspace remove the selection (the
      // keyboard twin of the panel Delete; text contexts are already excluded
      // by the keydown owner, so this never eats a rename backspace).
      { combo: 'delete', labelKey: 'shortcutDelete', group: 'arrange', enabled: () => hasElementSel, run: () => { if (multiSel) deleteElements(multiSel.col, multiSel.idxs); } } satisfies ShortcutDef,
      { combo: 'backspace', labelKey: 'shortcutDelete', group: 'arrange', enabled: () => hasElementSel, run: () => { if (multiSel) deleteElements(multiSel.col, multiSel.idxs); } } satisfies ShortcutDef,
      { combo: 'mod+]', labelKey: 'bringForward', group: 'arrange', enabled: () => hasElementSel, run: () => reorderSel('forward') } satisfies ShortcutDef,
      { combo: 'mod+[', labelKey: 'sendBackward', group: 'arrange', enabled: () => hasElementSel, run: () => reorderSel('backward') } satisfies ShortcutDef,
      { combo: 'alt+mod+]', labelKey: 'bringToFront', group: 'arrange', enabled: () => hasElementSel, run: () => reorderSel('front') } satisfies ShortcutDef,
      { combo: 'alt+mod+[', labelKey: 'sendToBack', group: 'arrange', enabled: () => hasElementSel, run: () => reorderSel('back') } satisfies ShortcutDef,
      // ADR 0333 Phase 3 — grouping (chrome-gated collections only).
      { combo: 'mod+g', labelKey: 'groupSelection', group: 'arrange', enabled: () => Boolean(chromeCol && multiSel && multiSel.idxs.length > 1), run: () => groupSel() } satisfies ShortcutDef,
      { combo: 'shift+mod+g', labelKey: 'ungroupSelection', group: 'arrange', enabled: () => Boolean(chromeCol && multiSel), run: () => ungroupSel() } satisfies ShortcutDef,
    ] : []),
    // ADR 0344 2a — tree clipboard keyboard twins (button-only before). The
    // copy/cut combos yield to a real text selection so the OS clipboard still
    // works over selected text; inputs are already excluded by the keydown owner.
    ...(tree ? [
      { combo: 'mod+c', labelKey: 'copyComponent', group: 'arrange', enabled: () => treeActive && Boolean(selNode) && (window.getSelection()?.isCollapsed ?? true), run: () => copySelected() } satisfies ShortcutDef,
      { combo: 'mod+x', labelKey: 'cutComponent', group: 'arrange', enabled: () => treeActive && Boolean(selNode) && (window.getSelection()?.isCollapsed ?? true), run: () => cutSelected() } satisfies ShortcutDef,
      { combo: 'mod+v', labelKey: 'pasteComponent', group: 'arrange', enabled: () => treeActive && getTreeClip(def.canvasTypeId) !== null, run: () => pasteClipboard() } satisfies ShortcutDef,
      { combo: 'alt+mod+c', labelKey: 'copyStyle', group: 'arrange', enabled: () => treeActive && Boolean(selNode), run: () => copyStyleSelected() } satisfies ShortcutDef,
      { combo: 'alt+mod+v', labelKey: 'pasteStyle', group: 'arrange', enabled: () => treeActive && Boolean(selNode) && getStyleClip(def.canvasTypeId) !== null, run: () => pasteStyleSelected() } satisfies ShortcutDef,
    ] : []),
  ], def.shortcuts ?? []);
  // §7.5 / CV-2 — feed the shared keydown owner (post-commit) + the ⌘K
  // projection (ADR 0334 3b-3; 'cv-' ids, 'canvas-editor' source — frozen).
  chrome.commitShortcuts(committedShortcuts);

  // Direct-manipulation gesture sink (ADR 0310 Phase C follow-up): the
  // InteractivePreview reports drag phases; the chassis maps them onto history
  // so a whole move/resize is ONE undo step ('start' pushes the pre-gesture
  // snapshot, 'move' updates live, 'end' just finalizes the dirty flag).
  // ADR 0333 Phase 3: THE locked guard — gesture-seam mutations skip locked
  // elements (the panel + element list stay open: they're how you unlock).
  const isLocked = (el: Record<string, unknown> | undefined): boolean => Boolean(el && el.locked === true);

  const patchElement = useCallback((col: string, idx: number, patch: Record<string, unknown>, phase: 'start' | 'move' | 'end') => {
    if (phase === 'end') { gesturePushed.current = false; setDirty(true); return; }
    if (!doc) return;
    // ADR 0333 grade pass DRAW-R1 — structural clone (share unchanged elements)
    // instead of a whole-doc JSON round-trip on every drag-move frame.
    const next = structuralClone(doc, col, [idx]);
    const el = readElements(next, col)[idx];
    if (!el || isLocked(el)) return;
    for (const [k, v] of Object.entries(patch)) setFieldOn(el, k, v);
    if (phase === 'start') { history.set(next); gesturePushed.current = true; } else history.replace(next);
    editGen.current += 1;
    setDirty(true);
  }, [doc, history]);

  // Batch variant for group gestures (ADR 0317 multi-select) — all patches land
  // on ONE clone so a group move is a single undo step (looping patchElement
  // would clone the committed doc each call, losing all but the last).
  const patchElements = useCallback((col: string, patches: { idx: number; patch: Record<string, unknown> }[], phase: 'start' | 'move' | 'end') => {
    if (phase === 'end') { gesturePushed.current = false; setDirty(true); return; }
    if (!doc || !patches.length) return;
    // DRAW-R1 — structural clone: deep-copy only the patched members (a group
    // drag of N shapes copies N, not the whole doc, every frame).
    const next = structuralClone(doc, col, patches.map((p) => p.idx));
    const list = readElements(next, col);
    let touched = 0;
    for (const { idx, patch } of patches) {
      const el = list[idx];
      if (!el || isLocked(el)) continue; // locked members of a group stay put
      for (const [k, v] of Object.entries(patch)) setFieldOn(el, k, v);
      touched += 1;
    }
    if (!touched) return;
    if (phase === 'start') { history.set(next); gesturePushed.current = true; } else history.replace(next);
    editGen.current += 1;
    setDirty(true);
  }, [doc, history]);

  const deleteElements = useCallback((col: string, idxs: number[]): number => {
    if (!doc || !idxs.length) return 0;
    const min = elementsDef?.find((c) => c.key === col)?.min ?? 0;
    // DRAW-R1 — delete only splices the array (no element mutated) → share all.
    const next = structuralClone(doc, col);
    const list = readElements(next, col);
    // Descending so earlier removals don't shift later indices; stop at `min`.
    const sorted = [...new Set(idxs)].filter((i) => i >= 0 && i < list.length && !isLocked(list[i])).sort((a, b) => b - a);
    let removed = 0;
    for (const i of sorted) {
      if (list.length <= min) break; // `list` shrinks live as we splice
      list.splice(i, 1);
      removed += 1;
    }
    if (removed > 0) {
      history.set(next);
      editGen.current += 1;
      setDirty(true);
      // Phase 8: gesture deletions (the eraser) announce like every mutation.
      setAnnounce(t('annElementsDeleted', { count: removed }));
    }
    return removed;
  }, [doc, history, elementsDef, t, setAnnounce]);

  // §7.4 / CV-7 — the near-selection pill verbs (surface anchors, chassis
  // owns history). Gates mirror the arrange shortcuts exactly.
  const elementActions = useMemo<ElementActions | null>(() => {
    if (!multiSel || !elementsDef || multiSel.idxs.length === 0 || !doc) return null;
    const sel = multiSel;
    const els = readElements(dict(doc), sel.col);
    const allLocked = sel.idxs.every((i) => els[i]?.locked === true);
    return {
      duplicate: selEl ? () => duplicateElementSel() : undefined,
      remove: () => { deleteElements(sel.col, sel.idxs); },
      toggleLock: () => {
        editDoc((d) => {
          const list = readElements(d, sel.col);
          for (const i of sel.idxs) { const el = list[i]; if (el) setFieldOn(el, 'locked', allLocked ? undefined : true); }
        });
        setAnnounce(t(allLocked ? 'annNodeUnlocked' : 'annNodeLocked'));
      },
      locked: allLocked,
      group: chromeCol && sel.idxs.length > 1 ? () => groupSel() : undefined,
      ungroup: chromeCol ? () => ungroupSel() : undefined,
    };
  }, [multiSel, elementsDef, doc, selEl, chromeCol, duplicateElementSel, deleteElements, editDoc, groupSel, ungroupSel, t, setAnnounce]);

  // ADR 0333 Phase 3 — the pen's commit seam (the Phase-2 "pointer-session
  // API" resolved to this): freshly-drawn elements land in ONE history step;
  // the live stroke was type-local overlay state. Respects `max`; selects the
  // committed elements.
  const addElementsSeam = useCallback((col: string, els: Record<string, unknown>[]): number[] => {
    if (!doc || !els.length) return [];
    const colDef = elementsDef?.find((c) => c.key === col);
    if (!colDef) return [];
    // ADR 0333 grade pass CODE-D11/UX-D2 — ATOMIC at the cap: a batch that
    // won't fully fit commits NOTHING (a partial symmetry batch would land a
    // lopsided result the symmetry feature exists to prevent; a split stroke
    // must not half-commit) and announces the cap instead of silently dropping.
    if (readElements(doc, col).length + els.length > colDef.max) {
      setAnnounce(t('annCapReached', { max: colDef.max }));
      toast.info(t('annCapReached', { max: colDef.max }));
      return [];
    }
    // DRAW-R1 — add only pushes to the array; the NEW elements are fresh
    // objects the caller passed, so no deep-copy of existing elements needed.
    const next = structuralClone(doc, col);
    const landed: number[] = [];
    for (const el of els) {
      const idx = addElement(next, col, el, colDef.max);
      if (idx < 0) break;
      landed.push(idx);
    }
    if (!landed.length) return [];
    history.set(next);
    editGen.current += 1;
    setDirty(true);
    setMulti(col, landed);
    // Phase-4 /ux-review: drawn commits announce like every other mutation.
    setAnnounce(t('annElementsAdded', { count: landed.length }));
    return landed;
  }, [doc, elementsDef, history, setMulti, t, setAnnounce]);

  // ---- align / distribute (ADR 0333 Phase 5) --------------------------------
  // Geometry stays TYPE-owned: the collection supplies bboxFor + movePatchFor;
  // the chassis composes them into ONE patchElements batch (one undo step).
  const alignCol = multiSel ? elementsDef?.find((c) => c.key === multiSel.col && c.movePatchFor && c.bboxFor) : undefined;
  const alignSel = useCallback((op: AlignOp) => {
    if (!multiSel || !doc) return;
    const col = elementsDef?.find((c) => c.key === multiSel.col);
    if (!col?.movePatchFor || !col.bboxFor) return;
    const list = readElements(doc, multiSel.col);
    const items: AlignItem[] = [];
    for (const idx of multiSel.idxs) {
      const el = list[idx];
      if (!el) continue;
      const box = col.bboxFor(el);
      if (box) items.push({ idx, box, el });
    }
    const patches = computeAlignPatches(items, op, col.movePatchFor);
    if (!patches.length) return;
    patchElements(multiSel.col, patches, 'start');
    patchElements(multiSel.col, [], 'end');
    // ADR 0333 grade pass UX-D15 — announce the SPECIFIC op, not a generic
    // "Arranged" for all eight actions.
    setAnnounce(t('annAlignedOp', { op: t(`align_${op}`) }));
  }, [multiSel, doc, elementsDef, patchElements, t, setAnnounce]);


  // ---- graph trait (ADR 0323) ---------------------------------------------
  const graphDef = def.graph;
  // ADR 0337 — a graph-first type (app-builder) opens in the screen-flow board;
  // everything else opens in the tree/frame editor (the historical default).
  const [graphView, setGraphView] = useState(graphDef?.defaultView === 'graph');
  // ADR 0345 3d — the active type-contributed workspace tab (null = design).
  const [workspaceTab, setWorkspaceTab] = useState<string | null>(null);
  const activeWorkspaceTab = workspaceTab ? def.workspaceTabs?.find((w) => w.id === workspaceTab) ?? null : null;
  const [graphSel, setGraphSel] = useState<{ node: string | null; edge: string | null }>({ node: null, edge: null });

  /** Move a graph node — one undo step per gesture (start=push, move/end=replace),
   *  mirroring patchElement. */
  const moveGraphNode = useCallback((id: string, x: number, y: number, phase: 'start' | 'move' | 'end') => {
    if (!doc || !graphDef) return;
    const next = clone(doc);
    graphDef.moveNode(next, id, x, y);
    if (phase === 'start') history.set(next); else history.replace(next);
    editGen.current += 1;
    setDirty(true);
  }, [doc, graphDef, history]);

  const connectGraph = useCallback((from: string, to: string) => {
    if (!doc || !graphDef) return;
    const next = clone(doc);
    if (graphDef.connect?.(next, from, to)) { history.set(next); editGen.current += 1; setDirty(true); }
  }, [doc, graphDef, history]);

  const deleteGraphEdge = useCallback((id: string) => {
    if (!doc || !graphDef) return;
    const next = clone(doc);
    if (!graphDef.deleteEdge) return;
    graphDef.deleteEdge(next, id);
    history.set(next); editGen.current += 1; setDirty(true);
    setGraphSel((s) => (s.edge === id ? { ...s, edge: null } : s));
  }, [doc, graphDef, history]);

  // Audit gap #1 — the selected edge (resolved fresh from the doc so the panel
  // always shows committed values) + its field writes. Discrete changes are one
  // undo step; text (label) rides history.replace like every other text field.
  const selEdge = useMemo(
    () => (graphDef && doc && graphSel.edge !== null ? graphDef.edges(doc).find((e) => e.id === graphSel.edge) ?? null : null),
    [graphDef, doc, graphSel.edge],
  );
  const updateGraphEdge = useCallback((id: string, patch: Record<string, unknown>) => {
    if (!graphDef?.updateEdge) return;
    editDoc((d) => graphDef.updateEdge!(d, id, patch));
  }, [graphDef, editDoc]);
  const updateGraphEdgeText = useCallback((id: string, patch: Record<string, unknown>) => {
    if (!doc || !graphDef?.updateEdge) return;
    const next = clone(doc);
    graphDef.updateEdge(next, id, patch);
    history.replace(next);
    editGen.current += 1;
    setDirty(true);
  }, [doc, graphDef, history]);

  // Audit gap #2 — spawn a node pre-connected from `fromId` (the trait owns
  // id/name semantics via its frames factory); select + announce the new node.
  const addConnectedGraphNode = useCallback((fromId: string, pos?: { x: number; y: number }) => {
    if (!doc || !graphDef?.addConnectedNode) return;
    const name = tt('frameDefaultName', { n: graphDef.nodes(doc).length + 1 });
    const next = clone(doc);
    const newId = graphDef.addConnectedNode(next, fromId, name, pos);
    if (!newId) return;
    history.set(next); editGen.current += 1; setDirty(true);
    setGraphSel({ node: newId, edge: null });
    setAnnounce(tt('annFrameAdded', { name }));
  }, [doc, graphDef, tt, history, setAnnounce]);

  // Clamp the graph selection when the doc changes (undo/redo/connect/delete).
  // Grade data-F4/code-F3b: the edge clamp checks IDENTITY, not range — a
  // cascade delete or redo can shift a positional connectors array so an
  // in-range index denotes a DIFFERENT connector; the selection survives only
  // while an edge with the same id AND the same endpoints exists. Ids stay
  // opaque strings (no Number()) so a future trait with `"e1"`-style ids works.
  const selEdgeSnap = useRef<{ id: string; from: string; to: string } | null>(null);
  useEffect(() => {
    if (!graphDef || !doc) return;
    setGraphSel((s) => {
      const nodeOk = s.node ? graphDef.nodes(doc).some((n) => n.id === s.node) : true;
      let edgeOk = true;
      if (s.edge !== null) {
        const hit = graphDef.edges(doc).find((e) => e.id === s.edge) ?? null;
        const prev = selEdgeSnap.current;
        edgeOk = Boolean(hit) && !(prev && prev.id === s.edge && hit && (prev.from !== hit.from || prev.to !== hit.to));
        selEdgeSnap.current = edgeOk && hit ? { id: hit.id, from: hit.from, to: hit.to } : null;
      } else {
        selEdgeSnap.current = null;
      }
      if (nodeOk && edgeOk) return s;
      return { node: nodeOk ? s.node : null, edge: edgeOk ? s.edge : null };
    });
  }, [doc, graphDef]);

  /** Activate a node: if its id maps to a frame, open that frame's editing and
   *  leave the graph view (app-builder: a screen node → its component editor). */
  const activateGraphNode = useCallback((id: string) => {
    if (frameOps && doc) {
      const idx = frameOps.frames(doc).findIndex((f) => (f as { id?: unknown }).id === id);
      if (idx >= 0) { setFrameIdx(idx); setGraphView(false); }
    }
    graphDef?.onActivateNode?.(id);
  }, [frameOps, doc, graphDef]);

  const setDocPropText = useCallback((name: string, value: unknown) => {
    if (!doc) return;
    const next = clone(doc);
    setFieldOn(next, name, value);
    history.replace(next);
    editGen.current += 1;
    setDirty(true);
  }, [doc, history]);

  const deleteSelected = useCallback(() => {
    if (!treeOps || !selPath || selPath.length === 0 || selLocked) return;
    const type = selNode?.type ?? '';
    editFrame((f) => treeOps.deleteAt(f, selPath));
    setSelPath(null);
    setAnnounce(t('annDeleted', { type }));
    outlineRef.current?.focus(); // UX F8 — never strand focus on the unmounted form
  }, [editFrame, treeOps, selPath, selNode, selLocked, t, setAnnounce]);

  /** Sibling count of the list containing `path`, on the active frame. */
  const siblingCount = useCallback((path: number[]): number => {
    if (!treeOps || !frame) return 0;
    const parent = path.slice(0, -1);
    if (parent.length === 0) return rootChildren(frame).length;
    const p = treeOps.nodeAt(frame, parent);
    return (p ? childrenOf(p) ?? [] : []).length;
  }, [frame, treeOps, rootChildren, childrenOf]);

  /** The container sibling ADJACENT to the selection (above first, else below)
   *  that accepts children — the keyboard target for "Move into container"
   *  (grade pass UX F1: dragging could nest, the keyboard could not). */
  const adjacentContainer = useMemo(() => {
    if (!treeOps || !frame || !selPath || selPath.length === 0 || !catalog) return null;
    const i = selPath[selPath.length - 1]!;
    const parent = selPath.slice(0, -1);
    for (const j of [i - 1, i + 1]) {
      if (j < 0) continue;
      const p = [...parent, j];
      const node = treeOps.nodeAt(frame, p);
      if (!node) continue;
      const cdef = catalog.components.find((c) => c.type === node.type);
      if (cdef?.acceptsChildren) return { path: p, label: cdef.label };
    }
    return null;
  }, [frame, selPath, catalog, treeOps]);

  const moveSelected = useCallback((kind: 'up' | 'down' | 'out' | 'in') => {
    if (!treeOps || !selPath || selPath.length === 0 || selLocked) return;
    const i = selPath[selPath.length - 1]!;
    const parent = selPath.slice(0, -1);
    let to: { parent: number[] | null; index: number } | null = null;
    if (kind === 'up' && i > 0) to = { parent: parent.length ? parent : null, index: i - 1 };
    else if (kind === 'down' && i < siblingCount(selPath) - 1) to = { parent: parent.length ? parent : null, index: i + 2 };
    else if (kind === 'out' && parent.length > 0) {
      const gp = parent.slice(0, -1);
      to = { parent: gp.length ? gp : null, index: parent[parent.length - 1]! + 1 };
    } else if (kind === 'in' && adjacentContainer && frame) {
      const target = treeOps.nodeAt(frame, adjacentContainer.path);
      to = { parent: adjacentContainer.path, index: (target ? childrenOf(target) ?? [] : []).length };
    }
    if (!to) return;
    // ADR 0344 2c — 'in'/'out' change the parent; the new parent must adopt.
    if ((kind === 'in' || kind === 'out') && selNode && !adoptOrAnnounce(to.parent, selNode.type)) return;
    const dest = to;
    const out: { landed: number[] | null } = { landed: null };
    editFrame((f) => { out.landed = treeOps.moveNode(f, selPath, dest.parent, dest.index); });
    if (out.landed) {
      setSelPath(out.landed);
      setAnnounce(t(`annMoved_${kind}`, { container: adjacentContainer?.label ?? '' }));
    }
  }, [editFrame, treeOps, childrenOf, selPath, selNode, selLocked, siblingCount, adjacentContainer, frame, adoptOrAnnounce, t, setAnnounce]);

  const duplicateSelected = useCallback(() => {
    if (!treeOps || !selPath || selPath.length === 0) return;
    const out: { landed: number[] | null } = { landed: null };
    editFrame((f) => { out.landed = treeOps.duplicateAt(f, selPath); });
    if (out.landed) { setSelPath(out.landed); setAnnounce(t('annDuplicated')); }
  }, [editFrame, treeOps, selPath, t, setAnnounce]);

  // Audit gap #3 → ADR 0344 2a — the tree clipboard, now module-scoped (a
  // subtree copied in one canvas pastes into another canvas of the SAME type;
  // the store's canvasTypeId key is the closed-world guard) with cut, keyboard
  // bindings, and a catalog-vocabulary style clipboard beside it. Deep-cloned
  // on write AND read, so pastes are independent and later doc edits can never
  // mutate the held copy. Caps stay server-enforced on save (validateAppDoc),
  // same as drag-and-drop.
  const [, bumpClip] = useReducer((n: number) => n + 1, 0);
  const treeClipboard = getTreeClip<N>(def.canvasTypeId);
  const styleClipboard = getStyleClip(def.canvasTypeId);
  const copySelected = useCallback(() => {
    if (!selNode) return;
    setTreeClip(def.canvasTypeId, selNode);
    bumpClip();
    setAnnounce(t('annCopied', { type: selNode.type }));
  }, [selNode, def.canvasTypeId, t, setAnnounce]);
  const cutSelected = useCallback(() => {
    if (!treeOps || !selPath || selPath.length === 0 || !selNode || selLocked) return;
    setTreeClip(def.canvasTypeId, selNode);
    bumpClip();
    editFrame((f) => treeOps.deleteAt(f, selPath)); // one undo step; undo restores the node, the clip stays
    setSelPath(null);
    setAnnounce(t('annCut', { type: selNode.type }));
    outlineRef.current?.focus(); // UX F8 — never strand focus on the unmounted form
  }, [treeOps, selPath, selNode, selLocked, def.canvasTypeId, editFrame, t, setAnnounce]);
  const pasteClipboard = useCallback(() => {
    if (!treeOps || !treeClipboard || !frame) return;
    // Same placement rule as palette-add: into the selected container when it
    // accepts children (2b: not locked; 2c: adopts this type), else at the root.
    const selCount = selNode ? (childrenOf(selNode) ?? []).length : 0;
    const parent = selPath && selDef?.acceptsChildren && !selLocked && canAdopt(selDef, treeClipboard.type, selCount) ? selPath : null;
    const target = parent ? treeOps.nodeAt(frame, parent) : null;
    const landedIndex = parent ? (target ? (childrenOf(target) ?? []).length : 0) : rootChildren(frame).length;
    editFrame((f) => treeOps.addChild(f, parent, clone(treeClipboard)));
    setSelPath([...(parent ?? []), landedIndex]);
    setAnnounce(t('annPasted', { type: treeClipboard.type }));
  }, [treeOps, treeClipboard, frame, selPath, selNode, selDef, selLocked, childrenOf, rootChildren, editFrame, t, setAnnounce]);

  // ADR 0344 2a — style clipboard over the CATALOG style vocabulary: enum/color
  // props are style (token scales); everything else is content and never rides.
  const selStyleProps = useMemo(() => {
    if (!selNode || !selDef) return null;
    const out: Record<string, unknown> = {};
    for (const p of selDef.props ?? []) {
      if (p.type !== 'enum' && p.type !== 'color') continue;
      const v = selNode.props?.[p.name];
      if (v !== undefined) out[p.name] = v;
    }
    return out;
  }, [selNode, selDef]);
  const copyStyleSelected = useCallback(() => {
    if (!selNode || !selStyleProps || Object.keys(selStyleProps).length === 0) return;
    setStyleClip(def.canvasTypeId, { sourceType: selNode.type, props: selStyleProps });
    bumpClip();
    setAnnounce(t('annStyleCopied', { type: selNode.type, n: Object.keys(selStyleProps).length }));
  }, [selNode, selStyleProps, def.canvasTypeId, t, setAnnounce]);
  const pasteStyleSelected = useCallback(() => {
    if (!styleClipboard || !treeOps || !selPath || selPath.length === 0 || !selDef) return;
    // Apply only what the TARGET's catalog def declares with the same style
    // type — and for enums, only values inside the target's option set.
    const applicable = (selDef.props ?? []).filter((p) =>
      (p.type === 'enum' || p.type === 'color')
      && styleClipboard.props[p.name] !== undefined
      && (p.type !== 'enum' || (p.options ?? []).includes(String(styleClipboard.props[p.name]))));
    if (applicable.length === 0) { setAnnounce(t('annStyleNone')); return; }
    editFrame((f) => { for (const p of applicable) treeOps.setPropAt(f, selPath, p.name, styleClipboard.props[p.name]); });
    setAnnounce(t('annStylePasted', { n: applicable.length }));
  }, [styleClipboard, treeOps, selPath, selDef, editFrame, t, setAnnounce]);

  // Audit gap #5 — the template preview gallery: render each catalog template
  // through the SHARED Renderer on a synthesized single-frame doc (coerceDoc({})
  // + addFrameFromTemplate — chassis-generic, no type seam), then add via the
  // same path as the one-click list.
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // ADR 0347 5a — pack-kit instantiation: the chassis owns the gallery entry,
  // the variable form, `{{var}}` substitution, and the ONE history commit; the
  // TYPE (def.insertKit) owns id remapping + its relations vocabulary.
  const [kitOpen, setKitOpen] = useState<CanvasKitDto | null>(null);
  const [kitValues, setKitValues] = useState<Record<string, string>>({});
  const openKit = useCallback((kit: CanvasKitDto) => {
    setKitValues(Object.fromEntries((kit.variables ?? []).map((v) => [v.name, v.default ?? ''])));
    setKitOpen(kit);
  }, []);
  const insertKitNow = useCallback(() => {
    if (!kitOpen || !def.insertKit || !doc) return;
    // Substitute {{var}} inside the kit JSON — values are JSON-escaped so a
    // quote in a value can never break out of its string position.
    const substituted = JSON.parse(JSON.stringify({ screens: kitOpen.screens, connectors: kitOpen.connectors ?? [] })
      .replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
        const v = kitValues[name];
        return v === undefined ? '' : JSON.stringify(v).slice(1, -1);
      })) as { screens: Record<string, unknown>[]; connectors?: Record<string, unknown>[] };
    // Probe on a CLONE first (grade pass AB-CODE-F4): a type may reject the
    // insert (frame cap) — a rejection must not commit a no-op history step.
    if (def.insertKit(clone(doc), substituted) === false) {
      setKitOpen(null);
      setAnnounce(t('annKitRejected', { kit: kitOpen.label }));
      return;
    }
    editDoc((d) => def.insertKit!(d, substituted));
    setKitOpen(null);
    setAnnounce(t('annKitInserted', { kit: kitOpen.label }));
  }, [kitOpen, kitValues, def, doc, editDoc, t, setAnnounce]);
  const templateContent = useCallback((tpl: FrameTemplateDto): string => {
    const d = coerceDoc({});
    if (frameOps) {
      const content = tpl.content ?? (rootKey ? { [rootKey]: tpl.components ?? [] } : {});
      frameOps.addFrameFromTemplate(d, { name: tpl.name, content });
    }
    return JSON.stringify(d);
  }, [coerceDoc, frameOps, rootKey]);
  const useTemplate = useCallback((tpl: FrameTemplateDto) => {
    if (!frameOps) return;
    const content = tpl.content ?? (rootKey ? { [rootKey]: tpl.components ?? [] } : {});
    let idx = -1;
    editDoc((d) => { idx = frameOps.addFrameFromTemplate(d, { name: tpl.name, content }); });
    if (idx >= 0) { setFrameIdx(idx); setSelPath(null); }
    setTemplatesOpen(false);
  }, [frameOps, rootKey, editDoc]);

  // ---- preview: delegated select + drag-and-drop ---------------------------

  const setHighlight = useCallback((el: HTMLElement | null) => {
    if (highlightRef.current === el) return;
    highlightRef.current?.classList.remove('cv-drop-target');
    highlightRef.current = el;
    el?.classList.add('cv-drop-target');
  }, []);

  const pathFromEvent = useCallback((e: { target: EventTarget | null }): number[] | null => {
    const el = (e.target as HTMLElement | null)?.closest?.(`[${PATH_ATTR}]`);
    if (!el) return null;
    return parsePath(el.getAttribute(PATH_ATTR) ?? '');
  }, []);

  const onPreviewClick = useCallback((e: React.MouseEvent) => {
    const p = pathFromEvent(e);
    setSelPath(p);
  }, [pathFromEvent]);

  const onPreviewDragStart = useCallback((e: React.DragEvent) => {
    const p = pathFromEvent(e);
    if (!p) return;
    e.dataTransfer.setData(MIME_MOVE, p.join('.'));
    e.dataTransfer.effectAllowed = 'move';
  }, [pathFromEvent]);

  const onPreviewDragOver = useCallback((e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types);
    if (!types.includes(MIME_ADD) && !types.includes(MIME_MOVE)) return;
    e.preventDefault();
    const el = (e.target as HTMLElement | null)?.closest?.(`[${PATH_ATTR}]`) as HTMLElement | null;
    setHighlight(el ?? (e.currentTarget as HTMLElement));
  }, [setHighlight]);

  const onPreviewDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the preview surface entirely (dragleave bubbles).
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setHighlight(null);
  }, [setHighlight]);

  /** Resolve a drop target path → {parent,list-index} per the ADR drop semantics:
   *  container → append inside; leaf → insert after it; empty surface → frame root. */
  const dropSlot = useCallback((targetPath: number[] | null, childType?: string): { parent: number[] | null; index: number } => {
    if (!treeOps || !frame || !targetPath || targetPath.length === 0) {
      return { parent: null, index: frame ? rootChildren(frame).length : 0 };
    }
    const node = treeOps.nodeAt(frame, targetPath);
    const cdef = node && catalog ? catalog.components.find((c) => c.type === node.type) : null;
    // ADR 0344 2c — a container that can't adopt THIS child falls through to
    // the sibling slot instead of swallowing the drop.
    const adopts = node && cdef?.acceptsChildren && (childType === undefined || canAdopt(cdef, childType, (childrenOf(node) ?? []).length));
    if (adopts) return { parent: targetPath, index: (childrenOf(node!) ?? []).length };
    const parent = targetPath.slice(0, -1);
    return { parent: parent.length ? parent : null, index: targetPath[targetPath.length - 1]! + 1 };
  }, [frame, treeOps, rootChildren, childrenOf, catalog]);

  const applyDrop = useCallback((dt: DataTransfer, targetPath: number[] | null) => {
    if (!treeOps || !treeActive || !frame) return; // ADR 0328 P3 — no tree writes on a gated frame
    const addType = dt.getData(MIME_ADD);
    const movePath = dt.getData(MIME_MOVE);
    if (addType && catalog) {
      const cdef = catalog.components.find((c) => c.type === addType);
      if (!cdef) return;
      const slot = dropSlot(targetPath, addType);
      if (!adoptOrAnnounce(slot.parent, addType)) return; // ADR 0344 2c
      const node = makeNode(cdef);
      editFrame((f) => treeOps.insertAt(f, slot.parent, slot.index, node));
      setSelPath([...(slot.parent ?? []), slot.index]);
    } else if (movePath) {
      const from = parsePath(movePath);
      if (isLockedAt(from)) return; // ADR 0344 2b — locked nodes don't move
      const movedType = treeOps.nodeAt(frame, from)?.type ?? '';
      const slot = dropSlot(targetPath, movedType);
      const sameParent = JSON.stringify(from.slice(0, -1)) === JSON.stringify(slot.parent ?? []);
      if (!adoptOrAnnounce(slot.parent, movedType, { sameParent })) return; // ADR 0344 2c
      const out: { landed: number[] | null } = { landed: null };
      editFrame((f) => { out.landed = treeOps.moveNode(f, from, slot.parent, slot.index); });
      if (out.landed) setSelPath(out.landed);
    }
  }, [dropSlot, catalog, editFrame, treeOps, makeNode, treeActive, isLockedAt, frame, adoptOrAnnounce]);

  const onPreviewDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setHighlight(null);
    applyDrop(e.dataTransfer, pathFromEvent(e));
  }, [applyDrop, pathFromEvent, setHighlight]);

  const onPreviewDragEnd = useCallback(() => setHighlight(null), [setHighlight]);

  /** Outline drop: insert BEFORE the row (its own slot), supporting add + move. */
  const onOutlineDrop = useCallback((dt: DataTransfer, rowPath: number[]) => {
    if (!treeOps || !treeActive) return;
    setOutlineDrop(null);
    const parent = rowPath.slice(0, -1);
    const slotParent = parent.length ? parent : null;
    const index = rowPath[rowPath.length - 1]!;
    const addType = dt.getData(MIME_ADD);
    const movePath = dt.getData(MIME_MOVE);
    if (addType && catalog) {
      const cdef = catalog.components.find((c) => c.type === addType);
      if (!cdef) return;
      if (!adoptOrAnnounce(slotParent, addType)) return; // ADR 0344 2c
      const node = makeNode(cdef);
      editFrame((f) => treeOps.insertAt(f, slotParent, index, node));
      setSelPath([...(slotParent ?? []), index]);
    } else if (movePath) {
      const from = parsePath(movePath);
      if (isLockedAt(from)) return; // ADR 0344 2b — locked nodes don't move
      const movedType = (frame ? treeOps.nodeAt(frame, from)?.type : '') ?? '';
      const sameParent = JSON.stringify(from.slice(0, -1)) === JSON.stringify(slotParent ?? []);
      if (!adoptOrAnnounce(slotParent, movedType, { sameParent })) return; // ADR 0344 2c
      const out: { landed: number[] | null } = { landed: null };
      editFrame((f) => { out.landed = treeOps.moveNode(f, from, slotParent, index); });
      if (out.landed) setSelPath(out.landed);
    }
  }, [catalog, editFrame, treeOps, makeNode, treeActive, isLockedAt, frame, adoptOrAnnounce]);

  // ADR 0458 a11y — KEYBOARD sibling reorder (Alt+ArrowUp/Down from OutlineTree).
  // Reuses the EXACT drop path (no parallel move logic): the `isLockedAt` guard, the
  // `adoptOrAnnounce` gate, and `treeOps.moveNode` (the single move owner). Sibling-
  // scoped by design — cross-parent reparent stays drag-only (ADR 0458 residue note).
  const onOutlineReorder = useCallback((from: number[], dir: 'up' | 'down') => {
    if (!treeOps || !treeActive || !frame) return;
    if (isLockedAt(from)) return; // ADR 0344 2b — locked nodes don't move
    const k = from.length - 1;
    const idx = from[k]!;
    const parentPath = from.slice(0, -1);
    const slotParent = parentPath.length ? parentPath : null;
    // Sibling list at this level (root list, or the parent node's children).
    const parentNode = parentPath.length ? treeOps.nodeAt(frame, parentPath) : null;
    const siblings = parentPath.length ? (parentNode ? childrenOf(parentNode) ?? [] : []) : rootChildren(frame);
    if (dir === 'up' ? idx <= 0 : idx >= siblings.length - 1) return; // sibling bounds
    const movedType = treeOps.nodeAt(frame, from)?.type ?? '';
    if (!adoptOrAnnounce(slotParent, movedType, { sameParent: true })) return; // ADR 0344 2c
    // `moveNode` uses insert-before + a same-parent decrement (treeOps.ts:146), so a
    // one-step sibling move is: up → idx-1, down → idx+2 (pinned by the reorder test).
    const toIndex = dir === 'up' ? idx - 1 : idx + 2;
    const out: { landed: number[] | null } = { landed: null };
    editFrame((f) => { out.landed = treeOps.moveNode(f, from, slotParent, toIndex); });
    if (out.landed) { setSelPath(out.landed); setReorderTick((n) => n + 1); }
  }, [treeOps, treeActive, frame, isLockedAt, childrenOf, rootChildren, adoptOrAnnounce, editFrame]);

  // Focus follows the keyboard-moved row (ARIA APG). Scoped to the outline container
  // (never a document-wide query); nonce-gated so it fires only on reorder.
  useEffect(() => {
    if (reorderTick === 0) return;
    outlineRef.current?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')?.focus();
  }, [reorderTick]);

  // ---- frames --------------------------------------------------------------

  const onAddFrame = useCallback(() => {
    if (!framesDef || !frameOps || !doc || frames.length >= framesDef.max) return;
    const name = tt('frameDefaultName', { n: frames.length + 1 });
    let idx = -1;
    editDoc((d) => { idx = frameOps.addFrame(d, name); });
    if (idx >= 0) { setFrameIdx(idx); setSelPath(null); setAnnounce(tt('annFrameAdded')); }
  }, [doc, frames.length, framesDef, editDoc, frameOps, tt, setAnnounce]);

  const commitRename = useCallback(() => {
    if (renamingIdx === null || !frameOps) return;
    const name = renameVal.trim();
    if (name) editDoc((d) => frameOps.renameFrame(d, renamingIdx, name));
    setRenamingIdx(null);
  }, [renamingIdx, renameVal, editDoc, frameOps]);

  const onFrameMenu = useCallback((i: number): MenuEntry[] => {
    if (!doc || !framesDef || !frameOps) return [];
    const s = frames[i];
    return [
      { id: 'rename', label: tt('renameFrame'), onSelect: () => { setRenameVal(s?.name ?? ''); setRenamingIdx(i); } },
      { id: 'duplicate', label: tt('duplicateFrame'), disabled: frames.length >= framesDef.max, onSelect: () => {
        let idx = -1;
        editDoc((d) => { idx = frameOps.duplicateFrame(d, i); });
        if (idx >= 0) { setFrameIdx(idx); setSelPath(null); }
      } },
      ...(homeFlag ? [{ id: 'home', label: tt('setHome'), disabled: Boolean(s && isHome(s)), onSelect: () => editDoc((d) => frameOps.setHomeFrame(d, i)) } satisfies MenuEntry] : []),
      { id: 'sep1', separator: true },
      { id: 'left', label: t('moveLeft'), disabled: i === 0, onSelect: () => { editDoc((d) => frameOps.reorderFrame(d, i, i - 1)); setFrameIdx(i - 1); } },
      { id: 'right', label: t('moveRight'), disabled: i >= frames.length - 1, onSelect: () => { editDoc((d) => frameOps.reorderFrame(d, i, i + 1)); setFrameIdx(i + 1); } },
      { id: 'sep15', separator: true },
      // ADR 0328 P7 — the frames CLIPBOARD: copy a frame here, paste it into
      // ANY deck of the same canvas type (cross-tab via localStorage). The
      // paste re-enters through addFrameFromTemplate → the same coercion +
      // validation every frame write gets; identity fields are re-minted.
      { id: 'copyFrame', label: t('copyFrame'), onSelect: () => {
        const src = frames[i];
        if (!src) return;
        const { id: _id, name, ...content } = dict(src);
        try {
          localStorage.setItem(`owp-frames-clip:${def.canvasTypeId}`, JSON.stringify({ name: String(name ?? ''), content }));
          setAnnounce(t('annFrameCopied', { name: String(name ?? '') }));
        } catch { /* storage full/blocked — the announce simply doesn't fire */ }
      } },
      { id: 'pasteFrame', label: t('pasteFrame'), disabled: frames.length >= framesDef.max || !hasFrameClipboard(def.canvasTypeId), onSelect: () => {
        const clip = readFrameClipboard(def.canvasTypeId);
        if (!clip) return;
        let idx = -1;
        editDoc((d) => { idx = frameOps.addFrameFromTemplate(d, { name: clip.name || tt('frameDefaultName', { n: frames.length + 1 }), content: clip.content }); });
        if (idx >= 0) { setFrameIdx(idx); setSelPath(null); setAnnounce(t('annFramePasted')); }
      } },
      { id: 'sep2', separator: true },
      { id: 'delete', label: tt('deleteFrame'), disabled: frames.length <= 1, onSelect: () => {
        void (async () => {
          if (!(await confirm({ title: tt('deleteFrameTitle', { name: s?.name ?? '' }), body: tt('deleteFrameBody'), confirmLabel: tt('deleteFrame'), danger: true }))) return;
          editDoc((d) => { frameOps.deleteFrame(d, i); });
          setFrameIdx((cur) => Math.max(0, cur >= i ? cur - 1 : cur));
          setSelPath(null);
          setAnnounce(tt('annFrameDeleted', { name: s?.name ?? '' }));
          framesNavRef.current?.focus(); // UX-CV-3 — never strand focus on the unmounted menu
        })();
      } },
    ];
  }, [doc, frames, framesDef, homeFlag, isHome, editDoc, frameOps, t, tt, def.canvasTypeId, setAnnounce]);

  const onFrameTabDrop = useCallback((e: React.DragEvent, toIdx: number) => {
    if (!frameOps) return;
    const raw = e.dataTransfer.getData(MIME_FRAME);
    if (raw === '') return;
    e.preventDefault();
    const fromIdx = Number(raw);
    if (!doc || Number.isNaN(fromIdx) || fromIdx === toIdx) return;
    const activeId = frames[frameIdx]?.id;
    editDoc((d) => frameOps.reorderFrame(d, fromIdx, toIdx));
    // Keep the same frame active after the reorder.
    const next = clone(doc); frameOps.reorderFrame(next, fromIdx, toIdx);
    const newIdx = frameOps.frames(next).findIndex((s) => s.id === activeId);
    if (newIdx >= 0) setFrameIdx(newIdx);
  }, [doc, frames, editDoc, frameOps, frameIdx]);

  // ---- save / share / history ----------------------------------------------

  const onSave = useCallback(async () => {
    // ADR 0359 D2 (from ADR 0335's CRITICAL save-coexistence rule): while a
    // collab room is live the CRDT snapshot is the durable authority — the
    // chassis CAS save MUST NOT run (N clients saving → 409 storms + a second
    // authority). host.canvas derivation is backend-side (Phase 6).
    if (collab.enabled) return;
    if (!orgId || !canvasId || !doc) return;
    setSaving(true); setError(null); setConflict(false);
    const genAtSave = editGen.current;
    try {
      // DRAW-R4/DATA-D9: bound numeric/text fields to their propDef limits at the
      // save boundary, so a value that reached the doc without a widget blur
      // (paste, programmatic, AI-authored) can't 422 the CAS save. Shares every
      // unchanged element (clone-on-edit safe).
      const res = await client.saveCanvas(orgId, canvasId, clampDocForSave({ ...(doc as Record<string, unknown>) }, def), version);
      setVersion(res.newVersion);
      // Grade pass (code F9): edits that landed while the save was in flight
      // keep the dirty flag (and the unsaved-changes guard) alive.
      if (editGen.current === genAtSave) setDirty(false);
      // Soft cross-reference warnings (ADR 0305 Phase C) — saved fine, but a
      // reference points at a missing target.
      if (res.warnings?.length) toast.warning(t('savedWithWarnings', { n: res.warnings.length, first: res.warnings[0]?.message ?? '' }));
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409) setConflict(true);
      else setError(e instanceof Error ? e.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  }, [client, orgId, canvasId, doc, version, t, def, collab.enabled]);

  // ADR 0305 Phase E — the version-history modal; a restore re-fetches the
  // canvas and resets the undo stacks (the restored state is the new baseline).
  const [historyOpen, setHistoryOpen] = useState(false);
  const onRestored = useCallback(() => {
    setHistoryOpen(false);
    void (async () => {
      if (!orgId || !canvasId) return;
      try {
        const rec = await client.getCanvas(orgId, canvasId);
        reset(coerceDoc(rec.state)); setVersion(rec.version); setDirty(false); setSelPath(null); setFrameIdx(0); setGraphSel({ node: null, edge: null });
        toast.success(t('histRestored'));
      } catch (e) {
        setError(e instanceof Error ? e.message : t('loadError'));
      }
    })();
  }, [client, orgId, canvasId, reset, coerceDoc, t]);

  // ADR 0305 Phase D — mint a public share link (the sharing feature owns links;
  // opaque token, default 7-day TTL per the ADR) and copy the /shared URL. The
  // TYPE supplies the mint (canvas/ never imports features/*).
  const [sharing, setSharing] = useState(false);
  // UX-AB-2 — the last-minted URL stays re-copyable from the toolbar (a
  // transient toast alone loses the link if the user misses it).
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const share = def.share;
  const onShare = useCallback(async () => {
    if (!orgId || !canvasId || !share) return;
    // ADR 0345 3a — the mint-time data disclosure (type-supplied copy).
    if (share.disclosureKey && !(await confirm({ title: t('shareDisclosureTitle'), body: tt(share.disclosureKey), confirmLabel: t('shareConfirm') }))) return;
    setSharing(true);
    try {
      const label = doc ? String(dict(doc)[nameKey] ?? '') : '';
      const url = await share.mint(orgId, { resourceId: canvasId, ...(label ? { label } : {}) });
      setShareUrl(url);
      // SHARE-UX-3 — this was the verbatim two-line anti-pattern
      // `ui/copyToClipboard.ts` was written to delete: a raw `writeText` with an
      // EMPTY catch, followed by an unconditional "Public link copied: {url}".
      // On the one surface where the loss is permanent (ADR 0448 P2 — the raw
      // token exists exactly once), the app claimed a copy it had not made. The
      // shared helper never says "copied" unless the write resolved, and the
      // toolbar's `shareUrl` re-copy affordance is the recovery either way.
      // R2 review F6 — a failed copy is not a success: the variant follows the
      // outcome, not just the wording. (`toast.warning` rather than `error`: the
      // link WAS created; only the clipboard write failed, and the URL is on
      // screen in the toolbar's re-copy affordance.)
      const res = await copyToClipboard(url, null);
      if (res.ok) toast.success(t('shareCreated', { url }));
      else toast.warning(t('shareCreatedNotCopied', { url }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('shareFailed'));
    } finally {
      setSharing(false);
    }
  }, [orgId, canvasId, share, doc, nameKey, t, tt]);
  const recopyShare = useCallback(async () => {
    if (!shareUrl) return;
    // Same rule on the re-copy: the helper toasts the failure itself, so a
    // blocked clipboard says so instead of reporting a copy that never happened.
    const res = await copyToClipboard(shareUrl, null);
    if (res.ok) toast.success(t('shareCreated', { url: shareUrl }));
    else toast.warning(t('shareCreatedNotCopied', { url: shareUrl }));
  }, [shareUrl, t]);

  if (loading) return <div className="cv-editor"><StateCard loading title={t('loading')} /></div>;
  // ADR 0359 Phase 3 — a definitely-on elements collab session gates the whole
  // editor body until synced + seed-resolved (edits made against the pre-binding
  // working copy would be lost); mirrors the Phase 2 EditorSurface gate.
  // UX-B2: the gate has a CEILING — a session that never reaches its first sync
  // swaps the spinner for a designed error + Retry (never an infinite spinner).
  if (def.collab === 'elements' && collabEnabled && !collabLive && !error) {
    if (collab.enabled && collab.failed) {
      return (
        <div className="cv-editor">
          <StateCard announce
            title={t('liveConnectFailed')}
            body={t('liveConnectFailedBody')}
            action={<Button variant="secondary" size="sm" onClick={() => setCollabAttempt((a) => a + 1)}>{t('retry')}</Button>}
          />
        </div>
      );
    }
    // Distinct from the plain doc-load spinner: the wait here is the ticket
    // mint + socket connect + first sync, so the copy sets that expectation.
    return <div className="cv-editor"><StateCard loading title={t('liveConnecting')} /></div>;
  }
  // Ahead of the generic error branch on purpose: "we don't know which
  // workspace" is a different thing from "this canvas failed to load", and
  // collapsing them is what made the original defect unactionable.
  if (orgGate) {
    return (
      <div className="cv-editor u-p-4">
        <CanvasOrgGate resolution={orgGate} onPick={(orgId) => { setSearch((prev) => { const next = new URLSearchParams(prev); next.set('org', orgId); return next; }); }} />
      </div>
    );
  }

  if (error && !doc) {
    return (
      <div className="cv-editor">
        <Notice variant="error">
          {error}
          {!errorPermanent && <> <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>{t('retry')}</Button></>}
        </Notice>
      </div>
    );
  }
  if (!doc || !catalog) return <div className="cv-editor"><Notice variant="error">{t('loadError')}</Notice></div>;

  const selIdx = selPath?.[selPath.length - 1] ?? -1;
  const selSiblings = selPath ? siblingCount(selPath) : 0;
  const ToolbarExtras = def.ToolbarExtras;
  const PreviewPanel = def.PreviewPanel;
  const InteractivePreview = def.InteractivePreview;
  const EditorSurface = def.EditorSurface;
  // ADR 0333 grade pass CODE-D1 — only serialize when the read-only Renderer /
  // PreviewPanel path actually consumes it; the InteractivePreview branch
  // (drawings/cad) re-serialized the whole doc every render for nothing.
  const needsPreviewContent = !(InteractivePreview && elementsDef && !PreviewPanel && !(graphDef && graphView));
  const previewContent = needsPreviewContent ? JSON.stringify(framesKey ? { ...doc, [framesKey]: frame ? [frame] : [] } : doc) : '';

  const touchLevel = def.touchSupport ?? 'view';
  const workspaceModes = [
    ...(graphDef ? [{
      id: '__graph__',
      label: graphView ? t('graphViewGraph') : t('graphViewEdit'),
      active: workspaceTab === null,
      onSelect: () => {
        // Returning from a type workspace always restores its primary canvas
        // surface. Once there, retain the established Graph ⇄ Edit toggle.
        if (workspaceTab !== null) {
          setWorkspaceTab(null);
          setGraphView(true);
        } else setGraphView((v) => !v);
      },
    }] : []),
    ...(def.workspaceTabs ?? []).map((w) => ({
      id: w.id,
      label: tt(w.labelKey),
      active: workspaceTab === w.id,
      onSelect: () => setWorkspaceTab((cur) => (cur === w.id ? null : w.id)),
    })),
  ];
  const workspaceLabel = def.workbench?.workspaceLabelKey ? tt(def.workbench.workspaceLabelKey) : t('workspaceModes');
  const workspaceStatus = activeWorkspaceTab
    ? tt(activeWorkspaceTab.labelKey)
    : graphDef ? (graphView ? t('graphViewGraph') : t('graphViewEdit'))
      : tt('editorHeading');
  return (
    <CanvasWorkbench className={`cv-editor${def.workbench?.className ? ` ${def.workbench.className}` : ''}`}>
      {/* ADR 0510 §9 (DSA-027) — the DECLARED touch level, surfaced honestly on
          small screens (CSS-gated ≤600px). 'full' needs no caveat. */}
      {touchLevel !== 'full' ? (
        // Plain static text, NOT a <Notice>: this is a standing capability
        // statement, not a state change — a live region here would announce a
        // phantom status on every mount.
        <p className="cv-editor__touchlevel">{t(`touchLevel_${touchLevel}`)}</p>
      ) : null}
      <header className="cv-editor__bar">
        {/* The editor is a full-screen surface with no PageHeader — give the
            page outline its h1 (BLD-8/XC-5); the visible identity is the
            editable name input below. */}
        <h1 className="sr-only">{tt('editorHeading')}</h1>
        {/* Return to wherever the editor was opened from (the chat card is the
            usual entry) — the toolbar previously had no exit but Delete
            (grade pass UX-CV-1). */}
        <Button variant="secondary" size="sm" onClick={() => navigate(-1)} title={t('back')} aria-label={t('back')}>
          <ArrowLeftIcon size={13} />
        </Button>
        <input
          className="cv-editor__name"
          value={docName}
          aria-label={tt('docName')}
          // ADR 0359 D2/Phase 3 — for the ELEMENTS binding the doc-level name
          // rides the CRDT props map (editable live); for the document surface
          // the name is outside the Y.XmlFragment, so a live edit would dirty a
          // working copy that can never save — locked, not silently lost.
          disabled={collab.enabled && !collabLive}
          title={collab.enabled && !collabLive ? t('liveLocked') : undefined}
          onChange={(e) => { history.replace({ ...doc, [nameKey]: e.target.value }); editGen.current += 1; setDirty(true); }}
        />
        {/* Identity status rides beside the name (compact) — the version + the
            saved-state chip, so the app title no longer owns a whole row. */}
        <span className="cv-editor__status">
          <span className="cv-editor__version">{t('version', { n: version })}</span>
          {dirty && !collab.enabled ? <span className="chip chip--muted cv-editor__unsaved">{t('unsaved')}</span> : null}
          {/* ADR 0359 Phase 4 — the live-session identity: the Live chip is the
              visible why for the locked Save/History/Preview affordances. */}
          {/* UX-N5 — the chip reflects the SOCKET honestly (a stale synced
              flag must not read "Live" over a dropped connection). */}
          {collab.enabled ? <CollabPresence peers={presence.peers} connected={collab.connected} /> : null}
        </span>
        {/* The spacer left-anchors identity and right-anchors every action
            cluster — the single-row pro-tool layout (ADR 0310 chassis). */}
        {selectionSummary ? <span className="cv-editor__selchip">{selectionSummary}</span> : null}
        {quickCtx && !narrowBar && !(graphDef && graphView && !selEl) ? <QuickPropsCluster defs={quickCtx.defs} valueOf={quickCtx.valueOf} onSet={quickCtx.onSet} tt={(k, o) => (o ? tt(k, o) : tt(k))} label={t('quickPropsLabel')} /> : null}
        <span className="cv-editor__spacer" aria-hidden="true" />
        <span className="cv-editor__tools" role="group" aria-label={t('historyTools')}>
          {/* ADR 0334 (canvas-document) — an EditorSurface owns its own
              undo/redo (the engine's history); hide the chassis buttons so the
              two stacks don't fight. */}
          {!EditorSurface ? (
            <>
              <Button variant="secondary" size="sm" disabled={!history.canUndo} onClick={undo} title={t('undo')} aria-label={t('undo')}><UndoIcon size={13} /></Button>
              <Button variant="secondary" size="sm" disabled={!history.canRedo} onClick={redo} title={t('redo')} aria-label={t('redo')}><RedoIcon size={13} /></Button>
            </>
          ) : null}
          {/* Pointer path to the `?` cheatsheet (ux-review — a keyboard-only
              route to a shortcuts overlay is its own irony). */}
          <Button variant="secondary" size="sm" onClick={() => setShortcutsOpen(true)} title={t('shortcutsTitle')} aria-label={t('shortcutsTitle')}><HelpCircleIcon size={13} /></Button>
        </span>
        {/* Tool modes (ADR 0333 Phase 2) — rendered only when the type
            declares tools; `select` is implicit and always first. Honest ARIA:
            aria-pressed toggle buttons in a labeled group (a radiogroup would
            promise arrow-key roving this segment doesn't implement —
            ux-review). */}
        {def.tools?.length ? (
          <span className="cv-editor__toolmodes" role="group" aria-label={t('toolModes')}>
            {[{ id: 'select', icon: undefined as (() => JSX.Element) | undefined, labelKey: '' }, ...def.tools].map((tool) => {
              const label = tool.id === 'select' ? t('toolSelect') : tt(tool.labelKey);
              return (
                <Button
                  key={tool.id}
                  aria-pressed={activeTool === tool.id}
                  variant="secondary" size="sm" className={activeTool === tool.id ? 'cv-editor__toolmode--active' : undefined}
                  onClick={() => { setActiveTool(tool.id); setAnnounce(t('annTool', { tool: label })); }}
                  title={label}
                  aria-label={label}
                >
                  {tool.icon ? tool.icon() : <MousePointerIcon size={13} />}
                </Button>
              );
            })}
          </span>
        ) : null}
        <span className="cv-editor__bar-sep" aria-hidden="true" />
        {narrowBar ? (
          // §7.2.1 / CV-15 — under 920px the view cluster folds into ONE ⋮
          // overflow Menu (the ChatHeader precedent); the bar never wraps and
          // never (visibly) horizontal-scrolls. Save/Delete/undo/tool modes
          // never collapse.
          <Menu
            label={t('moreActions')}
            triggerContent={<MoreHorizontalIcon size={15} aria-hidden />}
            triggerClassName="btn-ghost btn-sm"
            triggerTitle={t('moreActions')}
            items={[
              ...(def.preview ? [{
                id: 'preview',
                label: t('preview'),
                disabled: !canvasId,
                onSelect: () => {
                  if (!canvasId) return;
                  if (dirty) { toast.info(t('previewUnsavedHint')); return; }
                  navigate(`${def.editorPath}/${encodeURIComponent(canvasId)}/preview`);
                },
              }] : []),
              ...(share ? [{ id: 'share', label: sharing ? t('sharing') : t('share'), disabled: sharing || !canvasId, onSelect: () => void onShare() }] : []),
              ...(shareUrl ? [{ id: 'copy-share', label: t('copyShareLink'), onSelect: () => void recopyShare() }] : []),
              // ADR 0359 D2 — History (incl. restore) is locked while a room is
              // live: host.canvas is stale until the Phase 6 derive, and a
              // restore would write a second authority under the CRDT.
              { id: 'history', label: t('history'), disabled: !canvasId || collab.enabled, onSelect: () => setHistoryOpen(true) },
            ]}
            portal
          />
        ) : (
          <>
            {def.preview ? (
              <Button
                // Grade pass UX-CV-5: Preview stays clickable while dirty (it shows
                // a "save first" hint) but must LOOK unavailable then, so the
                // disabled visual matches the aria-disabled state.
                variant="secondary" size="sm" className={!canvasId || dirty || collab.enabled ? 'cv-editor__btn--pending' : undefined}
                aria-disabled={!canvasId || dirty || collab.enabled}
                onClick={() => {
                  if (!canvasId) return;
                  // ADR 0359 — the preview route renders host.canvas, which is
                  // STALE while a room is live (derive lands in Phase 6).
                  if (collab.enabled) { toast.info(t('liveLocked')); return; }
                  if (dirty) { toast.info(t('previewUnsavedHint')); return; }
                  navigate(`${def.editorPath}/${encodeURIComponent(canvasId)}/preview`);
                }}
              >
                {t('preview')}
              </Button>
            ) : null}
            {share ? (
              <Button variant="secondary" size="sm" onClick={() => void onShare()} disabled={sharing || !canvasId}>
                {sharing ? t('sharing') : t('share')}
              </Button>
            ) : null}
            {shareUrl ? (
              <Button variant="quiet" size="sm" onClick={() => void recopyShare()}>
                {t('copyShareLink')}
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" onClick={() => setHistoryOpen(true)}
              // ADR 0359 D2 — locked while a room is live (stale host.canvas; a
              // restore would write a second authority under the CRDT).
              disabled={!canvasId || collab.enabled}
              title={collab.enabled ? t('liveLocked') : undefined}
            >
              {t('history')}
            </Button>
          </>
        )}
        <span className="cv-editor__bar-sep" aria-hidden="true" />
        <Button variant="primary" size="sm" className="cv-editor__save"
          // ADR 0359 D2 — no CAS save while a collab room is live (the CRDT
          // snapshot is the durable authority; onSave also guards).
          disabled={saving || !dirty || collab.enabled}
          title={collab.enabled ? t('liveLocked') : undefined}
          onClick={() => void onSave()}
        >
          {saving ? t('saving') : t('save')}
        </Button>
        {ToolbarExtras && orgId && canvasId ? (
          <ToolbarExtras orgId={orgId} canvasId={canvasId} docName={docName} dirty={dirty} />
        ) : null}
        {/* Grade pass UX-CV-7: the destructive Delete lives at the FAR END,
            separated (`cv-editor__delete-sep` pushes it clear of the neutral
            controls) — a mid-toolbar destructive action was a misclick risk. */}
        <Button
          variant="secondary" size="sm" className="cv-editor__delete--danger cv-editor__delete-sep"
          disabled={!canvasId}
          onClick={() => {
            void (async () => {
              if (!orgId || !canvasId || !doc) return;
              if (!(await confirm({ title: tt('deleteDocTitle', { name: docName }), body: tt('deleteDocBody'), confirmLabel: tt('deleteDoc'), danger: true }))) return;
              try {
                await client.deleteCanvas(orgId, canvasId);
                toast.success(tt('deleteDocDone'));
                // ADR 0487 — the in-app "home" is the Dashboard's own URL ('/' is
                // the public marketing home; navigating there would eject an anon
                // demo user out of the app onto the landing page).
                navigate('/dashboard');
              } catch (e) {
                toast.error(e instanceof Error ? e.message : tt('deleteDocFailed'));
              }
            })();
          }}
        >
          {tt('deleteDoc')}
        </Button>
      </header>

      {/* ADR 0739 — a distinct mode strip keeps persistent authoring modes out
          of the dense command bar. Types own mode behavior; the chassis owns
          the stable layout and accessible names. */}
      {workspaceModes.length ? (
        <nav className="cv-editor__workspace" aria-label={workspaceLabel}>
          <span className="cv-editor__workspace-label">{workspaceLabel}</span>
          <span className="cv-editor__workspace-tabs">
            {workspaceModes.map((mode) => (
              <Button
                key={mode.id}
                variant="quiet" size="sm"
                className={`cv-editor__workspace-tab${mode.active ? ' is-active' : ''}`}
                aria-pressed={mode.active}
                onClick={mode.onSelect}
              >
                {mode.label}
              </Button>
            ))}
          </span>
        </nav>
      ) : null}

      {conflict ? (
        <Notice variant="warning">
          {t('conflict')}{' '}
          <Button
            variant="secondary" size="sm"
            onClick={() => {
              void (async () => {
                if (!orgId || !canvasId) return;
                if (!(await confirm({ title: t('reloadLatestTitle'), body: t('reloadLatestBody'), confirmLabel: t('reloadLatest'), danger: true }))) return;
                try {
                  const rec = await client.getCanvas(orgId, canvasId);
                  reset(coerceDoc(rec.state)); setVersion(rec.version); setDirty(false); setConflict(false); setSelPath(null); setFrameIdx(0); setGraphSel({ node: null, edge: null });
                } catch (e) {
                  setError(e instanceof Error ? e.message : t('loadError'));
                }
              })();
            }}
          >
            {t('reloadLatest')}
          </Button>
        </Notice>
      ) : null}
      {error ? <Notice variant="error">{error}</Notice> : null}
      {/* Grade pass (UX F2) — the one polite live region for structural ops.
          UX-CV-6: `role=status`/`role=alert` already imply polite/assertive
          `aria-live`, so the explicit attribute was redundant — dropped. */}
      <span className="sr-only" role="status">{announce}</span>
      {/* RFC 0130 — assertive channel for plugin announcements that must interrupt. */}
      <span className="sr-only" role="alert">{announceAssertive}</span>
      {kitOpen ? (
        <Modal onClose={() => setKitOpen(null)} label={kitOpen.label} showClose>
          <h2 className="cv-editor__panel-title">{kitOpen.label}</h2>
          {kitOpen.description ? <p className="muted">{kitOpen.description}</p> : null}
          {(kitOpen.variables ?? []).map((v) => {
            const val = kitValues[v.name] ?? '';
            const isHex = /^#[0-9a-fA-F]{6}$/.test(val);
            return (
              <label key={v.name} className="cv-editor__field">
                <span className="cv-editor__field-label">{v.label ?? v.name}</span>
                {v.type === 'color' ? (
                  // A hex TEXT field is the primary control (typeable, clearable,
                  // token-pasteable); the swatch only renders once the value IS a
                  // valid #rrggbb — a bare `type="color"` shows a black swatch for
                  // an empty value and offers no way to type (grade pass AB-UX-3).
                  <span className="cv-editor__color-pair">
                    <input
                      className="cv-editor__input"
                      value={val}
                      placeholder="#RRGGBB"
                      onChange={(e) => setKitValues((k) => ({ ...k, [v.name]: e.target.value }))}
                    />
                    {isHex ? (
                      <input
                        type="color"
                        className="cv-editor__color-swatch"
                        aria-label={v.label ?? v.name}
                        value={val}
                        onChange={(e) => setKitValues((k) => ({ ...k, [v.name]: e.target.value }))}
                      />
                    ) : null}
                  </span>
                ) : (
                  <input
                    className="cv-editor__input"
                    value={val}
                    onChange={(e) => setKitValues((k) => ({ ...k, [v.name]: e.target.value }))}
                  />
                )}
                {v.description ? <span className="muted">{v.description}</span> : null}
              </label>
            );
          })}
          <span className="action-bar">
            <Button variant="primary" size="sm" onClick={insertKitNow}>{t('kitInsert', { n: kitOpen.screens.length })}</Button>
            <Button variant="quiet" size="sm" onClick={() => setKitOpen(null)}>{t('kitCancel')}</Button>
          </span>
        </Modal>
      ) : null}
      {templatesOpen && catalog.templates?.length ? (
        <TemplateGallery
          templates={catalog.templates}
          renderContent={templateContent}
          Renderer={def.Renderer}
          onUse={useTemplate}
          onClose={() => setTemplatesOpen(false)}
          labels={{ title: t('templatesGalleryTitle') }}
        />
      ) : null}
      {historyOpen && orgId && canvasId ? (
        <CanvasHistoryModal client={client} orgId={orgId} canvasId={canvasId} currentDoc={doc} coerceDoc={coerceDoc} summarize={defaultVersionSummarizer} typeNamespace={def.i18nNamespace} onClose={() => setHistoryOpen(false)} onRestored={onRestored} />
      ) : null}
      {shortcutsOpen ? (
        <ShortcutsOverlay shortcuts={committedShortcuts} typeT={(k) => tt(k)} onClose={() => setShortcutsOpen(false)} />
      ) : null}

      <div className="cv-editor__cols" style={railVars}>
        {/* Palette — the closed component catalog, grouped by category with an
            instant client-side filter (grade pass UX F11 — 35 flat rows were a
            scan exercise). Click/Enter adds (keyboard path); dragging onto the
            preview places precisely. §7.2/CV-14: resizable (separator) +
            collapsible (chevron / `[`), persisted per canvas type. */}
        {/* The rail is the Screens list ONLY for frames-backed graphs (ADR
            0337); an elements-backed board (ADR 0360 campaign) keeps its
            palette label + adders — otherwise the rail renders empty and
            mislabeled (caught live in the CT-CV-6 pass). */}
        <RailAside
          side="l"
          collapsed={rails.l.collapsed}
          className="cv-editor__palette"
          label={graphView && graphDef && framesDef ? t('screensRail') : (treeActive || elementsDef ? t('palette') : t('templates'))}
          expandLabel={t('expandPalette')}
          collapseLabel={t('collapsePalette')}
          onToggle={() => toggleRail('l')}
        >
          {/* ADR 0337 — the Screens rail: in the graph-first board view the left
              rail lists SCREENS (not components), the MyndHyve model. Reuses the
              frames trait wholesale — select scrolls/highlights the board node,
              double-click opens that screen's component editor, the ⋯ menu is the
              same frame menu (rename/duplicate/home/reorder/delete). */}
          {graphView && graphDef && framesDef && frameOps && doc ? (
            <div className="cv-editor__screens-rail">
              <div className="cv-editor__panel-head">
                <h2 className="cv-editor__panel-title">{t('screensRail')}</h2>
                <Button variant="quiet" size="sm" onClick={onAddFrame} disabled={frames.length >= framesDef.max} aria-label={tt('addFrame')} title={tt('addFrame')}>
                  <PlusIcon size={14} aria-hidden />
                </Button>
              </div>
              <ul className="cv-editor__screens-rail-list" aria-label={t('screensRail')}>
                {frames.map((f, i) => (
                  <li key={f.id} className={`cv-editor__screen-row${graphSel.node === f.id ? ' cv-editor__screen-row--sel' : ''}`}>
                    {renamingIdx === i ? (
                      <input
                        className="cv-editor__input cv-editor__screen-rename"
                        autoFocus
                        value={renameVal}
                        aria-label={tt('renameFrame')}
                        onChange={(e) => setRenameVal(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setRenamingIdx(null); }}
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          className="cv-editor__screen-name"
                          aria-current={graphSel.node === f.id ? 'true' : undefined}
                          onClick={() => setGraphSel({ node: f.id, edge: null })}
                          onDoubleClick={() => activateGraphNode(f.id)}
                        >
                          {isHome(f) ? <span className="chip chip--muted cv-editor__screen-home">{tt('home')}</span> : null}
                          <span className="cv-editor__screen-name-text">{f.name || tt('frameDefaultName', { n: i + 1 })}</span>
                        </button>
                        <Menu items={onFrameMenu(i)} label={tt('frameActions', { name: f.name || '' })} triggerClassName="btn-ghost btn-sm cv-editor__screen-menu" triggerContent={<MoreHorizontalIcon size={14} aria-hidden />} align="end" />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {/* Elements mode (ADR 0310 Phase C): per-collection adders — one
              button per element kind, click/Enter adds + selects. */}
          {!(graphView && graphDef && framesDef) && elementsDef ? elementsDef.map((col) => (
            <div key={col.key}>
              <h2 className="cv-editor__panel-title">{col.label ?? tt(`col_${col.key}`)}</h2>
              <ul className="cv-editor__palette-list">
                {col.adders.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      className="cv-editor__palette-item"
                      disabled={doc ? readElements(doc, col.key).length >= col.max : true}
                      onClick={() => addElementOf(col, a)}
                    >
                      <span className="cv-editor__palette-label">{a.label ?? tt(`add_${a.id}`)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )) : null}
          {!(graphView && graphDef) && treeActive ? (
            <>
              <h2 className="cv-editor__panel-title">{t('palette')}</h2>
              <input
                type="search"
                className="cv-editor__input"
                value={paletteFilter}
                placeholder={t('paletteFilter')}
                aria-label={t('paletteFilter')}
                onChange={(e) => setPaletteFilter(e.target.value)}
              />
            </>
          ) : null}
          {!(graphView && graphDef) && treeActive ? paletteGroups.map(([category, items]) => (
            <div key={category}>
              <h3 className="cv-editor__panel-title cv-editor__palette-cat">{category === '__favorites' ? t('catFavorites') : category === '__recent' ? t('catRecent') : tt(`cat_${category}`)}</h3>
              <ul className="cv-editor__palette-list">
                {items.map((c) => (
                  <li key={c.type} className="cv-editor__palette-row">
                    <button
                      type="button"
                      className="cv-editor__palette-item"
                      onClick={() => addComponent(c)}
                      title={c.description ?? c.label}
                      draggable
                      onDragStart={(e) => { e.dataTransfer.setData(MIME_ADD, c.type); e.dataTransfer.effectAllowed = 'copy'; }}
                    >
                      <span className="cv-editor__palette-label">{c.label}</span>
                      {c.acceptsChildren ? <span className="cv-editor__palette-tag">{t('container')}</span> : null}
                    </button>
                    {/* A SIBLING control — the item is itself a button (no nesting). */}
                    <Button
                      variant="quiet" size="sm" className={`cv-editor__palette-star${palettePrefs.isFavorite(c.type) ? ' is-fav' : ''}`}
                      aria-pressed={palettePrefs.isFavorite(c.type)}
                      aria-label={t(palettePrefs.isFavorite(c.type) ? 'favoriteRemove' : 'favoriteAdd', { label: c.label })}
                      title={t(palettePrefs.isFavorite(c.type) ? 'favoriteRemove' : 'favoriteAdd', { label: c.label })}
                      onClick={() => palettePrefs.toggleFavorite(c.type)}
                    >
                      <StarIcon size={13} aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )) : null}
          {/* ADR 0305 Phase F — frame templates: one click adds a NEW frame
              built from the closed template catalog. */}
          {!(graphView && graphDef) && framesDef && frameOps && catalog.templates?.length ? (
            <>
              <h2 className="cv-editor__panel-title">{t('templates')}</h2>
              <Button variant="quiet" size="sm" className="cv-editor__tpl-browse" onClick={() => setTemplatesOpen(true)}>{t('templatesBrowse')}</Button>
              <ul className="cv-editor__palette-list">
                {catalog.templates.map((tpl) => (
                  <li key={tpl.id}>
                    <button
                      type="button"
                      className="cv-editor__palette-item"
                      title={tpl.description}
                      disabled={frames.length >= framesDef.max}
                      onClick={() => {
                        const content = tpl.content ?? (rootKey ? { [rootKey]: tpl.components ?? [] } : {});
                        let idx = -1;
                        editDoc((d) => { idx = frameOps.addFrameFromTemplate(d, { name: tpl.name, content }); });
                        if (idx >= 0) { setFrameIdx(idx); setSelPath(null); }
                      }}
                    >
                      <span className="cv-editor__palette-label">{tpl.name}</span>
                      <span className="cv-editor__palette-tag">{tt('templateTag')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {/* ADR 0347 5a — pack-distributed multi-frame kits. */}
          {!(graphView && graphDef) && def.insertKit && catalog.kits?.length ? (
            <>
              <h2 className="cv-editor__panel-title">{t('kitsTitle')}</h2>
              <ul className="cv-editor__palette-list">
                {catalog.kits.map((kit) => (
                  <li key={kit.kitId}>
                    <button
                      type="button"
                      className="cv-editor__palette-item"
                      title={kit.description}
                      onClick={() => openKit(kit)}
                    >
                      <span className="cv-editor__palette-label">{kit.label}</span>
                      <span className="cv-editor__palette-tag">{t('kitTag')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </RailAside>
        {/* §7.2 / CV-14 — the rail resize separators live on the GRID (absolute,
            out of flow — no phantom tracks), pinned into the column gaps; inside
            the overflow:auto asides they would scroll away. */}
        {!rails.l.collapsed ? (
          <RailSeparator side="l" value={rails.l.w} label={t('resizePalette')} onResize={(w) => rails.resize('l', w)} />
        ) : null}
        {!rails.r.collapsed ? (
          <RailSeparator side="r" value={rails.r.w} label={t('resizeProps')} onResize={(w) => rails.resize('r', w)} />
        ) : null}

        {/* Center — frame manager + live preview (click-select + drop target) + outline. */}
        <main className="cv-editor__center">
          {/* Grade pass UX F7: real tablist semantics — the strip is the doc's
              central object. Arrow keys rove; the tab keeps its drag + menu roles. */}
          {framesDef ? (
          <nav className="cv-editor__screens" role="tablist" aria-label={tt('frames')} ref={framesNavRef} tabIndex={-1}>
            {frames.map((s, i) => (
              <span key={s.id} className="cv-editor__screen-cell">
                {renamingIdx === i ? (
                  <input
                    className="cv-editor__rename cv-editor__input"
                    value={renameVal}
                    aria-label={tt('renameFrame')}
                    autoFocus
                    onChange={(e) => setRenameVal(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                      else if (e.key === 'Escape') setRenamingIdx(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    role="tab"
                    id={`cv-tab-${s.id}`}
                    aria-controls="cv-editor-tabpanel"
                    aria-selected={i === frameIdx}
                    tabIndex={i === frameIdx ? 0 : -1}
                    className={`cv-editor__screen-tab${i === frameIdx ? ' is-active' : ''}`}
                    onClick={() => { setFrameIdx(i); setSelPath(null); }}
                    onDoubleClick={() => { setRenameVal(s.name); setRenamingIdx(i); }}
                    onKeyDown={(e) => {
                      // Arrow roving + Home/End (the ARIA tabs pattern — UX-CV-4).
                      let next: number;
                      if (e.key === 'ArrowRight') next = (frameIdx + 1) % frames.length;
                      else if (e.key === 'ArrowLeft') next = (frameIdx - 1 + frames.length) % frames.length;
                      else if (e.key === 'Home') next = 0;
                      else if (e.key === 'End') next = frames.length - 1;
                      else return;
                      e.preventDefault();
                      setFrameIdx(next); setSelPath(null);
                      (e.currentTarget.closest('[role="tablist"]')?.querySelectorAll('[role="tab"]')[next] as HTMLElement | undefined)?.focus();
                    }}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData(MIME_FRAME, String(i)); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragOver={(e) => { if (e.dataTransfer.types.includes(MIME_FRAME)) e.preventDefault(); }}
                    onDrop={(e) => onFrameTabDrop(e, i)}
                  >
                    {s.name}{isHome(s) ? <span className="cv-editor__home-tag">{tt('home')}</span> : null}
                    {/* ADR 0359 D5 — quiet peer markers: who is on this frame. */}
                    {peersOnFrame(i).length > 0 ? (
                      <span className="cv-presence__rowmark" title={peersOnFrame(i).map((p) => p.name).join(', ')}>
                        {peersOnFrame(i).slice(0, 3).map((p) => (
                          <Avatar key={p.clientId} name={p.name} hueKey={p.name} size={14} alt={t('selectedBy', { name: p.name })} />
                        ))}
                      </span>
                    ) : null}
                  </button>
                )}
                {i === frameIdx && renamingIdx !== i ? (
                  <Menu
                    label={tt('frameActions', { name: s.name })}
                    triggerContent={<MoreHorizontalIcon size={13} />}
                    triggerClassName="secondary btn-sm cv-editor__screen-menu"
                    items={onFrameMenu(i)}
                  />
                ) : null}
              </span>
            ))}
            <Button
              variant="secondary" size="sm" className="cv-editor__screen-add"
              onClick={onAddFrame}
              disabled={frames.length >= framesDef.max}
              title={tt('addFrame')}
              aria-label={tt('addFrame')}
            >
              <PlusIcon size={13} />
            </Button>
          </nav>
          ) : null}
          {/* Delegated pointer conveniences over the rendered preview. Selection
              and every arrange op have first-class keyboard paths (outline rows
              are buttons; the property panel has Move up/down/out) — the click
              here is the pointer duplicate, per the Modal-backdrop precedent. */}
          <ViewportHandleContext.Provider value={viewportSlotApi}>
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events */}
          <div
            ref={previewRef}
            className="cv-editor__preview"
            // ADR 0333 Phase 8 — the verified touch convention: two-finger tap
            // = undo, three-finger = redo (movement/pinch never qualifies).
            onPointerDownCapture={onPreviewTouchDown}
            onPointerMoveCapture={onPreviewTouchMove}
            onPointerUpCapture={onPreviewTouchUp}
            onPointerCancelCapture={onPreviewTouchUp}
            // The tabpanel role pairs with the frame tablist; elements mode has
            // no tablist, so the role is dropped there (valid ARIA pairing).
            {...(framesDef ? { role: 'tabpanel', id: 'cv-editor-tabpanel', 'aria-labelledby': frame ? `cv-tab-${frame.id}` : undefined } : {})}
            onClick={onPreviewClick}
            onDragStart={onPreviewDragStart}
            onDragOver={onPreviewDragOver}
            onDragLeave={onPreviewDragLeave}
            onDrop={onPreviewDrop}
            onDragEnd={onPreviewDragEnd}
          >
            {activeWorkspaceTab && doc && orgId ? (
              // ADR 0345 3d — a type-contributed workspace tab replaces the
              // center surface; edits commit through the ONE history seam.
              <activeWorkspaceTab.Component
                doc={dict(doc)}
                commitDoc={(mutator) => editDoc((d) => mutator(dict(d)))}
                orgId={orgId}
                onAnnounce={dispatchAnnounce}
              />
            ) : graphDef && graphView && doc ? (
              // ADR 0323: the node-graph / screen-flow overview replaces the
              // per-frame preview. The chassis owns selection + history; the
              // trait projects the doc into nodes/edges + applies mutations.
              <GraphSurface
                nodes={graphDef.nodes(doc)}
                edges={graphDef.edges(doc)}
                nodeSize={graphDef.nodeSize}
                renderNode={graphDef.renderNode}
                selectedNodeId={graphSel.node}
                selectedEdgeId={graphSel.edge}
                onSelectNode={(id) => {
                  setGraphSel({ node: id, edge: null });
                  // ADR 0360 — elements-backed boards drive the ONE element
                  // selection (panel + list stay in sync with the board).
                  if (graphDef.elementForNode) {
                    const el = id ? graphDef.elementForNode(id) : null;
                    if (el) setMulti(el.col, [el.idx]);
                    else clearSel();
                  }
                }}
                onSelectEdge={(id) => setGraphSel({ node: null, edge: id || null })}
                onMoveNode={moveGraphNode}
                {...(graphDef.connect ? { onConnect: connectGraph } : {})}
                {...(graphDef.deleteEdge ? { onDeleteEdge: deleteGraphEdge } : {})}
                onActivateNode={activateGraphNode}
                {...(graphDef.addConnectedNode ? { onAddConnected: addConnectedGraphNode } : {})}
                onAnnounce={dispatchAnnounce}
                {...(graphDef.gridSnap ? { gridSnap: graphDef.gridSnap } : {})}
                {...(graphDef.deviceFrames ? { deviceFrames: graphDef.deviceFrames } : {})}
                {...(graphDef.defaultDevice ? { defaultDevice: graphDef.defaultDevice } : {})}
                labels={graphLabels}
              />
            ) : EditorSurface && doc && orgId ? (
              // ADR 0334: a FULL editor center panel (rich-text/TipTap). The
              // chassis owns save/version/dirty; the surface owns intra-document
              // selection + undo/redo. onDocChange lifts the working copy without
              // a chassis-history step.
              // ADR 0359 D2: gate ONLY while a definitely-on collab session is
              // still provisioning (resolve-once — the mounted surface's binding
              // and undo owner are fixed at mount); the keyed remount fires at
              // most once if collab resolves on after a solo mount.
              collabEnabled && collab.enabled && collab.failed && !collab.synced ? (
                // UX-B2 — the document session never reached its first sync:
                // an editor over an empty CRDT would look like data loss.
                <StateCard announce
                  title={t('liveConnectFailed')}
                  body={t('liveConnectFailedBody')}
                  action={<Button variant="secondary" size="sm" onClick={() => setCollabAttempt((a) => a + 1)}>{t('retry')}</Button>}
                />
              ) : collabEnabled && !collab.enabled ? (
                // UX-I3 — a designed loading state, not a bare aria-busy div.
                <StateCard loading title={t('loading')} />
              ) : (
                <EditorSurface key={collab.enabled ? 'collab' : 'solo'} orgId={orgId} {...(canvasId ? { canvasId } : {})} doc={doc} onDocChange={onEditorDocChange} onAnnounce={dispatchAnnounce} collab={collab} />
              )
            ) : PreviewPanel ? (
              // RFC 0130 (ADR 0310 Phase E): a live preview panel (the sandboxed
              // canvas-preview plugin frame for pack types) replaces the Renderer.
              <PreviewPanel content={previewContent} selection={selectionInfo} onAnnounce={dispatchAnnounce} />
            ) : InteractivePreview && elementsDef && doc ? (
              // ADR 0310 Phase C follow-up: direct-manipulation editing — the
              // type renders its scene interactively (click-select + drag),
              // reporting gestures through the chassis history via patchElement.
              <InteractivePreview
                doc={doc}
                selection={selEl}
                onSelect={(col, idx) => selectEl(col, idx)}
                onClearSelection={() => clearSel()}
                selectedIndices={(col) => (multiSel && multiSel.col === col ? multiSel.idxs : [])}
                onSetSelection={setMulti}
                patchElement={patchElement}
                patchElements={patchElements}
                deleteElements={deleteElements}
                activeTool={activeTool}
                addElements={addElementsSeam}
                cancelSignal={cancelSignal}
                elementActions={elementActions}
                {...(collab.enabled ? { peerSelections: peerSelectionsFor } : {})}
              />
            ) : (
              // §7.3 / CV-3 — the plain-Renderer center (slides, campaign,
              // pack data views) rides the shared viewport: paged sheets get
              // pan/zoom + the cluster. PreviewPanel (plugin iframe) and the
              // EditorSurface (owns its scroll) are structurally excluded by
              // the branches above (architect ruling P1-3).
              <ViewportSurface>
                <def.Renderer content={previewContent} editPaths />
              </ViewportSurface>
            )}
          </div>
          </ViewportHandleContext.Provider>
          {treeActive && frame ? (
            <div role="region" className="cv-editor__outline" aria-label={t('outline')} ref={outlineRef} tabIndex={-1}>
              <h2 className="cv-editor__panel-title">{t('outline')}</h2>
              <p id="cv-outline-reorder-hint" className="sr-only">{t('reorderHint')}</p>
              <OutlineTree
                nodes={rootChildren(frame)}
                path={[]}
                selPath={selPath}
                onSelect={setSelPath}
                dropPath={outlineDrop}
                setDropPath={setOutlineDrop}
                onDropRow={onOutlineDrop}
                onReorder={onOutlineReorder}
                labelFor={(n) => catalog.components.find((c) => c.type === n.type)?.label ?? n.type}
                childrenOf={childrenOf}
                label={t('outline')}
                describedById="cv-outline-reorder-hint"
              />
            </div>
          ) : null}
          {/* Flow mode (ADR 0334): a live heading outline / document map for
              rich-text canvases. Progressive — shown only once the doc has
              headings; each row scrolls the rendered content to that heading. */}
          {def.flow && doc ? (() => {
            const flowHeadings = def.flow.headings(doc);
            return flowHeadings.length ? (
              <div className="cv-editor__outline" ref={outlineRef} tabIndex={-1}>
                <FlowOutline headings={flowHeadings} contentRef={previewRef} label={t('outline')} />
              </div>
            ) : null;
          })() : null}
          {/* Elements mode (ADR 0310 Phase C): one selectable flat list per
              collection — the keyboard path for selection, like outline rows. */}
          {elementsDef ? (
            <div role="region" className="cv-editor__outline" aria-label={t('outline')} ref={outlineRef} tabIndex={-1}>
              {elementsDef.map((col) => {
                const list = readElements(doc, col.key);
                // The active roving tab-stop: the primary selection in this
                // collection, else the first row. Arrow moves focus; Space
                // toggles membership; Enter/click selects one; Shift extends —
                // the WCAG-canonical keyboard multi-select (ADR 0317).
                const primary = multiSel && multiSel.col === col.key ? multiSel.idxs[0]! : -1;
                const rove = primary >= 0 ? primary : 0;
                const onKey = (e: React.KeyboardEvent<HTMLDivElement>, i: number): void => {
                  const opts = Array.from(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
                  const focusAt = (j: number): void => { const el = opts[Math.max(0, Math.min(opts.length - 1, j))]; el?.focus(); };
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
                    e.preventDefault();
                    const j = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : opts.length - 1;
                    focusAt(j);
                    if (e.shiftKey) toggleEl(col.key, Math.max(0, Math.min(list.length - 1, j))); // extend
                  } else if (e.key === ' ') { e.preventDefault(); toggleEl(col.key, i); }
                  else if (e.key === 'Enter') { e.preventDefault(); selectEl(col.key, i); }
                };
                return (
                  <div key={col.key}>
                    <h2 className="cv-editor__panel-title">{col.label ?? tt(`col_${col.key}`)}</h2>
                    {list.length === 0 ? (
                      <p className="cv-editor__empty">{t('emptyCollection')}</p>
                    ) : (
                      <ul className="cv-editor__tree" role="listbox" aria-multiselectable="true" aria-label={col.label ?? tt(`col_${col.key}`)}>
                        {list.map((el, i) => (
                          <li key={i} role="none" className={col.chrome ? 'cv-editor__el-li' : undefined}>
                            <div
                              role="option"
                              tabIndex={i === rove ? 0 : -1}
                              aria-selected={isSelected(col.key, i)}
                              className={`cv-editor__tree-row${isSelected(col.key, i) ? ' is-sel' : ''}${el.hidden === true ? ' is-hidden-el' : ''}`}
                              onClick={(e) => (e.shiftKey ? toggleEl(col.key, i) : selectEl(col.key, i))}
                              onKeyDown={(e) => onKey(e, i)}
                            >
                              {typeof el.name === 'string' && el.name ? el.name : col.labelFor(el, ttFn)}
                              {/* ADR 0359 D5 — who has this element selected. */}
                              {peersOnElement(col.key, i).length > 0 ? (
                                <span className="cv-presence__rowmark" title={peersOnElement(col.key, i).map((p) => p.name).join(', ')}>
                                  {peersOnElement(col.key, i).slice(0, 3).map((p) => (
                                    <Avatar key={p.clientId} name={p.name} hueKey={p.name} size={14} alt={t('selectedBy', { name: p.name })} />
                                  ))}
                                </span>
                              ) : null}
                            </div>
                            {/* ADR 0333 Phase 3 — element chrome: lock/hide
                                toggles live on the LIST (the management
                                surface; the gesture seams enforce locked). */}
                            {col.chrome ? (
                              // Pointer sugar — the property panel is the
                              // canonical (keyboard/AT) chrome surface. Stable
                              // accessible names; state rides aria-pressed.
                              <span className="cv-editor__el-chrome">
                                <Button
                                  variant="quiet" size="sm"
                                  aria-pressed={el.locked === true}
                                  onClick={() => editDoc((d) => { const t2 = readElements(d, col.key)[i]; if (t2) { if (t2.locked === true) delete t2.locked; else t2.locked = true; } })}
                                  title={el.locked === true ? t('unlockElement') : t('lockElement')}
                                  aria-label={t('lockElement')}
                                >
                                  {el.locked === true ? <LockIcon size={12} /> : <UnlockIcon size={12} />}
                                </Button>
                                <Button
                                  variant="quiet" size="sm"
                                  aria-pressed={el.hidden === true}
                                  onClick={() => editDoc((d) => { const t2 = readElements(d, col.key)[i]; if (t2) { if (t2.hidden === true) delete t2.hidden; else t2.hidden = true; } })}
                                  title={el.hidden === true ? t('showElement') : t('hideElement')}
                                  aria-label={t('hideElement')}
                                >
                                  {el.hidden === true ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
                                </Button>
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </main>

        {/* Right — the property panel: catalog-driven for the selected tree
            node, the ACTIVE FRAME's own fields (fixed-schema frames types,
            ADR 0310 Phase B), or the selected ELEMENT / doc-level fields
            (elements types, Phase C). */}
        <RailAside
          side="r"
          collapsed={rails.r.collapsed}
          className="cv-editor__props"
          label={t('properties')}
          expandLabel={t('expandProps')}
          collapseLabel={t('collapseProps')}
          onToggle={() => toggleRail('r')}
        >
          <h2 className="cv-editor__panel-title">{t('properties')}</h2>
          {graphDef && graphView && selEdge && graphDef.edgePropDefs ? (
            // Audit gap #1 — the selected connection's fields (the same catalog-
            // driven panel idiom as elements/frames; PropertyField built-ins only).
            <div className="cv-editor__prop-form">
              <div className="cv-editor__prop-type">{t('graphEdgeHeading', {
                from: graphDef.nodes(doc).find((n) => n.id === selEdge.from)?.label ?? selEdge.from,
                to: graphDef.nodes(doc).find((n) => n.id === selEdge.to)?.label ?? selEdge.to,
              })}</div>
              {graphDef.edgePropDefs.map((p) => (
                <PropertyField
                  tt={tt}
                  key={p.name}
                  def={p}
                  value={((selEdge.data ?? {}) as Record<string, unknown>)[p.name]}
                  widgets={def.propertyWidgets}
                  docState={dict(doc)} orgId={orgId ?? ''}
                  frames={frames}
                  onChange={(name, v) => updateGraphEdge(selEdge.id, { [name]: v })}
                  onChangeText={(name, v) => updateGraphEdgeText(selEdge.id, { [name]: v })}
                />
              ))}
              <Button
                variant="secondary" size="sm" className="cv-editor__delete cv-editor__delete--danger"
                onClick={() => { deleteGraphEdge(selEdge.id); setAnnounce(t('graphDeletedEdge')); }}
              >
                {t('graphDeleteEdge')}
              </Button>
            </div>
          ) : elementsDef ? (
            selEl && selCol && selElData ? (
              <div className="cv-editor__prop-form">
                <div className="cv-editor__prop-type">{selCol.labelFor(selElData, ttFn)}</div>
                {/* ADR 0333 Phase 3 — element chrome fields: the CANONICAL
                    keyboard/AT surface for name/lock/hide (the list buttons are
                    pointer sugar; the ux-review a11y ruling). */}
                {selCol.chrome ? (
                  <>
                    <label className="cv-editor__field">
                      <span className="cv-editor__field-label">{t('elementName')}</span>
                      <input
                        className="cv-editor__input"
                        value={typeof selElData.name === 'string' ? selElData.name : ''}
                        maxLength={80}
                        onChange={(e) => setElFieldText('name', e.target.value || undefined)}
                      />
                    </label>
                    <label className="cv-editor__chrome-check">
                      <input
                        type="checkbox"
                        checked={selElData.locked === true}
                        onChange={(e) => setElField('locked', e.target.checked ? true : undefined)}
                      />
                      {t('lockElement')}
                    </label>
                    <label className="cv-editor__chrome-check">
                      <input
                        type="checkbox"
                        checked={selElData.hidden === true}
                        onChange={(e) => setElField('hidden', e.target.checked ? true : undefined)}
                      />
                      {t('hideElement')}
                    </label>
                  </>
                ) : null}
                {/* Keyboard-equivalent arrange actions (the PR-457 a11y pattern).
                    Bring/send extremes (ADR 0333 Phase 2) — array order = paint
                    order; ⌘]/⌘[ step overlap-aware via the shortcut registry. */}
                <div className="cv-editor__arrange" role="group" aria-label={t('arrange')}>
                  <Button variant="secondary" size="sm" disabled={selEl.idx <= 0} onClick={() => moveElementSel(-1)} title={t('moveUp')} aria-label={t('moveUp')}><ArrowUpIcon size={13} /></Button>
                  <Button variant="secondary" size="sm" disabled={selEl.idx >= readElements(doc, selEl.col).length - 1} onClick={() => moveElementSel(1)} title={t('moveDown')} aria-label={t('moveDown')}><ArrowDownIcon size={13} /></Button>
                  <Button variant="secondary" size="sm" disabled={selEl.idx >= readElements(doc, selEl.col).length - 1} onClick={() => reorderSel('front')} title={t('bringToFront')} aria-label={t('bringToFront')}><ArrowUpToLineIcon size={13} /></Button>
                  <Button variant="secondary" size="sm" disabled={selEl.idx <= 0} onClick={() => reorderSel('back')} title={t('sendToBack')} aria-label={t('sendToBack')}><ArrowDownToLineIcon size={13} /></Button>
                  <Button variant="secondary" size="sm" disabled={readElements(doc, selEl.col).length >= selCol.max} onClick={duplicateElementSel} title={t('duplicateComponent')} aria-label={t('duplicateComponent')}><CopyIcon size={13} /></Button>
                </div>
                {selCol.propDefs(selElData).map((p) => (
                  <PropertyField
                  tt={tt}
                    key={p.name}
                    def={p}
                    value={selElData[p.name]}
                    widgets={def.propertyWidgets}
                    docState={dict(doc)} orgId={orgId ?? ''}
                    frames={frames}
                    onChange={setElField}
                    onChangeText={setElFieldText}
                  />
                ))}
                <Button variant="secondary" size="sm" className="cv-editor__delete cv-editor__delete--danger" disabled={readElements(doc, selEl.col).length <= (selCol.min ?? 0)} onClick={deleteElementSel}>{t('deleteElement')}</Button>
              </div>
            ) : (
              <div className="cv-editor__prop-form">
                {/* Align / distribute over the multi-selection (ADR 0333
                    Phase 5) — the panel shows doc props at N≠1 (ADR 0317), so
                    the alignment actions ride here. Text buttons: keyboard-
                    native, no 8-icon vocabulary. */}
                {multiSel && multiSel.idxs.length > 1 && alignCol ? (
                  <div className="cv-editor__arrange cv-editor__arrange--wrap" role="group" aria-label={t('align')}>
                    {(['left', 'centerH', 'right', 'top', 'middle', 'bottom', 'distributeH', 'distributeV'] satisfies AlignOp[]).map((op) => (
                      <Button
                        key={op}
                        variant="secondary" size="sm"
                        disabled={op.startsWith('distribute') && multiSel.idxs.length < 3}
                        onClick={() => alignSel(op)}
                      >
                        {t(`align_${op}`)}
                      </Button>
                    ))}
                  </div>
                ) : null}
                {(def.docPropDefs ?? []).map((p) => (
                  <PropertyField
                  tt={tt}
                    key={p.name}
                    def={p}
                    value={dict(doc)[p.name]}
                    widgets={def.propertyWidgets}
                    docState={dict(doc)} orgId={orgId ?? ''}
                    frames={frames}
                    onChange={setDocProp}
                    onChangeText={setDocPropText}
                  />
                ))}
                <p className="cv-editor__empty">{t('selectElementHint')}</p>
              </div>
            )
          ) : !treeActive && frame && framesDef ? (
            <div className="cv-editor__prop-form">
              {(framesDef.propDefs?.(frame) ?? []).map((p) => (
                <PropertyField
                  tt={tt}
                  key={p.name}
                  def={p}
                  value={dict(frame)[p.name]}
                  widgets={def.propertyWidgets}
                  docState={dict(doc)} orgId={orgId ?? ''}
                  frames={frames}
                  onChange={setFrameProp}
                  onChangeText={setFramePropText}
                />
              ))}
            </div>
          ) : selNode && selDef && selPath ? (
            <div className="cv-editor__prop-form">
              <div className="cv-editor__prop-type">{selDef.label}</div>
              {/* ADR 0344 2b — authoring traits. Locked disables every gesture
                  below; the flag toggles themselves stay live (unlock path). */}
              <div className="cv-editor__node-flags" role="group" aria-label={t('nodeFlags')}>
                <label className="cv-editor__flag"><input type="checkbox" checked={Boolean(selNode.hidden)} onChange={(e) => setNodeFlag('hidden', e.target.checked)} /> {t('nodeHidden')}</label>
                <label className="cv-editor__flag"><input type="checkbox" checked={Boolean(selNode.locked)} onChange={(e) => setNodeFlag('locked', e.target.checked)} /> {t('nodeLocked')}</label>
              </div>
              {/* Keyboard-equivalent arrange actions (the PR-457 a11y pattern). */}
              <div className="cv-editor__arrange" role="group" aria-label={t('arrange')}>
                <Button variant="secondary" size="sm" disabled={selLocked || selIdx <= 0} onClick={() => moveSelected('up')} title={t('moveUp')} aria-label={t('moveUp')}><ArrowUpIcon size={13} /></Button>
                <Button variant="secondary" size="sm" disabled={selLocked || selIdx >= selSiblings - 1} onClick={() => moveSelected('down')} title={t('moveDown')} aria-label={t('moveDown')}><ArrowDownIcon size={13} /></Button>
                <Button variant="secondary" size="sm" disabled={selLocked || selPath.length < 2} onClick={() => moveSelected('out')}>{t('moveOut')}</Button>
                <Button variant="secondary" size="sm" disabled={selLocked || !adjacentContainer} onClick={() => moveSelected('in')} title={adjacentContainer ? t('moveInHint', { container: adjacentContainer.label }) : undefined}>{t('moveIn')}</Button>
                <Button variant="secondary" size="sm" onClick={duplicateSelected} title={t('duplicateComponent')} aria-label={t('duplicateComponent')}><CopyIcon size={13} /></Button>
                {/* Audit gap #3 / ADR 0344 2a — copy here, switch frame (or canvas), paste there. */}
                <Button variant="secondary" size="sm" onClick={copySelected}>{t('copyComponent')}</Button>
                <Button variant="secondary" size="sm" disabled={selLocked} onClick={cutSelected}>{t('cutComponent')}</Button>
                <Button variant="secondary" size="sm" disabled={!treeClipboard} onClick={pasteClipboard} title={treeClipboard ? t('pasteComponentHint', { type: treeClipboard.type }) : undefined}>{t('pasteComponent')}</Button>
                <Button variant="secondary" size="sm" disabled={!selStyleProps || Object.keys(selStyleProps).length === 0} onClick={copyStyleSelected}>{t('copyStyle')}</Button>
                <Button variant="secondary" size="sm" disabled={selLocked || !styleClipboard} onClick={pasteStyleSelected} title={styleClipboard ? t('pasteStyleHint', { type: styleClipboard.sourceType }) : undefined}>{t('pasteStyle')}</Button>
              </div>
              <fieldset className="cv-editor__prop-fields" disabled={selLocked}>
              {(selDef.props ?? []).map((p) => (
                <PropertyField
                  tt={tt}
                  key={p.name}
                  def={p}
                  value={selNode.props?.[p.name]}
                  widgets={def.propertyWidgets}
                  docState={dict(doc)} orgId={orgId ?? ''}
                  frames={frames}
                  onChange={setProp}
                  onChangeText={setPropText}
                />
              ))}
              </fieldset>
              <Button variant="secondary" size="sm" className="cv-editor__delete cv-editor__delete--danger" disabled={selLocked} onClick={deleteSelected}>{t('deleteComponent')}</Button>
            </div>
          ) : (
            <div className="cv-editor__prop-form">
              <p className="cv-editor__empty">{t('selectHint')}</p>
              {/* Audit gap #3 — with nothing selected, paste lands at the frame
                  root, so a copied subtree reaches an EMPTY target screen. */}
              {treeActive && treeClipboard ? (
                <Button variant="secondary" size="sm" onClick={pasteClipboard} title={t('pasteComponentHint', { type: treeClipboard.type })}>{t('pasteComponent')}</Button>
              ) : null}
            </div>
          )}
        </RailAside>
      </div>
      {/* §7.2.5 / CV-12 — the speaker-notes drawer (trait-gated: frames +
          present). A TYPE-PAYLOAD bottom drawer, not a permanent bar; edits
          commit on blur (the DEF-6 text contract — one undo step per blur). */}
      {framesDef && def.present && frame ? (
        <NotesDrawer
          key={frame.id /* grade-pass LOW-6: a frame switch resets the draft */}
          typeId={def.canvasTypeId}
          frameName={frame.name || ''}
          value={(() => { const v = dict(frame)[def.present.notesKey ?? 'notes']; return typeof v === 'string' ? v : ''; })()}
          onCommit={(v) => {
            const key = def.present?.notesKey ?? 'notes';
            editFrame((f) => setFieldOn(f, key, v || undefined));
            setAnnounce(t('annNotesSaved'));
          }}
        />
      ) : null}
      <CanvasWorkbenchStatus label={t('workspaceStatus')} className="cv-editor__statusbar">
        <span className="cv-workbench__status-mode">{workspaceStatus}</span>
        <span>{t('version', { n: version })}</span>
        {selectionSummary ? <span>{selectionSummary}</span> : null}
        <span className="cv-workbench__status-spacer" aria-hidden="true" />
        <span>{t('shortcutsTitle')} <kbd>?</kbd></span>
        <span>{t('shortcutToggleLeftRail')} <kbd>[</kbd></span>
        <span>{t('shortcutToggleRightRail')} <kbd>]</kbd></span>
      </CanvasWorkbenchStatus>
    </CanvasWorkbench>
  );
}

/** §7.2.5 / CV-12 — the chassis speaker-notes drawer: collapsed summary strip
 *  → a labeled textarea over the ACTIVE frame's notes field. Open state
 *  persists per canvas type; drafts commit on blur (one undo step). */
function NotesDrawer({ typeId, frameName, value, onCommit }: {
  typeId: string;
  frameName: string;
  value: string;
  onCommit: (v: string) => void;
}): JSX.Element {
  const { t } = useTranslation('canvas');
  const storageKey = `owp.cv.notes:${typeId}`;
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });
  const [draft, setDraft] = useState<string | null>(null);
  const toggle = (): void => {
    setOpen((v) => {
      try { localStorage.setItem(storageKey, v ? '0' : '1'); } catch { /* private mode */ }
      return !v;
    });
  };
  return (
    <section className="cv-notes-drawer" aria-label={t('notesDrawerLabel')}>
      <button type="button" className="cv-notes-drawer__head u-button-bare" aria-expanded={open} onClick={toggle}>
        <span className="cv-notes-drawer__title">{t('notesDrawerTitle')}</span>
        <span className="cv-notes-drawer__hint">
          {open ? frameName : (value ? `${value.slice(0, 80)}${value.length > 80 ? '\u2026' : ''}` : t('notesDrawerEmpty'))}
        </span>
        {open ? <ChevronDownIcon size={14} aria-hidden /> : <ChevronUpIcon size={14} aria-hidden />}
      </button>
      {open ? (
        <textarea
          className="cv-notes-drawer__input"
          aria-label={t('notesDrawerTitle')}
          placeholder={t('notesDrawerPlaceholder')}
          value={draft ?? value}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { if (draft !== null && draft !== value) onCommit(draft); setDraft(null); }}
        />
      ) : null}
    </section>
  );
}
