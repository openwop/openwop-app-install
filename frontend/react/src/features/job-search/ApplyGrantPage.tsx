/**
 * Auto-apply authority — the ADR 0541 P4 consent surface.
 *
 * The design decision this page encodes: **the bounds are the consent.** A
 * dialog that says "enable auto-apply" with a toggle is not consent, because the
 * user has agreed to something they cannot describe afterwards. So the issuing
 * form is a list of limits with no "unlimited" option, each labelled in plain
 * numbers, and the active-grants table shows spend against ceiling rather than
 * a status light.
 *
 * The second decision: revocation is presented as ordinary, not alarming. It is
 * the control that makes the grant safe to issue in the first place, and a
 * destructive-looking confirm would make users hesitate to use the thing that
 * protects them. The dialog says plainly what continues (the campaign) and what
 * stops (automatic submission).
 *
 * Built entirely from the shared ui/ design system; no bespoke controls.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Panel } from '../../ui/layout.js';
import { Button } from '../../ui/Button.js';
import { StateCard } from '../../ui/StateCard.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { Link } from 'react-router-dom';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { TextField, TextareaField } from '../../ui/Field.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { toast } from '../../ui/toast.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { formatNumber, formatDate } from '../../i18n/format.js';
import { ShieldIcon } from '../../ui/icons/index.js';
import { listOrgs, listGrants, createGrant, revokeGrant, queueCampaign, type ApplyGrantView } from './jobSearchClient.js';

/** Deliberately modest defaults (ADR 0541 D3a). A user may raise them; the
 *  product does not start them high and hope. */
const DEFAULTS = { maxSubmits: 25, maxPrepared: 10, ratePerHour: 4 };

function statusOf(g: ApplyGrantView, now: number): 'active' | 'revoked' | 'expired' {
  if (g.revokedAt) return 'revoked';
  if (Date.parse(g.expiresAt) <= now) return 'expired';
  return 'active';
}

