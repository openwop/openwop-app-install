/**
 * ADR 0948 P3a (D5) — the Funnel Architect on the Funnels page.
 *
 * No second chat: the shared `chat/ChatPocket` (ADR 0768 P5, the house pattern for a
 * feature page's assistant) around the ONE `EmbeddedChatPanel`, scoped to the architect.
 * The pocket is a bounded, non-modal popover, so it neither grows the page nor unmounts
 * when the first funnel appears; the page keys it by org (a new org is a new
 * conversation) and refreshes its list after every turn.
 *
 * The starter prompts' LABELS name the organization; what they SEND also carries its id,
 * because the architect's tools need `orgId` when a workspace has several organizations.
 * They promise only what works today: generation needs an installed blueprint, so that
 * prompt says so. The architect drafts and never publishes.
 */
import { useTranslation } from 'react-i18next';
import { ChatPocket } from '../../chat/ChatPocket.js';
import { Button } from '../../ui/Button.js';

export const FUNNEL_ARCHITECT_AGENT_ID = 'vendor.openwop-app.funnels.agents.funnel-architect';

const PROMPTS = ['Blueprints', 'Draft', 'FromBrief'] as const;

export function FunnelArchitectPocket({ orgId, orgName, defaultOpen, onTurnSettled }: {
  orgId: string;
  orgName: string | undefined;
  defaultOpen: boolean;
  onTurnSettled: () => void;
}): JSX.Element {
  const { t } = useTranslation('funnels');
  const org = orgName ?? t('architectThisOrg');
  return (
    <ChatPocket
      agentId={FUNNEL_ARCHITECT_AGENT_ID}
      title={t('architectTitle')}
      contextLabel={t('architectContext', { org })}
      defaultOpen={defaultOpen}
      onTurnSettled={onTurnSettled}
      renderEmptyState={(onPick) => (
        <div className="u-flex u-flex-col u-gap-1">
          <p className="chat-pocket__hint">{t('architectBody')}</p>
          {PROMPTS.map((k) => (
            <Button key={k} variant="quiet" className="u-text-left u-fs-13"
              onClick={() => onPick(`${t(`architectPrompt${k}`, { org })} ${t('architectOrgRef', { orgId })}`)}>
              {t(`architectPrompt${k}`, { org })}
            </Button>
          ))}
        </div>
      )}
    />
  );
}
