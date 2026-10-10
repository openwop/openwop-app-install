/**
 * ADR 0850 D7 — author a field's conditional visibility (ADR 0808 `when`).
 *
 * The model, the server sanitizer (`host/formFieldConditions.ts`) and the
 * public renderer all shipped with ADR 0808; the builder could only DISPLAY a
 * condition a pack template carried. This is the editor: one condition per
 * field, on an EARLIER field (the server's own rule — it is what makes
 * visibility resolve in one pass and a cycle unwritable).
 *
 * The operator and value are typed by the CONTROLLER's field type, because the
 * evaluator compares strictly against the submitted value (architect M6):
 * - checkbox → `truthy` / `falsy` only (it submits a boolean, so `equals "yes"`
 *   could never match and the field would silently never show);
 * - select → `equals` / `notEquals` against one of its options;
 * - every other type → `equals` / `notEquals` / `contains` with a STRING value
 *   (a number field's value is still a string when the condition is judged).
 * A condition the controller can no longer satisfy is a named save blocker in
 * `whenProblem`, not a silent never-shows.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormField } from './formsClient.js';
import { effectiveKey } from './fieldKeys.js';

export type FieldWhen = NonNullable<FormField['when']>;
type Op = FieldWhen['type'];

const CHECKBOX_OPS: readonly Op[] = ['truthy', 'falsy'];
const SELECT_OPS: readonly Op[] = ['equals', 'notEquals'];
const TEXT_OPS: readonly Op[] = ['equals', 'notEquals', 'contains'];

export function opsFor(type: FormField['type']): readonly Op[] {
  return type === 'checkbox' ? CHECKBOX_OPS : type === 'select' ? SELECT_OPS : TEXT_OPS;
}
export const takesValue = (op: Op): boolean => op !== 'truthy' && op !== 'falsy';
export const controllerKeyOf = (when: FieldWhen): string => when.left.replace(/^fields\./, '');
/** A select's options AS SAVED — the save path trims and drops blanks, so a
 *  condition must compare against the same list or `" Yes "` never matches
 *  the saved `"Yes"` (grade-code FRM2CD-9). */
const optionsOf = (f: Pick<FormField, 'options'>): string[] => (f.options ?? []).map((o) => o.trim()).filter(Boolean);

/**
 * Why a field's condition can NEVER be met against the fields as they now
 * stand, or null. Mirrors the server (an earlier controller that exists) and
 * adds the value-type checks the server cannot make without changing the shared
 * evaluator. Deliberately lenient toward conditions the editor would not author
 * but that DO work — a pack template's checkbox `equals true` matches the
 * boolean a checkbox submits (`render/whenCases.json`), so it is not a problem.
 */
export type WhenProblem = 'controller' | 'operator' | 'option' | 'value';
export function whenProblem(fields: ReadonlyArray<Pick<FormField, 'key' | 'type' | 'options' | 'when'> & { label?: string }>, i: number): WhenProblem | null {
  const when = fields[i]?.when;
  if (!when) return null;
  const ci = fields.findIndex((f) => effectiveKey({ key: f.key, label: f.label ?? '' }) === controllerKeyOf(when));
  if (ci < 0 || ci >= i) return 'controller';
  const c = fields[ci]!;
  if (!takesValue(when.type)) return null;
  if (c.type === 'checkbox') {
    // A checkbox submits a boolean: only a boolean comparison can ever match.
    return (when.type === 'equals' || when.type === 'notEquals') && typeof when.right === 'boolean' ? null : 'operator';
  }
  if (typeof when.right !== 'string') return 'value'; // a non-string never equals the submitted string
  if (!when.right.trim()) return 'value';
  if (c.type === 'select' && when.type !== 'contains' && !optionsOf(c).includes(when.right)) return 'option';
  return null;
}

