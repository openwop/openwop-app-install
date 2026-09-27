/**
 * Canvas framework — the catalog-driven property panel (ADR 0310, extracted from
 * the app-builder editor / ADR 0305 Phase C). Renders one field per
 * `CanvasPropDef`: the type's registered widgets (`propertyWidgets`, keyed by
 * prop type) are consulted FIRST, then the built-ins — boolean, number, enum,
 * longtext, color, and the string default. TEXT-family edits ride
 * `onChangeText` (history.replace — DEF-6: structural ops undo; keystrokes use
 * the field's native undo); discrete gestures ride `onChange` (one history
 * entry each).
 */
import { useTranslation } from 'react-i18next';
import { ColorField } from '../ui/ColorField.js';
import type { FrameBase } from './frameOps.js';
import { clampNumber } from './propBounds.js';
import type { CanvasPropDef, PropertyWidget } from './types.js';

export function PropertyField({ def: p, value: val, widgets, frames, docState, orgId, onChange, onChangeText, tt }: {
  def: CanvasPropDef;
  value: unknown;
  widgets?: Record<string, PropertyWidget> | undefined;
  frames: readonly FrameBase[];
  docState: Record<string, unknown>;
  /** The active org — forwarded to widgets that browse org resources. */
  orgId: string;
  onChange: (name: string, value: unknown) => void;
  onChangeText: (name: string, value: unknown) => void;
  /** ADR 0340 (GS-5/SL-7) — the TYPE-namespace translator: labels resolve
   *  `prop_<name>` and enum options `opt_<name>_<value>` from the type's own
   *  catalog, falling back to the code label — the same FIXED key contract
   *  the chassis already reads for frame vocabulary. Optional so bare
   *  consumers keep today's English labels. */
  tt?: (key: string, opts: { defaultValue: string }) => string;
}): JSX.Element {
  const { t } = useTranslation('canvas');
  const id = `prop-${p.name}`;
  const Widget = widgets?.[p.type];
  return (
    <div className="cv-editor__field">
      {/* SL-G7 — an explicit `labelKey` wins over the derived `prop_<name>`, for
          the case where one prop name legitimately has several labels (slides'
          `title` is "Title" on most layouts and "Quote" on the quote layout). */}
      <label htmlFor={id} className="cv-editor__field-label">{tt ? tt(p.labelKey ?? `prop_${p.name}`, { defaultValue: p.label ?? p.name }) : (p.label ?? p.name)}{p.required ? ' *' : ''}</label>
      {Widget ? (
        <Widget id={id} def={p} value={val} frames={frames} docState={docState} orgId={orgId} {...(tt ? { tt } : {})} onChange={(v) => onChange(p.name, v)} onChangeText={(v) => onChangeText(p.name, v)} />
      ) : p.type === 'boolean' ? (
        <input id={id} type="checkbox" checked={Boolean(val)} onChange={(e) => onChange(p.name, e.target.checked)} />
      ) : p.type === 'number' ? (
        // DRAW-R4/DATA-D9: native min/max/step drive the spinner + form validity;
        // the actual clamp runs on BLUR (not per keystroke — clamping mid-type
        // would snap a min:0.5 field to 0.5 the instant a "0" prefix is typed).
        // Blur fires before the manual Save (clicking Save blurs the input), so a
        // hand-typed or pasted out-of-range value is bounded before it saves.
        <input
          id={id}
          type="number"
          className="cv-editor__input"
          value={typeof val === 'number' ? val : ''}
          min={p.min}
          max={p.max}
          step={p.step}
          onChange={(e) => onChange(p.name, e.target.value === '' ? undefined : Number(e.target.value))}
          onBlur={() => {
            if (typeof val !== 'number' || !Number.isFinite(val)) return; // cleared/blank passes through
            const clamped = clampNumber(val, p.min, p.max);
            if (clamped !== val) onChange(p.name, clamped);
          }}
        />
      ) : p.type === 'enum' ? (
        <select id={id} className="cv-editor__input" value={typeof val === 'string' ? val : ''} onChange={(e) => onChange(p.name, e.target.value)}>
          <option value="">—</option>
          {(p.options ?? []).map((o) => <option key={o} value={o}>{tt ? tt(`opt_${p.name}_${o}`, { defaultValue: o }) : o}</option>)}
        </select>
      ) : p.type === 'longtext' ? (
        // DRAW-R4/DATA-D9: native maxLength is browser-enforced (truly blocks
        // over-length typing) and rides onChangeText unchanged — caret + native
        // undo + IME all preserved, unlike a JS truncate.
        <textarea id={id} className="cv-editor__input cv-editor__textarea" maxLength={p.maxLength} value={typeof val === 'string' ? val : ''} onChange={(e) => onChangeText(p.name, e.target.value)} />
      ) : p.type === 'stringlist' ? (
        // One entry per line (ADR 0310 Phase C built-in — campaign KPIs; the
        // server validator enforces the per-type caps).
        <textarea
          id={id}
          className="cv-editor__input cv-editor__textarea"
          value={Array.isArray(val) ? val.filter((b): b is string => typeof b === 'string').join('\n') : ''}
          onChange={(e) => {
            const lines = e.target.value.split('\n');
            onChangeText(p.name, lines.length === 1 && lines[0] === '' ? undefined : lines);
          }}
        />
      ) : p.type === 'color' ? (
        // ADR 0333 Phase 6: the shared ColorField upgrades the ADR 0305
        // native-picker+hex pair — theme-token swatches (runtime-resolved,
        // concrete values in the doc), none, recents, EyeDropper.
        <ColorField id={id} value={typeof val === 'string' ? val : ''} onChange={(v) => onChangeText(p.name, v)} hexAriaLabel={t('hexAria', { field: p.label ?? p.name })} />
      ) : (
        <input id={id} type="text" className="cv-editor__input" maxLength={p.maxLength} value={typeof val === 'string' ? val : ''} onChange={(e) => onChangeText(p.name, e.target.value)} />
      )}
    </div>
  );
}
