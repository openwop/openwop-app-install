/**
 * Conversations rail (ADR 0043) — the unified sidebar tab that REPLACED both
 * the chat-history drawer and the in-chat "Active agents" panel (both deleted
 * once this became the sole chat IA). It is now the only conversation surface.
 *
 * Two stacked zones, mirroring how Slack/Teams present a channel:
 *   1. "In this conversation" — the active participants of the OPEN
 *      conversation (the live active-agents lineup: the default assistant +
 *      any @-mentioned agents). Click a row to switch the routing voice; × to
 *      drop an agent. This is the active-agents panel's controls, folded in.
 *   2. "Conversations" — every persistent conversation for the tenant, grouped
 *      People · Agents · Groups (see `conversationGroups.ts`), searchable, with
 *      hover rename/delete. Click a row to resume that conversation.
 *
 * Presentational: all state lives in `useChatSessions` (the list) +
 * `useActiveAgents` (the lineup); the parent (ChatSidebar) wires the callbacks.
 * Reuses the existing `sesshist-*` / `activeagents-*` style hooks so it stays
 * within the token system (DESIGN.md §10) and visually matches the panels it
 * supersedes.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { searchChatConversations, type ChatSessionHeader, type ConversationSearchHit } from '../../client/chatSessionsClient.js';
import type { ActiveAgentRow } from '../activeAgents/types.js';
import {
  groupConversations,
  isUnread,
  SECTION_ORDER,
  type ConversationSection,
} from './conversationGroups.js';
import {
  BotIcon,
  BuildingIcon,
  HashIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  XIcon,
} from '../../ui/icons/index.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { confirm } from '../../ui/confirm.js';
import { ConversationLineup } from './ConversationLineup.js';

interface Props {
  conversations: readonly ChatSessionHeader[];
  isLoading: boolean;
  error: string | null;
  activeSessionId: string | null;
  onRefresh: () => Promise<void>;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;

  /** Active participants of the OPEN conversation (the live lineup, assistant
   *  first). Folds in what the retired active-agents panel showed. */
  lineup: ReadonlyArray<ActiveAgentRow>;
  currentAgentId: string;
  /** The advisor currently generating a reply — pulses their row. Null = idle. */
  thinkingAgentId: string | null;
  onSwitchAgent: (agentId: string) => void;
  onRemoveAgent: (agentId: string) => void;

  /** Start a fresh conversation — the single next action on the empty state. */
  onNewChat: () => void;
  /** Open-or-resume the Workspace conversation (ADR 0043 Phase 6 — the
   *  assistant's tenant-graph chat). */
  onOpenWorkspace: () => void;
  /** Create a new channel (ADR 0154 Phase 2) — the "+" on the Channels section
   *  header. When set, the Channels section header renders even with zero
   *  channels (so the first one can be created). */
  onCreateChannel?: () => void;
  /** Browse + join public channels (ADR 0154 FU-4) — the rail only lists channels
   *  you're in, so this surfaces discoverable public ones. */
  onBrowseChannels?: () => void;
  onClose: () => void;
}

const SECTION_ICON: Record<ConversationSection, JSX.Element> = {
  Agents: <BotIcon size={12} />,
  Channels: <HashIcon size={12} />,
  Groups: <MessageSquareIcon size={12} />,
  Workspace: <BuildingIcon size={12} />,
};

/** Section union value → chat-catalog key (display label only; the union
 *  values remain the stable data discriminators in conversationGroups.ts). */
const SECTION_LABEL_KEY: Record<ConversationSection, string> = {
  Agents: 'sectionAgents',
  Channels: 'sectionChannels',
  Groups: 'sectionGroups',
  Workspace: 'sectionWorkspace',
};

