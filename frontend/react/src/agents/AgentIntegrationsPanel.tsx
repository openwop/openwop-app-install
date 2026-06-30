/**
 * Agent integrations panel (PRD §9 Integrations + §15) — task sources, real and
 * simulated. The Discord preview shows the example command and creates a simulated
 * Discord task on the agent's board so the source taxonomy is demonstrable
 * without a real integration. Future sources are clearly labeled.
 */

import { useState, type ComponentType, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { createCard } from '../kanban/kanbanClient.js';
import { Notice } from '../ui/Notice.js';
import { BotIcon, MessageCircleIcon, PlugIcon, SendIcon } from '../ui/icons/index.js';

type IconCmp = ComponentType<{ size?: number; strokeWidth?: number; style?: CSSProperties }>;

interface SourceRow {
  nameKey: string;
  Icon: IconCmp;
  status: 'demo' | 'planned';
  blurbKey: string;
}

const SOURCES: ReadonlyArray<SourceRow> = [
  { nameKey: 'sourceDiscord', Icon: MessageCircleIcon, status: 'demo', blurbKey: 'intgDiscordBlurb' },
  { nameKey: 'intgSlack', Icon: MessageCircleIcon, status: 'planned', blurbKey: 'intgSlackBlurb' },
  { nameKey: 'intgEmail', Icon: SendIcon, status: 'planned', blurbKey: 'intgEmailBlurb' },
  { nameKey: 'intgWebhook', Icon: PlugIcon, status: 'planned', blurbKey: 'intgWebhookBlurb' },
  { nameKey: 'intgOtherAgents', Icon: BotIcon, status: 'demo', blurbKey: 'intgOtherAgentsBlurb' },
];

export function AgentIntegrationsPanel({ boardId, persona, onChanged }: { boardId: string | null; persona: string; onChanged?: () => void }): JSX.Element {
  const { t } = useTranslation('agents');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [discordTask, setDiscordTask] = useState('');

  const handle = persona.toLowerCase();

  const onCreateDiscord = async () => {
    if (!boardId || !discordTask.trim()) return;
    setError(null);
    try {
      await createCard(boardId, {
        title: discordTask.trim(),
        columnId: 'todo',
        source: 'discord',
        sourceLabel: `/assign @${handle}`,
      });
      setNotice(t('intgDiscordCreated', { persona }));
      setDiscordTask('');
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="agentintg-root">
      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}

      <p className="muted u-mt-0">
        {t('intgWorkSources', { persona })}
      </p>

      <div className="agentintg-card">
        <div className="u-flex u-items-center u-gap-2">
          <strong className="u-iflex u-items-center u-gap-1"><MessageCircleIcon size={16} /> {t('sourceDiscord')}</strong>
          <span className="chip chip--warning">{t('intgSimulated')}</span>
        </div>
        <p className="u-fs-14">
          {t('intgDiscordExplainer', { command: `/assign @${handle} "${t('intgDiscordPlaceholder')}"`, persona })}
        </p>
        <div className="u-flex u-gap-1-5 u-wrap">
          <input
            value={discordTask}
            onChange={(e) => setDiscordTask(e.target.value)}
            placeholder={t('intgDiscordPlaceholder')}
            className="agentintg-discord-input"
            disabled={!boardId}
          />
          <button type="button" className="primary" onClick={() => void onCreateDiscord()} disabled={!boardId || !discordTask.trim()}>
            {t('intgCreateDiscordTask')}
          </button>
        </div>
        {!boardId ? <p className="muted u-fs-12">{t('intgCreateBoardFirst')}</p> : null}
      </div>

      <strong className="u-fs-14">{t('intgAllSources')}</strong>
      <ul className="agentintg-list">
        {SOURCES.map((s) => (
          <li key={s.nameKey} className="agentintg-source-row">
            <span className="muted u-iflex"><s.Icon size={16} /></span>
            <span className="agentintg-source-name">{t(s.nameKey)}</span>
            <span className="muted u-fs-13 u-flex-1">{t(s.blurbKey)}</span>
            <span className={`chip ${s.status === 'demo' ? 'chip--success' : 'chip--muted'}`}>
              {s.status === 'demo' ? t('intgPreview') : t('intgPlanned')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
