/**
 * FORM-1 (ADR 0584) — subject erasure for Forms.
 *
 * WHAT WAS WRONG. `forms:submission` is the app's highest-volume store of
 * PUBLIC-VISITOR PII — a stranger's name, email address and free text, captured
 * from an unauthenticated page — and Forms registered ZERO erasers over it. The
 * opt-out was explicit in `formsService.ts` and named a compensating lifecycle
 * that was falsified on all three of its legs:
 *
 *   (a) "the crm precedent (contactsService.ts)" — that precedent was
 *       OVERTURNED as the CRM-2 defect. `crm/erasure.ts` now registers an eraser
 *       AND a `SubjectKeyResolver`, so the ADR 0381 seam already delivers a
 *       resolved `contactId` to every registrant. Forms was the store still not
 *       listening, which is the CRM-2 sentence verbatim.
 *   (b) "the CRM erasure path via the contact" — it never reached here.
 *       `onCrmRecordDeleted` strips the `contactId` POINTER and leaves the
 *       respondent's own name and email in `submission.values`; if anything it
 *       makes the residual PII harder to find, because the row no longer says
 *       whose it is.
 *   (c) "retention" — off on TWO independent default switches: the sweep daemon
 *       starts only under `OPENWOP_RETENTION_SWEEP_ENABLED`, and the
 *       `confidential-pii` window defaults to `null` = never purge.
 *
 * ANONYMIZE, DO NOT DELETE — the `crm/erasure.ts` and `documents/erasure.ts`
 * precedent, and the half of the original opt-out that WAS right. A submission is
 * also the org's own business record: that an enquiry arrived on this form at
 * this time, that it was routed to CRM, that a funnel step completed. Deleting
 * the row would destroy the org's record of its own intake and silently move
 * every count that reads off it. So the row survives and its identifying CONTENT
 * goes: every answer becomes the tombstone (the KEYS stay, so "they answered
 * these fields" remains true and the inbox still renders), and the whole `meta`
 * bag — referrer, UTM attribution, analytics session key, embed context — is
 * dropped, because none of it is a business fact about the enquiry, all of it is
 * a tracking fact about the person.
 *
 * HOW A SUBMISSION IS REACHED FROM A DSAR KEY. Three matches, in descending
 * order of authority, and none of them heuristic:
 *   1. `contactId` — the ADR 0381 fan-out already resolves an email-shaped key
 *      to a CRM contactId through the store-backed `cdp:contact-ident` index, so
 *      this leg fires for free once CRM's resolver has run.
 *   2. `meta.sessionKey` — the analytics identity-link space; a submission that
 *      carried one is keyed by it directly.
 *   3. An EXACT, case-folded match of the subject key against a submitted VALUE,
 *      and only for an email-shaped key. This is the leg that matters most:
 *      the overwhelming majority of respondents never become a CRM contact
 *      (`createToContact` is opt-in and off by default), so without it a DSAR
 *      from a person who filled a public form reaches nothing at all. An exact
 *      full-string match against an email address is authoritative — it is the
 *      same equality the identity index itself is built on, not a fuzzy or
 *      substring match, which is what keeps this from over-erasing.
 *
 * WHAT THESE THREE LEGS DO NOT REACH — the RESIDUAL, named (ADR 0584
 * §Correction, FORM-ERASE-1). Leg 3 fires only for an EMAIL-SHAPED subject key
 * (`key.includes('@')`), so a respondent to a form that captures name + phone
 * and nothing else, who never became a CRM contact and whose page sent no
 * analytics session key, is unreachable by ALL THREE legs. `eraseFormsSubject`
 * then logs `rows: 0` and returns `{ rowsTouched: 0 }` — since the DOCT-4/
 * WF-DOC-8 fix the fan-out at least SEES that zero in its `foundNothing`
 * channel, but the fan-out still reports success over data that is still
 * sitting in `values`. That is a real gap and it is recorded as one — in
 * `subject-erasure-feature-stores.test.ts`'s `PARTIAL_COVERAGE` ledger, whose
 * ceiling arithmetic restates it — rather than left to be inferred from the
 * fact that this module exists.
 *
 * It is a residual and not a bug because the alternative is WORSE: matching a
 * non-email subject key against free text means comparing an opaque id, or a
 * digit string, against every answer on every row — which over-erases someone
 * else's submission on a coincidence, and over-erasure is unrecoverable in a
 * way under-erasure is not. Closing it honestly needs a per-form declaration of
 * which field carries the respondent's identity (the `emailOptInField`
 * precedent: an owner names the field, the eraser matches only that one), which
 * is a forms-owner decision and not a default this change may pick.
 *
 * WHAT THIS DELIBERATELY DOES NOT ERASE, stated here rather than left implicit
 * (the `crm:suppression` precedent — an unstated omission is how a whole feature
 * package went unnoticed). `forms:def` — the form DEFINITION — carries
 * `createdBy` and is an ORG CONFIG record: a public page that must keep working
 * when its author leaves the workspace. The honest erasure for it is RE-ATTRIBUTE
 * to a surviving owner, not delete and not tombstone, and re-attribution needs a
 * target this change has no way to choose. It is left untouched on purpose. Note
 * that the ADR 0464 feature-store ratchet resolves coverage at MODULE level, so
 * registering here makes `forms:def` read as covered; the ratchet asserts this
 * paragraph exists so that reading cannot be mistaken for a claim.
 *
 * Idempotent by construction (the contract requires it — the eraser runs once per
 * linked identity key, so a K-times side effect would be a defect): every write
 * sets a field to the tombstone, which is a no-op the second time.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { createLogger } from '../../observability/logger.js';
import type { Submission } from './formsService.js';

const log = createLogger('features.forms.erasure');

/** What an erased answer becomes. Not `''` — an empty answer reads as "they
 *  left it blank", which is a different fact from "erased on request". Mirrors
 *  `crm/erasure.ts`'s `ERASED_VALUE`. */
