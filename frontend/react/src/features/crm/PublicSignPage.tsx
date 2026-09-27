/**
 * Public signing page (ADR 0402 §b) — the unauthed signer surface at /sign/:token.
 * Shows the exact content being signed, the non-negotiable legal-scope notice, and
 * a typed-name click-to-sign. Authorized purely by possession of the capability
 * token (the commerce-quote public-accept precedent). ui/ tokens only, theme-aware.
 *
 * Signature intent is deliberate: the signer types their name, reads the scope
 * notice, and confirms — no dark patterns, an honest record of what was agreed.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { confirm } from '../../ui/confirm.js';
import { Markdown } from '../../ui/Markdown.js';
import { FileTextIcon, CheckIcon, DownloadIcon } from '../../ui/icons/index.js';
import { getSignView, submitSignature, declineSignature, type SignPublicView } from './signClient.js';
import { formatDate } from '../../i18n/format.js';
import { crmActionError } from './crmUiHelpers.js';

type Phase = 'loading' | 'unavailable' | 'loadFailed' | 'view' | 'submitting' | 'done';

/** The signer's downloadable record: exactly the content they were shown, plus
 *  who signed, when (server time), and the legal scope they accepted. Every
 *  field comes from data we actually have — nothing is reconstructed. */
function signedCopy(
  view: SignPublicView,
  typedName: string,
  signedAt: string,
  labels: { record: string; signer: string; at: string; method: string },
): string {
  return [
    `# ${view.title}`,
    '',
    view.contentMarkdown,
    '',
    '---',
    '',
    `## ${labels.record}`,
    '',
    `- ${labels.signer}: ${typedName} <${view.signerEmail}>`,
    `- ${labels.at}: ${signedAt}`,
    `- ${labels.method}: click-to-sign`,
    '',
    view.legalNotice,
    '',
  ].join('\n');
}

