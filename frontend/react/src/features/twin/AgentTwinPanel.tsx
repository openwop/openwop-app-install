/**
 * Agent "Twin of …" affordance (ADR 0044, Phase 3) — shown on an agent's profile
 * when the `twin-recall` toggle is on. Surfaces the agent↔person LINK (admin
 * link/unlink) and, when the viewer IS the linked person, the GRANT controls that
 * let the agent recall the viewer's memory/knowledge. Self-gates on the toggle
 * (renders nothing when off) so the mount can stay unconditional.
 *
 * Link ≠ grant: linking says "this agent is your twin"; only YOU (the linked
 * person) can then allow it to recall your corpus, per scope. Fail-closed.
 */
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { Notice } from '../../ui/Notice.js';
import { CheckboxField } from '../../ui/Field.js';
import { SparklesIcon, UserIcon, ShieldIcon } from '../../ui/icons/index.js';
import { getMyProfile, getProfile } from '../profiles/profilesClient.js';
import {
  getAgentTwin, linkTwinToUser, unlinkTwin, grantRecall, revokeRecall,
  type AgentTwinView, type TwinScope,
} from './twinClient.js';

const ALL_SCOPES: TwinScope[] = ['memory', 'knowledge'];

export function AgentTwinPanel({ rosterId, persona }: { rosterId: string; persona: string }): JSX.Element | null {
  const { t } = useTranslation('twin');
  const access = useFeatureAccess('twin-recall');
  const [view, setView] = useState<AgentTwinView | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [linkedName, setLinkedName] = useState<string | null>(null);
  const [scopes, setScopes] = useState<Set<TwinScope>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!access.enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const [v, me] = await Promise.all([getAgentTwin(rosterId), getMyProfile().catch(() => null)]);
        if (cancelled) return;
        setView(v);
        setMyUserId(me?.userId ?? null);
        setScopes(new Set(v.grant?.scopes ?? []));
        // Resolve a friendly name for a link to SOMEONE ELSE (the self case shows
        // "you"). Best-effort — falls back to the opaque id if the lookup fails.
        if (v.link && v.link.userId !== me?.userId) {
          const name = await getProfile(v.link.userId).then((p) => p.displayName ?? null).catch(() => null);
          if (!cancelled) setLinkedName(name);
        } else if (!cancelled) {
          setLinkedName(null);
        }
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : t('failedToLoadTwinLink')); }
    })();
    return () => { cancelled = true; };
  }, [access.enabled, rosterId, t]);

  if (!access.enabled) return null;

  const run = async (op: () => Promise<void>, ok: string): Promise<void> => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await op();
      setView(await getAgentTwin(rosterId));
      setNotice(ok);
    } catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  };

  const link = view?.link ?? null;
  const isMine = !!link && !!myUserId && link.userId === myUserId;
  const toggleScope = (s: TwinScope): void => setScopes((prev) => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; });

  return (
    <div className="surface-card u-flex u-flex-col u-gap-3 u-mt-4">
      <span className="u-flex u-items-center u-gap-2"><SparklesIcon size={16} /> <strong>{t('digitalTwin')}</strong></span>
      <p className="muted u-fs-13 u-m-0">
        <Trans t={t} i18nKey="panelIntro" values={{ persona }} components={{ 0: <strong /> }} />
      </p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}

      {view === null ? (
        <p className="muted u-fs-13 u-m-0">{t('loading')}</p>
      ) : !link ? (
        <div className="action-bar u-gap-2">
          <span className="muted u-fs-13">{t('notTwinYet', { persona })}</span>
          <button type="button" className="primary btn-sm" disabled={busy || !myUserId}
            onClick={() => void run(() => linkTwinToUser(rosterId, myUserId!).then(() => undefined), t('nowYourTwin', { persona }))}>
            {t('makeTwinOfMe', { persona })}
          </button>
        </div>
      ) : (
        <div className="u-flex u-flex-col u-gap-3">
          <div className="action-bar u-justify-between u-items-center">
            <span className="u-flex u-items-center u-gap-2">
              <UserIcon size={14} />
              {isMine
                ? <Trans t={t} i18nKey="twinOfYou" components={{ 0: <strong /> }} />
                : <>{t('twinOfPerson')} <span className="chip chip--muted">{linkedName ?? link.userId}</span></>}
            </span>
            <button type="button" className="ghost btn-sm" disabled={busy}
              onClick={() => void run(() => unlinkTwin(rosterId), t('twinLinkRemoved'))}>{t('unlink')}</button>
          </div>

          {isMine ? (
            <div className="surface-card u-flex u-flex-col u-gap-2">
              <span className="u-flex u-items-center u-gap-2"><ShieldIcon size={14} /> <strong>{t('allowRecallHeading', { persona })}</strong></span>
              <div className="action-bar u-gap-3">
                {ALL_SCOPES.map((s) => (
                  <CheckboxField
                    key={s}
                    label={s === 'memory' ? t('scopeMemory') : t('scopeKnowledge')}
                    checked={scopes.has(s)}
                    disabled={busy}
                    onChange={() => toggleScope(s)}
                  />
                ))}
              </div>
              <div className="action-bar u-gap-2">
                <button type="button" className="primary btn-sm" disabled={busy || scopes.size === 0}
                  onClick={() => void run(() => grantRecall(rosterId, [...scopes]), t('recallConsentSaved'))}>
                  {view.grant ? t('updateConsent') : t('allowRecall')}
                </button>
                {view.grant ? (
                  <button type="button" className="ghost btn-sm" disabled={busy}
                    onClick={() => void run(() => revokeRecall(rosterId).then(() => { setScopes(new Set()); }), t('recallRevoked'))}>
                    {t('revokeRecall')}
                  </button>
                ) : null}
              </div>
              <p className="muted u-fs-12 u-m-0">
                {view.grant
                  ? t('recallActive', {
                      persona,
                      scopes: view.grant.scopes
                        .map((s) => (s === 'memory' ? t('scopeMemory') : t('scopeKnowledge')))
                        .join(' + ') || t('recallActiveNothing'),
                    })
                  : t('noRecallGranted', { persona })}
              </p>
            </div>
          ) : (
            <p className="muted u-fs-12 u-m-0">{t('onlyLinkedCanAllow', { name: linkedName ?? link.userId, persona })}</p>
          )}
        </div>
      )}
    </div>
  );
}
