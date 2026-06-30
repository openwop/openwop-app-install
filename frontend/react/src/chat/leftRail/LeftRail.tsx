/**
 * Left rail — single sidebar hosting two tab panels: the Conversations rail
 * (ADR 0043, the persistent-conversation list that folds in the open chat's
 * participants) and the Workflow Progress panel.
 *
 * Layout:
 *   - Open  → rail is 320px wide at the left of the chat. Tabs across its top,
 *             active panel content below.
 *   - Closed → rail is hidden entirely. ChatHeader's rail-toggle button reopens
 *             to the last-active tab.
 *   - Mobile (viewport < 720) → when open, the rail covers the chat as a
 *             full-width overlay so the panel is readable on phones.
 *
 * The legacy History drawer + Active-agents panel were retired here once the
 * Conversations rail became the default chat IA (ADR 0043) — the rail subsumes
 * both (history → the conversation list; active agents → the open conversation's
 * inline participants).
 */

import type { ComponentProps, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkflowProgressPanel } from '../workflowProgress/WorkflowProgressPanel.js';
import { ConversationsRail } from '../conversations/ConversationsRail.js';
import { ReviewInboxPanel } from '../reviews/ReviewInboxPanel.js';
import { MessageSquareIcon, WorkflowIcon, InboxIcon } from '../../ui/icons/index.js';

export type LeftRailTab = 'conversations' | 'progress' | 'reviews';

interface TabDescriptor {
  id: LeftRailTab;
  /** i18n key (namespace `chat`) for the tab label, translated at the render site. */
  labelKey: string;
  /** Tab glyph — a small inline-SVG component from `../icons`. */
  icon: ReactNode;
  /** Optional small numeric badge — total workflow runs. */
  badge?: number;
  /** Pre-translated accessible label for the badge (e.g. "reviews pending: 3").
   *  Falls back to the bare count when absent. */
  badgeLabel?: string;
}

interface Props {
  activeTab: LeftRailTab | null;
  /** Switch tabs, or close the rail by passing null. Clicking the
   *  already-active tab also closes — that's the rail's "collapse"
   *  gesture, handled inside the rail. */
  onSelectTab: (tab: LeftRailTab | null) => void;
  isMobile: boolean;

  /** Omit to drop the Conversations panel entirely (the multi-tab deck owns
   *  conversations via its tab strip + library picker, so its rail is Runs + Reviews
   *  only — ADR 0140). The standalone ChatSidebar always supplies it. */
  conversationsProps?: Omit<ComponentProps<typeof ConversationsRail>, 'onClose'>;
  progressProps: Omit<ComponentProps<typeof WorkflowProgressPanel>, 'onClose'>;
  reviewsProps: ComponentProps<typeof ReviewInboxPanel>;

  progressBadgeCount: number;
  /** Pending human-review count (ADR 0068/0070) — drives the Reviews tab badge. */
  reviewsBadgeCount: number;
}

export function LeftRail({
  activeTab,
  onSelectTab,
  isMobile,
  conversationsProps,
  progressProps,
  reviewsProps,
  progressBadgeCount,
  reviewsBadgeCount,
}: Props): JSX.Element | null {
  const { t } = useTranslation('chat');
  if (activeTab === null) return null;

  const tabs: TabDescriptor[] = [
    // The Conversations panel is optional — the multi-tab deck omits it (ADR 0140).
    ...(conversationsProps ? [{ id: 'conversations' as const, labelKey: 'tabConversations', icon: <MessageSquareIcon size={13} /> }] : []),
    { id: 'progress', labelKey: 'tabWorkflow', icon: <WorkflowIcon size={13} />, badge: progressBadgeCount },
    { id: 'reviews', labelKey: 'tabReviews', icon: <InboxIcon size={13} />, badge: reviewsBadgeCount, badgeLabel: t('reviewsBadgeA11y', { count: reviewsBadgeCount }) },
  ];

  const close = () => onSelectTab(null);

  return (
    <aside
      aria-label={t('chatToolsAside')}
      className={`leftrail-aside${isMobile ? ' leftrail-aside--mobile' : ''}`}
    >
      <TabStrip
        tabs={tabs}
        activeTab={activeTab}
        onSelectTab={(tab) => {
          if (tab === activeTab) {
            close();
          } else {
            onSelectTab(tab);
          }
        }}
      />
      <div
        id={`left-rail-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`left-rail-tab-${activeTab}`}
        className="u-flex-1 u-minh-0 u-flex u-flex-col"
      >
        {activeTab === 'conversations' && conversationsProps && (
          <ConversationsRail {...conversationsProps} onClose={close} />
        )}
        {activeTab === 'progress' && (
          <WorkflowProgressPanel {...progressProps} onClose={close} />
        )}
        {activeTab === 'reviews' && (
          <ReviewInboxPanel {...reviewsProps} />
        )}
      </div>
    </aside>
  );
}

function TabStrip({
  tabs,
  activeTab,
  onSelectTab,
}: {
  tabs: readonly TabDescriptor[];
  activeTab: LeftRailTab;
  onSelectTab: (tab: LeftRailTab) => void;
}): JSX.Element {
  const { t } = useTranslation('chat');
  // WAI-ARIA tablist roving: Arrow/Home/End move focus to and select another tab.
  const onTabKeyDown = (e: ReactKeyboardEvent) => {
    const i = tabs.findIndex((tab) => tab.id === activeTab);
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    const target = tabs[next];
    if (target && target.id !== activeTab) {
      onSelectTab(target.id);
      document.getElementById(`left-rail-tab-${target.id}`)?.focus();
    }
  };
  return (
    <div
      role="tablist"
      aria-label={t('chatToolTabs')}
      className="leftrail-tabstrip"
      onKeyDown={onTabKeyDown}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const label = t(tab.labelKey);
        return (
          <button
            key={tab.id}
            id={`left-rail-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`left-rail-panel-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelectTab(tab.id)}
            title={isActive ? t('tabCloseTitle', { label }) : t('tabSwitchTitle', { label })}
            className={`leftrail-tab${isActive ? ' is-active' : ''}`}
          >
            <span
              aria-hidden
              className="leftrail-tab-icon"
            >{tab.icon}</span>
            <span>{label}</span>
            {tab.badge !== undefined && tab.badge > 0 && (
              <span
                aria-label={tab.badgeLabel ?? `${tab.badge}`}
                className="leftrail-tab-badge"
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
