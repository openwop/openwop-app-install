/**
 * TabStrip — the APG `role="tablist"` strip for the multi-tab chat deck (ADR 0140 P4,
 * Decision 5). Presentational: props in, callbacks out; it owns NO deck state (the
 * deck is the single mutation path, which P6 persist + P7 sidebar-open rely on).
 *
 * a11y contract (the binding part of Decision 5):
 *  - container `role="tablist"`; each tab `role="tab"` + `aria-selected`; the deck's
 *    panels are `role="tabpanel"` wired via `aria-controls`/`aria-labelledby` using the
 *    {@link tabButtonId}/{@link tabPanelId} scheme (derived from the stable sessionId so
 *    it survives reload — P6).
 *  - ROVING tabindex: only the active tab is in the tab order (`tabIndex=0`), the rest
 *    `-1`; the per-tab close/pin controls are `tabIndex=-1` so the whole strip is a
 *    SINGLE tab stop (APG-pure). Arrow/Home/End move focus (manual activation —
 *    `handleTablistKeyDown`); Enter/Space activate via the tab's onClick.
 *  - `Delete`/`Backspace` on a focused tab closes it; the reducer activates the
 *    neighbour, and a focus-restoration effect lands focus on that neighbour's tab so
 *    keyboard users aren't stranded. (Keyboard pin is deferred to P7's shortcut pass —
 *    pin is mouse/hover here.)
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { handleTablistKeyDown } from '../../ui/rovingTabs.js';
import { IconButton } from '../../ui/IconButton.js';
import { PlusIcon, XIcon, PinIcon, MonitorIcon, SearchIcon, MenuIcon } from '../../ui/icons/index.js';
import { computeDropIndex } from './dropIndex.js';

export const tabButtonId = (sid: string): string => `tab-${sid}`;
export const tabPanelId = (sid: string): string => `tabpanel-${sid}`;

/** CSS.escape with a fallback (the global is absent in some test/SSR environments). */
const escapeAttr = (s: string): string =>
  (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));

export interface TabStripProps {
  tabs: readonly { sessionId: string; pinned: boolean }[];
  activeSessionId: string | null;
  titleFor: (sid: string) => string;
  onFocus: (sid: string) => void;
  onClose: (sid: string) => void;
  onReorder: (fromSid: string, toIndex: number) => void;
  onSetPinned: (sid: string, pinned: boolean) => void;
  onNewTab: () => void;
  /** Open the conversation library (ADR 0140 P7) — pick an existing conversation to
   *  open as a tab. Surfaced as a strong, labeled "Conversations" launcher (ADR 0140). */
  onOpenLibrary: () => void;
  /** Toggle the shared Runs + Reviews rail (ADR 0140). Omit to hide the control. */
  onToggleRail?: () => void;
  /** Whether the rail is currently open — drives the toggle's pressed state. */
  railOpen?: boolean;
  /** Combined runs + pending-reviews count — a small badge on the rail toggle. */
  railBadgeCount?: number;
  /** P5 forward-compat: a per-tab status slot (unread dot / blocked indicator). */
  renderStatus?: (sid: string) => ReactNode;
  /** Tabs awaiting a HITL interrupt (ADR 0140 G5) — drives the off-screen edge cue when a
   *  blocked tab is scrolled out of the overflowing strip. */
  blockedSids?: ReadonlySet<string>;
  /** Open this conversation in a new browser window (ADR 0140 G6, the light deep-link
   *  pop-out). Omit to hide the control. */
  onPopOut?: (sid: string) => void;
  /** Whether a tab CAN pop out yet — false for a brand-new tab whose conversation isn't
   *  persisted (no backend id to deep-link to). The control renders disabled. */
  canPopOut?: (sid: string) => boolean;
  /** Rename a chat from its tab (double-click the label, or F2 on the focused tab).
   *  Persists via the deck (PATCH → `titleSource:'user'`). Omit to disable renaming. */
  onRename?: (sid: string, title: string) => void | Promise<void>;
}

