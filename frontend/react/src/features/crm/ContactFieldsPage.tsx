/**
 * Contact custom-field definitions — /crm/fields (CRM-UX-7).
 *
 * `GET/POST /host/openwop-app/crm/fields` (+ `DELETE …/:defId`) have shipped
 * since ADR 0213 §2 with ZERO frontend consumers, and `crmClient.ts` said so in
 * a COMMENT rather than in the UI ("not yet editable from this page's contact
 * form"). The result: contact create/update already resolved `customFields` on
 * the wire, segments could FILTER on `customFields.<key>` for keys no operator
 * could define, and the values rendered read-only in a DIFFERENT feature's
 * console — so an AI agent could write a field a human could neither define nor
 * edit. This page is the definitions half; `ContactCustomFields.tsx` is the
 * values half.
 *
 * TENANT-scoped, not org-scoped (ADR 0213 §2), which is why this route takes no
 * `?org=` — the org `/fields` route deliberately refuses `entityType: contact`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { formatNumber } from '../../i18n/format.js';
import { HashIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import {
  CONTACT_FIELD_MAX,
  CONTACT_FIELD_TYPES,
  REF_ENTITY_TYPES,
  createContactField,
  deleteContactField,
  listContactFields,
  type ContactFieldDef,
  type ContactFieldType,
  type RefEntityType,
} from './crmClient.js';
import { crmActionError, focusFirst } from './crmUiHelpers.js';

export function ContactFieldsPage(): JSX.Element {
  const { t } = useTranslation('crm');
  const { t: tc } = useTranslation('common');
  const crm = useFeatureAccess('crm');

  const [fields, setFields] = useState<ContactFieldDef[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<ContactFieldType>('string');
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState('');
  const [refEntityType, setRefEntityType] = useState<RefEntityType>('company');
  const [busy, setBusy] = useState(false);

  // CRM-UX-16 — the focus target after a row delete: the table's caption,
  // else (the last definition just went, and the table swapped for its empty
  // card) the page title. Deferred via `pendingFocusRef` to the effect on
  // `fields`, so it runs AFTER the reload decided whether a caption exists.
  const pendingFocusRef = useRef(false);
  const captionRef = useRef<HTMLTableCaptionElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const load = useCallback(() => {
    setFailed(false);
    void listContactFields()
      .then(setFields)
      // HIGH-1 — UNKNOWN (`null`), never `[]`. `failed` is cleared
      // synchronously above, so the stale `[]` rendered the "No custom fields
      // yet" card for the whole RETRY request — precisely the claim the empty
      // slot's own docblock says must never appear, with the create form live
      // beside it, inviting the duplicate-key 409 it warns about.
      .catch(() => { setFields(null); setFailed(true); });
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    focusFirst(captionRef.current, titleRef.current);
  }, [fields]);

  const parsedOptions = options.split(',').map((o) => o.trim()).filter(Boolean);
  // An `enum` with no options is a control with nothing to pick — the server
  // rejects it, so the form says so first.
  const enumNeedsOptions = type === 'enum' && parsedOptions.length === 0;
  const atCap = fields !== null && !failed && fields.length >= CONTACT_FIELD_MAX.keys;

  const add = useCallback(async () => {
    if (!key.trim() || !label.trim() || enumNeedsOptions) return;
    setBusy(true);
    try {
      await createContactField({
        key: key.trim(),
        label: label.trim(),
        type,
        required,
        ...(type === 'enum' ? { options: parsedOptions } : {}),
        ...(type === 'reference' ? { refEntityType } : {}),
      });
      setKey(''); setLabel(''); setRequired(false); setOptions('');
      load();
      toast.success(t('contactFieldCreated'));
    } catch (e) {
      // The server owns key normalization, the 50-key cap and the duplicate-key
      // 409 — surface its message rather than re-deriving those rules here.
      toast.error(crmActionError(e, 'addFailed'));
    } finally { setBusy(false); }
  }, [key, label, type, required, parsedOptions, refEntityType, enumNeedsOptions, load, t]);

  const remove = useCallback(async (def: ContactFieldDef) => {
    if (!(await confirm({
      title: t('contactFieldDeleteConfirm', { label: def.label }),
      body: t('contactFieldDeleteBody', { key: def.key }),
      danger: true,
      confirmLabel: tc('delete'),
    }))) return;
    try {
      await deleteContactField(def.defId);
      // CRM-UX-16 — the row's Delete button unmounts with the reload; the
      // effect on `fields` lands focus so it is not dropped to <body>.
      pendingFocusRef.current = true;
      load();
      toast.success(t('contactFieldDeleted'));
    } catch (e) { toast.error(crmActionError(e, 'deleteFailed')); }
  }, [load, t, tc]);

  const columns: DataColumn<ContactFieldDef>[] = [
    { key: 'label', header: t('contactFieldColLabel'), render: (f) => f.label },
    { key: 'key', header: t('contactFieldColKey'), cellClassName: 'muted', render: (f) => <code>{f.key}</code> },
    // Type + required as LABELED chips, never colour alone (§5.3).
    { key: 'type', header: t('contactFieldColType'), render: (f) => (
      <span className="action-bar">
        <span className="chip">{t(`customFieldType_${f.type}`)}</span>
        {f.required ? <span className="chip chip--warning">{t('contactFieldRequiredChip')}</span> : null}
      </span>
    ) },
    { key: 'detail', header: t('contactFieldColDetail'), cellClassName: 'muted', render: (f) => (
      f.type === 'enum' ? (f.options ?? []).join(', ')
        : f.type === 'reference' ? t(`customFieldRef_${f.refEntityType ?? 'contact'}`)
        : '—'
    ) },
    { key: 'actions', header: '', render: (f) => (
      <Button variant="quiet" onClick={() => void remove(f)} aria-label={t('contactFieldDeleteLabel', { label: f.label })}>{tc('delete')}</Button>
    ) },
  ];

  // LOW-7 — `data-walkthrough` rides EVERY branch, not just the happy one
  // (the `CompanyDetailPage` precedent). A walkthrough step anchored to this
  // page otherwise cannot find its target while the toggle is still resolving,
  // or when the feature is off — which is exactly when it needs to say so.
  if (crm.loading) return <div data-walkthrough="crm-fields.page"><Skeleton /></div>;
  if (!crm.enabled) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="crm-fields.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }

  return (
    <section className="u-grid u-gap-4" data-walkthrough="crm-fields.page">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('contactFieldsTitle')}
        titleRef={titleRef}
        lede={t('contactFieldsLede')}
        actions={<Link to="/crm?tab=contacts" className="btn-ghost">{t('backToCrm')}</Link>}
      />

      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('contactFieldLabelLabel')}</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={CONTACT_FIELD_MAX.label} placeholder={t('contactFieldLabelPlaceholder')} />
        </label>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('contactFieldKeyLabel')}</span>
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder={t('contactFieldKeyPlaceholder')} />
        </label>
        <label className="u-grid u-gap-1 is-narrow">
          <span className="u-label-sm">{t('contactFieldTypeLabel')}</span>
          <select value={type} onChange={(e) => setType(e.target.value as ContactFieldType)}>
            {CONTACT_FIELD_TYPES.map((ft) => <option key={ft} value={ft}>{t(`customFieldType_${ft}`)}</option>)}
          </select>
        </label>
        {type === 'enum' ? (
          // A `.field` div, not a wrapping <label>: a hint INSIDE a label joins
          // the control's accessible NAME ("Options Comma-separated, up to
          // 24…"). It belongs in `aria-describedby` — a description, not a name.
          <div className="field">
            <label className="u-label-sm" htmlFor="crm-field-options">{t('contactFieldOptionsLabel')}</label>
            <input id="crm-field-options" aria-describedby="crm-field-options-hint" value={options} onChange={(e) => setOptions(e.target.value)} placeholder={t('contactFieldOptionsPlaceholder')} />
            <span id="crm-field-options-hint" className="muted u-fs-12">{enumNeedsOptions ? t('contactFieldOptionsRequired') : t('contactFieldOptionsHint', { max: formatNumber(CONTACT_FIELD_MAX.options) })}</span>
          </div>
        ) : null}
        {type === 'reference' ? (
          <label className="u-grid u-gap-1 is-narrow">
            <span className="u-label-sm">{t('contactFieldRefLabel')}</span>
            <select value={refEntityType} onChange={(e) => setRefEntityType(e.target.value as RefEntityType)}>
              {REF_ENTITY_TYPES.map((re) => <option key={re} value={re}>{t(`customFieldRef_${re}`)}</option>)}
            </select>
          </label>
        ) : null}
        <label className="u-iflex u-items-center u-gap-2">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
          <span className="u-label-sm">{t('contactFieldRequiredLabel')}</span>
        </label>
        <Button variant="primary" type="submit" disabled={busy || !key.trim() || !label.trim() || enumNeedsOptions || atCap}>{t('contactFieldCreate')}</Button>
        <p className="muted u-fs-12 u-m-0 u-w-full">
          {atCap ? t('contactFieldCapReached', { max: formatNumber(CONTACT_FIELD_MAX.keys) }) : t('contactFieldKeyHint')}
        </p>
      </form>

      <DataTable
        stack
        rows={fields ?? []}
        rowKey={(f) => f.defId}
        columns={columns}
        caption={t('contactFieldsTitle')}
        captionRef={captionRef}
        // The FAILURE branch is checked first (HIGH-1): on a failure `fields`
        // is `null`, so a skeleton-first order would hide the card.
        empty={failed ? (
          // A failed read never renders as "no fields defined" — that would
          // invite an operator to re-create a field that already exists and
          // collect a duplicate-key 409 for their trouble.
          <StateCard
            announce
            icon={<HashIcon />}
            title={tc('loadFailedTitle')}
            body={tc('loadFailedBody')}
            action={<Button variant="secondary" onClick={load}>{tc('retry')}</Button>}
          />
        ) : fields === null ? <Skeleton /> : (
          <StateCard icon={<HashIcon />} title={t('contactFieldsEmptyTitle')} body={t('contactFieldsEmptyBody')} />
        )}
      />
    </section>
  );
}
