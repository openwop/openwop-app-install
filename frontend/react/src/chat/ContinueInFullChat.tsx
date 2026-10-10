/**
 * ContinueInFullChat — ADR 0768 P4 ("every small chat can grow").
 *
 * The one handoff from an embedded (Dock / Pocket) conversation to the full
 * chat. Promotes the ephemeral conversation on click only (see
 * `lib/promoteConversation`), then deep-links `/?conversation=<id>`; the full
 * chat's fresh session list contains the new row, so its deep-link handler
 * opens it. On failure it stays put and says why — it never navigates to a
 * conversation that was only partly written.
 */

import { useState } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { announce } from '../ui/announce.js';
import { ArrowUpRightIcon } from '../ui/icons/index.js';
import { promoteConversation, type PromotableSession } from './lib/promoteConversation.js';

interface Props {
  session: PromotableSession;
  agentId?: string;
  /** A turn is in flight — its reply is not settled yet, so wait. */
  disabled?: boolean;
}

/** Only inside a router: the handoff IS a navigation. An embed hosted outside
 *  one (isolated test hosts) simply offers no handoff rather than crashing. */
export function ContinueInFullChat(props: Props): JSX.Element | null {
  return useInRouterContext() ? <HandoffControl {...props} /> : null;
}

function HandoffControl({ session, agentId, disabled }: Props): JSX.Element | null {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (session.messages.length === 0) return null;

  async function handoff(): Promise<void> {
    setBusy(true);
    setFailed(false);
    try {
      const id = await promoteConversation(session, agentId);
      navigate(`/?conversation=${encodeURIComponent(id)}`);
    } catch {
      setFailed(true);
      setBusy(false);
      // The visible note mounts WITH its text; the imperative announcer is what a
      // screen reader reliably hears (the live-region-mounted-with-content class).
      announce(t('handoffFailed'), { assertive: true });
    }
  }

  return (
    <div className="continue-full-chat">
      {failed ? (
        <span className="continue-full-chat__error">{t('handoffFailed')}</span>
      ) : null}
      <Button
        variant="link"
        size="sm"
        onClick={() => { void handoff(); }}
        disabled={disabled || busy}
        loading={busy}
        title={disabled ? t('handoffWaitTitle') : t('handoffTitle')}
      >
        {t('handoffLabel')} <ArrowUpRightIcon size={12} />
      </Button>
    </div>
  );
}
