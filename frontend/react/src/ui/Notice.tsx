/**
 * Notice — the one transient-notice primitive across Agents / Workflows /
 * Kanban. Routes through the token-anchored `.alert.*` classes (no hardcoded
 * hex) and leads with the matching Lucide icon (not an emoji prefix).
 *
 * ANNOUNCEMENT — read this before trusting the roles below.
 *
 * This file used to claim it "announces to assistive tech via `role=status` +
 * `aria-live`". For the common call shape that is NOT TRUE, and the claim is why
 * nobody re-checked it. Most call sites are conditionally mounted
 * (`{err ? <Notice…/> : null}`), so the live region enters the DOM with its text
 * ALREADY INSIDE — and assistive tech registers a region on insertion, then
 * announces subsequent MUTATIONS. A region that arrives complete announces
 * nothing while looking perfectly correct in the DOM, and an attribute-level test
 * passes either way. `StateCard` had the identical defect; PR #2616 proved it by
 * making the fix reversible — reverting to the inline region turns its test red.
 *
 * `role="alert"` (the `error` variant) is widely reported to be announced on
 * insertion, which is why the error sites are the less-exposed set. That is NOT
 * verified here and MUST NOT be treated as established — assuming it is exactly
 * the mistake that shipped #2615. The roles are therefore left untouched.
 *
 * The fix is opt-in per instance: pass `announce` with the text to speak, and
 * this component delegates to ADR 0363's `GlobalLiveRegion` (mounted once at
 * `App.tsx`, so it exists long before any message) INSTEAD OF rendering its own
 * region. Never both — that pairing is the DS-8 double-announce (`toast.tsx:80`:
 * "a double region made errors announce twice"), and making the two mutually
 * exclusive removes it by construction rather than by rule.
 */

import { useEffect } from 'react';
import { announce as announceToScreenReader } from './announce.js';
import { AlertIcon, CheckIcon } from './icons/index.js';

export type NoticeVariant = 'success' | 'error' | 'info' | 'warning';

function VariantIcon({ variant }: { variant: NoticeVariant }): JSX.Element | null {
  if (variant === 'success') return <CheckIcon size={15} />;
  if (variant === 'error' || variant === 'warning') return <AlertIcon size={15} />;
  return null;
}

/**
 * `announce` and `id` are mutually exclusive, enforced by the TYPE rather than a
 * comment. An `id` exists so a form control can point `aria-describedby` at this
 * notice — which means a screen reader ALREADY reads it when that control takes
 * focus. Announcing as well would speak it twice, and for live validation
 * (`CommercePage:422`, `PageExperimentsPanel:246`) it would fire again every time
 * a keystroke flips the condition. That is a regression, so it must not compile.
 */
type NoticeProps = {
  variant?: NoticeVariant;
  children: React.ReactNode;
} & (
  | {
      /** Element id — lets a form control reference this notice via `aria-describedby`. */
      id: string;
      announce?: never;
    }
  | {
      id?: undefined;
      /**
       * The text to SPEAK when this notice appears. Opt-in, and a string rather
       * than a boolean deliberately: `children` is `React.ReactNode` and most
       * call sites pass JSX, so there is no reliable text to extract — and an
       * explicit message keeps raw server error blobs out of the announcement.
       *
       * Setting it REPLACES this component's own live region for that instance.
       */
      announce?: string;
    }
);

export function Notice({ variant = 'info', children, id, announce }: NoticeProps): JSX.Element {
  // An error is announced ASSERTIVELY — a failed action must not be missed behind
  // a polite queue; the other variants stay polite (A11Y-2).
  const assertive = variant === 'error';

  useEffect(() => {
    if (announce) announceToScreenReader(announce, { assertive });
  }, [announce, assertive]);

  return (
    <div
      {...(id ? { id } : {})}
      className={`alert ${variant} u-flex u-gap-2 u-items-start`}
      // Delegating AND carrying a role would be two regions for one message.
      {...(announce
        ? {}
        : { role: assertive ? 'alert' : 'status', 'aria-live': assertive ? 'assertive' : 'polite' })}
      aria-atomic="true"
    >
      <span className="notice-icon"><VariantIcon variant={variant} /></span>
      <span>{children}</span>
    </div>
  );
}
