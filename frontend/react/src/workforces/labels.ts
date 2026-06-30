/**
 * Human-facing labels for the workforce lifecycle + autonomy enums
 * (DESIGN.md §5.3 — never leak the raw wire token to the operator). The
 * client enums are insider vocabulary ("shadow" / "auto"); the operator-facing
 * copy is externalized to the `workforces` i18n catalog. This module is a
 * pure (hook-free) layer, so it maps each enum value to its catalog KEY; a
 * React caller resolves it with `t(...)` from `useTranslation('workforces')`.
 */
import type { AutonomyLevel, WorkforceStatus } from '../client/workforcesClient.js';

/** Lifecycle status → catalog keys for its operator label + one-line gloss. */
const STATUS_KEYS: Record<WorkforceStatus, { label: string; gloss: string }> = {
  shadow: { label: 'statusShadowLabel', gloss: 'statusShadowGloss' },
  piloting: { label: 'statusPilotingLabel', gloss: 'statusPilotingGloss' },
  production: { label: 'statusProductionLabel', gloss: 'statusProductionGloss' },
};

/** Autonomy level → catalog keys for its operator label + one-line gloss. */
const AUTONOMY_KEYS: Record<AutonomyLevel, { label: string; gloss: string }> = {
  review: { label: 'autonomyReviewLabel', gloss: 'autonomyReviewGloss' },
  guided: { label: 'autonomyGuidedLabel', gloss: 'autonomyGuidedGloss' },
  auto: { label: 'autonomyAutoLabel', gloss: 'autonomyAutoGloss' },
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
export function statusGlossKey(s: WorkforceStatus): string {
  return STATUS_KEYS[s]?.gloss ?? '';
}
export function autonomyLabelKey(a: AutonomyLevel): string {
  return AUTONOMY_KEYS[a]?.label ?? a;
}
export function autonomyGlossKey(a: AutonomyLevel): string {
  return AUTONOMY_KEYS[a]?.gloss ?? '';
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
