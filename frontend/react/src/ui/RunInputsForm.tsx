/**
 * Run-inputs form + dialog (reusable-workflow redesign, Phase 4 / ADR 0184 line).
 *
 * Renders a workflow's declared run-input contract (`variables[]`, the Phase 1
 * params→run-inputs lift) as a typed form, so running a reusable template PROMPTS
 * for its inputs instead of freezing a value at author time or sending none. The
 * assembled object is posted as the run's `inputs` (POST /v1/runs.inputs) and seeds
 * the per-run variable bag.
 *
 * Single source for rendering the contract — the builder Run and the project
 * "Run now" flow both use it (no second input UI). Built on the shared `Modal` +
 * `Field` primitives; presentational + host-only, no wire change.
 */
import { Button } from '../ui/Button.js';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunConfigurable } from '@openwop/openwop';
import { Modal } from './Modal.js';
import { TextField, CheckboxField, SelectField } from './Field.js';
import type { RunVariable } from '../workflows/workflowsClient.js';
import { listStoredRefs } from '../byok/lib/byokClient.js';

/** ADR 0507 — `expandChain({deferred:true})` names variables
 *  `<chainIdSlug>_<12-hex expansionId>_<param>`. Anchored on the 12-hex segment so
 *  an ordinary name containing an underscore is untouched. */
const DEFERRED_VARIABLE = /^[a-z0-9_]+_[0-9a-f]{12}_(.+)$/i;

/** The authored parameter name behind a (possibly deferred-prefixed) variable. */
export function bareVariableName(name: string): string {
  const deferred = DEFERRED_VARIABLE.exec(name);
  return deferred ? deferred[1]! : name;
}

/** ADR 0712 Phase 2 — a variable that carries a Secrets Vault ref NAME (the
 *  `credentialRef` parameter chain packs pass to `ctx.callAI`). This decides only
 *  which CONTROL renders; what registers the key on the run is the wire field
 *  `configurable.ai.credentialRef`, and the server is the authority on it. */
export function isCredentialRefVariable(v: RunVariable): boolean {
  return bareVariableName(v.name) === 'credentialRef' && (v.type === undefined || v.type === 'string');
}

/** ADR 0712 — split a chosen key out of the run inputs and onto the run options.
 *
 *  The key rides `configurable.ai.credentialRef` ONLY, and an optional credential
 *  variable is dropped from `inputs`. That is a safety choice, not tidiness: a ref
 *  passed as the node's own `credentialRef` hits the dispatcher's EXPLICIT rung,
 *  which does not check the provider, so a Google key picked for a chain pinned to
 *  Anthropic would be sent to Anthropic. The run rung only ever uses the key for
 *  the provider it names. A REQUIRED variable stays in `inputs` (the run cannot
 *  start without it). A managed ref (`managed:*`) is not a BYOK credential — the
 *  host refuses it on this field — so it stays an input and is never sent here. */
export function splitRunCredential(
  variables: RunVariable[],
  inputs: Record<string, unknown>,
): { inputs: Record<string, unknown>; configurable?: RunConfigurable } {
  for (const v of variables) {
    if (!isCredentialRefVariable(v)) continue;
    const ref = inputs[v.name];
    if (typeof ref !== 'string' || ref.trim() === '' || ref.startsWith('managed:')) continue;
    const rest = { ...inputs };
    if (!v.required) delete rest[v.name];
    return { inputs: rest, configurable: { version: 1, ai: { credentialRef: ref.trim() } } };
  }
  return { inputs };
}

/** Humanize a variable name for the field LABEL ('attendeeCompanyId' →
 *  'Attendee company id') — the wire name stays the submission key; showing it
 *  raw made template inputs read like protocol internals (day-1 UX P12/F1).
 *  Exported for tests. */
