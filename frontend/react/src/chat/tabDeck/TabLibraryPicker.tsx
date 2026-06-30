/**
 * TabLibraryPicker — the conversation LIBRARY for the multi-tab deck (ADR 0140 P7).
 *
 * A lightweight modal over the SINGLE conversation index (`useChatSessions().sessions`,
 * passed in) — NOT a second list. Selecting a conversation opens it as a tab via the
 * deck's `openTab` (which dedupes → focuses if already open). It also surfaces rename +
 * delete (free — `useChatSessions` already owns them, no per-tab lineup coupling).
 *
 * Deliberately NOT `ConversationsRail`: that component's "in this conversation" zone
 * (agent lineup / switch-voice / drop-agent / thinking pulse) describes ONE active
 * session — a single-active concept the deck doesn't have (each tab's lineup lives
 * inside its own TabSession). Rendering it here with an empty lineup would be dishonest
 * UI. Per-tab agent management remains an open gap (ADR 0140).
 */

import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { confirm } from '../../ui/confirm.js';
import { IconButton } from '../../ui/IconButton.js';
import { MessageSquareIcon, HashIcon, PencilIcon, PlusIcon, TrashIcon, SearchIcon } from '../../ui/icons/index.js';
import type { ChatSessionHeader } from '../../client/chatSessionsClient.js';

export function TabLibraryPicker({
  conversations, openIds, onOpen, onRename, onDelete, onClose, onCreateChannel, onBrowseChannels,
}: {
  conversations: readonly ChatSessionHeader[];
  /** Ids already open as tabs (shown as "open" so selecting just focuses). */
  openIds: ReadonlySet<string>;
  onOpen: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
  onClose: () => void;
  /** ADR 0154 FU-1 — deck parity: create a channel from the library. */
  onCreateChannel?: () => void;
  /** ADR 0154 FU-4 — deck parity: browse + join public channels. */
  onBrowseChannels?: () => void;
}): JSX.Element {
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Synchronous guard: an edit unmounts the input → fires `onBlur` → commit. Without
  // this, Enter double-commits (Enter then the blur) and Escape COMMITS (the blur fires
  // after cancel). The ref is flipped false synchronously by the first of commit/cancel,
  // so the trailing blur is a no-op.
  const renamePendingRef = useRef(false);

  // Recents-first (ADR 0140): the picker OPENS showing the most recently-updated
  // conversations pre-listed (recognition over recall), and search filters that list —
  // never an empty box. Sort a copy by `updatedAt` desc so the launcher is a strong
  // "jump back in" surface regardless of the backend list order.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q ? conversations.filter((c) => (c.title ?? '').toLowerCase().includes(q)) : conversations.slice();
    return rows.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, [conversations, query]);

  const beginRename = (sid: string, title: string): void => {
    renamePendingRef.current = true;
    setRenamingId(sid);
    setDraft(title);
  };
  const cancelRename = (): void => {
    renamePendingRef.current = false;
    setRenamingId(null);
  };
  const commitRename = async (sid: string): Promise<void> => {
    if (!renamePendingRef.current) return; // already committed/cancelled (trailing blur)
    renamePendingRef.current = false;
    const title = draft.trim();
    setRenamingId(null);
    if (title) await onRename(sid, title);
  };

  const handleDelete = async (sid: string, title: string): Promise<void> => {
    const ok = await confirm({ title: t('multiTabDeleteConfirm', { title }), danger: true, confirmLabel: t('multiTabDelete') });
    if (ok) await onDelete(sid);
  };

  return (
    <Modal onClose={onClose} label={t('multiTabLibraryTitle')} className="tabdeck-library">
      <h2 className="tabdeck-library__heading">{t('multiTabLibraryTitle')}</h2>
      <label className="tabdeck-library__search">
        <SearchIcon size={14} />
        <input
          type="search"
          className="tabdeck-library__search-input"
          placeholder={t('multiTabLibrarySearch')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('multiTabLibrarySearch')}
        />
      </label>
      {(onCreateChannel || onBrowseChannels) ? (
        <div className="u-flex u-justify-end u-gap-2 u-mb-2">
          {onBrowseChannels ? (
            <button type="button" className="secondary btn-sm" onClick={() => { onBrowseChannels(); onClose(); }}>
              <SearchIcon size={13} /> {t('browseChannelsCta')}
            </button>
          ) : null}
          {onCreateChannel ? (
            <button type="button" className="secondary btn-sm" onClick={() => { onCreateChannel(); onClose(); }}>
              <PlusIcon size={13} /> {t('newChannelCta')}
            </button>
          ) : null}
        </div>
      ) : null}
      {filtered.length === 0 ? (
        <p className="u-text-muted tabdeck-library__empty">{t('multiTabLibraryEmpty')}</p>
      ) : (
        <>
          {query.trim() === '' ? (
            <p className="u-text-muted tabdeck-library__sectionlabel">{t('multiTabLibraryRecent')}</p>
          ) : null}
        <ul className="tabdeck-library__list">
          {filtered.map((c) => {
            const isOpen = openIds.has(c.sessionId);
            const title = c.title || t('multiTabNewTab');
            return (
              <li key={c.sessionId} className="tabdeck-library__row">
                {renamingId === c.sessionId ? (
                  <input
                    type="text"
                    className="tabdeck-library__rename"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void commitRename(c.sessionId); }
                      if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                    }}
                    onBlur={() => void commitRename(c.sessionId)}
                    aria-label={t('multiTabRenameAria', { title })}
                  />
                ) : (
                  <button
                    type="button"
                    className="tabdeck-library__open u-button-bare"
                    onClick={() => { onOpen(c.sessionId); onClose(); }}
                  >
                    {c.type === 'channel' ? <HashIcon size={14} /> : <MessageSquareIcon size={14} />}
                    <span className="tabdeck-library__title">{title}</span>
                    {isOpen ? <span className="chip chip--muted tabdeck-library__openchip">{t('multiTabOpenBadge')}</span> : null}
                  </button>
                )}
                <span className="tabdeck-library__actions">
                  {/* ADR 0154 — channels are managed via the tab's settings (owner-gated);
                      suppress the generic rename/delete (they hit the ungated chat-session
                      routes and would desync channel.name / bypass archive). */}
                  {c.type === 'channel' ? null : (
                    <>
                      <IconButton
                        label={t('multiTabRenameAria', { title })}
                        icon={<PencilIcon size={14} />}
                        onClick={() => beginRename(c.sessionId, title)}
                      />
                      <IconButton
                        label={t('multiTabDeleteAria', { title })}
                        icon={<TrashIcon size={14} />}
                        onClick={() => void handleDelete(c.sessionId, title)}
                      />
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        </>
      )}
    </Modal>
  );
}
