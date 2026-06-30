/**
 * Field — the shared form-field primitive. Guarantees the accessibility
 * wiring that every hand-rolled `<label>…<input>` in the app was getting
 * wrong (jsx-a11y/label-has-associated-control): a generated id, an explicit
 * label↔control association, `aria-describedby` for help + error text, and
 * `aria-invalid` when in an error state.
 *
 * Use the typed wrappers (TextField / TextareaField / SelectField) for the
 * common cases; drop to <Field> with a render prop for custom controls.
 */

import { forwardRef, useId } from 'react';

export interface FieldProps {
  label: React.ReactNode;
  /** Help text rendered below the control and wired via aria-describedby. */
  help?: React.ReactNode | undefined;
  /** Error text; sets aria-invalid + role="alert" and wires aria-describedby. */
  error?: React.ReactNode | undefined;
  required?: boolean | undefined;
  className?: string | undefined;
  /** Inline style for the field wrapper — for bespoke layouts (e.g. a flex row
   *  of fields) the primitive shouldn't hard-code. */
  containerStyle?: React.CSSProperties | undefined;
  /** Render the control; receives the wiring props to spread onto it. */
  children: (wiring: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: true;
    'aria-required'?: true;
  }) => React.ReactNode;
}

export function Field({ label, help, error, required, className, containerStyle, children }: FieldProps): JSX.Element {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={className ? `field ${className}` : 'field'} {...(containerStyle ? { style: containerStyle } : {})}>
      <label className="field-label" htmlFor={id}>
        {label}
        {required ? <span className="field-required" aria-hidden="true">*</span> : null}
      </label>
      {children({
        id,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true } : {}),
        ...(required ? { 'aria-required': true } : {}),
      })}
      {help ? <div className="field-help" id={helpId}>{help}</div> : null}
      {error ? <div className="field-error" id={errorId} role="alert">{error}</div> : null}
    </div>
  );
}

type FieldShell = Pick<FieldProps, 'label' | 'help' | 'error' | 'required' | 'className' | 'containerStyle'>;

export const TextField = forwardRef<HTMLInputElement, FieldShell & React.InputHTMLAttributes<HTMLInputElement>>(
  function TextField({ label, help, error, required, className, containerStyle, ...input }, ref) {
    return (
      <Field label={label} help={help} error={error} required={required} className={className} containerStyle={containerStyle}>
        {(w) => <input {...w} {...input} ref={ref} />}
      </Field>
    );
  },
);

export const TextareaField = forwardRef<HTMLTextAreaElement, FieldShell & React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextareaField({ label, help, error, required, className, containerStyle, ...textarea }, ref) {
    return (
      <Field label={label} help={help} error={error} required={required} className={className} containerStyle={containerStyle}>
        {(w) => <textarea {...w} {...textarea} ref={ref} />}
      </Field>
    );
  },
);

export const SelectField = forwardRef<HTMLSelectElement, FieldShell & React.SelectHTMLAttributes<HTMLSelectElement>>(
  function SelectField({ label, help, error, required, className, containerStyle, children, ...select }, ref) {
    return (
      <Field label={label} help={help} error={error} required={required} className={className} containerStyle={containerStyle}>
        {(w) => <select {...w} {...select} ref={ref}>{children}</select>}
      </Field>
    );
  },
);

/**
 * Checkbox field — the label sits AFTER the box (the one layout `<Field>` can't
 * express, since it renders the label above the control). Explicit `htmlFor`/id
 * association + the shared `field-help` / `field-error` wiring, so it reads as
 * one product with the other form primitives (DESIGN.md §5.1).
 */
export const CheckboxField = forwardRef<HTMLInputElement, FieldShell & React.InputHTMLAttributes<HTMLInputElement>>(
  function CheckboxField({ label, help, error, required, className, containerStyle, ...input }, ref) {
    const id = useId();
    const helpId = help ? `${id}-help` : undefined;
    const errorId = error ? `${id}-error` : undefined;
    const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;
    return (
      <div {...(className ? { className } : {})} {...(containerStyle ? { style: containerStyle } : {})}>
        <label className="u-flex u-items-center u-gap-2 u-fs-13" htmlFor={id}>
          <input
            type="checkbox"
            id={id}
            ref={ref}
            {...(describedBy ? { 'aria-describedby': describedBy } : {})}
            {...(error ? { 'aria-invalid': true } : {})}
            {...(required ? { 'aria-required': true } : {})}
            {...input}
          />
          <span>
            {label}
            {required ? <span className="field-required" aria-hidden="true">*</span> : null}
          </span>
        </label>
        {help ? <div className="field-help" id={helpId}>{help}</div> : null}
        {error ? <div className="field-error" id={errorId} role="alert">{error}</div> : null}
      </div>
    );
  },
);

/** Standalone inline error text (role="alert") for non-Field contexts. */
export function FormError({ children }: { children: React.ReactNode }): JSX.Element | null {
  if (!children) return null;
  return <div className="field-error" role="alert">{children}</div>;
}
