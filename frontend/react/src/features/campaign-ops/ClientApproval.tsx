/**
 * ADR 0924 D4/D5 — the agency side of client approval.
 *
 *  - `ClientApproversPanel` (agency admins): who at the client approves, and the
 *    switch between "the agency approves" and "the client approves". Shown only
 *    while the client approval portal is on.
 *  - `SendToClient` (on an in-review change): makes a private link per approver
 *    and shows each once, to copy and send. Sending again replaces the old links.
 *
 * The client never gets an account: the link is the whole of their access, and
 * it ends when the change is decided, the approver is removed or seven days pass.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { TextField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import {
  addApprover, listApprovers, removeApprover, sendApprovalLinks, updateClient, CampaignOpsError,
  type ClientAccount, type ClientApprover, type SentApprovalLink,
} from './campaignOpsClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];

/** The server's own plain-language message (e.g. "Add a client approver first."). */
function failureText(e: unknown, t: TFn): string {
  return e instanceof CampaignOpsError && e.message ? e.message : t('actionFailed');
}

export function ClientApproversPanel({ client, onClientChanged }: { client: ClientAccount; onClientChanged: (c: ClientAccount) => void }): JSX.Element | null {
  const { t } = useTranslation('campaign-ops');
  const [approvers, setApprovers] = useState<ClientApprover[] | null>(null);
  const [portalOn, setPortalOn] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const out = await listApprovers(client.orgId);
      setApprovers(out.approvers.filter((a) => a.status === 'active'));
      setPortalOn(out.portalEnabled);
    } catch (e) {
      setError(failureText(e, t));
    }
  }, [client.orgId, t]);
  useEffect(() => { setApprovers(null); setError(null); void load(); }, [load]);

  if (!portalOn && client.approvalPolicy !== 'client') return null;

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError(failureText(e, t)); } finally { setBusy(false); }
  };
  const clientApproves = client.approvalPolicy === 'client';

  return (
    <details className="surface-card u-grid u-gap-2" open={clientApproves}>
      <summary className="u-fw-600">{t('approversTitle')}</summary>
      <p className="u-m-0 u-fs-13 u-text-muted">{clientApproves ? t('approversClientMode') : t('approversAgencyMode')}</p>
      {approvers === null ? <p className="u-m-0 u-fs-13 u-text-muted">{t('loading')}</p> : approvers.length === 0 ? (
        <p className="u-m-0 u-fs-13">{t('approversEmpty')}</p>
      ) : (
        <ul className="u-list-plain u-grid u-gap-1 u-m-0">
          {approvers.map((a) => (
            <li key={a.approverId} className="u-flex u-flex-wrap u-items-center u-gap-2">
              <span>{a.displayName}</span>
              <span className="u-text-muted u-fs-13">{a.email}</span>
              <Button size="sm" variant="quiet" disabled={busy} onClick={() => void run(() => removeApprover(client.orgId, a.approverId))}>
                {t('approverRemove', { name: a.displayName })}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="u-flex u-flex-wrap u-items-end u-gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => { await addApprover(client.orgId, { displayName: name.trim(), email: email.trim() }); setName(''); setEmail(''); });
        }}
      >
        <TextField label={t('approverName')} value={name} onChange={(e) => setName(e.target.value)} required />
        <TextField label={t('approverEmail')} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Button type="submit" size="sm" loading={busy} disabled={busy || !name.trim() || !email.trim()}>{t('approverAdd')}</Button>
      </form>
      <div className="u-flex u-flex-wrap u-gap-2">
        <Button
          size="sm"
          variant={clientApproves ? 'quiet' : 'secondary'}
          disabled={busy}
          onClick={() => void run(async () => onClientChanged(await updateClient(client.orgId, { approvalPolicy: clientApproves ? 'agency' : 'client' })))}
        >
          {clientApproves ? t('policyToAgency') : t('policyToClient')}
        </Button>
      </div>
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
    </details>
  );
}

export function SendToClient({ orgId, changeSetId, disabled }: { orgId: string; changeSetId: string; disabled: boolean }): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const [links, setLinks] = useState<SentApprovalLink[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { setLinks(await sendApprovalLinks(orgId, changeSetId)); } catch (e) { setError(failureText(e, t)); } finally { setBusy(false); }
  };
  const copy = (link: SentApprovalLink): void => {
    void navigator.clipboard?.writeText(link.url).then(() => setCopied(link.approverId)).catch(() => setCopied(null));
  };

  return (
    <div className="u-grid u-gap-2">
      <div className="u-flex u-flex-wrap u-gap-2">
        <Button size="sm" variant="primary" loading={busy} disabled={disabled || busy} onClick={() => void send()}>
          {links ? t('sendToClientAgain') : t('sendToClient')}
        </Button>
      </div>
      {links ? (
        <div className="u-grid u-gap-2">
          <p className="u-m-0 u-fs-13 u-text-muted">{t('sendToClientHelp')}</p>
          <ul className="u-list-plain u-grid u-gap-2 u-m-0">
            {links.map((l) => (
              <li key={l.approverId} className="u-grid u-gap-1">
                <span className="u-fs-13">{l.displayName} · {l.email}</span>
                <div className="u-flex u-flex-wrap u-items-end u-gap-2">
                  <TextField label={t('linkFor', { name: l.displayName })} value={l.url} readOnly onFocus={(e) => e.currentTarget.select()} className="u-minw-240" />
                  <Button size="sm" variant="secondary" onClick={() => copy(l)}>{copied === l.approverId ? t('linkCopied') : t('linkCopy')}</Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
    </div>
  );
}
