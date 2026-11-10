/** Controlled saved-reference selector. Only the caller owns its action/config. */
import { SelectField } from '../../ui/Field.js';

export function StoredCredentialField({ label, help, value, refs, emptyLabel, disabled, onChange }: {
  label: string;
  help?: string;
  value: string;
  refs: readonly string[];
  emptyLabel: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  return <SelectField label={label} help={help} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
    <option value="">{emptyLabel}</option>
    {refs.map(ref => <option key={ref} value={ref}>{ref}</option>)}
  </SelectField>;
}
