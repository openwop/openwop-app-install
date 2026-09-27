/**
 * ADR 0544 P4 — the consent surface.
 *
 * ## Why this is not "a checkbox at the submit moment"
 *
 * Matrix row 10 describes a single checkbox at submit time. That moment does not
 * exist for the path this feature actually runs: under tier A/B the host submits
 * through a board's documented API and NO HUMAN IS PRESENT — the same fact that
 * forced ADR 0544's own correction to stop asserting `human-reviewed`. A consent
 * checkbox staged at a moment nobody attends is not consent; it is a setting.
 *
 * The consent therefore lives where the human is: on their own applications,
 * one at a time, AFTER the application went out. That turns out to be the more
 * faithful reading of row 10's actual requirement — "the number is shown before
 * consent" — because the number is only knowable once the applications exist.
 * At authority-granting time the count is unknown, so a blanket "attach to
 * everything" toggle would be consent to an unseen number, which row 10 exists
 * to forbid. (Recorded as a correction note on the ADR.)
 *
 * ## The dialog shows the employer's page, not a summary of it
 *
 * The claims render through the shared `ClaimList` — the same component the
 * public verification page uses, fed by a backend preview that runs the same
 * derivation and projection as the public resolve. A second, friendlier summary
 * would drift, and it would drift on the one screen whose entire purpose is
 * telling someone exactly what they are about to reveal.
 *
 * Refusals do NOT open the dialog. A confirm box offering "Create the link"
 * above an explanation of why no link can exist is a button that must not be
 * pressed, and the honest response is a notice instead.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Panel } from '../../ui/layout.js';
import { Button } from '../../ui/Button.js';
import { StateCard } from '../../ui/StateCard.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Modal } from '../../ui/Modal.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { toast } from '../../ui/toast.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { ShieldIcon } from '../../ui/icons/index.js';
import { ClaimList, useRenderedClaims } from './ClaimList.js';
import type { VerifierClaim } from './attestationVerifyClient.js';
import {
  listOrgs, listApplications, listIssuedAttestations, previewAttestation, issueAttestation,
  revokeAttestation, type JobApplication, type AttestationRow,
} from './jobSearchClient.js';

/** The absolute link an employer opens. Built from the app's own origin. */
const verifyUrl = (token: string): string =>
  `${typeof window === 'undefined' ? '' : window.location.origin}/verify/${encodeURIComponent(token)}`;

