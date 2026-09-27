/**
 * MembersPane (ADR 0140 follow-on) — the right-docked "who's in this conversation"
 * panel, shared by BOTH chat surfaces (the multi-tab deck's `TabSession` and the
 * standalone `ChatSidebar`).
 *
 * Competitive analysis (Discord/Slack/Teams/Zoom — 4/5) puts the active
 * conversation's member list in a RIGHT contextual pane opened from a header
 * affordance, NOT in the left rail (which stays the single navigation axis: the
 * conversation LIST). This pane is that right-hand detail surface.
 *
 * It is presentational — driven by whatever `activeAgents` / channel roster the
 * host passes in. The deck renders it per-tab (no cross-tab state lifting); the
 * sidebar renders it for its single active session. Reuses the same rail-variant
 * roster components both surfaces used before, so they stay visually identical.
 */

import { Button } from '../../ui/Button.js';
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { ConversationLineup } from './ConversationLineup.js';
import type { ActiveAgentRow } from '../activeAgents/types.js';
import type { ChannelRosterEntry } from '../../client/channelsClient.js';
import { XIcon } from '../../ui/icons/index.js';

const ChannelRosterPanel = lazy(() => import('./ChannelRosterPanel.js').then((m) => ({ default: m.ChannelRosterPanel })));
const ChannelPresenceBar = lazy(() => import('./ChannelPresenceBar.js').then((m) => ({ default: m.ChannelPresenceBar })));

interface Props {
  isChannel: boolean;
  channelId: string;
  /** Agent lineup (non-channel conversations). */
  lineup: readonly ActiveAgentRow[];
  currentAgentId: string;
  thinkingAgentId: string | null;
  /** ADR 0304 — the live-boardroom floor (the agent being voiced right now). */
  speakingAgentId?: string | null;
  onSwitchAgent: (agentId: string) => void;
  onRemoveAgent: (agentId: string) => void;
  /** Channel roster (channel conversations). */
  channelRoster?: {
    roster: readonly ChannelRosterEntry[];
    viewerIsOwner: boolean;
    viewerSubjectRef: string | null;
    onManage: () => void;
    onLeave: () => void;
  };
  onClose: () => void;
}

export function MembersPane({
  isChannel,
  channelId,
  lineup,
  currentAgentId,
  thinkingAgentId,
  speakingAgentId = null,
  onSwitchAgent,
  onRemoveAgent,
  channelRoster,
  onClose,
}: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const headingId = 'members-pane-heading';
  return (
    <aside
      id="members-pane"
      className="members-pane"
      aria-labelledby={headingId}
    >
      <header className="members-pane__head">
        <strong id={headingId} className="u-flex-1 u-fs-13">{t('inThisConversation')}</strong>
        <Button
          variant="secondary" className="sesshist-mini-btn"
          onClick={onClose}
          aria-label={t('closeMembers')}
        >
          <XIcon size={14} />
        </Button>
      </header>
      <div className="u-flex-1 u-minh-0 u-overflow-y-auto">
        {isChannel && channelRoster ? (
          <Suspense fallback={null}>
            <ChannelPresenceBar channelId={channelId} />
            <ChannelRosterPanel
              roster={channelRoster.roster}
              viewerIsOwner={channelRoster.viewerIsOwner}
              viewerSubjectRef={channelRoster.viewerSubjectRef}
              onManage={channelRoster.onManage}
              onLeave={channelRoster.onLeave}
            />
          </Suspense>
        ) : (
          <ConversationLineup
            lineup={lineup}
            currentAgentId={currentAgentId}
            thinkingAgentId={thinkingAgentId}
            speakingAgentId={speakingAgentId}
            onSwitchAgent={onSwitchAgent}
            onRemoveAgent={onRemoveAgent}
          />
        )}
      </div>
    </aside>
  );
}
