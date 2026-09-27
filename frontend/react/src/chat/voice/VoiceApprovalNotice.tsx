/**
 * A7 (ADR 0467 follow-on) — the chat-side card for a HELD voice tool call.
 *
 * The OpenAI sideband's tool loop is server-side (the browser is audio-only),
 * so its require-approval verdicts can't show the in-voice card the
 * browser-relay transport gets (#2386). Instead the sideband holds the call
 * and lands a `voice-approval-request` system notice in the conversation —
 * this card renders it with Approve/Deny. Authority is enforced server-side
 * (only the session opener may resolve); a stale card resolves to "gone".
 */
import { Button } from '../../ui/Button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MicIcon } from '../../ui/icons/index.js';
import { toast } from '../../ui/toast.js';
import { resolveHeldVoiceApproval } from './voiceClient.js';

export function VoiceApprovalNotice({ toolName, callId, fcId }: { toolName: string; callId: string; fcId: string }): JSX.Element {
  const { t } = useTranslation('chat');
  const [state, setState] = useState<'pending' | 'busy' | 'executed' | 'denied' | 'gone'>('pending');

  const resolve = async (approve: boolean): Promise<void> => {
    setState('busy');
    try {
      setState(await resolveHeldVoiceApproval(callId, fcId, approve));
    } catch (err) {
      setState('pending');
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (state === 'executed' || state === 'denied' || state === 'gone') {
    return (
      <div className="alert info msgbubble-system" role="status">
        <MicIcon size={12} aria-hidden />{' '}
        {t(state === 'executed' ? 'voiceHeldApprovalExecuted' : state === 'denied' ? 'voiceHeldApprovalDenied' : 'voiceHeldApprovalGone', { tool: toolName })}
      </div>
    );
  }
  return (
    <div className="alert warning msgbubble-system" role="alert">
      <div>
        <MicIcon size={12} aria-hidden /> {t('voiceApprovalBody', { tool: toolName })}
      </div>
      <div className="action-bar u-mt-2">
        <Button variant="primary" size="sm" disabled={state === 'busy'} aria-busy={state === 'busy'} onClick={() => void resolve(true)}>
          {t('voiceApprovalApprove')}
        </Button>
        <Button variant="quiet" size="sm" disabled={state === 'busy'} onClick={() => void resolve(false)}>
          {t('voiceApprovalDeny')}
        </Button>
      </div>
    </div>
  );
}
