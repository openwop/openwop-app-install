/**
 * Canvas framework — shared property widgets beyond the PropertyField
 * built-ins (ADR 0310 Phase C). Registered per definition via
 * `propertyWidgets`, keyed by `CanvasPropDef.type`.
 */
import type { PropertyWidgetProps } from './types.js';

/** A REQUIRED enum: like the built-in enum widget but with no empty option —
 *  schema-required discriminators (campaign channel `type`, funnel `stage`)
 *  must never clear. Options come from the field's `options`. */
export function RequiredEnumWidget({ id, def, value, onChange, tt }: PropertyWidgetProps): JSX.Element {
  const options = def.options ?? [];
  // CS-G3 — the same `opt_<name>_<value>` lookup the BUILT-IN `enum` branch does
  // (PropertyForm) and QuickPropsCluster does. Without it, an optional enum was
  // localized and a required one rendered raw codes on the same panel — purely
  // an artefact of which widget drew it. Falls back to the code, so a consumer
  // that supplies no keys is byte-for-byte unchanged.
  const label = (o: string): string => (tt ? tt(`opt_${def.name}_${o}`, { defaultValue: o }) : o);
  return (
    <select id={id} className="cv-editor__input" value={typeof value === 'string' ? value : options[0] ?? ''} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o} value={o}>{label(o)}</option>)}
    </select>
  );
}