export function humanizeVariableName(name: string): string {
  // ADR 0507 — strip the RFC 0124 deferred-materialisation prefix first.
  // `expandChain({deferred:true})` names its variables
  // `<chainIdSlug>_<12-hex expansionId>_<param>`, so the raw name humanises to
  // "Finance invoice ap a2ec352bceed invoice text" — a hex id in a form label.
  // Harmless until now because seeded workflows carried NO variables and the form
  // rendered nothing; deferred seeding is what puts these in front of people.
  // Anchored on the 12-hex segment so an ordinary name containing an underscore is
  // untouched.
  const spaced = bareVariableName(name)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A run input is "answered" when it holds a non-empty value. Booleans are always
 *  answered (false is a real answer); everything else must be a non-blank string /
 *  a finite number. */
function isAnswered(v: RunVariable, value: unknown): boolean {
  if (v.type === 'boolean') return typeof value === 'boolean';
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

/** Seed the form from each variable's `defaultValue` (booleans default to false so
 *  the checkbox has a definite state). Values are held in the shape the control
 *  edits (string for text/number fields — coerced to number on submit). */
export function initialRunInputValues(variables: RunVariable[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of variables) {
    if (v.defaultValue !== undefined) out[v.name] = v.type === 'boolean' ? Boolean(v.defaultValue) : String(v.defaultValue);
    else if (v.type === 'boolean') out[v.name] = false;
    else out[v.name] = '';
  }
  return out;
}

/** Coerce the edited form values into the typed `inputs` object for the run.
 *  Empty optional fields are dropped so they fall through to the variable default. */
export function toRunInputs(variables: RunVariable[], values: Record<string, unknown>): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const v of variables) {
    const raw = values[v.name];
    if (v.type === 'boolean') { inputs[v.name] = Boolean(raw); continue; }
    if (typeof raw === 'string' && raw.trim() === '') continue; // let the default apply
    if ((v.type === 'number' || v.type === 'integer') && typeof raw === 'string') {
      const n = Number(raw);
      if (Number.isFinite(n)) inputs[v.name] = n;
      continue;
    }
    if (raw !== undefined) inputs[v.name] = raw;
  }
  return inputs;
}

/** The list of required inputs still missing a value — the caller disables Run while
 *  non-empty. */
export function missingRequired(variables: RunVariable[], values: Record<string, unknown>): RunVariable[] {
  return variables.filter((v) => v.required && !isAnswered(v, values[v.name]));
}

export function RunInputsForm({
  variables,
  values,
  onChange,
  credentialRefs,
}: {
  variables: RunVariable[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  /** ADR 0712 — the tenant's stored key NAMES. When present, a credential-ref
   *  variable renders as a picker over them instead of a free-text field (a typed
   *  name that is not in the vault is refused at run create). Absent ⇒ text. */
  credentialRefs?: readonly string[] | undefined;
}): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="u-grid u-gap-3">
      {variables.map((v) => {
        const value = values[v.name];
        if (credentialRefs && isCredentialRefVariable(v)) {
          const current = typeof value === 'string' ? value : '';
          // Keep an authored default visible even if it is not a stored key, so
          // the select never silently shows a different value than it submits.
          const options = current && !credentialRefs.includes(current) ? [current, ...credentialRefs] : credentialRefs;
          return (
            <SelectField
              key={v.name}
              label={humanizeVariableName(v.name)}
              required={v.required || undefined}
              help={t('runInputs.credentialHelp')}
              value={current}
              onChange={(e) => onChange(v.name, e.target.value)}
            >
              {!v.required ? <option value="">{t('runInputs.credentialDefault')}</option> : null}
              {options.map((ref) => <option key={ref} value={ref}>{ref}</option>)}
            </SelectField>
          );
        }
        // Reuse the shared form primitives (DESIGN.md §5.1) — never hand-roll a
        // control: they carry the label↔input association + aria-describedby help.
        if (v.type === 'boolean') {
          return (
            <CheckboxField
              key={v.name}
              label={humanizeVariableName(v.name)}
              {...(v.description ? { help: v.description } : {})}
              checked={Boolean(value)}
              onChange={(e) => onChange(v.name, e.target.checked)}
            />
          );
        }
        const numeric = v.type === 'number' || v.type === 'integer';
        return (
          <TextField
            key={v.name}
            label={humanizeVariableName(v.name)}
            required={v.required || undefined}
            {...(v.description ? { help: v.description } : {})}
            type={numeric ? 'number' : 'text'}
            {...(v.type === 'integer' ? { inputMode: 'numeric' as const } : {})}
            value={typeof value === 'string' || typeof value === 'number' ? value : ''}
            placeholder={v.required ? t('runInputs.requiredPlaceholder') : t('runInputs.optionalPlaceholder')}
            onChange={(e) => onChange(v.name, e.target.value)}
          />
        );
      })}
    </div>
  );
}

