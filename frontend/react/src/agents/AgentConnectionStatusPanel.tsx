/**
 * Agent connection-status surface (ADR 0033 §3.3 / T3.3).
 *
 * The honest "can this twin act?" view: which of the agent's
 * `requiredConnections` (ADR 0031 `agentProfile`) are configured vs missing,
 * and the effective autonomy after the fail-closed activation gate. When a
 * required connection is unconfigured the backend forces `review` (propose,
 * never auto-act) — this panel renders that as the advertised `supported:false`
 * signal so a viewer sees exactly why a twin is held at draft/recommend.
 *
 * Cohesion: reuses the shared `chip`/`Notice`/`StateCard` layer, the Lucide
 * icon set, and token-driven utility classes only (no raw hex) per DESIGN.md.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { getConnectionReadiness, type ConnectionReadiness } from './rosterClient.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { CheckIcon, XIcon, ClockIcon, PlugIcon } from '../ui/icons/index.js';

const AUTONOMY_LABEL_KEY: Record<ConnectionReadiness['gatedAutonomy'], string> = {
  auto: 'connActs',
  guided: 'connActsGuardrails',
  review: 'connProposes',
};

function ProviderChip({ provider, configured, status, t }: ConnectionReadiness['entries'][number] & { t: TFunction }): JSX.Element {
  if (configured) {
    return (
      <span className="chip chip--success u-iflex u-items-center u-gap-1">
        <CheckIcon size={13} /> {provider}
      </span>
    );
  }
  // A connection exists but isn't active (needs-reconsent / expired / revoked):
  // distinct from "missing" so the fix is obvious (reconnect vs connect).
  if (status) {
    return (
      <span className="chip chip--warning u-iflex u-items-center u-gap-1">
        <ClockIcon size={13} /> {t('connProviderStatus', { provider, status })}
      </span>
    );
  }
  return (
    <span className="chip chip--danger u-iflex u-items-center u-gap-1">
      <XIcon size={13} /> {t('connNotConnected', { provider })}
    </span>
  );
}

export function AgentConnectionStatusPanel({ rosterId }: { rosterId: string }): JSX.Element {
  const { t } = useTranslation('agents');
  const [readiness, setReadiness] = useState<ConnectionReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getConnectionReadiness(rosterId)
      .then((r) => { if (!cancelled) { setReadiness(r); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rosterId]);

  if (loading) return <p className="muted u-mt-0">{t('connChecking')}</p>;
  if (error) return <Notice variant="error">{error}</Notice>;
  if (!readiness) return <></>;

  if (readiness.required.length === 0) {
    return (
      <StateCard
        icon={<PlugIcon size={20} />}
        title={t('connNoneTitle')}
        body={t('connNoneBody')}
      />
    );
  }

  const { allConfigured, effective, declaredAutonomy, gatedAutonomy, entries, missing } = readiness;

  return (
    <div className="u-flex u-flex-col u-gap-3">
      {allConfigured ? (
        <Notice variant="success">
          {t('connAllConfigured', { autonomy: t(AUTONOMY_LABEL_KEY[gatedAutonomy]).toLowerCase() })}
        </Notice>
      ) : (
        <Notice variant="warning">
          {t('connNotReady', { count: missing.length, missing: missing.length, total: readiness.required.length, declared: t(AUTONOMY_LABEL_KEY[declaredAutonomy]) })}
        </Notice>
      )}

      <div className="u-flex u-flex-wrap u-gap-2" aria-label={t('connRequiredLabel')}>
        {entries.map((e) => <ProviderChip key={e.provider} {...e} t={t} />)}
      </div>

      <p className="muted u-fs-13 u-mt-0">
        {t('connEffective')} <strong>{t(AUTONOMY_LABEL_KEY[gatedAutonomy])}</strong>
        {effective.acting ? '' : t('connDraftOnly')}
      </p>
    </div>
  );
}
