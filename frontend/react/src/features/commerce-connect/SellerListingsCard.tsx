/**
 * Seller listing editor + operator approval queue (ADR 0385 Phase 4).
 * The editor upserts a lane/price for one of the seller's packs (native-paid
 * enters the approval queue; a material edit re-enters it). The approval queue
 * renders ONLY when the superadmin fetch succeeds — the backend 403 is the
 * authority (the marketplace install precedent), the UI just hides.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { formatCurrency } from '../../i18n/format.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { toast } from '../../ui/toast.js';
import { Notice } from '../../ui/Notice.js';
import { confirm } from '../../ui/confirm.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { getEffectiveAccess } from '../../client/accessClient.js';
import {
  listOwnListings, upsertListing, releaseListing, listApprovals, decideApproval, ApiError,
  type PaidListing, type ListingLane, type PendingListingApproval,
} from './commerceConnectClient.js';

const APPROVAL_TONE: Record<string, string> = { approved: 'completed', pending: 'waiting-approval', rejected: 'cancelled', draft: 'paused' };

function laneSummary(l: PaidListing, t: TFunction): string {
  if (l.lane === 'native-paid' && l.priceMajorUnits !== undefined) return formatCurrency(l.priceMajorUnits, l.currency ?? 'usd');
  if (l.lane === 'external-link') return t('laneExternal');
  return t('laneFree');
}

export function SellerListingsCard(): JSX.Element {
  const { t } = useTranslation('commerce-connect');
  const [rows, setRows] = useState<PaidListing[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [packName, setPackName] = useState('');
  const [lane, setLane] = useState<ListingLane>('native-paid');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('usd');
  const [externalUrl, setExternalUrl] = useState('');

  // CCX-R2-1 — a failed listings read must not tell a SELLER "no listings
  // yet" about their own marketplace inventory (the session's recurring
  // failure-as-EMPTY shape, on a money surface).
  const [rowsFailed, setRowsFailed] = useState(false);
  // MPL-2 (review fold-in) — MPL-2 put `workspace:write` on the listing routes but
  // NOTHING client-side learned about it, so a VIEWER in a shared workspace was
  // still rendered Save and Unlist and only found out by pressing them: the 403
  // came back as the raw, untranslated `Missing required scope: workspace:write`
  // through `toast.error(e.message)`. Same presentation-only pattern the repo
  // already uses at `DocumentsPage.tsx:169` / `ProjectsPage.tsx:84` — the backend
  // stays the authority, the UI just stops offering what it knows will refuse.
  // Fail-closed on the AFFORDANCE, but a failed access READ is not "you lack
  // permission": `accessFailed` says we could not check rather than silently
  // deleting the button (the UX-DOC-3 distinction).
  const [canWrite, setCanWrite] = useState(false);
  const [accessFailed, setAccessFailed] = useState(false);
  useEffect(() => {
    void getEffectiveAccess()
      .then((a) => { setCanWrite(a.scopes.includes('workspace:write')); setAccessFailed(false); })
      .catch(() => { setCanWrite(false); setAccessFailed(true); });
  }, []);
  const load = useCallback(() => {
    // MKT-UX-12 — `setRows(null)` FIRST. Clearing `rowsFailed` while `rows` still
    // held the `[]` written by the previous `catch` made the render fall to
    // `rows.length === 0 && !rowsFailed` for the whole request duration, so a
    // seller clicking Retry saw the confident "No listings yet" over stale failed
    // data, with no skeleton. `null` paints the skeleton instead (the
    // `BundleShopPage.loadCatalog` pattern). The pinning test could not
    // discriminate this: `findByText` awaits past the window.
    setRows(null);
    setRowsFailed(false);
    void listOwnListings().then(setRows).catch(() => { setRows([]); setRowsFailed(true); });
  }, []);
  useEffect(load, [load]);

  /** MKT-UX-7 — load a rejected row back into the editor. Without this the exit
   *  from a rejection is retyping the exact pack id, and a typo silently creates
   *  a SECOND listing for a pack that may not exist. */
  const prefill = useCallback((l: PaidListing) => {
    setPackName(l.packName);
    setLane(l.lane);
    setPrice(l.priceMajorUnits !== undefined ? String(l.priceMajorUnits) : '');
    setCurrency(l.currency ?? 'usd');
    setExternalUrl(l.externalPaymentUrl ?? '');
  }, []);

  /** MPL-6 / MKT-UX-17 — the exit. `danger`-confirmed because it is the seller's
   *  own claim on the pack name that goes: another workspace can take the name
   *  immediately afterwards. */
  const release = useCallback(async (l: PaidListing) => {
    if (!(await confirm({
      title: t('unlistConfirm', { pack: l.packName }),
      body: t('unlistConfirmBody'), danger: true, confirmLabel: t('unlist'),
    }))) return;
    setBusy(true);
    try { await releaseListing(l.packName); toast.success(t('unlisted', { pack: l.packName })); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  }, [load, t]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      await upsertListing(packName.trim(), {
        lane,
        ...(lane === 'native-paid' ? { priceMajorUnits: Number(price), currency } : {}),
        ...(lane === 'external-link' ? { externalPaymentUrl: externalUrl.trim() } : {}),
      });
      toast.success(t('listingSaved', { pack: packName.trim() }));
      setPackName(''); setPrice(''); setExternalUrl('');
      load();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); } finally { setBusy(false); }
  }, [packName, lane, price, currency, externalUrl, load, t]);

  // Save is blocked until the active lane's field is valid; surface the reason inline.
  const priceInvalid = lane === 'native-paid' && !(Number(price) > 0);
  const urlInvalid = lane === 'external-link' && !/^https:\/\//.test(externalUrl.trim());

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <strong>{t('listingsTitle')}</strong>
      {rows === null ? <Skeleton /> : rows.length === 0 ? (
        rowsFailed ? (
          <p className="u-m-0 u-text-sm muted">{t('listingsUnavailable')} <Button variant="quiet" size="sm" onClick={load}>{t('retry')}</Button></p>
        ) : (
        <p className="u-m-0 u-text-sm muted">{t('noListingsYet')}</p>
        )
      ) : (
        <ul className="u-m-0 u-p-0 u-list-none u-grid u-gap-2">
          {rows.map((l) => (
            <li key={l.packName} className="u-grid u-gap-1 u-text-sm">
              <span className="action-bar u-justify-between u-items-center">
                <span><code>{l.packName}</code> · {laneSummary(l, t)}</span>
                <span className="action-bar u-gap-2 u-items-center">
                  {/* `Edit` only pre-fills the local form — harmless without
                      write scope, and removing it would strip a viewer's ability
                      to READ a listing's current lane/price. Save is where the
                      gate belongs, and that is where it is. */}
                  <Button variant="quiet" size="sm" disabled={busy} onClick={() => prefill(l)}>{t('edit')}</Button>
                  {canWrite ? (
                    <Button variant="danger" size="sm" disabled={busy} onClick={() => void release(l)}>{t('unlist')}</Button>
                  ) : null}
                  {/* MPL-11 — ADR 0574 P3 calls `suspended` "visible to the
                      seller, never purchasable, not a 404". The client type
                      omitted `state`, so a held listing rendered identically to
                      a live one and the seller saw a normal listing that
                      silently could not be bought. */}
                  {l.state && l.state !== 'active' ? (
                    <StatusBadge status={l.state === 'suspended' ? 'waiting-approval' : 'cancelled'} label={t(`state_listing_${l.state}`)} />
                  ) : null}
                  {l.lane === 'native-paid' ? (
                    <StatusBadge status={APPROVAL_TONE[l.approvalState ?? 'draft'] ?? 'paused'} label={t(`approval_${l.approvalState ?? 'draft'}`)} />
                  ) : null}
                </span>
              </span>
              {/* MPL-11 — a hold is not self-explanatory; the row carries the
                  operator's reason so the seller knows what to fix. */}
              {l.state === 'suspended' && l.stateMeta?.reason ? (
                <Notice variant="warning">{t('listingHeldReason', { reason: l.stateMeta.reason })}</Notice>
              ) : null}
              {/* MKT-UX-7 — a rejection used to be the single word "Rejected"
                  with no reason and no exit: the seller's only way back was to
                  notice that re-saving re-enters the queue and to retype the
                  exact pack id into the free-text field. Now the reason is shown
                  and "Revise and resubmit" pre-fills the editor below. */}
              {l.approvalState === 'rejected' ? (
                <Notice variant="warning">
                  {l.approvalNote ? t('rejectedReason', { reason: l.approvalNote }) : t('rejectedNoReason')}
                  {' '}
                  <Button variant="quiet" size="sm" onClick={() => prefill(l)}>{t('reviseAndResubmit')}</Button>
                </Notice>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="u-grid u-gap-2">
        <label className="u-grid u-gap-1 u-text-sm">
          <span className="muted">{t('packNameLabel')}</span>
          <input type="text" value={packName} onChange={(e) => setPackName(e.target.value)} placeholder="vendor.example.nodes" />
        </label>
        <label className="u-grid u-gap-1 u-text-sm">
          <span className="muted">{t('laneLabel')}</span>
          <select value={lane} onChange={(e) => setLane(e.target.value as ListingLane)}>
            <option value="native-paid">{t('laneNative')}</option>
            <option value="external-link">{t('laneExternal')}</option>
            <option value="free">{t('laneFree')}</option>
          </select>
        </label>
        {lane === 'native-paid' ? (
          <div className="action-bar u-gap-2">
            <label className="u-grid u-gap-1 u-text-sm">
              <span className="muted">{t('priceLabel')}</span>
              <input type="number" min="1" step="1" value={price} onChange={(e) => setPrice(e.target.value)} />
            </label>
            <label className="u-grid u-gap-1 u-text-sm">
              <span className="muted">{t('currencyLabel')}</span>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="usd">USD</option>
                <option value="eur">EUR</option>
                <option value="brl">BRL</option>
                <option value="gbp">GBP</option>
              </select>
            </label>
          </div>
        ) : null}
        {lane === 'external-link' ? (
          <label className="u-grid u-gap-1 u-text-sm">
            <span className="muted">{t('externalUrlLabel')}</span>
            <input type="url" value={externalUrl} onChange={(e) => setExternalUrl(e.target.value)} placeholder="https://…" />
          </label>
        ) : null}
        <div className="action-bar u-items-center">
          {canWrite ? (
            <Button variant="primary"
              disabled={busy || !packName.trim() || priceInvalid || urlInvalid}
              onClick={save}
            >
              {t('saveListing')}
            </Button>
          ) : null}
          {/* UXR-4a — say WHY save is disabled instead of leaving a dead button */}
          {priceInvalid ? <span className="u-text-sm muted">{t('priceInvalidHint')}</span>
            : urlInvalid ? <span className="u-text-sm muted">{t('urlInvalidHint')}</span>
              : null}
        </div>
        {/* The affordance is gone — say WHY, in the user's language, instead of
            leaving a form with no button. `accessFailed` distinguishes "we could
            not check" from "you are not allowed"; both hide Save, only one is a
            statement about the user. */}
        {!canWrite ? (
          <Notice variant="info">{accessFailed ? t('accessUnknownNotice') : t('readOnlyNotice')}</Notice>
        ) : null}
        <p className="u-m-0 u-text-sm muted">{t('nativePaidHint')}</p>
      </div>
    </div>
  );
}

export function ApprovalQueueCard(): JSX.Element | null {
  const { t } = useTranslation('commerce-connect');
  const [pending, setPending] = useState<PendingListingApproval[] | null>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  // MKT-UX-19 — busy is keyed by approvalId. One flag across the whole queue
  // disabled every row's buttons on any decision and showed nobody which row was
  // in flight.
  const [busy, setBusy] = useState<string | null>(null);
  /** MKT-UX-7 + MKT-UX-14 — the reject lane is a two-step with a REQUIRED reason.
   *  Approve and Reject used to fire on a single click with no confirm at all, on
   *  the gate that admits money-taking listings, and the rejection carried no
   *  reason anywhere in the system. The inline form is the friction AND the
   *  reason field in one, so there is no modal that hides the row it is about. */
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(() => {
    void listApprovals()
      .then((rows) => { setPending(rows); setVisible(true); setFailed(false); })
      .catch((e: unknown) => {
        // UX-CC-1: 401/403 hides (not an operator); anything else shows a retry.
        const notAllowed = e instanceof ApiError && (e.status === 403 || e.status === 401);
        setVisible(!notAllowed);
        setFailed(!notAllowed);
      });
  }, []);
  useEffect(load, [load]);

  const approve = useCallback(async (l: PendingListingApproval) => {
    // MKT-UX-14 — the external-link lane sends buyers to a THIRD-PARTY payment
    // destination. Confirming names it, because approving that URL is the whole
    // decision and a single click is not proportionate to it.
    if (l.externalPaymentUrl && !(await confirm({
      title: t('approveExternalConfirm', { pack: l.packName }),
      body: t('approveExternalConfirmBody', { url: l.externalPaymentUrl }),
      danger: true, confirmLabel: t('approve'),
    }))) return;
    setBusy(l.approvalId);
    try { await decideApproval(l.approvalId, 'approved'); toast.success(t('approvedToast', { pack: l.packName })); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(null); }
  }, [load, t]);

  const reject = useCallback(async (l: PendingListingApproval) => {
    const reason = rejectReason.trim();
    if (!reason) return; // the button is disabled without one; belt and braces
    setBusy(l.approvalId);
    try {
      await decideApproval(l.approvalId, 'rejected', reason);
      toast.success(t('rejectedToast', { pack: l.packName }));
      setRejecting(null); setRejectReason('');
      load();
    }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(null); }
  }, [load, t, rejectReason]);

  if (!visible) return null;
  if (failed) {
    return (
      <div className="surface-card u-p-4 u-grid u-gap-3">
        <strong>{t('approvalsTitle')}</strong>
        <Notice variant="error">{t('approvalsLoadFailed')}</Notice>
        <div className="action-bar"><Button variant="quiet" onClick={load}>{t('retry')}</Button></div>
      </div>
    );
  }
  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <strong>{t('approvalsTitle')}</strong>
      {pending === null ? <Skeleton /> : pending.length === 0 ? (
        <p className="u-m-0 u-text-sm muted">{t('noApprovalsPending')}</p>
      ) : (
        <ul className="u-m-0 u-p-0 u-list-none u-grid u-gap-2">
          {pending.map((l) => (
            /* CC2-B1 — this gate exists to stop a phishing/squat listing, and the
               row used to show a pack name and a price. It showed neither WHO
               was selling nor, on the external-link lane, WHERE the money goes
               — so approving `feature.crm.nodes` told the operator nothing
               about the payment destination being attached to it. Both are now
               on the row, and the destination is rendered as plain text (never
               an anchor): a reviewer must read it, not be invited to click it. */
            <li key={l.approvalId} className="u-grid u-gap-1 u-text-sm">
              <span className="action-bar u-justify-between u-items-center">
                <span>
                  <code>{l.packName}</code>
                  <span className="chip u-ml-2">{l.lane}</span>
                  {l.priceMajorUnits !== undefined ? <> · {formatCurrency(l.priceMajorUnits, l.currency ?? 'usd')}</> : null}
                </span>
              <span className="action-bar u-gap-2">
                {/* MKT-UX-11 — `variant="danger"`, the convention `ui/ConfirmDialog`
                    names for irreversible actions. This was `quiet`, visually
                    identical to the benign quiet buttons beside it. */}
                <Button variant="danger" disabled={busy !== null} onClick={() => { setRejecting(l.approvalId); setRejectReason(''); }}>{t('reject')}</Button>
                <Button variant="primary" disabled={busy !== null} onClick={() => void approve(l)}>{t('approve')}</Button>
                </span>
              </span>
              <span className="muted u-fs-12">
                {t('approvalSeller', { tenant: l.sellerTenantId })}
                {l.externalPaymentUrl ? <> · {t('approvalPaysOut')} <code>{l.externalPaymentUrl}</code></> : null}
              </span>
              {/* CC2-R1 — approving a listing for a pack this host does not have
                  sells bytes that are not here. Stated, not blocked: absence can
                  also mean the pack directory was briefly unreadable, and the
                  operator is the one who can tell the difference. */}
              {l.packMissing ? (
                <Notice variant="warning" announce={t('approvalPackMissing')}>{t('approvalPackMissing')}</Notice>
              ) : null}
              {/* MKT-UX-7 — the reason, required. Without it the seller receives
                  the single word "Rejected" and the only exit is retyping the
                  pack id. The submit is disabled until a reason exists, and the
                  backend refuses a reasonless rejection anyway (400) — the UI
                  states the rule, the route enforces it. */}
              {rejecting === l.approvalId ? (
                <div className="u-grid u-gap-1">
                  <label className="u-grid u-gap-1">
                    <span className="muted">{t('rejectReasonLabel')}</span>
                    <textarea rows={2} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder={t('rejectReasonPlaceholder')} />
                  </label>
                  <span className="action-bar u-gap-2">
                    <Button variant="danger" disabled={busy !== null || !rejectReason.trim()} onClick={() => void reject(l)}>
                      {busy === l.approvalId ? t('rejecting') : t('confirmReject')}
                    </Button>
                    <Button variant="quiet" disabled={busy !== null} onClick={() => { setRejecting(null); setRejectReason(''); }}>{t('cancel')}</Button>
                  </span>
                  {!rejectReason.trim() ? <span className="muted u-fs-12">{t('rejectReasonRequiredHint')}</span> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
