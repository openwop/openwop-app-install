/**
 * UserPicker (ADR 0261) — the shared "pick a person by NAME" control.
 *
 * Replaces the raw user-id / subject text inputs scattered across the app
 * (delegate-approvals, strategy/initiative owner, CRM deal owner, CMS locale
 * grants) with one name-resolving single-select over the org's members. The
 * value it emits is a member `subject` (the principal the backend already
 * stores); the option the human reads is the member's display name.
 *
 * Two render modes:
 *  - `label` given → a full `ui/Field` SelectField (visible label + a11y wiring),
 *    for forms (Strategy, CRM, Delegation).
 *  - no `label` → a bare `<select aria-label>` for inline rows (CMS grant add).
 *
 * Robustness the raw inputs never had, kept so wiring it in never loses data:
 *  - an existing `value` that resolves to no current member is preserved as its
 *    own option (a legacy free-text owner, or a member since removed), never
 *    silently reset to empty on the next save;
 *  - a members-load failure degrades to that preserved value rather than
 *    wiping the field.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectField } from '../ui/Field.js';
import { type OrgMember } from '../client/accessClient.js';
import { loadOrgMembers } from './orgMembers.js';

export interface UserPickerProps {
  /** Selected member subject; '' = nobody. */
  value: string;
  onChange: (subject: string) => void;
  /** Org whose members to offer. Omit for the active workspace. */
  orgId?: string | undefined;
  /** Pre-loaded members — supply to reuse a fetch the parent already made. */
  members?: readonly OrgMember[] | undefined;
  /** Visible field label → labeled (Field) mode. Omit for a bare inline select. */
  label?: React.ReactNode;
  /** Accessible name for the bare inline mode (required when `label` is absent). */
  ariaLabel?: string | undefined;
  /** Offer an empty "nobody" option (default true). */
  allowEmpty?: boolean | undefined;
  /** Text for the empty option (default `common:userPickerNone`, "Unassigned").
   *  Required pickers pass a "choose a person…" prompt instead. */
  emptyLabel?: string | undefined;
  /** Subjects to hide (e.g. exclude self). */
  excludeSubjects?: readonly string[] | undefined;
  help?: React.ReactNode | undefined;
  error?: React.ReactNode | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}

function memberLabel(m: OrgMember): string {
  return m.email ? `${m.displayName} · ${m.email}` : m.displayName;
}

export function UserPicker({
  value,
  onChange,
  orgId,
  members: membersProp,
  label,
  ariaLabel,
  allowEmpty = true,
  emptyLabel,
  excludeSubjects,
  help,
  error,
  required,
  disabled,
  className,
}: UserPickerProps): JSX.Element {
  const { t } = useTranslation('common');
  const [fetched, setFetched] = useState<OrgMember[] | null>(null);

  useEffect(() => {
    if (membersProp) return; // parent owns the data
    let cancelled = false;
    setFetched(null);
    void loadOrgMembers(orgId)
      .then((m) => { if (!cancelled) setFetched(m); })
      .catch(() => { if (!cancelled) setFetched([]); });
    return () => { cancelled = true; };
  }, [orgId, membersProp]);

  const loading = !membersProp && fetched === null;

  const options = useMemo(() => {
    const source = membersProp ?? fetched ?? [];
    const excluded = new Set(excludeSubjects ?? []);
    const withSubject = source.filter((m): m is OrgMember & { subject: string } =>
      !!m.subject && !excluded.has(m.subject));
    const rows = withSubject.map((m) => ({ value: m.subject, label: memberLabel(m) }));
    // Preserve an existing value that maps to no current member (legacy free
    // text, or a member since removed) so saving can't silently drop it.
    if (value && !rows.some((r) => r.value === value)) {
      rows.unshift({ value, label: value });
    }
    return rows;
  }, [membersProp, fetched, excludeSubjects, value]);

  const selectProps = {
    value,
    disabled: disabled || loading,
    onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value),
  };

  const optionEls = (
    <>
      {allowEmpty ? <option value="">{loading ? t('loading') : (emptyLabel ?? t('userPickerNone'))}</option> : null}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </>
  );

  if (label !== undefined) {
    return (
      <SelectField
        label={label}
        help={help}
        error={error}
        required={required}
        {...(className ? { className } : {})}
        {...selectProps}
      >
        {optionEls}
      </SelectField>
    );
  }

  return (
    <select aria-label={ariaLabel} className={className} {...selectProps}>
      {optionEls}
    </select>
  );
}
