/**
 * StateCard — the one empty / loading / error block across Agents / Workflows /
 * Kanban. Every empty state names ONE next action (the `action` slot). Replaces
 * the bare muted-text empty states ("Select or create a board", "no task board
 * yet", "Loading…") that each surface reinvented.
 *
 * ── BEFORE YOU RENDER AN EMPTY STATE: PROVE THE READ SUCCEEDED ──────────────
 *
 *     {items && items.length === 0 && !failed && <StateCard … />}
 *      ▲                              ▲
 *      │                              └─ and that it did not FAIL
 *      └─ the read actually came back (not still null)
 *
 * An empty state is a POSITIVE CLAIM — "there is nothing here" — and it is the
 * one claim a failed read must never make. The trap is that the empty is rarely
 * written by the catch; it is usually minted at RENDER by a `?? []` coalesce, so
 * the state stays `null`, an error flag gets set somewhere else, and the list
 * renders `[]` anyway. `scripts/check-failed-read-sentinels.mjs` greps the CATCH
 * and is structurally blind to that shape (its docblock, note 3).
 *
 * MEASURED 2026-08-10: of 61 files carrying the LIST form of the risky shape
 * (`?? []` feeding an empty state), 59 already get this right and reached the
 * idiom above independently — it is the house style, it simply was not written
 * down anywhere. The two that did not were a creator's earnings ("Nothing
 * accrued yet" when the read failed) and a router's rules ("every turn uses the
 * fallback target" when the config was unreadable). Both were on surfaces where
 * a confident zero is the costliest possible wrong answer.
 *
 * The same rule covers the NUMERIC form, which that audit did NOT sweep: `?? 0`
 * feeding a stat, chip or total renders a confident ZERO on a failed read, which
 * is worse than a false "none" because it looks like a measurement. Guard it the
 * same way — prove the read succeeded before you render the number.
 *
 * The failure flag has no canonical name in this repo (`error`, `loadFailed`,
 * `orgsFailed`, `earningsFailed`, `decisionsFailed`, `linksFailed`, and at least
 * one `'error'` state-sentinel), which is exactly why no gate can enforce this
 * and why it is written here instead — on the component every author opens when
 * adding an empty state.
 */
import { useEffect } from 'react';
import { announce as announceToScreenReader } from './announce.js';

export function StateCard({
  icon,
  title,
  body,
  action,
  loading,
  announce,
}: {
  /** A Lucide icon node shown above the title. */
  icon?: React.ReactNode;
  title: string;
  body?: React.ReactNode;
  /** The single next-action CTA(s). Omit for loading states. */
  action?: React.ReactNode;
  /** When true, marks the region busy for assistive tech. */
  loading?: boolean;
  /**
   * Announce this card when it appears. Set it on FAILED-READ states.
   *
   * WHY IT EXISTS. Without it the swap is silent. A sighted user watches a
   * skeleton become "Couldn't load your environments"; a screen-reader user is
   * told nothing, and nothing reads as "nothing to report" — the exact false
   * conclusion the whole failed-read effort exists to prevent, reintroduced for
   * the users least able to work around it.
   *
   * WHY IT DELEGATES INSTEAD OF RENDERING ITS OWN REGION — this is the part that
   * is easy to get wrong, and the first cut (#2615) got it wrong. A `role=status`
   * container that is MOUNTED WITH ITS TEXT ALREADY INSIDE is not reliably
   * announced: assistive tech registers the region on insertion and generally
   * announces only SUBSEQUENT mutations. Every failure card in this app is
   * conditionally mounted (`error ? <StateCard/> : …`), so an inline region on
   * this component announces approximately nothing while looking completely
   * correct in the DOM — and a test asserting the attribute passes either way.
   *
   * ADR 0363's `GlobalLiveRegion` is mounted once at the app shell and already
   * solves this: the region is present long before the message, and repeats
   * re-announce via its zero-width-space marker. So this defers to that owner
   * rather than standing up a second, weaker one. No double-announce — the card
   * picks exactly one mechanism, and `Notice`/`toast` keep their own.
   *
   * POLITE, not assertive: these appear on load, not in response to something the
   * user just did. `Notice`'s assertive branch stays right for failed ACTIONS —
   * the distinction is who initiated it.
   *
   * Opt-in and defaulted off: an empty or loading card must NOT announce. A live
   * region that fires on every ordinary first visit is one people switch off.
   *
   * DO NOT SET THIS INSIDE A KEEP-ALIVE HIDDEN SUBTREE. `chat/tabDeck/TabChatDeck`
   * keeps every tab MOUNTED and hides inactive ones with `display:none`, which
   * removes them from the accessibility tree — but React effects still run there.
   * An `announce` card in an inactive tab would therefore speak a failure the user
   * cannot see and whose card they cannot reach. Announce from the visible surface,
   * or gate the prop on the tab being active.
   */
  announce?: boolean;
}): JSX.Element {
  // `title` alone: the body carries the server's raw error text, which is noise
  // read aloud and changes on every retry, which would re-announce needlessly.
  //
  // Two behaviours worth knowing before changing this, both checked rather than
  // assumed. StrictMode (main.tsx:80) double-invokes effects in DEV, and
  // `announce()` deliberately re-announces a repeated string via its marker flip,
  // so a dev build says it twice; production mounts once and does not. And two
  // announcing cards on one page both call `announce()`, so the later one wins
  // the polite slot — which is the behaviour we want, since a screen-reader user
  // should not have to sit through a queue of simultaneous failures.
  useEffect(() => {
    if (announce) announceToScreenReader(title);
  }, [announce, title]);

  return (
    <div className="state-card" aria-busy={loading ? 'true' : undefined}>
      {icon ? <div className="state-card__glyph muted" aria-hidden="true">{icon}</div> : null}
      <div className="state-card__title">{title}</div>
      {body ? <div className="state-card__body">{body}</div> : null}
      {action ? <div className="state-card__actions action-bar u-justify-center">{action}</div> : null}
    </div>
  );
}
