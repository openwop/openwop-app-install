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
  // ADR 0713 OQ1 — every attempted registry pack install at boot failed
  // (`bootstrap/installRegistryPacks.ts`).
  'registry_install_none_succeeded',
  // ADR 0994 — why an SMTP send failed (`host/smtpSend.ts` `classifySmtpFailure`).
  'smtp_auth',
  'smtp_connect',
  'smtp_timeout',
  'smtp_rejected',
  'smtp_other',
  // ADR 1018 D8 — why a public chat widget may not answer
  // (`features/chat-widget/widgetCredential.ts`), logged on `widget_credential_refused`.
  'widget_no_own_key',
  'widget_managed_binding',
  'widget_subscription_binding',
  'widget_key_unavailable',
] as const;

/**
 * ADR 1031 P2 (security) — reason codes a composed FEATURE registers
 * (`BackendFeature.security.logReasonCodes`), declared into the type by module
 * augmentation from the feature's directory:
 *
 *   declare module '<path>/observability/logReasonCodes.js' {
 *     interface FeatureLogReasonCodes { my_code: true }
 *   }
 *
 * The trust rule is UNCHANGED: a code is written verbatim past the scrub and mask
 * passes only if it is a member of the vocabulary. A registered code joins it only
 * when it matches the same format every static code is held to
 * (`LOG_REASON_CODE_FORMAT`, pinned by adr0900-log-reason-code.test.ts), is not
 * already a code, and arrives before the seal; anything else throws at boot and
 * never becomes trusted. A literal is still the only way to write one.
 */
export interface FeatureLogReasonCodes {}
export type LogReasonCode = (typeof LOG_REASON_CODES)[number] | Extract<keyof FeatureLogReasonCodes, string>;

/** The one format a reason code may have: a short snake_case literal, never runtime data. */
export const LOG_REASON_CODE_FORMAT = /^[a-z][a-z0-9_]{2,63}$/;

const CODES: ReadonlySet<string> = new Set(LOG_REASON_CODES);
const featureCodes = new Map<string, string>(); // code → owning feature
let sealed = false;

/** Called by the feature composer's seal only (`features/featureSecurity.ts`). */
export function recordFeatureLogReasonCode(featureId: string, code: string): void {
  if (sealed) throw new Error(`feature security registration is closed (ADR 1031 P2): log reason code '${code}' (feature '${featureId}') was registered after the seal`);
  if (!LOG_REASON_CODE_FORMAT.test(code)) throw new Error(`feature '${featureId}': log reason code ${JSON.stringify(code)} does not match ${LOG_REASON_CODE_FORMAT} (ADR 0900 D2)`);
  if (CODES.has(code) || featureCodes.has(code)) throw new Error(`log reason code '${code}' is registered twice (ADR 1031 P2)`);
  featureCodes.set(code, featureId);
}

export function sealFeatureLogReasonCodes(): void { sealed = true; }

/** Every feature-registered code with its owner (census). */
export function featureLogReasonCodes(): Array<{ featureId: string; code: string }> {
  return [...featureCodes].map(([code, featureId]) => ({ featureId, code }));
}

export function isLogReasonCode(value: unknown): value is LogReasonCode {
  return typeof value === 'string' && (CODES.has(value) || featureCodes.has(value));
}
