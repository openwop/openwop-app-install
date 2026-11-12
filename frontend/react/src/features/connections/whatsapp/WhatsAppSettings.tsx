/**
 * WhatsApp settings (ADR 1053 D10; ADR 0394 P2/P3), a lazy sub-view of the
 * Connections page (not a top-level route: the entry chunk has no room, and
 * nothing here belongs in the eager registry). Gated on the `whatsapp` toggle.
 * Three sections, each read on its own so one failure never blanks the others:
 *  - the no-training attestation: until an admin records it, verified inbound
 *    messages never start an AI workflow (fail-closed);
 *  - the WhatsApp-bound connections the caller can see, with the facts that
 *    decide what each can do (scope, inbound) and an on-demand sender-health read;
 *  - recent provider-reported delivery failures (admins; last four digits only).
 * Pairing a sender and configuring inbound stay on the channels page (ADR 1042).
 * Copy lives in the lazy `connections` namespace under `wa_` keys. The three sections
 * sit inside the Connections card, so they use the recessed `.surface-inset`, never a
 * card in a card (DESIGN.md: nested cards drop their chrome; grade-ux WA85UX-19).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../../ui/Button.js';
import { Notice } from '../../../ui/Notice.js';
import { StateCard } from '../../../ui/StateCard.js';
import { Skeleton } from '../../../ui/Skeleton.js';
import { confirm } from '../../../ui/confirm.js';
import { toast } from '../../../ui/toast.js';
import { listMyWorkspaces } from '../../../client/workspaceClient.js';
import { useFeatureAccess } from '../../../featureToggles/FeatureAccessContext.js';
import { useFormat } from '../../../i18n/useFormat.js';
import { ActivityIcon, AlertIcon, MessageCircleIcon, ShieldIcon } from '../../../ui/icons/index.js';
import {
  WhatsAppApiError, getAttestation, getHealth, listDeliveryFailures, listWhatsAppConnections, recordAttestation, revokeAttestation,
  type Attestation, type WaConnection, type WaDeliveryFailure, type WaHealth, type WaQuality,
} from './whatsappClient.js';

type Load<T> = { state: 'loading' } | { state: 'error'; forbidden: boolean } | { state: 'ok'; value: T };
const failed = (err: unknown): Load<never> => ({ state: 'error', forbidden: err instanceof WhatsAppApiError && err.status === 403 });

/** quality → chip tone (DESIGN §5.3: the label is always present, colour is never the only signal). */
const QUALITY_TONE: Record<WaQuality, string> = { high: 'chip--success', medium: 'chip--warning', low: 'chip--danger', unknown: 'chip--muted' };

/** `onAttestationChange` reports every attestation state this view reads or writes, so
 *  the Connections card's status chip never contradicts the card below it (WA85UX-23). */
export function WhatsAppSettings({ onAttestationChange }: { onAttestationChange?: (attested: boolean) => void } = {}): JSX.Element {
  const { t } = useTranslation('connections');
  const access = useFeatureAccess('whatsapp');
  // WA85UX-1/-15 — every section is WORKSPACE-wide and the server judges it at the
  // workspace ROOT (`orgs/<workspace id>`, ADR 1053 D10), so the view addresses the
  // active workspace itself, never an arbitrary org.
  const [workspace, setWorkspace] = useState<Load<string>>({ state: 'loading' });
  const loadWorkspace = useCallback(() => {
    setWorkspace({ state: 'loading' });
    void listMyWorkspaces().then((w) => setWorkspace({ state: 'ok', value: w.active }), (err: unknown) => setWorkspace(failed(err)));
  }, []);
  useEffect(() => { if (access.enabled) loadWorkspace(); }, [access.enabled, loadWorkspace]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) return <StateCard icon={<MessageCircleIcon />} title={t('wa_notEnabledTitle')} body={t('wa_notEnabledBody')} />;
  return (
    <div className="u-grid u-gap-4" data-walkthrough="connections.whatsapp">
      <div className="action-bar u-justify-between u-items-center u-gap-2 u-wrap">
        <p className="u-m-0 muted u-text-sm">{t('wa_lede')}</p>
        <Link className="inline-link" to="/access?tab=channels">{t('wa_pairNumbers')}</Link>
      </div>
      {workspace.state === 'loading' ? <Skeleton /> : workspace.state === 'error' ? (
        <StateCard announce title={t('wa_workspaceLoadErrorTitle')} body={t('wa_loadErrorBody')} action={<Button variant="primary" onClick={loadWorkspace}>{t('wa_retry')}</Button>} />
      ) : <Sections orgId={workspace.value} {...(onAttestationChange ? { onAttestationChange } : {})} />}
    </div>
  );
}

