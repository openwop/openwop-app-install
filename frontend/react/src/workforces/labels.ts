/**
 * Human-facing labels for the workforce lifecycle + autonomy enums
 * (DESIGN.md §5.3 — never leak the raw wire token to the operator). The
 * client enums are insider vocabulary ("shadow" / "auto"); the operator-facing
 * copy is externalized to the `workforces` i18n catalog. This module is a
 * pure (hook-free) layer, so it maps each enum value to its catalog KEY; a
 * React caller resolves it with `t(...)` from `useTranslation('workforces')`.
 */
import type { AutonomyLevel, WorkforceStatus } from '../client/workforcesClient.js';

/** Lifecycle status → the catalog key for its operator label.
 *  The `gloss` half was dropped with `statusGlossKey` (Phase D, no callers). Leaving the
 *  literals behind would have been worse than dead data: `check-i18n` harvests any quoted
 *  identifier, so they kept its orphan pass quiet about catalog entries nothing renders. */
const STATUS_KEYS: Record<WorkforceStatus, { label: string }> = {
  shadow: { label: 'statusShadowLabel' },
  piloting: { label: 'statusPilotingLabel' },
  production: { label: 'statusProductionLabel' },
};

/** Autonomy level → catalog keys for its operator label + one-line gloss.
 *  The label WORDS are the canonical autonomy vocabulary (DESIGN.md §5.3) —
 *  Supervised / Guided / Autonomous — kept in lockstep with the agent meter's
 *  `agents/i18n/*` `autonomy{Supervised,Guided,Autonomous}` keys. */
const AUTONOMY_KEYS: Record<AutonomyLevel, { label: string }> = {
  review: { label: 'autonomyReviewLabel' },
  guided: { label: 'autonomyGuidedLabel' },
  auto: { label: 'autonomyAutoLabel' },
};

/** Journey stage → catalog keys for its operator label + one-line gloss. */
const JOURNEY_KEYS: Record<WorkforceStatus, { label: string; gloss: string }> = {
  shadow: { label: 'journeyShadowLabel', gloss: 'journeyShadowGloss' },
  piloting: { label: 'journeyPilotingLabel', gloss: 'journeyPilotingGloss' },
  production: { label: 'journeyProductionLabel', gloss: 'journeyProductionGloss' },
};

export function statusLabelKey(s: WorkforceStatus): string {
  return STATUS_KEYS[s]?.label ?? s;
}
export function autonomyLabelKey(a: AutonomyLevel): string {
  return AUTONOMY_KEYS[a]?.label ?? a;
}
export function journeyLabelKey(s: WorkforceStatus): string {
  return JOURNEY_KEYS[s]?.label ?? s;
}
export function journeyGlossKey(s: WorkforceStatus): string {
  return JOURNEY_KEYS[s]?.gloss ?? '';
}

/** Status → chip class, mapped once so a workforce status reads the same way
 *  on the gallery card and the detail header (DESIGN.md §4.5 rule 7). */
export function statusChipClass(s: WorkforceStatus): string {
  switch (s) {
    case 'production': return 'chip chip--success';
    case 'piloting': return 'chip chip--accent';
    default: return 'chip chip--muted'; // shadow
  }
}

/**
 * The trust journey — the plain-language spine of the whole /workforces UX.
 * A workforce earns autonomy in three stages; `status` is its current stage.
 * Operator-facing labels/glosses live in the catalog (resolve via
 * `journeyLabelKey` / `journeyGlossKey`); this array carries only the ordered
 * wire statuses that drive the rail.
 */
export const JOURNEY: ReadonlyArray<{ status: WorkforceStatus }> = [
  { status: 'shadow' },
  { status: 'piloting' },
  { status: 'production' },
];

/** 0 = Watching, 1 = Assisting, 2 = Running on its own. */
export function journeyIndex(s: WorkforceStatus): number {
  const i = JOURNEY.findIndex((j) => j.status === s);
  return i < 0 ? 0 : i;
}
