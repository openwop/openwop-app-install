/**
 * PageHeader — the one editorial page-title primitive (DESIGN.md §5).
 *
 * Gives every top-level page the same hierarchy and lifts the app's
 * editorial voice out of the chrome and into the content:
 *   - eyebrow: a mono uppercase kicker (the "FIG. 01" register, --ink-3)
 *   - title:   Geist sans at marquee weight, out-ranking the cards below it
 *   - lede:    a one-line sans intro (--ink-3, ≤ 64ch)
 *   - actions: a right-aligned button cluster (uses .action-bar)
 *
 * Sits above a hairline rule. Reach for this instead of a bare <h1>/<h2> so
 * "Runs", "Workflows", "AI coworkers" all read as one publication.
 */

import type { ReactNode, Ref } from 'react';

interface Props {
  /** Optional wayfinding rendered before the editorial heading. */
  breadcrumb?: ReactNode;
  /** Short mono kicker above the title, e.g. "RUNS". Rendered uppercase. */
  eyebrow?: string;
  /** The page title — sans marquee. String or node (e.g. with a count). */
  title: ReactNode;
  /** One-line intro under the title. */
  lede?: ReactNode;
  /** Right-aligned action cluster (buttons/links). */
  actions?: ReactNode;
  /** A ref to the `<h1>`, which then becomes programmatically focusable
   *  (`tabIndex={-1}`) — for a page that must land focus on its title after a
   *  navigation it caused (a record delete that returns to the collection,
   *  CRM-UX-16), so a keyboard / screen-reader user hears where they are. */
  titleRef?: Ref<HTMLHeadingElement> | undefined;
}

export function PageHeader({ breadcrumb, eyebrow, title, lede, actions, titleRef }: Props): JSX.Element {
  return (
    <header className="page-header">
      <div className="page-header__lead">
        {breadcrumb ? <div className="page-header__breadcrumb">{breadcrumb}</div> : null}
        {eyebrow ? <p className="page-header__eyebrow">{eyebrow}</p> : null}
        <h1 className="page-header__title" {...(titleRef ? { ref: titleRef, tabIndex: -1 } : {})}>{title}</h1>
        {lede ? <p className="page-header__lede">{lede}</p> : null}
      </div>
      {actions ? <div className="page-header__actions action-bar">{actions}</div> : null}
    </header>
  );
}
