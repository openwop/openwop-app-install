/**
 * CanvasSurfaceShell (ADR 0361 Phase 1) — the shell-chrome COMPOSITION for
 * ENGINE-BACKED editors: types whose center owns its own model, undo, and
 * persistence (the workflow builder's zustand/xyflow engine), so none of
 * `CanvasEditorPage`'s document lifecycle (load/save/CAS/version/share)
 * applies. The chassis owns the CHROME — rails, shortcuts, ⌘K, announcer,
 * zoom slot — while the consumer supplies CONTENT ONLY (bar, rail bodies,
 * center, tail) plus its type verbs.
 *
 * ADR 0365: the chrome BEHAVIOR lives in the shared blocks —
 * `useSurfaceChrome` (announcer / registry keydown owner / ⌘K projection /
 * zoom slot) and `RailAside` — consumed by BOTH this composition and
 * `CanvasEditorPage`. The two compositions are an accepted, documented split
 * (engine lifecycle vs doc lifecycle).
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { mergeShortcuts, type ShortcutDef } from './shortcuts.js';
import { ShortcutsOverlay } from './ShortcutsOverlay.js';
import { useRailLayout, RAIL_COLLAPSED_W, type RailSide } from './useRailLayout.js';
import { RailSeparator } from './RailSeparator.js';
import { RailAside } from './RailAside.js';
import { ViewportHandleContext } from './viewportHandle.js';
import { useSurfaceChrome } from './useSurfaceChrome.js';
import { CanvasWorkbench, CanvasWorkbenchStatus } from './CanvasWorkbench.js';

/** What the shell hands its consumer's content/verbs. */
export interface SurfaceShellCtx {
  /** The shell's live-region sink (rail toggles announce automatically). */
  announce: (message: string) => void;
}

/** One rail's content + pre-translated labels (the consumer owns its i18n
 *  namespace; the shell never guesses keys). */
export interface SurfaceRailConfig {
  content: ReactNode;
  /** aside className (keeps the consumer's existing CSS, e.g. `builder-rail`). */
  className: string;
  label: string;
  expandLabel: string;
  collapseLabel: string;
  resizeLabel: string;
  announceCollapsed: string;
  announceExpanded: string;
  defaultW: number;
}

export interface SurfaceShellConfig {
  /** Persists rail layout AND names the ⌘K command source. MUST stay stable
   *  across restructurings (users' saved layouts key on it) — the builder
   *  keeps `'workflow-builder'`. */
  storageKey: string;
  /** Root + columns classNames (the consumer's existing chrome CSS). */
  shellClassName: string;
  colsClassName: string;
  /** Toolbar row(s) + any banners/drawers that sit above the columns. */
  bar: (ctx: SurfaceShellCtx) => ReactNode;
  railL: SurfaceRailConfig;
  railR: SurfaceRailConfig;
  /** The engine surface (consumer wraps it in its own ErrorBoundary). */
  center: ReactNode;
  /** Below-the-columns chrome (the builder's RunDrawer). */
  tail?: ReactNode;
  /** The type's verbs, merged into the shell's view registry. `group: 'type'`
   *  entries label from `typeT`; general/view entries label from the canvas ns. */
  typeShortcuts?: (ctx: SurfaceShellCtx) => ShortcutDef[];
  /** The consumer's translator for `group: 'type'` labels (overlay + ⌘K). */
  typeT: (key: string) => string;
  /** ⌘K group heading for the projected commands. */
  commandsGroupLabel: string;
}

