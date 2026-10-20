/**
 * ADR 0907 D8 — the DSAR eraser for the conversions relay queue
 * (`campaign-connectors:conversion`).
 *
 * THE DEFECT. A relay row carries a SHA-256 of the visitor's email and the
 * consent visitor key. A hashed email is still personal data (it re-identifies
 * the person to any party holding the address), yet the only thing that ever
 * removed these rows was the age-based retention purger, which is opt-in. A
 * data-subject erasure did not reach them.
 *
 * The census in `test/subject-erasure-feature-stores.test.ts` could not see the
 * store either: its fields are `visitor` and `emailHash`, which match none of
 * the subject-field signals. It is recorded in that file's `NON_COLLECTION_STORES`
 * ledger, which ties the store to this module.
 *
 * DELETE, not redact: a relay row exists only to deliver the subject's own
 * conversion to an ad platform. Nothing joins to it.
 *
 * THE MATCH RULE: exact equality on `visitor`, on `emailHash`, or on the hash of
 * a key that is an email address. Never a substring or free-text match.
 *
 * WHAT THIS DELIBERATELY DOES NOT ERASE, and why. Coverage in the census is
 * resolved per feature directory, so registering this eraser makes every
 * `campaign-connectors` store read as covered. The other stores hold no subject
 * identity: `pixel` (an org's pixel ids), `performance` (campaign-level ad
 * metrics) and `sync-state` (per-platform sync cursors).
 *
 * RESIDUAL, stated: an event already delivered to Meta or TikTok lives on in the
 * platform under the platform's own retention. Erasing it there is the
 * advertiser's request to the platform, not something this host can do.
 */

import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { deleteSubjectConversions } from './pixelService.js';

const log = createLogger('features.campaign-connectors.erasure');

/** Invoked once per resolved identity key by the ADR 0381 fan-out. */
export async function eraseCampaignConversions(tenantId: string, subjectKey: string): Promise<void> {
  const { removed, failed } = await deleteSubjectConversions(tenantId, subjectKey);
  if (removed > 0) log.info('campaign_conversions_erased', { tenantId, removed });
  // A delete that did not take leaves the subject's data behind; that is a
  // failed erasure, not a success (the ANL-2 shape).
  if (failed > 0) {
    throw new OpenwopError('internal_error', `campaign-connectors: ${failed} conversion row(s) targeted for erasure were not deleted.`, 500, {});
  }
}

/** Called from the feature's route registration, regardless of the toggle: an
 *  erasure obligation is not a purchased feature (the CONS-5 reasoning). */
export function registerCampaignConnectorsErasure(): void {
  registerSubjectEraser(eraseCampaignConversions);
}