export function PublicSignPage({ token }: { token: string }): JSX.Element {
  const { t } = useTranslation('crm');
  const [phase, setPhase] = useState<Phase>('loading');
  const [view, setView] = useState<SignPublicView | null>(null);
  const [typedName, setTypedName] = useState('');
  const [outcome, setOutcome] = useState<'signed' | 'declined' | null>(null);
  // S-G1 — the server's signature instant, so the copy the signer downloads
  // carries the same timestamp as the durable record.
  const [signedAt, setSignedAt] = useState('');
  // R2 S1R2-3 — the server says whether a completion email is even possible
  // (transport + public origin); the done screen promises nothing beyond that.
  const [certEmailPlanned, setCertEmailPlanned] = useState(false);
  const [error, setError] = useState('');
  // R2 S-G2 — the explicit consent the server records with the signature.
  const [acknowledged, setAcknowledged] = useState(false);

  // Move focus to the current step on each transition (see PublicBookingPage).
  const stepRef = useRef<HTMLDivElement>(null);
  const focusMounted = useRef(false);
  useEffect(() => {
    if (focusMounted.current) stepRef.current?.focus();
    else focusMounted.current = true;
  }, [phase]);

  const [loadNonce, setLoadNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setPhase('loading');
    getSignView(token)
      .then((v) => { if (!live) return; setView(v); setPhase(v.signerStatus === 'pending' ? 'view' : 'done'); if (v.signerStatus !== 'pending') setOutcome(v.signerStatus === 'signed' ? 'signed' : 'declined'); })
      .catch((e: Error & { status?: number }) => {
        // R2 S1R2-1 — only a real 404/410 means the link is dead; a blip must
        // not read "ask the sender for a new link" (false AND terminal).
        if (live) setPhase(e.status === 404 || e.status === 410 ? 'unavailable' : 'loadFailed');
      });
    return () => { live = false; };
  }, [token, loadNonce]);

  const sign = async (): Promise<void> => {
    if (!typedName.trim()) { setError(t('signPubNameRequired')); return; }
    setError('');
    setPhase('submitting');
    try {
      const out = await submitSignature(token, typedName.trim());
      setSignedAt(out.signedAt);
      setCertEmailPlanned(out.certificateEmailPlanned === true);
      setOutcome('signed');
      setPhase('done');
    } catch (e) {
      const err = e as Error & { status?: number; reason?: string };
      // R2 S1R2-4 — typed reasons map to LOCALIZED copy (raw server English
      // reached pt-BR/es/fr signers), and a content-changed 409 REFETCHES: the
      // stale document must not stay on screen with a live Sign button.
      if (err.status === 409 && err.reason === 'content_changed') {
        setError(t('signPubContentChanged'));
        setLoadNonce((n) => n + 1);
        return;
      }
      setPhase('view');
      setError(
        err.reason === 'acknowledgment_required' ? t('signPubErrAckRequired')
          : err.reason === 'out_of_order' ? t('signPubErrOutOfOrder')
          : err.reason === 'terminal' ? t('signPubErrTerminal')
          : err.reason === 'declined' || err.reason === 'signed' ? t('signPubErrAlreadyResponded')
          // CRM-UX-14 — a status the signer can act on, else the generic line;
          // never the server's own sentence.
          : crmActionError(err, 'signPubGenericError'),
      );
    }
  };

  const decline = async (): Promise<void> => {
    if (!view) return;
    const ok = await confirm({ title: t('signPubDeclineConfirm', { title: view.title }), danger: true, confirmLabel: t('signPubDecline') });
    if (!ok) return;
    setError('');
    setPhase('submitting');
    try {
      await declineSignature(token);
      setOutcome('declined');
      setPhase('done');
    } catch (e) {
      setPhase('view');
      setError(crmActionError(e, 'signPubGenericError'));
    }
  };

  const shell = (children: JSX.Element): JSX.Element => (
    <div ref={stepRef} tabIndex={-1} className="u-mx-auto u-w-full u-p-4 u-maxw-720">{children}</div>
  );

  if (phase === 'loading') return shell(<div className="u-p-2" role="status" aria-live="polite"><Skeleton /></div>);
  if (phase === 'loadFailed') {
    return shell(
      <StateCard
        icon={<FileTextIcon />} title={t('signPubLoadFailedTitle')} body={t('signPubLoadFailedBody')} announce
        action={<Button variant="secondary" onClick={() => setLoadNonce((n) => n + 1)}>{t('common:retry')}</Button>}
      />,
    );
  }
  if (phase === 'unavailable' || !view) {
    return shell(<StateCard icon={<FileTextIcon />} title={t('signPubNotFoundTitle')} body={t('signPubNotFoundBody')} />);
  }

  if (phase === 'done') {
    const signed = outcome === 'signed';
    return shell(
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <div className="u-flex u-items-center u-gap-2">
          <span className={signed ? 'chip chip--success' : 'chip chip--muted'}>{signed ? <CheckIcon size={14} /> : null} {t(signed ? 'signPubSignedChip' : 'signPubDeclinedChip')}</span>
        </div>
        <h1 className="u-fs-16 u-m-0">{t(signed ? 'signPubSignedTitle' : 'signPubDeclinedTitle', { title: view.title })}</h1>
        <p className="u-m-0 u-text-muted">{t(signed ? (certEmailPlanned ? 'signPubSignedBodyEmail' : 'signPubSignedBody') : 'signPubDeclinedBody')}</p>
        {/* S-G1 — you should never sign something and be left with nothing. The
            copy is composed from what the signer actually saw (`contentMarkdown`)
            plus the SERVER's signature instant — no fabricated fields. Offered
            only when this session did the signing, since `signedAt` is only
            known then; a returning signer sees the status, not a false record. */}
        {signed && signedAt ? (
          <div className="action-bar">
            <a
              className="btn"
              download={`${view.title.replace(/[^\p{L}\p{N}.-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'agreement'}.md`}
              href={`data:text/markdown;charset=utf-8,${encodeURIComponent(signedCopy(view, typedName.trim(), signedAt, {
                record: t('signPubCopyRecordHeading'),
                signer: t('signPubCopySigner'),
                at: t('signPubCopySignedAt'),
                method: t('signPubCopyMethod'),
              }))}`}
            >
              <DownloadIcon size={14} /> {t('signPubDownloadCopy')}
            </a>
          </div>
        ) : null}
      </div>,
    );
  }

  return shell(
    <div className="u-grid u-gap-4">
      <header className="u-grid u-gap-1">
        <h1 className="u-fs-16 u-m-0">{view.title}</h1>
        <p className="u-m-0 u-fs-12 u-text-muted">{t('signPubSigningAs', { email: view.signerEmail })}</p>
        {/* R2 S1R2-5 — WHO is asking, and since when: a signature request with
            no visible requester is exactly what phishing looks like. */}
        {view.requestedBy?.name || view.requestedBy?.email ? (
          <p className="u-m-0 u-fs-12 u-text-muted">
            {t('signPubRequestedBy', { who: view.requestedBy.name ?? view.requestedBy.email ?? '' })}
            {view.requestedBy.name && view.requestedBy.email ? ` (${view.requestedBy.email})` : ''}
            {view.requestedAt ? ` · ${formatDate(view.requestedAt)}` : ''}
          </p>
        ) : null}
      </header>

      {!view.yourTurn ? <Notice variant="info">{t('signPubWaitTurn')}</Notice> : null}

      <section className="surface-card u-p-4" aria-label={t('signPubContentLabel')}>
        <Markdown>{view.contentMarkdown}</Markdown>
      </section>

      <Notice variant="warning">{view.legalNotice}</Notice>

      {error ? <Notice variant="error">{error}</Notice> : null}

      <form className="surface-card u-p-4 surface-form u-grid u-gap-3" onSubmit={(e) => { e.preventDefault(); void sign(); }}>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('signPubTypedName')}</span>
          <input value={typedName} onChange={(e) => setTypedName(e.target.value)} placeholder={t('signPubTypedNamePlaceholder')} autoComplete="name" disabled={!view.yourTurn} required />
        </label>
        <label className="u-flex u-items-center u-gap-2">
          <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} disabled={!view.yourTurn} required />
          <span className="u-fs-13">{t('signPubAcknowledge')}</span>
        </label>
        <div className="action-bar">
          <Button variant="primary" type="submit" disabled={!view.yourTurn || phase === 'submitting' || !typedName.trim() || !acknowledged}>{phase === 'submitting' ? t('signPubSigning') : t('signPubSign')}</Button>
          <Button variant="quiet" disabled={phase === 'submitting'} onClick={() => void decline()}>{t('signPubDecline')}</Button>
        </div>
      </form>
    </div>,
  );
}
