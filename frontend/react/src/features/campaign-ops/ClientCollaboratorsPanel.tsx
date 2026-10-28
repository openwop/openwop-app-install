/**
 * ADR 0958 matrix row 10 — the agency's Collaborators panel for one client:
 * invite a vendor or freelancer, give them access to one campaign or approved
 * brief for a limited time, take access back, and suspend, reactivate or remove
 * them. Every action is a call to the existing routes, which hold the authority
 * (`host:members:manage` on the client); this panel adds none and shows the
 * server's own refusal verbatim.
 *
 * The states are shown as the server holds them (D2/D7): an invite not yet
 * accepted, active, suspended, removed. An archived client takes no new
 * collaborator and every grant is refused while it is archived; archiving
 * suspends its signed-in collaborators, so after un-archiving each must be
 * reactivated by a person. Client approvers (link-only) are managed in the
 * approvers panel and are not listed here.
 *
 * Lazy (own chunk), agency admins only. Renders nothing when external
 * collaborators are off or the caller does not manage this client. A failed
 * read is said with a retry, never shown as "no collaborators".
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { CheckboxField, SelectField, TextField } from '../../ui/Field.js';
import { InlineState } from '../../ui/InlineState.js';
import { Notice } from '../../ui/Notice.js';
import { confirm } from '../../ui/confirm.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';
import { formatDate } from '../../i18n/format.js';
import { CampaignOpsError, type ClientStatus } from './campaignOpsClient.js';
import {
  grantCollaborator, inviteCollaborator, inviteUrl, listCollaborators, listGrantable, revokeCollaboratorGrant, setCollaboratorStatus,
  type Collaborator, type CollaboratorGrant, type GrantAction, type GrantableKind,
} from './collaboratorsClient.js';

type Load = { kind: 'loading' } | { kind: 'hidden' } | { kind: 'failed' } | { kind: 'ready'; people: Collaborator[]; grantable: GrantableKind[] };
type TFn = ReturnType<typeof useTranslation>['t'];

const EXPIRY_CHOICES = [7, 30, 90, 180] as const;
const STATUS_CHIP: Record<Collaborator['status'], string> = {
  invited: 'chip chip--accent', active: 'chip chip--success', suspended: 'chip chip--warning', revoked: 'chip chip--muted',
};

const hidden = (e: unknown): boolean =>
  e instanceof CampaignOpsError && (e.status === 403 || (e.status === 404 && /not enabled/i.test(e.message)));
const failureText = (e: unknown, t: TFn): string => (e instanceof CampaignOpsError && e.message ? e.message : t('collabActionFailed'));
const grantLive = (g: CollaboratorGrant, now: number): boolean => g.status === 'active' && Date.parse(g.expiresAt) > now;

export function ClientCollaboratorsPanel({ orgId, clientStatus }: { orgId: string; clientStatus: ClientStatus }): JSX.Element | null {
  const { t } = useTranslation('campaign-ops');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [invite, setInvite] = useState({ kind: 'vendor' as 'vendor' | 'freelancer', displayName: '', email: '', company: '' });
  const [sentLink, setSentLink] = useState<{ name: string; url: string; expiresAt?: string } | null>(null);
  const [granting, setGranting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [people, grantable] = await Promise.all([listCollaborators(orgId), listGrantable(orgId)]);
      setLoad({ kind: 'ready', people: people.filter((c) => c.mode === 'signed-in'), grantable });
    } catch (e) {
      setLoad(hidden(e) ? { kind: 'hidden' } : { kind: 'failed' });
    }
  }, [orgId]);
  useEffect(() => { setLoad({ kind: 'loading' }); setSentLink(null); setGranting(null); void refresh(); }, [refresh]);

  const titles = useMemo(() => {
    const m = new Map<string, string>();
    if (load.kind === 'ready') for (const k of load.grantable) for (const i of k.items) m.set(`${k.kind}:${i.id}`, i.title);
    return m;
  }, [load]);

  const run = async (fn: () => Promise<void>, done: string): Promise<boolean> => {
    setBusy(true); setError(null); setStatus(null);
    try { await fn(); setStatus(done); await refresh(); return true; }
    catch (e) { setError(failureText(e, t)); return false; }
    finally { setBusy(false); }
  };

  if (load.kind === 'hidden') return null;
  const archived = clientStatus === 'archived';
  const now = Date.now();
  const people = load.kind === 'ready' ? load.people : [];
  const current = people.filter((c) => c.status !== 'revoked');
  const removed = people.filter((c) => c.status === 'revoked');

  const sendInvite = async (): Promise<void> => {
    const name = invite.displayName.trim();
    await run(async () => {
      const out = await inviteCollaborator(orgId, {
        kind: invite.kind, displayName: name, email: invite.email.trim(), ...(invite.company.trim() ? { company: invite.company.trim() } : {}),
      });
      setSentLink({ name, url: inviteUrl(out.invite.token), ...(out.invite.expiresAt ? { expiresAt: out.invite.expiresAt } : {}) });
      setInvite({ kind: invite.kind, displayName: '', email: '', company: '' });
    }, t('collabInvited', { name }));
  };

  const remove = async (c: Collaborator): Promise<void> => {
    const ok = await confirm({
      title: t('collabRemoveTitle', { name: c.displayName }),
      body: t('collabRemoveBody'),
      confirmLabel: t('collabRemove'),
      danger: true,
    });
    if (ok) await run(() => setCollaboratorStatus(orgId, c.collaboratorId, 'revoked'), t('collabRemoved', { name: c.displayName }));
  };

  return (
    <section className="surface-card u-grid u-gap-3" aria-labelledby="campaign-ops-collaborators">
      <div>
        <h3 id="campaign-ops-collaborators" className="u-mt-0 u-mb-1 u-fs-15">{t('collabHeading')}</h3>
        <p className="muted u-fs-13 u-m-0">{t('collabIntro')}</p>
      </div>
      {archived ? <Notice variant="warning">{t('collabArchived')}</Notice> : null}
      {load.kind === 'loading' ? <InlineState kind="loading" message={t('collabLoading')} /> : null}
      {load.kind === 'failed' ? (
        <InlineState kind="failed" announce={t('collabLoadFailed')} announcePolite message={t('collabLoadFailed')}
          action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('intakeRetry')}</Button>} />
      ) : null}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {status ? <Notice variant="success" announce={status}>{status}</Notice> : null}

      {sentLink ? (
        <div className="u-grid u-gap-2">
          <p className="u-m-0 u-fs-13">{t('collabLinkOnce', { name: sentLink.name })}{sentLink.expiresAt ? ` ${t('collabLinkExpires', { date: formatDate(sentLink.expiresAt) })}` : ''}</p>
          <div className="u-flex u-flex-wrap u-items-end u-gap-2">
            <TextField label={t('collabLinkLabel', { name: sentLink.name })} value={sentLink.url} readOnly onFocus={(e) => e.currentTarget.select()} className="u-minw-240 u-mb-0" />
            <Button size="sm" variant="secondary" onClick={() => void copyToClipboard(sentLink.url, t('collabLinkCopied'))}>{t('linkCopy')}</Button>
            <Button size="sm" variant="link" onClick={() => setSentLink(null)}>{t('collabLinkDone')}</Button>
          </div>
        </div>
      ) : null}

      {load.kind === 'ready' && current.length === 0 ? <p className="muted u-m-0">{t('collabEmpty')}</p> : null}
      {current.length > 0 ? (
        <ul className="u-list-plain u-grid u-gap-3 u-m-0" aria-label={t('collabListLabel')}>
          {current.map((c) => (
            <li key={c.collaboratorId} className="u-grid u-gap-1">
              <span className="u-flex u-flex-wrap u-items-center u-gap-2">
                <span className="u-fw-600">{c.displayName}</span>
                {c.company ? <span className="muted u-fs-13">{c.company}</span> : null}
                <span className="muted u-fs-13">{c.email}</span>
                <span className="chip chip--muted">{t(`collabKind_${c.kind === 'freelancer' ? 'freelancer' : 'vendor'}`)}</span>
                <span className={STATUS_CHIP[c.status]}>{t(`collabStatus_${c.status}`)}</span>
              </span>
              {c.status === 'invited' ? <span className="u-fs-13 muted">{t('collabInvitedHint')}</span> : null}
              {c.status === 'suspended' ? <span className="u-fs-13 muted">{archived ? t('collabSuspendedArchivedHint') : t('collabSuspendedHint')}</span> : null}
              <GrantList c={c} now={now} titles={titles} busy={busy} t={t}
                onRevoke={(g) => void run(() => revokeCollaboratorGrant(orgId, c.collaboratorId, g.grantId), t('collabGrantRevoked'))} />
              {granting === c.collaboratorId && load.kind === 'ready' ? (
                <GrantForm grantable={load.grantable} busy={busy} t={t} onCancel={() => setGranting(null)}
                  onGrant={(body) => void run(() => grantCollaborator(orgId, c.collaboratorId, body).then(() => undefined), t('collabGranted', { name: c.displayName })).then((ok) => { if (ok) setGranting(null); })} />
              ) : (
                <div className="action-bar u-flex u-flex-wrap u-gap-2">
                  <Button size="sm" variant="secondary" disabled={busy || archived} onClick={() => { setGranting(c.collaboratorId); setError(null); }}>{t('collabGiveAccess')}</Button>
                  {c.status === 'active' ? (
                    <Button size="sm" variant="quiet" disabled={busy} onClick={() => void run(() => setCollaboratorStatus(orgId, c.collaboratorId, 'suspended'), t('collabSuspended', { name: c.displayName }))}>{t('collabSuspend')}</Button>
                  ) : null}
                  {c.status === 'suspended' ? (
                    <Button size="sm" variant="quiet" disabled={busy || archived} onClick={() => void run(() => setCollaboratorStatus(orgId, c.collaboratorId, 'active'), t('collabReactivated', { name: c.displayName }))}>{t('collabReactivate')}</Button>
                  ) : null}
                  <Button size="sm" variant="quiet" disabled={busy} onClick={() => void remove(c)}>{t('collabRemove')}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {removed.length > 0 ? (
        <details>
          <summary className="u-fs-13">{t('collabRemovedList', { count: removed.length })}</summary>
          <ul className="u-m-0 u-fs-13">
            {removed.map((c) => <li key={c.collaboratorId}>{c.displayName} · {c.email}</li>)}
          </ul>
        </details>
      ) : null}

      {load.kind === 'ready' && !archived ? (
        <form className="u-grid u-gap-2" aria-label={t('collabInviteHeading')}
          onSubmit={(e) => { e.preventDefault(); void sendInvite(); }}>
          <h4 className="u-m-0 u-fs-13 u-fw-600">{t('collabInviteHeading')}</h4>
          <div className="u-flex u-flex-wrap u-items-end u-gap-2">
            <SelectField label={t('collabKindLabel')} value={invite.kind} onChange={(e) => setInvite({ ...invite, kind: e.target.value === 'freelancer' ? 'freelancer' : 'vendor' })} className="u-mb-0">
              <option value="vendor">{t('collabKind_vendor')}</option>
              <option value="freelancer">{t('collabKind_freelancer')}</option>
            </SelectField>
            <TextField label={t('collabName')} value={invite.displayName} onChange={(e) => setInvite({ ...invite, displayName: e.target.value })} required maxLength={120} className="u-mb-0" />
            <TextField label={t('collabEmail')} type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} required maxLength={254} className="u-mb-0" />
            <TextField label={t('collabCompany')} value={invite.company} onChange={(e) => setInvite({ ...invite, company: e.target.value })} maxLength={120} className="u-mb-0" />
            <Button type="submit" size="sm" loading={busy} disabled={busy || !invite.displayName.trim() || !invite.email.trim()}>{t('collabInvite')}</Button>
          </div>
          <p className="muted u-fs-13 u-m-0">{t('collabInviteHelp')}</p>
        </form>
      ) : null}
    </section>
  );
}

function GrantList({ c, now, titles, busy, t, onRevoke }: {
  c: Collaborator; now: number; titles: Map<string, string>; busy: boolean; t: TFn; onRevoke: (g: CollaboratorGrant) => void;
}): JSX.Element | null {
  const live = c.grants.filter((g) => grantLive(g, now));
  if (live.length === 0) return <span className="u-fs-13 muted">{t('collabNoAccess')}</span>;
  return (
    <ul className="u-m-0 u-fs-13" aria-label={t('collabAccessLabel', { name: c.displayName })}>
      {live.map((g) => {
        const title = titles.get(`${g.resource.kind}:${g.resource.id}`) ?? t('collabResourceUnlisted');
        return (
          <li key={g.grantId} className="u-flex u-flex-wrap u-items-center u-gap-2">
            <span>{t(`collabResourceKind_${g.resource.kind === 'creative-brief' ? 'creative_brief' : g.resource.kind === 'campaign' ? 'campaign' : 'other'}`)}: {title}</span>
            <span className="muted">{g.actions.map((a) => t(`collabAction_${a.replace('-', '_')}`)).join(', ')}</span>
            <span className="muted">{t('collabUntil', { date: formatDate(g.expiresAt) })}</span>
            <Button size="sm" variant="link" disabled={busy} onClick={() => onRevoke(g)} aria-label={t('collabRevokeAccessAria', { title, name: c.displayName })}>{t('collabRevokeAccess')}</Button>
          </li>
        );
      })}
    </ul>
  );
}

function GrantForm({ grantable, busy, t, onGrant, onCancel }: {
  grantable: GrantableKind[]; busy: boolean; t: TFn;
  onGrant: (body: { resource: { kind: string; id: string }; actions: GrantAction[]; expiresInDays: number }) => void; onCancel: () => void;
}): JSX.Element {
  const options = grantable.flatMap((k) => k.items.map((i) => ({ value: `${k.kind}:${i.id}`, kind: k.kind, id: i.id, title: i.title, actions: k.actions })));
  const [pick, setPick] = useState(options[0]?.value ?? '');
  const chosen = options.find((o) => o.value === pick);
  const [actions, setActions] = useState<GrantAction[]>(['view']);
  const [days, setDays] = useState<number>(30);
  const offered = chosen?.actions.join(',') ?? '';
  // Keep only the actions the picked kind supports. Keyed on the kind's action
  // list (a string), and a no-op when nothing changes, so it cannot loop.
  useEffect(() => {
    const allowed = offered.split(',');
    setActions((cur) => (cur.every((a) => allowed.includes(a)) ? cur : cur.filter((a) => allowed.includes(a))));
  }, [offered]);
  if (options.length === 0) {
    return (
      <div className="u-flex u-flex-wrap u-items-center u-gap-2">
        <span className="u-fs-13">{t('collabNothingToGrant')}</span>
        <Button size="sm" variant="link" onClick={onCancel}>{t('intakeCancel')}</Button>
      </div>
    );
  }
  return (
    <form className="u-grid u-gap-2" aria-label={t('collabGiveAccess')}
      onSubmit={(e) => { e.preventDefault(); if (chosen) onGrant({ resource: { kind: chosen.kind, id: chosen.id }, actions, expiresInDays: days }); }}>
      <div className="u-flex u-flex-wrap u-items-end u-gap-2">
        <SelectField label={t('collabResourceLabel')} value={pick} onChange={(e) => setPick(e.target.value)} className="u-mb-0">
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {t(`collabResourceKind_${o.kind === 'creative-brief' ? 'creative_brief' : o.kind === 'campaign' ? 'campaign' : 'other'}`)}: {o.title}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('collabExpiresLabel')} value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="u-mb-0">
          {EXPIRY_CHOICES.map((d) => <option key={d} value={d}>{t('collabDays', { count: d })}</option>)}
        </SelectField>
      </div>
      <fieldset className="u-flex u-flex-wrap u-gap-3 u-m-0 u-p-0 u-border-0">
        <legend className="u-fs-13 u-mb-1">{t('collabActionsLabel')}</legend>
        {(chosen?.actions ?? []).map((a) => (
          <CheckboxField key={a} label={t(`collabAction_${a.replace('-', '_')}`)} checked={actions.includes(a)}
            onChange={(e) => setActions((cur) => (e.target.checked ? [...cur, a] : cur.filter((x) => x !== a)))} />
        ))}
      </fieldset>
      <div className="action-bar u-flex u-gap-2">
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={busy || !chosen || actions.length === 0}>{t('collabGrant')}</Button>
        <Button size="sm" variant="link" onClick={onCancel}>{t('intakeCancel')}</Button>
      </div>
    </form>
  );
}