/** Modal wrapper: collects the run inputs, then hands the coerced object to `onRun`.
 *  Run is disabled while any required input is unanswered (with a hint) or `busy`. */
export function RunInputsDialog({
  workflowName,
  variables,
  onRun,
  onCancel,
  busy = false,
  error,
}: {
  workflowName: string;
  variables: RunVariable[];
  /** `configurable` is set when the run names a stored key (ADR 0712) — pass it
   *  to `createRun` beside `inputs`. */
  onRun: (inputs: Record<string, unknown>, configurable?: RunConfigurable) => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}): JSX.Element {
  const { t } = useTranslation('common');
  const [values, setValues] = useState<Record<string, unknown>>(() => initialRunInputValues(variables));
  const missing = useMemo(() => missingRequired(variables, values), [variables, values]);
  const wantsCredential = useMemo(() => variables.some(isCredentialRefVariable), [variables]);
  const [credentialRefs, setCredentialRefs] = useState<readonly string[] | undefined>(undefined);
  useEffect(() => {
    if (!wantsCredential) return undefined;
    let live = true;
    // A failed read degrades to the free-text field; the server still refuses a
    // name that is not in the vault, so nothing is lost but the convenience.
    listStoredRefs().then((refs) => { if (live) setCredentialRefs(refs); }, () => undefined);
    return () => { live = false; };
  }, [wantsCredential]);

  return (
    <Modal onClose={onCancel} label={t('runInputs.title', { name: workflowName })} error={error ?? undefined} showClose>
      <form
        className="u-grid u-gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || missing.length > 0) return;
          const split = splitRunCredential(variables, toRunInputs(variables, values));
          onRun(split.inputs, split.configurable);
        }}
      >
        <div className="u-grid u-gap-1">
          <strong className="u-fs-16">{t('runInputs.title', { name: workflowName })}</strong>
          <p className="muted u-fs-13">{t('runInputs.blurb')}</p>
        </div>
        <RunInputsForm variables={variables} values={values} credentialRefs={credentialRefs} onChange={(name, value) => setValues((p) => ({ ...p, [name]: value }))} />
        {/* The live region is ALWAYS MOUNTED; only its text is conditional.
            Mounting a `role="status"` together with its content announces NOTHING —
            a screen reader observes insertions into an EXISTING live region, so a
            node that appears already-populated is silent. Rendering the wrapper
            unconditionally and swapping the text is what makes the hint audible.
            (An attribute-level test passes against the broken form, which is how
            this survives review; found by /grade-ux 2026-08-01.) */}
        <p className="muted u-fs-12" role="status">
          {missing.length > 0 ? t('runInputs.missingHint', { n: missing.length }) : ''}
        </p>
        <div className="action-bar u-justify-end">
          <Button variant="quiet" onClick={onCancel} disabled={busy}>{t('cancel')}</Button>
          <Button variant="primary" type="submit" disabled={busy || missing.length > 0}>
            {busy ? t('runInputs.starting') : t('runInputs.run')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
