/**
 * "Who can recall my memory" tab (ADR 0044, Phase 3) — the user's consent
 * dashboard: every agent the user has granted twin-recall, the scopes it may
 * read, and one-click revoke. Granting happens on the agent ("Twin of you ·
 * Allow recall"); this is the place to review + withdraw it. Shown on My Profile
 * only when the `twin-recall` toggle is on (ProfilePage gates the tab).
 */
import { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SparklesIcon, TrashIcon } from '../../ui/icons/index.js';
import { listRoster } from '../../agents/rosterClient.js';
import { listMyGrants, revokeRecall, type MyTwinGrant } from './twinClient.js';

export function ProfileTwinGrantsTab(): JSX.Element {
  const { t } = useTranslation('twin');
  const [grants, setGrants] = useState<MyTwinGrant[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const [g, roster] = await Promise.all([listMyGrants(), listRoster().catch(() => [])]);
    // `listGrantsForUser` returns the full history (active + revoked); the consent
    // dashboard shows only what's currently in force.
    setGrants(g.filter((x) => x.status !== 'revoked'));
    setNames(Object.fromEntries(roster.map((r) => [r.rosterId, r.persona])));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('failedToLoadGrants')); });
    return () => { cancelled = true; };
  }, [load, t]);

  const onRevoke = async (agentId: string): Promise<void> => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await revokeRecall(agentId);
      await load();
      setNotice(t('recallRevokedEverywhere'));
    } catch (e) { setError(e instanceof Error ? e.message : t('revokeFailed')); }
    finally { setBusy(false); }
  };

  return (
    <div className="u-flex u-flex-col u-gap-3">
      <p className="muted u-fs-13 u-m-0">
        <Trans t={t} i18nKey="grantsIntro" components={{ 0: <strong /> }} />
      </p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}

      {grants === null ? (
        <StateCard icon={<SparklesIcon size={20} />} title={t('loading')} loading />
      ) : grants.length === 0 ? (
        <StateCard icon={<SparklesIcon size={20} />} title={t('noAgentTitle')} body={t('noAgentBody')} />
      ) : (
        <ul className="u-flex u-flex-col u-gap-2 u-m-0 u-p-0" style={{ listStyle: 'none' }}>
          {grants.map((g) => (
            <li key={g.agentId} className="surface-card action-bar u-justify-between u-items-center">
              <span className="u-flex u-flex-col u-gap-1">
                <strong>{names[g.agentId] ?? g.agentId}</strong>
                <span className="u-flex u-items-center u-gap-1">
                  {g.scopes.length
                    ? g.scopes.map((s) => <span key={s} className="chip chip--accent u-fs-12">{s === 'memory' ? t('scopeMemory') : s === 'knowledge' ? t('scopeKnowledge') : s}</span>)
                    : <span className="chip chip--muted u-fs-12">{t('noScopes')}</span>}
                </span>
              </span>
              <button type="button" className="ghost btn-sm" disabled={busy} onClick={() => void onRevoke(g.agentId)}>
                <TrashIcon size={14} /> {t('revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
