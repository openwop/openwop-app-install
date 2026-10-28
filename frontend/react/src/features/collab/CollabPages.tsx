/**
 * ADR 0958 P2 — the collaborator's pages. A vendor, freelancer or client reviewer
 * signs in to THEIR OWN account; these pages show only what an agency granted
 * them, read through the server's one per-use check. No chat, no agency nav.
 *
 *  - `CollabHomePage` — "Shared with me": every grant usable now, across agencies.
 *  - `CollabGrantPage` — one granted resource (an approved brief, a campaign).
 *  - `CollabAcceptPage` — accept an invite while signed in; the server binds it
 *    only to the account that holds the invited, verified email.
 *  - ADR 0958 P3 — on a campaign grant that allows `upload`, `IntakeSection`
 *    sends files with their rights. They wait for the agency's review; the
 *    collaborator sees the outcome and the reason, never a link to the files.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { Button } from '../../ui/Button.js';
import { Markdown } from '../../ui/Markdown.js';
import { CheckboxField, SelectField, TextareaField, TextField } from '../../ui/Field.js';
import { InlineState } from '../../ui/InlineState.js';
import { confirm } from '../../ui/confirm.js';
import { formatBytes, formatDate } from '../../i18n/format.js';
import {
  acceptInvite, CollabError, getGrant, INTAKE_ACCEPT, INTAKE_LICENSES, INTAKE_MAX_BYTES, INTAKE_MAX_FILES, listIntakes, listShared, readInvite,
  sendIntake, withdrawIntake, type GrantView, type IntakeLicense, type IntakeView, type InviteView, type SharedItem,
} from './collabClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];
const kindKey = (kind: string): string => (kind === 'creative-brief' ? 'kindCreativeBrief' : kind === 'campaign' ? 'kindCampaign' : 'kindOther');

export function CollabHomePage(): JSX.Element {
  const { t } = useTranslation('collab');
  const [items, setItems] = useState<SharedItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false); setItems(null);
    void listShared().then(setItems).catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="u-grid u-gap-4">
      <PageHeader title={t('homeTitle')} lede={t('homeLede')} />
      {failed ? <StateCard announce title={t('loadFailedTitle')} body={t('loadFailedBody')} action={<Button onClick={load}>{t('retry')}</Button>} /> : null}
      {!failed && items === null ? <StateCard loading title={t('loading')} /> : null}
      {items && items.length === 0 ? <StateCard title={t('emptyTitle')} body={t('emptyBody')} /> : null}
      {items && items.length > 0 ? (
        <ul className="u-list-plain u-grid u-gap-3">
          {items.map((i) => (
            <li key={i.grantId}>
              <Link to={`/collab/${encodeURIComponent(i.grantId)}`} className="surface-card u-grid u-gap-1">
                <span className="u-text-muted u-fs-13">{i.clientName ? t('fromClient', { client: i.clientName }) : t('fromAgency')}</span>
                <strong>{i.title}</strong>
                <span className="u-flex u-flex-wrap u-gap-2 u-items-center">
                  <span className="chip chip--muted">{t(kindKey(i.resourceKind))}</span>
                  <span className="u-text-muted u-fs-13">{t('accessUntil', { date: formatDate(i.expiresAt) })}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ResourceBody({ view, t }: { view: GrantView; t: TFn }): JSX.Element {
  const r = view.resource;
  if (r.kind === 'creative_brief' && typeof r.markdown === 'string') return <Markdown>{r.markdown}</Markdown>;
  if (r.kind === 'campaign') {
    const channels = Array.isArray(r.channels) ? r.channels.filter((c): c is string => typeof c === 'string') : [];
    return (
      <dl className="u-grid u-gap-2 u-m-0">
        <dt className="u-text-muted u-fs-13">{t('objective')}</dt>
        <dd className="u-m-0">{typeof r.objective === 'string' && r.objective ? r.objective : t('none')}</dd>
        <dt className="u-text-muted u-fs-13">{t('channels')}</dt>
        <dd className="u-m-0 u-flex u-flex-wrap u-gap-2">
          {channels.length ? channels.map((c) => <span key={c} className="chip chip--muted">{c}</span>) : t('none')}
        </dd>
      </dl>
    );
  }
  return <p className="u-text-muted u-m-0">{t('unsupported')}</p>;
}

export function CollabGrantPage(): JSX.Element {
  const { t } = useTranslation('collab');
  const { grantId = '' } = useParams();
  const [view, setView] = useState<GrantView | null>(null);
  const [state, setState] = useState<'loading' | 'gone' | 'failed' | 'ok'>('loading');
  const load = useCallback(() => {
    setState('loading');
    void getGrant(grantId)
      .then((v) => { setView(v); setState('ok'); })
      .catch((e: unknown) => setState(e instanceof CollabError && e.status === 404 ? 'gone' : 'failed'));
  }, [grantId]);
  useEffect(load, [load]);

  const back = <Link to="/collab" className="btn btn-ghost btn-sm">{t('backToShared')}</Link>;
  if (state === 'loading') return <StateCard loading title={t('loading')} />;
  if (state === 'gone') return <StateCard title={t('goneTitle')} body={t('goneBody')} action={back} />;
  if (state === 'failed' || !view) return <StateCard announce title={t('loadFailedTitle')} body={t('loadFailedBody')} action={<Button onClick={load}>{t('retry')}</Button>} />;
  return (
    <div className="u-grid u-gap-4">
      <div>{back}</div>
      <PageHeader eyebrow={view.clientName ?? t('fromAgency')} title={view.title} lede={t('accessUntil', { date: formatDate(view.grant.expiresAt) })} />
      <section className="surface-card u-grid u-gap-3" aria-label={view.title}>
        <ResourceBody view={view} t={t} />
      </section>
      {view.grant.resourceKind === 'campaign' && view.grant.actions.includes('upload') ? <IntakeSection grantId={view.grant.grantId} /> : null}
    </div>
  );
}

const STATUS_CHIP: Record<IntakeView['status'], string> = {
  submitted: 'chip chip--warning', accepted: 'chip chip--success', rejected: 'chip chip--danger', withdrawn: 'chip chip--muted',
};

function errorText(e: unknown, t: TFn): string {
  if (e instanceof CollabError && e.status === 404) return t('intakeGone');
  if (e instanceof CollabError && e.message) return e.message;
  return t('intakeSendFailed');
}

/** ADR 0958 P3 — send files to the agency, with their rights, and see what happened to them. */
function IntakeSection({ grantId }: { grantId: string }): JSX.Element {
  const { t } = useTranslation('collab');
  const [items, setItems] = useState<IntakeView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [license, setLicense] = useState<IntakeLicense>('work-for-hire');
  const [termEndsAt, setTermEndsAt] = useState('');
  const [credit, setCredit] = useState('');
  const [modelReleases, setModelReleases] = useState<'' | 'yes' | 'no'>('');
  const [attest, setAttest] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setFailed(false);
    void listIntakes(grantId).then(setItems).catch(() => setFailed(true));
  }, [grantId]);
  useEffect(load, [load]);

  const total = files.reduce((n, f) => n + f.size, 0);
  const pick = (list: FileList | null): void => {
    setError(null); setDone(null);
    const next = list ? Array.from(list) : [];
    if (next.length > INTAKE_MAX_FILES) { setError(t('intakeTooMany', { max: INTAKE_MAX_FILES })); return; }
    if (next.reduce((n, f) => n + f.size, 0) > INTAKE_MAX_BYTES) { setError(t('intakeTooBig', { size: formatBytes(INTAKE_MAX_BYTES) })); return; }
    setFiles(next);
  };

  const send = async (): Promise<void> => {
    setError(null); setDone(null);
    if (files.length === 0) { setError(t('intakeNoFiles')); return; }
    if (license === 'licensed-term' && !termEndsAt) { setError(t('intakeTermRequired')); return; }
    if (!modelReleases) { setError(t('intakeReleasesRequired')); return; }
    if (!attest) { setError(t('intakeAttestRequired')); return; }
    setBusy(true);
    try {
      await sendIntake(grantId, files, {
        license, modelReleases: modelReleases === 'yes', attest: true,
        ...(license === 'licensed-term' ? { termEndsAt } : {}), ...(credit.trim() ? { credit: credit.trim() } : {}),
      }, note.trim() || undefined);
      setFiles([]); setAttest(false); setNote('');
      if (picker.current) picker.current.value = '';
      setDone(t('intakeSent'));
      load();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (i: IntakeView): Promise<void> => {
    const ok = await confirm({ title: t('intakeWithdrawTitle'), body: t('intakeWithdrawBody'), confirmLabel: t('intakeWithdraw'), danger: true });
    if (!ok) return;
    setError(null); setDone(null);
    try { await withdrawIntake(grantId, i.intakeId); setDone(t('intakeWithdrawn')); load(); }
    catch (e) { setError(errorText(e, t)); }
  };

  return (
    <section className="surface-card u-grid u-gap-3" aria-labelledby="collab-intake-title">
      <h2 id="collab-intake-title" className="u-m-0 u-fs-16">{t('intakeTitle')}</h2>
      <p className="u-text-muted u-m-0 u-fs-13">{t('intakeLede')}</p>
      <label className="field">
        <span className="field-label">{t('intakeFiles')}</span>
        <input ref={picker} type="file" multiple accept={INTAKE_ACCEPT} disabled={busy} onChange={(e) => pick(e.target.files)} />
        <span className="field-help">{files.length ? t('intakePicked', { count: files.length, size: formatBytes(total) }) : t('intakeFilesHelp', { max: INTAKE_MAX_FILES, size: formatBytes(INTAKE_MAX_BYTES) })}</span>
      </label>
      <SelectField label={t('intakeLicense')} value={license} onChange={(e) => setLicense(e.target.value as IntakeLicense)} disabled={busy}>
        {INTAKE_LICENSES.map((l) => <option key={l} value={l}>{t(`intakeLicense_${l.replace(/-/g, '_')}`)}</option>)}
      </SelectField>
      {license === 'licensed-term' ? (
        <TextField type="date" label={t('intakeTermEndsAt')} value={termEndsAt} onChange={(e) => setTermEndsAt(e.target.value)} disabled={busy} required />
      ) : null}
      <SelectField label={t('intakeReleases')} value={modelReleases} onChange={(e) => setModelReleases(e.target.value as '' | 'yes' | 'no')} disabled={busy} required>
        <option value="">{t('intakeReleasesChoose')}</option>
        <option value="yes">{t('intakeReleasesYes')}</option>
        <option value="no">{t('intakeReleasesNo')}</option>
      </SelectField>
      <TextField label={t('intakeCredit')} help={t('intakeCreditHelp')} value={credit} maxLength={200} onChange={(e) => setCredit(e.target.value)} disabled={busy} />
      <TextareaField label={t('intakeNote')} value={note} maxLength={1000} rows={2} onChange={(e) => setNote(e.target.value)} disabled={busy} />
      <CheckboxField label={t('intakeAttest')} checked={attest} onChange={(e) => setAttest(e.target.checked)} disabled={busy} required />
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {done ? <Notice variant="success" announce={done}>{done}</Notice> : null}
      <div className="action-bar">
        <Button variant="primary" loading={busy} onClick={() => void send()}>{t('intakeSend')}</Button>
      </div>

      <h3 className="u-m-0 u-fs-15">{t('intakeHistory')}</h3>
      {failed ? <InlineState kind="failed" message={t('intakeLoadFailed')} action={<Button variant="secondary" size="sm" onClick={load}>{t('retry')}</Button>} /> : null}
      {!failed && items === null ? <InlineState kind="loading" message={t('loading')} /> : null}
      {items && items.length === 0 ? <p className="u-text-muted u-m-0">{t('intakeHistoryEmpty')}</p> : null}
      {items && items.length > 0 ? (
        <ul className="u-list-plain u-grid u-gap-2">
          {items.map((i) => (
            <li key={i.intakeId} className="u-grid u-gap-1">
              <span className="u-flex u-flex-wrap u-gap-2 u-items-center">
                <span className={STATUS_CHIP[i.status]}>{t(`intakeStatus_${i.status}`)}</span>
                <span className="u-text-muted u-fs-13">{t('intakeSentOn', { date: formatDate(i.submittedAt) })}</span>
              </span>
              <span className="u-fs-13">{i.files.map((f) => f.name).join(', ')}</span>
              {i.reason ? <span className="u-fs-13">{t('intakeReason', { reason: i.reason })}</span> : null}
              {i.status === 'submitted' ? (
                <span><Button variant="link" onClick={() => void withdraw(i)}>{t('intakeWithdraw')}</Button></span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function CollabAcceptPage(): JSX.Element {
  const { t } = useTranslation('collab');
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<InviteView | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readInvite(token).then((v) => { if (!cancelled) setInvite(v); }).catch(() => { if (!cancelled) setInvalid(true); });
    return () => { cancelled = true; };
  }, [token]);

  const accept = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await acceptInvite(token);
      navigate('/collab', { replace: true });
    } catch (e) {
      if (e instanceof CollabError && e.status === 404) { setInvalid(true); return; }
      setError(e instanceof CollabError && e.reason === 'invite_email_mismatch' ? t('emailMismatch') : t('acceptFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (invalid) return <StateCard title={t('inviteInvalidTitle')} body={t('inviteInvalidBody')} />;
  if (!invite) return <StateCard loading title={t('loading')} />;
  return (
    <div className="u-grid u-gap-4">
      <PageHeader title={t('acceptTitle')} lede={invite.clientName ? t('acceptLedeClient', { client: invite.clientName, name: invite.displayName }) : t('acceptLede', { name: invite.displayName })} />
      <section className="surface-card u-grid u-gap-3">
        <p className="u-m-0">{t('acceptExplain')}</p>
        {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
        <div className="action-bar">
          <Button variant="primary" loading={busy} onClick={() => void accept()}>{t('acceptAction')}</Button>
        </div>
      </section>
    </div>
  );
}
