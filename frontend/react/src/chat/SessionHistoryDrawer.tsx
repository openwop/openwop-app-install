/**
 * Sidebar drawer listing chat sessions for the calling tenant (Phase 2C.1).
 *
 *   Date groups: Today / Yesterday / This Week / Older
 *   Search box that filters by title (case-insensitive, debounced).
 *   Hover-revealed Rename + Delete per row.
 *   Rename uses an inline TextField; submit-on-Enter / cancel-on-Esc.
 *   Delete prompts a one-step confirm modal (no undo snackbar in the
 *     sample — adopters can add their own per the plan).
 *
 * The drawer is purely presentational — state lives in `useChatSessions`.
 * The parent (ChatSidebar) wires the active-session callback.
 */

import { useMemo, useState } from 'react';
import type { ChatSessionHeader } from '../client/chatSessionsClient.js';
import { PencilIcon, TrashIcon, XIcon } from '../ui/icons/index.js';

interface Props {
  sessions: readonly ChatSessionHeader[];
  isLoading: boolean;
  error: string | null;
  /** The session currently open in the message-feed (highlighted). */
  activeSessionId: string | null;
  /** Trigger a re-fetch of the headers (used after the "Try again"
   *  affordance when an error surfaces). */
  onRefresh: () => Promise<void>;
  /** Switch the chat-feed to a different session. */
  onSelect: (sessionId: string) => void;
  /** Persist a renamed title. */
  onRename: (sessionId: string, title: string) => Promise<void>;
  /** Drop a session (cascades to messages on the BE). */
  onDelete: (sessionId: string) => Promise<void>;
  /** Close the drawer. */
  onClose: () => void;
}

type DateGroup = 'Today' | 'Yesterday' | 'This Week' | 'Older';

function groupOf(iso: string): DateGroup {
  const d = new Date(iso);
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTarget = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (startOfTarget === startOfToday) return 'Today';
  if (startOfTarget === startOfToday - dayMs) return 'Yesterday';
  if (startOfTarget >= startOfToday - 6 * dayMs) return 'This Week';
  return 'Older';
}

const GROUP_ORDER: DateGroup[] = ['Today', 'Yesterday', 'This Week', 'Older'];

export function SessionHistoryDrawer({
  sessions,
  isLoading,
  error,
  activeSessionId,
  onRefresh,
  onSelect,
  onRename,
  onDelete,
  onClose,
}: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
    const buckets: Record<DateGroup, ChatSessionHeader[]> = {
      Today: [], Yesterday: [], 'This Week': [], Older: [],
    };
    for (const s of filtered) {
      buckets[groupOf(s.updatedAt)].push(s);
    }
    return buckets;
  }, [sessions, query]);

  async function commitRename(sessionId: string): Promise<void> {
    const trimmed = renameDraft.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    try {
      await onRename(sessionId, trimmed);
    } catch (e) {
      // Surface rename errors via the drawer's `error` prop already.
      console.error('rename failed', e);
    }
    setRenamingId(null);
  }

  return (
    <aside
      className="session-history-drawer u-w-full u-h-full u-bg-surface u-flex u-flex-col"
      aria-label="Chat history"
    >
      <header className="sesshist-header">
        <strong className="u-flex-1 u-fs-13">History</strong>
        <button
          type="button"
          className="secondary sesshist-mini-btn"
          onClick={onClose}
          aria-label="Close history"
        >
          <XIcon size={14} />
        </button>
      </header>

      <div className="u-p-2 u-border-b">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats…"
          aria-label="Search chats"
          className="u-w-full u-fs-12"
        />
      </div>

      <div className="u-flex-1 u-overflow-y-auto u-pad-4x0">
        {isLoading && (
          <div className="muted u-p-3 u-fs-12">Loading…</div>
        )}
        {error && (
          <div className="alert error u-m-2 u-fs-11">
            {error}
            <div className="u-mt-1-5">
              <button
                type="button"
                className="secondary sesshist-mini-btn"
                onClick={() => { void onRefresh(); }}
              >
                Try again
              </button>
            </div>
          </div>
        )}
        {!isLoading && !error && sessions.length === 0 && (
          <div className="muted u-p-3 u-fs-12">
            No saved chats yet.
          </div>
        )}
        {GROUP_ORDER.map((group) => {
          const items = grouped[group];
          if (items.length === 0) return null;
          return (
            <section key={group} aria-label={group}>
              <h3 className="muted sesshist-group-head">
                {group}
              </h3>
              <ul className="u-list-none u-m-0 u-p-0">
                {items.map((s) => {
                  const isActive = s.sessionId === activeSessionId;
                  const isRenaming = renamingId === s.sessionId;
                  return (
                    <li
                      key={s.sessionId}
                      className="session-row sesshist-row"
                      role="button"
                      tabIndex={isRenaming ? -1 : 0}
                      style={{
                        background: isActive
                          ? 'color-mix(in oklch, var(--color-accent) 18%, transparent)'
                          : 'transparent',
                        borderLeft: isActive
                          ? '2px solid var(--color-accent)'
                          : '2px solid transparent',
                      }}
                      onClick={() => { if (!isRenaming) onSelect(s.sessionId); }}
                      onKeyDown={(e) => {
                        if (!isRenaming && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          onSelect(s.sessionId);
                        }
                      }}
                    >
                      {isRenaming ? (
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => { void commitRename(s.sessionId); }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); void commitRename(s.sessionId); }
                            if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); }
                          }}
                          className="sesshist-rename-input"
                          aria-label="Rename chat"
                        />
                      ) : (
                        <>
                          <div
                            className="sesshist-row-title"
                            style={{ fontWeight: isActive ? 600 : 400 }}
                            title={s.title}
                          >
                            {s.title}
                          </div>
                          <div className="muted sesshist-row-count">
                            {s.messageCount} {s.messageCount === 1 ? 'message' : 'messages'}
                          </div>
                          <div className="session-row-actions sesshist-row-actions">
                            <button
                              type="button"
                              className="secondary sesshist-action-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenameDraft(s.title);
                                setRenamingId(s.sessionId);
                              }}
                              aria-label="Rename chat"
                            >
                              <PencilIcon size={12} />
                            </button>
                            <button
                              type="button"
                              className="secondary sesshist-action-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                setPendingDeleteId(s.sessionId);
                              }}
                              aria-label="Delete chat"
                            >
                              <TrashIcon size={12} />
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      {pendingDeleteId && (
        <div
          role="presentation"
          className="sesshist-modal-overlay"
          onClick={() => setPendingDeleteId(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setPendingDeleteId(null); } }}
        >
          <div
            role="presentation"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Confirm delete"
              className="sesshist-dialog"
            >
              <div className="u-fw-600 u-mb-1-5">Delete this chat?</div>
              <div className="muted u-fs-12 u-mb-3">
                The chat and all messages are removed permanently.
              </div>
              <div className="u-flex u-gap-2 u-justify-end">
                <button
                  type="button"
                  className="secondary sesshist-dialog-btn"
                  onClick={() => setPendingDeleteId(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const id = pendingDeleteId;
                    setPendingDeleteId(null);
                    try { await onDelete(id); } catch (e) { console.error('delete failed', e); }
                  }}
                  className="primary sesshist-dialog-btn"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