export function TabStrip({
  tabs, activeSessionId, titleFor, onFocus, onClose, onReorder, onSetPinned, onNewTab, onOpenLibrary, onToggleRail, railOpen, railBadgeCount, renderStatus, blockedSids, onPopOut, canPopOut, onRename,
}: TabStripProps): JSX.Element {
  const { t } = useTranslation('chat');
  // Inline tab rename (ADR 0140 follow-up). Mirrors the conversations-rail edit UX:
  // an input replaces the label; Enter/blur commits, Escape cancels.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const startRename = (sid: string): void => { setRenameDraft(titleFor(sid)); setRenamingId(sid); };
  const cancelRename = (): void => setRenamingId(null);
  const commitRename = (sid: string): void => {
    const trimmed = renameDraft.trim();
    setRenamingId(null);
    if (trimmed && trimmed !== titleFor(sid)) void onRename?.(sid, trimmed);
  };
  const stripRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragSidRef = useRef<string | null>(null);
  // Mouse-discoverability for overflow (ux-review): fade the right edge only when tabs
  // are scrolled off (keyboard users already reach them via Arrow/Home/End + the
  // scroll-into-view effect). The new-tab button lives OUTSIDE the scroll region so it
  // stays reachable.
  const [overflowRight, setOverflowRight] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = (): void => setOverflowRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', update); ro?.disconnect(); };
  }, [tabs.length]);

  // Off-screen BLOCKED edge cue (ADR 0140 G5): a tab waiting on a HITL interrupt that is
  // scrolled out of the strip is invisible — surface a pulsing chevron at the edge it sits
  // past, clickable to scroll it into view. Recomputed on scroll/resize and when the
  // blocked set changes.
  const [blockedEdge, setBlockedEdge] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !blockedSids || blockedSids.size === 0) { setBlockedEdge((p) => (p.left || p.right ? { left: false, right: false } : p)); return; }
    const update = (): void => {
      const vp = el.getBoundingClientRect();
      let left = false, right = false;
      for (const sid of blockedSids) {
        const tabEl = el.querySelector<HTMLElement>(`[role="tab"][data-sid="${escapeAttr(sid)}"]`);
        if (!tabEl) continue;
        const r = tabEl.getBoundingClientRect();
        if (r.right <= vp.left + 1) left = true;        // fully past the left edge
        else if (r.left >= vp.right - 1) right = true;  // fully past the right edge
      }
      setBlockedEdge((p) => (p.left === left && p.right === right ? p : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', update); ro?.disconnect(); };
  }, [tabs, blockedSids]);

  const scrollToBlocked = (dir: 'left' | 'right'): void => {
    const el = scrollRef.current;
    if (!el || !blockedSids) return;
    const vp = el.getBoundingClientRect();
    let best: { node: HTMLElement; d: number } | null = null;
    for (const sid of blockedSids) {
      const tabEl = el.querySelector<HTMLElement>(`[role="tab"][data-sid="${escapeAttr(sid)}"]`);
      if (!tabEl) continue;
      const r = tabEl.getBoundingClientRect();
      const off = dir === 'left' ? r.right <= vp.left + 1 : r.left >= vp.right - 1;
      if (!off) continue;
      // Nearest off-screen blocked tab in that direction (so a chevron walks the user toward them).
      const d = dir === 'left' ? vp.left - r.right : r.left - vp.right;
      if (!best || d < best.d) best = { node: tabEl, d };
    }
    best?.node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    best?.node.focus();
  };
  // Set when a close was initiated by the keyboard, so the post-close effect knows to
  // move focus to the newly-active tab (a mouse close should NOT steal focus).
  const closeViaKeyboardRef = useRef(false);

  // After a keyboard close, the reducer has activated the neighbour; land focus on it.
  // Also keep the active tab scrolled into view (so Arrow-key nav drags the strip).
  useEffect(() => {
    if (!activeSessionId) return;
    const el = stripRef.current?.querySelector<HTMLElement>(`[role="tab"][data-sid="${activeSessionId}"]`);
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (closeViaKeyboardRef.current) {
      closeViaKeyboardRef.current = false;
      el?.focus();
    }
  }, [activeSessionId]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    handleTablistKeyDown(e); // roving (Arrow/Home/End) — preventDefaults its own keys
    if (e.defaultPrevented) return;
    const el = document.activeElement as HTMLElement | null;
    if (el?.getAttribute('role') !== 'tab') return; // only when a TAB is focused
    const sid = el.getAttribute('data-sid');
    if (!sid) return;
    // F2 — the standard "rename" affordance for the keyboard path (mouse uses dbl-click).
    if (e.key === 'F2' && onRename) { e.preventDefault(); startRename(sid); return; }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    e.preventDefault();
    closeViaKeyboardRef.current = true;
    onClose(sid);
  };

  const onDrop = (e: React.DragEvent<HTMLElement>, targetSid: string): void => {
    e.preventDefault();
    const fromSid = dragSidRef.current;
    dragSidRef.current = null;
    if (!fromSid) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const side: 'before' | 'after' = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    const toIndex = computeDropIndex(tabs.map((tb) => tb.sessionId), fromSid, targetSid, side);
    if (toIndex !== null) onReorder(fromSid, toIndex);
  };

  return (
    <div
      ref={stripRef}
      className="tabdeck-strip"
      role="tablist"
      aria-label={t('multiTabTablistAria')}
      onKeyDown={onKeyDown}
    >
      {/* Left — a hamburger that toggles the left rail (Runs/Reviews). The tab viewport
          (flex:1) grows beside it; Conversations + "+ New chat" anchor the right end. */}
      {onToggleRail ? (
        <button
          type="button"
          className={`tabdeck-launcher tabdeck-launcher--icon${railOpen ? ' is-active' : ''}`}
          onClick={onToggleRail}
          aria-pressed={!!railOpen}
          aria-label={railOpen ? t('closeChatTools') : t('openChatTools')}
          title={t('chatToolsTitle')}
        >
          <MenuIcon size={16} />
          {railBadgeCount && railBadgeCount > 0 ? (
            <span className="tabdeck-launcher__badge">{railBadgeCount}</span>
          ) : null}
        </button>
      ) : null}
      <div className="tabdeck-strip__viewport" data-overflow={overflowRight ? 'right' : undefined}>
        {blockedEdge.left && (
          <button
            type="button"
            className="tabdeck-strip__blocked-cue tabdeck-strip__blocked-cue--left"
            aria-label={t('multiTabBlockedOffscreen')}
            title={t('multiTabBlockedOffscreen')}
            onClick={() => scrollToBlocked('left')}
          />
        )}
        {blockedEdge.right && (
          <button
            type="button"
            className="tabdeck-strip__blocked-cue tabdeck-strip__blocked-cue--right"
            aria-label={t('multiTabBlockedOffscreen')}
            title={t('multiTabBlockedOffscreen')}
            onClick={() => scrollToBlocked('right')}
          />
        )}
        <div ref={scrollRef} className="tabdeck-strip__scroll">
      {tabs.map((tab) => {
        const sid = tab.sessionId;
        const isActive = sid === activeSessionId;
        const title = titleFor(sid);
        return (
          <span
            key={sid}
            className="tabdeck-tab"
            data-active={isActive ? 'true' : undefined}
            draggable
            onDragStart={(e) => { dragSidRef.current = sid; e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
            onDrop={(e) => onDrop(e, sid)}
            onDragEnd={() => { dragSidRef.current = null; }}
          >
            {tab.pinned ? <span className="tabdeck-tab__pinned" title={t('multiTabPinnedAria')}><PinIcon size={12} /></span> : null}
            {renderStatus?.(sid)}
            {onRename && renamingId === sid ? (
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => commitRename(sid)}
                // Stop the tablist's roving handler from hijacking keys while typing.
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(sid); }
                  if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                }}
                onClick={(e) => e.stopPropagation()}
                className="tabdeck-tab__label sesshist-rename-input"
                aria-label={t('multiTabRenameTab', { title })}
              />
            ) : (
              <button
                type="button"
                id={tabButtonId(sid)}
                data-sid={sid}
                role="tab"
                aria-selected={isActive}
                aria-controls={tabPanelId(sid)}
                tabIndex={isActive ? 0 : -1}
                className="tabdeck-tab__btn tabdeck-tab__label"
                title={onRename ? t('multiTabRenameHint', { title }) : title}
                onClick={() => onFocus(sid)}
                onDoubleClick={onRename ? () => startRename(sid) : undefined}
              >
                {title}
              </button>
            )}
            <IconButton
              label={tab.pinned ? t('multiTabUnpinTab', { title }) : t('multiTabPinTab', { title })}
              icon={<PinIcon />}
              className={`tabdeck-tab__pin${tab.pinned ? ' tabdeck-tab__pin--on' : ''}`}
              tabIndex={-1}
              aria-pressed={tab.pinned}
              onClick={() => onSetPinned(sid, !tab.pinned)}
            />
            {onPopOut ? (
              <IconButton
                label={t('multiTabOpenInNewWindow', { title })}
                icon={<MonitorIcon />}
                className="tabdeck-tab__popout"
                tabIndex={-1}
                disabled={canPopOut ? !canPopOut(sid) : false}
                onClick={() => onPopOut(sid)}
              />
            ) : null}
            <IconButton
              label={t('multiTabCloseTabNamed', { title })}
              icon={<XIcon />}
              className="tabdeck-tab__close"
              tabIndex={-1}
              aria-keyshortcuts="Delete"
              onClick={() => onClose(sid)}
            />
          </span>
        );
      })}
        </div>
      </div>
      {/* Right cluster — the Conversations library launcher, then the new-chat action.
          Both sit OUTSIDE the scroll region so they stay reachable as tabs overflow. */}
      <button
        type="button"
        className="tabdeck-launcher"
        onClick={onOpenLibrary}
        title={t('multiTabLibraryAria')}
      >
        <SearchIcon size={14} />
        <span>{t('multiTabLibraryLauncher')}</span>
      </button>
      <button
        type="button"
        className="tabdeck-launcher"
        onClick={onNewTab}
        aria-keyshortcuts="Alt+N"
        title={t('multiTabNewTabAria')}
      >
        <PlusIcon size={14} />
        <span>{t('newChat')}</span>
      </button>
    </div>
  );
}
