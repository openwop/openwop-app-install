/**
 * Canvas framework — the interactive multi-frame viewer (ADR 0310, extracted
 * from the app-builder's AppBuilderInteractiveViewer / ADR 0305 Phase D).
 * Renders ONE frame at a time through the type's shared read-mode Renderer and
 * makes tap-through actions REAL: the renderer stamps `data-cv-nav` on
 * actionable elements, and this component's delegated click handler switches
 * the active frame. A frame-tab strip is the always-available (and
 * keyboard-accessible) navigation fallback.
 *
 * ADR 0345 3b — an optional TYPE-supplied `runtime` upgrades the tap-through
 * into an application simulator: the CHASSIS owns the mechanics (an ephemeral
 * per-mount variable store initialized from the document and reset with it, a
 * frame-as-modal overlay, and the delegated `data-cv-act` click), while the
 * TYPE owns the semantics (what its closed action kinds mean). Deterministic —
 * no eval, no persistence, no globals.
 *
 * Feature-agnostic on purpose: consumed by the type's preview page AND the
 * public shared view. Chrome (device frames, theme toggle, fullscreen) is the
 * consumer's job; label strings arrive as props so this stays namespace-free.
 */
import { Button } from '../ui/Button.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { ACT_ATTR, NAV_ATTR, STATE_ATTR } from './dnd.js';

interface ViewerFrame { id: string; name: string; [k: string]: unknown }

/** What a type's action semantics may do — the whole capability surface.
 *  Anything not here (network, storage, eval) is not expressible. */
export interface PreviewRuntimeCtx {
  navigate: (to: string) => void;
  getVar: (name: string) => unknown;
  setVar: (name: string, value: unknown) => void;
  openModal: (frameId: string) => void;
  closeModal: () => void;
  /** Appends to the (capped) diagnostics trace — the 3c drawer's feed. */
  trace: (line: string) => void;
}

/** ADR 0345 3c — a designed-state switch the diagnostics drawer offers
 *  (e.g. force an operation's result to ok/error/empty). */
export interface PreviewSimulation {
  id: string;
  label: string;
  mode: 'ok' | 'error' | 'empty';
  apply: (ctx: PreviewRuntimeCtx) => void;
}

/** The type-supplied runtime semantics (ADR 0345 3b). */
export interface PreviewRuntime {
  /** Initial variable values derived from the document (state facet). */
  initialVars: (doc: Record<string, unknown>) => Record<string, unknown>;
  /** Run the actions stamped at `actPath` on the frame `frameId`. */
  onAct: (doc: Record<string, unknown>, frameId: string, actPath: string, event: 'click' | 'change' | 'submit', ctx: PreviewRuntimeCtx) => void;
  /** ADR 0345 3c — designed-state switches for the diagnostics drawer. */
  simulations?: (doc: Record<string, unknown>) => PreviewSimulation[];
}

/** The Renderer contract (widened by ADR 0345 3b — both extras optional, so
 *  every existing type renderer remains conformant). */
export type ViewerRenderer = ComponentType<{
  content: string;
  editPaths?: boolean;
  /** Live preview variables for binding resolution (`state.*` paths). */
  runtimeState?: Record<string, unknown>;
  /** Stamp `data-cv-act` on action-bearing nodes (runtime mode only). */
  actPaths?: boolean;
}>;

const TRACE_CAP = 100;

