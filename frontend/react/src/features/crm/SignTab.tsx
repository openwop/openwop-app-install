/**
 * CRM E-sign tab (ADR 0402 §b) — the operator surface: request signatures on a
 * commerce quote / document and track each request (per-signer status, void,
 * download certificate). The signing itself happens on the public /sign/:token
 * page. Models the ADR 0008 CRUD-tab pattern.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { FileTextIcon, DownloadIcon } from '../../ui/icons/index.js';
import { listSignRequests, requestSignature, voidSignRequest, type SignRequestView, type SignerStatus, type SignRequestStatus } from './signClient.js';
import { crmActionError, crudErr } from './crmUiHelpers.js';
import { formatDateTime } from '../../i18n/format.js';

interface Props { orgId: string }

const TERMINAL: SignRequestStatus[] = ['completed', 'declined', 'voided'];

export function SignTab({ orgId }: Props): JSX.Element {
  const { t } = useTranslation('crm');
  const { t: tc } = useTranslation('common');
  const [requests, setRequests] = useState<SignRequestView[] | null>(null);
  // A failed read drew "No signature requests yet". Signature state is the kind of
  // thing an operator acts on — chasing a countersignature, or not chasing one.
  const [requestsFailed, setRequestsFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const [targetKind, setTargetKind] = useState('document');
  const [targetId, setTargetId] = useState('');
  const newSignerRow = (): { id: string; email: string; name: string } => ({ id: (crypto.randomUUID?.() ?? String(Math.random())), email: '', name: '' });
  const [signers, setSigners] = useState<{ id: string; email: string; name: string }[]>([newSignerRow()]);

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    // The org-gated read, guarded like every sibling tab's (`if (!orgId) return`).
    // HG-4 moved the page's org states into `ui/OrgSelectionState`, which renders
    // its children while the org read is still in flight — so this tab now mounts
    // for a moment with `orgId` ''. Without the guard that is a real request for
    // the signature requests of no organization; with it, `requests` stays `null`
    // and the skeleton below is the loading affordance, keyed on this tab's read.
    if (!orgId) return;
    const seq = ++loadSeq.current; // review F1 — a late previous-org response must not land
    setRequestsFailed(false);
    try {
      const rows = await listSignRequests(orgId);
      if (seq === loadSeq.current) setRequests(rows);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      // CRM-UX-14 — the wire string is for the developer; the user gets the
      // canonical failed-read card below (the ReportsTab shape).
      console.warn('[crm] sign requests read failed:', e);
      setRequests([]); setRequestsFailed(true);
    }
  }, [orgId]);

  // R2 CC-SP-13 — same as BookingTab: never keep the previous org's signature
  // requests on screen under the new org's header. Registered BEFORE the load
  // effect so the seq bump precedes load()'s capture (else mount deadlocks).
  useEffect(() => { loadSeq.current++; setRequests(null); setRequestsFailed(false); }, [orgId]);
  useEffect(() => { void load(); }, [load]);

  const setSigner = (i: number, patch: Partial<{ email: string; name: string }>): void => {
    setSigners((cur) => cur.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };
  const addSigner = (): void => setSigners((cur) => [...cur, newSignerRow()]);
  const removeSigner = (i: number): void => setSigners((cur) => (cur.length > 1 ? cur.filter((_, idx) => idx !== i) : cur));

  const create = async (): Promise<void> => {
    const clean = signers.map((s, i) => ({ email: s.email.trim(), ...(s.name.trim() ? { name: s.name.trim() } : {}), order: i })).filter((s) => s.email);
    if (!targetId.trim() || clean.length === 0) return;
    setBusy(true);
    try {
      const req = await requestSignature(orgId, { target: { kind: targetKind, id: targetId.trim() }, signers: clean });
      toast.success(t('signRequested'));
      setTargetId('');
      setSigners([newSignerRow()]);
      setRequests((cur) => (cur ? [req, ...cur] : [req]));
    } catch (e) { toast.error(crmActionError(e, 'actionFailed')); }
    finally { setBusy(false); }
  };

  const doVoid = (req: SignRequestView): void => {
    void confirm({ title: t('signVoidConfirm', { title: req.title }), danger: true, confirmLabel: t('signVoid') })
      .then((ok) => { if (ok) voidSignRequest(orgId, req.signRequestId).then(load).catch(crudErr); });
  };

  const reqChip = (status: SignRequestStatus): JSX.Element => {
    const cls = status === 'completed' ? 'chip chip--success'
      : status === 'declined' || status === 'voided' ? 'chip chip--danger'
      : status === 'partially_signed' ? 'chip chip--accent' : 'chip chip--warning';
    return <span className={cls}>{t(`signStatus_${status}`)}</span>;
  };
  const signerChip = (status: SignerStatus): string =>
    status === 'signed' ? 'chip chip--success' : status === 'declined' ? 'chip chip--danger' : 'chip chip--muted';

  return (
    <div className="u-grid u-gap-4">
      {/* Request form */}
      <form className="surface-card u-p-4 surface-form u-grid u-gap-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <div className="u-flex u-items-center u-gap-2"><FileTextIcon size={16} /><strong>{t('signNewTitle')}</strong></div>
        <div className="u-flex u-gap-3 u-flex-wrap">
          <label className="u-grid u-gap-1"><span className="u-label-sm">{t('signFieldTargetKind')}</span>
            <select value={targetKind} onChange={(e) => setTargetKind(e.target.value)} className="u-w-auto">
              <option value="document">{t('signTarget_document')}</option>
              <option value="commerce_quote">{t('signTarget_commerce_quote')}</option>
            </select></label>
          <label className="u-grid u-gap-1 u-flex-1"><span className="u-label-sm">{t('signFieldTargetId')}</span>
            <input value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder={t('signTargetIdPlaceholder')} required /></label>
        </div>
        <div className="u-grid u-gap-1">
          <span className="u-label-sm">{t('signFieldSigners')}</span>
          {signers.map((s, i) => (
            <div key={s.id} className="u-flex u-gap-2 u-flex-wrap u-items-center">
              <input type="email" value={s.email} onChange={(e) => setSigner(i, { email: e.target.value })} placeholder={t('signSignerEmail')} aria-label={t('signSignerEmail')} />
              <input value={s.name} onChange={(e) => setSigner(i, { name: e.target.value })} placeholder={t('signSignerName')} aria-label={t('signSignerName')} />
              {signers.length > 1 ? <Button variant="quiet" onClick={() => removeSigner(i)}>{t('common:delete')}</Button> : null}
            </div>
          ))}
          <div><Button variant="quiet" onClick={addSigner}>{t('signAddSigner')}</Button></div>
        </div>
        <div><Button variant="primary" type="submit" disabled={busy || !targetId.trim() || !signers.some((s) => s.email.trim())}>{t('signRequest')}</Button></div>
      </form>

      {/* Tracker */}
      {requests === null ? <Skeleton /> : requestsFailed ? (
        <StateCard
          announce
          icon={<FileTextIcon />}
          title={tc('loadFailedTitle')}
          body={tc('loadFailedBody')}
          action={<Button variant="secondary" onClick={() => void load()}>{tc('retry')}</Button>}
        />
      ) : requests.length === 0 ? (
        <StateCard icon={<FileTextIcon />} title={t('signEmptyTitle')} body={t('signEmptyBody')} />
      ) : (
        <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
          {requests.map((req) => (
            <li key={req.signRequestId} className="surface-card u-p-4 u-grid u-gap-2">
              <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
                <strong className="u-fs-16">{req.title}</strong>
                {reqChip(req.status)}
                <span className="chip chip--muted">{t(`signTarget_${req.target.kind}`)}</span>
              </div>
              <ul className="u-grid u-gap-1 u-list-none u-p-0 u-m-0">
                {req.signers.map((s) => (
                  <li key={s.signerId} className="u-flex u-items-center u-gap-2 u-flex-wrap">
                    <span className={signerChip(s.status)}>{t(`signSignerStatus_${s.status}`)}</span>
                    <span>{s.name ? `${s.name} · ` : ''}{s.email}</span>
                    {s.signedAt ? <span className="u-fs-12 u-text-muted">{formatDateTime(s.signedAt)}</span> : null}
                  </li>
                ))}
              </ul>
              <div className="action-bar">
                {req.certificateUrl ? (
                  <a className="btn secondary" href={req.certificateUrl} target="_blank" rel="noreferrer"><DownloadIcon size={14} /> {t('signDownloadCert')}</a>
                ) : null}
                {!TERMINAL.includes(req.status) ? <Button variant="quiet" onClick={() => doVoid(req)}>{t('signVoid')}</Button> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
