/**
 * Forms (host-extension product feature — ADR 0017).
 *
 * Gates on useFeatureAccess('forms'). An org picker → a forms list (+ "New
 * form") → a builder for the selected form (title, fields, "create CRM contact",
 * submit message) → publish/unpublish + the copyable PUBLIC /public-forms/:formId
 * URL → the captured submissions (a submission with a contactId became a CRM lead).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n/index.js';
import { formatDate } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ClipboardIcon, GlobeIcon, InboxIcon, LockIcon, PlusIcon, SaveIcon, SendIcon, TrashIcon } from '../../ui/icons/index.js';
import {
  createForm, deleteForm, listForms, listOrgs, listSubmissions, publicFormUrl,
  setFormStatus, updateForm, FIELD_TYPES,
  type FieldType, type FormDef, type FormField, type Org, type Submission,
} from './formsClient.js';

/** A draft field carries a client-only stable `_rid` for React keys (the field
 *  `key` is user-editable and may be empty/duplicate), stripped before the API. */
type DraftField = FormField & { _rid: string };
interface Draft { title: string; fields: DraftField[]; createToContact: boolean; submitMessage: string }

let _ridSeq = 0;
const nextRid = (): string => `f${_ridSeq++}`;

const STARTER: FormField[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
];

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);

function copy(text: string): void {
  void navigator.clipboard?.writeText(text).then(() => toast.success(i18n.t('forms:publicUrlCopied'))).catch(() => { /* clipboard blocked */ });
}

// Human-readable labels for the machine submission-error codes (§2 copy).
const ERR_LABEL_KEY: Record<string, string> = { no_contact_fields: 'forms:errNoContactFields', contact_create_failed: 'forms:errContactCreateFailed' };
// Semantic status chip per DESIGN.md §5.1 (.chip--{success,muted}) — color is
// never the sole signal (the text label rides along).
const statusChip = (s: FormDef['status']): string => (s === 'published' ? 'chip chip--success' : 'chip chip--muted');

