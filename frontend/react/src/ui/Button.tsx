/**
 * Button — the explicit action-intent API (ADR 0510 §4, DSA-013).
 *
 * Variants map 1:1 onto the EXISTING button classes, so adopting `<Button>` at
 * a call site is a no-visual-change refactor:
 *
 *   primary   → (bare)                    the filled clay CTA — at most one per view
 *   secondary → .secondary                the outlined workhorse
 *   quiet     → .btn-ghost                recessive row/inline actions
 *   danger    → .secondary.u-text-danger  the destructive convention (no filled-danger exists)
 *   link      → .btn-link                 an action that reads as a text link
 *   accent    → .btn-accent               the outlined accent CTA (kicktodo/empty-state family)
 *   accent-solid → .btn-accent-solid      the filled accent CTA
 *
 * `size="sm"` adds `.btn-sm`. `loading` sets `aria-busy` + disables (the label
 * stays visible — never swap it for a bare spinner). `type` defaults to
 * `"button"` (the repo convention); submit sites opt in explicitly.
 *
 * The global bare-`button` element styling remains until the unwrapped-button
 * tranche program reaches zero (`check-unwrapped-buttons.mjs` ledger); NEW code
 * uses this component. `className` passthrough exists for layout utilities and
 * feature-scoped chrome — variant/size classes never ride it.
 */
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'link' | 'accent' | 'accent-solid';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Marks the action in flight: aria-busy + disabled, label stays visible. */
  loading?: boolean;
  /** Stretches to the container's inline size. */
  fullWidth?: boolean;
  /** Explicit — defaults to "button" so a Button inside a form never submits by accident. */
  type?: 'button' | 'submit' | 'reset';
  /** Optional only for i18n `<Trans>` component slots, which inject the label. */
  children?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: '',
  secondary: 'secondary',
  quiet: 'btn-ghost',
  danger: 'secondary u-text-danger',
  link: 'btn-link',
  accent: 'btn-accent',
  'accent-solid': 'btn-accent-solid',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  fullWidth = false,
  type = 'button',
  className,
  disabled,
  children,
  ...rest
}, ref) {
  const classes = [
    VARIANT_CLASS[variant],
    size === 'sm' ? 'btn-sm' : '',
    fullWidth ? 'u-w-full' : '',
    className ?? '',
  ].filter(Boolean).join(' ');
  return (
    <button
      ref={ref}
      type={type}
      {...(classes ? { className: classes } : {})}
      disabled={disabled || loading}
      {...(loading ? { 'aria-busy': true } : {})}
      {...rest}
    >
      {children}
    </button>
  );
});