/** The connections are read once: the numbers card lists them and the failures
 *  table names the number each failure came from (WA85UX-4). */
function Sections({ orgId, onAttestationChange }: { orgId: string; onAttestationChange?: (attested: boolean) => void }): JSX.Element {
  const { t } = useTranslation('connections');
  const [connections, setConnections] = useState<Load<WaConnection[]>>({ state: 'loading' });
  const reloadConnections = useCallback(() => {
    setConnections({ state: 'loading' });
    void listWhatsAppConnections(orgId).then((value) => setConnections({ state: 'ok', value }), (err: unknown) => setConnections(failed(err)));
  }, [orgId]);
  useEffect(reloadConnections, [reloadConnections]);
  // Not a member of the workspace root: say so once, instead of three failed cards.
  if (connections.state === 'error' && connections.forbidden) {
    return <StateCard icon={<ShieldIcon />} title={t('wa_notRootMemberTitle')} body={t('wa_notRootMemberBody')} />;
  }
  return (
    <>
      <AttestationCard orgId={orgId} {...(onAttestationChange ? { onAttestationChange } : {})} />
      <ConnectionsCard orgId={orgId} load={connections} reload={reloadConnections} />
      <FailuresCard orgId={orgId} connections={connections} />
    </>
  );
}

function AttestationCard({ orgId, onAttestationChange }: { orgId: string; onAttestationChange?: (attested: boolean) => void }): JSX.Element {
  const { t } = useTranslation('connections');
  const fmt = useFormat();
  const checkboxId = useId();
  const [load, setLoad] = useState<Load<Attestation>>({ state: 'loading' });
  // Every state this card shows (a read, a record, a revoke) reaches the entry chip.
  useEffect(() => { if (load.state === 'ok') onAttestationChange?.(load.value.attested); }, [load, onAttestationChange]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoad({ state: 'loading' });
    void getAttestation(orgId).then((value) => setLoad({ state: 'ok', value }), (err: unknown) => setLoad(failed(err)));
  }, [orgId]);
  useEffect(reload, [reload]);
  // WA85UX-17 — after an action, re-read WITHOUT the loading flip (the card keeps its
  // current state until the GET answers) and move focus to the card's heading: the
  // button the user acted on is replaced (Record ↔ Revoke), so focus must not drop to <body>.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const refreshAfterAction = (): void => {
    void getAttestation(orgId).then((value) => setLoad({ state: 'ok', value }), (err: unknown) => setLoad(failed(err)));
    headingRef.current?.focus();
  };

  const record = async (): Promise<void> => {
    setBusy(true); setActionError(null);
    try {
      // The PUT answers the GET's shape (canManage included); reload anyway so the
      // card always shows the server's view after an action (WA85UX-11).
      setLoad({ state: 'ok', value: await recordAttestation(orgId) }); setConfirmed(false);
      refreshAfterAction();
      toast.success(t('wa_attestRecorded'));
    } catch (err) {
      setActionError(err instanceof WhatsAppApiError && err.status === 403 ? t('wa_attestForbidden') : t('wa_attestFailed'));
    } finally { setBusy(false); }
  };
  const revoke = async (): Promise<void> => {
    if (!(await confirm({ title: t('wa_revokeConfirmTitle'), body: t('wa_revokeConfirmBody'), confirmLabel: t('wa_revoke'), danger: true }))) return;
    setBusy(true); setActionError(null);
    try {
      await revokeAttestation(orgId);
      refreshAfterAction();
      toast.success(t('wa_attestRevoked'));
    } catch (err) {
      setActionError(err instanceof WhatsAppApiError && err.status === 403 ? t('wa_attestForbidden') : t('wa_revokeFailed'));
    } finally { setBusy(false); }
  };

  return (
    <section className="surface-inset u-grid u-gap-3" aria-labelledby={`${checkboxId}-h`}>
      <h3 id={`${checkboxId}-h`} ref={headingRef} tabIndex={-1} className="u-fs-16 u-m-0">{t('wa_attestHeading')}</h3>
      <p className="u-m-0 muted u-text-sm">{t('wa_attestExplain')}</p>
      {load.state === 'loading' ? <Skeleton /> : load.state === 'error' ? (
        <StateCard announce title={t('wa_attestLoadErrorTitle')} body={t('wa_loadErrorBody')} action={<Button variant="primary" onClick={reload}>{t('wa_retry')}</Button>} />
      ) : load.value.attested ? (
        <div className="action-bar u-justify-between u-items-center u-gap-2 u-wrap">
          <div className="u-flex u-items-center u-gap-2 u-wrap">
            <span className="chip chip--success">{t('wa_attestedChip')}</span>
            <span className="u-text-sm muted">
              {load.value.attestedAt
                ? (load.value.attestedByName
                  ? t('wa_attestedLine', { when: fmt.date(load.value.attestedAt), who: load.value.attestedByName })
                  : t('wa_attestedLineNoName', { when: fmt.date(load.value.attestedAt) }))
                : null}
            </span>
          </div>
          {load.value.canManage
            ? <Button variant="danger" size="sm" loading={busy} onClick={() => void revoke()}>{t('wa_revoke')}</Button>
            : <span className="u-text-sm muted">{t('wa_adminOnlyChange')}</span>}
        </div>
      ) : (
        <div className="u-grid u-gap-2">
          <Notice variant="warning">{t('wa_notAttestedNotice')}</Notice>
          {load.value.canManage ? <>
          <label htmlFor={checkboxId} className="u-flex u-items-start u-gap-2 u-text-sm">
            <input id={checkboxId} type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>{t('wa_attestConfirmLabel')}</span>
          </label>
          <div><Button variant="primary" disabled={!confirmed} loading={busy} onClick={() => void record()}>{t('wa_attestRecord')}</Button></div>
          </> : <p className="u-m-0 u-text-sm muted">{t('wa_adminOnlyChange')}</p>}
        </div>
      )}
      {actionError ? <Notice variant="error" announce={actionError}>{actionError}</Notice> : null}
    </section>
  );
}

