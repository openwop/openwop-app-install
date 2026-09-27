/**
 * Job listings — the ADR 0542 P5 surface.
 *
 * Two things share this page deliberately: the listings themselves, and the
 * PUBLISH control that decides whether anyone else can see them. Putting the
 * control anywhere else would let a user publish a set they are not currently
 * looking at, which is the same defect as a consent dialog that hides the number
 * it is asking about (ADR 0541 P4's finding, applied to a different surface).
 *
 * The publish confirm therefore states exactly WHAT becomes public — role,
 * company, location, source board — and what does not: applications, notes and
 * personal details. "Publish listings" without that inventory would be asking
 * for agreement to an unread list.
 *
 * Built entirely from the shared ui/ design system.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Panel } from '../../ui/layout.js';
import { Button } from '../../ui/Button.js';
import { StateCard } from '../../ui/StateCard.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { toast } from '../../ui/toast.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { ShieldIcon } from '../../ui/icons/index.js';
import {
  listOrgs, listListings, getListingsVisibility, setListingsVisibility, type JobListing,
} from './jobSearchClient.js';

export function JobListingsPage(): JSX.Element {
  const { t } = useTranslation('job-search');
  const { orgs, orgsFailed, retry: retryOrgs, orgId } = useOrgSelection(listOrgs);

  const [listings, setListings] = useState<JobListing[] | null>(null);
  const [isPublic, setIsPublic] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    try {
      setError(null);
      const [rows, vis] = await Promise.all([listListings(orgId), getListingsVisibility(orgId)]);
      setListings(rows);
      setIsPublic(vis.public);
    } catch {
      setError(t('loadFailed'));
      setListings([]);
    }
  }, [orgId, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  const columns = useMemo<DataColumn<JobListing>[]>(() => [
    // JSUX-LIST-1 — sorting via the DataTable's own opt-in.
    { key: 'title', header: t('colTitle'), sortValue: (l) => l.title, render: (l) => l.title },
    { key: 'company', header: t('colCompany'), sortValue: (l) => l.companyName, render: (l) => l.companyName },
    {
      key: 'location', header: t('colLocation'), sortValue: (l) => l.location ?? '',
      // Remote is shown as a labelled chip beside the location rather than
      // replacing it: a remote role with a stated office is BOTH, and collapsing
      // them would lose the half the user is filtering on.
      render: (l) => (
        <span className="u-flex u-gap-2 u-items-center">
          {l.location ?? '—'}
          {l.remote ? <StatusBadge status="info" label={t('remoteYes')} /> : null}
        </span>
      ),
    },
    { key: 'board', header: t('colBoard'), sortValue: (l) => l.sourceBoard ?? '', render: (l) => l.sourceBoard ?? '—' },
  ], [t]);

  const applyVisibility = useCallback(async (next: boolean) => {
    setConfirming(false);
    if (!orgId) return;
    try {
      await setListingsVisibility(orgId, next);
      setIsPublic(next);
      toast.success(t(next ? 'published' : 'unpublished'));
    } catch {
      toast.error(t('visibilityFailed'));
    }
  }, [orgId, t]);

  return (
    <div className="u-flex-col u-gap-4" data-walkthrough="job-search.listings">
      <PageHeader eyebrow={t('eyebrow')} title={t('listingsTitle')} lede={t('listingsLede')} />
      <OrgSelectionState
        orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<ShieldIcon />}
      >
        {error ? <Notice variant="error">{error}</Notice> : null}

        <Panel title={t('visibilityTitle')}>
          {isPublic === null ? (
            <Skeleton />
          ) : (
            <div className="u-grid u-gap-3">
              {/* State first, action second: the user should read what is true
                  now before being offered the control that changes it. */}
              <div className="u-flex u-gap-2 u-items-center">
                <StatusBadge
                  status={isPublic ? 'warning' : 'neutral'}
                  label={t(isPublic ? 'visibilityPublic' : 'visibilityPrivate')}
                />
              </div>
              <p className="muted u-fs-12">{t('visibilityBody')}</p>
              <div className="action-bar">
                {isPublic ? (
                  <Button variant="quiet" onClick={() => void applyVisibility(false)}>{t('unpublishAction')}</Button>
                ) : (
                  <Button variant="primary" onClick={() => setConfirming(true)}>{t('publishAction')}</Button>
                )}
              </div>
            </div>
          )}
        </Panel>

        <Panel title={t('listingsTitle')}>
          {listings === null ? (
            <Skeleton />
          ) : (
            <DataTable
              filterable={{ placeholder: t('filterListings') }}
              stack
              rows={listings}
              rowKey={(l) => l.listingId}
              columns={columns}
              caption={t('listingsTitle')}
              empty={<StateCard title={t('listingsEmptyTitle')} body={t('listingsEmptyBody')} />}
            />
          )}
        </Panel>
      </OrgSelectionState>

      {/* Only PUBLISHING confirms. Making something private again is the safe
          direction and needs no ceremony — a confirm there would train users to
          click through the one that matters. */}
      {confirming ? (
        <ConfirmDialog
          title={t('publishConfirmTitle')}
          // `/ux-review`: the COUNT belongs in the confirm. "Publish listings" is
          // agreement to an unread list; "publish 47 listings" is a decision —
          // the same number-before-consent rule ADR 0541 P4 applied to the grant,
          // which this surface was not honouring.
          //
          // And the reversibility clause is stated honestly: making them private
          // again does not un-read what was copied while they were public, so
          // promising a clean undo would be the overstatement.
          body={`${t('publishConfirmBody', { count: listings?.length ?? 0 })} ${t('publishReversibility')}`}
          confirmLabel={t('publishConfirmAction')}
          onConfirm={() => void applyVisibility(true)}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}
