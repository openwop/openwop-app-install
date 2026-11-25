/**
 * ADR 1099 P1 — the project's "Client access" tab: invite someone outside the
 * workspace (a client, or another firm such as a builder) to THIS project, give
 * someone already invited to the org access to it, and take access back.
 *
 * Every action is a call to the host collaborator routes, which hold the rules:
 * `host:members:manage` on the project's org, and the `projects.client-portal`
 * switch (the tab only shows when it is on). A refusal is a uniform 404, shown as
 * "only workspace admins can do this", never as "no one has access". A failed
 * read says so with a retry.
 *
 * Inviting and giving access are create actions, so each opens a `CreateDialog`
 * from a button (issue 5921), never a form sitting on the tab.
 *
 * What an invited person sees is decided on the server (the project's name and
 * status in P1); this tab says so rather than implying more.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { CreateDialog } from '../../ui/CreateDialog.js';
import { SelectField, TextField } from '../../ui/Field.js';
import { InlineState } from '../../ui/InlineState.js';
import { Notice } from '../../ui/Notice.js';
import { confirm } from '../../ui/confirm.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';
import { formatDate } from '../../i18n/format.js';
import type { Project } from './projectsClient.js';
import {
  ClientAccessError, grantProject, inviteToOrg, listOrgCollaborators, listProjectAudiences, projectInviteUrl, revokeProjectGrant,
  type OrgCollaborator, type ProjectCollaboratorKind, type ProjectGrant, type ProjectGrantAction,
} from './projectClientAccessClient.js';

/** `audiences` is null when the labels could not be read: no picker, and a new grant gets the most limited view. */
type Load = { kind: 'loading' } | { kind: 'no-authority' } | { kind: 'failed' } | { kind: 'ready'; people: OrgCollaborator[]; audiences: string[] | null };
type Access = 'view' | 'comment';
const EXPIRY_CHOICES = [7, 30, 90, 180] as const;
const actionsFor = (a: Access): ProjectGrantAction[] => (a === 'comment' ? ['view', 'comment'] : ['view']);