export function JobApplicationsPage(): JSX.Element {
  const { t } = useTranslation('job-search');
  const fmt = useFormat();
  const { orgs, orgsFailed, retry: retryOrgs, orgId } = useOrgSelection(listOrgs);

  const [apps, setApps] = useState<JobApplication[] | null>(null);
  const [issued, setIssued] = useState<AttestationRow[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  const [pendingDeal, setPendingDeal] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ dealId: string; claims: VerifierClaim[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AttestationRow | null>(null);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    try {
      setLoadFailed(false);
      const [a, i] = await Promise.all([listApplications(orgId), listIssuedAttestations(orgId)]);
      setApps(a);
      setIssued(i);
    } catch {
      setLoadFailed(true);
      setApps([]);
    }
  }, [orgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Live attestation for a deal, if any. Revoked ones do not count as shared. */
  const activeFor = useCallback(
    (dealId: string): AttestationRow | undefined => issued.find((r) => r.dealId === dealId && !r.revokedAt),
    [issued],
  );

  const startShare = useCallback(async (dealId: string) => {
    if (!orgId) return;
    setNotice(null);
    setPendingDeal(dealId);
    const res = await previewAttestation(orgId, dealId);
    setPendingDeal(null);
    if (res.kind === 'ok') { setPreview({ dealId, claims: res.claims }); return; }
    // A refusal is an answer, not an error — and each one means something
    // different to the applicant, so none of them collapses into "failed".
    const copy = {
      'not-attestable': { title: t('shareNotAttestableTitle'), body: t('shareNotAttestableBody') },
      'not-the-subject': { title: t('shareNotSubjectTitle'), body: t('shareNotSubjectBody') },
      failed: { title: t('shareFailedTitle'), body: t('shareFailedBody') },
    }[res.kind];
    setNotice(copy);
  }, [orgId, t]);

  const confirmShare = useCallback(async () => {
    if (!orgId || !preview) return;
    setBusy(true);
    try {
      const { token } = await issueAttestation(orgId, preview.dealId);
      setPreview(null);
      setLink(verifyUrl(token));
      await refresh();
    } catch {
      setPreview(null);
      setNotice({ title: t('shareFailedTitle'), body: t('linkIssueFailed') });
    } finally {
      setBusy(false);
    }
  }, [orgId, preview, refresh, t]);

  const doRevoke = useCallback(async () => {
    if (!orgId || !revoking) return;
    setBusy(true);
    try {
      await revokeAttestation(orgId, revoking.attestationId);
      toast.success(t('attRevoked_toast'));
      await refresh();
    } catch {
      toast.error(t('appsLoadFailed'));
    } finally {
      setBusy(false);
      setRevoking(null);
    }
  }, [orgId, revoking, refresh, t]);

  const columns = useMemo<DataColumn<JobApplication>[]>(() => [
    // JSUX-LIST-1 — sorting is the DataTable's own opt-in (`sortValue`).
    { key: 'role', header: t('colRole'), sortValue: (a) => a.title ?? '', render: (a) => a.title || '—' },
    { key: 'company', header: t('colCompany'), sortValue: (a) => a.companyName ?? '', render: (a) => a.companyName ?? '—' },
    { key: 'stage', header: t('colStage'), sortValue: (a) => a.stage ?? '', render: (a) => a.stage ?? '—' },
    { key: 'applied', header: t('colApplied'), sortValue: (a) => a.appliedAt ?? '', render: (a) => (a.appliedAt ? fmt.date(a.appliedAt) : '—') },
    {
      key: 'verification',
      header: t('colVerification'),
      render: (a) => {
        const live = activeFor(a.dealId);
        if (live) {
          return (
            <span className="u-flex u-gap-2 u-items-center">
              <StatusBadge status="success" label={t('attActive')} />
              <Button variant="quiet" size="sm" onClick={() => setRevoking(live)}>{t('attRevoke')}</Button>
            </span>
          );
        }
        return (
          <Button
            variant="secondary"
            size="sm"
            disabled={pendingDeal === a.dealId}
            onClick={() => { void startShare(a.dealId); }}
          >
            {t('actionShare')}
          </Button>
        );
      },
    },
  ], [t, fmt, activeFor, pendingDeal, startShare]);

  return (
    <div className="u-flex-col u-gap-4" data-walkthrough="job-search.applications">
      <PageHeader eyebrow={t('eyebrow')} title={t('appsTitle')} lede={t('appsLede')} />
      <OrgSelectionState
        orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<ShieldIcon />}
      >
        <Panel>
          {notice ? (
            <div className="u-mb-3">
              <Notice variant="info" announce={`${notice.title}. ${notice.body}`}>
                <strong>{notice.title}</strong> {notice.body}
              </Notice>
            </div>
          ) : null}

          {loadFailed ? (
            <StateCard
              announce
              icon={<ShieldIcon size={20} />}
              title={t('appsLoadFailed')}
              action={<Button variant="secondary" size="sm" onClick={() => { void refresh(); }}>{t('appsRetry')}</Button>}
            />
          ) : apps === null ? (
            <div role="status" aria-busy="true" aria-label={t('appsTitle')} className="u-flex u-flex-col u-gap-2">
              {['90%', '80%', '85%'].map((w, i) => <Skeleton key={i} width={w} height={18} />)}
            </div>
          ) : apps.length === 0 ? (
            <StateCard icon={<ShieldIcon size={20} />} title={t('appsEmptyTitle')} body={t('appsEmptyBody')} />
          ) : (
            <DataTable filterable={{ placeholder: t('filterApplications') }}
              rows={apps} columns={columns} rowKey={(a) => a.dealId} />
          )}
        </Panel>
      </OrgSelectionState>

      {preview ? (
        <ConfirmDialog
          title={t('shareTitle')}
          confirmLabel={t('shareConfirm')}
          busy={busy}
          onCancel={() => setPreview(null)}
          onConfirm={() => { void confirmShare(); }}
          body={<SharePreviewBody claims={preview.claims} />}
        />
      ) : null}

      {revoking ? (
        <ConfirmDialog
          danger
          title={t('attRevokeConfirmTitle')}
          body={t('attRevokeConfirmBody')}
          confirmLabel={t('attRevoke')}
          busy={busy}
          onCancel={() => setRevoking(null)}
          onConfirm={() => { void doRevoke(); }}
        />
      ) : null}

      {link ? <LinkReadyModal url={link} onClose={() => setLink(null)} /> : null}
    </div>
  );
}

/**
 * The consent body: what they will see, then what they will NOT see, then what
 * revoking can and cannot undo.
 *
 * The third line matters as much as the first. "You can revoke at any time"
 * alone overstates reversibility — the same finding ADR 0542 P5's publish
 * control took — because revoking stops the link resolving and cannot un-read
 * what an employer has already read.
 */
function SharePreviewBody({ claims }: { claims: VerifierClaim[] }): JSX.Element {
  const { t } = useTranslation('job-search');
  const rendered = useRenderedClaims(claims);
  return (
    <span className="u-flex u-flex-col u-gap-2">
      <span>{t('shareLede')}</span>
      <ClaimList claims={rendered} dense />
      <span className="muted u-text-sm">{t('shareNothingElse')}</span>
      <span className="muted u-text-sm">{t('shareIrreversible')}</span>
    </span>
  );
}

/**
 * The token, shown ONCE. There is no route that reads it back, so this dialog is
 * the applicant's only chance to keep it — the copy says so rather than letting
 * them discover it later.
 */
function LinkReadyModal({ url, onClose }: { url: string; onClose: () => void }): JSX.Element {
  const { t } = useTranslation('job-search');
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('linkCopied'));
    } catch {
      // Clipboard access is refused in plenty of ordinary situations (no
      // permission, insecure context). Saying so beats a success toast for
      // something that did not happen — the link is on screen and selectable.
      setCopyFailed(true);
    }
  }, [url, t]);

  return (
    <Modal label={t('linkReadyTitle')} onClose={onClose} showClose>
      <h2 className="page-header__title">{t('linkReadyTitle')}</h2>
      <p className="muted u-mt-1">{t('linkReadyBody')}</p>
      <p className="u-mono u-break-all u-mt-2">{url}</p>
      {copyFailed ? (
        <div className="u-mt-2"><Notice variant="warning" announce={t('linkCopyFailed')}>{t('linkCopyFailed')}</Notice></div>
      ) : null}
      <div className="action-bar u-mt-3">
        <Button onClick={() => { void copy(); }}>{t('linkCopy')}</Button>
        <Button variant="quiet" onClick={onClose}>{t('linkDone')}</Button>
      </div>
    </Modal>
  );
}
