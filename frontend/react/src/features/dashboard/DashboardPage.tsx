/**
 * DashboardPage (ADR 0375 Phase 2) — the customizable tile grid at `/dashboard`.
 * Composes tiles from the registry (`ALL_DASHBOARD_TILES`); owns no tile data.
 * The effective set = registry ∩ owning-feature-toggle ∩ tier ∩ enabled, ordered
 * by the caller's saved layout (fallback defaults). Customize mode adds
 * keyboard-operable reorder / resize / remove + an add-picker; edits persist
 * (debounced) via the Phase-1 self-scoped layout route.
 */
import { toast } from '../../ui/toast.js';
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { LayoutGridIcon, SettingsIcon, CheckIcon, PlusIcon, RotateCcwIcon } from '../../ui/icons/index.js';
import { confirm } from '../../ui/confirm.js';
import { useLiveRegion } from '../../ui/announce.js';
import { useAuth } from '../../auth/useAuth.js';
import { useBackendSession } from '../../auth/backendSession.js';
import { useFeatureVisible, useFeatureLocked, useAllFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useEffectiveAccessState, isAdminCaller } from '../../client/useEffectiveAccess.js';
import { getLayout, putLayout, type TileLayout } from './dashboardClient.js';
import { ALL_DASHBOARD_TILES } from './allTiles.js';
import { resolveTiles, mergeForPersist, type SavedTile } from './resolveTiles.js';
import { DashboardTileCard } from './DashboardTileCard.js';

/** Picker group order — the catalog's categories, work-first. */
const CATEGORY_ORDER = ['Work', 'Business', 'Content', 'AI', 'Operations'] as const;