export function FieldWhenEditor({ fields, index, onChange }: {
  fields: ReadonlyArray<FormField>;
  index: number;
  onChange: (when: FieldWhen | undefined) => void;
}): JSX.Element | null {
  const { t } = useTranslation('forms');
  const field = fields[index];
  // The EFFECTIVE key (FRM2UX-4): a field left on "key (auto)" is still a
  // controller, under the key it will be saved with.
  const controllers = fields.slice(0, index).filter((f) => effectiveKey(f));
  // A stored condition always keeps its control, even with nothing earlier to
  // point at (moved to the top, controller deleted) — otherwise the save
  // blocker names a problem the page offers no way to clear (FRM2UX-1, the
  // FRM2-1 "unrendered control" lesson).
  if (!field || (controllers.length === 0 && !field.when)) return null;
  const when = field.when;
  const label = field.label || field.key || String(index + 1);
  const controllerKey = when ? controllerKeyOf(when) : '';
  const controller = controllers.find((f) => effectiveKey(f) === controllerKey);
  const ops = controller ? opsFor(controller.type) : [];
  const problem = whenProblem(fields, index);

  const pickController = (key: string): void => {
    if (!key) { onChange(undefined); return; }
    const c = controllers.find((f) => effectiveKey(f) === key);
    if (!c) return;
    const op = opsFor(c.type)[0]!;
    const first = c.type === 'select' ? optionsOf(c)[0] ?? '' : '';
    onChange({ type: op, left: `fields.${key}`, ...(takesValue(op) ? { right: first } : {}) });
  };
  const pickOp = (op: Op): void => {
    if (!when) return;
    const right = typeof when.right === 'string' ? when.right : '';
    onChange({ type: op, left: when.left, ...(takesValue(op) ? { right } : {}) });
  };
  const ruleLabel = (op: Op): string => t(controller?.type === 'checkbox' ? `whenOpCheckbox_${op}` : `whenOp_${op}`);

  return (
    <div className="u-flex u-gap-1 u-items-center u-wrap">
      <label className="u-label-sm u-flex u-gap-1 u-items-center u-wrap u-min-w-0">{t('whenEditorLabel')}
        <select
          value={when ? controllerKey : ''}
          onChange={(e) => pickController(e.target.value)}
          // WCAG 2.5.3 — the name STARTS with the visible "Show this field".
          aria-label={t('whenControllerAria', { label })}
          aria-invalid={problem === 'controller' || undefined}
          className="u-w-auto u-min-w-0"
        >
          <option value="">{t('whenAlways')}</option>
          {controllers.map((c) => <option key={effectiveKey(c)} value={effectiveKey(c)}>{t('whenOnlyWhen', { field: c.label || effectiveKey(c) })}</option>)}
          {/* A stored condition on a field that is gone or now later keeps a
              visible, clearable entry — the FRM2-1 "unrendered control" lesson. */}
          {when && !controller ? <option value={controllerKey}>{t('whenControllerMissing', { key: controllerKey })}</option> : null}
        </select>
      </label>
      {when && controller ? (
        <>
          <select
            value={when.type}
            onChange={(e) => pickOp(e.target.value as Op)}
            aria-label={t('whenOperatorAria', { label })}
            aria-invalid={problem === 'operator' || undefined}
            className="u-w-auto u-min-w-0"
          >
            {/* A stored rule outside the authorable set (a pack template's
                checkbox `equals true`) stays selected and visible. */}
            {[...ops, ...(ops.includes(when.type) ? [] : [when.type])].map((op) => <option key={op} value={op}>{ruleLabel(op)}</option>)}
          </select>
          {takesValue(when.type) && controller.type !== 'checkbox' ? (
            controller.type === 'select' ? (
              <select
                value={typeof when.right === 'string' ? when.right : ''}
                onChange={(e) => onChange({ ...when, right: e.target.value })}
                aria-label={t('whenValueAria', { label })}
                aria-invalid={problem === 'option' || undefined}
                className="u-w-auto u-min-w-0"
              >
                {!optionsOf(controller).includes(typeof when.right === 'string' ? when.right : '')
                  ? <option value={typeof when.right === 'string' ? when.right : ''}>{t('whenOptionMissing')}</option>
                  : null}
                {optionsOf(controller).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                value={typeof when.right === 'string' ? when.right : String(when.right ?? '')}
                onChange={(e) => onChange({ ...when, right: e.target.value })}
                maxLength={200}
                placeholder={t('whenValuePlaceholder')}
                aria-label={t('whenValueAria', { label })}
                aria-invalid={problem === 'value' || undefined}
                className="u-w-auto u-min-w-0"
              />
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}
