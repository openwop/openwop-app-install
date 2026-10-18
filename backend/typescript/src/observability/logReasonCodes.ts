/**
 * ADR 0900 D2 — the closed vocabulary of the `reasonCode` log field.
 *
 * `reason` is free text at many log sites and some of them carry user-authored text,
 * so the PII mask hashes it (a global `declarePiiFields(..., ['reason'])` put it in the
 * union). That leaves post-deploy probes nothing to count. `reasonCode` is the field
 * that is safe by construction: its values are the fixed literals below, so the logger
 * writes a member verbatim past the scrub and mask passes and DROPS anything else
 * (`observability/logger.ts` `liftReasonCode`).
 *
 * Adding a code is a reviewed code change. Never build one from runtime data: no ids,
 * no tenant or user names, no interpolation.
 */
export const LOG_REASON_CODES = [
  'speech_seam_not_admitted',
  'speech_seam_anonymous',
  'speech_seam_insufficient_scope',
  // ADR 0901 — the KickTodo run-principal binding's verdicts
  // (`features/kicktodo-core/surfaceBinding.ts`), logged on
  // `kicktodo_surface_unbound` (shadow) and `kicktodo_surface_refused` (enforced).
  'kicktodo_subject_mismatch',
  'kicktodo_person_required',
  'kicktodo_enrollment_not_owned',
  'kicktodo_manage_required',
  'kicktodo_org_required',
  'kicktodo_org_manage_required',
  'kicktodo_relation_denied',
  // ADR 0713 OQ1 — every attempted registry pack install at boot failed
  // (`bootstrap/installRegistryPacks.ts`).
  'registry_install_none_succeeded',
] as const;

export type LogReasonCode = (typeof LOG_REASON_CODES)[number];

const CODES: ReadonlySet<string> = new Set(LOG_REASON_CODES);

export function isLogReasonCode(value: unknown): value is LogReasonCode {
  return typeof value === 'string' && CODES.has(value);
}
