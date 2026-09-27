/**
 * InlineState + EmptyRow — the COMPACT designed-state primitives (ADR 0510 §4,
 * DSA-030). Full-page states own `<StateCard>`; embedded regions (an analytics
 * panel, a coupon list inside a tab, a table body) kept regressing to bespoke
 * muted paragraphs — this is their one shared shape.
 *
 * Honest-state doctrine applies at every size (DESIGN.md §4.6): `failed` is a
 * FAILED READ, never rendered as if the server said "none" — it announces via
 * the shared live region (StateCard's announcer semantics) and offers a retry.
 * `empty` is for a TRUE empty answer only.
 *
 * `EmptyRow` is the table-aware wrapper: one full-width cell carrying an
 * InlineState, so tables stop hand-rolling `<td colSpan>` muted text.
 */
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { announce as announceToScreenReader } from './announce.js';
import { Skeleton } from './Skeleton.js';
import { AlertIcon } from './icons/index.js';

export type InlineStateKind = 'loading' | 'empty' | 'failed';

export interface InlineStateProps {
  kind: InlineStateKind;
  /**
   * The one-line message. Optional for `loading` (skeleton only).
   *
   * `ReactNode` rather than `string` so a composed message can carry its own
   * structure (a second sentence in its own element). Existing callers pass
   * strings and are unaffected — this widens the type, not the behaviour.
   */
  message?: ReactNode;
  /** A single compact action — retry for `failed`, a create CTA for `empty`. */
  action?: ReactNode;
  /**
   * `failed` only: the text to ANNOUNCE — pass the same message unless the
   * visible copy is unsuitable for speech (a long body, or copy that only
   * parses beside a title).
   */
  announce?: string;
  /**
   * Announce POLITELY instead of assertively (DESIGN.md §4.6 rule 8).
   *
   * The default stays assertive because that is what every existing caller
   * already gets, and those are failed ACTIONS the user just took — the case
   * §4.6 explicitly leaves assertive. Set this when the state appears on LOAD
   * or on a background poll: interrupting someone mid-sentence for something
   * they did not do is the wrong trade, and `StateCard` (the page-level twin of
   * this component) has always announced politely for exactly that reason. The
   * two variants of `OrgSelectionState` disagreeing on this was the defect that
   * put the prop here.
   */
  announcePolite?: boolean;
}

export function InlineState({ kind, message, action, announce, announcePolite }: InlineStateProps): JSX.Element {
  const { t } = useTranslation('common');
  useEffect(() => {
    if (kind === 'failed' && announce) {
      announceToScreenReader(announce, { assertive: !announcePolite });
    }
  }, [kind, announce, announcePolite]);

  if (kind === 'loading') {
    return (
      <div className="inline-state inline-state--loading" aria-busy="true">
        <Skeleton width="60%" />
        {message ? <span className="sr-only">{message}</span> : null}
      </div>
    );
  }
  if (kind === 'failed') {
    return (
      <div className="inline-state inline-state--failed" {...(announce ? {} : { role: 'alert' })}>
        <AlertIcon size={14} aria-hidden />
        <span>{message ?? t('inlineFailed')}</span>
        {action}
      </div>
    );
  }
  return (
    <div className="inline-state inline-state--empty">
      <span>{message ?? t('inlineEmpty')}</span>
      {action}
    </div>
  );
}

/** Table-aware empty/failed/loading row: one cell spanning the table. */
export function EmptyRow({ colSpan, ...state }: InlineStateProps & { colSpan: number }): JSX.Element {
  return (
    <tr className="inline-state-row">
      <td colSpan={colSpan}>
        <InlineState {...state} />
      </td>
    </tr>
  );
}
