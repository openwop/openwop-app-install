/**
 * StepRail — an ordered path of steps, each a LINK to its own URL (ADR 1154 D9).
 *
 * It is a `<nav>` holding an ordered list, not a tablist: the steps are places
 * with their own addresses, so the current one is marked `aria-current="step"`
 * and a keyboard user moves through them as links. Each step shows its state as
 * a labelled chip with a glyph, never as colour alone (DESIGN.md §5.3, §11).
 *
 * The caller owns the words (labels and state labels) and the state→tone map is
 * fixed here, so every rail in the app reads the same way.
 */
import { Link } from 'react-router-dom';
import { CheckIcon, CircleIcon, ClockIcon, HelpCircleIcon, AlertIcon } from './icons/index.js';

export type StepRailState = 'not-started' | 'in-progress' | 'needs-you' | 'done' | 'unknown';

export interface StepRailItem {
  id: string;
  label: string;
  /** Where the step lives. */
  to: string;
  state: StepRailState;
  /** The visible name of `state` (the caller's translation). */
  stateLabel: string;
}

export interface StepRailProps {
  /** The accessible name of the rail ("Campaign steps"). */
  label: string;
  items: readonly StepRailItem[];
  /** The step being shown, if any. */
  currentId?: string;
}

const TONE: Record<StepRailState, string> = {
  'not-started': 'chip--muted',
  'in-progress': 'chip--accent',
  'needs-you': 'chip--warning',
  done: 'chip--success',
  unknown: 'chip--muted',
};

function Glyph({ state }: { state: StepRailState }): JSX.Element {
  if (state === 'done') return <CheckIcon size={12} aria-hidden />;
  if (state === 'needs-you') return <AlertIcon size={12} aria-hidden />;
  if (state === 'in-progress') return <ClockIcon size={12} aria-hidden />;
  if (state === 'unknown') return <HelpCircleIcon size={12} aria-hidden />;
  return <CircleIcon size={12} aria-hidden />;
}

export function StepRail({ label, items, currentId }: StepRailProps): JSX.Element {
  return (
    <nav className="step-rail" aria-label={label}>
      <ol className="step-rail__list" role="list">
        {items.map((item, i) => (
          <li key={item.id} className="step-rail__item">
            <Link to={item.to} className="step-rail__link" data-state={item.state}
              {...(item.id === currentId ? { 'aria-current': 'step' as const } : {})}>
              <span className="step-rail__name"><span className="step-rail__index" aria-hidden>{i + 1}</span>{item.label}</span>
              <span className={`chip ${TONE[item.state]}`}><Glyph state={item.state} />{item.stateLabel}</span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
