/**
 * ADR 0924 D5 — the client approver's page, rendered by the sharing viewer for a
 * `campaign_approval` link (`/shared/:token`). No app chrome and no navigation:
 * the approver sees the request and the before → after of each change, and
 * approves or rejects with an optional comment. The approve names the exact hash
 * they were shown, so a changed package can never be approved by mistake.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { TextareaField } from '../../ui/Field.js';
import { CheckIcon, LinkIcon } from '../../ui/icons/index.js';
import { ChangeDiff } from './ChangeDiff.js';
import type { DiffEntry } from './campaignOpsClient.js';
import { decideApproval, PortalDecisionError, type PortalFailure } from './portalClient.js';

interface ApprovalPackage {
  state: 'in_review' | 'stale';
  clientName: string;
  approverName?: string;
  request?: string;
  changeSetHash?: string;
  changes?: DiffEntry[];
  maxComment?: number;
}

const COLUMN = { maxWidth: '46rem' } as const;

export function PublicApprovalView({ token, resource }: { token: string; resource: Record<string, unknown> }): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const pkg = resource as unknown as ApprovalPackage;
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'approved' | 'rejected' | null>(null);
  const [failure, setFailure] = useState<PortalFailure | null>(pkg.state === 'stale' ? 'stale' : null);
  const max = pkg.maxComment ?? 2000;

  const decide = async (action: 'approve' | 'reject'): Promise<void> => {
    if (!pkg.changeSetHash) return;
    setBusy(true);
    try {
      setDone(await decideApproval(token, { action, expectedChangeSetHash: pkg.changeSetHash, ...(comment.trim() ? { comment: comment.trim() } : {}) }));
      setFailure(null);
    } catch (e) {
      setFailure(e instanceof PortalDecisionError ? e.kind : 'failed');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="u-p-4 page-enter">
        <StateCard
          icon={<CheckIcon size={28} />}
          announce
          title={done === 'approved' ? t('portalApprovedTitle') : t('portalRejectedTitle')}
          body={done === 'approved' ? t('portalApprovedBody', { client: pkg.clientName }) : t('portalRejectedBody')}
        />
      </div>
    );
  }
  if (failure === 'stale' || failure === 'gone') {
    return (
      <div className="u-p-4 page-enter">
        <StateCard
          icon={<LinkIcon size={28} />}
          announce
          title={failure === 'stale' ? t('portalStaleTitle') : t('portalGoneTitle')}
          body={failure === 'stale' ? t('portalStaleBody') : t('portalGoneBody')}
        />
      </div>
    );
  }

  return (
    <article className="u-p-4 u-mx-auto page-enter u-grid u-gap-3" style={COLUMN}>
      <header className="u-grid u-gap-1">
        <h1 className="page-header__title u-m-0">{t('portalTitle', { client: pkg.clientName })}</h1>
        <p className="u-text-muted u-m-0">
          {pkg.approverName ? t('portalIntroNamed', { name: pkg.approverName }) : t('portalIntro')}
        </p>
      </header>
      {pkg.request ? (
        <section className="u-grid u-gap-1" aria-labelledby="portal-request">
          <h2 id="portal-request" className="u-fs-14 u-m-0">{t('portalRequestHeading')}</h2>
          <p className="u-m-0 u-prewrap">{pkg.request}</p>
        </section>
      ) : null}
      <section className="u-grid u-gap-1" aria-labelledby="portal-changes">
        <h2 id="portal-changes" className="u-fs-14 u-m-0">{t('portalChangesHeading')}</h2>
        <ChangeDiff diff={pkg.changes ?? []} />
      </section>
      <TextareaField
        label={t('portalCommentLabel')}
        help={t('portalCommentHelp', { max })}
        value={comment}
        maxLength={max}
        rows={3}
        onChange={(e) => setComment(e.target.value)}
      />
      {failure === 'rate_limited' ? <Notice variant="error" announce={t('portalRateLimited')}>{t('portalRateLimited')}</Notice> : null}
      {failure === 'failed' ? <Notice variant="error" announce={t('portalFailed')}>{t('portalFailed')}</Notice> : null}
      <div className="u-flex u-gap-2 u-flex-wrap">
        <Button variant="primary" disabled={busy || !pkg.changeSetHash} onClick={() => void decide('approve')}>{t('portalApprove')}</Button>
        <Button variant="secondary" disabled={busy || !pkg.changeSetHash} onClick={() => void decide('reject')}>{t('portalReject')}</Button>
      </div>
      <p className="u-text-muted u-fs-12 u-m-0">{t('portalFinePrint')}</p>
    </article>
  );
}
