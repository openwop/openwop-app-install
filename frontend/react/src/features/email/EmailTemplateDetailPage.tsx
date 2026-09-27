/**
 * Email template detail — `/email/templates/:templateId` (ADR 0520).
 *
 * The template editor (name, subject, body format, body + the server-authoritative
 * markdown preview), Save, and Delete. It used to render INSIDE the templates
 * list card on `/email`, with the open template held in component state and
 * mirrored to `?template=`; see ADR 0520 for why that mirror was the wrong lane.
 *
 * `/email` remains a hub (provider status · sender identity · templates ·
 * campaigns) — this ADR moves the templates lane to the canon, it does not
 * dissolve the hub.
 *
 * The page loads its OWN template by id rather than reading a list the hub
 * happened to fetch: it is reachable by bookmark, shared link, or reload with no
 * list in memory. `?org=` rides in from the cell; absent it the first workspace
 * is used, and a template that is not in the resolved workspace renders the
 * designed not-found state instead of an empty editor bound to a dead id.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { confirm } from '../../ui/confirm.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Button } from '../../ui/Button.js';
import { toast } from '../../ui/toast.js';
import { useUnsavedChangesWarning } from '../../ui/useUnsavedChangesWarning.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { GlobeIcon, LockIcon, SaveIcon, SendIcon, TrashIcon } from '../../ui/icons/index.js';
import {
  deleteTemplate, getTemplate, listOrgs, updateTemplate,
  type EmailBodyFormat, type EmailTemplate,
} from './emailClient.js';
import { EmailBodyPreview } from './EmailBodyPreview.js';

export function EmailTemplateDetailPage(): JSX.Element {
  const { t } = useTranslation('email');
  const { templateId = '' } = useParams<{ templateId: string }>();
  const navigate = useNavigate();
  const access = useFeatureAccess('email');

  const [searchParams] = useSearchParams();
  const [orgId, setOrgId] = useState(searchParams.get('org') ?? '');
  const [orgsFailed, setOrgsFailed] = useState(false);
  /** CCDATA-1 — when the link carried no `?org=` we GUESSED the first workspace.
   *  A not-found then has two very different meanings (deleted vs. looked in the
   *  wrong place), and only this flag can tell them apart, so the copy below
   *  names the workspace actually checked instead of hedging. */
  const [guessedOrgName, setGuessedOrgName] = useState('');

  const [draft, setDraft] = useState<EmailTemplate | null>(null);
  const [dirty, setDirty] = useState(false);
  /** The read resolved and found nothing — a deleted template or a stale link.
   *  Distinct from `null` (still loading), which must not render "not found". */
  const [notFound, setNotFound] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Every edit goes through this, so `dirty` cannot drift from the edits it
  // guards — a per-control `setDirty(true)` would be one missed call away from
  // silently dropping the unsaved-changes warning.
  const edit = useCallback((patch: Partial<EmailTemplate>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  }, []);
  useUnsavedChangesWarning(dirty);

  // Resolve the workspace only when the link didn't name one.
  useEffect(() => {
    if (!access.enabled || orgId) return;
    void listOrgs()
      .then((o) => { setOrgId(o[0]?.orgId ?? ''); setGuessedOrgName(o[0]?.name ?? ''); setOrgsFailed(false); })
      .catch(() => setOrgsFailed(true));
  }, [access.enabled, orgId]);

  useEffect(() => {
    if (!orgId || !templateId) return undefined;
    setDraft(null); setNotFound(false); setLoadFailed(false);
    let live = true; // ignore a stale resolution if the org/template changed mid-flight
    void getTemplate(orgId, templateId)
      .then((tpl) => { if (live) { setDraft(tpl); setDirty(false); } })
      .catch((e) => {
        if (!live) return;
        // A 404 IS the answer ("no such template here"), not a failure to read.
        if (e instanceof Error && /\b404\b/.test(e.message)) setNotFound(true);
        else { setError(e instanceof Error ? e.message : t('loadFailed')); setLoadFailed(true); }
      });
    return () => { live = false; };
  }, [orgId, templateId, t]);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const saved = await updateTemplate(orgId, draft.templateId, {
        name: draft.name, subject: draft.subject, body: draft.body, format: draft.format ?? 'text',
      });
      setDraft(saved); setDirty(false);
      toast.success(t('templateSaved'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  }, [draft, orgId, t]);

  const remove = useCallback(async () => {
    if (!draft) return;
    if (!(await confirm({ title: t('deleteTemplateConfirm'), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteTemplate(orgId, draft.templateId);
      setDirty(false); // the entity is gone; its unsaved edits are moot
      navigate(`/email?org=${encodeURIComponent(orgId)}`);
    } catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [draft, orgId, navigate, t]);

  const backLink = <Link to={orgId ? `/email?org=${encodeURIComponent(orgId)}` : '/email'} className="btn-ghost">{t('backToEmail')}</Link>;

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  // Ordered failure-first: a failed-read branch below a loading branch never runs.
  if (orgsFailed) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('loadFailedTitle')} actions={backLink} />
        <StateCard announce icon={<GlobeIcon size={20} />} title={t('loadFailedTitle')} body={t('loadFailedBody')} />
      </div>
    );
  }
  if (notFound) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('templateNotFoundTitle')} actions={backLink} />
        {/* A way out at the point of failure — the workspace picker that can
            fix a wrong-workspace link lives back on the hub. */}
        <StateCard announce icon={<SendIcon size={20} />} title={t('templateNotFoundTitle')} body={guessedOrgName ? t('templateNotFoundGuessedBody', { workspace: guessedOrgName }) : t('templateNotFoundBody')}
          action={<Link to={orgId ? `/email?org=${encodeURIComponent(orgId)}` : '/email'} className="btn-accent-solid">{t('backToEmail')}</Link>} />
      </div>
    );
  }
  if (loadFailed) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('templateLoadFailedTitle')} actions={backLink} />
        {error ? <Notice variant="error">{error}</Notice> : null}
        <StateCard announce icon={<SendIcon size={20} />} title={t('templateLoadFailedTitle')} body={t('templateLoadFailedBody')} />
      </div>
    );
  }
  if (!draft) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('loadingTemplate')} actions={backLink} />
        <StateCard icon={<SendIcon size={20} />} title={t('loadingTemplate')} loading />
      </div>
    );
  }

  return (
    <div className="u-gap-3 u-flex u-flex-col" data-walkthrough="email.template">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={draft.name}
        lede={t('templateDetailLede')}
        actions={
          <>
            {backLink}
            <Button variant="danger" onClick={() => void remove()}><TrashIcon size={14} /> {t('common:delete')}</Button>
            {/* §4.5 rule 4 — THE action on this page. */}
            <Button variant="accent-solid" disabled={busy} onClick={() => void save()}><SaveIcon size={14} /> {t('common:save')}</Button>
          </>
        }
      />

      <div className="surface-card u-gap-2">
        <div className="u-flex u-gap-2 u-items-center u-wrap">
          <h2 className="u-fs-16 u-m-0 u-flex-1">{t('editorHeading')}</h2>
          {dirty ? <span className="chip chip--warning">{t('unsavedChanges')}</span> : null}
        </div>

        <label className="u-label-sm">{t('editorNameLabel')}
          <input value={draft.name} onChange={(e) => edit({ name: e.target.value })} />
        </label>
        <label className="u-label-sm">{t('editorSubjectLabel')}
          <input value={draft.subject} onChange={(e) => edit({ subject: e.target.value })} />
        </label>
        <label className="u-label-sm">{t('editorFormatLabel')}
          <select value={draft.format ?? 'text'} onChange={(e) => edit({ format: e.target.value as EmailBodyFormat })}>
            <option value="text">{t('formatPlain')}</option>
            <option value="markdown">{t('formatMarkdown')}</option>
          </select>
        </label>
        <label className="u-label-sm">{t('editorBodyLabel')}
          <textarea value={draft.body} rows={12} onChange={(e) => edit({ body: e.target.value })} />
        </label>
        {/* ADR 0256 — the preview is rendered by the SAME server-side renderer
            that builds the sent HTML part, so what is shown is what sends. */}
        {draft.format === 'markdown' ? (
          <>
            <p className="muted u-fs-13 u-m-0">{t('markdownHint')}</p>
            <EmailBodyPreview orgId={orgId} body={draft.body} />
          </>
        ) : null}
      </div>
    </div>
  );
}
