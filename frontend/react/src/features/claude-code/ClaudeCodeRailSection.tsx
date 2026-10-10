/**
 * ADR 0785 D5 follow-on — the "Claude Code" section of the chat's Conversations
 * rail. Lists the caller's LIVE terminal sessions (newest first, bounded) so a
 * user who left the chat can find a running Claude Code again.
 *
 * Contributed through the deck's `RailSection` seam (`chat/tabDeck/tabKindRegistry`):
 * core chat never imports this feature, and the deck only renders the section
 * while the `claude-code` feature is visible.
 *
 * Clicking a row focuses the deck tab already showing that session (the
 * per-browser `tabStore` map), or opens a new `claude-code` tab PRE-SEEDED with
 * the session id — `ClaudeCodeTerminalTab` reads `tabStore` at mount and
 * reattaches instead of showing the start picker.
 *
 * Two reads per refresh (terminals + devices, in parallel) — never one per row.
 * A failed read renders one quiet line with a retry; no toast.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeckRailSectionProps } from '../../chat/tabDeck/tabKindRegistry.js';
import { Button } from '../../ui/Button.js';
import { PlusIcon, TerminalIcon } from '../../ui/icons/index.js';
import { formatRelativeTime } from '../../i18n/format.js';
import { tabStore } from './terminalTabStore.js';
import { listDevices, listTerminals, type DeviceView, type TerminalSession } from './claudeCodeClient.js';

/** Most rows the section shows. */
export const RAIL_SESSION_LIMIT = 10;
/** A tab switch refreshes the list at most this often (mount + tab open/close always do). */
const ACTIVE_REFRESH_MIN_MS = 15_000;

interface Row {
  session: TerminalSession;
  device: DeviceView | undefined;
}

/** Live sessions, newest first, bounded (pure; exported for tests). */
export function liveSessions(all: readonly TerminalSession[], limit = RAIL_SESSION_LIMIT): TerminalSession[] {
  return all
    .filter((s) => s.status !== 'exited')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function ClaudeCodeRailSection({ openTabIds, activeTabId, focusTab, openNewTab }: DeckRailSectionProps): JSX.Element {
  const { t } = useTranslation('claude-code');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  const reqRef = useRef(0);
  const lastLoadRef = useRef(0);

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    lastLoadRef.current = Date.now();
    try {
      // Devices only label rows + give the online hint: a failure there must not hide sessions.
      const [terminals, devices] = await Promise.all([listTerminals(), listDevices().catch(() => [] as DeviceView[])]);
      if (req !== reqRef.current) return;
      const byId = new Map(devices.map((d) => [d.deviceId, d]));
      setRows(liveSessions(terminals).map((session) => ({ session, device: byId.get(session.deviceId) })));
      setFailed(false);
    } catch {
      if (req === reqRef.current) setFailed(true);
    }
  }, []);

  // Mount (the rail being shown) + whenever this kind's tabs open or close.
  const openKey = openTabIds.join(',');
  useEffect(() => { void load(); }, [load, openKey]);
  // A tab switch (e.g. back from a terminal that just started a session), throttled.
  useEffect(() => {
    if (Date.now() - lastLoadRef.current >= ACTIVE_REFRESH_MIN_MS) void load();
  }, [activeTabId, load]);
  // Returning to the browser tab.
  useEffect(() => {
    const onVis = (): void => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [load]);

  const tabShowing = (sessionId: string): string | undefined => openTabIds.find((id) => tabStore.get(id) === sessionId);
  const activeSessionId = activeTabId && openTabIds.includes(activeTabId) ? tabStore.get(activeTabId) : null;

  const open = (row: Row, title: string): void => {
    const existing = tabShowing(row.session.sessionId);
    if (existing) { focusTab(existing); return; }
    openNewTab({ seed: (tabId) => tabStore.set(tabId, row.session.sessionId), title });
  };
  const startNew = (): void => openNewTab();

  const heading = t('railHeading');
  return (
    <section aria-label={heading}>
      <h3 className="muted sesshist-group-head u-flex u-items-center u-gap-1-5 u-justify-between">
        <span className="u-flex u-items-center u-gap-1-5">
          <span aria-hidden className="u-iflex"><TerminalIcon size={12} /></span>
          {heading}
        </span>
        {rows && rows.length > 0 ? (
          // `primary` adds no class: the markup equals the Channels header's raw
          // `.icon-button` (and the row's `.sesshist-row-open` below), so it reads the same.
          <Button variant="primary" className="icon-button" onClick={startNew} aria-label={t('railNew')} title={t('railNew')}>
            <PlusIcon size={13} />
          </Button>
        ) : null}
      </h3>
      {failed && rows === null ? (
        <p className="muted u-fs-12 u-m-0 u-pad-2-4">
          {t('railLoadFailed')}{' '}
          <Button variant="link" size="sm" onClick={() => { void load(); }}>{t('retry')}</Button>
        </p>
      ) : rows === null ? null : rows.length === 0 ? (
        // Compact empty state (mirrors the empty Channels section): one line + the action.
        <div className="u-pad-2-4">
          <p className="muted u-fs-12 u-m-0 u-mb-2">{t('railEmpty')}</p>
          <Button variant="primary" size="sm" className="u-iflex u-items-center u-gap-1" onClick={startNew}>
            <PlusIcon size={13} /> {t('railStart')}
          </Button>
        </div>
      ) : (
        <ul className="u-list-none u-m-0 u-p-0">
          {rows.map((row) => {
            const { session, device } = row;
            const deviceLabel = device?.label ?? t('railUnknownDevice');
            const title = session.title || t('railFallbackTitle', { device: deviceLabel });
            const online = device?.online;
            return (
              <li
                key={session.sessionId}
                className="session-row sesshist-row"
                data-active={session.sessionId === activeSessionId ? 'true' : undefined}
              >
                <Button variant="primary" className="sesshist-row-open" onClick={() => open(row, title)} title={title}>
                  <div className="sesshist-row-title u-flex u-items-center u-gap-1-5">
                    <span className="u-truncate u-minw-0">{title}</span>
                  </div>
                  <div className="muted sesshist-row-count u-flex u-items-center u-gap-1">
                    {online !== undefined ? (
                      <span className="cc-rail-dot" data-online={online ? 'true' : 'false'} role="img" aria-label={online ? t('railOnline') : t('railOffline')} title={online ? t('railOnline') : t('railOffline')} />
                    ) : null}
                    <span className="u-truncate u-minw-0">{deviceLabel} · {formatRelativeTime(session.createdAt)}</span>
                  </div>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