export function ApplyGrantPage(): JSX.Element {
  const { t } = useTranslation('job-search');
  const { orgs, orgsFailed, retry: retryOrgs, orgId } = useOrgSelection(listOrgs);

  const [grants, setGrants] = useState<ApplyGrantView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<ApplyGrantView | null>(null);

  const [campaignId, setCampaignId] = useState('');
  const [maxSubmits, setMaxSubmits] = useState(String(DEFAULTS.maxSubmits));
  const [maxPrepared, setMaxPrepared] = useState(String(DEFAULTS.maxPrepared));
  const [ratePerHour, setRatePerHour] = useState(String(DEFAULTS.ratePerHour));
  const [origins, setOrigins] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  const refresh = useCallback(async () => {
    if (!orgId) return;
    try {
      setError(null);
      setGrants(await listGrants(orgId));
    } catch {
      setError(t('loadFailed'));
      setGrants([]);
    }
  }, [orgId, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  const [queueBusy, setQueueBusy] = useState(false);
  // JSUX-Q-1 — the toast is a 4s acknowledgement; the DESTINATION rides
  // durable state (the Environments pendingApproval precedent): a Notice with
  // a real link to the agent's board, so the user can SEE the card. The toast
  // system deliberately carries no actions (string-coalescing + announce
  // contract), so this is the sanctioned shape, not a workaround.
  const [queuedBoardId, setQueuedBoardId] = useState<string | null>(null);
  const onQueue = useCallback(async () => {
    if (!orgId || queueBusy) return;
    setQueueBusy(true);
    try {
      const { created, boardId } = await queueCampaign(orgId);
      toast.success(t(created ? 'queuedNotice' : 'alreadyQueuedNotice'));
      setQueuedBoardId(boardId ?? null);
    } catch (err) {
      toast.error(t('queueFailed', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setQueueBusy(false);
    }
  }, [orgId, queueBusy, t]);

  const now = Date.now();
  const columns = useMemo<DataColumn<ApplyGrantView>[]>(() => [
    // JSUX-LIST-1 — sorting via the DataTable's own opt-in.
    { key: 'campaign', header: t('colCampaign'), sortValue: (g) => g.campaignId, render: (g) => g.campaignId },
    {
      key: 'used', header: t('colUsed'), align: 'right', cellClassName: 'tabular-nums', sortValue: (g) => g.submitsUsed,
      // Spend against ceiling, never a bare count: the ceiling is the thing the
      // user consented to, so the number is meaningless without it.
      render: (g) => t('usedOf', { used: formatNumber(g.submitsUsed), max: formatNumber(g.maxSubmits) }),
    },
    {
      key: 'prepared', header: t('colPrepared'), align: 'right', cellClassName: 'tabular-nums',
      render: (g) => t('usedOf', { used: formatNumber(g.preparedUsed), max: formatNumber(g.maxPrepared) }),
    },
    { key: 'rate', header: t('colRate'), align: 'right', cellClassName: 'tabular-nums', render: (g) => t('ratePerHour', { count: g.ratePerHour }) },
    { key: 'tiers', header: t('colTiers'), render: (g) => g.tiers.join(', ') },
    { key: 'origins', header: t('colOrigins'), render: (g) => g.origins.join(', ') },
    { key: 'expires', header: t('colExpires'), sortValue: (g) => g.expiresAt, render: (g) => formatDate(g.expiresAt) },
    {
      key: 'status', header: t('colStatus'),
      render: (g) => {
        const s = statusOf(g, now);
        return <StatusBadge status={s === 'active' ? 'success' : 'neutral'} label={t(s === 'active' ? 'statusActive' : s === 'revoked' ? 'statusRevoked' : 'statusExpired')} />;
      },
    },
    {
      key: 'actions', header: '',
      render: (g) => (statusOf(g, now) === 'active'
        ? (
          <span className="u-flex u-gap-2">
            {/* WF-JS-1 — queue ONE campaign pass as a card on the career agent's
                board. Queuing, not running: the heartbeat loop picks it up, and
                at the default review autonomy a person approves the run first —
                which is exactly what the success copy says. */}
            <Button variant="quiet" size="sm" disabled={queueBusy} onClick={() => void onQueue()}>
              {t('queueAction')}
            </Button>
            <Button variant="quiet" size="sm" onClick={() => setConfirming(g)}>{t('revokeAction')}</Button>
          </span>
        )
        : null),
    },
  ], [t, now, queueBusy, onQueue]);

  /**
   * The bounds, said back in plain language BEFORE the button is usable.
   *
   * Returns null until every limit is present, which also gates the submit —
   * issuing authority to submit on someone's behalf should not be one click
   * easier than revoking it, and before this the form had LESS friction than
   * the revoke dialog.
   */
  const consent = useMemo(() => {
    const submits = Number(maxSubmits);
    const rate = Number(ratePerHour);
    const sites = origins.split('\n').map((o) => o.trim()).filter(Boolean);
    if (!campaignId.trim() || !Number.isFinite(submits) || submits <= 0) return null;
    if (!Number.isFinite(rate) || rate <= 0 || sites.length === 0 || !expiresAt) return null;
    return t('consentSummary', {
      submits: formatNumber(submits),
      rate: formatNumber(rate),
      sites: t('consentSites', { count: sites.length }),
      expires: formatDate(expiresAt),
    });
  }, [campaignId, maxSubmits, ratePerHour, origins, expiresAt, t]);

  const issue = useCallback(async () => {
    if (!orgId) return;
    setBusy(true);
    try {
      await createGrant(orgId, {
        campaignId: campaignId.trim(),
        maxSubmits: Number(maxSubmits),
        maxPrepared: Number(maxPrepared),
        ratePerHour: Number(ratePerHour),
        origins: origins.split('\n').map((o) => o.trim()).filter(Boolean),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : '',
      });
      setCampaignId('');
      setOrigins('');
      await refresh();
    } catch (err) {
      // The server's own message is surfaced verbatim: it names WHICH bound was
      // missing, and a generic "could not issue" would hide the one useful fact.
      toast.error(t('issueFailed', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }, [orgId, campaignId, maxSubmits, maxPrepared, ratePerHour, origins, expiresAt, refresh, t]);

  const doRevoke = useCallback(async () => {
    const g = confirming;
    setConfirming(null);
    if (!g || !orgId) return;
    try {
      await revokeGrant(orgId, g.grantId);
      toast.success(t('revokedNotice'));
      await refresh();
    } catch {
      toast.error(t('revokeFailed'));
    }
  }, [confirming, orgId, refresh, t]);

  return (
    // ADR 0489 D3 — the walkthrough anchor. Required for any screen with a nav
    // entry, and the ratchet is shrink-only, so exempting is not an option.
    <div className="u-flex-col u-gap-4" data-walkthrough="job-search.authority">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      <OrgSelectionState
        orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<ShieldIcon />}
      >
        {error ? <Notice variant="error">{error}</Notice> : null}

        {/* JSUX-Q-1 — the queued card's DESTINATION survives the toast. */}
        {queuedBoardId ? (
          <Notice variant="info">
            <p className="u-m-0">{t('queuedCardBody')}</p>
            <p className="u-fs-12 u-m-0 u-mt-1">
              <Link to={`/boards/${encodeURIComponent(queuedBoardId)}`}>{t('queuedCardLink')}</Link>
            </p>
          </Notice>
        ) : null}

        <Panel title={t('activeTitle')}>
          {grants === null ? (
            <Skeleton />
          ) : (
            <DataTable
              stack
              rows={grants}
              rowKey={(g) => g.grantId}
              columns={columns}
              caption={t('activeTitle')}
              empty={<StateCard title={t('emptyTitle')} body={t('emptyBody')} />}
            />
          )}
        </Panel>

        <Panel title={t('issueTitle')}>
          <p className="muted u-fs-12">{t('issueLede')}</p>
          <div className="u-grid u-gap-3">
            <TextField label={t('fieldCampaign')} help={t('fieldCampaignHint')} value={campaignId} onChange={(e) => setCampaignId(e.target.value)} />
            <TextField label={t('fieldMaxSubmits')} help={t('fieldMaxSubmitsHint')} type="number" value={maxSubmits} onChange={(e) => setMaxSubmits(e.target.value)} />
            <TextField label={t('fieldMaxPrepared')} help={t('fieldMaxPreparedHint')} type="number" value={maxPrepared} onChange={(e) => setMaxPrepared(e.target.value)} />
            <TextField label={t('fieldRate')} help={t('fieldRateHint')} type="number" value={ratePerHour} onChange={(e) => setRatePerHour(e.target.value)} />
            <TextareaField label={t('fieldOrigins')} help={t('fieldOriginsHint')} rows={3} value={origins} onChange={(e) => setOrigins(e.target.value)} />
            <TextField label={t('fieldExpires')} help={t('fieldExpiresHint')} type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            {/* The consent RESTATEMENT (`/ux-review`). Reading back the bounds
                in words is what turns six form fields into an informed decision:
                a user who cannot describe what they authorised has not consented
                to it. `role="status"` so it reaches a screen reader as the
                fields change, rather than being silent text beside the button. */}
            <Notice id="job-search-consent" variant={consent === null ? 'info' : 'warning'}>
              {consent ?? t('consentSummaryIncomplete')}
            </Notice>
            <div className="action-bar">
              <Button
                variant="primary"
                onClick={() => void issue()}
                disabled={busy || consent === null}
                // The consent restatement IS this button's description, so a
                // screen-reader user hears what they are authorising as part of
                // the control rather than as unrelated text beside it.
                aria-describedby="job-search-consent"
              >
                {busy ? t('issuing') : t('issueAction')}
              </Button>
            </div>
          </div>
        </Panel>
      </OrgSelectionState>

      {/* Rendered conditionally rather than via an `open` prop — ConfirmDialog
          mounts when it is shown. Deliberately NOT `danger`: revocation is the
          control that makes a grant safe to issue, and dressing it as
          destructive would make users hesitate to use their own safety valve. */}
      {confirming !== null ? (
      <ConfirmDialog
        title={t('revokeConfirmTitle')}
        body={t('revokeConfirmBody')}
        confirmLabel={t('revokeConfirmAction')}
        onConfirm={() => void doRevoke()}
        onCancel={() => setConfirming(null)}
      />
      ) : null}
    </div>
  );
}