function ConnectionsCard({ orgId, load, reload }: { orgId: string; load: Load<WaConnection[]>; reload: () => void }): JSX.Element {
  const { t } = useTranslation('connections');
  const headingId = useId();

  return (
    <section className="surface-inset u-grid u-gap-3" aria-labelledby={headingId}>
      <h3 id={headingId} className="u-fs-16 u-m-0">{t('wa_connectionsHeading')}</h3>
      {load.state === 'loading' ? <Skeleton /> : load.state === 'error' ? (
        <StateCard announce title={t('wa_connectionsLoadErrorTitle')} body={t('wa_loadErrorBody')} action={<Button variant="primary" onClick={reload}>{t('wa_retry')}</Button>} />
      ) : load.value.length === 0 ? (
        <StateCard icon={<MessageCircleIcon />} title={t('wa_connectionsEmptyTitle')} body={t('wa_connectionsEmptyBody')}
          action={<Link className="inline-link" to="/access?tab=channels">{t('wa_openChannels')}</Link>} />
      ) : (
        <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
          {load.value.map((c) => <ConnectionRow key={c.connectionId} orgId={orgId} c={c} />)}
        </ul>
      )}
    </section>
  );
}

function ConnectionRow({ orgId, c }: { orgId: string; c: WaConnection }): JSX.Element {
  const { t } = useTranslation('connections');
  const fmt = useFormat();
  const [health, setHealth] = useState<Load<WaHealth> | null>(null);
  const check = (): void => {
    setHealth({ state: 'loading' });
    void getHealth(orgId, c.connectionId).then((value) => setHealth({ state: 'ok', value }), (err: unknown) => setHealth(failed(err)));
  };
  return (
    <li className="action-bar u-grid u-gap-2">
      <div className="u-flex u-justify-between u-items-center u-gap-2 u-wrap">
        <div className="u-minw-0 u-grid u-gap-1">
          <div className="u-flex u-items-center u-gap-2 u-wrap">
            <strong className="u-truncate">{c.displayName}</strong>
            <span className="chip">{t(c.transport === 'whatsapp-twilio' ? 'wa_transport_twilio' : 'wa_transport_cloud')}</span>
            <span className={`chip ${c.axis === 'user' ? 'chip--warning' : 'chip--muted'}`}>{t(`wa_axis_${c.axis}`)}</span>
            <span className={`chip ${c.inbound === 'enabled' ? 'chip--success' : 'chip--warning'}`}>{t(`wa_inbound_${c.inbound}`)}</span>
          </div>
          <span className="u-text-sm muted">{t('wa_senderLine', { sender: c.sender })}</span>
        </div>
        {c.transport === 'whatsapp-twilio' ? (
          <Button size="sm" variant="secondary" loading={health?.state === 'loading'} onClick={check}><ActivityIcon /> {t('wa_checkHealth')}</Button>
        ) : null}
      </div>
      {c.axis === 'user' ? <p className="u-m-0 u-text-sm muted">{t('wa_axisUserHint')}</p> : null}
      {c.inbound !== 'enabled' ? <p className="u-m-0 u-text-sm muted">{t('wa_inboundMissingHint')} <Link className="inline-link" to="/access?tab=channels">{t('wa_openChannels')}</Link></p> : null}
      {c.transport === 'whatsapp-cloud' ? <p className="u-m-0 u-text-sm muted">{t('wa_healthTwilioOnly')}</p> : null}
      {health?.state === 'error' ? <Notice variant="error" announce={t('wa_healthFailed')}>{t('wa_healthFailed')}</Notice> : null}
      {health?.state === 'ok' ? (
        health.value.sender ? (
          <div className="u-flex u-items-center u-gap-2 u-wrap u-text-sm" role="status">
            <span className={`chip ${QUALITY_TONE[health.value.sender.quality]}`}>{t(`wa_quality_${health.value.sender.quality}`)}</span>
            {health.value.sender.status ? <span className="chip chip--muted">{t('wa_senderStatus', { status: t(`wa_senderStatus_${health.value.sender.status}`, { defaultValue: health.value.sender.status }) })}</span> : null}
            {health.value.sender.messagingLimit ? <span className="chip chip--muted">{t('wa_messagingLimit', { limit: health.value.sender.messagingLimit })}</span> : null}
            <span className="muted">{t('wa_checkedAt', { when: fmt.dateTime(health.value.fetchedAt) })}</span>
            {health.value.sender.quality === 'unknown' && health.value.sender.status === null
              ? <span className="muted">{t('wa_healthNoRating')}</span> : null}
          </div>
        ) : <p className="u-m-0 u-text-sm muted" role="status">{t('wa_healthUnbound')}</p>
      ) : null}
    </li>
  );
}

