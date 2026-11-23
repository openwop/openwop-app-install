/**
 * ADR 1136 P3b (D8) — one browser session's trajectory. Every step is shown as a
 * HOST label (the action kind, its tier, who decided it) with the site's host and
 * path. The executor's page-derived label is a fenced, labelled note, never copy,
 * and nothing typed reaches this page: the backend projection drops query
 * strings and never carries a field value.
 *
 * A session that is waiting says on which site, and where to answer (the Inbox).
 * A session that ended `browser_not_connected` shows the Connect-a-browser card.
 * Stopping is the one write, and it is the safe direction.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { Panel } from '../../ui/layout.js';
import { Button } from '../../ui/Button.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { formatDateTime, formatRelativeTime } from '../../i18n/format.js';
import { ComputerUseApiError, getSession, hostOf, isLiveStatus, stopSession, type SessionDetail, type SessionStep } from './computerUseClient.js';
import { SessionStatusBadge } from './SessionStatusBadge.js';

/** Errors this page explains in its own words; anything else shows its code. */
const KNOWN_ERRORS = new Set(['browser_not_connected', 'credential_entry_unsupported', 'takeover_limit_reached', 'takeover_expired', 'aborted_by_user']);

function StepRow({ step, index }: { step: SessionStep; index: number }): JSX.Element {
  const { t } = useTranslation('computer-use');
  const signedIn = step.kind === 'credential' && step.decidedBy === 'human';
  const where = step.url ? (() => { try { const u = new URL(step.url); return `${u.host}${u.pathname === '/' ? '' : u.pathname}`; } catch { return ''; } })() : '';
  return (
    <li className="u-grid u-gap-1" data-testid="cu-step">
      <div className="u-flex u-gap-2 u-items-center u-flex-wrap">
        <span className="muted u-text-sm">{index + 1}.</span>
        {signedIn ? (
          // ADR 1136 P3b — a take-over: the person signed in themselves. Host text
          // and the reported host only; nothing they typed is known to the host.
          <strong>{t('signedInOn', { host: hostOf(step.url) })}</strong>
        ) : (
          <>
            <strong>{t(`kind_${step.kind}`, { defaultValue: step.kind })}</strong>
            {where ? <span className="muted u-text-sm">{where}</span> : null}
          </>
        )}
        <span className="chip">{t(`tier_${step.tier}`, { defaultValue: step.tier })}</span>
        <span className="muted u-text-sm">{t(`decided_${step.decidedBy}`, { defaultValue: step.decidedBy })} · {t('stepAt', { time: formatDateTime(step.at, { timeStyle: 'medium' }) })}</span>
      </div>
      {step.description ? (
        <p className="muted u-text-sm">{t('pageLabelNote')} <q>{step.description.slice(0, 160)}</q></p>
      ) : null}
    </li>
  );
}