export function InteractiveViewer({ doc, framesKey = 'screens', homeFlag = 'isInitial', Renderer, themeOverride, noFramesText, framesLabel, transitionFor, thumbnails, runtime, modalCloseText, onTrace, diagnostics }: {
  /** The parsed canvas document (already validated server-side). */
  doc: Record<string, unknown>;
  /** The doc key holding the frame array (the type's frames-trait key). */
  framesKey?: string;
  /** The single-home flag field ('' when the type has none). */
  homeFlag?: string;
  Renderer: ViewerRenderer;
  /** Client-side theme swap for the preview's light/dark toggle — never persisted. */
  themeOverride?: 'light' | 'dark';
  noFramesText: string;
  framesLabel: string;
  /** Audit gap #4 — the transition to play navigating from→to (a connector's
   *  `transition`); undefined/'none' = instant swap (the prior behavior). */
  transitionFor?: ((fromId: string, toId: string) => string | undefined) | undefined;
  /** Audit polish P1 — render a mini preview inside each frame tab (the shared
   *  Renderer, aria-hidden decorative; capped at the first 20 frames). */
  thumbnails?: boolean;
  /** ADR 0345 3b — the type's action/state semantics; absent = plain tap-through. */
  runtime?: PreviewRuntime;
  /** Accessible label for the modal-overlay close button (namespace-free rule). */
  modalCloseText?: string;
  /** ADR 0345 3c seam — observe trace lines (the diagnostics drawer's feed). */
  onTrace?: (line: string) => void;
  /** ADR 0345 3c — render the diagnostics drawer (trace + simulation switches).
   *  Labels arrive as props (the namespace-free rule). */
  diagnostics?: { label: string; emptyText: string; modeLabels: Record<'ok' | 'error' | 'empty', string> };
}): JSX.Element {
  const rawFrames = doc[framesKey];
  const frames = useMemo(
    () => (Array.isArray(rawFrames) ? (rawFrames as ViewerFrame[]).filter((s) => s && typeof s.id === 'string') : []),
    [rawFrames],
  );
  const initialId = (homeFlag ? frames.find((s) => s[homeFlag] === true)?.id : undefined) ?? frames[0]?.id ?? '';
  const [activeId, setActiveId] = useState(initialId);
  // Grade pass (code F17): a replaced `doc` prop (e.g. a shared page refresh)
  // re-anchors to its own initial frame instead of pinning the first render's.
  useEffect(() => { setActiveId(initialId); }, [initialId]);
  const active = frames.find((s) => s.id === activeId) ?? frames[0];

  // ADR 0345 3b — the ephemeral preview state: derived from THIS document,
  // reset whenever the document identity changes (a version restore or share
  // refresh starts a fresh session). Never persisted, never global.
  const [vars, setVars] = useState<Record<string, unknown>>(() => runtime?.initialVars(doc) ?? {});
  const [modalId, setModalId] = useState<string | null>(null);
  useEffect(() => { setVars(runtime?.initialVars(doc) ?? {}); setModalId(null); setTrace([]); }, [doc, runtime]);
  const [trace, setTrace] = useState<string[]>([]);

  // Audit gap #4 — a keyed animation per navigation: the inner frame remounts
  // (the key) with a transition class; CSS turns it off under reduced motion.
  const TRANSITIONS = ['push', 'replace', 'modal', 'fade', 'slide'];
  const [anim, setAnim] = useState<{ key: number; kind: string } | null>(null);
  const navigate = (to: string, from?: string): void => {
    const kind = from && from !== to && transitionFor ? transitionFor(from, to) : undefined;
    setActiveId(to);
    setModalId(null); // navigating away dismisses a frame-modal
    if (kind && TRANSITIONS.includes(kind)) setAnim((a) => ({ key: (a?.key ?? 0) + 1, kind }));
  };

  // A plain per-render object (grade pass AB-CODE-F2): handlers created this
  // render close over it, so it is exactly as fresh as they are — and building
  // it is pure, unlike the previous render-phase ref write (impure under
  // concurrent React; the same rule CanvasEditorPage documents for keydown).
  const ctx: PreviewRuntimeCtx = {
    navigate: (to) => { if (frames.some((s) => s.id === to)) navigate(to, active?.id); },
    getVar: (name) => vars[name],
    setVar: (name, value) => setVars((v) => ({ ...v, [name]: value })),
    openModal: (frameId) => { if (frames.some((s) => s.id === frameId)) setModalId(frameId); },
    closeModal: () => setModalId(null),
    trace: (line) => {
      setTrace((t) => [...t.slice(-(TRACE_CAP - 1)), line]);
      onTrace?.(line);
    },
  };

  // Frame-as-modal focus contract (grade pass AB-UX-1): `aria-modal` must be
  // TRUE for AT — initial focus moves to the Close button, Tab cycles inside
  // the sheet, Escape dismisses, and focus returns to the invoking element.
  const modalSheetRef = useRef<HTMLDivElement | null>(null);
  const modalCloseRef = useRef<HTMLButtonElement | null>(null);
  const modalReturnRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!modalId) return;
    modalReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalCloseRef.current?.focus();
    return () => { modalReturnRef.current?.focus(); modalReturnRef.current = null; };
  }, [modalId]);
  const onModalKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { e.stopPropagation(); setModalId(null); return; }
    if (e.key !== 'Tab' || !modalSheetRef.current) return;
    const focusables = modalSheetRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables.length) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  // Single-frame doc for the shared renderer; theme overridden client-side only.
  const content = useMemo(() => JSON.stringify({
    ...doc,
    ...(themeOverride ? { theme: themeOverride } : {}),
    [framesKey]: active ? [active] : [],
  }), [doc, framesKey, active, themeOverride]);
  const modalFrame = modalId ? frames.find((s) => s.id === modalId) : undefined;
  const modalContent = useMemo(() => (modalFrame ? JSON.stringify({
    ...doc,
    ...(themeOverride ? { theme: themeOverride } : {}),
    [framesKey]: [modalFrame],
  }) : null), [doc, framesKey, modalFrame, themeOverride]);
  const rt = runtime ? { runtimeState: vars, actPaths: true } : {};

  // Audit polish P1 — swipe navigation: a POINTER ENHANCEMENT over the tab
  // strip (the first-class keyboard/AT path). Horizontal intent only (|dx|>48
  // and |dx|>2|dy|), never from a tap target ([data-cv-nav]/[data-cv-act]) —
  // so delegated taps and vertical scrolling are unaffected.
  const swipe = useRef<{ x: number; y: number; nav: boolean } | null>(null);
  const onStagePointerDown = (e: React.PointerEvent): void => {
    const t = e.target as HTMLElement | null;
    const onNav = Boolean(t?.closest?.(`[${NAV_ATTR}]`) || t?.closest?.(`[${ACT_ATTR}]`));
    swipe.current = { x: e.clientX, y: e.clientY, nav: onNav };
  };
  const onStagePointerUp = (e: React.PointerEvent): void => {
    const st = swipe.current;
    swipe.current = null;
    if (!st || st.nav || !active) return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    if (Math.abs(dx) <= 48 || Math.abs(dx) <= 2 * Math.abs(dy)) return;
    const idx = frames.findIndex((s) => s.id === active.id);
    const next = frames[dx < 0 ? idx + 1 : idx - 1];
    if (next) { setActiveId(next.id); setAnim((a) => ({ key: (a?.key ?? 0) + 1, kind: 'slide' })); }
  };

  // Audit polish P1 — per-tab thumbnail contents (the SAME single-frame doc the
  // stage renders), memoized per doc/frames; capped so a 60-screen app doesn't
  // mount 60 mini-renders.
  const THUMB_CAP = 20;
  const thumbContents = useMemo(() => {
    if (!thumbnails) return null;
    const m = new Map<string, string>();
    for (const f of frames.slice(0, THUMB_CAP)) m.set(f.id, JSON.stringify({ ...doc, [framesKey]: [f] }));
    return m;
  }, [thumbnails, frames, doc, framesKey]);

  const onNavClick = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    // ADR 0345 3b — action-stamped elements win over plain nav stamps; the
    // TYPE's runtime interprets its own closed kinds through the ctx.
    if (runtime) {
      const actEl = target?.closest?.(`[${ACT_ATTR}]`);
      const actPath = actEl?.getAttribute(ACT_ATTR);
      const frameId = modalId ?? active?.id;
      if (actPath && frameId) {
        e.preventDefault();
        runtime.onAct(doc, frameId, actPath, 'click', ctx);
        return;
      }
    }
    const el = target?.closest?.(`[${NAV_ATTR}]`);
    const to = el?.getAttribute(NAV_ATTR);
    if (to && frames.some((s) => s.id === to)) {
      e.preventDefault();
      navigate(to, active?.id);
    }
  };

  /**
   * Native inputs own their own accessible keyboard/pointer behavior. This is
   * deliberately delegated only for the state bridge: a renderer must stamp a
   * declared `state.<id>` binding before a transient preview value can change.
   * No document mutation, network call, or arbitrary property write is possible.
   */
  const onStageInput = (e: React.FormEvent<HTMLDivElement>): void => {
    if (!runtime) return;
    const target = e.target as HTMLElement | null;
    const stateName = target?.getAttribute?.(STATE_ATTR);
    if (stateName) {
      let value: unknown;
      if (target instanceof HTMLInputElement) {
        value = target.type === 'checkbox' ? target.checked : target.type === 'number' || target.type === 'range' ? Number(target.value) : target.value;
      } else if (target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
        value = target.value;
      } else {
        return;
      }
      ctx.setVar(stateName, value);
    }
    const actEl = target?.closest?.(`[${ACT_ATTR}]`);
    const actPath = actEl?.getAttribute(ACT_ATTR);
    const frameId = modalId ?? active?.id;
    if (actPath && frameId) runtime.onAct(doc, frameId, actPath, 'change', ctx);
  };

  const onStageSubmit = (e: React.FormEvent<HTMLDivElement>): void => {
    e.preventDefault();
    if (!runtime) return;
    const target = e.target as HTMLElement | null;
    const actEl = target?.closest?.(`[${ACT_ATTR}]`);
    const actPath = actEl?.getAttribute(ACT_ATTR);
    const frameId = modalId ?? active?.id;
    if (actPath && frameId) runtime.onAct(doc, frameId, actPath, 'submit', ctx);
  };

  if (!frames.length) return <p className="muted">{noFramesText}</p>;

  return (
    <div className="cv-viewer">
      <nav className="cv-viewer__screens" role="tablist" aria-label={framesLabel}>
        {frames.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`cv-viewer-tab-${s.id}`}
            aria-controls="cv-viewer-tabpanel"
            aria-selected={s.id === active?.id}
            tabIndex={s.id === active?.id ? 0 : -1}
            className={`cv-viewer__screen-tab${s.id === active?.id ? ' is-active' : ''}`}
            onClick={() => setActiveId(s.id)}
            onKeyDown={(e) => {
              // Arrow roving + Home/End (the ARIA tabs pattern — UX-CV-4).
              const idx = frames.findIndex((x) => x.id === active?.id);
              let next: number;
              if (e.key === 'ArrowRight') next = (idx + 1) % frames.length;
              else if (e.key === 'ArrowLeft') next = (idx - 1 + frames.length) % frames.length;
              else if (e.key === 'Home') next = 0;
              else if (e.key === 'End') next = frames.length - 1;
              else return;
              e.preventDefault();
              const id = frames[next]?.id;
              const el = e.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[next] as HTMLElement | undefined;
              if (id) { setActiveId(id); el?.focus(); }
            }}
          >
            {thumbContents?.has(s.id) ? (
              <span className="cv-viewer__thumb" aria-hidden>
                <span className="cv-viewer__thumb-scale"><Renderer content={thumbContents.get(s.id)!} /></span>
              </span>
            ) : null}
            {s.name}
          </button>
        ))}
      </nav>
      {/* Delegated tap-through: nav-stamped elements switch frames. The tab strip
          above is the first-class keyboard path for the same navigation. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
      <div className="cv-viewer__stage" role="tabpanel" id="cv-viewer-tabpanel" {...(active ? { 'aria-labelledby': `cv-viewer-tab-${active.id}` } : {})} onClick={onNavClick} onInput={onStageInput} onSubmit={onStageSubmit} onPointerDown={onStagePointerDown} onPointerUp={onStagePointerUp}>
        <div key={anim?.key ?? 0} className={`cv-viewer__framebox${anim ? ` cv-viewer__framebox--t-${anim.kind}` : ''}`}>
          <Renderer content={content} {...rt} />
        </div>
        {modalFrame && modalContent ? (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the dialog's keydown implements the ARIA modal contract (Escape + Tab trap)
          <div className="cv-viewer__modal" role="dialog" aria-modal="true" aria-label={modalFrame.name} onKeyDown={onModalKeyDown}>
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events -- backdrop dismiss is a pointer enhancement; the labeled Close button (and Escape) is the first-class path */}
            <div className="cv-viewer__modal-backdrop" onClick={() => setModalId(null)} />
            <div className="cv-viewer__modal-sheet" ref={modalSheetRef}>
              <Button ref={modalCloseRef} variant="quiet" size="sm" className="cv-viewer__modal-close" onClick={() => setModalId(null)}>
                {modalCloseText ?? 'Close'}
              </Button>
              <Renderer content={modalContent} {...rt} />
            </div>
          </div>
        ) : null}
      </div>
      {diagnostics && runtime ? (
        <details className="cv-viewer__diag">
          <summary>{diagnostics.label}</summary>
          {runtime.simulations ? (
            <div className="cv-viewer__diag-sims" role="group" aria-label={diagnostics.label}>
              {runtime.simulations(doc).map((sim) => (
                <Button key={sim.id} variant="quiet" size="sm" onClick={() => sim.apply(ctx)}>
                  {/* Mode as inline muted text, not a chip — a chip inside a button
                      reads as a second interactive element (grade pass AB-UX-7). */}
                  {sim.label} <span className="muted cv-viewer__diag-mode">({diagnostics.modeLabels[sim.mode]})</span>
                </Button>
              ))}
            </div>
          ) : null}
          {trace.length ? (
            <ol className="cv-viewer__diag-trace">
              {trace.map((line, i) => <li key={i}>{line}</li>)}
            </ol>
          ) : <p className="muted">{diagnostics.emptyText}</p>}
        </details>
      ) : null}
    </div>
  );
}
