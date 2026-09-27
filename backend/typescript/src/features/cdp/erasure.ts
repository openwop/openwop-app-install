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
 * THE RESIDUAL, stated rather than implied. An event whose payload carries the
 * person under a key the ingest did NOT flag and which is not a known identity
 * field is not reached. Neither is one keyed by an identifier the ADR 0381
 * closure did not produce — `resolveCrmSubjectKeys` is one-directional
 * email/phone → contactId, so a DSAR keyed by a contactId does not expand to
 * that person's email (CONS-11). Both are recorded in
 * `test/subject-erasure-feature-stores.test.ts` `PARTIAL_COVERAGE` rather than
 * left to be inferred from an eraser's existence.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.cdp.erasure');

/** Same namespace + key function as `collectService` — this module reads and
 *  writes the SAME rows (the `crm/erasure.ts` precedent: the erasure seam does
 *  not widen the owning service's public surface). */
interface CollectedEventRow {
  eventId: string;
  tenantId: string;
  eventType: string;
  payload: Record<string, unknown>;
  piiFields: string[];
  at: string;
}
const events = new DurableCollection<CollectedEventRow>(
  'cdp:collected-event', (e) => e.eventId, undefined, (e) => e.tenantId,
);

/**
 * Payload keys that ARE an identity regardless of what `looksLikePiiName`
 * thought at ingest. `sessionKey` is the consent `subjectKey` and the ADR 0381
 * closure's own currency; `contactId` is a live DSAR key; the rest are the
 * collection SDKs' conventional anonymous-id spellings. None of them is
 * PII-by-NAME, which is exactly why the ingest tag alone was not enough.
 */
const IDENTITY_KEYS: readonly string[] = [
  'contactId', 'sessionKey', 'subjectKey', 'userId', 'visitorKey', 'visitorId',
  'anonymousId', 'anonymousKey', 'distinctId',
];

const fold = (v: string): string => v.trim().toLowerCase();

function addressesSubject(row: CollectedEventRow, subject: string): boolean {
  const candidates = new Set<string>([...IDENTITY_KEYS, ...(row.piiFields ?? [])]);
  for (const key of candidates) {
    const v = row.payload?.[key];
    if (typeof v === 'string' && v && fold(v) === subject) return true;
  }
  return false;
}

/** Invoked once per resolved identity key by the ADR 0381 fan-out. */
export async function eraseCdpCollectedEvents(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const subject = fold(subjectKey);
  if (!subject) return;
  let deleted = 0;
  for (const row of await events.listForTenantIndexed(tenantId)) {
    if (row.tenantId !== tenantId) continue; // belt-and-braces on a stale index marker
    if (!addressesSubject(row, subject)) continue;
    await events.delete(row.eventId);
    deleted += 1;
  }
  if (deleted > 0) log.info('cdp_collected_events_erased', { tenantId, deleted });
}

/** Register CDP's DSAR eraser. Called from the feature's boot path, which runs
 *  regardless of the `cdp` toggle — an erasure obligation is not a purchased
 *  feature (the CONS-5 reasoning, applied here too). */
export function registerCdpErasure(): void {
  registerSubjectEraser(eraseCdpCollectedEvents);
}
