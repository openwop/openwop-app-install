/**
 * "Describe your agent" panel (ADR 0514 P3) — the create wizard's entry into
 * AI agent authoring. It does NOT implement a chat or a BYOK gate: it owns
 * only its drawer chrome (heading + Close) and delegates the AI surface to the
 * shared <EmbeddedChatPanel> (chat/), supplying the Agent Author agent + a
 * context-aware empty state. The Agent Author drafts + creates the roster
 * entry via its node pack; the created agent lands DISABLED and the user
 * reviews it on /agents.
 *
 * EmbeddedChatPanel is **lazy-imported** from `chat/`: chat/ imports agents/
 * (roster surfaces), so a static agents→chat edge would create a cycle — the
 * dynamic import is a separate chunk (the CreateWithAiPanel precedent).
 *
 * @see docs/adr/0514-agent-author-describe-to-create.md
 */

import { lazy, Suspense } from 'react';
import { Button } from '../ui/Button.js';
import { useTranslation } from 'react-i18next';

const EmbeddedChatPanel = lazy(() =>
  import('../chat/EmbeddedChatPanel.js').then((m) => ({ default: m.EmbeddedChatPanel })),
);

/** The agent the wizard's describe-to-create scopes the chat to (ADR 0514 pack). */
const AGENT_AUTHOR_AGENT_ID = 'feature.agent-author.agents.agent-author';

function AgentAuthorWelcome({ onPick }: { onPick: (text: string) => void }): JSX.Element {
  const { t } = useTranslation('agents');
  const examples = [t('authorExample1'), t('authorExample2'), t('authorExample3')];
  return (
    <div className="u-flex u-flex-col u-gap-2">
      <p className="muted u-fs-13 u-m-0">{t('authorWelcome')}</p>
      <div className="u-flex u-flex-col u-gap-1">
        {examples.map((ex) => (
          <Button key={ex} variant="quiet" className="u-text-left u-fs-13" onClick={() => onPick(ex)}>
            {ex}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function AgentAuthorPanel({ onClose }: { onClose(): void }): JSX.Element {
  const { t } = useTranslation('agents');
  return (
    <div className="surface-card u-flex u-flex-col u-minh-0 u-gap-2" role="region" aria-label={t('authorPanelHeading')}>
      <div className="u-flex u-items-center u-justify-between u-gap-2">
        <h3 className="u-m-0">{t('authorPanelHeading')}</h3>
        <Button variant="secondary" size="sm" onClick={onClose}>{t('authorClose')}</Button>
      </div>
      {/* The lands-DISABLED contract, stated up front — the user should never
          be surprised that the created agent is not yet active. */}
      <p className="muted u-fs-13 u-m-0">{t('authorPanelHint')}</p>
      <Suspense fallback={<div className="muted u-fs-13 u-p-3">{t('authorLoading')}</div>}>
        <EmbeddedChatPanel
          agentId={AGENT_AUTHOR_AGENT_ID}
          renderEmptyState={(onPick) => <AgentAuthorWelcome onPick={onPick} />}
        />
      </Suspense>
    </div>
  );
}