export function DashboardPage(): JSX.Element {
  const { t } = useTranslation('dashboard');
  const isVisible = useFeatureVisible();
  const isLocked = useFeatureLocked();
  const { loading: accessLoading } = useAllFeatureAccess();
  const { access, resolved: accessResolved } = useEffectiveAccessState();
  const isAdmin = isAdminCaller(access);

  const [saved, setSaved] = useState<SavedTile[] | null | undefined>(undefined); // undefined = loading
  // THIRD state, and it is load-bearing. `saved === null` means "the server says
  // you have no saved layout" — `mergeForPersist` preserves rows only from that
  // argument, so persisting against a null it never actually read WRITES THE
  // DEFAULTS OVER THE USER'S REAL LAYOUT. A failed read must never reach persist.
  const [layoutFailed, setLayoutFailed] = useState(false);
  /**
   * A SAVE failed. The UI had already shown the edit as applied — the arrangement
   * simply reverts on the next load, with nothing said in between. Surfaced by
   * the standing Notice below (one persistent surface, no toast — see the catch).
   */
  /** See PersonalNoteTile: only the newest save may write the status (WRITE-1). */
  const saveSeqRef = useRef(0);
  const [saveFailed, setSaveFailed] = useState(false);
  // `t` is language-bound at capture, and these fire from a debounce/cleanup —
  // a []-dep flush would toast in the language active at FIRST MOUNT.
  const tRef = useRef(t);
  tRef.current = t;
  const [working, setWorking] = useState<SavedTile[] | null>(null);
  const [customizing, setCustomizing] = useState(false);
  // ANN-UX-2 — a polite region only speaks when its text MUTATES, so a plain
  // `useState` announcer goes SILENT on a repeat: React bails on `Object.is`-equal
  // state before the DOM is touched. That is exactly wrong here, because every
  // message below is a user VERB and the natural way to check a keypress worked is
  // to press it again. `t('resetAnnounce')` and the tile card's "Refreshed <name>"
  // are word-for-word identical on a second press; without this they say nothing.
  // No call site on this page is AMBIENT (nothing polls, nothing reconnects), so
  // none of them passes `collapseRepeats`.
  const [announce, setAnnounce] = useLiveRegion();
  // DASH-1 focus restore. Reordering re-renders the grid, so the button the
  // user just activated unmounts and focus falls to <body> — a keyboard user
  // loses their place and cannot make consecutive moves, which defeats the
  // point of a keyboard alternative to drag-and-drop. Verified live 2026-08-03.
  // The subtlety: after move-to-EDGE the activated control becomes disabled,
  // and focusing a disabled button silently does nothing — so fall back to the
  // opposite-edge control, which is necessarily enabled once the tile moved.
  const [refocus, setRefocus] = useState<{ id: string; label: string; fallback: string } | null>(null);
  useEffect(() => {
    if (!refocus) return;
    // Attribute COMPARISON, not selector interpolation: `CSS.escape` is absent
    // in some DOM environments (jsdom) — the same trap this codebase already
    // hit in the CMS section-focus work.
    const tile = Array.from(document.querySelectorAll('[data-tile-id]'))
      .find((el) => el.getAttribute('data-tile-id') === refocus.id);
    const pick = (l: string): HTMLButtonElement | null => {
      const b = Array.from(tile?.querySelectorAll('button') ?? [])
        .find((x) => x.getAttribute('aria-label') === l);
      return b && !b.disabled ? b : null;
    };
    (pick(refocus.label) ?? pick(refocus.fallback))?.focus();
    setRefocus(null);
  }, [refocus]);
  const [pickerQuery, setPickerQuery] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSave = useRef<TileLayout[] | null>(null); // payload awaiting the debounce
  const dragId = useRef<string | null>(null); // pointer-drag source (customize mode)

  // The greeting lede — the page's one personal moment (kept to a single line;
  // Asana-scale greeting banners are a documented user complaint). Time-of-day
  // + first name when a display name exists, plain otherwise.
  const { user: fbUser } = useAuth();
  const { user: durableUser } = useBackendSession();
  const hour = new Date().getHours();
  const slot = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
  const rawName = fbUser?.displayName ?? durableUser?.displayName ?? '';
  const firstName = rawName.trim().split(/\s+/)[0] ?? '';
  const lede = firstName
    ? `${t(`greeting${slot}Named`, { name: firstName })} ${t('subtitleBrief')}`
    : `${t(`greeting${slot}`)} ${t('subtitleBrief')}`;

  // Load the caller's saved layout once.
  useEffect(() => {
    const ctl = new AbortController();
    getLayout(ctl.signal)
      .then((l) => { setLayoutFailed(false); setSaved(l ? l.tiles : null); })
      .catch(() => {
        // Render the defaults so the page still works, but remember that we are
        // showing them because we could NOT read, not because none are saved.
        if (ctl.signal.aborted) return;
        setLayoutFailed(true);
        setSaved(null);
      });
    return () => ctl.abort();
  }, []);

  const ready = saved !== undefined && !accessLoading && accessResolved;

  // Derive the working layout once everything is ready (fail-closed: a tile whose
  // feature is off / tier is unmet is absent). Toggle state is already settled
  // before `ready` (accessLoading gates it), so `isVisible` is read once here and
  // deliberately kept OUT of the deps — it's a fresh closure each render, and
  // depending on it would re-derive on every setWorking and clobber user edits.
  useEffect(() => {
    if (!ready) return;
    const resolvedTiles = resolveTiles({ registry: ALL_DASHBOARD_TILES, saved: saved ?? null, toggleEnabled: (id) => isVisible(id), isAdmin, featureLocked: (id) => isLocked(id) });
    setWorking(resolvedTiles.map((r) => ({ id: r.def.id, order: r.order, size: r.size, enabled: r.enabled })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isVisible intentionally excluded (see above); derive once when ready
  }, [ready, saved, isAdmin]);

  // Persist edits (debounced). The initial derivation sets `working` without
  // marking dirty, so a bare view never writes (zero-write first paint).
  const persist = useCallback((next: SavedTile[]) => {
    // A failed read gives us no baseline to merge against; writing here would
    // replace the stored layout with the defaults. Refuse, don't guess.
    if (layoutFailed) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // Preserve saved rows for registered-but-currently-unavailable tiles (a
    // toggled-off feature's arrangement survives the flip — grade-data S7b).
    const registryIds = new Set(ALL_DASHBOARD_TILES.map((d) => d.id));
    const full = mergeForPersist(saved ?? null, next, registryIds) as TileLayout[];
    pendingSave.current = full;
    saveTimer.current = setTimeout(() => {
      pendingSave.current = null;
      const seq = (saveSeqRef.current += 1);
      void putLayout(full)
        .then(() => { if (seq !== saveSeqRef.current) return; setSaveFailed(false); })
        .catch(() => {
          if (seq !== saveSeqRef.current) return; // superseded
          // NO toast here. The standing Notice below is already
          // role="alert"/aria-live="assertive" (Notice.tsx), and toast.error is
          // too — firing both is the SAME DS-8 double-announce I thought I had
          // removed, just moved into a different lane (grade-ux DASHW-10). The
          // persistent surface wins: it survives, a 5s toast does not.
          setSaveFailed(true);
        });
    }, 600);
  }, [saved, layoutFailed]);
  // Flush on unmount — an edit made just before navigating away must persist
  // (grade-code HOME-C2; same class as the note tile's flush).
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // Unmounting, but <Toaster/> is mounted at the app shell (App.tsx:402), so
    // this still reaches the user.
    if (pendingSave.current) { void putLayout(pendingSave.current).catch(() => toast.error(tRef.current('layoutSaveFailedOnLeave'))); }
  }, []);

  const defById = useMemo(() => new Map(ALL_DASHBOARD_TILES.map((d) => [d.id, d])), []);
  const availableResolved = useMemo(() => {
    if (!working) return [];
    return working
      .filter((w) => defById.has(w.id))
      .map((w) => ({ def: defById.get(w.id)!, order: w.order, size: w.size, enabled: w.enabled }))
      .sort((a, b) => a.order - b.order);
  }, [working, defById]);
  const enabledTiles = availableResolved.filter((r) => r.enabled);
  const disabledTiles = availableResolved.filter((r) => !r.enabled);

  const mutate = (next: SavedTile[]): void => { setWorking(next); persist(next); };
  /** The tile's display name — used by every announcement so they read alike. */
  const nameOf = (id: string): string => {
    const def = defById.get(id);
    return def ? t(def.labelKey, { defaultValue: def.label }) : id;
  };

  // DASH-1 (round 2) — keyboard reorder was O(n) presses to cross a long grid;
  // pointer users got DnD in round 1. Move-to-top/bottom closes the tail.
  const moveToEdge = (id: string, edge: 'top' | 'bottom'): void => {
    if (!working) return;
    const enabledIds = availableResolved.filter((r) => r.enabled).map((r) => r.def.id);
    const fromIdx = enabledIds.indexOf(id);
    if (fromIdx < 0) return;
    const toIdx = edge === 'top' ? 0 : enabledIds.length - 1;
    if (fromIdx === toIdx) return;
    const ids = [...enabledIds];
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, id);
    const orderOf = new Map(ids.map((tileId, i) => [tileId, (i + 1) * 10]));
    mutate(working.map((w) => (orderOf.has(w.id) ? { ...w, order: orderOf.get(w.id)! } : w)));
    setAnnounce(t('movedAnnounce', { name: nameOf(id), pos: toIdx + 1, total: ids.length }));
    setRefocus({
      id,
      label: edge === 'top' ? t('moveToTop') : t('moveToBottom'),
      fallback: edge === 'top' ? t('moveToBottom') : t('moveToTop'),
    });
  };

  const move = (id: string, dir: -1 | 1): void => {
    if (!working) return;
    const enabledOrdered = availableResolved.filter((r) => r.enabled);
    const idx = enabledOrdered.findIndex((r) => r.def.id === id);
    const swapWith = enabledOrdered[idx + dir];
    if (!swapWith) return;
    const next = working.map((w) => {
      if (w.id === id) return { ...w, order: swapWith.order };
      if (w.id === swapWith.def.id) return { ...w, order: enabledOrdered[idx]!.order };
      return w;
    });
    mutate(next);
    setAnnounce(t('movedAnnounce', { name: t(defById.get(id)!.labelKey, { defaultValue: defById.get(id)!.label }), pos: idx + 1 + dir, total: enabledOrdered.length }));
    // Same restore as the edge moves: a single step can also land the tile at
    // an end, disabling the button that was just pressed.
    setRefocus({
      id,
      label: dir === -1 ? t('moveUp', { defaultValue: 'Move up' }) : t('moveDown', { defaultValue: 'Move down' }),
      fallback: dir === -1 ? t('moveDown', { defaultValue: 'Move down' }) : t('moveUp', { defaultValue: 'Move up' }),
    });
  };
  // D-G2 — every customize action announces. Reordering already did; resize and
  // add/remove were silent, so a screen-reader user got no confirmation that the
  // thing they just pressed had done anything.
  const toggleSize = (id: string): void => {
    if (!working) return;
    const cur = working.find((w) => w.id === id);
    if (!cur) return;
    const nextSize = cur.size === 'half' ? 'full' : 'half';
    mutate(working.map((w) => (w.id === id ? { ...w, size: nextSize } : w)));
    setAnnounce(t(nextSize === 'full' ? 'resizedWideAnnounce' : 'resizedCompactAnnounce', { name: nameOf(id) }));
  };
  const setEnabled = (id: string, enabled: boolean): void => {
    if (!working) return;
    const maxOrder = working.reduce((m, w) => Math.max(m, w.order), 0);
    mutate(working.map((w) => (w.id === id ? { ...w, enabled, ...(enabled ? { order: maxOrder + 10 } : {}) } : w)));
    // D-G3 — removal is recoverable, but only if you know where it went. Say so
    // rather than leaving the tile to silently vanish off the grid.
    setAnnounce(t(enabled ? 'addedAnnounce' : 'removedAnnounce', { name: nameOf(id) }));
  };

  // Pointer-drag reorder (customize mode): place the dragged tile at the drop
  // target's position. The ↑/↓ buttons remain the keyboard path — DnD is an
  // addition, never a replacement (a11y parity).
  const reorderTo = (fromId: string, toId: string): void => {
    if (!working || fromId === toId) return;
    const enabledIds = availableResolved.filter((r) => r.enabled).map((r) => r.def.id);
    const fromIdx = enabledIds.indexOf(fromId);
    const toIdx = enabledIds.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const ids = [...enabledIds];
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, fromId);
    const orderOf = new Map(ids.map((tileId, i) => [tileId, (i + 1) * 10]));
    mutate(working.map((w) => (orderOf.has(w.id) ? { ...w, order: orderOf.get(w.id)! } : w)));
    setAnnounce(t('movedAnnounce', { name: nameOf(fromId), pos: toIdx + 1, total: ids.length }));
  };

  // D-G1 — a way BACK. Once you customized there was no route to the default
  // arrangement short of hand-restoring every tile. Persisting an empty layout
  // is exactly what "no saved layout" means to `resolveTiles`, so the defaults
  // are re-derived from the registry rather than duplicated here.
  const resetToDefaults = async (): Promise<void> => {
    if (!(await confirm({ title: t('resetConfirmTitle'), body: t('resetConfirmBody'), confirmLabel: t('reset') }))) return;
    const defaults = resolveTiles({ registry: ALL_DASHBOARD_TILES, saved: null, toggleEnabled: (id) => isVisible(id), isAdmin, featureLocked: (id) => isLocked(id) });
    const next = defaults.map((r) => ({ id: r.def.id, order: r.order, size: r.size, enabled: r.enabled }));
    setSaved(null);
    mutate(next);
    setAnnounce(t('resetAnnounce'));
  };

  if (!ready || working === null) {
    return (
      <div>
        <PageHeader title={t('title')} lede={lede} />
        <div className="dash-grid" aria-busy="true"><Skeleton height={140} /><Skeleton height={140} /></div>
      </div>
    );
  }

  return (
    <div data-walkthrough="dashboard.page">
      <PageHeader
        title={t('title')}
        lede={lede}
        actions={
          <>
            {customizing ? (
              <Button variant="secondary" size="sm" onClick={() => { void resetToDefaults(); }}>
                <RotateCcwIcon size={14} /> {t('reset')}
              </Button>
            ) : null}
            <Button
              variant={customizing ? 'primary' : 'secondary'}
              size="sm"
              disabled={layoutFailed}
              {...(layoutFailed ? { title: t('layoutUnreadable') } : {})}
              onClick={() => { setCustomizing((c) => !c); setPickerQuery(''); }}
            >
              {customizing ? <><CheckIcon size={14} /> {t('done')}</> : <><SettingsIcon size={14} /> {t('customize')}</>}
            </Button>
          </>
        }
      />

      {/* `aria-atomic` is load-bearing with `useLiveRegion`: the repeat mechanism
          is an invisible TRAILING marker, and without atomic some assistive tech
          reads only the changed portion — i.e. the marker alone, silently. */}
      <span aria-live="polite" aria-atomic="true" className="sr-only">{announce}</span>

      {layoutFailed ? <Notice variant="warning" announce={t('layoutUnreadable')}>{t('layoutUnreadable')}</Notice> : null}
      {/* A STANDING surface, not just the toast. The toast is one ~5s notice per
          failure episode, and the ref only clears on a success — so a
          session-long failure (expired cookie, offline) would leave the user
          rearranging tiles in silence, believing each move stuck. That is a
          softer version of the lie this fix exists to remove. */}
      {saveFailed ? (
        <Notice variant="error">
          {t('layoutSaveFailedStanding')}{' '}
          {/* It could not clear itself before: `saveFailed` reset only on a later
              SUCCESSFUL save, so one blip pinned a red banner to the home screen
              for the session (grade-ux DASHW-13). */}
          <Button variant="link" onClick={() => { if (pendingSave.current ?? working) persist(working ?? []); }}>
            {t('layoutSaveRetry')}
          </Button>
        </Notice>
      ) : null}

      {enabledTiles.length === 0 ? (
        <StateCard
          icon={<LayoutGridIcon size={20} />}
          title={t('emptyTitle')}
          body={t('emptyBody')}
          action={!customizing ? <Button variant="secondary" onClick={() => setCustomizing(true)}><SettingsIcon size={14} /> {t('customize')}</Button> : undefined}
        />
      ) : (
        <div className="dash-grid">
          {enabledTiles.map((tile, i) => (
            <DashboardTileCard
              key={tile.def.id}
              tile={tile}
              customizing={customizing}
              isFirst={i === 0}
              isLast={i === enabledTiles.length - 1}
              onMove={(dir) => move(tile.def.id, dir)}
              onMoveToEdge={(edge) => moveToEdge(tile.def.id, edge)}
              onToggleSize={() => toggleSize(tile.def.id)}
              onRemove={() => setEnabled(tile.def.id, false)}
              onAnnounce={setAnnounce}
              onDragStartTile={() => { dragId.current = tile.def.id; }}
              onDropOnTile={() => { if (dragId.current) reorderTo(dragId.current, tile.def.id); dragId.current = null; }}
              onDragEndTile={() => { dragId.current = null; }}
            />
          ))}
        </div>
      )}

      {customizing && disabledTiles.length > 0 ? (
        <section className="dash-picker surface-card" aria-label={t('addTiles')}>
          <h2 className="dash-picker__title">{t('addTiles')}</h2>
          {/* Search across the catalog — category headings alone stopped scaling
              at 40+ tiles (the ClickUp/monday picker-search pattern). Only shown
              once the catalog is big enough to need it. */}
          {disabledTiles.length > 8 ? (
            <input
              type="search"
              className="ui-input filterbar-search dash-picker__search"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder={t('searchTiles')}
              aria-label={t('searchTiles')}
            />
          ) : null}
          {(() => {
            const q = pickerQuery.trim().toLowerCase();
            const matches = (tile: (typeof disabledTiles)[number]): boolean => {
              if (!q) return true;
              const label = t(tile.def.labelKey, { defaultValue: tile.def.label }).toLowerCase();
              const desc = t(tile.def.descriptionKey, { defaultValue: '' }).toLowerCase();
              return label.includes(q) || desc.includes(q);
            };
            const visible = disabledTiles.filter(matches);
            if (visible.length === 0) {
              return <p className="dash-picker__empty muted" role="status">{t('searchNoMatch', { query: pickerQuery.trim() })}</p>;
            }
            return (
              <>
                {q ? <p className="sr-only" role="status">{t('searchMatches', { count: visible.length })}</p> : null}
                {CATEGORY_ORDER.map((cat) => {
                  const group = visible.filter((tile) => tile.def.category === cat);
                  if (group.length === 0) return null;
                  return (
              <div key={cat} className="dash-picker__group">
                <h3 className="dash-picker__group-title muted">{t(`category_${cat}`)}</h3>
                <ul className="dash-picker__list u-list-none u-m-0 u-p-0">
                  {group.map((tile) => {
                    const Icon = tile.def.icon;
                    const label = t(tile.def.labelKey, { defaultValue: tile.def.label });
                    return (
                      <li key={tile.def.id} className="dash-picker__row">
                        <span className="dash-picker__meta">
                          <span className="dash-picker__label"><Icon size={14} /> {label}</span>
                          <span className="dash-picker__desc muted">{t(tile.def.descriptionKey, { defaultValue: '' })}</span>
                        </span>
                        <Button variant="secondary" size="sm" onClick={() => setEnabled(tile.def.id, true)} aria-label={t('addTileNamed', { defaultValue: 'Add', name: label })}>
                          <PlusIcon size={14} /> {t('add')}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </div>
                  );
                })}
              </>
            );
          })()}
        </section>
      ) : null}
    </div>
  );
}