function FailuresCard({ orgId, connections }: { orgId: string; connections: Load<WaConnection[]> }): JSX.Element {
  const { t } = useTranslation('connections');
  const fmt = useFormat();
  const headingId = useId();
  const [load, setLoad] = useState<Load<WaDeliveryFailure[]>>({ state: 'loading' });
  const reload = useCallback(() => {
    setLoad({ state: 'loading' });
    void listDeliveryFailures(orgId).then((value) => setLoad({ state: 'ok', value }), (err: unknown) => setLoad(failed(err)));
  }, [orgId]);
  useEffect(reload, [reload]);

  return (
    <section className="surface-inset u-grid u-gap-3" aria-labelledby={headingId}>
      <h3 id={headingId} className="u-fs-16 u-m-0">{t('wa_failuresHeading')}</h3>
      <p className="u-m-0 muted u-text-sm">{t('wa_failuresExplain')}</p>
      {load.state === 'loading' ? <Skeleton /> : load.state === 'error' ? (
        load.forbidden
          ? <StateCard icon={<ShieldIcon />} title={t('wa_failuresForbiddenTitle')} body={t('wa_failuresForbiddenBody')} />
          : <StateCard announce title={t('wa_failuresLoadErrorTitle')} body={t('wa_loadErrorBody')} action={<Button variant="primary" onClick={reload}>{t('wa_retry')}</Button>} />
      ) : load.value.length === 0 ? (
        <StateCard icon={<AlertIcon />} title={t('wa_failuresEmptyTitle')} body={t('wa_failuresEmptyBody')} />
      ) : (
        <div className="u-overflow-x-auto">
          <table className="data-table">
            <caption className="sr-only">{t('wa_failuresHeading')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('wa_colWhen')}</th>
                <th scope="col">{t('wa_colStatus')}</th>
                <th scope="col">{t('wa_colNumber')}</th>
                <th scope="col">{t('wa_colRecipient')}</th>
                <th scope="col">{t('wa_colKind')}</th>
                <th scope="col">{t('wa_colError')}</th>
              </tr>
            </thead>
            <tbody>
              {load.value.map((f) => (
                <tr key={f.providerSid}>
                  <td>{fmt.dateTime(f.at)}</td>
                  <td><span className="chip chip--danger">{t(`wa_status_${f.status}`)}</span></td>
                  <td>{connections.state === 'loading'
                    ? <><span aria-hidden="true">…</span><span className="sr-only">{t('wa_loadingNumber')}</span></>
                    : connections.state === 'error'
                      ? t('wa_unknownNumber')
                      : connections.value.find((c) => c.connectionId === f.connectionId)?.displayName ?? t('wa_removedConnection')}</td>
                  <td><span aria-hidden="true">•••• {f.recipientLast4}</span><span className="sr-only">{t('wa_recipientAria', { last4: f.recipientLast4 })}</span></td>
                  <td>{t(`wa_kind_${f.kind}`)}</td>
                  <td>{f.errorCode ?? t('wa_noErrorCode')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
