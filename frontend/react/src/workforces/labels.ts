/**
 * Human-facing labels for the workforce lifecycle + autonomy enums
 * (DESIGN.md §5.3 — never leak the raw wire token to the operator). The
 * client enums are insider vocabulary ("shadow" / "auto"); these give each a
 * title-case label and a one-line gloss for a tooltip / legend.
 */
import type { AutonomyLevel, WorkforceStatus } from '../client/workforcesClient.js';

const STATUS: Record<WorkforceStatus, { label: string; gloss: string }> = {
  shadow: { label: 'Shadow', gloss: 'Runs alongside humans, takes no real action' },
  piloting: { label: 'Piloting', gloss: 'Acting on live work, with human review' },
  production: { label: 'Production', gloss: 'Bounded-autonomous within policy, live' },
};

const AUTONOMY: Record<AutonomyLevel, { label: string; gloss: string }> = {
  review: { label: 'Review', gloss: 'Every decision waits for human approval' },
  guided: { label: 'Guided', gloss: 'Acts, but routes key decisions for review' },
  auto: { label: 'Auto', gloss: 'Bounded-autonomous within its policy' },
};

/** Status → chip class, mapped once so a workforce status reads the same way
 *  on the gallery card and the detail header (DESIGN.md §4.5 rule 7). */
export function statusChipClass(s: WorkforceStatus): string {
  switch (s) {
    case 'production': return 'chip chip--success';
    case 'piloting': return 'chip chip--accent';
    default: return 'chip chip--muted'; // shadow
  }
}

export function statusLabel(s: WorkforceStatus): string {
  return STATUS[s]?.label ?? s;
}
export function statusGloss(s: WorkforceStatus): string {
  return STATUS[s]?.gloss ?? '';
}
export function autonomyLabel(a: AutonomyLevel): string {
  return AUTONOMY[a]?.label ?? a;
}
export function autonomyGloss(a: AutonomyLevel): string {
  return AUTONOMY[a]?.gloss ?? '';
}

/**
 * The trust journey — the plain-language spine of the whole /workforces UX.
 * A workforce earns autonomy in three stages; `status` is its current stage.
 * These labels (not the wire enums) are what the operator sees.
 */
export const JOURNEY: ReadonlyArray<{ status: WorkforceStatus; label: string; gloss: string }> = [
  { status: 'shadow', label: 'Watching', gloss: 'Watches your team work and learns — takes no real action yet.' },
  { status: 'piloting', label: 'Assisting', gloss: 'Acts on live work, with a human reviewing exceptions.' },
  { status: 'production', label: 'Running on its own', gloss: 'Runs autonomously within its policy guardrails.' },
];

/** 0 = Watching, 1 = Assisting, 2 = Running on its own. */
export function journeyIndex(s: WorkforceStatus): number {
  const i = JOURNEY.findIndex((j) => j.status === s);
  return i < 0 ? 0 : i;
}
export function journeyLabel(s: WorkforceStatus): string {
  return JOURNEY[journeyIndex(s)]?.label ?? s;
}
export function journeyGloss(s: WorkforceStatus): string {
  return JOURNEY[journeyIndex(s)]?.gloss ?? '';
}
