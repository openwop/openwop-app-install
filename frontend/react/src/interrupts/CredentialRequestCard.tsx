/**
 * ADR 1125 D1 — a `credential` request (RFC 0199 §C): the run needs the person to
 * connect a provider. One primary action, "Connect".
 *
 * The link is BUILT HERE from the run and node ids, to the host's own connect
 * route (`features/connections/routes.ts`, the same URL `connectUrlFor` issues).
 * `data.connectUrl` is never followed: a pack can raise this kind with any data,
 * and an inbox button is no place for a link someone else chose. The provider
 * name is shown as text only, bounded.
 */
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { config } from '../client/config.js';

interface Props {
  runId: string;
  nodeId: string;
  data: unknown;
}

/** The host connect route for this request, relative to the API base. */
export function hostConnectUrl(runId: string, nodeId: string, baseUrl: string = config.baseUrl): string {
  return `${baseUrl.replace(/\/+$/, '')}/host/openwop-app/connections/connect/${encodeURIComponent(runId)}/${encodeURIComponent(nodeId)}`;
}

export function CredentialRequestCard({ runId, nodeId, data }: Props): JSX.Element {
  const { t } = useTranslation('interrupts');
  const d = (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as { provider?: unknown };
  const provider = typeof d.provider === 'string' && d.provider.trim() ? d.provider.trim().slice(0, 60) : undefined;
  return (
    <div role="group" aria-label={t('credentialTitle', { provider: provider ?? t('credentialAnAccount') })} className="u-grid u-gap-2">
      <p className="u-m-0">{t('credentialBody', { provider: provider ?? t('credentialAnAccount') })}</p>
      <div className="action-bar">
        <Button variant="primary" onClick={() => { window.open(hostConnectUrl(runId, nodeId), '_blank', 'noopener,noreferrer'); }}>
          {t('credentialConnect')}
        </Button>
      </div>
    </div>
  );
}