export function ComputerUseSessionPage(): JSX.Element {
  const { t } = useTranslation('computer-use');
  const access = useFeatureAccess('computer-use');
  const pairing = useFeatureAccess('claude-code');
  const { sessionId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const orgId = searchParams.get('org') ?? '';
  // null = loading; 'missing' = 404 (or no org named); 'failed' = any other failure.
  const [session, setSession] = useState<SessionDetail | null | 'missing' | 'failed'>(null);
  const [reload, setReload] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  useEffect(() => {
    if (!access.enabled) return;
    if (!orgId || !sessionId) { setSession('missing'); return; }
    let live = true;
    setSession(null);
    getSession(orgId, sessionId)
      .then((s) => { if (live) setSession(s); })
      .catch((err: unknown) => { if (live) setSession(err instanceof ComputerUseApiError && err.status === 404 ? 'missing' : 'failed'); });
    return () => { live = false; };
  }, [access.enabled, orgId, sessionId, reload]);

  const onStop = useCallback(async (): Promise<void> => {
    setBusy(true);
    setStopError(null);
    try {
      setSession(await stopSession(orgId, sessionId));
      setConfirming(false);
      toast.success(t('stopped'));
    } catch {
      setStopError(t('stopFailed'));
    } finally {
      setBusy(false);
    }
  }, [orgId, sessionId, t]);

  const back = <Link to={orgId ? `/computer-use?org=${encodeURIComponent(orgId)}` : '/computer-use'}>{t('backToList')}</Link>;
  const header = (title: string, actions?: JSX.Element) => <PageHeader eyebrow={t('eyebrow')} title={title} actions={actions} />;

  if (access.loading || session === null) return <div className="u-grid u-gap-4">{header(t('detailTitle'))}<Skeleton /></div>;
  if (!access.enabled || session === 'missing') {
    return <section className="u-grid u-gap-4">{header(t('detailTitle'))}<StateCard title={t('notFoundTitle')} body={t('notFoundBody')} action={back} /></section>;
  }
  if (session === 'failed') {
    return (
      <section className="u-grid u-gap-4">
        {header(t('detailTitle'))}
        <StateCard announce title={t('loadFailedTitle')} body={t('loadFailedBody')} action={<Button variant="secondary" onClick={() => setReload((n) => n + 1)}>{t('retry')}</Button>} />
      </section>
    );
  }

  const s = session;
  const live = isLiveStatus(s.status);
  const errorText = s.error
    ? (KNOWN_ERRORS.has(s.error) ? t(`error_${s.error}`) : t('error_other', { code: s.error }))
    : null;

  return (
    <section className="u-grid u-gap-4">
      {header(t('detailTitle'), live ? <Button variant="secondary" onClick={() => setConfirming(true)}>{t('stop')}</Button> : undefined)}
      <div className="u-flex u-gap-3 u-items-center u-flex-wrap">
        {back}
        <SessionStatusBadge status={s.status} />
        <span className="muted u-text-sm">{t('startedAt', { when: formatRelativeTime(s.createdAt) })}</span>
        {s.status === 'awaiting_approval' || s.status === 'awaiting_takeover' ? <Link to="/inbox">{t('openInbox')}</Link> : null}
      </div>

      {s.status === 'awaiting_takeover' && s.takeover ? (
        <Notice variant="warning">
          <strong>{t('takeoverTitle', { host: hostOf(s.takeover.origin) })}</strong>{' '}{t('takeoverBody')}
        </Notice>
      ) : null}
      {s.status === 'awaiting_approval' && s.pendingAction ? (
        <Notice variant="info">
          <strong>{t('pendingTitle', { host: hostOf(s.pendingAction.url) || hostOf(s.startUrl) })}</strong>{' '}
          {t('pendingBody', { action: t(`verb_${s.pendingAction.kind}`, { defaultValue: s.pendingAction.kind }) })}
        </Notice>
      ) : null}
      {s.error === 'browser_not_connected' ? (
        <Panel title={t('connectTitle')} data-testid="cu-connect">
          <p>{t('connectBody')}</p>
          {pairing.enabled ? <Link to="/claude-code">{t('connectPairCta')}</Link> : null}
        </Panel>
      ) : errorText ? <Notice variant="error">{errorText}</Notice> : null}

      <Panel title={t('taskLabel')}>
        <p>{s.task}</p>
        {s.allowedOrigins.length > 0 ? (
          <p className="muted u-text-sm">{t('allowedSites')}: {s.allowedOrigins.map((o) => hostOf(o) || o).join(', ')}</p>
        ) : null}
      </Panel>

      <Panel title={t('stepsTitle')}>
        {s.steps.length === 0 ? <p className="muted">{t('noSteps')}</p> : (
          <ol className="u-grid u-gap-3" aria-label={t('stepsCaption')}>
            {s.steps.map((st, i) => <StepRow key={`${i}-${st.at}`} step={st} index={i} />)}
          </ol>
        )}
      </Panel>

      {s.resultSummary ? <Panel title={t('resultTitle')}><p>{s.resultSummary}</p></Panel> : null}

      {confirming ? (
        <ConfirmDialog
          title={t('stopTitle')}
          body={t('stopBody')}
          confirmLabel={t('stopConfirm')}
          danger
          busy={busy}
          error={stopError ?? undefined}
          errorAnnounce={stopError ?? undefined}
          onConfirm={() => { void onStop(); }}
          onCancel={() => { setConfirming(false); setStopError(null); }}
        />
      ) : null}
    </section>
  );
}
