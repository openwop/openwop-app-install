/**
 * Agent integrations panel (PRD §9 Integrations + §15) — task sources, real and
 * simulated. The Discord preview shows the example command and creates a simulated
 * Discord task on the agent's board so the source taxonomy is demonstrable
 * without a real integration. Future sources are clearly labeled.
 */

import { useState, type ComponentType, type CSSProperties } from 'react';
import { createCard } from '../kanban/kanbanClient.js';
import { Notice } from '../ui/Notice.js';
import { BotIcon, MessageCircleIcon, PlugIcon, SendIcon } from '../ui/icons/index.js';

type IconCmp = ComponentType<{ size?: number; strokeWidth?: number; style?: CSSProperties }>;

interface SourceRow {
  name: string;
  Icon: IconCmp;
  status: 'demo' | 'planned';
  blurb: string;
}

const SOURCES: ReadonlyArray<SourceRow> = [
  { name: 'Discord', Icon: MessageCircleIcon, status: 'demo', blurb: 'Teammates assign work from chat with a slash command.' },
  { name: 'Slack', Icon: MessageCircleIcon, status: 'planned', blurb: 'Assign tasks from a Slack channel or DM.' },
  { name: 'Email', Icon: SendIcon, status: 'planned', blurb: 'Forward an email to create a task.' },
  { name: 'Webhook / API', Icon: PlugIcon, status: 'planned', blurb: 'Create tasks programmatically from your systems.' },
  { name: 'Other agents', Icon: BotIcon, status: 'demo', blurb: 'One agent assigns a task to another.' },
];

export function AgentIntegrationsPanel({ boardId, persona, onChanged }: { boardId: string | null; persona: string; onChanged?: () => void }): JSX.Element {
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
      setNotice(`Created a To Do task on ${persona}'s board from a simulated Discord command.`);
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
        Work can arrive on {persona}'s board from humans, workflows, other agents, chat tools, schedules, or APIs.
      </p>

      <div className="agentintg-card">
        <div className="u-flex u-items-center u-gap-2">
          <strong className="u-iflex u-items-center u-gap-1"><MessageCircleIcon size={16} /> Discord</strong>
          <span className="chip chip--warning">Simulated</span>
        </div>
        <p className="u-fs-14">
          In Discord, <code>/assign @{handle} "Follow up with ACME on renewal"</code> creates a To Do card on {persona}'s board.
          {' '}{persona}'s heartbeat then picks it up and runs the matching workflow.
        </p>
        <div className="u-flex u-gap-1-5 u-wrap">
          <input
            value={discordTask}
            onChange={(e) => setDiscordTask(e.target.value)}
            placeholder={`Follow up with ACME on renewal`}
            className="agentintg-discord-input"
            disabled={!boardId}
          />
          <button type="button" className="primary" onClick={() => void onCreateDiscord()} disabled={!boardId || !discordTask.trim()}>
            Create simulated Discord task
          </button>
        </div>
        {!boardId ? <p className="muted u-fs-12">Create this agent's board first.</p> : null}
      </div>

      <strong className="u-fs-14">All task sources</strong>
      <ul className="agentintg-list">
        {SOURCES.map((s) => (
          <li key={s.name} className="agentintg-source-row">
            <span className="muted u-iflex"><s.Icon size={16} /></span>
            <span className="agentintg-source-name">{s.name}</span>
            <span className="muted u-fs-13 u-flex-1">{s.blurb}</span>
            <span className={`chip ${s.status === 'demo' ? 'chip--success' : 'chip--muted'}`}>
              {s.status === 'demo' ? 'Preview' : 'Planned'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
