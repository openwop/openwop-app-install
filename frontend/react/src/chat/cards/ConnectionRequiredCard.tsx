/**
 * ADR 0189 Phase 2 — the connect-to-continue card, chat-feed surface.
 *
 * Backend suspends a connector node with `kind:'clarification'` +
 * `data.profile:'openwop-connection'` (host/connectionInterrupt.ts). The
 * clarification card in defaultCards.tsx discriminates on that profile and
 * renders THIS instead of the free-text answer field.
 *
 * The Connect/Continue/Skip UI + P9 connect launch lives in the shared
 * `interrupts/ConnectionRequiredControls` so the chat card and the
 * run-detail/inbox dialog can never drift; this wrapper supplies the chat
 * card shell (GateEyebrow + title) and adapts resume to `onAction('resolve')`.
 */
import { useTranslation } from 'react-i18next';
import { ConnectionRequiredControls } from '../../interrupts/ConnectionRequiredControls.js';
import type { CardProps } from '../registry/types.js';
import { GateEyebrow } from '../registry/defaultCards.js';

export function ConnectionRequiredCard({ payload, onAction, isLoading, context }: CardProps): JSX.Element {
  const { t } = useTranslation('chat');
  const data = (payload as { data?: unknown }).data;
  return (
    <div className="card u-bg-surface-2">
      <GateEyebrow name={context?.nodeName} />
      <h3 className="u-mbox-b2 u-fs-13">{t('connectionRequiredTitle')}</h3>
      <ConnectionRequiredControls
        data={data}
        busy={isLoading ?? false}
        onResolve={(value) => { void onAction('resolve', value); }}
      />
    </div>
  );
}
