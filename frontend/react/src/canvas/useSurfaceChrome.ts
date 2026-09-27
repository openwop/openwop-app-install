/**
 * useSurfaceChrome (ADR 0365) — the ONE owner of the canvas shell-chrome
 * BEHAVIOR blocks that used to be duplicated between `CanvasEditorPage`
 * (doc-lifecycle composition) and `CanvasSurfaceShell` (engine-lifecycle
 * composition):
 *
 *   - the dual-channel a11y announcer (polite + assertive live-region state),
 *   - the declarative shortcut-registry WINDOW-KEYDOWN owner (composing +
 *     `inTextContext` + modal-Escape guards) and the `?` cheatsheet state,
 *   - the ⌘K command projection (ADR 0334 3b-3) + `registerCommandSource`
 *     lifecycle under a FROZEN source key,
 *   - the §7.3 zoom-handle slot the center surface publishes into.
 *
 * The two COMPOSITIONS remain (an accepted, documented split — the doc
 * lifecycle vs the engine lifecycle); only the behavior has one owner, which
 * is the drift class that actually occurred (§7 canon 1).
 *
 * Registry timing contract (kept byte-equal to the prior inline wiring): the
 * dispatch ref is assigned POST-COMMIT (a ref write during render is impure
 * under concurrent React — a keydown landing mid-render could dispatch
 * closures over state the user never saw), while the ⌘K projection ref is
 * assigned during render (the palette reads it lazily on open).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { dispatchShortcut, inTextContext, comboLabel, type ShortcutDef } from './shortcuts.js';
import type { ViewportHandleSlot, ViewportZoomHandle } from './viewportHandle.js';
import { registerCommandSource, type ContributedCommand } from '../ui/commandContributions.js';
import { withRepeatMark } from '../ui/announce.js';
import { DotsIcon } from '../ui/icons/index.js';

export interface SurfaceChromeOptions {
  /** FROZEN ⌘K identity: the `registerCommandSource` key ('canvas-editor' /
   *  'workflow-builder') and the per-command id prefix ('cv' / the shell's
   *  storageKey). Changing either breaks user muscle memory + tests. */
  commandSourceKey: string;
  commandIdPrefix: string;
  /** ⌘K group heading (pre-translated). */
  commandsGroupLabel: string;
  /** Label resolvers: `group: 'type'` entries vs canvas-ns entries. */
  typeT: (key: string) => string;
  canvasT: (key: string) => string;
}

export interface SurfaceChrome {
  /** Live-region strings — the composition renders its own region elements. */
  announce: string;
  announceAssertive: string;
  /**
   * `collapseRepeats` suppresses a consecutive IDENTICAL message instead of
   * re-announcing it. Default OFF, because the common caller is a user verb
   * ("no downstream node") where a second press is a second real event and
   * silence reads as a broken key. Pass it for AMBIENT churn the user did not
   * trigger — presence join/leave, which can flap — where a repeat is noise and
   * the polite queue would back up behind it.
   */
  setAnnounce: (message: string, opts?: { collapseRepeats?: boolean }) => void;
  /** The politeness-routing sink handed to surfaces (WCAG 4.1.3). */
  dispatchAnnounce: (message: string, politeness?: 'polite' | 'assertive') => void;
  /** `?` cheatsheet open state (the ShortcutsOverlay mount stays composition-owned). */
  shortcutsOpen: boolean;
  setShortcutsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** Call ONCE per render with the current registry — feeds the keydown
   *  dispatcher (post-commit) and the ⌘K projection (render-time). */
  commitShortcuts: (defs: ShortcutDef[]) => void;
  /** The zoom-handle slot (⇧1/⇧2/⇧0 dispatch target). */
  viewportSlot: React.MutableRefObject<ViewportZoomHandle | null>;
  viewportSlotApi: ViewportHandleSlot;
}

export function useSurfaceChrome(opts: SurfaceChromeOptions): SurfaceChrome {
  const [announce, setAnnounceState] = useState('');
  const [announceAssertive, setAnnounceAssertiveState] = useState('');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Repeats must stay audible. These regions render their message as a bare
  // text child, so setting the SAME string is a no-op all the way down (React
  // bails on Object.is-equal state; the reconciler skips an equal text update)
  // and the screen reader never speaks again. Two dead-end presses in different
  // directions, or ⌘A twice, would announce once and then go quiet.
  // `withRepeatMark` (ADR 0363, shared with `ui/announce`) flips an invisible
  // marker so each repeat is a distinct value.
  const setAnnounce = useMemo(() => (message: string, opts?: { collapseRepeats?: boolean }) => {
    setAnnounceState((prev) => (opts?.collapseRepeats ? message : withRepeatMark(prev, message)));
  }, []);
  const setAnnounceAssertive = useMemo(() => (message: string) => {
    setAnnounceAssertiveState((prev) => withRepeatMark(prev, message));
  }, []);

  const dispatchAnnounce = useMemo(() => (message: string, politeness?: 'polite' | 'assertive') => {
    if (politeness === 'assertive') setAnnounceAssertive(message);
    else setAnnounce(message);
  }, [setAnnounce, setAnnounceAssertive]);

  // §7.3 / CV-3 — the zoom-handle slot the center surface publishes into.
  const viewportSlot = useRef<ViewportZoomHandle | null>(null);
  const viewportSlotApi = useMemo<ViewportHandleSlot>(() => ({
    publish: (h) => { viewportSlot.current = h; },
    get: () => viewportSlot.current,
  }), []);

  // §7.5 / CV-2 — the registry + the ONE window-keydown owner.
  const shortcutsRef = useRef<ShortcutDef[]>([]);
  const pendingRef = useRef<ShortcutDef[]>([]);
  const paletteCmdsRef = useRef<ContributedCommand[]>([]);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const isMacPlatform = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);
  const commitShortcuts = (defs: ShortcutDef[]): void => {
    pendingRef.current = defs;
  };
  // BOTH consumer refs assign post-commit, never during render (the P3-3
  // grade-pass fix): a discarded render's defs can sit in pendingRef, but
  // effects only run for COMMITTED renders — the dispatch ref and the ⌘K
  // projection therefore always reflect a committed registry. The palette
  // reads its source lazily on open, so post-commit projection is
  // observably identical to the former render-time write.
  useEffect(() => {
    const defs = pendingRef.current;
    shortcutsRef.current = defs;
    const o = optsRef.current;
    // ⌘K projection (ADR 0334 3b-3): enabled entries only, shortcut as hint.
    paletteCmdsRef.current = defs
      .filter((s) => !s.enabled || s.enabled())
      .map((s) => ({
        id: `${o.commandIdPrefix}-${s.combo}`,
        label: s.group === 'type' ? o.typeT(s.labelKey) : o.canvasT(s.labelKey),
        hint: comboLabel(s.combo, isMacPlatform),
        group: o.commandsGroupLabel,
        icon: DotsIcon,
        run: () => s.run(new KeyboardEvent('keydown')),
      }));
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || inTextContext(e)) return;
      // A modal owns its own Escape (ui/Modal) — never also clear selection
      // or switch tools underneath it.
      if (e.key === 'Escape' && document.querySelector('[aria-modal="true"]')) return;
      dispatchShortcut(e, shortcutsRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const sourceKey = opts.commandSourceKey;
  useEffect(() => registerCommandSource(sourceKey, () => paletteCmdsRef.current), [sourceKey]);

  return {
    announce,
    announceAssertive,
    setAnnounce,
    dispatchAnnounce,
    shortcutsOpen,
    setShortcutsOpen,
    commitShortcuts,
    viewportSlot,
    viewportSlotApi,
  };
}