export function CanvasSurfaceShell({ config }: { config: SurfaceShellConfig }): JSX.Element {
  const { t: tc } = useTranslation('canvas');
  const { storageKey, railL, railR } = config;

  // ADR 0365 — the shared chrome-behavior blocks (one owner with the page).
  const chrome = useSurfaceChrome({
    commandSourceKey: storageKey,
    commandIdPrefix: storageKey,
    commandsGroupLabel: config.commandsGroupLabel,
    typeT: config.typeT,
    canvasT: tc,
  });
  const { setAnnounce, setShortcutsOpen, viewportSlot, viewportSlotApi } = chrome;
  const ctx = useMemo<SurfaceShellCtx>(() => ({ announce: setAnnounce }), [setAnnounce]);

  // §7.2 / CV-1 — rail geometry (resizable + collapsible, persisted).
  const rails = useRailLayout(storageKey, {
    l: { w: railL.defaultW, collapsed: false },
    r: { w: railR.defaultW, collapsed: false },
  });
  const railVars = {
    '--cv-rail-l': `${rails.l.collapsed ? RAIL_COLLAPSED_W : rails.l.w}px`,
    '--cv-rail-r': `${rails.r.collapsed ? RAIL_COLLAPSED_W : rails.r.w}px`,
  } as React.CSSProperties;

  const toggleRail = useCallback((side: RailSide) => {
    const cfg = side === 'l' ? railL : railR;
    const willCollapse = !(side === 'l' ? rails.l.collapsed : rails.r.collapsed);
    rails.toggle(side);
    setAnnounce(willCollapse ? cfg.announceCollapsed : cfg.announceExpanded);
  }, [rails, railL, railR, setAnnounce]);

  // The shell's view entries + the consumer's type verbs, committed to the
  // shared keydown owner + ⌘K projection.
  const shortcuts = mergeShortcuts([
    { combo: '?', labelKey: 'shortcutsTitle', group: 'general', run: () => setShortcutsOpen((v) => !v) },
    { combo: 'shift+1', labelKey: 'zoomToFit', group: 'view', enabled: () => viewportSlot.current != null, run: () => viewportSlot.current?.fit() },
    { combo: 'shift+2', labelKey: 'zoomToSelection', group: 'view', enabled: () => viewportSlot.current?.zoomToSelection != null, run: () => viewportSlot.current?.zoomToSelection?.() },
    { combo: 'shift+0', labelKey: 'zoom100', group: 'view', enabled: () => viewportSlot.current != null, run: () => viewportSlot.current?.zoomToPercent(100) },
    { combo: '[', labelKey: 'shortcutToggleLeftRail', group: 'view', run: () => toggleRail('l') },
    { combo: ']', labelKey: 'shortcutToggleRightRail', group: 'view', run: () => toggleRail('r') },
  ], config.typeShortcuts?.(ctx) ?? []);
  chrome.commitShortcuts(shortcuts);

  const railAside = (side: RailSide, cfg: SurfaceRailConfig): JSX.Element => (
    <RailAside
      side={side}
      collapsed={side === 'l' ? rails.l.collapsed : rails.r.collapsed}
      className={cfg.className}
      label={cfg.label}
      expandLabel={cfg.expandLabel}
      collapseLabel={cfg.collapseLabel}
      onToggle={() => toggleRail(side)}
    >
      {cfg.content}
    </RailAside>
  );

  return (
    <CanvasWorkbench className={config.shellClassName}>
      {config.bar(ctx)}
      {/* §7.8 — the shell live region (rail toggles, consumer verbs). */}
      <div className="sr-only" role="status" aria-live="polite">{chrome.announce}</div>
      <ViewportHandleContext.Provider value={viewportSlotApi}>
        <div className={config.colsClassName} style={railVars}>
          {railAside('l', railL)}
          {!rails.l.collapsed ? (
            <RailSeparator side="l" value={rails.l.w} label={railL.resizeLabel} onResize={(w) => rails.resize('l', w)} />
          ) : null}
          {!rails.r.collapsed ? (
            <RailSeparator side="r" value={rails.r.w} label={railR.resizeLabel} onResize={(w) => rails.resize('r', w)} />
          ) : null}
          {config.center}
          {railAside('r', railR)}
        </div>
      </ViewportHandleContext.Provider>
      {config.tail}
      {/* ADR 0739 — engine-backed canvases get the same stable bottom context
          region as document-backed canvases. These shortcuts are truthful for
          every surface this shell mounts; type-specific state stays in tail. */}
      <CanvasWorkbenchStatus label={tc('workspaceStatus')} className="cv-workbench__status--surface">
        <span>{tc('shortcutsTitle')} <kbd>?</kbd></span>
        <span>{tc('shortcutToggleLeftRail')} <kbd>[</kbd></span>
        <span>{tc('shortcutToggleRightRail')} <kbd>]</kbd></span>
      </CanvasWorkbenchStatus>
      {chrome.shortcutsOpen ? (
        <ShortcutsOverlay shortcuts={shortcuts} typeT={config.typeT} onClose={() => setShortcutsOpen(false)} />
      ) : null}
    </CanvasWorkbench>
  );
}