export function FormsPage(): JSX.Element {
  const { t } = useTranslation('forms');
  const access = useFeatureAccess('forms');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [forms, setForms] = useState<FormDef[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = (forms ?? []).find((f) => f.formId === selectedId) ?? null;

  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [access.enabled]);

  const loadForms = useCallback((org: string) => {
    void listForms(org).then(setForms).catch((e) => setError(e instanceof Error ? e.message : t('loadFormsFailed')));
  }, [t]);

  useEffect(() => { if (orgId) { setForms(null); setSelectedId(''); setDraft(null); setSubs(null); loadForms(orgId); } }, [orgId, loadForms]);

  // Select a form → populate the editable draft + load its submissions (explicit,
  // so a background forms-reload never clobbers in-progress edits).
  const selectForm = useCallback((f: FormDef) => {
    setSelectedId(f.formId);
    setDraft({ title: f.title, fields: f.fields.map((x) => ({ ...x, _rid: nextRid() })), createToContact: f.createToContact, submitMessage: f.submitMessage ?? '' });
    setSubs(null);
    void listSubmissions(orgId, f.formId).then(setSubs).catch(() => setSubs([]));
  }, [orgId]);

  const createNew = useCallback(async () => {
    if (!orgId || !newTitle.trim()) return;
    setBusy(true);
    try {
      const form = await createForm(orgId, { title: newTitle.trim(), fields: STARTER, createToContact: true });
      setNewTitle('');
      loadForms(orgId);
      selectForm(form);
      toast.success(t('formCreated'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('createFailed')); }
    finally { setBusy(false); }
  }, [orgId, newTitle, loadForms, selectForm, t]);

  const save = useCallback(async () => {
    if (!selected || !draft) return;
    setBusy(true);
    try {
      const fields = draft.fields
        .map(({ _rid, ...f }) => ({ ...f, key: (f.key.trim() || slug(f.label)) }))
        .filter((f) => f.key && f.label.trim());
      const sm = draft.submitMessage.trim();
      await updateForm(orgId, selected.formId, { title: draft.title.trim() || t('untitledForm'), fields, createToContact: draft.createToContact, submitMessage: sm });
      loadForms(orgId);
      toast.success(t('saved'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  }, [selected, draft, orgId, loadForms, t]);

  const togglePublish = useCallback(async () => {
    if (!selected) return;
    try {
      await setFormStatus(orgId, selected.formId, selected.status === 'published' ? 'draft' : 'published');
      loadForms(orgId);
    } catch (e) { toast.error(e instanceof Error ? e.message : t('publishFailed')); }
  }, [selected, orgId, loadForms, t]);

  const remove = useCallback(async (formId: string) => {
    try { await deleteForm(orgId, formId); if (selectedId === formId) setSelectedId(''); loadForms(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, selectedId, loadForms, t]);

  const patchField = (i: number, patch: Partial<FormField>): void => {
    setDraft((d) => d ? { ...d, fields: d.fields.map((f, j) => j === i ? { ...f, ...patch } : f) } : d);
  };

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div className="u-gap-3 u-flex u-flex-col">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<GlobeIcon />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <>
          {/* Forms list + new form */}
          {/* New-form add toolbar (§5.1 .surface-form) */}
          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('newFormLabel')}</span>
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={t('newFormPlaceholder')} />
            </label>
            <button type="button" className="btn-primary" disabled={busy || !newTitle.trim()} onClick={() => void createNew()}><PlusIcon /> {t('newFormButton')}</button>
          </div>

          <div className="surface-card u-gap-2">
            <h2 className="u-fs-16 u-m-0">{t('formsHeading')}</h2>
            {!forms ? <Skeleton /> : forms.length === 0 ? <span className="u-label-sm">{t('noFormsYet')}</span> : forms.map((f) => (
              <div key={f.formId} className="u-flex u-gap-1 u-items-center">
                <button type="button" className={`${selectedId === f.formId ? 'btn-accent' : 'btn-ghost'} u-justify-start u-flex-1`} aria-current={selectedId === f.formId ? 'true' : undefined} onClick={() => selectForm(f)}>{f.title}</button>
                <span className={statusChip(f.status)}>{f.status}</span>
                <button type="button" className="btn-ghost" title={t('deleteForm')} aria-label={t('deleteForm')} onClick={() => void remove(f.formId)}><TrashIcon /></button>
              </div>
            ))}
          </div>

          {/* Builder for the selected form */}
          {selected && draft ? (
            <div className="surface-card u-gap-2">
              <div className="u-flex u-gap-2 u-items-center u-wrap">
                <h2 className="u-fs-16 u-m-0 u-flex-1">{t('editForm')}</h2>
                <span className={statusChip(selected.status)}>{selected.status}</span>
                <div className="action-bar">
                  <button type="button" className="btn-ghost" onClick={() => void togglePublish()}>
                    <SendIcon /> {selected.status === 'published' ? t('unpublish') : t('publish')}
                  </button>
                  <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}><SaveIcon /> {t('common:save')}</button>
                </div>
              </div>

              <label className="u-label-sm">{t('titleLabel')}
                <input value={draft.title} onChange={(e) => setDraft((d) => d ? { ...d, title: e.target.value } : d)} />
              </label>

              <h3 className="u-fs-14 u-m-0">{t('fieldsHeading')}</h3>
              {draft.fields.map((f, i) => (
                <div key={f._rid} className="surface-inset u-flex u-gap-1 u-items-center u-wrap">
                  <input value={f.label} onChange={(e) => patchField(i, { label: e.target.value })} placeholder={t('fieldLabelPlaceholder')} aria-label={t('fieldLabelAria')} className="u-flex-1" />
                  <input value={f.key} onChange={(e) => patchField(i, { key: e.target.value })} placeholder={t('fieldKeyPlaceholder')} aria-label={t('fieldKeyAria')} className="u-w-auto" />
                  <select value={f.type} onChange={(e) => patchField(i, { type: e.target.value as FieldType })} aria-label={t('fieldTypeAria')} className="u-w-auto">
                    {FIELD_TYPES.map((ft) => <option key={ft} value={ft}>{ft}</option>)}
                  </select>
                  <label className="u-label-sm u-flex u-gap-1 u-items-center"><input type="checkbox" checked={f.required} onChange={(e) => patchField(i, { required: e.target.checked })} /> {t('fieldRequired')}</label>
                  <button type="button" className="btn-ghost" title={t('removeField')} aria-label={t('removeField')} onClick={() => setDraft((d) => d ? { ...d, fields: d.fields.filter((_, j) => j !== i) } : d)}><TrashIcon /></button>
                </div>
              ))}
              <div className="u-flex u-justify-start">
                <button type="button" className="btn-ghost" onClick={() => setDraft((d) => d ? { ...d, fields: [...d.fields, { key: '', label: '', type: 'text', required: false, _rid: nextRid() }] } : d)}><PlusIcon /> {t('addField')}</button>
              </div>

              <label className="u-label-sm u-flex u-gap-1 u-items-center">
                <input type="checkbox" checked={draft.createToContact} onChange={(e) => setDraft((d) => d ? { ...d, createToContact: e.target.checked } : d)} />
                {t('createToContact')}
              </label>
              <label className="u-label-sm">{t('submitMessageLabel')}
                <input value={draft.submitMessage} onChange={(e) => setDraft((d) => d ? { ...d, submitMessage: e.target.value } : d)} placeholder={t('submitMessagePlaceholder')} />
              </label>

              {selected.status === 'published' ? (
                <div className="surface-inset u-gap-1 u-flex u-flex-col">
                  <span className="u-label-sm"><GlobeIcon /> {t('publicUrlLabel')}</span>
                  <div className="u-flex u-gap-1 u-items-center">
                    <code className="u-flex-1">{publicFormUrl(selected.formId)}</code>
                    <button type="button" className="btn-ghost" title={t('copyPublicUrl')} aria-label={t('copyPublicUrl')} onClick={() => copy(publicFormUrl(selected.formId))}><ClipboardIcon /></button>
                  </div>
                </div>
              ) : <span className="u-label-sm">{t('publishToGetUrl')}</span>}
            </div>
          ) : null}

          {/* Submissions for the selected form */}
          {selected ? (
            <div className="surface-card u-gap-2">
              <h2 className="u-fs-16 u-m-0 u-flex u-gap-1 u-items-center"><InboxIcon /> {t('submissionsHeading')}</h2>
              {!subs ? <Skeleton /> : subs.length === 0 ? <span className="u-label-sm">{t('noSubmissionsYet')}</span> : subs.map((s) => (
                <div key={s.submissionId} className="surface-inset u-flex u-gap-2 u-items-center u-wrap">
                  <span className="u-flex-1">{Object.entries(s.values).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</span>
                  {s.contactId ? <span className="chip chip--success">{t('submissionContact')}</span> : s.error ? <span className="chip chip--danger">{t(ERR_LABEL_KEY[s.error] ?? 'forms:submissionError')}</span> : null}
                  <span className="u-label-sm" title={s.createdAt}>{formatDate(s.createdAt)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