export function ProjectClientAccessTab({ project }: { project: Project }): JSX.Element {
  const { t } = useTranslation('projects');
  const orgId = project.orgId;
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [invite, setInvite] = useState({ kind: 'client-stakeholder' as ProjectCollaboratorKind, displayName: '', email: '', company: '' });
  const [access, setAccess] = useState<Access>('comment');
  const [days, setDays] = useState<number>(30);
  const [audience, setAudience] = useState('');
  const [existing, setExisting] = useState('');
  const [sentLink, setSentLink] = useState<{ name: string; url: string; expiresAt?: string } | null>(null);
  const [dialog, setDialog] = useState<'invite' | 'add' | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [people, audiences] = await Promise.all([
        listOrgCollaborators(orgId),
        // A failed read of the labels is shown below, and only narrows: no picker, so
        // a new grant carries no audience and gets the most limited view.
        listProjectAudiences(orgId).then((a): string[] | null => a, (): null => null),
      ]);
      setLoad({ kind: 'ready', people, audiences });
    } catch (e) {
      setLoad(e instanceof ClientAccessError && (e.status === 403 || e.status === 404) ? { kind: 'no-authority' } : { kind: 'failed' });
    }
  }, [orgId]);
  useEffect(() => { setLoad({ kind: 'loading' }); setSentLink(null); void refresh(); }, [refresh]);

  const run = async (fn: () => Promise<void>, ok: string): Promise<void> => {
    setBusy(true); setError(null); setDone(null);
    try { await fn(); setDone(ok); await refresh(); }
    catch (e) { setError(e instanceof ClientAccessError && e.message ? e.message : t('clientAccessFailed')); }
    finally { setBusy(false); }
  };

  if (load.kind === 'loading') return <InlineState kind="loading" message={t('clientAccessLoading')} />;
  if (load.kind === 'no-authority') return <Notice variant="info">{t('clientAccessNoAuthority')}</Notice>;
  if (load.kind === 'failed') {
    return (
      <InlineState kind="failed" announce={t('clientAccessLoadFailed')} announcePolite message={t('clientAccessLoadFailed')}
        action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('clientAccessRetry')}</Button>} />
    );
  }

  const now = Date.now();
  const liveHere = (c: OrgCollaborator): ProjectGrant[] =>
    c.grants.filter((g) => g.status === 'active' && Date.parse(g.expiresAt) > now && g.resource.kind === 'project' && g.resource.id === project.id);
  const withAccess = load.people.filter((c) => c.status !== 'revoked' && liveHere(c).length > 0);
  const addable = load.people.filter((c) => c.mode === 'signed-in' && c.status !== 'revoked' && liveHere(c).length === 0);

  const openDialog = (d: 'invite' | 'add'): void => { setError(null); setDone(null); setDialog(d); };

  // A refused invite throws, so the dialog stays open with the server's message.
  // Once the invite exists, its one-time link is shown even if the grant then
  // fails: the person is invited either way, and a retry would only conflict.
  const sendInvite = async (): Promise<void> => {
    const name = invite.displayName.trim();
    const out = await inviteToOrg(orgId, {
      kind: invite.kind, displayName: name, email: invite.email.trim(), ...(invite.company.trim() ? { company: invite.company.trim() } : {}),
    });
    setSentLink({ name, url: projectInviteUrl(out.invite.token), ...(out.invite.expiresAt ? { expiresAt: out.invite.expiresAt } : {}) });
    setInvite({ kind: invite.kind, displayName: '', email: '', company: '' });
    try {
      await grantProject(orgId, out.collaborator.collaboratorId, project.id, actionsFor(access), days, audience || undefined);
      setDone(t('clientAccessInvited', { name }));
    } catch {
      setError(t('clientAccessInvitedNotGranted', { name }));
    }
    await refresh();
  };

  const addExisting = async (): Promise<void> => {
    const c = addable.find((x) => x.collaboratorId === existing);
    if (!c) return;
    await grantProject(orgId, c.collaboratorId, project.id, actionsFor(access), days, audience || undefined);
    setExisting('');
    setDone(t('clientAccessGranted', { name: c.displayName }));
    await refresh();
  };

  const revoke = async (c: OrgCollaborator, g: ProjectGrant): Promise<void> => {
    const ok = await confirm({
      title: t('clientAccessRevokeTitle', { name: c.displayName }),
      body: t('clientAccessRevokeBody'),
      confirmLabel: t('clientAccessRevoke'),
      danger: true,
    });
    if (ok) await run(() => revokeProjectGrant(orgId, c.collaboratorId, g.grantId), t('clientAccessRevoked', { name: c.displayName }));
  };

  const offered = load.audiences ?? [];
  const accessFields = (
    <>
      {offered.length > 0 ? (
        <SelectField label={t('clientAccessAudience')} value={audience} onChange={(e) => setAudience(offered.includes(e.target.value) ? e.target.value : '')} className="u-mb-0">
          <option value="">{t('clientAccessAudienceNone')}</option>
          {offered.map((a) => <option key={a} value={a}>{a}</option>)}
        </SelectField>
      ) : null}
      <SelectField label={t('clientAccessLevel')} value={access} onChange={(e) => setAccess(e.target.value === 'view' ? 'view' : 'comment')} className="u-mb-0">
        <option value="comment">{t('clientAccessLevelComment')}</option>
        <option value="view">{t('clientAccessLevelView')}</option>
      </SelectField>
      <SelectField label={t('clientAccessExpires')} value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="u-mb-0">
        {EXPIRY_CHOICES.map((d) => <option key={d} value={d}>{t('clientAccessDays', { count: d })}</option>)}
      </SelectField>
    </>
  );

  return (
    <section className="surface-card u-grid u-gap-3" aria-labelledby="project-client-access" data-testid="project-client-access">
      <div>
        <h3 id="project-client-access" className="u-mt-0 u-mb-1 u-fs-15">{t('clientAccessHeading')}</h3>
        <p className="muted u-fs-13 u-m-0">{t('clientAccessIntro')}</p>
      </div>
      <div className="action-bar">
        <Button size="sm" onClick={() => openDialog('invite')}>{t('clientAccessInviteHeading')}</Button>
        {addable.length > 0 ? <Button size="sm" variant="secondary" onClick={() => openDialog('add')}>{t('clientAccessAddHeading')}</Button> : null}
      </div>
      {load.audiences === null ? <Notice variant="warning" announce={t('clientAccessAudienceUnavailable')}>{t('clientAccessAudienceUnavailable')}</Notice> : null}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {done ? <Notice variant="success" announce={done}>{done}</Notice> : null}

      {sentLink ? (
        <div className="u-grid u-gap-2">
          <p className="u-m-0 u-fs-13">{t('clientAccessLinkOnce', { name: sentLink.name })}{sentLink.expiresAt ? ` ${t('clientAccessLinkExpires', { date: formatDate(sentLink.expiresAt) })}` : ''}</p>
          <div className="u-flex u-flex-wrap u-items-end u-gap-2">
            <TextField label={t('clientAccessLinkLabel', { name: sentLink.name })} value={sentLink.url} readOnly onFocus={(e) => e.currentTarget.select()} className="u-minw-240 u-mb-0" />
            <Button size="sm" variant="secondary" onClick={() => void copyToClipboard(sentLink.url, t('clientAccessLinkCopied'))}>{t('clientAccessLinkCopy')}</Button>
            <Button size="sm" variant="link" onClick={() => setSentLink(null)}>{t('clientAccessLinkDone')}</Button>
          </div>
        </div>
      ) : null}

      {withAccess.length === 0 ? <p className="muted u-m-0">{t('clientAccessEmpty')}</p> : (
        <ul className="u-list-plain u-grid u-gap-3 u-m-0" aria-label={t('clientAccessListLabel')}>
          {withAccess.map((c) => (
            <li key={c.collaboratorId} className="u-grid u-gap-1">
              <span className="u-flex u-flex-wrap u-items-center u-gap-2">
                <span className="u-fw-600">{c.displayName}</span>
                {c.company ? <span className="muted u-fs-13">{c.company}</span> : null}
                <span className="muted u-fs-13">{c.email}</span>
                {c.accepted ? null : <span className="chip chip--accent">{t('clientAccessPending')}</span>}
              </span>
              {liveHere(c).map((g) => (
                <span key={g.grantId} className="u-flex u-flex-wrap u-items-center u-gap-2 u-fs-13">
                  <span className="muted">{g.actions.includes('comment') ? t('clientAccessLevelComment') : t('clientAccessLevelView')}</span>
                  {g.audience ? <span className="chip">{t('clientAccessAudienceChip', { audience: g.audience })}</span> : null}
                  <span className="muted">{t('clientAccessUntil', { date: formatDate(g.expiresAt) })}</span>
                  <Button size="sm" variant="link" disabled={busy} onClick={() => void revoke(c, g)} aria-label={t('clientAccessRevokeAria', { name: c.displayName })}>{t('clientAccessRevoke')}</Button>
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}

      {dialog === 'invite' ? (
        <CreateDialog
          title={t('clientAccessInviteHeading')}
          submitLabel={t('clientAccessInvite')}
          canSubmit={!!invite.displayName.trim() && !!invite.email.trim()}
          onSubmit={sendInvite}
          onClose={() => setDialog(null)}
          errorFallback={t('clientAccessFailed')}
        >
          <SelectField label={t('clientAccessKind')} value={invite.kind} onChange={(e) => setInvite({ ...invite, kind: e.target.value === 'vendor' ? 'vendor' : 'client-stakeholder' })} className="u-mb-0">
            <option value="client-stakeholder">{t('clientAccessKindClient')}</option>
            <option value="vendor">{t('clientAccessKindFirm')}</option>
          </SelectField>
          <TextField label={t('clientAccessName')} value={invite.displayName} onChange={(e) => setInvite({ ...invite, displayName: e.target.value })} required maxLength={120} className="u-mb-0" />
          <TextField label={t('clientAccessEmail')} type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} required maxLength={254} className="u-mb-0" />
          <TextField label={t('clientAccessCompany')} value={invite.company} onChange={(e) => setInvite({ ...invite, company: e.target.value })} maxLength={120} className="u-mb-0" />
          {accessFields}
          <p className="muted u-fs-13 u-m-0">{t('clientAccessInviteHelp')}</p>
        </CreateDialog>
      ) : null}

      {dialog === 'add' ? (
        <CreateDialog
          title={t('clientAccessAddHeading')}
          submitLabel={t('clientAccessGrant')}
          canSubmit={!!existing}
          onSubmit={addExisting}
          onClose={() => setDialog(null)}
          errorFallback={t('clientAccessFailed')}
        >
          <SelectField label={t('clientAccessPerson')} value={existing} onChange={(e) => setExisting(e.target.value)} className="u-mb-0">
            <option value="">{t('clientAccessPersonPick')}</option>
            {addable.map((c) => <option key={c.collaboratorId} value={c.collaboratorId}>{c.company ? `${c.displayName} (${c.company})` : c.displayName}</option>)}
          </SelectField>
          {accessFields}
        </CreateDialog>
      ) : null}
    </section>
  );
}
