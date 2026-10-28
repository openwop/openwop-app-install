/**
 * CONS-6 — the DSAR eraser for `cdp:collected-event`.
 *
 * THE DEFECT. `collectService` is the app's raw first-party ingest: it stores an
 * untyped `payload` bag and TAGS THE PAYLOAD'S PII KEYS AT INGEST (`piiFields`,
 * `looksLikePiiName`). It is the one store in the app that self-declares it
 * holds PII — and `features/cdp/` registered ZERO `registerSubjectEraser` and
 * zero resolvers. Its only lifecycle was a retention purger that is opt-in and
 * default-off (triple-gated behind `OPENWOP_RETENTION_SWEEP_ENABLED`,
 * `listGovernedTenants()` and a set window), so on a default install the rows
 * were reachable by NOTHING.
 *
 * It is also invisible to the ADR 0464 feature gate by construction: the subject
 * identity lives inside `Record<string, unknown>`, and no field-name matcher can
 * ever bind that (the assessment's "mechanism 8"). So this eraser has to be
 * written deliberately; no ratchet was ever going to demand it.
 *
 * THE MATCH RULE, and why it is narrow. Over-erasure is unrecoverable, and
 * matching a subject key against arbitrary free text is exactly what the
 * `forms:submission` PARTIAL_COVERAGE entry refuses to do ("that over-erases a
 * stranger's row on a digit-string coincidence"). So a row is erased only when a
 * payload field that is EITHER an identity field by name OR one the ingest
 * itself flagged as PII holds a value that EXACTLY equals (trimmed,
 * case-folded) one of the subject's resolved identity keys. Not a substring, not
 * a fuzzy match, and never the whole payload scanned blind.
 *
 * DELETE, not redact. `analytics:event` — the sibling behavioural store, same
 * shape of data — is DELETED by `eraseSubjectAnalytics`. A collected event is a
 * record OF the subject's behaviour; it exists because of them, it is nobody
 * else's business record, and there is no referential integrity to preserve
 * (nothing joins to `eventId`). ADR 0464's taxonomy sends "a subject's OWN data"
 * to DELETE.
 *
 * ADR 0954 recovery correction: delete the payload and its legacy plaintext
 * projections, retaining only opaque primary/index/receipt deletion fences.
 * These prevent an admitted delayed CAS or identical retry from republishing
 * the subject's event. A failed cleanup retains its durable deleting receipt
 * (including legacy keys) until acknowledged cleanup strips those keys.
 *
 * THE RESIDUAL, stated rather than implied. An event whose payload carries the
 * person under a key the ingest did NOT flag and which is not a known identity
 * field is not reached. Neither is one keyed by an identifier the ADR 0381
 * closure did not produce — `resolveCrmSubjectKeys` is one-directional
 * email/phone → contactId, so a DSAR keyed by a contactId does not expand to
 * that person's email (CONS-11). Both are recorded in
 * `test/subject-erasure-feature-stores.test.ts` `PARTIAL_COVERAGE` rather than
 * left to be inferred from an eraser's existence.
 */

import { registerSubjectEraser, currentErasureRequest } from '../../host/subjectErasure.js';
import { writeErasureTombstone, tombstoneId } from '../consent/consentService.js';
import { eraseCollectedEventsForIdentity } from './visitorEventIndex.js';
import { collectedIdentityForms, foldCollectedIdentity } from './collectedEventIdentity.js';
import { createLogger } from '../../observability/logger.js';
const log = createLogger('features.cdp.erasure');

/** The shared barrier precedes both reservation and legacy-primary enumeration.
 * Group every normalized form with the original DSAR for sanctioned readmission. */
export async function eraseCdpCollectedEvents(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey || !foldCollectedIdentity(subjectKey)) return;
  const request = currentErasureRequest();
  const dsarHash = tombstoneId(tenantId, request?.tenantId === tenantId ? request.requestedKey : subjectKey);
  for (const form of collectedIdentityForms(subjectKey)) await writeErasureTombstone(tenantId, form, dsarHash);
  const deleted = await eraseCollectedEventsForIdentity(tenantId, subjectKey);
  if (deleted) log.info('cdp_collected_events_erased', { tenantId, deleted });
}
export function registerCdpErasure(): void { registerSubjectEraser(eraseCdpCollectedEvents); }
