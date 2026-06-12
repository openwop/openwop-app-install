/**
 * Forms (host-extension product feature — ADR 0017).
 *
 * Gates on useFeatureAccess('forms'). An org picker → a forms list (+ "New
 * form") → a builder for the selected form (title, fields, "create CRM contact",
 * submit message) → publish/unpublish + the copyable PUBLIC /public-forms/:formId
 * URL → the captured submissions (a submission with a contactId became a CRM lead).
 */
import { useCallback, useEffect, useState } from 'react';
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
  void navigator.clipboard?.writeText(text).then(() => toast.success('Public URL copied')).catch(() => { /* clipboard blocked */ });
}

// Human-readable labels for the machine submission-error codes (§2 copy).
const ERR_LABEL: Record<string, string> = { no_contact_fields: 'no contact fields', contact_create_failed: 'contact failed' };
// Semantic status chip per DESIGN.md §5.1 (.chip--{success,muted}) — color is
// never the sole signal (the text label rides along).
const statusChip = (s: FormDef['status']): string => (s === 'published' ? 'chip chip--success' : 'chip chip--muted');

export function FormsPage(): JSX.Element {
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
    void listForms(org).then(setForms).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load forms.'));
  }, []);

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
      toast.success('Form created');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Create failed.'); }
    finally { setBusy(false); }
  }, [orgId, newTitle, loadForms, selectForm]);

  const save = useCallback(async () => {
    if (!selected || !draft) return;
    setBusy(true);
    try {
      const fields = draft.fields
        .map(({ _rid, ...f }) => ({ ...f, key: (f.key.trim() || slug(f.label)) }))
        .filter((f) => f.key && f.label.trim());
      const sm = draft.submitMessage.trim();
      await updateForm(orgId, selected.formId, { title: draft.title.trim() || 'Untitled', fields, createToContact: draft.createToContact, submitMessage: sm });
      loadForms(orgId);
      toast.success('Saved');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed.'); }
    finally { setBusy(false); }
  }, [selected, draft, orgId, loadForms]);

  const togglePublish = useCallback(async () => {
    if (!selected) return;
    try {
      await setFormStatus(orgId, selected.formId, selected.status === 'published' ? 'draft' : 'published');
      loadForms(orgId);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Publish failed.'); }
  }, [selected, orgId, loadForms]);

  const remove = useCallback(async (formId: string) => {
    try { await deleteForm(orgId, formId); if (selectedId === formId) setSelectedId(''); loadForms(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed.'); }
  }, [orgId, selectedId, loadForms]);

  const patchField = (i: number, patch: Partial<FormField>): void => {
    setDraft((d) => d ? { ...d, fields: d.fields.map((f, j) => j === i ? { ...f, ...patch } : f) } : d);
  };

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title="Forms is not enabled" body="Ask an administrator to enable the Forms feature for this tenant." />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label="Organization">
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div className="u-gap-3 u-flex u-flex-col">
      <PageHeader eyebrow="Workspace" title="Forms" lede="Build a public form; submissions become CRM contacts." actions={orgPicker} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<GlobeIcon />} title="No organizations" body="Create an organization first — forms belong to an org." />
      ) : (
        <>
          {/* Forms list + new form */}
          {/* New-form add toolbar (§5.1 .surface-form) */}
          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">New form</span>
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="e.g. Contact us" />
            </label>
            <button type="button" className="btn-primary" disabled={busy || !newTitle.trim()} onClick={() => void createNew()}><PlusIcon /> New form</button>
          </div>

          <div className="surface-card u-gap-2">
            <strong>Forms</strong>
            {!forms ? <Skeleton /> : forms.length === 0 ? <span className="u-label-sm">No forms yet.</span> : forms.map((f) => (
              <div key={f.formId} className="u-flex u-gap-1 u-items-center">
                <button type="button" className={`${selectedId === f.formId ? 'btn-primary' : 'btn-ghost'} u-justify-start u-flex-1`} onClick={() => selectForm(f)}>{f.title}</button>
                <span className={statusChip(f.status)}>{f.status}</span>
                <button type="button" className="btn-ghost" title="Delete form" aria-label="Delete form" onClick={() => void remove(f.formId)}><TrashIcon /></button>
              </div>
            ))}
          </div>

          {/* Builder for the selected form */}
          {selected && draft ? (
            <div className="surface-card u-gap-2">
              <div className="u-flex u-gap-2 u-items-center u-wrap">
                <strong className="u-flex-1">Edit form</strong>
                <span className={statusChip(selected.status)}>{selected.status}</span>
                <div className="action-bar">
                  <button type="button" className="btn-ghost" onClick={() => void togglePublish()}>
                    <SendIcon /> {selected.status === 'published' ? 'Unpublish' : 'Publish'}
                  </button>
                  <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}><SaveIcon /> Save</button>
                </div>
              </div>

              <label className="u-label-sm">Title
                <input value={draft.title} onChange={(e) => setDraft((d) => d ? { ...d, title: e.target.value } : d)} />
              </label>

              <strong className="u-label-sm">Fields</strong>
              {draft.fields.map((f, i) => (
                <div key={f._rid} className="surface-inset u-flex u-gap-1 u-items-center u-wrap">
                  <input value={f.label} onChange={(e) => patchField(i, { label: e.target.value })} placeholder="Label" aria-label="Field label" />
                  <input value={f.key} onChange={(e) => patchField(i, { key: e.target.value })} placeholder="key (auto)" aria-label="Field key" className="u-w-auto" />
                  <select value={f.type} onChange={(e) => patchField(i, { type: e.target.value as FieldType })} aria-label="Field type">
                    {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <label className="u-label-sm u-flex u-gap-1 u-items-center"><input type="checkbox" checked={f.required} onChange={(e) => patchField(i, { required: e.target.checked })} /> required</label>
                  <button type="button" className="btn-ghost" title="Remove field" aria-label="Remove field" onClick={() => setDraft((d) => d ? { ...d, fields: d.fields.filter((_, j) => j !== i) } : d)}><TrashIcon /></button>
                </div>
              ))}
              <div className="u-flex u-justify-start">
                <button type="button" className="btn-ghost" onClick={() => setDraft((d) => d ? { ...d, fields: [...d.fields, { key: '', label: '', type: 'text', required: false, _rid: nextRid() }] } : d)}><PlusIcon /> Add field</button>
              </div>

              <label className="u-label-sm u-flex u-gap-1 u-items-center">
                <input type="checkbox" checked={draft.createToContact} onChange={(e) => setDraft((d) => d ? { ...d, createToContact: e.target.checked } : d)} />
                Create a CRM contact from each submission
              </label>
              <label className="u-label-sm">Submit message (optional)
                <input value={draft.submitMessage} onChange={(e) => setDraft((d) => d ? { ...d, submitMessage: e.target.value } : d)} placeholder="Thanks — we'll be in touch." />
              </label>

              {selected.status === 'published' ? (
                <div className="surface-inset u-gap-1 u-flex u-flex-col">
                  <span className="u-label-sm"><GlobeIcon /> Public URL</span>
                  <div className="u-flex u-gap-1 u-items-center">
                    <code className="u-flex-1">{publicFormUrl(selected.formId)}</code>
                    <button type="button" className="btn-ghost" title="Copy public URL" aria-label="Copy public URL" onClick={() => copy(publicFormUrl(selected.formId))}><ClipboardIcon /></button>
                  </div>
                </div>
              ) : <span className="u-label-sm">Publish the form to get its public URL.</span>}
            </div>
          ) : null}

          {/* Submissions for the selected form */}
          {selected ? (
            <div className="surface-card u-gap-2">
              <strong><InboxIcon /> Submissions</strong>
              {!subs ? <Skeleton /> : subs.length === 0 ? <span className="u-label-sm">No submissions yet.</span> : subs.map((s) => (
                <div key={s.submissionId} className="surface-inset u-flex u-gap-2 u-items-center u-wrap">
                  <span className="u-flex-1">{Object.entries(s.values).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</span>
                  {s.contactId ? <span className="chip chip--success">contact</span> : s.error ? <span className="chip chip--danger">{ERR_LABEL[s.error] ?? 'error'}</span> : null}
                  <span className="u-label-sm" title={s.createdAt}>{new Date(s.createdAt).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
