/**
 * AI briefing tile (ADR 0577) — a read-only PROJECTION of a scheduled agent
 * chat's latest assistant turn, never a chat surface (the single-chat rule:
 * no composer here; the one action is opening the conversation in the ONE
 * chat). Config is a conversation POINTER in the self-scoped briefing row;
 * the excerpt renders through the chat feed's own MessageRenderer so the
 * markdown/trust pipeline is inherited, not re-implemented. Cadence lives in
 * scheduled-chats (server-side); the card chassis owns LazyMount + manual
 * refresh, so this tile fetches only on mount.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../../ui/Button.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import { MessageRenderer } from '../../../chat/MessageRenderer.js';
import { stageComposerDraft } from '../../../chat/composerSeed.js';
import { parsePersistedMessages } from '../../../chat/hooks/chatSession/lib.js';
import type { ChatMessage } from '../../../chat/hooks/useChatSession.js';
import { getChatSession, listChatSessionMessagesPage } from '../../../client/chatSessionsClient.js';
import { listScheduledChats, type ScheduledChat } from '../../../client/scheduledChatsClient.js';
import { getBriefingConfig, putBriefingConfig } from '../dashboardClient.js';
import { useOrgResource } from '../useOrgResource.js';
import type { DashboardTileProps } from '../tileTypes.js';

/** The projection's load result — every branch is a DESIGNED state. */
type Projection =
  | { kind: 'loading' }
  | { kind: 'unconfigured' }
  | { kind: 'error' }            // a failed read is a failed-read state, never an empty briefing
  | { kind: 'gone' }             // the configured conversation no longer exists → re-pick
  | { kind: 'not-run-yet'; conversationId: string }
  | { kind: 'ready'; conversationId: string; message: ChatMessage };

export default function AiBriefingTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const [projection, setProjection] = useState<Projection>({ kind: 'loading' });
  // The scheduled-chats list backs the PICKER (unconfigured / re-pick states).
  const scheduled = useOrgResource<ScheduledChat[]>((orgId) => listScheduledChats(orgId));
  const [pickId, setPickId] = useState('');
  const [saving, setSaving] = useState(false);

  const loadProjection = useCallback(async (conversationId: string): Promise<void> => {
    try {
      await getChatSession(conversationId); // throws on 404 → the gone state
    } catch {
      setProjection({ kind: 'gone' });
      return;
    }
    try {
      const page = await listChatSessionMessagesPage(conversationId, { limit: 10 });
      const parsed = parsePersistedMessages(page.messages);
      const latest = [...parsed].reverse().find((m) => m.role === 'assistant' && !m.meta?.deletedAt);
      setProjection(latest ? { kind: 'ready', conversationId, message: latest } : { kind: 'not-run-yet', conversationId });
    } catch {
      setProjection({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getBriefingConfig()
      .then((config) => {
        if (cancelled) return;
        if (!config) { setProjection({ kind: 'unconfigured' }); return; }
        void loadProjection(config.conversationId);
      })
      .catch(() => { if (!cancelled) setProjection({ kind: 'error' }); });
    return () => { cancelled = true; };
  }, [loadProjection]);

  const save = async (): Promise<void> => {
    if (!pickId) return;
    setSaving(true);
    try {
      await putBriefingConfig(pickId);
      setProjection({ kind: 'loading' });
      await loadProjection(pickId);
    } catch {
      setProjection({ kind: 'error' });
    } finally {
      setSaving(false);
    }
  };

  // ADR 0577 P2 — "create a Morning Briefing": creation is CHAT-FIRST (the
  // openwop:tasks.schedule-recurring agent tool), so the CTA seeds the ONE
  // chat's composer with the ask and deep-links there. No bespoke create form.
  const seedMorningBriefing = (): void => { stageComposerDraft(t('briefingSeedPrompt')); };

  if (projection.kind === 'loading') return <SkeletonRows rows={compact ? 3 : 4} columns={['40%', '90%', '75%']} />;
  if (projection.kind === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  if (projection.kind === 'unconfigured' || projection.kind === 'gone') {
    const chats = scheduled.status === 'ready' ? (scheduled.data ?? []) : [];
    return (
      <div className="u-flex u-flex-col u-gap-2">
        {projection.kind === 'gone' ? (
          <p className="dash-tile__state muted">{t('briefingGone')}</p>
        ) : null}
        {chats.length > 0 ? (
          <>
            <label className="u-label-sm" htmlFor="dash-briefing-pick">{t('briefingPickLabel')}</label>
            <select
              id="dash-briefing-pick"
              className="u-w-auto"
              value={pickId}
              onChange={(e) => setPickId(e.target.value)}
            >
              <option value="">{t('briefingPickPlaceholder')}</option>
              {chats.map((s) => (
                <option key={s.chatId} value={s.conversationId} title={s.prompt}>{s.agentId}</option>
              ))}
            </select>
            <div>
              <Button variant="secondary" onClick={() => { void save(); }} disabled={!pickId || saving}>
                {saving ? t('briefingSaving') : t('briefingSave')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="dash-tile__state muted">{t('briefingEmpty')}</p>
            <div>
              <Link to="/chat" className="btn secondary btn-sm" onClick={seedMorningBriefing}>
                {t('briefingCreateCta')}
              </Link>
            </div>
          </>
        )}
      </div>
    );
  }

  if (projection.kind === 'not-run-yet') {
    return (
      <div className="u-flex u-flex-col u-gap-2">
        <p className="dash-tile__state muted">{t('briefingNotRunYet')}</p>
        <div>
          <Link to={`/chat?conversation=${encodeURIComponent(projection.conversationId)}`} className="btn secondary btn-sm">
            {t('briefingOpen')}
          </Link>
        </div>
      </div>
    );
  }

  const { message, conversationId } = projection;
  const agentName = message.agentPersona ?? message.agentId ?? t('briefingAgentFallback');
  return (
    <div className="u-flex u-flex-col u-gap-2">
      {/* Provenance: this text is AGENT OUTPUT from a scheduled run — name the
          agent and the run time so the projection never reads as app copy. */}
      <p className="dash-tile__state muted u-m-0">
        <span className="chip">{agentName}</span>
        {message.createdAt ? <span className="u-ml-2">{formatRelativeTime(message.createdAt)}</span> : null}
      </p>
      <div className="dash-briefing__excerpt">
        <MessageRenderer content={message.content} markdown rendering={message.meta?.rendering} />
      </div>
      <div>
        <Link to={`/chat?conversation=${encodeURIComponent(conversationId)}`} className="btn secondary btn-sm">
          {t('briefingOpen')}
        </Link>
      </div>
    </div>
  );
}