export function ConversationsRail({
  conversations,
  isLoading,
  error,
  activeSessionId,
  onRefresh,
  onSelect,
  onRename,
  onDelete,
  lineup,
  currentAgentId,
  thinkingAgentId,
  onSwitchAgent,
  onRemoveAgent,
  onNewChat,
  onOpenWorkspace,
  onCreateChannel,
  onBrowseChannels,
  onClose,
}: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const grouped = useMemo(() => groupConversations(conversations, query), [conversations, query]);
  const headingId = 'conversations-rail-heading';

  // ADR 0112 — server-side message FULL-TEXT search, layered over the client-side
  // title filter above. Debounced; degrades silently to titles-only when the
  // `conversation-search` toggle is off (the route 404s → `searchChatConversations`
  // returns []). Only message hits (a snippet, `messageId`) are shown here — title
  // matches are already covered by the client filter.
  const [messageHits, setMessageHits] = useState<readonly ConversationSearchHit[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setMessageHits([]); return; }
    let cancelled = false;
    const handle = setTimeout(() => {
      void searchChatConversations(q).then((hits) => {
        if (!cancelled) setMessageHits(hits.filter((h) => h.messageId));
      });
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query]);

  async function commitRename(sessionId: string): Promise<void> {
    const trimmed = renameDraft.trim();
    if (!trimmed) { setRenamingId(null); return; }
    try { await onRename(sessionId, trimmed); } catch (e) { console.error('rename failed', e); }
    setRenamingId(null);
  }

  // ADR 0043 — delete via the shared in-app confirm (focus-trapped) rather than a
  // hand-rolled role=dialog. Resolves false on cancel/Escape/scrim → no-op.
  async function requestDelete(sessionId: string): Promise<void> {
    const ok = await confirm({
      title: t('deleteConversationTitle'),
      body: t('deleteConversationBody'),
      danger: true,
      confirmLabel: t('common:delete'),
    });
    if (!ok) return;
    try { await onDelete(sessionId); } catch (e) { console.error('delete failed', e); }
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <aside
      className="conversations-rail u-w-full u-h-full u-bg-surface u-flex u-flex-col"
      tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      aria-labelledby={headingId}
    >
      <header className="sesshist-header">
        <strong id={headingId} className="u-flex-1 u-fs-13">{t('conversationsHeading')}</strong>
        <button
          type="button"
          className="secondary sesshist-mini-btn u-mr-2"
          onClick={onOpenWorkspace}
          title={t('openWorkspaceAssistant')}
        >
          <span aria-hidden className="u-iflex u-mr-1"><BuildingIcon size={12} /></span>
          {t('workspace')}
        </button>
        <button
          type="button"
          className="secondary sesshist-mini-btn"
          onClick={onClose}
          aria-label={t('closeConversations')}
        >
          <XIcon size={14} />
        </button>
      </header>

      {/* Zone 1 — participants of the open conversation (ADR 0140 G2: extracted to the
          shared ConversationLineup, also rendered per-tab in TabSession). */}
      <ConversationLineup
        lineup={lineup}
        currentAgentId={currentAgentId}
        thinkingAgentId={thinkingAgentId}
        onSwitchAgent={onSwitchAgent}
        onRemoveAgent={onRemoveAgent}
      />

      <div className="u-p-2 u-border-b">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchConversationsPlaceholder')}
          aria-label={t('searchConversations')}
          className="u-w-full u-fs-12"
        />
      </div>

      {/* ADR 0112 — message full-text matches (snippets), distinct from the
          title filter above. Self-hides when there are none (toggle off / no
          content hits). Clicking opens that conversation. */}
      {query.trim().length >= 2 && messageHits.length > 0 && (
        <section aria-label={t('messageMatches')} className="u-border-b">
          <h3 className="muted sesshist-group-head">{t('messageMatches')}</h3>
          <ul className="u-list-none u-m-0 u-p-1-5 u-flex u-flex-col u-gap-1">
            {messageHits.map((h) => (
              <li
                key={`${h.conversationId}:${h.messageId ?? 'title'}`}
                className="session-row sesshist-row"
                role="button"
                tabIndex={0}
                onClick={() => onSelect(h.conversationId)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(h.conversationId); } }}
              >
                <div className="sesshist-row-title u-truncate" title={h.title}>{h.title || t('untitledConversation')}</div>
                <div className="muted u-fs-11 u-truncate">{h.snippet}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="u-flex-1 u-overflow-y-auto u-pad-4x0">
        {isLoading && <div className="muted u-p-3 u-fs-12">{t('common:loading')}</div>}
        {error && (
          <div className="u-m-2">
            <Notice variant="error">
              {error}
              <div className="u-mt-1-5">
                <button type="button" className="secondary sesshist-mini-btn" onClick={() => { void onRefresh(); }}>
                  {t('tryAgain')}
                </button>
              </div>
            </Notice>
          </div>
        )}
        {!isLoading && !error && conversations.length === 0 && (
          <StateCard
            icon={<MessageSquareIcon size={20} />}
            title={t('noConversationsYet')}
            body={t('noConversationsBody')}
            action={(
              <button type="button" className="primary sesshist-dialog-btn" onClick={onNewChat}>
                {t('newChat')}
              </button>
            )}
          />
        )}
        {SECTION_ORDER.map((section) => {
          const items = grouped[section];
          // The Channels header renders even when empty (so the "+" can mint the
          // first channel); every other empty section collapses.
          const isChannelsSection = section === 'Channels';
          const channelsHeader = isChannelsSection && (!!onCreateChannel || !!onBrowseChannels);
          // When the Channels section is empty, the self-explaining empty-state
          // below carries the LABELED actions, so the ambiguous header icons are
          // suppressed (they return once there are channels to act on).
          const channelsEmpty = isChannelsSection && channelsHeader && items.length === 0;
          if (items.length === 0 && !channelsHeader) return null;
          return (
            <section key={section} aria-label={t(SECTION_LABEL_KEY[section])}>
              <h3 className="muted sesshist-group-head u-flex u-items-center u-gap-1-5 u-justify-between">
                <span className="u-flex u-items-center u-gap-1-5">
                  <span aria-hidden className="u-iflex">{SECTION_ICON[section]}</span>
                  {t(SECTION_LABEL_KEY[section])}
                </span>
                {isChannelsSection && items.length > 0 ? (
                  <span className="u-flex u-items-center u-gap-1">
                    {onBrowseChannels ? (
                      <button type="button" className="icon-button" onClick={onBrowseChannels} aria-label={t('browseChannelsCta')} title={t('browseChannelsCta')}>
                        <SearchIcon size={13} />
                      </button>
                    ) : null}
                    {onCreateChannel ? (
                      <button type="button" className="icon-button" onClick={onCreateChannel} aria-label={t('newChannelCta')} title={t('newChannelCta')}>
                        <PlusIcon size={13} />
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </h3>
              {channelsEmpty ? (
                // Self-explaining empty-state — what channels ARE + how to start.
                // Compact (not a full StateCard) so it doesn't compete with the
                // "No conversations yet" card when the whole list is empty.
                <div className="u-pad-2-4">
                  <p className="muted u-fs-12 u-m-0 u-mb-2">{t('channelsEmptyBody')}</p>
                  <div className="u-flex u-gap-2 u-wrap">
                    {onCreateChannel ? (
                      <button type="button" className="btn-primary btn-sm u-iflex u-items-center u-gap-1" onClick={onCreateChannel}>
                        <PlusIcon size={13} /> {t('newChannelCta')}
                      </button>
                    ) : null}
                    {onBrowseChannels ? (
                      <button type="button" className="secondary btn-sm" onClick={onBrowseChannels}>
                        {t('browseChannelsCta')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <ul className="u-list-none u-m-0 u-p-0">
                {items.map((c) => (
                  <ConversationRow
                    key={c.sessionId}
                    conversation={c}
                    isActive={c.sessionId === activeSessionId}
                    unread={c.sessionId !== activeSessionId && isUnread(c)}
                    isRenaming={renamingId === c.sessionId}
                    renameDraft={renameDraft}
                    onRenameDraftChange={setRenameDraft}
                    onSelect={() => onSelect(c.sessionId)}
                    onStartRename={() => { setRenameDraft(c.title); setRenamingId(c.sessionId); }}
                    onCommitRename={() => { void commitRename(c.sessionId); }}
                    onCancelRename={() => setRenamingId(null)}
                    onRequestDelete={() => { void requestDelete(c.sessionId); }}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function ConversationRow({
  conversation,
  isActive,
  unread,
  isRenaming,
  renameDraft,
  onRenameDraftChange,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onRequestDelete,
}: {
  conversation: ChatSessionHeader;
  isActive: boolean;
  unread: boolean;
  isRenaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (v: string) => void;
  onSelect: () => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onRequestDelete: () => void;
}): JSX.Element {
  const { t } = useTranslation('chat');
  // Member count excludes the owner so the chip reads "who you're talking to".
  const memberCount = (conversation.participants ?? []).filter((p) => p.role !== 'owner').length;
  // ADR 0154 — a channel is managed via the chat settings gear (owner-gated
  // rename/archive/members), so the generic rail rename/delete are suppressed for
  // it: those call the ungated chat-session routes, which would desync channel.name
  // and bypass the owner-only, reversible archive.
  const isChannel = conversation.type === 'channel';
  return (
    // ARIA 1.2: the row's open action is a real <button> (the row body); the
    // rename/delete controls are SIBLINGS of it, not interactive descendants of a
    // role=button. `data-active`/`data-unread` drive the active/unread styling (CSS),
    // so no inline color/spacing literals.
    <li
      className="session-row sesshist-row"
      data-active={isActive ? 'true' : undefined}
      data-unread={unread ? 'true' : undefined}
    >
      {isRenaming ? (
        <input
          autoFocus
          value={renameDraft}
          onChange={(e) => onRenameDraftChange(e.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onCommitRename(); }
            if (e.key === 'Escape') { e.preventDefault(); onCancelRename(); }
          }}
          className="sesshist-rename-input"
          aria-label={t('renameConversation')}
        />
      ) : (
        <>
          <button
            type="button"
            className="sesshist-row-open"
            onClick={onSelect}
            title={conversation.title}
          >
            <div className="sesshist-row-title u-flex u-items-center u-gap-1-5">
              {unread && (
                <span
                  role="img"
                  aria-label={t('unread')}
                  title={t('unread')}
                  className="conversations-unread-dot"
                />
              )}
              {isChannel && <span aria-hidden className="u-iflex muted"><HashIcon size={12} /></span>}
              <span className="u-truncate">{conversation.title}</span>
            </div>
            <div className="muted sesshist-row-count">
              {memberCount > 0 && <span>{t('participants', { count: memberCount })} · </span>}
              {t('messages', { count: conversation.messageCount })}
            </div>
          </button>
          {isChannel ? null : (
            <div className="session-row-actions sesshist-row-actions">
              <button
                type="button"
                className="secondary sesshist-action-btn"
                onClick={onStartRename}
                aria-label={t('renameConversation')}
              >
                <PencilIcon size={12} />
              </button>
              <button
                type="button"
                className="secondary sesshist-action-btn"
                onClick={onRequestDelete}
                aria-label={t('deleteConversation')}
              >
                <TrashIcon size={12} />
              </button>
            </div>
          )}
        </>
      )}
    </li>
  );
}
