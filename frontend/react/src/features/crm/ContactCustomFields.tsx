/**
 * The VALUE half of CRM-UX-7 — one input per tenant-defined contact custom
 * field, shared by the contact create form and the per-contact edit modal so
 * the two can never disagree about how a `date` or an `enum` is entered.
 *
 * The definitions themselves are authored on `/crm/fields`
 * (`ContactFieldsPage`); this renders whatever they say.
 *
 * WHY VALUES ARE HELD AS STRINGS. `<input>` is a string control, and coercing
 * on every keystroke is what makes a number field snap to 0 while you are
 * clearing it (the round-2 forms lesson). `toWire()` does the one conversion,
 * at submit, and DROPS empties rather than sending `''` — the server treats a
 * missing key as unset, and an empty string as a real empty value.
 */
import { useTranslation } from 'react-i18next';
import type { ContactFieldDef, CustomFieldValues } from './crmClient.js';

/** Draft values keyed by field KEY. Always a string, whatever the field type. */
export type CustomFieldDraft = Record<string, string>;

/** Seed a draft from a contact's stored values (or an empty one for create). */
export function toDraft(defs: readonly ContactFieldDef[], values?: CustomFieldValues): CustomFieldDraft {
  const draft: CustomFieldDraft = {};
  for (const def of defs) {
    const v = values?.[def.key];
    draft[def.key] = v === undefined || v === null ? (def.type === 'boolean' ? 'false' : '') : String(v);
  }
  return draft;
}

/**
 * Draft → wire. Empty strings are OMITTED, not sent as `''`.
 *
 * A `number` that does not parse is also omitted rather than sent as `NaN`.
 *
 * LOW-1 — the reason given for that used to be "so a typo can never silently
 * erase a stored value". THAT CLAIM IS FALSE. `updateContactFields` sends the
 * map to `PATCH …/contacts/:id`, and the handler does
 * `next.customFields = patch.customFields` — a REPLACE, not a merge
 * (`contactsService.ts`). An omitted key is therefore erased *exactly* as a
 * `null` would erase it. Omission is not a safety net: it IS the clear, and it
 * is the intended one — the same gesture as emptying any other box, and the
 * modal says so out loud (`customFieldsEditHint`: "Saving replaces this
 * contact's whole custom-field set with what is shown here").
 *
 * Omitting NaN is still right, for a DIFFERENT and larger reason. `NaN`
 * serializes to `null`, and the server's `isFieldMap` guard accepts only
 * string/number/boolean values — ONE null makes the whole map fail the guard,
 * at which point `resolveContactCustomFields` substitutes `{}` and the replace
 * wipes EVERY custom field on the contact, not just the mistyped one. So the
 * omission scopes the damage of a typo to the one field the user was editing;
 * it does not prevent it.
 */
export function toWire(defs: readonly ContactFieldDef[], draft: CustomFieldDraft): CustomFieldValues {
  const out: CustomFieldValues = {};
  for (const def of defs) {
    const raw = (draft[def.key] ?? '').trim();
    if (raw === '') {
      // A boolean's "unset" is meaningful as `false`; every other type omits.
      if (def.type === 'boolean') out[def.key] = false;
      continue;
    }
    if (def.type === 'number') {
      const n = Number(raw);
      if (Number.isFinite(n)) out[def.key] = n;
      continue;
    }
    if (def.type === 'boolean') { out[def.key] = raw === 'true'; continue; }
    out[def.key] = raw;
  }
  return out;
}

/** True when every `required` field has something in it — the same rule the
 *  server enforces on CREATE, checked here so the user is told before the POST
 *  rather than by a 400. */
export function missingRequired(defs: readonly ContactFieldDef[], draft: CustomFieldDraft): ContactFieldDef[] {
  return defs.filter((def) => def.required && def.type !== 'boolean' && (draft[def.key] ?? '').trim() === '');
}

/** The DOM id `ContactCustomFieldInputs` gives a field's control — exported so
 *  a form can move focus to the field it just marked invalid (CRM-UX-15). */
export function customFieldInputId(idPrefix: string, def: ContactFieldDef): string {
  return `${idPrefix}-${def.defId}`;
}

export function ContactCustomFieldInputs({ defs, draft, onChange, idPrefix, errors }: {
  defs: readonly ContactFieldDef[];
  draft: CustomFieldDraft;
  onChange: (key: string, value: string) => void;
  /** Distinguishes the create form's inputs from the modal's when both are
   *  mounted — ids must be unique per document. */
  idPrefix: string;
  /** CRM-UX-15 — per-field validation messages keyed by field KEY. A keyed
   *  field renders `aria-invalid` + `aria-describedby` → the message (the
   *  `ui/Field` contract), so the failure is ON the field, not only in a toast. */
  errors?: Readonly<Record<string, string>> | undefined;
}): JSX.Element | null {
  const { t } = useTranslation('crm');
  if (defs.length === 0) return null;
  return (
    <>
      {defs.map((def) => {
        const id = customFieldInputId(idPrefix, def);
        const value = draft[def.key] ?? '';
        const label = def.required ? t('fieldRequiredLabel', { label: def.label }) : def.label;
        const error = errors?.[def.key];
        const errorId = `${id}-error`;
        const invalid = error ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {};
        const errorNode = error ? <span id={errorId} className="field-error" role="alert">{error}</span> : null;
        if (def.type === 'boolean') {
          return (
            <label key={def.defId} className="u-iflex u-items-center u-gap-2">
              <input id={id} type="checkbox" checked={value === 'true'} onChange={(e) => onChange(def.key, String(e.target.checked))} />
              <span className="u-label-sm">{label}</span>
            </label>
          );
        }
        if (def.type === 'enum') {
          return (
            <div key={def.defId} className="field">
              <label className="u-label-sm" htmlFor={id}>{label}</label>
              <select id={id} value={value} onChange={(e) => onChange(def.key, e.target.value)} required={def.required} {...invalid}>
                {/* The blank option is what makes an OPTIONAL enum clearable —
                    without it the first option is silently "chosen" by the
                    browser and a value the user never picked gets written. */}
                <option value="">{t('customFieldNoValue')}</option>
                {(def.options ?? []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
              {errorNode}
            </div>
          );
        }
        const inputType = def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text';
        const isRef = def.type === 'reference';
        const entity = t(`customFieldRef_${def.refEntityType ?? 'contact'}`);
        // A `.field` div, not a wrapping <label>, whenever there is a hint: a
        // hint INSIDE a label joins the control's accessible NAME. It belongs in
        // `aria-describedby` — a description, not a name.
        return (
          <div key={def.defId} className="field">
            <label className="u-label-sm" htmlFor={id}>{label}</label>
            <input
              id={id}
              type={inputType}
              value={value}
              required={def.required}
              onChange={(e) => onChange(def.key, e.target.value)}
              {...(isRef ? { placeholder: t('customFieldRefPlaceholder', { entity }) } : {})}
              {...invalid}
              {...(isRef || error ? { 'aria-describedby': [isRef ? `${id}-hint` : '', error ? errorId : ''].filter(Boolean).join(' ') } : {})}
            />
            {/* A `reference` holds an ID, which is not guessable — say so
                rather than letting the user type a name that will 400. */}
            {isRef ? <span id={`${id}-hint`} className="muted u-fs-12">{t('customFieldRefHint', { entity })}</span> : null}
            {errorNode}
          </div>
        );
      })}
    </>
  );
}
