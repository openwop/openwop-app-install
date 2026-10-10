/**
 * Approve a Claude Code device (ADR 0785 P1) — where the companion's
 * `verificationPath` lands (`/claude-code/pair`).
 *
 * The user TYPES the code their own terminal shows. The page deliberately
 * ignores a `?code=` in the URL (RFC 8628 §5.4): a link that pre-fills the code
 * is a one-click phishing lure — an attacker starts a pairing on their machine and
 * mails the victim the link. Typing it makes the victim read the code off a
 * terminal they own. The page also shows where and when the request started, and
 * which workspace the device will join, before anyone clicks.
 *
 * This is a consent surface, so three rules:
 *   - The consent text comes from the SERVER, and the approval sends back the
 *     hash of the exact text shown. If the text changed while the page was open,
 *     the server refuses (409 `consent_outdated`) and the page reloads it rather
 *     than approving something the user did not read.
 *   - Approve is disabled until the user ticks that they read it. It is not a
 *     dark pattern in reverse: the tick is the acknowledgement being recorded.
 *   - Deny is a first-class action, not a "cancel": a stray pairing request is
 *     exactly the case the user should be able to shut down in one click.
 */
import { useCallback, useState, type FormEvent, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { Panel } from '../../ui/layout.js';
import { Button } from '../../ui/Button.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { CheckboxField, TextField } from '../../ui/Field.js';
import { formatDateTime, formatRelativeTime } from '../../i18n/format.js';
import { TerminalIcon } from '../../ui/icons/index.js';
import {
  ClaudeCodeApiError,
  approvePairRequest,
  denyPairRequest,
  getPairRequest,
  type PairRequestView,
} from './claudeCodeClient.js';

type Phase =
  | { kind: 'enter' }
  | { kind: 'loading' }
  | { kind: 'ready'; view: PairRequestView }
  | { kind: 'not-found' }
  | { kind: 'not-enabled' }
  | { kind: 'approved' }
  | { kind: 'denied' };

/** A 404 from the feature gate (toggle or operator gate) is NOT a bad code: telling
 *  someone who typed the right code that it "is not valid" sends them round the
 *  pairing loop for nothing (observed 2026-09-30, the first prod pairing). */
const isFeatureOff = (err: unknown): boolean =>
  err instanceof ClaudeCodeApiError && err.status === 404 && err.feature !== undefined;

export function ClaudeCodePairPage(): JSX.Element {
  const { t } = useTranslation('claude-code');
  const [phase, setPhase] = useState<Phase>({ kind: 'enter' });
  const [typed, setTyped] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (userCode: string) => {
    setPhase({ kind: 'loading' });
    setAcknowledged(false);
    try {
      setPhase({ kind: 'ready', view: await getPairRequest(userCode) });
    } catch (err) {
      if (isFeatureOff(err)) setPhase({ kind: 'not-enabled' });
      else if (err instanceof ClaudeCodeApiError && err.status === 404) setPhase({ kind: 'not-found' });
      else { setError(t('decideFailed')); setPhase({ kind: 'enter' }); }
    }
  }, [t]);

  const onFind = (e: FormEvent): void => {
    e.preventDefault();
    if (typed.trim()) void load(typed.trim());
  };

  const decide = useCallback(async (approve: boolean) => {
    if (phase.kind !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      if (approve) await approvePairRequest(phase.view.request.userCode, phase.view.consentHash);
      else await denyPairRequest(phase.view.request.userCode);
      setPhase({ kind: approve ? 'approved' : 'denied' });
    } catch (err) {
      if (err instanceof ClaudeCodeApiError && err.reason === 'consent_outdated') {
        setError(t('consentChanged'));
        await load(phase.view.request.userCode);
      } else if (isFeatureOff(err)) {
        setPhase({ kind: 'not-enabled' });
      } else if (err instanceof ClaudeCodeApiError && err.status === 404) {
        setPhase({ kind: 'not-found' });
      } else {
        setError(t('decideFailed'));
      }
    } finally {
      setBusy(false);
    }
  }, [load, phase, t]);

  const manage = <Link to="/claude-code">{t('manageDevices')}</Link>;

  return (
    <div className="u-flex-col u-gap-4" data-walkthrough="claude-code.pair">
      <PageHeader eyebrow={t('eyebrow')} title={t('pairTitle')} lede={t('pairLede')} />
      {error ? <Notice variant="warning" announce={error}>{error}</Notice> : null}

      {phase.kind === 'enter' ? (
        <Panel>
          <form onSubmit={onFind} className="u-flex u-flex-col u-gap-3">
            <TextField
              label={t('codeLabel')}
              help={t('codeHelp')}
              value={typed}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTyped(e.target.value)}
            />
            <div><Button type="submit" variant="primary" disabled={!typed.trim()}>{t('codeFind')}</Button></div>
          </form>
        </Panel>
      ) : null}

      {phase.kind === 'loading' ? (
        <Panel>
          <div role="status" aria-busy="true" aria-label={t('pairTitle')} className="u-flex u-flex-col u-gap-2">
            {['60%', '85%', '70%'].map((w, i) => <Skeleton key={i} width={w} height={18} />)}
          </div>
        </Panel>
      ) : null}

      {phase.kind === 'not-found' ? (
        <StateCard announce icon={<TerminalIcon size={20} />} title={t('notFoundTitle')} body={t('notFoundBody')} action={manage} />
      ) : null}
      {phase.kind === 'not-enabled' ? (
        <StateCard announce icon={<TerminalIcon size={20} />} title={t('notEnabledTitle')} body={t('notEnabledBody')} action={<Link to="/tutorials/set-up-claude-code">{t('notEnabledHelp')}</Link>} />
      ) : null}
      {phase.kind === 'approved' ? (
        <StateCard announce icon={<TerminalIcon size={20} />} title={t('approvedTitle')} body={t('approvedBody')} action={manage} />
      ) : null}
      {phase.kind === 'denied' ? (
        <StateCard announce icon={<TerminalIcon size={20} />} title={t('deniedTitle')} body={t('deniedBody')} action={manage} />
      ) : null}

      {phase.kind === 'ready' ? (
        <>
          <Panel title={t('requestTitle')}>
            <dl className="u-m-0">
              <dt>{t('requestLabel')}</dt>
              <dd><strong>{phase.view.request.label}</strong></dd>
              <dt>{t('requestPlatform')}</dt>
              <dd><code>{phase.view.request.platform}</code></dd>
              <dt>{t('codeLabel')}</dt>
              <dd><code>{phase.view.request.userCode}</code></dd>
              <dt>{t('requestFrom')}</dt>
              <dd><code>{phase.view.request.requestedFrom}</code> · {formatRelativeTime(phase.view.request.createdAt)}</dd>
              <dt>{t('requestWorkspace')}</dt>
              <dd><code>{phase.view.workspaceId}</code></dd>
              <dt>{t('requestExpires')}</dt>
              <dd>{formatDateTime(phase.view.request.expiresAt)}</dd>
            </dl>
            <p className="u-mb-0">{t('requestNotYou')}</p>
          </Panel>

          <Panel title={t('consentTitle')}>
            {/* The provider's sentence, verbatim and attributed — the risk being
                accepted is stated in its own words, not paraphrased. */}
            <blockquote className="u-m-0">
              <p className="u-mt-0">{phase.view.consent.quote}</p>
              <footer>
                <a href={phase.view.consent.source} target="_blank" rel="noopener noreferrer">
                  {t('consentSource', { date: phase.view.consent.fetchedAt })}
                </a>
              </footer>
            </blockquote>
            <ul>
              {phase.view.consent.acknowledgements.map((a) => <li key={a}>{a}</li>)}
            </ul>
            <CheckboxField
              label={t('consentCheck')}
              checked={acknowledged}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAcknowledged(e.target.checked)}
            />
            <div className="u-flex u-gap-2 u-mt-3">
              <Button variant="primary" loading={busy} disabled={busy || !acknowledged} onClick={() => { void decide(true); }}>
                {t('approve')}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => { void decide(false); }}>
                {t('deny')}
              </Button>
            </div>
          </Panel>
        </>
      ) : null}
    </div>
  );
}