export const ERASED_VALUE = 'erased:subject';

// The SAME namespace + key function as the owning service — this module reads and
// writes the same rows. Declared here rather than exported from `formsService` so
// the erasure seam does not widen that module's public surface (the documents
// precedent).
const submissions = new DurableCollection<Submission>('forms:submission', (s) => s.submissionId, undefined, (s) => s.tenantId);

const fold = (v: string): string => v.trim().toLowerCase();

/**
 * The registered eraser. `subjectKey` may be a contactId, an analytics session
 * key, an email address, or a key from an identity space Forms knows nothing
 * about — the last simply matches no row, which is the harmless no-op the
 * contract describes.
 */
export async function eraseFormsSubject(tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 }; // fail-closed — never a tenant-wide sweep
  const key = fold(subjectKey);
  // Only an EMAIL-shaped key is matched against submitted values. A bare opaque
  // id (a contactId, a session key) must never be compared against free text:
  // that is the over-erasure this exact-match rule exists to prevent.
  const emailShaped = key.includes('@');
  let touched = 0;

  for (const s of await submissions.listForTenantIndexed(tenantId)) {
    if (s.tenantId !== tenantId) continue;
    const byContact = !!s.contactId && s.contactId === subjectKey;
    const bySession = !!s.meta?.sessionKey && s.meta.sessionKey === subjectKey;
    const byValue = emailShaped
      && Object.values(s.values ?? {}).some((v) => typeof v === 'string' && fold(v) === key);
    if (!byContact && !bySession && !byValue) continue;

    const values = Object.fromEntries(Object.keys(s.values ?? {}).map((k) => [k, ERASED_VALUE]));
    const alreadyErased = Object.values(s.values ?? {}).every((v) => v === ERASED_VALUE);
    const metaEmpty = Object.keys(s.meta ?? {}).length === 0;
    if (alreadyErased && metaEmpty) continue; // idempotent — nothing left to do

    // `contactId` is KEPT: it is an opaque pointer at a CRM row that
    // `crm/erasure.ts` anonymizes in the same fan-out, and dropping it here
    // would break the org's record of where the enquiry was routed while
    // erasing nothing (the same reasoning that keeps `crm:suppression`'s key).
    await submissions.put({ ...s, values, meta: {} });
    touched += 1;
  }

  // Logged because a silent erasure is indistinguishable from one that never ran
  // — which is exactly how this package's absence went unnoticed.
  log.info('forms_subject_erased', { tenantId, rows: touched });
  // DOCT-4 / WF-DOC-8 — report, so the seam's `foundNothing` tell can see this
  // eraser. NOTE the honest limit this does NOT lift: the FORM-ERASE-1
  // residual above (name+phone-only respondents unreachable by all 3 legs)
  // now at least shows up as rowsTouched 0 in the channel instead of only in
  // a log line (DOCT-DEBT-4's compounding concern).
  return { rowsTouched: touched };
}

export function registerFormsErasure(): void {
  registerSubjectEraser(eraseFormsSubject);
}
